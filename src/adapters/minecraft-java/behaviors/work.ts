// Chores: collect_drops, deposit_when_full, chop_wood_loop, farm_loop, light_area.
import type { Bot } from 'mineflayer'
import type { Block } from 'prismarine-block'
import { z } from '../../../core/index.ts'
import { defineBehavior } from '../../../brains/behaviors/types.ts'
import { droppedItemName, unreachableDrop } from '../../../skills/pickup.ts'
import { CROPS, isMature } from '../../../skills/farming.ts'
import { isPlaceFace, vec } from '../../../skills/world.ts'
import { resolveCenter, isDay, countWhere, dist, flatDist } from './util.ts'
import { WOOD_NEED } from './tools.ts'
import { DEFAULT_TREE_RINGS } from '../../../skills/treePlan.ts'
import { depositable, ironStillNeeded } from '../../../skills/storagePlan.ts'
import { homeDepositPlan, depositChests } from '../../../skills/containers.ts'
import { heldCounts } from '../../../skills/gear.ts'

// ------------------------------------------------------------------ collect_drops

export const collectDrops = defineBehavior({
  name: 'collect_drops',
  capabilities: ['move', 'inventory'],
  category: 'work',
  description: 'Picks up dropped items lying nearby every so often (all items, or only the listed ones). Arm it while working so loot and drops don\'t despawn. ' +
    'Drops it ran out of air going for (pickup.maxAirBreaks times, items on the bottom of a lake) are left alone for pickup.unreachableMinutes.',
  options: z.object({
    radius: z.number().min(2).max(32).default(12).describe('pick up drops this close'),
    items: z.array(z.string()).default([]).describe('only these items, e.g. oak_log,wheat; empty = everything'),
    everySeconds: z.number().min(2).max(600).default(15).describe('pause after a pickup run')
  }),
  requires: ['pickup_items'],
  priority: 'npc',
  create (o) {
    const wanted = (bot: Bot) => Object.values(bot.entities ?? {}).filter(e =>
      e.name === 'item' && e.position && bot.entity && e.position.distanceTo(bot.entity.position) <= o.radius &&
      (!o.items.length || o.items.includes(droppedItemName(e) ?? '')) &&
      !unreachableDrop(bot, e)) // given up on: ran out of air going for it (pickup.maxAirBreaks)
    return {
      cooldownMs: o.everySeconds * 1000,
      failureCooldownMs: 20_000,
      maxFailureCooldownMs: 120_000,
      score: ({ bot }) => bot.inventory?.emptySlotCount?.() !== 0 && wanted(bot).length ? 22 : 0,
      async run (ctx) {
        if (!o.items.length) return ctx.act('pickup_items', { radius: o.radius })
        const names = [...new Set(wanted(ctx.bot).map(e => droppedItemName(e)).filter((n): n is string => !!n))]
        let last = null
        for (const item of names) last = await ctx.act('pickup_items', { radius: o.radius, item })
        return last ?? { ok: false, message: 'nothing to pick up' }
      }
    }
  }
})

// ------------------------------------------------------------------ deposit_when_full

