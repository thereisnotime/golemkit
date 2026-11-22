// The armed set: which behaviours are on and with what options. Config (variant defaults +
// profile `behaviors:`) is the base; runtime changes from actions (chat, LLM, hooks, the
// self-improver) are stored in agent.storage under `behaviors` and win over the config, so
// they survive restarts. behavior_reset drops the runtime changes again.
import type { BehaviorRegistry, Options } from './registry.ts'
import type { NormalizedEntry } from './config.ts'

export const STORAGE_KEY = 'behaviors'

/** A runtime change, as persisted. Options hold only what was set at runtime. */
export interface ArmedRecord {
  enabled: boolean
  options: Options
  /** Who changed it last: "player:Robin", "brain:llm", "brain:hooks"... */
  by: string
  at: number
}

export interface ArmedEntry {
  name: string
  /** Validated options with defaults. */
  options: Options
  source: 'config' | 'runtime'
  by: string
  since: number | null
}

export interface KeyValueStore {
  get<T> (key: string, fallback: T): T
  set (key: string, value: unknown): void
}

export type ChangeResult = { ok: true, message: string, options: Options } | { ok: false, message: string }

export class ArmedStore {
  private readonly registry: BehaviorRegistry
  private readonly storage: KeyValueStore
  private readonly config: Record<string, NormalizedEntry>
  private readonly now: () => number
  private readonly listeners: ((name: string | null, kind: 'arm' | 'disarm' | 'configure' | 'reset') => void)[] = []
  /** Bumped on every change, so caches know when to rebuild. */
  version = 0

  constructor (registry: BehaviorRegistry, storage: KeyValueStore, config: Record<string, NormalizedEntry> = {}, now: () => number = Date.now) {
    this.registry = registry
    this.storage = storage
    this.config = config
    this.now = now
  }

  onChange (fn: (name: string | null, kind: 'arm' | 'disarm' | 'configure' | 'reset') => void): void {
    this.listeners.push(fn)
  }

  private records (): Record<string, ArmedRecord> {
    return this.storage.get<Record<string, ArmedRecord>>(STORAGE_KEY, {})
  }

  private save (records: Record<string, ArmedRecord>, name: string | null, kind: 'arm' | 'disarm' | 'configure' | 'reset'): void {
    this.storage.set(STORAGE_KEY, records)
    this.version++
    for (const fn of this.listeners) fn(name, kind)
  }

  /** Raw (unvalidated) merged options: config, then runtime. */
  private rawOptions (name: string): Options {
    return { ...this.config[name]?.options, ...this.records()[name]?.options }
  }

  isArmed (name: string): boolean {
    const rec = this.records()[name]
    if (rec) return rec.enabled
    return this.config[name]?.enabled ?? false
  }

  /** Validated options (with defaults), armed or not. Falls back to defaults if stored options went stale. */
  options (name: string): Options {
    const v = this.registry.validate(name, this.rawOptions(name))
    if (v.ok) return v.options
    const d = this.registry.validate(name, {})
    return d.ok ? d.options : {}
  }

  /** Stored options that no longer validate (renamed option, tighter limits), or null. */
  problem (name: string): string | null {
    const v = this.registry.validate(name, this.rawOptions(name))
    return v.ok ? null : v.error
  }

  armed (): ArmedEntry[] {
    const recs = this.records()
    const names = new Set([...Object.keys(this.config), ...Object.keys(recs)])
    const out: ArmedEntry[] = []
    for (const name of names) {
      if (!this.registry.has(name) || !this.isArmed(name)) continue
      const rec = recs[name]
      out.push({
        name,
        options: this.options(name),
        source: rec ? 'runtime' : 'config',
        by: rec?.by ?? 'config',
        since: rec?.at ?? null
      })
    }
    // registry order, so status and selection ties are stable
    const order = this.registry.names()
    return out.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name))
  }

  /** Arms a behaviour; new options merge over the current ones. */
  arm (name: string, options: Options = {}, by = 'system'): ChangeResult {
    return this.change(name, options, by, true, 'arm')
  }

  configure (name: string, options: Options, by = 'system'): ChangeResult {
    return this.change(name, options, by, this.isArmed(name), 'configure')
  }

  disarm (name: string, by = 'system'): ChangeResult {
    if (!this.registry.has(name)) return { ok: false, message: this.registry.unknown(name) }
    if (!this.isArmed(name)) return { ok: false, message: `${name} is not armed` }
    const recs = { ...this.records() }
    recs[name] = { enabled: false, options: recs[name]?.options ?? {}, by, at: this.now() }
    this.save(recs, name, 'disarm')
    return { ok: true, message: `disarmed ${name}`, options: this.options(name) }
  }

  /** Drops runtime changes for one behaviour (or all), back to the profile/variant config. */
  reset (name?: string): ChangeResult {
    if (name && !this.registry.has(name)) return { ok: false, message: this.registry.unknown(name) }
    const recs = { ...this.records() }
    if (name) delete recs[name]
    else for (const k of Object.keys(recs)) delete recs[k]
    this.save(recs, name ?? null, 'reset')
    return { ok: true, message: name ? `${name} back to config (${this.isArmed(name) ? 'armed' : 'not armed'})` : 'all behaviours back to config', options: name ? this.options(name) : {} }
  }

  private change (name: string, options: Options, by: string, enabled: boolean, kind: 'arm' | 'configure'): ChangeResult {
    if (!this.registry.has(name)) return { ok: false, message: this.registry.unknown(name) }
    const recs = { ...this.records() }
    const runtimeOpts = { ...recs[name]?.options, ...options }
    const v = this.registry.validate(name, { ...this.config[name]?.options, ...runtimeOpts })
    if (!v.ok) return { ok: false, message: v.error }
    recs[name] = { enabled, options: runtimeOpts, by, at: this.now() }
    this.save(recs, name, kind)
    return { ok: true, message: `${kind === 'arm' ? 'armed' : enabled ? 'configured' : 'saved options for (not armed)'} ${name}`, options: v.options }
  }
}
