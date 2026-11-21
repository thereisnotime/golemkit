import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { IntentPipeline, formatDecision, type IntentLayer, type LayerResult } from '../src/brains/intents/pipeline.ts'
import { embeddingsLayer, type Embedder } from '../src/brains/intents/layers/embeddings.ts'
import { localLlmLayer, extractJson } from '../src/brains/intents/layers/local-llm.ts'
import { patternsLayer } from '../src/brains/intents/layers/patterns.ts'
import { resolveConfig, buildPipeline, layersToSettings } from '../src/brains/intents/config.ts'
import { extractSlots, validateModelArgs, findAmount, findItem } from '../src/brains/intents/slots.ts'
import { EXAMPLES } from '../src/brains/intents/examples.ts'
import { lineShape, type IntentName } from '../src/brains/intents/parse.ts'
import { parseProfile } from '../src/core/profile.ts'
import { findToggle, parseToggleValue, deepMerge, expandPaths } from '../src/core/toggles.ts'
import { runBench, parseConfig, pipelineFor, table } from '../scripts/intents-bench.ts'
import { HELDOUT_CASES } from './fixtures/intents-heldout.ts'
import { SEEN_CASES } from './fixtures/intents-seen.ts'

const ctx = { speaker: 'Tester' }

// ------------------------------------------------------------------ fakes

/** A layer with a fixed answer (sync or async), counting its calls. */
function fake (name: string, answer: Partial<LayerResult> | null, o: { sync?: boolean, delay?: number, status?: 'ready' | 'unavailable', fail?: boolean } = {}): IntentLayer & { calls: number } {
  const res = (): LayerResult | null => answer ? { intent: 'follow', args: {}, confidence: 0.9, layer: name, ms: 0, ...answer } : null
  const layer: IntentLayer & { calls: number } = {
    name,
    kind: 'fake',
    calls: 0,
    status: () => o.status ?? 'ready',
    async classify () {
      layer.calls++
      if (o.delay) await new Promise(r => setTimeout(r, o.delay))
      if (o.fail) throw new Error('boom')
      return res()
    }
  }
  if (o.sync) layer.classifySync = () => { layer.calls++; return res() }
  return layer
}

/** Deterministic bag-of-words vectors: each word hashes into one of 128 dimensions. */
const words = (t: string) => t.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
function hashEmbedder (): Embedder & { calls: number } {
  const e = {
    calls: 0,
    async embed (texts: string[]) {
      e.calls++
      return texts.map(t => {
        const v = new Float32Array(128)
        for (const w of words(t)) { let h = 0; for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0; v[h % 128]! += 1 }
        const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1
        return v.map(x => x / n)
      })
    }
  }
  return e
}

const TINY_EXAMPLES = {
  follow: ['follow me', 'walk with me', 'stay with me'],
  guard: ['protect me', 'guard me', 'keep me safe'],
  collect: ['mine stone', 'dig dirt', 'collect gravel'],
  none: ['lol', 'nice house', 'good morning']
}

// ------------------------------------------------------------------ pipeline strategies

test('first_confident: the first layer above its threshold wins, later layers never run', async () => {
  const a = fake('a', { intent: 'guard', confidence: 0.5 })
  const b = fake('b', { intent: 'follow', confidence: 0.8 })
  const c = fake('c', { intent: 'stop', confidence: 0.99 })
  const p = new IntentPipeline([{ layer: a, threshold: 0.7 }, { layer: b, threshold: 0.7 }, { layer: c, threshold: 0.7 }])
  const d = await p.decide('x', ctx)
  assert.equal(d.winner?.layer, 'b')
  assert.equal(c.calls, 0)
  assert.deepEqual(d.trace.map(e => [e.layer, e.accepted]), [['a', false], ['b', true]])
  assert.match(formatDecision('x', d), /a: guard 0\.50 low .*\| b: follow 0\.80 .*=> b follow/)
})

test('rejected guesses and errors never win; unavailable layers are skipped', async () => {
  const a = fake('a', { intent: 'guard', confidence: 0.95, rejected: 'margin' })
  const b = fake('b', null, { fail: true })
  const c = fake('c', { intent: 'stop' }, { status: 'unavailable' })
  const d = await new IntentPipeline([{ layer: a, threshold: 0.7 }, { layer: b, threshold: 0.7 }, { layer: c, threshold: 0.7 }]).decide('x', ctx)
  assert.equal(d.winner, null)
  assert.equal(d.trace[1]!.error, 'boom')
  assert.match(d.trace[2]!.skipped!, /unavailable/)
  assert.equal(c.calls, 0)
})

