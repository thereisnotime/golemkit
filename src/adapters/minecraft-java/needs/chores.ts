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
import { spareCraft } from '../../../skills/needPlan.ts'
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

  return [
    {
      name: 'look_around',
      mode: 'passive',
      when: 'any',
      cooldownMinutes: 0.3,
      description: 'glance around, at players close by now and then',
      requires: ['look_around'],
      applicable: () => true,
      run: (ctx) => ctx.act('look_around', { radius: 10 })
    },
    {
      name: 'go_home',
      mode: 'idle',
      when: 'any',
      cooldownMinutes: 1,
      description: 'walk back home when it is further than idle.radius',
      requires: ['go_home'],
      applicable: (ctx, o) => { const d = homeDist(ctx); return d !== null && d > o.radius },
      run: (ctx) => ctx.act('go_home', { range: 3 })
    },
    {
      name: 'stroll',
      mode: 'idle',
      when: 'day',
      cooldownMinutes: 2,
      description: 'a short walk near home',
      requires: ['wander'],
      applicable: (ctx, o) => nearHome(ctx, o.radius),
      run: (ctx, o) => ctx.act('wander', { radius: clamp(Math.min(8, o.radius), 1, 64) })
    },
    {
      name: 'rest_by_bed',
      mode: 'idle',
      when: 'night',
      cooldownMinutes: 1,
      description: 'at night, go home and wait by the bed',
      requires: ['go_home'],
      applicable: (ctx) => !ctx.bb.facts.sleeping && homeDist(ctx) !== null,
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
      applicable: (ctx, o) => nearHome(ctx, o.radius) && tidyBody().score(ctx) > 0,
      run: (ctx) => tidyBody().run(ctx)
    },
    {
      name: 'top_up_wood',
      mode: 'active',
      when: 'day',
      cooldownMinutes: 10,
      description: 'fell a tree near home while it has fewer than 16 logs',
      requires: ['chop_tree'],
      applicable: (ctx, o) => !!agent.canDig && nearHome(ctx, o.radius) && woodStock(bot(ctx)) < 16,
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
      description: 'break grass near home for seeds while its farm has fewer than 16',
      requires: ['gather_seeds'],
      applicable: (ctx, o) => !!agent.canDig && nearHome(ctx, o.radius) && getFarms(agent).length > 0 && seedCount(heldItems(bot(ctx))) + chestSeedCount(agent, bot(ctx)) < 16,
      async run (ctx, o) {
        const have = seedCount(heldItems(bot(ctx)))
        const r = await ctx.act('gather_seeds', { count: clamp(16 - have, 1, 64), radius: clamp(o.radius + 8, 4, 128), maxMinutes: 3 })
        await backHome(ctx)
        return r
      }
    },
    {
      name: 'extend_farm',
      mode: 'active',
      when: 'day',
      cooldownMinutes: 10,
      description: 'plant, re-till and grow its farm near home, or start one when it has seeds and no farm',
      requires: ['tend_farm'],
      applicable: (ctx, o) => {
        if (!agent.canDig) return false
        const b = bot(ctx)
        const farm = nearestFarm(agent, b)
        if (!farm) return !!agent.getAction('start_farm') && seedCount(heldItems(b)) + chestSeedCount(agent, b) >= 8 && nearHome(ctx, o.radius * 2)
        const home = getHome(agent)
        if (home && Math.hypot(home.x - farm.x, home.z - farm.z) > o.radius * 2) return false
        const w = farmWorkFor(agent, b, farm, { targetSize: 9, seedReserve: 4 })
        return !!w && farmWorkCount(w) > 0
      },
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
      applicable: (ctx) => !!spareCraft(heldItems(bot(ctx))),
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
      description: 'torches on the dark spots around home where mobs could spawn',
      requires: ['light_up'],
      applicable: (ctx, o) => {
        if (!nearHome(ctx, o.radius) || agent.settings.canPlace === false) return false
        const inv = heldItems(bot(ctx))
        return (inv.torch ?? 0) > 0 || (inv.coal ?? 0) + (inv.charcoal ?? 0) > 0
      },
      run: (ctx, o) => ctx.act('light_up', { place: 'home', radius: clamp(o.radius, 2, 48), max_torches: 8 })
    },
    {
      name: 'scout_nearby',
      mode: 'active',
      when: 'day',
      cooldownMinutes: 30,
      description: 'look around near home for iron and coal it does not know of yet (remembered as found:iron, found:coal), then come back',
      requires: ['find_target', 'go_home'],
      applicable: (ctx, o) => nearHome(ctx, o.radius) && !!nextTarget(SCOUT),
      async run (ctx, o) {
        const target = nextTarget(SCOUT)
        if (!target) return 'knows where iron and coal are'
        const r = await ctx.act('find_target', { target, radius: clamp(o.radius * 2, 16, 512), max_minutes: 3, exposed: true })
        await backHome(ctx)
        return { ok: true, message: `scouted for ${target}: ${r.message}` }
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
