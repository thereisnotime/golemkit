// Pipeline config: which layers run, in which order, with which thresholds, and the strategy.
// Comes from the profile (intents.layers / strategy / log_decisions), brain options and live
// toggles (intents.strategy, intents.layers.<name>.enabled / .threshold). Without any of it the
// pipeline is today's: patterns at 0.7, then the cloud LLM handoff. See docs/guide/intents.md.
import { join } from 'node:path'
import type { Logger } from '../../core/index.ts'
import { DEFAULT_THRESHOLD } from './parse.ts'
import { EXAMPLES, mergeExamples, type Examples } from './examples.ts'
import { IntentPipeline, type IntentLayer, type Strategy } from './pipeline.ts'
import { patternsLayer } from './layers/patterns.ts'
import { embeddingsLayer, DEFAULT_EMBEDDING_MODEL, type Embedder } from './layers/embeddings.ts'
import { localLlmLayer } from './layers/local-llm.ts'
import type { SlotOptions } from './slots.ts'

export type LayerKind = 'patterns' | 'embeddings' | 'local_llm' | 'cloud_llm'
export const LAYER_KINDS: readonly LayerKind[] = ['patterns', 'embeddings', 'local_llm', 'cloud_llm']
export const STRATEGIES: readonly Strategy[] = ['first_confident', 'vote', 'best']

/** One layer entry as written in a profile (snake_case keys as in YAML). */
export interface LayerConfig {
  use: LayerKind
  /** Defaults to `use`; set it to run two layers of a kind (two local models). */
  name?: string
  enabled?: boolean
  threshold?: number
  // embeddings
  model?: string
  dtype?: string
  method?: 'knn' | 'centroid'
  k?: number
  margin?: number
  preload?: boolean
  // local_llm
  url?: string
  timeout_ms?: number
  api_key_var?: string
}

export interface PipelineConfig {
  /** Classifier layers in order (enabled ones only; cloud_llm is not among them). */
  layers: (LayerConfig & { name: string, threshold: number })[]
  strategy: Strategy
  minVotes: number
  logDecisions: boolean
  /** cloud_llm enabled: unresolved lines go to the LLM brain. */
  handoff: boolean
  examples?: Examples
}

export const DEFAULT_THRESHOLDS: Record<Exclude<LayerKind, 'cloud_llm'>, number> = { patterns: DEFAULT_THRESHOLD, embeddings: 0.62, local_llm: 0.7 }

/** The intents settings as they land in agent.settings.intents (profile layers become { layers: {name: entry}, order }). */
export interface IntentsSettings {
  mode?: string
  threshold?: number
  strategy?: Strategy
  log_decisions?: boolean
  min_votes?: number
  layers?: LayerConfig[] | Record<string, Partial<LayerConfig>>
  order?: string[]
  examples?: Examples
}

/** Profile array -> { layers: {name: entry}, order: [names] }, so live toggles (intents.layers.<name>.*) merge into it. */
export function layersToSettings (layers: LayerConfig[]): { layers: Record<string, LayerConfig>, order: string[] } {
  const out: Record<string, LayerConfig> = {}
  const order: string[] = []
  for (const l of layers) {
    const name = l.name ?? l.use
    out[name] = { ...l }
    order.push(name)
  }
  return { layers: out, order }
}

const isKind = (s: unknown): s is LayerKind => typeof s === 'string' && (LAYER_KINDS as readonly string[]).includes(s)

/**
 * Resolves the effective pipeline config. Base order: settings (order + layers object), else
 * `fallbackLayers` (brain options), else [patterns, cloud_llm]. Entries in the settings layers
 * object override by name (that's where live toggles land); a known kind switched on by toggle
 * without a profile entry is added before the handoff.
 */
