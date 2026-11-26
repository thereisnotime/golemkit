// Idle chores for the Minecraft Java adapter: what the bot does in each idle mode when no
// behaviour scores (src/brains/npc/idle.ts picks one). They wrap existing actions and stay near
// home (idle.radius); explore trips are budgeted like any trip and come home.
import type { Bot } from 'mineflayer'
import type { Agent } from '../../../core/index.ts'
import type { ChoreDef, NpcContext, BehaviorContext } from '../../../brains/npc/index.ts'
import type { BehaviorBody as Body } from '../../../brains/behaviors/types.ts'
import { getHome, getPlaces } from '../../../skills/navigation.ts'
import { getFarms, nearestFarm, farmWorkFor } from '../../../skills/food.ts'
import { seedCount } from '../../../skills/foodPlan.ts'
import { farmWorkCount } from '../../../skills/farmPlan.ts'
import { spareCraft, choreIdle, type ChoreState } from '../../../skills/needPlan.ts'
import { woodStock, depositWhenFull } from '../behaviors/work.ts'
import { chestSeedCount } from '../behaviors/keepFed.ts'
import { tripRun } from '../behaviors/trip.ts'
import { heldItems } from './index.ts'

const bot = (ctx: NpcContext) => ctx.bot as Bot
const day = (ctx: NpcContext) => !ctx.bb.facts.isNight
const homeDist = (ctx: NpcContext) => ctx.bb.facts.homeDistance
/** Home is known, in this dimension, and the bot is within `r` of it. */
const nearHome = (ctx: NpcContext, r: number) => { const d = homeDist(ctx); return d !== null && d <= r }

/** What scout_nearby and explore look for, in order: the first not remembered yet. */
const SCOUT = ['iron', 'coal']
const EXPLORE = ['iron', 'coal', 'village', 'diamond']

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(n)))

/** A run that had nothing to do: the chore waits its quietMinutes, not just its cooldown. */
const nothing = (message: string) => ({ ok: true, message, data: { nothingDone: true } })

async function backHome (ctx: BehaviorContext, range = 4): Promise<void> {
  // the blackboard is a tick old; go_home is quick when it is already there
  if (ctx.agent.getAction('go_home') && (homeDist(ctx) ?? Infinity) > range) await ctx.act('go_home', { range })
}

