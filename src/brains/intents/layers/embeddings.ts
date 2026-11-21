// embeddings layer: a local sentence-embedding model (transformers.js, ONNX on the CPU) picks
// the intent by the nearest labelled example phrasings (examples.ts); slots come from the line
// itself (slots.ts), never from the model. The model loads on first use (or at warmup) and is
// cached on disk (data/models/). If the package or the model can't load, the layer reports
// "unavailable" and the pipeline skips it.
import { join } from 'node:path'
import type { Logger } from '../../../core/index.ts'
import { addressesOther, isStatement, lineShape, shapeConfidence, type IntentName, type ParseContext } from '../parse.ts'
import { extractSlots, refine, FAMILIES, type SlotOptions } from '../slots.ts'
import { EXAMPLES, type ExampleLabel, type Examples } from '../examples.ts'
import type { IntentLayer, LayerResult, LayerStatus } from '../pipeline.ts'

/** Turns texts into L2-normalised vectors. */
export interface Embedder {
  embed (texts: string[]): Promise<Float32Array[]>
}

export interface EmbeddingsLayerOptions extends SlotOptions {
  name?: string
  /** Hugging Face model id (ONNX weights). Default Xenova/all-MiniLM-L6-v2. */
  model?: string
  /** Weights: q8 (quantised, default), fp32, fp16, q4. */
  dtype?: string
  /** knn (default): mean of the k most similar examples per intent; centroid: similarity to each intent's mean vector. */
  method?: 'knn' | 'centroid'
  k?: number
  /** Best intent minus the runner-up (chat included) must be at least this. Default 0.05. */
  margin?: number
  examples?: Examples
  /** Model cache folder. Default data/models. */
  cacheDir?: string
  /** Injected embedder (tests, other runtimes) instead of transformers.js. */
  embedder?: Embedder | (() => Promise<Embedder>)
  log?: Pick<Logger, 'info' | 'warn' | 'debug'>
}

export const DEFAULT_EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2'

// ------------------------------------------------------------------ transformers.js

const loaded = new Map<string, Promise<Embedder>>()

/** A transformers.js feature-extraction pipeline (mean pooled, normalised), loaded once per model. */
export function transformersEmbedder (model = DEFAULT_EMBEDDING_MODEL, opts: { cacheDir?: string, dtype?: string } = {}): Promise<Embedder> {
  const key = `${model}|${opts.dtype ?? 'q8'}`
  let p = loaded.get(key)
  if (!p) {
    p = (async () => {
      const spec = '@huggingface/transformers'
      const tf = await import(spec) as any
      tf.env.cacheDir = opts.cacheDir ?? join(process.cwd(), 'data', 'models')
      tf.env.allowLocalModels = false
      const extract = await tf.pipeline('feature-extraction', model, { dtype: opts.dtype ?? 'q8' })
      return {
        async embed (texts: string[]): Promise<Float32Array[]> {
          if (!texts.length) return []
          const out = await extract(texts, { pooling: 'mean', normalize: true })
          const [n, dim] = out.dims as [number, number]
          const data = out.data as Float32Array
          return Array.from({ length: n }, (_, i) => data.slice(i * dim, (i + 1) * dim))
        }
      }
    })()
    loaded.set(key, p)
    p.catch(() => loaded.delete(key))
  }
  return p
}

// ------------------------------------------------------------------ the layer

const dot = (a: Float32Array, b: Float32Array): number => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!; return s }

function normalise (v: Float32Array): Float32Array {
  const n = Math.sqrt(dot(v, v)) || 1
  return v.map(x => x / n)
}

interface Index { labels: ExampleLabel[], vectors: Float32Array[], centroids: Map<ExampleLabel, Float32Array> }

export interface EmbeddingsLayer extends IntentLayer {
  /** Scores per label for a line (for the benchmark and debugging). */
  scores (text: string): Promise<{ label: ExampleLabel, score: number }[] | null>
}

