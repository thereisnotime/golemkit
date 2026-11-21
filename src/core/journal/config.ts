// Journal settings: settings.journal (a profile's `journal:` block lands there) plus env.
//
//   journal:
//     enabled: true
//     types: [death, chat_in, action]   # default: all
//     exclude: [player_seen]
//     retentionDays: 14                 # raw JSONL, deleted only after the day's rollup exists
//     rollupRetentionDays: 365
//     caps: { chat_in: 30, default: 60 } # per type per minute
//     actions: { includeStatus: false, skip: [follow] }
//     observe: true                     # recent-events line in observe() with a context pack
//     summarize: { provider: anthropic, model: claude-haiku-4-5 }   # off by default
//
// Env: MC_JOURNAL=false, MC_JOURNAL_TYPES, MC_JOURNAL_RETENTION_DAYS, MC_JOURNAL_SUMMARIZE=<provider>
import type { JournalConfig, SummarizeConfig } from './types.ts'

export const DEFAULT_CAPS: Record<string, number> = {
  default: 60,
  death: 20,
  damage: 12,
  item_gained: 20,
  item_lost: 20,
  block_broken: 12,
  block_placed: 12,
  chat_in: 40,
  chat_out: 30,
  whisper: 30,
  action: 40,
  player_seen: 20,
  place_visited: 10,
  llm_turn: 30,
  journal_dropped: 30
}

const list = (v: unknown): string[] => typeof v === 'string'
  ? v.split(/[\s,]+/).filter(Boolean)
  : Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

const num = (v: unknown, fallback: number): number => {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback
}

const SUMMARY_PASS = ['model', 'effort', 'login', 'oauthTokenVar', 'oauthTokenFile', 'proxy', 'mode', 'transport', 'baseUrl', 'reasoningEffort']

function resolveSummarize (v: unknown, settings: Record<string, unknown>, env: NodeJS.ProcessEnv): SummarizeConfig | null {
  const llm = (settings.llm ?? {}) as Record<string, unknown>
  let o: Record<string, unknown> | null = null
  if (v === true) o = { provider: llm.provider ?? env.MC_LLM_PROVIDER, ...pick(llm) }
  else if (typeof v === 'string') o = { provider: v }
  else if (v && typeof v === 'object') o = v as Record<string, unknown>
  else if (v === undefined && env.MC_JOURNAL_SUMMARIZE) o = { provider: env.MC_JOURNAL_SUMMARIZE }
  if (!o || typeof o.provider !== 'string' || o.provider === 'none' || o.enabled === false) return null
  const { provider, maxChars, enabled: _e, ...rest } = o
  return { provider, options: rest, maxChars: num(maxChars, 600) }
}

function pick (o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(SUMMARY_PASS.filter(k => o[k] !== undefined).map(k => [k, o[k]]))
}

export function resolveJournalConfig (settings: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = process.env): JournalConfig {
  const raw = settings.journal
  const j = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>
  const envOff = env.MC_JOURNAL === 'false' || env.MC_JOURNAL === '0'
  const types = list(j.types ?? env.MC_JOURNAL_TYPES)
  const actions = (j.actions ?? {}) as Record<string, unknown>
  return {
    enabled: raw !== false && j.enabled !== false && !envOff,
    types: types.length ? new Set(types) : null,
    exclude: new Set(list(j.exclude)),
    retentionDays: num(j.retentionDays ?? env.MC_JOURNAL_RETENTION_DAYS, 14),
    rollupRetentionDays: num(j.rollupRetentionDays, 365),
    flushMs: num(j.flushMs, 2000),
    caps: { ...DEFAULT_CAPS, ...(j.caps ?? {}) },
    actions: { includeStatus: actions.includeStatus === true, skip: new Set(list(actions.skip)) },
    observe: j.observe !== false,
    placeRegion: num(j.placeRegion, 64),
    summarize: resolveSummarize(j.summarize, settings, env)
  }
}