export function minecraftChores (agent: Agent): ChoreDef[] {
  // deposit_when_full's body with a lower threshold: tidies before the inventory is full
  let tidy: Body | null = null
  const tidyBody = (): Body => {
    tidy ??= depositWhenFull.create!(depositWhenFull.options.parse({ threshold: 0.5 }), { agent })
    return tidy
  }
  let exploreAt = 0
  const nextTarget = (list: string[]) => list.find(t => !getPlaces(agent)[`found:${t}`]) ?? null

  /** The chore's view of the world, read lazily (choreIdle only looks at what the chore needs). */
  const stateFor = (ctx: NpcContext, o: { radius: number }): ChoreState => {
    const b = bot(ctx)
    let inv: Record<string, number> | null = null
    const held = () => (inv ??= heldItems(b))
    return {
      get homeDistance () { return homeDist(ctx) },
      radius: o.radius,
      canDig: !!agent.canDig,
      canPlace: agent.settings.canPlace !== false,
      get sleeping () { return !!ctx.bb.facts.sleeping },
      get wood () { return woodStock(b) },
      get seeds () { return seedCount(held()) + chestSeedCount(agent, b) },
      get farm () {
        const f = nearestFarm(agent, b)
        if (!f) return null
        const home = getHome(agent)
        const fromHome = home ? Math.hypot(home.x - f.x, home.z - f.z) : 0
        if (fromHome > o.radius * 2) return { fromHome, work: 0 }
        const w = farmWorkFor(agent, b, f, { targetSize: 9, seedReserve: 4 })
        return { fromHome, work: w ? farmWorkCount(w) : 0 }
      },
      startFarm: !!agent.getAction('start_farm'),
      get spare () { return !!spareCraft(held()) },
      get lightFuel () { const i = held(); return (i.torch ?? 0) + (i.coal ?? 0) + (i.charcoal ?? 0) > 0 },
      get scoutTarget () { return nextTarget(SCOUT) },
      get tidy () { return tidyBody().score(ctx) > 0 }
    }
  }
  const wants = (name: string, ctx: NpcContext, o: { radius: number }) => choreIdle(name, stateFor(ctx, o)) === null

  return [
    {
      name: 'look_around',
      mode: 'passive',
      when: 'any',
      cooldownMinutes: 0.3,
      description: 'glance around, at players close by now and then',
      requires: ['look_around'],
      applicable: (ctx, o) => wants('look_around', ctx, o),
      whyIdle: (ctx, o) => choreIdle('look_around', stateFor(ctx, o)),
      run: (ctx) => ctx.act('look_around', { radius: 10 })
    },
    {
      name: 'go_home',
      mode: 'idle',
      when: 'any',
      cooldownMinutes: 1,
      description: 'walk back home when it is further than idle.radius',
      requires: ['go_home'],
      applicable: (ctx, o) => wants('go_home', ctx, o),
      whyIdle: (ctx, o) => choreIdle('go_home', stateFor(ctx, o)),
      run: (ctx) => ctx.act('go_home', { range: 3 })
    },
    {
      name: 'stroll',
      mode: 'idle',
      when: 'day',
      cooldownMinutes: 2,
      description: 'a short walk near home',
      requires: ['wander'],
      applicable: (ctx, o) => wants('stroll', ctx, o),
      whyIdle: (ctx, o) => choreIdle('stroll', stateFor(ctx, o)),
      run: (ctx, o) => ctx.act('wander', { radius: clamp(Math.min(8, o.radius), 1, 64) })
    },
    {
      name: 'rest_by_bed',
      mode: 'idle',
      when: 'night',
      cooldownMinutes: 1,
      description: 'at night, go home and wait by the bed',
      requires: ['go_home'],
      applicable: (ctx, o) => wants('rest_by_bed', ctx, o),
      whyIdle: (ctx, o) => choreIdle('rest_by_bed', stateFor(ctx, o)),
      async run (ctx) {
        if ((homeDist(ctx) ?? 0) > 3) await ctx.act('go_home', { range: 2 })
        await ctx.wait(20_000)
        return 'waited by the bed'
      }
    },
    {
      name: 'tidy_storage',
      mode: 'active',
      when: 'day',
      cooldownMinutes: 10,
      description: 'store what it does not need in its chests near home once the inventory is half full',
      requires: ['deposit'],
      applicable: (ctx, o) => wants('tidy_storage', ctx, o),
      whyIdle: (ctx, o) => choreIdle('tidy_storage', stateFor(ctx, o)),
      async run (ctx) {
        const r = await tidyBody().run(ctx)
        return r && typeof r === 'object' && r.ok && /nothing/.test(r.message) ? nothing(r.message) : r
      }
    },
    {
      name: 'top_up_wood',
      mode: 'active',
      when: 'day',
      cooldownMinutes: 10,
      description: 'fell a tree near home while it has fewer than 16 logs',
      requires: ['chop_tree'],
      applicable: (ctx, o) => wants('top_up_wood', ctx, o),
      whyIdle: (ctx, o) => choreIdle('top_up_wood', stateFor(ctx, o)),
      async run (ctx, o) {
        const r = await ctx.act('chop_tree', { radius: clamp(o.radius + 8, 4, 64), avoid_spawn: 48 })
        await backHome(ctx)
        return r
      }
    },
    {
      name: 'top_up_seeds',
      mode: 'active',
      when: 'day',
      cooldownMinutes: 15,
      description: 'break grass near home for seeds while it has fewer than 16 (carried and in its chests), for its farm or the one it is to start',
      requires: ['gather_seeds'],
      // no farm yet counts too: start_farm needs 8 (it used to wait for a farm that needed the seeds)
      applicable: (ctx, o) => wants('top_up_seeds', ctx, o),
      whyIdle: (ctx, o) => choreIdle('top_up_seeds', stateFor(ctx, o)),
      async run (ctx, o) {
        const have = seedCount(heldItems(bot(ctx)))
        const r = await ctx.act('gather_seeds', { count: clamp(16 - have, 1, 64), radius: clamp(o.radius + 8, 4, 128), maxMinutes: 3 })
        await backHome(ctx)
        // no grass near home (snow, a stone yard): not again for a while
        return r.ok && seedCount(heldItems(bot(ctx))) <= have ? nothing(r.message) : r
      }
    },
    {
      name: 'extend_farm',
      mode: 'active',
      when: 'day',
      cooldownMinutes: 10,
      description: 'plant, re-till and grow its farm near home, or start one when it has seeds and no farm',
      requires: ['tend_farm'],
      applicable: (ctx, o) => wants('extend_farm', ctx, o),
      whyIdle: (ctx, o) => choreIdle('extend_farm', stateFor(ctx, o)),
      async run (ctx) {
        const farm = nearestFarm(agent, bot(ctx))
        if (!farm) return ctx.act('start_farm', { seeds: 8 })
        return ctx.act('tend_farm', { farm: farm.name, size: 9 })
      }
    },
    {
      name: 'craft_spares',
      mode: 'active',
      when: 'any',
      cooldownMinutes: 10,
      description: 'craft torches (below 16) or a spare stone pickaxe from what it carries',
      requires: ['craft'],
      applicable: (ctx, o) => wants('craft_spares', ctx, o),
      whyIdle: (ctx, o) => choreIdle('craft_spares', stateFor(ctx, o)),
      async run (ctx) {
        const s = spareCraft(heldItems(bot(ctx)))
        if (!s) return 'nothing to craft'
        return ctx.act('craft', { item: s.item, count: s.count })
      }
    },
    {
      name: 'light_dark_spots',
      mode: 'active',
      when: 'day',
      cooldownMinutes: 30,
      quietMinutes: 240,
      description: 'torches on the dark spots around home where mobs could spawn',
      requires: ['light_up'],
      applicable: (ctx, o) => wants('light_dark_spots', ctx, o),
      whyIdle: (ctx, o) => choreIdle('light_dark_spots', stateFor(ctx, o)),
      async run (ctx, o) {
        const r = await ctx.act('light_up', { place: 'home', radius: clamp(o.radius, 2, 48), max_torches: 8 })
        // lit nothing (all lit, or no spot a torch reaches): leave it for a few hours
        const placed = (r.data as { placed?: unknown[] } | undefined)?.placed
        return r.ok && Array.isArray(placed) && !placed.length ? nothing(r.message) : r
      }
    },
    {
      name: 'scout_nearby',
      mode: 'active',
      when: 'day',
      cooldownMinutes: 30,
      description: 'look around near home for iron and coal it does not know of yet (remembered as found:iron, found:coal), then come back',
      requires: ['find_target', 'go_home'],
      applicable: (ctx, o) => wants('scout_nearby', ctx, o),
      whyIdle: (ctx, o) => choreIdle('scout_nearby', stateFor(ctx, o)),
      async run (ctx, o) {
        const target = nextTarget(SCOUT)
        if (!target) return 'knows where iron and coal are'
        const r = await ctx.act('find_target', { target, radius: clamp(o.radius * 2, 16, 512), max_minutes: 3, exposed: true })
        await backHome(ctx)
        // none near home: the next look is the quiet pause away, not the cooldown
        return r.ok ? { ok: true, message: `scouted for ${target}: ${r.message}` } : nothing(`scouted for ${target}: ${r.message}`)
      }
    },
    {
      name: 'explore',
      mode: 'explore',
      when: 'day',
      cooldownMinutes: 20,
      description: 'a scouting trip out to idle.exploreRadius for ore, a village or diamonds it does not know of, then home',
      requires: ['find_target', 'go_home'],
      applicable: (ctx) => homeDist(ctx) !== null && day(ctx) && !!nextTarget(EXPLORE) && (ctx.now - exploreAt > 60_000 || ctx.now < exploreAt),
      async run (ctx, o) {
        exploreAt = ctx.now
        const target = nextTarget(EXPLORE)
        if (!target) return 'nothing left to look for'
        const r = await tripRun(ctx, { purpose: `exploring for ${target}`, kind: 'travel', distance: o.radius },
          () => ctx.act('find_target', { target, radius: clamp(o.radius, 16, 512), max_minutes: clamp(o.minutes, 1, 30), exposed: true }))
        await backHome(ctx)
        return { ok: true, message: `explored for ${target}: ${r.message}` }
      }
    }
  ]
}
