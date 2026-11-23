// Per-agent behaviour runtime: the registry, the armed store and the NPC controller of the
// current session. Turns the armed set into NPC-brain Behaviors (rebuilt when the set changes)
// and skips, with one warning, behaviours the bot can't run (missing actions, no digging...).
import type { Agent, Logger } from '../../core/index.ts'
import type { Behavior, NpcController, NpcHook } from '../npc/index.ts'
import { LEVELS, type BehaviorDefinition, type BehaviorLevel } from './types.ts'
import type { BehaviorRegistry, Options } from './registry.ts'
import { ArmedStore, type ArmedEntry } from './armed.ts'
import type { NormalizedEntry } from './config.ts'

/** Whether the bot may place blocks: settings.canPlace (default true). */
export function canPlace (agent: Pick<Agent, 'settings'>): boolean {
  return agent.settings?.canPlace !== false
}

/** Why this bot can't run a behaviour, or null if it can. */
export function missingCapability (def: BehaviorDefinition<any>, agent: Pick<Agent, 'getAction' | 'canDig' | 'settings'>): string | null {
  const missing = (def.requires ?? []).filter(a => !agent.getAction(a))
  if (missing.length) return `needs the ${missing.join(', ')} action${missing.length > 1 ? 's' : ''}, which this bot doesn't have`
  if (def.needs?.dig && !agent.canDig) return 'needs digging, which is disabled for this bot (canDig)'
  if (def.needs?.place && !canPlace(agent)) return 'needs block placing, which is disabled for this bot (settings.canPlace)'
  return null
}

export interface BuiltSet {
  version: number
  behaviors: Behavior[]
  hooks: NpcHook[]
  skipped: Record<string, string>
}

export class BehaviorRuntime {
  readonly agent: Agent
  readonly registry: BehaviorRegistry
  readonly store: ArmedStore
  readonly log: Logger
  /** Caller name used for act() ("behaviors"). */
  readonly name: string
  controller: NpcController | null = null
  private built: BuiltSet | null = null
  private warned = new Set<string>()

  constructor (agent: Agent, registry: BehaviorRegistry, config: Record<string, NormalizedEntry>, name = 'behaviors') {
    this.agent = agent
    this.registry = registry
    this.name = name
    this.log = agent.log.child(name)
    this.store = new ArmedStore(registry, agent.storage, config)
    this.store.onChange((changed, kind) => {
      // a disarmed or retuned behaviour stops now instead of finishing its current run
      if (changed && (kind === 'disarm' || kind === 'configure' || kind === 'reset')) this.controller?.cancel(changed, kind)
      if (!changed) this.controller?.cancel(undefined, kind)
    })
  }

  priorityOf (def: BehaviorDefinition<any>, options: Options): number {
    const level = (options.priority as BehaviorLevel | undefined) ?? def.priority ?? 'npc'
    return LEVELS[level]
  }

  /** The armed set as Behaviors and hooks, cached until the armed set changes. */
  build (): BuiltSet {
    if (this.built && this.built.version === this.store.version) return this.built
    const behaviors: Behavior[] = []
    const hooks: NpcHook[] = []
    const skipped: Record<string, string> = {}
    for (const entry of this.store.armed()) {
      const def = this.registry.get(entry.name)!
      const why = missingCapability(def, this.agent)
      if (why) {
        skipped[entry.name] = why
        if (!this.warned.has(entry.name)) {
          this.warned.add(entry.name)
          this.log.warn(`${entry.name} is armed but can't run: ${why}`, { behavior: entry.name })
        }
        continue
      }
      const problem = this.store.problem(entry.name)
      if (problem) this.log.warn(`${entry.name}: stored options are invalid, using defaults (${problem})`, { behavior: entry.name })
      try {
        const env = { agent: this.agent }
        if (def.create) {
          const body = def.create(entry.options, env)
          const help = body.help ?? def.help
          const goal = body.goal ?? def.goal
          behaviors.push({
            ...body, name: def.name, priority: this.priorityOf(def, entry.options), requires: [...(def.requires ?? []), ...(body.requires ?? [])],
            ...(goal ? { goal } : {}), ...(help ? { help } : {})
          })
        }
        if (def.hook) hooks.push(def.hook(entry.options, env))
      } catch (e) {
        skipped[entry.name] = `failed to start: ${(e as Error).message}`
        this.log.warn(`${entry.name} failed to start: ${(e as Error).message}`, { behavior: entry.name })
      }
    }
    this.built = { version: this.store.version, behaviors, hooks, skipped }
    return this.built
  }

  behaviors (): Behavior[] {
    return this.build().behaviors
  }

  hooks (): NpcHook[] {
    return this.build().hooks
  }

  armed (): ArmedEntry[] {
    return this.store.armed()
  }

  /** Compact status: armed set, what runs, last outcomes, cooldowns, back-off. */
  status (): Record<string, unknown> {
    const built = this.build()
    const c = this.controller
    const cs = c?.status()
    return {
      armed: this.armed().map(e => {
        const st = c?.statsFor(e.name)
        return {
          name: e.name,
          options: e.options,
          by: e.by,
          priority: this.priorityOf(this.registry.get(e.name)!, e.options),
          ...(built.skipped[e.name] ? { skipped: built.skipped[e.name] } : {}),
          ...(st ? { runs: st.runs, cooldown: st.cooldown, last: st.last } : {})
        }
      }),
      running: cs?.behavior ?? null,
      runningFor: cs?.runningFor ?? 0,
      paused: cs?.paused ?? null,
      ...(cs?.askedForHelp ? { askedForHelp: cs.askedForHelp } : {}),
      connected: !!c
    }
  }
}
