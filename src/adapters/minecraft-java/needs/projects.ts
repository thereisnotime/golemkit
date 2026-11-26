// The base_project idle chore (active mode): when nothing else scores, work one session on the
// base projects (src/skills/projects.ts), or propose the next big one to the owners. It only
// runs when the safe needs are met (health and food at settings.projects.minHealth/minFood, no
// hostiles close), by day or, at night, on projects inside finished and lit walls, and never
// while an LLM goal about building is being worked on. See docs/guide/base-projects.md.
import type { Bot } from 'mineflayer'
import type { Agent } from '../../../core/index.ts'
import { needsSurvival } from '../../../core/index.ts'
import type { ChoreDef, NpcContext } from '../../../brains/npc/index.ts'
import { planBase, settingsOf } from '../../../skills/projects.ts'
import { safeToWork } from '../../../skills/basePlan.ts'

const bot = (ctx: NpcContext) => ctx.bot as Bot

/** Why the chore wouldn't run now, or null when it would. */
export function projectBlocker (agent: Agent, ctx: NpcContext): string | null {
  const s = settingsOf(agent)
  if (!s.enabled) return 'off'
  if (s.policy === 'off') return 'policy off'
  const b = bot(ctx)
  if (!b?.entity) return 'not in the game'
  const unsafe = safeToWork({ health: b.health ?? 20, food: b.food ?? 20, danger: ctx.bb.needs.danger, survival: needsSurvival(b) }, s)
  if (unsafe) return unsafe
  return null
}

export function projectChores (agent: Agent): ChoreDef[] {
  let cache: { at: number, ok: boolean } = { at: -Infinity, ok: false }
  return [{
    name: 'base_project',
    mode: 'active',
    when: 'any',
    cooldownMinutes: 1,
    description: 'one work session on the base projects (fortress walls, stone floor, lighting, storage, workshop, walkway, towers), or propose the next big one to the owners',
    requires: ['work_on_base'],
    applicable: (ctx) => {
      if (projectBlocker(agent, ctx)) return false
      if (ctx.now - cache.at < 20_000 && ctx.now >= cache.at) return cache.ok
      let ok = false
      try {
        const p = planBase(agent, bot(ctx))
        ok = typeof p !== 'string' && p.step.kind !== 'none'
      } catch { ok = false }
      cache = { at: ctx.now, ok }
      return ok
    },
    async run (ctx) {
      cache = { at: -Infinity, ok: false }
      return ctx.act('work_on_base', {})
    }
  }]
}