test('decideSync: decides when a leading sync layer is confident or every layer is sync; otherwise defers', () => {
  const sync = fake('s', { intent: 'stop', confidence: 0.9 }, { sync: true })
  const syncLow = fake('s', { intent: 'stop', confidence: 0.3 }, { sync: true })
  const slow = fake('slow', { intent: 'follow' })
  assert.equal(new IntentPipeline([{ layer: sync, threshold: 0.7 }, { layer: slow, threshold: 0.7 }]).decideSync('x', ctx)?.winner?.intent, 'stop')
  assert.equal(new IntentPipeline([{ layer: syncLow, threshold: 0.7 }, { layer: slow, threshold: 0.7 }]).decideSync('x', ctx), undefined)
  assert.equal(new IntentPipeline([{ layer: syncLow, threshold: 0.7 }]).decideSync('x', ctx)?.winner, null)
  // an unavailable async layer doesn't force waiting
  const gone = fake('gone', { intent: 'follow' }, { status: 'unavailable' })
  assert.equal(new IntentPipeline([{ layer: syncLow, threshold: 0.7 }, { layer: gone, threshold: 0.7 }]).decideSync('x', ctx)?.winner, null)
  // vote/best need every layer
  assert.equal(new IntentPipeline([{ layer: sync, threshold: 0.7 }, { layer: slow, threshold: 0.7 }], { strategy: 'best' }).decideSync('x', ctx), undefined)
})

test('vote: the intent most confident layers agree on; best: the highest confidence', async () => {
  const layers = [
    { layer: fake('a', { intent: 'guard', confidence: 0.95 }), threshold: 0.7 },
    { layer: fake('b', { intent: 'follow', confidence: 0.75 }), threshold: 0.7 },
    { layer: fake('c', { intent: 'follow', confidence: 0.8, args: { player: 'x' } }), threshold: 0.7 },
    { layer: fake('d', { intent: 'stop', confidence: 0.6 }), threshold: 0.7 }
  ]
  const vote = await new IntentPipeline(layers, { strategy: 'vote' }).decide('x', ctx)
  assert.equal(vote.winner?.intent, 'follow')
  assert.deepEqual(vote.winner?.args, { player: 'x' }, 'args from the most confident voter')
  assert.equal((await new IntentPipeline(layers, { strategy: 'vote', minVotes: 3 }).decide('x', ctx)).winner, null)
  assert.equal((await new IntentPipeline(layers, { strategy: 'best' }).decide('x', ctx)).winner?.layer, 'a')
  assert.equal(vote.trace.length, 4, 'vote runs every layer')
})

// ------------------------------------------------------------------ embeddings layer

test('embeddings: nearest examples pick the intent, slots come from the line', async () => {
  const e = hashEmbedder()
  const layer = embeddingsLayer({ embedder: e, examples: TINY_EXAMPLES, margin: 0.02 })
  assert.equal(layer.status!(), 'idle')
  const r = await layer.classify('please follow me', ctx)
  assert.equal(layer.status!(), 'ready')
  assert.equal(r?.intent, 'follow')
  assert.deepEqual(r?.args, { player: 'Tester' })
  const m = await layer.classify('mine 20 stone', ctx)
  assert.equal(m?.intent, 'collect')
  assert.deepEqual(m?.args, { item: 'stone', count: 20 })
  // chat is closest to the none examples
  const chat = await layer.classify('nice house lol', ctx)
  assert.match(chat?.rejected ?? '', /chat/)
  // negated and question shapes count as for the patterns
  assert.equal((await layer.classify("don't mine stone", ctx))?.rejected, 'negated')
  const q = await layer.classify('did you mine stone?', ctx)
  assert.ok(q && q.confidence < 0.6, `question halves confidence: ${q?.confidence}`)
})

