// Benchmark for the intents pipeline: runs layer configs over labelled phrasings and reports
// accuracy, macro-F1, false triggers on non-commands, slot accuracy, latency and model load time.
//
//   node scripts/intents-bench.ts                                    patterns, embeddings, patterns+embeddings on seen + heldout
//   node scripts/intents-bench.ts --config patterns --config embeddings:method=centroid,threshold=0.6
//   node scripts/intents-bench.ts --config patterns+embeddings@vote --set heldout
//   node scripts/intents-bench.ts --config local_llm --url http://127.0.0.1:11434/v1 --model qwen2.5:1.5b
//   node scripts/intents-bench.ts --config embeddings --grid         threshold x margin sweep
//   node scripts/intents-bench.ts --json data/bench/run.json         also write the full results
//
// A config is layer kinds joined by "+", each with optional key=value settings after ":" (the
// profile keys: threshold, margin, method, k, model, url, timeout_ms), and an optional
// "@strategy" (first_confident | vote | best). Sets: seen (the parser's test table), heldout
// (paraphrases the embeddings examples don't contain), all, or a JSON file of [text, intent|null, args?].
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { resolveConfig, buildPipeline, type LayerConfig, type LayerKind, type BuildDeps } from '../src/brains/intents/config.ts'
import { transformersEmbedder, DEFAULT_EMBEDDING_MODEL, type Embedder } from '../src/brains/intents/layers/embeddings.ts'
import type { IntentPipeline, Strategy } from '../src/brains/intents/pipeline.ts'
import { SEEN_CASES, type LabelledCase } from '../test/fixtures/intents-seen.ts'
import { HELDOUT_CASES } from '../test/fixtures/intents-heldout.ts'

const SPEAKER = 'Tester'

export interface BenchConfig {
  label: string
  layers: LayerConfig[]
  strategy: Strategy
}

export interface Metrics {
  config: string
  set: string
  n: number
  accuracy: number
  macroF1: number
  /** Share of must-not-trigger lines that triggered an intent. */
  falseTriggers: number
  falseTriggerCount: number
  negatives: number
  /** Commands that got no intent. */
  misses: number
  /** Right intent, all expected args right, over right-intent cases with expected args. */
  slotAccuracy: number
  slotCases: number
  p50: number
  p95: number
  /** Per-layer latency over the lines it ran on. */
  layers: Record<string, { p50: number, p95: number, runs: number, loadMs: number }>
  errors: { text: string, gold: string | null, got: string | null, args?: Record<string, unknown>, by?: string }[]
}

/** "patterns+embeddings:threshold=0.6,k=5@vote" -> layers and strategy. */
export function parseConfig (spec: string, extra: Partial<LayerConfig> = {}): BenchConfig {
  const [body = '', strategy] = spec.split('@')
  const layers = body.split('+').filter(Boolean).map(part => {
    const [use = '', opts = ''] = part.split(':')
    const l: Record<string, unknown> = { use }
    if (use === 'local_llm') Object.assign(l, { url: extra.url, model: extra.model, timeout_ms: extra.timeout_ms })
    if (use === 'embeddings' && extra.model && extra.url === undefined) l.model = extra.model
    for (const kv of opts.split(',').filter(Boolean)) {
      const [k = '', v = ''] = kv.split('=')
      l[k] = v === 'true' ? true : v === 'false' ? false : v !== '' && !Number.isNaN(Number(v)) ? Number(v) : v
    }
    if (!['patterns', 'embeddings', 'local_llm'].includes(use)) throw new Error(`unknown layer ${use} in ${spec}`)
    return l as unknown as LayerConfig
  })
  if (!layers.length) throw new Error(`empty config ${spec}`)
  if (strategy && !['first_confident', 'vote', 'best'].includes(strategy)) throw new Error(`unknown strategy ${strategy}`)
  return { label: spec, layers, strategy: (strategy ?? 'first_confident') as Strategy }
}

export function pipelineFor (c: BenchConfig, deps: BuildDeps): IntentPipeline {
  // no cloud_llm: the bench measures the classifiers
  return buildPipeline(resolveConfig({ strategy: c.strategy }, [...c.layers, { use: 'cloud_llm' as LayerKind, enabled: false }]), deps)
}

export { SEEN_CASES, HELDOUT_CASES }

const pct = (xs: number[], p: number): number => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]! * 10) / 10
}

