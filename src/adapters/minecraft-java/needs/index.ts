// The Minecraft Java needs provider for the NPC controller's needs layer
// (src/brains/npc/needs.ts): what safety, food, gear, supplies and rest mean in Minecraft, the
// gear search (iron ore with an open face, then upgrade_tools there, then home), the idle chores
// and the site checks. See docs/guide/needs-and-idle.md.
import type { Bot } from 'mineflayer'
import type { Agent } from '../../../core/index.ts'
import { needsSurvival } from '../../../core/index.ts'
import type { NeedsProvider, NeedDef, NpcContext } from '../../../brains/npc/index.ts'
import { runtimeFor } from '../../../brains/behaviors/actions.ts'
import { gearUrgency, suppliesUrgency, type GearState } from '../../../skills/needPlan.ts'
import { heldTier } from '../../../skills/progression.ts'
import { seedCount } from '../../../skills/foodPlan.ts'
import { getFarms } from '../../../skills/food.ts'
import { chestView, chestTotals, memoryOptions } from '../../../skills/containers.ts'
import { woodStock } from '../behaviors/work.ts'
import { chestSeedCount } from '../behaviors/keepFed.ts'
import { tripRun } from '../behaviors/trip.ts'
import { minecraftChores } from './chores.ts'
import { minecraftSites, siteFromFailure } from './sites.ts'

/** Items carried, worn and in the offhand, by name. */
export function heldItems (bot: Bot): Record<string, number> {
  const out: Record<string, number> = {}
  for (const i of bot.inventory?.items?.() ?? []) out[i.name] = (out[i.name] ?? 0) + i.count
  for (const slot of [5, 6, 7, 8, 45]) {
    const it = bot.inventory?.slots?.[slot]
    if (it) out[it.name] = (out[it.name] ?? 0) + it.count
  }
  return out
}

/** What "geared up" means for this bot: keep_tools_upgraded's options when it is armed, else iron tools without armour. */
export function gearTarget (agent: Agent): Pick<GearState, 'upTo' | 'armour'> {
  try {
    const rt = runtimeFor(agent)
    if (rt?.store.isArmed('keep_tools_upgraded')) {
      const o = rt.store.options('keep_tools_upgraded') as { upTo?: GearState['upTo'], armour?: boolean }
      return { upTo: o.upTo ?? 'iron', armour: !!o.armour }
    }
  } catch {}
  return { upTo: 'iron', armour: false }
}

/** Caches a costly reading for a few seconds. */
function cached<T> (ms: number, read: (ctx: NpcContext) => T): (ctx: NpcContext) => T {
  let at = -Infinity
  let v: T
  return (ctx) => {
    if (ctx.now - at >= ms || ctx.now < at) { v = read(ctx); at = ctx.now }
    return v
  }
}

const bot = (ctx: NpcContext) => ctx.bot as Bot

export function minecraftNeeds (agent: Agent): NeedsProvider {
  const gear = cached(10_000, (ctx) => {
    const b = bot(ctx)
    if (!b.entity || !needsSurvival(b)) return { urgency: 0, missing: [] as string[] }
    return gearUrgency({ held: heldItems(b), ...gearTarget(agent) })
  })
  const supplies = cached(15_000, (ctx) => {
    const b = bot(ctx)
    if (!b.entity || !needsSurvival(b)) return { urgency: 0, short: [] as string[] }
    const inv = heldItems(b)
    let storedFood: number | null = null
    try {
      const t = chestTotals(chestView(agent, b))
      const foods = (b.registry as { foodsByName?: Record<string, unknown> })?.foodsByName ?? {}
      const seen = Object.entries(t.has).filter(([k]) => k in foods).reduce((n, [, v]) => n + v, 0)
      storedFood = seen || !t.unknown ? seen : null
    } catch {}
    const keep = (() => { try { return Number((runtimeFor(agent)?.store.options('chop_wood_loop') as { keep?: number } | undefined)?.keep) || 16 } catch { return 16 } })()
    return suppliesUrgency({
      wood: woodStock(b),
      woodKeep: keep,
      storedFood,
      lowFood: memoryOptions(agent).lowFood,
      seeds: seedCount(inv) + chestSeedCount(agent, b),
      hasFarm: getFarms(agent).length > 0
    })
  })

  const needs: NeedDef[] = [
    {
      name: 'safety',
      goal: 'stay safe',
      servedBy: ['stay_safe', 'avoid_mobs', 'bodyguard', 'guard_owner'],
      urgency: (ctx) => {
        const health = typeof bot(ctx).health === 'number' ? bot(ctx).health : 20
        return Math.max(ctx.bb.needs.danger, health <= 8 ? 1 - health / 20 : 0)
      }
    },
    {
      name: 'food',
      goal: 'stay fed',
      servedBy: ['keep_fed', 'farm_setup', 'farm_loop'],
      urgency: (ctx) => needsSurvival(bot(ctx)) ? ctx.bb.needs.hunger : 0
    },
    {
      name: 'gear',
      goal: 'iron tools and armour',
      servedBy: ['keep_tools_upgraded'],
      urgency: (ctx) => gear(ctx).urgency,
      search: {
        what: 'iron ore with an open face',
        requires: ['find_target', 'upgrade_tools'],
        // only when iron is what is missing and it could mine it (a stone pickaxe, digging allowed)
        ready: (ctx) => {
          const b = bot(ctx)
          const t = gearTarget(agent)
          if (!agent.canDig || t.upTo === 'stone') return false
          const tier = heldTier(heldItems(b), 'pickaxe')
          if (tier === 'none' || tier === 'wooden') return false
          return gear(ctx).missing.some(m => /iron/.test(m))
        },
        async run (ctx, o) {
          const t = gearTarget(agent)
          const r = await tripRun(ctx, { purpose: 'a search for iron ore', kind: 'ore', distance: o.radius }, async () => {
            const f = await ctx.act('find_target', { target: 'iron', radius: o.radius, max_minutes: o.minutes, go: true, exposed: true, at_night: o.atNight })
            if (!f.ok) return f
            // upgrade_tools mines what it sees (safe mining: not deeper than mining.safeDepth unless ready)
            const u = await ctx.act('upgrade_tools', { up_to: t.upTo, armour: t.armour, safe: true })
            return { ok: u.ok, message: `${f.message}; ${u.message}` }
          })
          if (ctx.agent.getAction('go_home')) await ctx.act('go_home', { range: 4 })
          return r
        }
      }
    },
    {
      name: 'supplies',
      goal: 'keep the base supplied',
      servedBy: ['chop_wood_loop', 'deposit_when_full', 'check_storage', 'farm_setup'],
      urgency: (ctx) => supplies(ctx).urgency
    },
    {
      name: 'rest',
      goal: 'rest at home',
      servedBy: ['sleep_at_night', 'keep_spawn_bed', 'return_home'],
      urgency: (ctx) => {
        if (ctx.bb.facts.sleeping) return 0
        if (!ctx.bb.facts.isNight) return ctx.bb.needs.tiredness * 0.5
        return (ctx.bb.facts.homeDistance ?? 0) > 8 ? 0.8 : 0.5
      }
    }
  ]

  return {
    needs,
    chores: minecraftChores(agent),
    sites: minecraftSites(agent),
    siteFromFailure,
    // Minecraft: timeOfDay 0 is 06:00
    clock: (ctx) => {
      const t = ctx.agent.adapter?.time?.()
      return t ? ((t.timeOfDay / 1000) + 6) % 24 : null
    }
  }
}