test('embeddings: margin, missing slots, knn vs centroid', async () => {
  const e = hashEmbedder()
  const tight = embeddingsLayer({ embedder: e, examples: { follow: ['walk with me'], guard: ['walk guard me'] }, margin: 0.5 })
  assert.match((await tight.classify('walk me', ctx))?.rejected ?? '', /margin/)
  const noItem = embeddingsLayer({ embedder: e, examples: TINY_EXAMPLES })
  assert.equal((await noItem.classify('collect', ctx))?.rejected, 'no item')
  const centroid = embeddingsLayer({ embedder: e, examples: TINY_EXAMPLES, method: 'centroid' })
  assert.equal((await centroid.classify('guard me', ctx))?.intent, 'guard')
  const knn1 = embeddingsLayer({ embedder: e, examples: TINY_EXAMPLES, k: 1 })
  assert.equal((await knn1.classify('guard me', ctx))?.confidence, 1)
})

test('embeddings: an embedder that fails to load makes the layer unavailable (logged once) and the pipeline skips it', async () => {
  const warns: string[] = []
  const layer = embeddingsLayer({ embedder: async () => { throw new Error('Cannot find package @huggingface/transformers') }, log: { info () {}, debug () {}, warn: m => warns.push(m) } })
  const patterns = patternsLayer()
  const p = new IntentPipeline([{ layer, threshold: 0.6 }, { layer: patterns, threshold: 0.7 }])
  const d1 = await p.decide('follow me', ctx)
  const d2 = await p.decide('come here', ctx)
  assert.equal(layer.status!(), 'unavailable')
  assert.equal(d1.winner?.intent, 'follow')
  assert.equal(d2.winner?.intent, 'come')
  assert.match(d2.trace[0]!.skipped!, /unavailable: Cannot find package/)
  assert.equal(warns.length, 1)
  // later decisions don't wait for it
  assert.equal(p.decideSync('stop', ctx)?.winner?.intent, 'stop')
})

// ------------------------------------------------------------------ local_llm layer

async function server (handler: (body: any) => { status?: number, body: unknown, delay?: number }): Promise<{ url: string, close: () => Promise<void>, bodies: any[] }> {
  const bodies: any[] = []
  const s: Server = createServer((req, res) => {
    let data = ''
    req.on('data', c => { data += c })
    req.on('end', () => {
      const body = JSON.parse(data)
      bodies.push(body)
      const r = handler(body)
      setTimeout(() => {
        res.writeHead(r.status ?? 200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(r.body))
      }, r.delay ?? 0)
    })
  })
  await new Promise<void>(r => s.listen(0, '127.0.0.1', r))
  const port = (s.address() as AddressInfo).port
  return { url: `http://127.0.0.1:${port}/v1`, bodies, close: () => new Promise(r => { s.closeAllConnections(); s.close(() => r()) }) }
}
const reply = (content: string) => ({ body: { choices: [{ message: { content } }] } })

test('local_llm: valid JSON becomes a validated intent; the request asks for strict JSON', async () => {
  const srv = await server(() => reply('{"intent":"collect","args":{"item":"cobblestone","count":64},"confidence":0.9}'))
  try {
    const layer = localLlmLayer({ url: srv.url, model: 'tiny' })
    const r = await layer.classify('fetch me a stack of cobble', ctx)
    assert.equal(r?.intent, 'collect')
    assert.deepEqual(r?.args, { item: 'cobblestone', count: 64 })
    assert.equal(r?.rejected, undefined)
    assert.equal(srv.bodies[0].model, 'tiny')
    assert.equal(srv.bodies[0].response_format.type, 'json_object')
    assert.match(srv.bodies[0].messages[0].content, /never invent items/i)
  } finally { await srv.close() }
})

test('local_llm: invalid JSON is an error, "none" is no intent, unknown intents are errors', async () => {
  let content = 'sure! I think they want you to follow'
  const srv = await server(() => reply(content))
  try {
    const layer = localLlmLayer({ url: srv.url, model: 'tiny' })
    const p = new IntentPipeline([{ layer, threshold: 0.7 }])
    const d = await p.decide('walk behind me', ctx)
    assert.equal(d.winner, null)
    assert.match(d.trace[0]!.error!, /invalid JSON/)
    content = '```json\n{"intent":"none","args":{}}\n```'
    assert.equal(await layer.classify('lol', ctx), null)
    content = '{"intent":"rm -rf","args":{}}'
    await assert.rejects(async () => layer.classify('do something', ctx), /unknown intent/)
  } finally { await srv.close() }
})

