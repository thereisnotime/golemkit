// light_home: spawn-proofs home, its own farms and listed places with torches, a few at a time
// by day. The planning is the light_up action (src/skills/lighting.ts, pure parts in
// lightPlan.ts); this decides when and where: each area once per `everyMinutes`, sooner after
// a hostile was seen there, only areas within `maxTrip` of the bot.
import type { Bot } from 'mineflayer'
import { z, needsSurvival, type Agent } from '../../../core/index.ts'
import { defineBehavior } from '../../../brains/behaviors/types.ts'
import { getHome, getPlaces, sameDimension } from '../../../skills/navigation.ts'
import { getFarms } from '../../../skills/food.ts'
import { inventoryCounts } from '../../../skills/toolkit.ts'
import { lightCheckDue } from '../../../skills/lightPlan.ts'
import { isDay, flatDist, hostilesNear, type Point } from './util.ts'

const CHECKED_KEY = 'lighting.checked'

const placeOpt = z.union([
  z.string(),
  z.object({ name: z.string().optional(), x: z.number(), y: z.number(), z: z.number(), radius: z.number().int().min(2).max(48).optional() })
])

interface Area extends Point {
  key: string
  label: string
  radius: number
  /** Side of the field when the area is one of its own farms. */
  farmSize?: number
}

/**
 * Where to walk to before lighting an area: the centre, or for a farm (whose centre is the
 * water) the middle of the ring side nearest the bot, so the walk ends off the field.
 */
export function approachPoint (a: Area, from: { x: number, z: number }): Point {
  if (!a.farmSize) return { x: a.x, y: a.y, z: a.z }
  const off = Math.ceil(a.farmSize / 2) + 1
  const dx = from.x - a.x, dz = from.z - a.z
  return Math.abs(dx) >= Math.abs(dz)
    ? { x: a.x + Math.sign(dx || 1) * off, y: a.y, z: a.z }
    : { x: a.x, y: a.y, z: a.z + Math.sign(dz) * off }
}

/** Home, own farms and the listed places in the bot's dimension. */
function areas (agent: Agent, bot: Bot, o: { home: boolean, farms: boolean, radius: number, farmRadius: number, places: z.infer<typeof placeOpt>[] }): Area[] {
  const out: Area[] = []
  const home = getHome(agent)
  if (o.home && home && sameDimension(bot, home)) out.push({ key: 'home', label: 'home', x: home.x, y: home.y, z: home.z, radius: o.radius })
  if (o.farms) {
    const dim = bot.game?.dimension
    for (const f of getFarms(agent)) {
      if (f.dim && dim && f.dim !== dim) continue
      out.push({ key: f.name, label: f.name, x: f.x, y: f.y + 1, z: f.z, radius: Math.max(o.farmRadius, Math.ceil(f.size / 2) + 4), farmSize: f.size })
    }
  }
  const places = getPlaces(agent)
  for (const p of o.places) {
    if (typeof p === 'string') {
      const pl = p.toLowerCase() === 'home' ? home : places[p.toLowerCase()]
      if (pl && sameDimension(bot, pl)) out.push({ key: p.toLowerCase(), label: p, x: pl.x, y: pl.y, z: pl.z, radius: o.radius })
    } else {
      const key = p.name ?? `${p.x},${p.y},${p.z}`
      out.push({ key, label: key, x: p.x, y: p.y, z: p.z, radius: p.radius ?? o.radius })
    }
  }
  // a farm or place inside another area's circle is still its own area (other centre, other floor)
  const seen = new Set<string>()
  return out.filter(a => !seen.has(a.key) && seen.add(a.key))
}

