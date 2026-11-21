// The intent pipeline: an ordered list of classifier layers (patterns, embeddings, a local LLM)
// and a strategy that picks the winner. Layers only classify; the brain acts, and the cloud LLM
// handoff (cloud_llm) is the brain's job after the pipeline found nothing. See docs/guide/intents.md.
import type { IntentName, ParseContext } from './parse.ts'

export interface LayerResult {
  intent: IntentName
  args: Record<string, unknown>
  /** 0..1, on the layer's own scale (pattern confidence, cosine similarity, model confidence). */
  confidence: number
  layer: string
  ms: number
  /** Why the guess can't be used whatever its confidence (margin too small, slot missing, invented item). */
  rejected?: string
  /** Extra detail for the decision log (runner-up, raw output). */
  note?: string
}

export type LayerStatus = 'ready' | 'idle' | 'loading' | 'unavailable'

export interface IntentLayer {
  name: string
  /** Layer kind: patterns, embeddings, local_llm. */
  kind: string
  /** A guess (possibly below threshold or rejected), or null for "no idea / not a command". */
  classify (text: string, ctx: ParseContext): Promise<LayerResult | null> | LayerResult | null
  /** Synchronous classification, for layers that can (patterns): lets the brain decide without waiting. */
  classifySync? (text: string, ctx: ParseContext): LayerResult | null
  /** idle = not loaded yet (loads on first classify), unavailable = skipped. Default ready. */
  status? (): LayerStatus
  /** Why it's unavailable. */
  reason? (): string | undefined
  /** Loads models ahead of the first message; resolves with the load time in ms (0 if nothing to load). */
  warmup? (): Promise<number>
}

export interface PipelineLayer {
  layer: IntentLayer
  threshold: number
}

export type Strategy = 'first_confident' | 'vote' | 'best'

export interface TraceEntry {
  layer: string
  result: LayerResult | null
  accepted: boolean
  ms: number
  skipped?: string
  error?: string
}

export interface Decision {
  winner: LayerResult | null
  trace: TraceEntry[]
  ms: number
}

export interface PipelineOptions {
  strategy?: Strategy
  /** vote: votes the winning intent needs (default 1: a plurality of the confident layers). */
  minVotes?: number
}

const now = () => performance.now()

export class IntentPipeline {
  readonly layers: PipelineLayer[]
  readonly strategy: Strategy
  readonly minVotes: number

  constructor (layers: PipelineLayer[], opts: PipelineOptions = {}) {
    this.layers = layers
    this.strategy = opts.strategy ?? 'first_confident'
    this.minVotes = Math.max(1, opts.minVotes ?? 1)
  }

  private accepted (r: LayerResult | null, threshold: number): boolean {
    return !!r && !r.rejected && r.confidence >= threshold
  }

  private skip (l: PipelineLayer): string | undefined {
    if (l.layer.status?.() === 'unavailable') return `unavailable${l.layer.reason?.() ? `: ${l.layer.reason()}` : ''}`
    return undefined
  }

  private async run (l: PipelineLayer, text: string, ctx: ParseContext): Promise<TraceEntry> {
    const skipped = this.skip(l)
    if (skipped) return { layer: l.layer.name, result: null, accepted: false, ms: 0, skipped }
    const t0 = now()
    try {
      const result = await l.layer.classify(text, ctx)
      const ms = Math.round((now() - t0) * 10) / 10
      if (result) result.ms = ms
      // the layer may have found out during the call that it can't run
      const late = !result ? this.skip(l) : undefined
      return { layer: l.layer.name, result, accepted: this.accepted(result, l.threshold), ms, ...(late ? { skipped: late } : {}) }
    } catch (e) {
      return { layer: l.layer.name, result: null, accepted: false, ms: Math.round((now() - t0) * 10) / 10, error: (e as Error).message }
    }
  }

  /**
   * Decides without awaiting anything when it can: first_confident with a leading synchronous
   * layer that is confident, or a pipeline of synchronous layers only. Undefined means the
   * remaining layers are async (call decide()).
   */
  decideSync (text: string, ctx: ParseContext): Decision | undefined {
    const t0 = now()
    const trace: TraceEntry[] = []
    for (const l of this.layers) {
      const skipped = this.skip(l)
      if (skipped) { trace.push({ layer: l.layer.name, result: null, accepted: false, ms: 0, skipped }); continue }
      if (!l.layer.classifySync) return undefined
      const s = now()
      let result: LayerResult | null = null
      let error: string | undefined
      try { result = l.layer.classifySync(text, ctx) } catch (e) { error = (e as Error).message }
      const ms = Math.round((now() - s) * 10) / 10
      if (result) result.ms = ms
      const accepted = this.accepted(result, l.threshold)
      trace.push({ layer: l.layer.name, result, accepted, ms, ...(error ? { error } : {}) })
      if (accepted && this.strategy === 'first_confident') return { winner: result, trace, ms: Math.round((now() - t0) * 10) / 10 }
    }
    return { winner: this.pick(trace), trace, ms: Math.round((now() - t0) * 10) / 10 }
  }

  /** Runs the layers by the strategy: first_confident in order until one is confident, vote and best all of them (in parallel). */
  async decide (text: string, ctx: ParseContext): Promise<Decision> {
    const t0 = now()
    const trace: TraceEntry[] = []
    if (this.strategy === 'first_confident') {
      for (const l of this.layers) {
        const e = await this.run(l, text, ctx)
        trace.push(e)
        if (e.accepted) break
      }
    } else {
      trace.push(...await Promise.all(this.layers.map(l => this.run(l, text, ctx))))
    }
    return { winner: this.pick(trace), trace, ms: Math.round((now() - t0) * 10) / 10 }
  }

  /** The winner among the accepted guesses, by the strategy. */
  pick (trace: TraceEntry[]): LayerResult | null {
    const ok = trace.filter(e => e.accepted && e.result).map(e => e.result!)
    if (!ok.length) return null
    if (this.strategy === 'first_confident') return ok[0]!
    if (this.strategy === 'best') return ok.reduce((a, b) => b.confidence > a.confidence ? b : a)
    // vote: most confident layers agreeing on the intent; ties go to the higher summed confidence
    const tally = new Map<IntentName, { votes: number, sum: number, top: LayerResult }>()
    for (const r of ok) {
      const t = tally.get(r.intent) ?? { votes: 0, sum: 0, top: r }
      t.votes++
      t.sum += r.confidence
      if (r.confidence > t.top.confidence) t.top = r
      tally.set(r.intent, t)
    }
    const best = [...tally.values()].sort((a, b) => b.votes - a.votes || b.sum - a.sum)[0]!
    return best.votes >= this.minVotes ? best.top : null
  }
}

/** One line for the decision log: each layer's guess, confidence and time, then the winner. */
export function formatDecision (text: string, d: Decision): string {
  const parts = d.trace.map(e => {
    if (e.skipped) return `${e.layer}: skipped (${e.skipped})`
    if (e.error) return `${e.layer}: error (${e.error})`
    if (!e.result) return `${e.layer}: - ${e.ms}ms`
    const r = e.result
    return `${e.layer}: ${r.intent} ${r.confidence.toFixed(2)}${r.rejected ? ` rejected (${r.rejected})` : e.accepted ? '' : ' low'}${r.note ? ` [${r.note}]` : ''} ${e.ms}ms`
  })
  const w = d.winner
  return `"${text}" | ${parts.join(' | ')} => ${w ? `${w.layer} ${w.intent} ${JSON.stringify(w.args)}` : 'none'} (${d.ms}ms)`
}