export const depositWhenFull = defineBehavior({
  name: 'deposit_when_full',
  capabilities: ['move', 'containers'],
  category: 'work',
  description: 'When the inventory is nearly full, stores what it does not need in its own chests near home, then walks back. ' +
    'Keeps tools, armour, shields, the bed, food, seeds for its farm, iron and fuel while tools or armour are to make, and a small crafting stock. ' +
    'The pantry (settings.storage.chests role pantry, the first one by default) only ever gets food; its own placed chests come first, then configured storage, ' +
    'gear chests only take gear. When they are all full it puts down a new chest of its own near home (outside, off paths and doors). ' +
    'With place or x y z it uses that chest instead.',
  options: z.object({
    threshold: z.number().min(0.3).max(1).default(0.85).describe('share of inventory slots used that counts as full'),
    place: z.string().optional().describe('remembered place where the chest is'),
    x: z.number().optional().describe('chest x (with y and z)'),
    y: z.number().optional(),
    z: z.number().optional(),
    keep: z.array(z.string()).default([]).describe('items never to store'),
    seeds: z.number().int().min(0).max(256).default(32).describe('seeds of each kind kept for its farm'),
    armour: z.boolean().default(true).describe('keep iron while iron armour is still to make (as well as iron tools)'),
    placeChest: z.boolean().default(true).describe('put down a new chest of its own near home when its chests are full'),
    returnBack: z.boolean().default(true).describe('walk back to where it was afterwards')
  }),
  requires: ['deposit'],
  uses: ['goto_place', 'goto', 'place_chest'],
  priority: 'npc',
  create (o, { agent }) {
    const needs = (bot: Bot) => ({ keep: o.keep, seeds: o.seeds, iron: ironStillNeeded(heldCounts(bot), o.armour) })
    const toStore = (bot: Bot) => {
      const isFood = (n: string) => !!(bot.registry as any)?.foodsByName?.[n]
      const inv: Record<string, number> = {}
      for (const i of bot.inventory?.items?.() ?? []) inv[i.name] = (inv[i.name] ?? 0) + i.count
      return depositable(inv, { ...needs(bot), isFood })
    }
    return {
      cooldownMs: 30_000,
      failureCooldownMs: 60_000,
      maxFailureCooldownMs: 600_000,
      score: ({ bot, bb, current }) => {
        if (current === 'deposit_when_full') return 45
        return bb.needs.inventoryFull >= o.threshold && Object.keys(toStore(bot as Bot)).length ? 45 : 0
      },
      async run (ctx) {
        const bot = ctx.bot as Bot
        const start = bot.entity.position.floored()
        const back = async () => {
          if (o.returnBack && agent.getAction('goto') && dist(start, bot.entity.position) > 6) await ctx.act('goto', { x: start.x, y: start.y, z: start.z })
        }
        const at = o.x !== undefined && o.y !== undefined && o.z !== undefined ? { x: o.x, y: o.y, z: o.z } : null
        if (o.place || at) {
          // the chest it was told to use
          if (o.place) {
            const r = await ctx.act('goto_place', { name: o.place })
            if (!r.ok) return r
          } else if (at && dist(at, bot.entity.position) > 24 && agent.getAction('goto')) {
            const r = await ctx.act('goto', at)
            if (!r.ok) return r
          }
          const items = toStore(bot)
          if (!Object.keys(items).length) return { ok: true, message: 'nothing I can spare to store' }
          const res = await ctx.act('deposit', { items, ...(at ?? {}) })
          await back()
          return res
        }
        const done: string[] = []
        let last: { ok: boolean, message: string } | null = null
        const canPlace = o.placeChest && agent.settings.canPlace !== false && !!agent.getAction('place_chest')
        for (let i = 0; i < 4; i++) {
          const { plan } = homeDepositPlan(agent, bot, needs(bot), { canPlace })
          if (plan.do === 'nothing') {
            if (i === 0 && !depositChests(agent, bot).length) {
              // no chests of its own and no home to put one by: the nearest chest (never the pantry for non-food)
              const items = toStore(bot)
              if (Object.keys(items).length) last = await ctx.act('deposit', { items })
            } else if (!done.length) last = { ok: false, message: plan.why }
            break
          }
          if (plan.do === 'place') {
            agent.log.info(`deposit_when_full: ${plan.why}, putting down a new chest`)
            const r = await ctx.act('place_chest', {})
            if (!r.ok) { last = { ok: false, message: `${plan.why}; ${r.message}` }; break }
            done.push(r.message)
            continue
          }
          if (dist(plan.at, bot.entity.position) > 24 && agent.getAction('goto')) {
            const r = await ctx.act('goto', { ...plan.at })
            if (!r.ok) { last = r; break }
          }
          const r = await ctx.act('deposit', { items: plan.items, ...plan.at })
          last = r
          if (r.ok) done.push(r.message)
          // full or partly stored: plan again with what the chest really holds now
          if (!Object.keys(toStore(bot)).length) break
          if (!r.ok && !(r.data as { full?: boolean } | undefined)?.full) break
        }
        await back()
        if (done.length) return { ok: true, message: done.join('; ') }
        return last ?? { ok: false, message: 'nothing stored' }
      }
    }
  }
})

// ------------------------------------------------------------------ chop_wood_loop

const isLog = (n: string) => /(_log|_stem)$/.test(n) && !n.startsWith('stripped_')
const isPlank = (n: string) => n.endsWith('_planks')

/** Logs in stock, counting 4 planks as a log. */
export function woodStock (bot: Bot): number {
  return countWhere(bot, isLog) + Math.floor(countWhere(bot, isPlank) / 4)
}