export function resolveConfig (s: IntentsSettings = {}, fallbackLayers?: LayerConfig[], fallback: { strategy?: Strategy, logDecisions?: boolean } = {}): PipelineConfig {
  let base: LayerConfig[]
  let overrides: Record<string, Partial<LayerConfig>> = {}
  if (Array.isArray(s.layers)) base = s.layers
  else {
    overrides = s.layers ?? {}
    if (s.order?.length) base = s.order.map(n => ({ use: (overrides[n]?.use ?? n) as LayerKind, name: n }))
    else base = fallbackLayers ?? [{ use: 'patterns' }, { use: 'cloud_llm' }]
  }
  const merged: (LayerConfig & { name: string })[] = base.map(l => {
    const name = l.name ?? l.use
    return { ...l, ...overrides[name], name, use: (overrides[name]?.use ?? l.use) as LayerKind }
  })
  for (const [name, o] of Object.entries(overrides)) {
    if (merged.some(l => l.name === name)) continue
    const use = o.use ?? name
    if (o.enabled === true && isKind(use)) merged.splice(merged.findIndex(l => l.use === 'cloud_llm') >>> 0, 0, { ...o, use, name } as LayerConfig & { name: string })
  }
  const cloud = merged.find(l => l.use === 'cloud_llm')
  const layers = merged
    .filter(l => l.use !== 'cloud_llm' && isKind(l.use) && l.enabled !== false)
    .map(l => ({ ...l, threshold: l.threshold ?? (l.use === 'patterns' && s.threshold !== undefined ? s.threshold : DEFAULT_THRESHOLDS[l.use as Exclude<LayerKind, 'cloud_llm'>]) }))
  const strategy = s.strategy && (STRATEGIES as readonly string[]).includes(s.strategy) ? s.strategy : fallback.strategy ?? 'first_confident'
  return {
    layers,
    strategy,
    minVotes: s.min_votes ?? 1,
    logDecisions: s.log_decisions ?? fallback.logDecisions ?? false,
    handoff: cloud ? cloud.enabled !== false : true,
    ...(s.examples ? { examples: s.examples } : {})
  }
}

export interface BuildDeps extends SlotOptions {
  log?: Pick<Logger, 'info' | 'warn' | 'debug'>
  /** Reuse layer instances across rebuilds (a loaded model survives a threshold change). Keyed by the layer's config. */
  cache?: Map<string, IntentLayer>
  embedder?: Embedder | (() => Promise<Embedder>)
  fetch?: typeof fetch
  /** Model cache folder (default data/models). */
  cacheDir?: string
  env?: Record<string, string | undefined>
}

/** Builds the layer for one config entry (thresholds aren't part of the layer; the pipeline applies them). */
export function buildLayer (l: LayerConfig & { name: string }, cfg: Pick<PipelineConfig, 'examples'>, deps: BuildDeps = {}): IntentLayer | null {
  const { threshold: _t, enabled: _e, ...shape } = l
  void _t; void _e
  const key = JSON.stringify({ shape, examples: l.use === 'embeddings' ? cfg.examples ?? null : null })
  const hit = deps.cache?.get(key)
  if (hit) return hit
  let layer: IntentLayer | null = null
  switch (l.use) {
    case 'patterns': layer = patternsLayer({ name: l.name }); break
    case 'embeddings':
      layer = embeddingsLayer({
        name: l.name,
        model: l.model ?? DEFAULT_EMBEDDING_MODEL,
        dtype: l.dtype,
        method: l.method,
        k: l.k,
        margin: l.margin,
        examples: mergeExamples(EXAMPLES, cfg.examples),
        cacheDir: deps.cacheDir ?? join(process.cwd(), 'data', 'models'),
        embedder: deps.embedder,
        knownItem: deps.knownItem,
        log: deps.log
      })
      break
    case 'local_llm':
      if (!l.url || !l.model) { deps.log?.warn(`intents layer ${l.name}: local_llm needs url and model, skipping it`); return null }
      layer = localLlmLayer({
        name: l.name,
        url: l.url,
        model: l.model,
        timeoutMs: l.timeout_ms,
        apiKey: l.api_key_var ? (deps.env ?? process.env)[l.api_key_var] : undefined,
        fetch: deps.fetch,
        knownItem: deps.knownItem,
        log: deps.log
      })
      break
    default: return null
  }
  deps.cache?.set(key, layer)
  return layer
}

export function buildPipeline (cfg: PipelineConfig, deps: BuildDeps = {}): IntentPipeline {
  const layers = cfg.layers.flatMap(l => {
    const layer = buildLayer(l, cfg, deps)
    return layer ? [{ layer, threshold: l.threshold }] : []
  })
  return new IntentPipeline(layers, { strategy: cfg.strategy, minVotes: cfg.minVotes })
}
