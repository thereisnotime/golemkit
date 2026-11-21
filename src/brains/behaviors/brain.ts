// The behaviours brain: keeps a set of armed behaviours (from the variant, the profile's
// `behaviors:` block and runtime behavior_arm calls) and runs them through the NPC
// controller. Armed behaviours act on their own between LLM turns and chat commands, at
// their own priority (idle 10, npc 20, behavior 35), and back off whenever a player, hook,
// reflex or (for npc-level ones) the LLM holds the body.
//
//   brains: [commandBrain(), reflexes(), behaviorsBrain({ defaults: { keep_fed: true } }), llmBrain()]
//
// See docs/guide/behaviors.md.
import { defineBrain, type Agent } from '../../core/index.ts'
import { NpcController, INTERRUPT_ACTION, type SelectOptions, type BlackboardOptions } from '../npc/index.ts'
import type { Caller } from '../../core/index.ts'
import { defineAction, noParams, ok } from '../../core/index.ts'
import { BehaviorRegistry } from './registry.ts'
import { BehaviorRuntime } from './runtime.ts'
import { mergeConfigs, validateBehaviorConfig, type BehaviorConfig } from './config.ts'
import { attachRuntime, behaviorActions, fmtOptions, runtimeFor } from './actions.ts'
import { defaultBehaviors } from './library/index.ts'

export interface BehaviorsBrainOptions extends SelectOptions, BlackboardOptions {
  /** Caller name for act() and logs. Default 'behaviors'. */
  name?: string
  /** Behaviour definitions. Default: the built-in library. */
  registry?: BehaviorRegistry
  /** Variant defaults; the profile's `behaviors:` (settings.behaviors) merges over them. */
  defaults?: BehaviorConfig
  /** Decision tick. Default 1000 ms. */
  tickMs?: number
  /** Back-off after another caller held the body, by caller kind (see NpcOptions). */
  backoffMs?: Partial<Record<Caller['kind'], number>>
  /** Set home to the spawn point when none is set. Default false: return_home etc. use an explicit home. */
  autoHome?: boolean
}

let shared: BehaviorRegistry | null = null
/** The built-in library as a registry (one shared instance; definitions are stateless). */
export function defaultBehaviorRegistry (): BehaviorRegistry {
  shared ??= new BehaviorRegistry(defaultBehaviors())
  return shared
}

const interrupt = defineAction({
  name: INTERRUPT_ACTION,
  description: 'Ends the NPC brain\'s current action (used when it switches behaviour).',
  params: noParams,
  internal: true,
  run: () => ok('')
})

export const behaviorsBrain = (opts: BehaviorsBrainOptions = {}) => {
  const name = opts.name ?? 'behaviors'
  const tickMs = opts.tickMs ?? 1000

  return defineBrain({
    name,
    start (agent: Agent) {
      const registry = opts.registry ?? defaultBehaviorRegistry()
      // both blocks are checked on their own first, so errors say where they come from
      validateBehaviorConfig(opts.defaults, registry, `variant ${agent.definition.name} behaviors`)
      validateBehaviorConfig(agent.settings.behaviors, registry, 'profile behaviors')
      const config = validateBehaviorConfig(mergeConfigs(opts.defaults, agent.settings.behaviors as BehaviorConfig | undefined), registry)
      const rt = new BehaviorRuntime(agent, registry, config, name)
      attachRuntime(agent, rt)
      for (const a of [...behaviorActions, interrupt]) if (!agent.getAction(a.name)) agent.registerAction(a)
      const armed = rt.armed()
      rt.log.info(armed.length ? `armed: ${armed.map(a => a.name).join(', ')}` : 'no behaviours armed', {
        armed: armed.map(a => { const o = fmtOptions(registry, a.name, a.options); return o ? `${a.name}(${o})` : a.name }).join(' ') || undefined
      })
    },
    session (agent, bot) {
      const rt = runtimeFor(agent)
      if (!rt) return
      const c = new NpcController(agent, bot, {
        ...opts,
        name,
        autoHome: opts.autoHome ?? false,
        behaviors: () => rt.behaviors(),
        hooks: () => rt.hooks()
      })
      rt.controller = c
      const tick = () => { c.tick().catch(e => rt.log.warn(`tick: ${(e as Error).message}`)) }
      const first = setTimeout(tick, 3000) // let chunks and entities load first
      const timer = setInterval(tick, tickMs)
      return () => {
        clearTimeout(first)
        clearInterval(timer)
        c.stop('session ended')
        if (rt.controller === c) rt.controller = null
      }
    },
    observe (agent) {
      const rt = runtimeFor(agent)
      if (!rt) return {}
      return { behaviors: { armed: rt.armed().map(a => a.name), running: rt.controller?.current ?? null } }
    },
    stop (agent) {
      runtimeFor(agent)?.controller?.stop('stopped')
    }
  })
}