export const chopWoodLoop = defineBehavior({
  name: 'chop_wood_loop',
  capabilities: ['move', 'dig'],
  category: 'work',
  description: 'Keeps a stock of wood: by day, while it has fewer than `keep` logs (4 planks count as one), it fells trees, ' +
    'away from spawn, protected areas and remembered danger zones, and replants. With no tree close it goes to trees it remembers, ' +
    'then searches wider rings (a trip out and back). It also runs, at a higher score, when keep_tools_upgraded is stuck for wood. Needs digging enabled.',
  options: z.object({
    keep: z.number().int().min(1).max(512).default(16).describe('logs to keep in stock'),
    radius: z.number().min(4).max(64).default(32).describe('how far to look for trees when rings is empty'),
    rings: z.array(z.number().int().min(8).max(512)).max(8).default([...DEFAULT_TREE_RINGS])
      .describe('search rings when no tree is close, smallest first; rings past 64 blocks are scouting trips; [] = only radius'),
    spawnClearance: z.number().min(0).max(256).default(48).describe('leave trees within this distance of the world spawn alone (it still chops further out after respawning there)'),
    replant: z.boolean().default(true).describe('plant saplings afterwards')
  }),
  requires: ['chop_tree'],
  needs: { dig: true },
  priority: 'npc',
  create (o) {
    return {
      cooldownMs: 5000,
      failureCooldownMs: 60_000,
      maxFailureCooldownMs: 900_000,
      score ({ bot, bb }) {
        const needed = bb.need(WOOD_NEED) > 0
        if (!isDay(bot) || (woodStock(bot) >= o.keep && !needed) || bot.inventory?.emptySlotCount?.() === 0) return 0
        // spawnClearance is about the trees (chop_tree skips those near spawn), not where the bot
        // stands: it respawns at the world spawn after a death and has to start from there
        return needed ? 38 : 30
      },
      async run (ctx) {
        const before = woodStock(ctx.bot)
        const r = await ctx.act('chop_tree', { radius: o.radius, replant: o.replant, avoid_spawn: o.spawnClearance, ...(o.rings.length ? { rings: o.rings } : {}) })
        if (r.ok && woodStock(ctx.bot) > before) ctx.bb.setNeed(WOOD_NEED, 0)
        return r
      }
    }
  }
})

// ------------------------------------------------------------------ farm_loop

export function ripeCount (bot: Bot, center: { x: number, y: number, z: number }, radius: number): number {
  const ids = Object.keys(CROPS).map(n => bot.registry.blocksByName[n]?.id).filter((x): x is number => x !== undefined)
  return bot.findBlocks({
    point: center as any,
    matching: ids,
    maxDistance: radius,
    count: 64,
    useExtraInfo: (b: Block) => isMature(b.name, (b.getProperties() as Record<string, unknown>).age)
  }).length
}

export const farmLoop = defineBehavior({
  name: 'farm_loop',
  capabilities: ['move', 'dig', 'place'],
  category: 'work',
  description: 'Tends fields: every few minutes, when enough crops are ripe within the radius, harvests them, picks up the drops ' +
    'and replants. Arm it near a farm, or give it a remembered place (e.g. farm:1 from start_farm) to walk to.',
  options: z.object({
    radius: z.number().min(2).max(32).default(16).describe('field radius around the bot (or the place)'),
    minRipe: z.number().int().min(1).max(64).default(4).describe('wait until at least this many crops are ripe'),
    everyMinutes: z.number().min(0.5).max(240).default(5).describe('pause between rounds'),
    replant: z.boolean().default(true).describe('replant from the inventory'),
    place: z.string().optional().describe('remembered place of the field (e.g. farm:1); default around the bot')
  }),
  requires: ['harvest'],
  uses: ['goto'],
  priority: 'npc',
  create (o, { agent }) {
    const center = (bot: Bot) => o.place ? resolveCenter(agent, bot, { place: o.place }) : bot.entity?.position ?? null
    return {
      cooldownMs: o.everyMinutes * 60_000,
      failureCooldownMs: 120_000,
      maxFailureCooldownMs: 900_000,
      score: ({ bot }) => {
        const c = bot.entity ? center(bot) : null
        return c && ripeCount(bot, c, o.radius) >= o.minRipe ? 30 : 0
      },
      async run (ctx) {
        const c = center(ctx.bot)
        if (!c) return { ok: false, message: `don't know ${o.place}` }
        if (o.place) {
          if (dist(c, ctx.bot.entity.position) > 8 && agent.getAction('goto')) {
            const there = await ctx.act('goto', { x: c.x, y: c.y + 1, z: c.z })
            if (!there.ok) return there
          }
          return ctx.act('harvest', { radius: o.radius, replant: o.replant, x: c.x, y: c.y + 1, z: c.z })
        }
        return ctx.act('harvest', { radius: o.radius, replant: o.replant })
      }
    }
  }
})