/** Runs one pipeline over one labelled set. Warm the layers first (warmup) so load time isn't in the latencies. */
export async function runBench (pipe: IntentPipeline, cases: LabelledCase[], label: { config: string, set: string }, loadMs: Record<string, number> = {}): Promise<Metrics> {
  const totals: number[] = []
  const per: Record<string, number[]> = {}
  const rows: { gold: string | null, got: string | null, slotOk?: boolean }[] = []
  const errors: Metrics['errors'] = []
  for (const [text, gold, args] of cases) {
    const d = await pipe.decide(text, { speaker: SPEAKER })
    totals.push(d.ms)
    for (const e of d.trace) if (!e.skipped) (per[e.layer] ??= []).push(e.ms)
    const got = d.winner?.intent ?? null
    const slotOk = got !== null && got === gold && args && Object.keys(args).length
      ? Object.entries(args).every(([k, v]) => isDeepStrictEqual(d.winner!.args[k], v))
      : undefined
    rows.push({ gold, got, slotOk })
    if (got !== gold || slotOk === false) errors.push({ text, gold, got, ...(d.winner ? { args: d.winner.args, by: d.winner.layer } : {}) })
  }
  const correct = rows.filter(r => r.got === r.gold).length
  const classes = new Set(rows.flatMap(r => [r.gold, r.got]).filter((x): x is string => x !== null))
  let f1sum = 0
  for (const c of classes) {
    const tp = rows.filter(r => r.got === c && r.gold === c).length
    const fp = rows.filter(r => r.got === c && r.gold !== c).length
    const fn = rows.filter(r => r.gold === c && r.got !== c).length
    const p = tp + fp ? tp / (tp + fp) : 0
    const rc = tp + fn ? tp / (tp + fn) : 0
    f1sum += p + rc ? 2 * p * rc / (p + rc) : 0
  }
  const negatives = rows.filter(r => r.gold === null)
  const slotRows = rows.filter(r => r.slotOk !== undefined)
  const r3 = (x: number) => Math.round(x * 1000) / 1000
  return {
    ...label,
    n: rows.length,
    accuracy: r3(correct / rows.length),
    macroF1: r3(classes.size ? f1sum / classes.size : 0),
    falseTriggers: r3(negatives.length ? negatives.filter(r => r.got !== null).length / negatives.length : 0),
    falseTriggerCount: negatives.filter(r => r.got !== null).length,
    negatives: negatives.length,
    misses: rows.filter(r => r.gold !== null && r.got === null).length,
    slotAccuracy: r3(slotRows.length ? slotRows.filter(r => r.slotOk).length / slotRows.length : 0),
    slotCases: slotRows.length,
    p50: pct(totals, 0.5),
    p95: pct(totals, 0.95),
    layers: Object.fromEntries(Object.entries(per).map(([k, xs]) => [k, { p50: pct(xs, 0.5), p95: pct(xs, 0.95), runs: xs.length, loadMs: loadMs[k] ?? 0 }])),
    errors
  }
}

/** Loads every layer of a pipeline once; returns load times per layer. */
export async function warm (pipe: IntentPipeline): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const { layer } of pipe.layers) out[layer.name] = await layer.warmup?.() ?? 0
  return out
}

export function table (ms: Metrics[]): string {
  const head = ['config', 'set', 'n', 'acc', 'macroF1', 'false trig', 'misses', 'slots', 'p50 ms', 'p95 ms', 'load ms']
  const rows = ms.map(m => [
    m.config, m.set, String(m.n), m.accuracy.toFixed(3), m.macroF1.toFixed(3),
    `${m.falseTriggerCount}/${m.negatives} (${(m.falseTriggers * 100).toFixed(0)}%)`, String(m.misses),
    `${m.slotAccuracy.toFixed(3)} (${m.slotCases})`, String(m.p50), String(m.p95),
    String(Object.values(m.layers).reduce((a, l) => a + l.loadMs, 0))
  ])
  const w = head.map((h, i) => Math.max(h.length, ...rows.map(r => r[i]!.length)))
  const line = (r: string[]) => `| ${r.map((c, i) => c.padEnd(w[i]!)).join(' | ')} |`
  return [line(head), `|${w.map(n => '-'.repeat(n + 2)).join('|')}|`, ...rows.map(line)].join('\n')
}

/** An embedder that remembers vectors, so a threshold grid doesn't re-embed every line. */
export function memoEmbedder (load: () => Promise<Embedder>): () => Promise<Embedder> {
  const cache = new Map<string, Float32Array>()
  let inner: Promise<Embedder> | null = null
  return async () => {
    inner ??= load()
    const e = await inner
    return {
      async embed (texts: string[]) {
        const missing = [...new Set(texts.filter(t => !cache.has(t)))]
        if (missing.length) (await e.embed(missing)).forEach((v, i) => cache.set(missing[i]!, v))
        return texts.map(t => cache.get(t)!)
      }
    }
  }
}

function loadSet (name: string): { name: string, cases: LabelledCase[] }[] {
  if (name === 'seen') return [{ name, cases: SEEN_CASES }]
  if (name === 'heldout') return [{ name, cases: HELDOUT_CASES }]
  if (name === 'all') return [{ name: 'seen', cases: SEEN_CASES }, { name: 'heldout', cases: HELDOUT_CASES }]
  return [{ name, cases: JSON.parse(readFileSync(name, 'utf8')) as LabelledCase[] }]
}

