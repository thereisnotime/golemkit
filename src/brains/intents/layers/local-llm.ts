// local_llm layer: a small model behind any OpenAI-compatible endpoint (Ollama, llama.cpp
// server, LM Studio) asked for strict JSON {intent, args, confidence} against the known intent
// list, with a short timeout. The output is data, never code: it's JSON.parse'd, the intent must
// be one of ours, and every argument is re-checked against the line (slots.ts validateModelArgs),
// so an invented item, place or coordinate rejects the guess. An endpoint that can't be reached
// is skipped for a while (logged once).
import type { Logger } from '../../../core/index.ts'
import { INTENT_NAMES, addressesOther, isStatement, lineShape, shapeConfidence, type IntentName, type ParseContext } from '../parse.ts'
import { INTENT_ARGS, validateModelArgs, type SlotOptions } from '../slots.ts'
import type { IntentLayer, LayerResult, LayerStatus } from '../pipeline.ts'

export interface LocalLlmLayerOptions extends SlotOptions {
  name?: string
  /** OpenAI-compatible base URL, e.g. http://127.0.0.1:11434/v1 (Ollama). */
  url: string
  model: string
  apiKey?: string
  /** Per-message timeout. Default 2000 ms. */
  timeoutMs?: number
  /** After a connection failure, skip the layer for this long. Default 60 s. */
  retryAfterMs?: number
  /** Confidence when the model doesn't give one. Default 0.8. */
  defaultConfidence?: number
  fetch?: typeof fetch
  log?: Pick<Logger, 'info' | 'warn' | 'debug'>
}

export function localLlmPrompt (): string {
  const intents = INTENT_NAMES.map(i => `${i}${INTENT_ARGS[i].length ? `(${INTENT_ARGS[i].join(', ')})` : ''}`).join('; ')
  return [
    'You classify one Minecraft chat line that a player said to their bot. Reply with one JSON object and nothing else:',
    '{"intent": "<intent or none>", "args": {...}, "confidence": <0..1>}',
    `Intents (optional args in brackets): ${intents}.`,
    'Use "none" for chat, questions about the past, statements, jokes and requests with several steps.',
    'Args: item = Minecraft item name (cobblestone, oak_log, bread), count = number said, place = place name said,',
    'target (find) = what to look for, player = a player name said ("me" = the speaker), at = "speaker" for here/there,',
    'guard target = player | here | place, chop unit = tree | log | planks.',
    'Only use words and numbers that are in the line. Never invent items, places, players or coordinates; leave args out instead.',
    'Examples:',
    '"follow me" -> {"intent":"follow","args":{},"confidence":0.95}',
    '"get 64 cobblestone" -> {"intent":"collect","args":{"item":"cobblestone","count":64},"confidence":0.95}',
    '"chop some wood" -> {"intent":"chop","args":{"unit":"log"},"confidence":0.9}',
    '"go to the farm" -> {"intent":"goto","args":{"place":"farm"},"confidence":0.9}',
    '"stay here" -> {"intent":"stop","args":{"stay":true},"confidence":0.9}',
    '"start farming" -> {"intent":"behavior_on","args":{"activity":"farming"},"confidence":0.9}',
    '"bring me 5 bread" -> {"intent":"bring","args":{"item":"bread","count":5},"confidence":0.95}',
    '"did you eat?" -> {"intent":"none","args":{},"confidence":0.9}'
  ].join('\n')
}

