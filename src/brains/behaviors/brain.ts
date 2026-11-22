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
import { defaultBehaviors } from '../../adapters/minecraft-java/behaviors/index.ts'

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

/**
 * NPC mode: while the LLM brain can't think (provider quota or its own budget used up), arm extra
 * behaviours so the bot keeps playing on its own, and disarm exactly those when the LLM is back.
 * settings.npcMode: false to turn it off, or { arm: { behaviour: options, ... } } to choose them.
 * Default: chop_wood_loop and deposit_when_full (stay_safe covers going home at night).
 * What it armed is remembered in storage, so a restart in between still cleans up.
 */
// stay_safe already takes the bot home at night; return_home/sleep_at_night here only fought it
// over the same go_home trip ("path was stopped") and the bot never got home.
const NPC_MODE_DEFAULT: Record<string, Record<string, unknown>> = {
  chop_wood_loop: {},
  deposit_when_full: {}
}
const NPC_KEY = 'npcMode.armed'

function wireNpcMode (agent: Agent, rt: BehaviorRuntime): void {
  const cfg = (agent.settings as { npcMode?: false | { arm?: Record<string, Record<string, unknown>> } }).npcMode
  if (cfg === false) return
  const wanted = (cfg && cfg.arm) ?? NPC_MODE_DEFAULT
  const on = (reason: string) => {
    if (agent.storage.get<string[] | undefined>(NPC_KEY)) return // already in NPC mode
    const armedNow: string[] = []
    for (const [name, options] of Object.entries(wanted)) {
      if (!rt.registry.get(name) || rt.store.isArmed(name)) continue
      const r = rt.store.arm(name, options, 'npc-mode')
      if (r.ok) armedNow.push(name)
    }
    agent.storage.set(NPC_KEY, armedNow)
    rt.log.info(`NPC mode on (${reason}): armed ${armedNow.join(', ') || 'nothing new'}`)
  }
  const off = () => {
    const armedBy = agent.storage.get<string[] | undefined>(NPC_KEY)
    if (!armedBy) return
    for (const name of armedBy) rt.store.disarm(name, 'npc-mode')
    agent.storage.delete(NPC_KEY)
    rt.log.info(`NPC mode off, LLM is back: disarmed ${armedBy.join(', ') || 'nothing'}`)
  }
  // Still in NPC mode from before a restart: drop anything we armed that isn't in the set any more.
  const prev = agent.storage.get<string[] | undefined>(NPC_KEY)
  if (prev) {
    const keep = prev.filter(n => n in wanted)
    for (const n of prev.filter(n => !(n in wanted))) rt.store.disarm(n, 'npc-mode')
    if (keep.length !== prev.length) agent.storage.set(NPC_KEY, keep)
  }
  ;(agent.on as (ev: string, fn: (...a: unknown[]) => void) => void)('llmPaused', (reason: unknown) => on(String(reason ?? 'LLM paused')))
  ;(agent.on as (ev: string, fn: (...a: unknown[]) => void) => void)('llmResumed', () => off())
}

export const behaviorsBrain = (opts: BehaviorsBrainOptions = {}) => {
  const name = opts.name ?? 'behaviors'
  const tickMs = opts.tickMs ?? 1000

  return defineBrain({
    name,
    start (agent: Agent) {
      const library = opts.registry ?? defaultBehaviorRegistry()
      // both blocks are checked on their own first, so errors say where they come from
      validateBehaviorConfig(opts.defaults, library, `variant ${agent.definition.name} behaviors`)
      validateBehaviorConfig(agent.settings.behaviors, library, 'profile behaviors')
      const merged = validateBehaviorConfig(mergeConfigs(opts.defaults, agent.settings.behaviors as BehaviorConfig | undefined), library)
      // behaviours the game can't do (capabilities) are left out, config entries for them too
      const caps = (agent as Partial<Agent>).adapter?.capabilities
      const registry = caps ? library.forCapabilities(caps) : library
      const config = registry === library ? merged : Object.fromEntries(Object.entries(merged).filter(([n]) => registry.has(n)))
      if (registry !== library) agent.log.child(name).info(`left out (the game lacks what they need): ${library.names().filter(n => !registry.has(n)).join(', ')}`)
      const rt = new BehaviorRuntime(agent, registry, config, name)
      attachRuntime(agent, rt)
      for (const a of [...behaviorActions, interrupt]) if (!agent.getAction(a.name)) agent.registerAction(a)
      wireNpcMode(agent, rt)
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
