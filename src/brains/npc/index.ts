// NPC brain: a utility-AI loop that keeps a bot busy on its own. Bots configure it with
// behaviours (score + run); the highest score wins, with hysteresis so it doesn't flap.
// It acts at PRIORITY.npc and backs off whenever a player, LLM or reflex has the body.
// See docs/guide/npc-brain.md.
import { defineBrain, defineAction, noParams, ok, fail, type Agent } from '../../core/index.ts'
import { NpcController, INTERRUPT_ACTION, type NpcOptions } from './controller.ts'
import { helpDesk } from './help.ts'

export { NpcController, INTERRUPT_ACTION, type NpcOptions, type BehaviorStats, type NpcSnapshot } from './controller.ts'
export { NeedsLayer, planNeeds, searchDue, IDLE_BAND, SEARCH_SCORE, CHORE_SCORES, type NeedsProvider, type NeedDef, type NeedSearch, type ChoreDef, type SiteProbe, type NeedInput, type NeedsPlan, type LayerView } from './needs.ts'
export { pickChore, inHours, windowOk, MODE_RANK, type ChoreSpec, type ChoreWhen } from './idle.ts'
export { Blackboard, type Needs, type Facts, type BlackboardOptions } from './blackboard.ts'
export { decide, best, failureCooldown, flipCooldown, isFlip, type Decision, type Scored, type SelectOptions } from './select.ts'
export { HelpDesk, helpDesk, helpMessage, normalizeReason, resolveHelpOptions, HELP_DEFAULTS, type HelpOptions, type HelpAsk, type HelpText, type Failure, type HelpSource, type HelpAgent } from './help.ts'
export { NpcYield, type Behavior, type BehaviorContext, type NpcContext, type NpcHook } from './types.ts'
export * from './behaviors/index.ts'

export const npcBrain = (opts: NpcOptions) => {
  const name = opts.name ?? 'npc'
  const tickMs = opts.tickMs ?? 1500
  let controller: NpcController | null = null

  const status = defineAction({
    name: 'npc_status',
    description: 'Report what the NPC brain is doing: current behaviour, top scores, needs, back-off.',
    params: noParams,
    exclusive: false,
    run () {
      if (!controller) return fail('NPC brain not running')
      return ok(controller.summary(), controller.status())
    }
  })

  const interrupt = defineAction({
    name: INTERRUPT_ACTION,
    description: 'Ends the NPC brain\'s current action (used when it switches behaviour).',
    params: noParams,
    internal: true,
    run: () => ok('')
  })

  return defineBrain({
    name,
    start (agent: Agent) {
      for (const a of [status, interrupt]) if (!agent.getAction(a.name)) agent.registerAction(a)
    },
    session (agent, bot) {
      const c = new NpcController(agent, bot, opts)
      controller = c
      const unlist = agent.status?.addSource(c.name, () => c.snapshot())
      const tick = () => { c.tick().catch(e => agent.log.warn(`npc tick: ${(e as Error).message}`)) }
      // Give the world a moment to load chunks and entities before the first decision.
      const first = setTimeout(tick, 3000)
      const timer = setInterval(tick, tickMs)
      return () => {
        clearTimeout(first)
        clearInterval(timer)
        c.stop('session ended')
        unlist?.()
        if (controller === c) controller = null
      }
    },
    observe (agent) {
      const asked = helpDesk(agent).observeView(Date.now())
      return asked.length ? { askedForHelp: asked } : {}
    },
    stop () {
      controller?.stop('stopped')
    }
  })
}