export function embeddingsLayer (opts: EmbeddingsLayerOptions = {}): EmbeddingsLayer {
  const name = opts.name ?? 'embeddings'
  const model = opts.model ?? DEFAULT_EMBEDDING_MODEL
  const method = opts.method ?? 'knn'
  const k = Math.max(1, opts.k ?? 3)
  const margin = opts.margin ?? 0.05
  const examples = opts.examples ?? EXAMPLES
  let state: LayerStatus = 'idle'
  let why: string | undefined
  let ready: Promise<{ embedder: Embedder, index: Index } | null> | null = null
  let loadMs = 0

  const ensure = () => {
    if (ready) return ready
    state = 'loading'
    const t0 = performance.now()
    ready = (async () => {
      try {
        const e = opts.embedder
        const embedder = !e ? await transformersEmbedder(model, { cacheDir: opts.cacheDir, dtype: opts.dtype }) : typeof e === 'function' ? await e() : e
        const labels: ExampleLabel[] = []
        const texts: string[] = []
        const seen = new Set<string>()
        for (const [label, list] of Object.entries(examples) as [ExampleLabel, string[]][]) {
          for (const raw of list ?? []) {
            const t = lineShape(raw).t
            if (!t || seen.has(`${label}|${t}`)) continue
            seen.add(`${label}|${t}`)
            labels.push(label)
            texts.push(t)
          }
        }
        const vectors: Float32Array[] = []
        for (let i = 0; i < texts.length; i += 64) vectors.push(...await embedder.embed(texts.slice(i, i + 64)))
        const centroids = new Map<ExampleLabel, Float32Array>()
        for (const label of new Set(labels)) {
          const vs = vectors.filter((_, i) => labels[i] === label)
          const c = new Float32Array(vs[0]!.length)
          for (const v of vs) for (let i = 0; i < v.length; i++) c[i]! += v[i]!
          centroids.set(label, normalise(c))
        }
        loadMs = Math.round(performance.now() - t0)
        state = 'ready'
        opts.log?.info(`embeddings: ${opts.embedder ? 'injected embedder' : model} ready in ${loadMs} ms (${texts.length} examples, ${method}${method === 'knn' ? ` k=${k}` : ''})`)
        return { embedder, index: { labels, vectors, centroids } }
      } catch (err) {
        state = 'unavailable'
        why = (err as Error).message.split('\n')[0]!.slice(0, 200)
        opts.log?.warn(`embeddings layer unavailable, skipping it: ${why}`)
        return null
      }
    })()
    return ready
  }

  const scoresFor = (index: Index, q: Float32Array): { label: ExampleLabel, score: number }[] => {
    const out: { label: ExampleLabel, score: number }[] = []
    if (method === 'centroid') {
      for (const [label, c] of index.centroids) out.push({ label, score: dot(q, c) })
    } else {
      const per = new Map<ExampleLabel, number[]>()
      index.vectors.forEach((v, i) => {
        const l = index.labels[i]!
        const arr = per.get(l) ?? []
        arr.push(dot(q, v))
        per.set(l, arr)
      })
      for (const [label, sims] of per) {
        const top = sims.sort((a, b) => b - a).slice(0, k)
        out.push({ label, score: top.reduce((a, b) => a + b, 0) / top.length })
      }
    }
    return out.sort((a, b) => b.score - a.score)
  }

  const scores = async (text: string) => {
    const r = await ensure()
    if (!r) return null
    const t = lineShape(text).t
    if (!t) return null
    const [q] = await r.embedder.embed([t])
    return scoresFor(r.index, q!)
  }

  return {
    name,
    kind: 'embeddings',
    status: () => state,
    reason: () => why,
    async warmup () { await ensure(); return loadMs },
    scores,
    async classify (text: string, ctx: ParseContext): Promise<LayerResult | null> {
      const shape = lineShape(text)
      if (!shape.t || shape.t.length > 120) return null
      const ranked = await scores(text)
      if (!ranked?.length) return null
      const r = (n: number) => Math.round(n * 1000) / 1000
      const bestIntent = ranked.find(s => s.label !== 'none')
      if (!bestIntent) return null
      const intent = bestIntent.label as IntentName
      const runnerUp = ranked.find(s => s !== bestIntent)
      const base = { intent, args: {}, confidence: r(bestIntent.score), layer: name, ms: 0, note: runnerUp ? `next ${runnerUp.label} ${r(runnerUp.score)}` : undefined }
      if (ranked[0]!.label === 'none') return { ...base, rejected: `closest to chat ${r(ranked[0]!.score)}` }
      if (isStatement(shape.t)) return { ...base, rejected: 'a statement, not a request' }
      if (addressesOther(text)) return { ...base, rejected: 'said to someone else' }
      // the margin is against the runner-up outside the intent's family (stop/start, give/bring are settled by the words)
      const family = FAMILIES.find(f => f.includes(intent)) ?? [intent]
      const rival = ranked.find(s => s !== bestIntent && !family.includes(s.label as IntentName))
      if (rival && bestIntent.score - rival.score < margin) return { ...base, rejected: `margin ${r(bestIntent.score - rival.score)} < ${margin} (${rival.label})` }
      const shaped = shapeConfidence(refine(intent, shape.t), bestIntent.score, shape)
      if (shaped === null) return { ...base, rejected: 'negated' }
      const slots = extractSlots(intent, text, ctx, opts)
      if (!slots.ok) return { ...base, confidence: shaped, rejected: `no ${slots.missing}` }
      return { ...base, intent: slots.intent, args: slots.args, confidence: shaped }
    }
  }
}