test('local_llm: invented items, counts and coordinates reject the guess', async () => {
  let content = ''
  const srv = await server(() => reply(content))
  try {
    const layer = localLlmLayer({ url: srv.url, model: 'tiny' })
    content = '{"intent":"bring","args":{"item":"diamond_sword"},"confidence":0.95}'
    assert.match((await layer.classify('bring me bread', ctx))?.rejected ?? '', /diamond_sword isn't in the line/)
    content = '{"intent":"bring","args":{"item":"unobtainium"},"confidence":0.95}'
    assert.match((await layer.classify('bring me unobtainium', ctx))?.rejected ?? '', /invented item/)
    content = '{"intent":"collect","args":{"item":"sand","count":500}}'
    assert.match((await layer.classify('dig some sand', ctx))?.rejected ?? '', /count 500/)
    content = '{"intent":"goto","args":{"x":100,"y":64,"z":-5}}'
    assert.match((await layer.classify('go to the mine', ctx))?.rejected ?? '', /coordinate/)
    content = '{"intent":"goto","args":{"x":100,"y":64,"z":-5}}'
    assert.deepEqual((await layer.classify('walk over to 100 64 -5', ctx))?.args, { x: 100, y: 64, z: -5 })
  } finally { await srv.close() }
})

test('local_llm: a slow endpoint times out, an unreachable one is skipped for a while', async () => {
  const srv = await server(() => ({ ...reply('{"intent":"stop"}'), delay: 400 }))
  try {
    const layer = localLlmLayer({ url: srv.url, model: 'tiny', timeoutMs: 100 })
    const d = await new IntentPipeline([{ layer, threshold: 0.7 }]).decide('stop', ctx)
    assert.match(d.trace[0]!.error!, /timeout 100ms/)
    assert.ok(d.ms < 380, `gave up at ${d.ms} ms`)
  } finally { await srv.close() }
  const warns: string[] = []
  const gone = localLlmLayer({ url: 'http://127.0.0.1:9/v1', model: 'tiny', log: { info () {}, debug () {}, warn: m => warns.push(m) } })
  const p = new IntentPipeline([{ layer: gone, threshold: 0.7 }, { layer: patternsLayer(), threshold: 0.7 }])
  assert.equal((await p.decide('follow me', ctx)).winner?.layer, 'patterns')
  assert.equal(gone.status!(), 'unavailable')
  assert.match((await p.decide('come here', ctx)).trace[0]!.skipped!, /unavailable: can't reach/)
  assert.equal(warns.length, 1)
})

test('extractJson takes the first object and never evaluates anything', () => {
  assert.deepEqual(extractJson('here you go: {"intent":"eat","args":{}} done'), { intent: 'eat', args: {} })
  assert.throws(() => extractJson('{intent: eat}'))
  assert.throws(() => extractJson('no json'))
})

// ------------------------------------------------------------------ slots

test('slots: amounts, items and places come from the line', () => {
  assert.equal(findAmount('get me 20 of those logs'), 20)
  assert.equal(findAmount('a stack of cobble'), 64)
  assert.equal(findAmount('some sand'), undefined)
  assert.equal(findItem('grab me some cobble', 'block'), 'cobblestone')
  assert.equal(findItem('fetch me a pickaxe', 'item'), 'pickaxe')
  assert.equal(findItem('nothing useful here', 'item'), null)
  assert.deepEqual(extractSlots('goto', 'could you head back to base', ctx), { ok: true, intent: 'go_home', args: {} })
  assert.deepEqual(extractSlots('goto', 'head over to the mine', ctx), { ok: true, intent: 'goto', args: { place: 'mine' } })
  assert.deepEqual(extractSlots('behavior_on', 'stop chopping', ctx), { ok: true, intent: 'behavior_off', args: { activity: 'chopping' } })
  assert.deepEqual(extractSlots('guard', 'no need to guard me anymore', ctx), { ok: true, intent: 'unguard', args: {} })
  assert.deepEqual(extractSlots('bring', 'hand me your bread', ctx), { ok: true, intent: 'give', args: { item: 'bread' } })
  assert.deepEqual(extractSlots('bring', 'bring me', ctx), { ok: false, missing: 'item' })
  assert.deepEqual(validateModelArgs('bring', { item: 'bread', count: 5 }, 'bring me 5 bread', ctx), { ok: true, intent: 'bring', args: { item: 'bread', count: 5 } })
})

// ------------------------------------------------------------------ config

test('config: no layers configured = patterns at 0.7 then the cloud handoff, first_confident', () => {
  const c = resolveConfig({})
  assert.deepEqual(c.layers.map(l => [l.name, l.threshold]), [['patterns', 0.7]])
  assert.equal(c.handoff, true)
  assert.equal(c.strategy, 'first_confident')
  assert.equal(c.logDecisions, false)
  assert.equal(resolveConfig({ threshold: 0.8 }).layers[0]!.threshold, 0.8, 'intents.threshold still sets the patterns threshold')
})

test('config: profile layers keep their order; toggles switch layers and thresholds live', () => {
  const p = parseProfile(`
variant: companion
intents:
  mode: first
  strategy: first_confident
  log_decisions: true
  layers:
    - { use: patterns, threshold: 0.7 }
    - { use: embeddings, threshold: 0.62, margin: 0.05, model: Xenova/all-MiniLM-L6-v2, method: knn, k: 3 }
    - { use: local_llm, url: http://127.0.0.1:11434/v1, model: qwen2.5:1.5b, timeout_ms: 2000, threshold: 0.7, enabled: false }
    - { use: cloud_llm }
`)
  const settings = p.options.settings as Record<string, unknown>
  const s = settings.intents as any
  assert.deepEqual(s.order, ['patterns', 'embeddings', 'local_llm', 'cloud_llm'])
  let c = resolveConfig(s)
  assert.deepEqual(c.layers.map(l => `${l.name}@${l.threshold}`), ['patterns@0.7', 'embeddings@0.62'])
  assert.equal(c.layers[1]!.k, 3)
  assert.equal(c.logDecisions, true)
  // live toggles land as dotted overrides merged into settings, like agent.settings does
  const over = (flat: Record<string, unknown>) => (deepMerge(settings, expandPaths(flat)) as any).intents
  for (const [k, v] of [['intents.layers.embeddings.threshold', '0.55'], ['intents.layers.local_llm.enabled', 'on'], ['intents.strategy', 'vote'], ['intents.layers.cloud_llm.enabled', 'off']] as const) {
    const def = findToggle(k)
    assert.ok(def, k)
    assert.ok(parseToggleValue(def, v).ok, k)
  }
  c = resolveConfig(over({ 'intents.layers.embeddings.threshold': 0.55, 'intents.layers.local_llm.enabled': true, 'intents.strategy': 'vote', 'intents.layers.cloud_llm.enabled': false }))
  assert.deepEqual(c.layers.map(l => `${l.name}@${l.threshold}`), ['patterns@0.7', 'embeddings@0.55', 'local_llm@0.7'])
  assert.equal(c.strategy, 'vote')
  assert.equal(c.handoff, false)
  assert.equal(c.layers[2]!.url, 'http://127.0.0.1:11434/v1')
  // switching patterns off
  assert.deepEqual(resolveConfig(over({ 'intents.layers.patterns.enabled': false })).layers.map(l => l.name), ['embeddings'])
})

test('config: a toggle can switch on embeddings on a bot without layer config (added before the handoff)', () => {
  const c = resolveConfig({ layers: { embeddings: { enabled: true } } })
  assert.deepEqual(c.layers.map(l => `${l.name}@${l.threshold}`), ['patterns@0.7', 'embeddings@0.62'])
  assert.equal(c.handoff, true)
  assert.equal(resolveConfig({ layers: { embeddings: { threshold: 0.5 } } }).layers.length, 1, 'a threshold alone does not switch it on')
})

test('config: bad layer entries are refused by the profile schema; local_llm without url is skipped', () => {
  assert.throws(() => parseProfile('variant: x\nintents:\n  layers:\n    - { use: magic }\n'))
  assert.throws(() => parseProfile('variant: x\nintents:\n  layers:\n    - { use: embeddings, threshold: 3 }\n'))
  assert.throws(() => parseProfile('variant: x\nintents:\n  strategy: random\n'))
  const warns: string[] = []
  const pipe = buildPipeline(resolveConfig({}, [{ use: 'patterns' }, { use: 'local_llm' }]), { log: { info () {}, debug () {}, warn: m => warns.push(m) } })
  assert.deepEqual(pipe.layers.map(l => l.layer.name), ['patterns'])
  assert.match(warns[0]!, /needs url and model/)
  assert.deepEqual(layersToSettings([{ use: 'local_llm', name: 'qwen' }]), { layers: { qwen: { use: 'local_llm', name: 'qwen' } }, order: ['qwen'] })
})

test('config: pipelines reuse cached layer instances, so a threshold change keeps a loaded model', () => {
  const cache = new Map<string, IntentLayer>()
  const e = hashEmbedder()
  const a = buildPipeline(resolveConfig({}, [{ use: 'embeddings', threshold: 0.6 }]), { cache, embedder: e })
  const b = buildPipeline(resolveConfig({}, [{ use: 'embeddings', threshold: 0.5 }]), { cache, embedder: e })
  assert.equal(a.layers[0]!.layer, b.layers[0]!.layer)
  assert.equal(b.layers[0]!.threshold, 0.5)
})

// ------------------------------------------------------------------ benchmark

test('bench: metrics on a tiny dataset', async () => {
  const pipe = pipelineFor(parseConfig('patterns'), {})
  const m = await runBench(pipe, [
    ['follow me', 'follow', { player: 'Tester' }],
    ['get 10 dirt', 'collect', { item: 'dirt', count: 10 }],
    ['shadow me', 'follow'],
    ['lol', null],
    ['steve come here', null]
  ], { config: 'patterns', set: 'tiny' })
  assert.equal(m.n, 5)
  assert.equal(m.accuracy, 0.8)
  assert.equal(m.falseTriggers, 0)
  assert.equal(m.misses, 1)
  assert.equal(m.slotAccuracy, 1)
  assert.equal(m.slotCases, 2)
  assert.ok(m.macroF1 > 0.6 && m.macroF1 < 1)
  assert.deepEqual(m.errors.map(e => e.text), ['shadow me'])
  assert.match(table([m]), /\| patterns \| tiny \| 5 +\| 0\.800/)
  assert.deepEqual(parseConfig('patterns+embeddings:threshold=0.6,k=5@vote').layers, [{ use: 'patterns' }, { use: 'embeddings', threshold: 0.6, k: 5 }])
  assert.equal(parseConfig('patterns+embeddings@vote').strategy, 'vote')
  assert.throws(() => parseConfig('patterns+magic'))
})

test('bench data: held-out lines are not among the embeddings examples or the seen set; enough of them', () => {
  const seen = new Set([...Object.values(EXAMPLES).flat(), ...SEEN_CASES.map(c => c[0])].map(t => lineShape(t ?? '').t))
  const overlap = HELDOUT_CASES.filter(c => seen.has(lineShape(c[0]).t)).map(c => c[0])
  assert.deepEqual(overlap, [])
  assert.ok(HELDOUT_CASES.length >= 60)
  assert.ok(HELDOUT_CASES.filter(c => c[1] === null).length >= 15, 'must-not-trigger lines')
  const labels = new Set(Object.keys(EXAMPLES))
  for (const [, intent] of HELDOUT_CASES) if (intent) assert.ok(labels.has(intent as IntentName), intent)
})

// ------------------------------------------------------------------ the real model (opt-in)

test('real model: all-MiniLM-L6-v2 catches paraphrases the patterns miss', { skip: process.env.INTENTS_REAL_MODEL !== '1' && 'set INTENTS_REAL_MODEL=1 (downloads ~23 MB to data/models once)' }, async () => {
  const layer = embeddingsLayer({ margin: 0.03 })
  const ms = await layer.warmup!()
  assert.equal(layer.status!(), 'ready', layer.reason!() ?? '')
  assert.ok(ms > 0)
  const p = new IntentPipeline([{ layer: patternsLayer(), threshold: 0.7 }, { layer, threshold: 0.55 }])
  for (const [line, intent] of [['keep the zombies off me', 'guard'], ['hurry over to me', 'come'], ['stop wandering around please', 'behavior_off'], ['lol nice', null]] as const) {
    const d = await p.decide(line, ctx)
    assert.equal(d.winner?.intent ?? null, intent, formatDecision(line, d))
  }
})
