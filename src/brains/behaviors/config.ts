// Behaviour configuration from variants and profiles:
//
//   behaviors:
//     keep_fed: true
//     stay_safe: { below: 10 }
//     wander: { enabled: false }
//
// `true` arms with defaults, an object arms with those options unless `enabled: false`.
import type { BehaviorRegistry, Options } from './registry.ts'

export type BehaviorConfigEntry = boolean | ({ enabled?: boolean } & Record<string, unknown>)
export type BehaviorConfig = Record<string, BehaviorConfigEntry>

export interface NormalizedEntry {
  enabled: boolean
  options: Options
}

export function normalizeEntry (entry: BehaviorConfigEntry | null | undefined): NormalizedEntry {
  if (entry === undefined || entry === null) return { enabled: true, options: {} }
  if (typeof entry === 'boolean') return { enabled: entry, options: {} }
  const { enabled, ...options } = entry
  return { enabled: enabled !== false, options }
}

/**
 * Later configs win per behaviour: `enabled` is replaced (an options map means enabled),
 * options merge. Returns a config in the same `{ enabled, ...options }` shape.
 */
export function mergeConfigs (...configs: (BehaviorConfig | undefined)[]): BehaviorConfig {
  const out: Record<string, NormalizedEntry> = {}
  for (const c of configs) {
    if (!c) continue
    for (const [name, raw] of Object.entries(c)) {
      const n = normalizeEntry(raw)
      out[name] = { enabled: n.enabled, options: { ...out[name]?.options, ...n.options } }
    }
  }
  return Object.fromEntries(Object.entries(out).map(([name, e]) => [name, { ...e.options, enabled: e.enabled }]))
}

export class BehaviorConfigError extends Error {
  readonly problems: string[]
  constructor (problems: string[], where = 'behaviors') {
    super(`${where}: ${problems.length === 1 ? problems[0] : '\n  - ' + problems.join('\n  - ')}`)
    this.name = 'BehaviorConfigError'
    this.problems = problems
  }
}

/**
 * Checks a `behaviors:` block against the registry: every name must exist and every option
 * must pass the behaviour's schema. Throws BehaviorConfigError listing all problems.
 * Returns the normalized entries with defaults filled in.
 */
export function validateBehaviorConfig (raw: unknown, registry: BehaviorRegistry, where = 'behaviors'): Record<string, NormalizedEntry> {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new BehaviorConfigError(['must be a map of behaviour name to true/false or options'], where)
  const problems: string[] = []
  const out: Record<string, NormalizedEntry> = {}
  for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!registry.has(name)) { problems.push(registry.unknown(name)); continue }
    if (entry !== null && typeof entry !== 'boolean' && (typeof entry !== 'object' || Array.isArray(entry))) {
      problems.push(`${name}: expected true, false or an options map, got ${JSON.stringify(entry)}`)
      continue
    }
    const n = normalizeEntry(entry as BehaviorConfigEntry)
    if (typeof (entry as any)?.enabled !== 'undefined' && typeof (entry as any).enabled !== 'boolean') {
      problems.push(`${name}.enabled: expected true or false`)
      continue
    }
    const v = registry.validate(name, n.options)
    if (!v.ok) { problems.push(v.error); continue }
    out[name] = { enabled: n.enabled, options: v.options }
  }
  if (problems.length) throw new BehaviorConfigError(problems, where)
  return out
}