/** The first {...} in a reply (code fences and chatter around it are ignored). */
export function extractJson (text: string): unknown {
  const s = text.replace(/```(?:json)?/g, '')
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  if (a < 0 || b <= a) throw new Error('no JSON object in the reply')
  return JSON.parse(s.slice(a, b + 1))
}

const INTENT_ALIASES: Record<string, string> = { go_to: 'goto', go: 'goto', gohome: 'go_home', home: 'go_home', mine: 'collect', gather: 'collect', get: 'collect', search: 'find', sethome: 'set_home', unguard_me: 'unguard' }

export function normaliseIntent (raw: string): string {
  const s = raw.trim().toLowerCase().replace(/\(.*$/, '').replace(/[\s-]+/g, '_').replace(/[^a-z_]/g, '')
  return INTENT_ALIASES[s] ?? s
}

export function localLlmLayer (opts: LocalLlmLayerOptions): IntentLayer {
  const name = opts.name ?? 'local_llm'
  const base = opts.url.replace(/\/+$/, '')
  const timeoutMs = opts.timeoutMs ?? 2000
  const doFetch = opts.fetch ?? fetch
  let downUntil = 0
  let why: string | undefined
  let warned = false
  let jsonMode = true

  const status = (): LayerStatus => downUntil > Date.now() ? 'unavailable' : 'ready'

  async function call (line: string): Promise<string> {
    const body = {
      model: opts.model,
      messages: [{ role: 'system', content: localLlmPrompt() }, { role: 'user', content: line }],
      temperature: 0,
      max_tokens: 150,
      stream: false,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {})
    }
    let res: Response
    try {
      res = await doFetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      })
    } catch (e) {
      const err = e as Error
      if (err.name === 'TimeoutError' || err.name === 'AbortError') throw new Error(`timeout ${timeoutMs}ms`)
      downUntil = Date.now() + (opts.retryAfterMs ?? 60_000)
      why = `can't reach ${base}: ${(err as { cause?: { code?: string } }).cause?.code ?? err.message}`
      if (!warned) { warned = true; opts.log?.warn(`local_llm layer unavailable, skipping it: ${why}`) }
      throw new Error(why)
    }
    if (res.status === 400 && jsonMode) {
      const text = await res.text().catch(() => '')
      if (/response_format|json/i.test(text)) { jsonMode = false; return call(line) }
      throw new Error(`HTTP 400: ${text.slice(0, 120)}`)
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    if (warned) { warned = false; opts.log?.info(`local_llm layer back: ${base}`) }
    const data = await res.json() as { choices?: { message?: { content?: string } }[] }
    return data.choices?.[0]?.message?.content ?? ''
  }

  return {
    name,
    kind: 'local_llm',
    status,
    reason: () => why,
    async warmup () { return 0 },
    async classify (text: string, ctx: ParseContext): Promise<LayerResult | null> {
      const shape = lineShape(text)
      if (!shape.t || shape.t.length > 160) return null
      if (status() === 'unavailable') return null
      const content = await call(text.trim())
      let parsed: { intent?: unknown, args?: unknown, confidence?: unknown }
      try { parsed = extractJson(content) as typeof parsed } catch (e) {
        throw new Error(`invalid JSON (${(e as Error).message.slice(0, 60)}): ${content.slice(0, 60)}`)
      }
      if (!parsed || typeof parsed !== 'object') return null
      // tolerate spelling ("go_to", "stop(stay)", "Go Home"); the result must still be one of ours
      const intent = typeof parsed.intent === 'string' ? normaliseIntent(parsed.intent) : ''
      if (!intent || intent === 'none' || intent === 'null') return null
      const raw = typeof parsed.confidence === 'number' && parsed.confidence >= 0 && parsed.confidence <= 1 ? parsed.confidence : (opts.defaultConfidence ?? 0.8)
      if (!(INTENT_NAMES as readonly string[]).includes(intent)) throw new Error(`unknown intent ${intent.slice(0, 30)}`)
      const i = intent as IntentName
      if (isStatement(shape.t)) return { intent: i, args: {}, confidence: raw, layer: name, ms: 0, rejected: 'a statement, not a request' }
      if (addressesOther(text)) return { intent: i, args: {}, confidence: raw, layer: name, ms: 0, rejected: 'said to someone else' }
      const shaped = shapeConfidence(i, raw, shape)
      if (shaped === null) return { intent: i, args: {}, confidence: raw, layer: name, ms: 0, rejected: 'negated' }
      const args = parsed.args && typeof parsed.args === 'object' && !Array.isArray(parsed.args) ? parsed.args as Record<string, unknown> : {}
      const v = validateModelArgs(i, args, text, ctx, opts)
      if (!v.ok) return { intent: i, args: {}, confidence: shaped, layer: name, ms: 0, rejected: v.reason }
      return { intent: v.intent, args: v.args, confidence: shaped, layer: name, ms: 0 }
    }
  }
}