export const lightHome = defineBehavior({
  name: 'light_home',
  capabilities: ['place', 'craft', 'move'],
  category: 'work',
  description: 'Spawn-proofs home, its own farms and listed places: by day, every so often (sooner after a hostile was seen there) it walks over, ' +
    'finds the spots where mobs could spawn and puts torches down so every one has light (light_up: floor torches, walls where there is no floor, ' +
    'never on farmland, crops, paths, in front of doors, in water, near spawn or where a torch was refused, never breaking anything; around a farm ' +
    'it stays off the field and counts only the ground the field is on). Crafts torches from coal or charcoal ' +
    '(smelts charcoal from logs); backs off with a reason when out of both. Low priority: after food, safety and tools.',
  options: z.object({
    radius: z.number().int().min(4).max(48).default(24).describe('flat radius around home (and listed places) to light'),
    farmRadius: z.number().int().min(4).max(48).default(12).describe('radius around each of its own farms'),
    home: z.boolean().default(true).describe('light around home'),
    farms: z.boolean().default(true).describe('light around its own farms (farm:1, ...)'),
    places: z.array(placeOpt).max(16).default([]).describe('more areas: remembered place names, or {name, x, y, z, radius}'),
    target: z.number().int().min(1).max(15).default(8).describe('light every spawnable spot to at least this (1 stops 1.21.1 spawns; 8 leaves a margin)'),
    maxTorches: z.number().int().min(1).max(64).default(16).describe('torches per run'),
    yRange: z.number().int().min(1).max(16).default(6).describe('blocks above and below the centre to look at'),
    everyMinutes: z.number().min(5).max(24 * 60).default(20).describe('check each area this often (20 = one Minecraft day)'),
    onMobs: z.boolean().default(true).describe('re-check an area sooner when a hostile shows up in it'),
    maxTrip: z.number().int().min(16).max(512).default(96).describe('only areas within this distance of the bot'),
    spawnClearance: z.number().min(0).max(256).default(24).describe('never place within this distance of the world spawn')
  }),
  requires: ['light_up'],
  uses: ['go_home', 'goto', 'craft', 'smelt'],
  needs: { place: true },
  priority: 'npc',
  create (o, { agent }) {
    const mobSeen = new Map<string, number>()
    const mobIds = new Set<number>() // each mob counts once, not every tick it stays around
    const checked = () => agent.storage.get<Record<string, number>>(CHECKED_KEY, {})
    const due = (bot: Bot, now: number): Area[] => {
      if (!bot.entity) return []
      const me = bot.entity.position
      const c = checked()
      return areas(agent, bot, o)
        .filter(a => flatDist(a, me) <= o.maxTrip && lightCheckDue(c[a.key], now, o.everyMinutes * 60_000, mobSeen.get(a.key)))
        .sort((a, b) => flatDist(a, me) - flatDist(b, me))
    }
    return {
      cooldownMs: 30_000,
      failureCooldownMs: 120_000,
      maxFailureCooldownMs: 60 * 60_000,
      score: ({ bot, now, current }) => {
        const b = bot as Bot
        if (!b.entity || !needsSurvival(b)) return 0
        if (o.onMobs) {
          for (const a of areas(agent, b, o)) {
            if (flatDist(a, b.entity.position) > a.radius + 24) continue
            for (const h of hostilesNear(b, a, a.radius)) {
              if (mobIds.has(h.id)) continue
              mobIds.add(h.id)
              if (mobIds.size > 500) mobIds.delete(mobIds.values().next().value!)
              mobSeen.set(a.key, Date.now())
            }
          }
        }
        if (!isDay(b) || agent.settings.canPlace === false) return 0
        if (current === 'light_home') return 18
        return due(b, now).length ? 18 : 0
      },
      // out of coal: the back-off ends when torches, coal, charcoal, logs or cobblestone change
      retryKey: ({ bot }) => {
        const inv = (bot as Bot).inventory ? inventoryCounts(bot as Bot) : {}
        return Object.entries(inv).filter(([n]) => /^(torch|coal|charcoal|stick|cobblestone|furnace)$|_log$|_stem$|_planks$/.test(n)).map(([n, c]) => `${n}:${c}`).sort().join(',')
      },
      async run (ctx) {
        const bot = ctx.bot as Bot
        const area = due(bot, ctx.now)[0]
        if (!area) return { ok: true, message: 'every area is checked' }
        if (flatDist(area, bot.entity.position) > 24) {
          const r = area.key === 'home' && agent.getAction('go_home')
            ? await ctx.act('go_home', { range: 4 })
            : await ctx.act('goto', { ...approachPoint(area, bot.entity.position) })
          if (!r.ok) return { ok: false, message: `light_home: could not get to ${area.label}: ${r.message}` }
        }
        const r = await ctx.act('light_up', {
          x: area.x, y: area.y, z: area.z, radius: area.radius, y_range: o.yRange, target: o.target,
          max_torches: o.maxTorches, spawn_clearance: o.spawnClearance
        })
        const d = r.data as { left?: number, placed?: unknown[] } | undefined
        // done when nothing is left dark, or this run placed nothing new (no spot reaches the rest)
        if (r.ok && (!d?.left || !d.placed?.length)) {
          agent.storage.set(CHECKED_KEY, { ...checked(), [area.key]: Date.now() })
          mobSeen.delete(area.key)
        }
        agent.log.info(`light_home: ${area.label}: ${r.message}`)
        return r
      }
    }
  }
})