// ------------------------------------------------------------------ light_area

/** Block light at a position (0..15), or null when the chunk has no light data. */
function blockLight (bot: Bot, p: { x: number, y: number, z: number }): number | null {
  const l = (bot.blockAt(vec(bot, p.x, p.y, p.z)) as any)?.light
  return typeof l === 'number' ? l : null
}

function torchNear (bot: Bot, spacing: number): boolean {
  const ids = ['torch', 'wall_torch', 'lantern', 'soul_torch', 'glowstone', 'sea_lantern', 'jack_o_lantern']
    .map(n => bot.registry.blocksByName[n]?.id).filter((x): x is number => x !== undefined)
  return !!bot.findBlock({ matching: ids, maxDistance: spacing })
}

function canMakeTorch (bot: Bot): boolean {
  const coal = countWhere(bot, n => n === 'coal' || n === 'charcoal')
  const sticks = countWhere(bot, n => n === 'stick') + countWhere(bot, isPlank)
  return coal > 0 && sticks > 0
}

/** A free block next to the bot with a solid floor, for a torch. */
function torchSpot (bot: Bot): { x: number, y: number, z: number } | null {
  const base = bot.entity.position.floored()
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]] as const) {
    const p = base.offset(dx, 0, dz)
    const here = bot.blockAt(p)
    if (here?.name !== 'air') continue
    if (!isPlaceFace(bot.blockAt(p.offset(0, -1, 0)))) continue
    return { x: p.x, y: p.y, z: p.z }
  }
  return null
}

export const lightArea = defineBehavior({
  name: 'light_area',
  capabilities: ['place'],
  category: 'work',
  description: 'Places torches on dark ground around home (or a remembered place) so mobs do not spawn there, crafting torches ' +
    'from coal and sticks if needed. Only inside the given radius; never in protected areas.',
  options: z.object({
    place: z.string().optional().describe('remembered place to light up; default home'),
    radius: z.number().min(4).max(64).default(20).describe('only light within this distance of the centre'),
    darkBelow: z.number().int().min(1).max(15).default(8).describe('place a torch where block light is below this'),
    spacing: z.number().int().min(3).max(16).default(7).describe('no torch closer than this to another light'),
    craft: z.boolean().default(true).describe('craft torches from coal/charcoal and sticks when out')
  }),
  requires: ['place_block'],
  uses: ['craft'],
  needs: { place: true },
  priority: 'npc',
  create (o, { agent }) {
    const ready = (bot: Bot) => {
      if (!bot.entity) return false
      const c = resolveCenter(agent, bot, { place: o.place })
      if (!c || flatDist(c, bot.entity.position) > o.radius) return false
      if (agent.protectedAreas?.isProtected(bot.entity.position)) return false
      const light = blockLight(bot, bot.entity.position)
      if (light === null || light >= o.darkBelow) return false
      if (torchNear(bot, o.spacing)) return false
      return countWhere(bot, n => n === 'torch') > 0 || (o.craft && !!agent.getAction('craft') && canMakeTorch(bot))
    }
    return {
      cooldownMs: 8000,
      failureCooldownMs: 30_000,
      maxFailureCooldownMs: 600_000,
      score: ({ bot }) => ready(bot) ? 20 : 0,
      async run (ctx) {
        if (!countWhere(ctx.bot, n => n === 'torch')) {
          if (!countWhere(ctx.bot, n => n === 'stick')) {
            const s = await ctx.act('craft', { item: 'stick', count: 4 })
            if (!s.ok) return s
          }
          const t = await ctx.act('craft', { item: 'torch', count: 4 })
          if (!t.ok) return t
        }
        const spot = torchSpot(ctx.bot)
        if (!spot) return { ok: false, message: 'no spot for a torch here' }
        return ctx.act('place_block', { item: 'torch', ...spot })
      }
    }
  }
})