async function main (): Promise<void> {
  const argv = process.argv.slice(2)
  const many = (flag: string) => argv.flatMap((a, i) => a === flag && argv[i + 1] ? [argv[i + 1]!] : [])
  const one = (flag: string) => many(flag).at(-1)
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter(l => l.startsWith('//')).map(l => l.slice(3)).join('\n'))
    return
  }
  const extra: Partial<LayerConfig> = { url: one('--url'), model: one('--model'), timeout_ms: one('--timeout') ? Number(one('--timeout')) : undefined }
  const specs = many('--config')
  const configs = (specs.length ? specs : ['patterns', 'embeddings', 'patterns+embeddings']).map(s => parseConfig(s, extra))
  const sets = loadSet(one('--set') ?? 'all')
  const model = configs.flatMap(c => c.layers).find(l => l.use === 'embeddings')?.model ?? DEFAULT_EMBEDDING_MODEL
  // the model loads once (transformers.js keeps it); each config embeds its examples again
  let modelMs = 0
  const load = async () => {
    const t0 = performance.now()
    const e = await transformersEmbedder(model)
    if (!modelMs) { modelMs = Math.round(performance.now() - t0); console.error(`model ${model} loaded in ${modelMs} ms`) }
    return e
  }
  const quiet = argv.includes('--quiet')
  const log = { info: (m: string) => { if (!quiet) console.error(m) }, warn: (m: string) => console.error(`warn: ${m}`), debug: () => {} }
  const deps: BuildDeps = { embedder: load, log }
  const results: Metrics[] = []
  for (const c of configs) {
    const pipe = pipelineFor(c, deps)
    const t0 = performance.now()
    const loads = await warm(pipe)
    console.error(`${c.label}: layers ready in ${Math.round(performance.now() - t0)} ms`)
    for (const s of sets) results.push(await runBench(pipe, s.cases, { config: c.label, set: s.name }, loads))
  }
  console.log(table(results))
  if (modelMs) console.log(`\nembedding model load (first use, from the disk cache or download): ${modelMs} ms`)
  if (argv.includes('--errors')) {
    for (const m of results) {
      console.log(`\n${m.config} / ${m.set}: ${m.errors.length} wrong`)
      for (const e of m.errors) console.log(`  ${JSON.stringify(e.text)}: want ${e.gold ?? 'none'}, got ${e.got ?? 'none'}${e.by ? ` (${e.by} ${JSON.stringify(e.args)})` : ''}`)
    }
  }

  let grid: unknown[] = []
  if (argv.includes('--grid')) {
    // cached vectors: every grid point reuses the embeddings of the first
    grid = await runGrid(configs, sets, { embedder: memoEmbedder(load), log: { ...log, info: () => {} } })
  }
  const out = one('--json')
  if (out) {
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, JSON.stringify({ when: new Date().toISOString(), modelLoadMs: modelMs, results, grid }, null, 2))
    console.error(`wrote ${out}`)
  }
}

/** Threshold x margin sweep over the embeddings / local_llm layers of each config (vectors are cached, so it's quick). */
async function runGrid (configs: BenchConfig[], sets: { name: string, cases: LabelledCase[] }[], deps: BuildDeps): Promise<unknown[]> {
  const rows: { config: string, threshold: number, margin: number, scores: Record<string, Pick<Metrics, 'accuracy' | 'macroF1' | 'falseTriggers' | 'slotAccuracy'>> }[] = []
  for (const c of configs) {
    const tunable = c.layers.find(l => l.use === 'embeddings' || l.use === 'local_llm')
    if (!tunable) continue
    const thresholds = Array.from({ length: 16 }, (_, i) => Math.round((0.5 + i * 0.02) * 100) / 100)
    const margins = tunable.use === 'embeddings' ? [0, 0.02, 0.04, 0.06, 0.08] : [0]
    for (const threshold of thresholds) {
      for (const margin of margins) {
        const layers = c.layers.map(l => l === tunable ? { ...l, threshold, ...(l.use === 'embeddings' ? { margin } : {}) } : l)
        const pipe = pipelineFor({ ...c, layers }, deps)
        const scores: Record<string, Pick<Metrics, 'accuracy' | 'macroF1' | 'falseTriggers' | 'slotAccuracy'>> = {}
        for (const s of sets) {
          const m = await runBench(pipe, s.cases, { config: c.label, set: s.name })
          scores[s.name] = { accuracy: m.accuracy, macroF1: m.macroF1, falseTriggers: m.falseTriggers, slotAccuracy: m.slotAccuracy }
        }
        rows.push({ config: c.label, threshold, margin, scores })
      }
    }
  }
  // rank by mean accuracy across the sets
  const mean = (r: typeof rows[number]) => Object.values(r.scores).reduce((a, s) => a + s.accuracy, 0) / Object.keys(r.scores).length
  rows.sort((a, b) => mean(b) - mean(a))
  console.log('\ngrid (top 15 by mean accuracy):')
  for (const r of rows.slice(0, 15)) {
    console.log(`  ${r.config} threshold=${r.threshold} margin=${r.margin}: ${Object.entries(r.scores).map(([s, m]) => `${s} acc ${m.accuracy} F1 ${m.macroF1} false ${m.falseTriggers}`).join(' | ')}`)
  }
  return rows
}

if (import.meta.main) {
  main().catch(e => { console.error(e); process.exit(1) })
}
