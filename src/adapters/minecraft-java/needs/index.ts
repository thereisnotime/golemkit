// The Minecraft Java needs provider for the NPC controller's needs layer
// (src/brains/npc/needs.ts): what safety, food, gear, supplies and rest mean in Minecraft, the
// gear search (iron ore with an open face, then upgrade_tools there, then home), the idle chores
// and the site checks. See docs/guide/needs-and-idle.md.
import type { Bot } from 'mineflayer'
import type { Agent } from '../../../core/index.ts'
import { needsSurvival } from '../../../core/index.ts'
import type { NeedsProvider, NeedDef, NpcContext } from '../../../brains/npc/index.ts'
import { runtimeFor } from '../../../brains/behaviors/actions.ts'
import { gearUrgency, suppliesUrgency, ironWanted, type GearState } from '../../../skills/needPlan.ts'
import { stairMineConfig, knownMine, knownLitMine, lastMineTrip } from '../../../skills/stairMine.ts'
import { mineTripDue, nightMineOk, turnedBackForLight, NIGHT_START_TORCHES } from '../../../skills/stairMinePlan.ts'
import { torchSupplyStep } from '../../../skills/lightPlan.ts'
import { torchCrafts } from '../../../skills/minePlan.ts'
import { inventoryCounts } from '../../../skills/toolkit.ts'
import { BUCKET_NEED } from '../behaviors/tools.ts'
import { heldTier } from '../../../skills/progression.ts'
import { seedCount } from '../../../skills/foodPlan.ts'
import { getFarms } from '../../../skills/food.ts'
import { chestView, chestTotals, memoryOptions } from '../../../skills/containers.ts'
import { woodStock } from '../behaviors/work.ts'
import { chestSeedCount } from '../behaviors/keepFed.ts'
import { tripRun } from '../behaviors/trip.ts'
import { minecraftChores } from './chores.ts'
import { projectChores } from './projects.ts'
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
export function gearTarget (agent: Agent): Pick<GearState, 'upTo' | 'armour' | 'bucket' | 'shield'> {
  try {
    const rt = runtimeFor(agent)
    if (rt?.store.isArmed('keep_tools_upgraded')) {
      const o = rt.store.options('keep_tools_upgraded') as { upTo?: GearState['upTo'], armour?: boolean, bucket?: boolean, shield?: boolean }
      return { upTo: o.upTo ?? 'iron', armour: !!o.armour, bucket: o.bucket !== false, shield: o.shield !== false }
    }
  } catch {}
  return { upTo: 'iron', armour: false, bucket: false, shield: false }
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
  // night trips: a lit known mine, or none yet and torches for a first one (mine.startAtNight)
  const mineAtNight = (b: Bot): boolean => {
    const s = stairMineConfig(agent)
    const known = knownMine(agent, b)
    const inv = inventoryCounts(b)
    // torches carried, or the ones dig_mine makes before going down (coal or charcoal from logs)
    const step = torchSupplyStep(inv, NIGHT_START_TORCHES, { furnaceNear: true, tableNear: true })
    const torches = step.do === 'ready' ? step.torches : step.do === 'stuck' ? (inv.torch ?? 0) : Math.max(NIGHT_START_TORCHES, (inv.torch ?? 0) + 4 * torchCrafts(inv))
    return nightMineOk({ known: !!known, lit: !!knownLitMine(agent, b), torches, startAtNight: s.startAtNight })
  }
  const gear = cached(10_000, (ctx) => {
    const b = bot(ctx)
    if (!b.entity || !needsSurvival(b)) return { urgency: 0, missing: [] as string[] }
    return gearUrgency({ held: heldItems(b), ...gearTarget(agent), bucketNeeded: ctx.bb.need(BUCKET_NEED) > 0 })
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

  let mineLeg = false
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
        what: 'iron ore with an open face, else its staircase mine',
        requires: ['find_target', 'upgrade_tools'],
        // only when iron is what is missing and it could mine it (a stone pickaxe, digging allowed)
        ready: (ctx) => {
          const b = bot(ctx)
          const t = gearTarget(agent)
          if (!agent.canDig || t.upTo === 'stone') return false
          const tier = heldTier(heldItems(b), 'pickaxe')
          if (tier === 'none' || tier === 'wooden') return false
          return gear(ctx).missing.some(m => /iron|bucket|shield/.test(m))
        },
        // at night only down a lit mine near home (the walk to it is short), or a first mine it lights as it digs
        night: (ctx) => {
          const s = stairMineConfig(agent)
          if (!s.enabled || !s.atNight || !agent.getAction('dig_mine') || !mineTripDue(lastMineTrip(agent), ctx.now, s)) return false
          return mineAtNight(bot(ctx))
        },
        // down the mine and smelting after it: chopping wood or tending the farm doesn't pull it out
        committed: () => mineLeg,
        async run (ctx, o) {
          const t = gearTarget(agent)
          const b = bot(ctx)
          const s = stairMineConfig(agent)
          const upgrade = () => ctx.act('upgrade_tools', { up_to: t.upTo, armour: t.armour, bucket: !!t.bucket || ctx.bb.need(BUCKET_NEED) > 0, shield: !!t.shield, safe: true })
          const home = async () => { if (ctx.agent.getAction('go_home')) await ctx.act('go_home', { range: 4 }) }
          const night = ctx.bb.facts.isNight
          const mineOk = s.enabled && !!agent.getAction('dig_mine') && mineTripDue(lastMineTrip(agent), ctx.now, s)
          const mine = knownMine(agent, b)
          const parts: string[] = []
          // 1. ore with an open face within the search radius, by day; skipped once its mine is down at depth
          if (!night && !(mineOk && mine?.bottom)) {
            const r = await tripRun(ctx, { purpose: 'a search for iron ore', kind: 'ore', distance: o.radius }, async () => {
              const f = await ctx.act('find_target', { target: 'iron', radius: o.radius, max_minutes: o.minutes, go: true, exposed: true, at_night: o.atNight })
              if (!f.ok) return f
              // upgrade_tools mines what it sees (safe mining: not deeper than mining.safeDepth unless ready)
              const u = await upgrade()
              return { ok: u.ok, message: `${f.message}; ${u.message}` }
            })
            // not fit for a trip yet (health, food): no mine either, and it doesn't count as a search
            if (!r.ok && /^not ready for a trip/.test(r.message)) return { ok: false, message: r.message, data: { retry: true } }
            // turned back at sunset: the mine near home doesn't need daylight, so on to it when night mining may go
            const back = (r.data as { turnedBack?: unknown } | undefined)?.turnedBack
            if (r.ok || !mineOk || (back && !(turnedBackForLight(back) && s.atNight && mineAtNight(b)))) { await home(); return r }
            parts.push(r.message)
          }
          if (!mineOk) { await home(); return { ok: false, message: parts.join('; ') || 'no mine trip due' } }
          // 2. its staircase mine near home: food from the pantry and a weapon first, then down for the iron the chain still needs
          mineLeg = true
          try {
            await home()
            if (agent.getAction('prepare_trip')) {
              const p = await ctx.act('prepare_trip', { purpose: 'a trip down the mine', kind: 'ore', waive: [] })
              if (!p.ok) return { ok: false, message: [...parts, p.message].join('; '), data: { retry: true } }
            }
            // wood for the mine first: a spare pickaxe, sticks for torches, a crafting table (the first
            // live trip came up early with its only stone pickaxe worn out and no sticks to make another)
            if (woodStock(b) < 3 && agent.getAction('chop_tree')) await ctx.act('chop_tree', { radius: 32, avoid_spawn: 48 })
            const want = Math.min(32, Math.max(3, ironWanted({ held: heldItems(b), ...t, bucketNeeded: ctx.bb.need(BUCKET_NEED) > 0 })))
            const m = await ctx.act('dig_mine', { ore: 'iron', count: want })
            parts.push(m.message)
            // 3. smelt and craft at home
            await home()
            const u = await upgrade()
            parts.push(u.message)
            return { ok: m.ok || u.ok, message: parts.join('; ') }
          } finally { mineLeg = false }
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
    chores: [...minecraftChores(agent), ...projectChores(agent)],
    sites: minecraftSites(agent),
    siteFromFailure,
    // Minecraft: timeOfDay 0 is 06:00
    clock: (ctx) => {
      const t = ctx.agent.adapter?.time?.()
      return t ? ((t.timeOfDay / 1000) + 6) % 24 : null
    }
  }
}
