// Navigation around a home base: wander near it, go back to it, remember named places.
// Home and places live in agent.storage, so they survive restarts.
import type { Bot } from 'mineflayer'
import type { Agent } from '../core/index.ts'
import {
  defineSkill, defineAction, z, noParams, ok, fail, goals, fmtPos, nearestHostile,
  checkAborted, travel, swimUp, oxygen, dangerMemory, DEATH_ZONE_KIND
} from '../core/index.ts'
import { gotoWithin as walkWithin, GotoTimeoutError } from './world.ts'
import { prepareTripAction } from './trip.ts'
import { escapeBox, ShelteredError } from './survival.ts'

export interface Place {
  x: number
  y: number
  z: number
  dimension?: string
}

const HOME_KEY = 'home'
const PLACES_KEY = 'places'

export function getHome (agent: Agent): Place | undefined {
  return agent.storage.get<Place>(HOME_KEY)
}

export function setHome (agent: Agent, place: Place): void {
  agent.storage.set(HOME_KEY, place)
}

export function getPlaces (agent: Agent): Record<string, Place> {
  return agent.storage.get<Record<string, Place>>(PLACES_KEY, {})
}

export function setPlace (agent: Agent, name: string, place: Place | null): void {
  const places = { ...getPlaces(agent) }
  if (place) places[name] = place
  else delete places[name]
  agent.storage.set(PLACES_KEY, places)
}

function here (bot: Bot): Place {
  const p = bot.entity.position
  return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), dimension: bot.game.dimension }
}

export function sameDimension (bot: Bot, place: Place): boolean {
  return !place.dimension || place.dimension === bot.game.dimension
}

/**
 * Walks to a goal but gives up after `ms`. Returns false on timeout, rethrows when the
 * action itself was aborted, so callers can report a partial walk instead of hanging. A path
 * stopped right at the start (the previous action's stop landing on ours) is retried once.
 */
async function gotoWithin (bot: Bot, goal: unknown, signal: AbortSignal, ms: number): Promise<boolean> {
  try {
    await walkWithin(bot, goal, signal, ms)
    return true
  } catch (e) {
    checkAborted(signal)
    if (e instanceof GotoTimeoutError) return false
    throw e
  }
}

/** A home a few blocks up or down (a floor above, a cellar, stairs) still counts as there. */
export const HOME_VERTICAL_SLACK = 3

/**
 * How far a position is from home for "am I home" checks: horizontal distance to the middle
 * of the home block, plus only the part of the height difference beyond HOME_VERTICAL_SLACK.
 * Pure, exported for tests.
 */
export function homeOffset (pos: { x: number, y: number, z: number }, home: { x: number, y: number, z: number }): number {
  const dy = Math.max(0, Math.abs(pos.y - home.y) - HOME_VERTICAL_SLACK)
  return Math.hypot(pos.x - (home.x + 0.5), dy, pos.z - (home.z + 0.5))
}

/** Within `range` of home by homeOffset (range 0 still allows standing anywhere on the home block). */
export function atHome (pos: { x: number, y: number, z: number }, home: { x: number, y: number, z: number }, range: number): boolean {
  return homeOffset(pos, home) <= Math.max(range, 0.75)
}

/** A Vec3 at absolute block coordinates, built from the bot's own position (no direct vec3 dependency). */
function at (bot: Bot, x: number, y: number, z: number) {
  const base = bot.entity.position.floored()
  return base.offset(x - base.x, y - base.y, z - base.z)
}

export function distanceTo (bot: Bot, p: { x: number, y: number, z: number }): number {
  const e = bot.entity.position
  return Math.hypot(e.x - p.x, e.y - p.y, e.z - p.z)
}

function isPassable (block: any): boolean {
  return !!block && block.boundingBox === 'empty' && !/water|lava/.test(block.name)
}

function isStandable (block: any): boolean {
  return !!block && block.boundingBox === 'block' && !/lava|magma|cactus|campfire/.test(block.name)
}

/** Height offsets to try, top down (0 = y itself), or nearest to y first: 0, -1, 1, -2, 2... */
export function standOffsets (span: number, nearest = false): number[] {
  const out: number[] = []
  if (!nearest) { for (let dy = span; dy >= -span; dy--) out.push(dy); return out }
  out.push(0)
  for (let d = 1; d <= span; d++) out.push(-d, d)
  return out
}

/**
 * Finds a block to stand on at x/z near height y (solid below, two free blocks above). Top down
 * by default; `nearest` tries the heights closest to y first, so a walk near a building ends on
 * the ground next to it and not on its roof or wall top (seen live: Pax's strolls by the fortress
 * all picked roofs it could not get to, "found nowhere to wander to").
 */
export function findStandable (bot: Bot, x: number, y: number, z: number, span = 6, nearest = false): Place | null {
  for (const dy of standOffsets(span, nearest)) {
    const ground = bot.blockAt(at(bot, x, y + dy - 1, z))
    if (!ground || !isStandable(ground)) continue
    const feet = bot.blockAt(ground.position.offset(0, 1, 0))
    const head = bot.blockAt(ground.position.offset(0, 2, 0))
    if (isPassable(feet) && isPassable(head)) return { x, y: y + dy, z }
  }
  return null
}

/** In water from the blocks at the feet, the head and below, and whether it stands (pure, for tests). */
export function inWaterAt (b: { feet?: string, head?: string, below?: string, onGround: boolean }): boolean {
  if (b.feet === 'water' || b.head === 'water') return true
  // bobbing at the surface (a jump out of a hole in the ice): it sinks back once it stops swimming
  return !b.onGround && b.below === 'water'
}

/** In water or bobbing on it (sinks once it stops swimming). */
export function inWater (bot: Bot): boolean {
  const p = bot.entity.position
  return inWaterAt({ feet: bot.blockAt(p)?.name, head: bot.blockAt(p.offset(0, 1, 0))?.name, below: bot.blockAt(p.offset(0, -1, 0))?.name, onGround: !!bot.entity.onGround })
}

/**
 * Swims to the nearest dry spot within 12 blocks (does nothing when not in water). Returns
 * whether it ended out of the water. For actions that end with the bot afloat: an idle bot
 * in deep water sinks and drowns.
 */
/**
 * Offsets to look for dry land at, nearest ring first: every 2 blocks out to 12, then every 4
 * out to `maxRadius` with 16 directions (the middle of a lake). Pure, exported for tests.
 */
export function dryLandOffsets (maxRadius = 12): [number, number][] {
  const out: [number, number][] = []
  for (let r = 2; r <= Math.min(12, maxRadius); r += 2) out.push([r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r])
  for (let r = 16; r <= maxRadius; r += 4) {
    for (let i = 0; i < 16; i++) out.push([Math.round(Math.cos(i * Math.PI / 8) * r), Math.round(Math.sin(i * Math.PI / 8) * r)])
  }
  return out
}

export async function reachDryLand (bot: Bot, signal: AbortSignal, maxRadius = 12): Promise<boolean> {
  if (!inWater(bot)) return true
  const p = bot.entity.position
  for (const [dx, dz] of dryLandOffsets(maxRadius)) {
    const spot = findStandable(bot, Math.floor(p.x) + dx, Math.floor(p.y), Math.floor(p.z) + dz, 6)
    if (!spot || bot.blockAt(at(bot, spot.x, spot.y, spot.z))?.name === 'water') continue
    // under water and short of air: up for a breath before the next try (the pathfinder walks lake beds)
    if (oxygen(bot) < 12) await swimUp(bot, signal)
    // the exact spot: within 1 of a spot on the ice is still in the hole
    const far = Math.hypot(dx, dz) > 12
    await gotoWithin(bot, new goals.GoalBlock(spot.x, spot.y, spot.z), signal, far ? 40_000 : 20_000).catch(() => { checkAborted(signal); return false })
    if (!inWater(bot)) return true
  }
  return !inWater(bot)
}

const wander = defineAction({
  name: 'wander',
  description: 'Take a short walk to a random spot within a radius of home (or of a given center, or of where the bot stands).',
  params: z.object({
    radius: z.number().min(1).max(64).default(12).describe('how far from the center to wander, in blocks'),
    x: z.number().optional().describe('center x; default home, else current position'),
    z: z.number().optional().describe('center z')
  }),
  async run ({ agent, bot, signal }, { radius, x, z: cz }) {
    const home = getHome(agent)
    const pos = bot.entity.position
    const useHome = x === undefined && home && sameDimension(bot, home) && distanceTo(bot, home) < radius * 4
    const center = x !== undefined && cz !== undefined
      ? { x, y: pos.y, z: cz }
      : useHome ? home! : { x: pos.x, y: pos.y, z: pos.z }
    // the later tries stay closer (a small yard inside walls), and every try takes the ground
    // nearest the bot's height, not a roof or wall top above it
    let tries = 0
    for (let attempt = 0; attempt < 12; attempt++) {
      const r = attempt < 6 ? radius : Math.max(2, radius / 2)
      const angle = Math.random() * Math.PI * 2
      const dist = Math.max(1.5, r * Math.sqrt(Math.random()))
      const tx = Math.floor(center.x + Math.cos(angle) * dist)
      const tz = Math.floor(center.z + Math.sin(angle) * dist)
      const spot = findStandable(bot, tx, Math.floor(pos.y), tz, 6, true)
      if (!spot) continue
      // water, or a spot well above or below it: a lake or a cliff, not a stroll
      if (Math.abs(spot.y - pos.y) > 4) continue
      // not back into the spot it just died in (settings.deathSpots)
      if (dangerMemory(agent).isInDanger(spot, 0, DEATH_ZONE_KIND)) continue
      if (++tries > 6) break
      const arrived = await gotoWithin(bot, new goals.GoalNear(spot.x, spot.y, spot.z, 1), signal, 12000)
        .catch(() => { checkAborted(signal); return false })
      if (arrived) return ok(`wandered to ${fmtPos(bot.entity.position)}`)
    }
    return fail(tries ? 'found nowhere to wander to: no path to the spots I picked' : 'found nowhere to wander to: no ground to stand on within reach')
  }
})

const setHomeAction = defineAction({
  name: 'set_home',
  description: 'Remember a home position (default: where the bot stands now).',
  params: z.object({ x: z.number().optional(), y: z.number().optional(), z: z.number().optional() }),
  exclusive: false,
  run ({ agent, bot }, p) {
    const cur = here(bot)
    const home = { x: p.x ?? cur.x, y: p.y ?? cur.y, z: p.z ?? cur.z, dimension: cur.dimension }
    setHome(agent, home)
    return ok(`home set to ${fmtPos(home)}`)
  }
})

/** Beyond this, go_home walks in legs (travel) before the final approach. */
const FAR_HOME = 40
/** Longest go_home trip in legs. */
const FAR_HOME_MS = 5 * 60_000

const goHome = defineAction({
  name: 'go_home',
  description: 'Walk back to the remembered home position.',
  params: z.object({ range: z.number().min(0).max(16).default(2).describe('how close to get, in blocks') }),
  async run (ctx, { range }) {
    const { agent, bot, signal } = ctx
    const home = getHome(agent)
    if (!home) return fail('no home set')
    if (!sameDimension(bot, home)) return fail(`home is in ${home.dimension}`)
    // already there (inside the walls, a floor up or down): nothing to walk, and no path to fail
    if (atHome(bot.entity.position, home, range)) return ok(`already home (${fmtPos(home)})`)
    try { await escapeBox(ctx) } catch (e) { if (e instanceof ShelteredError) return fail(`${e.message}, at ${fmtPos(bot.entity.position)}`); throw e }
    let arrived = false
    try {
      // far out (after a respawn at world spawn, say): the pathfinder only plans through loaded
      // chunks, so walk most of the way in legs first
      if (homeOffset(bot.entity.position, home) > FAR_HOME) {
        const trip = AbortSignal.any([signal, AbortSignal.timeout(FAR_HOME_MS)])
        try {
          await travel(bot, home, trip, { range: Math.max(range, 3) })
        } catch (e) {
          checkAborted(signal)
          if (trip.aborted) throw new Error(`took over ${FAR_HOME_MS / 1000}s`)
          throw e
        }
      }
      arrived = await gotoWithin(bot, new goals.GoalNear(home.x, home.y, home.z, range), signal, 60000)
    } catch (e) {
      checkAborted(signal)
      if (atHome(bot.entity.position, home, range)) return ok(`home at ${fmtPos(home)}`)
      return fail(`couldn't get home (${(e as Error).message}), at ${fmtPos(bot.entity.position)}`)
    }
    // GoalNear measures to the block corner in 3D, atHome to the block's middle: allow the half
    // block (and a little) between them so stopping right at the edge counts
    if (atHome(bot.entity.position, home, range + 1)) return ok(`home at ${fmtPos(home)}`)
    // the pathfinder can settle without getting there (seen live: done in 5 ms, 80 blocks out);
    // only being there counts, so stay_safe backs off instead of calling this every second
    return fail(arrived
      ? `the path ended short of home, at ${fmtPos(bot.entity.position)} (${Math.round(homeOffset(bot.entity.position, home))} blocks out)`
      : `couldn't get home in time, at ${fmtPos(bot.entity.position)}`)
  }
})

const rememberPlace = defineAction({
  name: 'remember_place',
  description: 'Remember a named place (default: where the bot stands now), to walk back to later with goto_place.',
  params: z.object({
    name: z.string().min(1).max(32),
    x: z.number().optional(),
    y: z.number().optional(),
    z: z.number().optional()
  }),
  exclusive: false,
  run ({ agent, bot }, p) {
    const cur = here(bot)
    const place = { x: p.x ?? cur.x, y: p.y ?? cur.y, z: p.z ?? cur.z, dimension: cur.dimension }
    setPlace(agent, p.name.toLowerCase(), place)
    return ok(`remembered ${p.name} at ${fmtPos(place)}`)
  }
})

const forgetPlace = defineAction({
  name: 'forget_place',
  description: 'Forget a named place.',
  params: z.object({ name: z.string() }),
  exclusive: false,
  run ({ agent }, { name }) {
    if (!getPlaces(agent)[name.toLowerCase()]) return fail(`don't know ${name}`)
    setPlace(agent, name.toLowerCase(), null)
    return ok(`forgot ${name}`)
  }
})

const places = defineAction({
  name: 'places',
  description: 'List home and remembered places.',
  params: noParams,
  exclusive: false,
  run ({ agent }) {
    const home = getHome(agent)
    const list = Object.entries(getPlaces(agent)).map(([n, p]) => `${n} (${fmtPos(p)})`)
    return ok(`home: ${home ? fmtPos(home) : 'none'}; places: ${list.join(', ') || 'none'}`)
  }
})

const gotoPlace = defineAction({
  name: 'goto_place',
  description: 'Walk to a place remembered with remember_place.',
  params: z.object({ name: z.string(), range: z.number().min(0).max(16).default(2) }),
  async run ({ agent, bot, signal }, { name, range }) {
    const place = getPlaces(agent)[name.toLowerCase()]
    if (!place) return fail(`don't know ${name}`)
    if (!sameDimension(bot, place)) return fail(`${name} is in ${place.dimension}`)
    const arrived = await gotoWithin(bot, new goals.GoalNear(place.x, place.y, place.z, range), signal, 60000)
    return arrived ? ok(`at ${name}`) : fail(`couldn't reach ${name} in time`)
  }
})

const flee = defineAction({
  name: 'flee',
  description: 'Run away from the nearest hostile mob until it is a safe distance away.',
  params: z.object({
    distance: z.number().min(4).max(32).default(16).describe('how far to get from the mob'),
    entityId: z.number().int().optional().describe('run from this mob instead of the nearest hostile one')
  }),
  async run ({ bot, signal }, { distance, entityId }) {
    const picked = entityId !== undefined ? bot.entities[entityId] : undefined
    const mob = picked && picked.type !== 'player' ? picked : nearestHostile(bot, bot.entity.position, distance)
    if (!mob) return ok('nothing to flee from')
    const away = new goals.GoalInvert(new goals.GoalFollow(mob, distance))
    const done = await gotoWithin(bot, away, signal, 15000).catch(() => false)
    return done ? ok(`got away from ${mob.name}`) : fail(`couldn't get away from ${mob.name}`)
  }
})

export const navigation = () => defineSkill({
  name: 'navigation',
  capabilities: ['move'],
  description: 'Home, wandering and named places.',
  actions: [wander, setHomeAction, goHome, rememberPlace, forgetPlace, places, gotoPlace, flee, prepareTripAction],
  observe: (agent, bot) => {
    const home = getHome(agent)
    return {
      home: home ? fmtPos(home) : null,
      homeDistance: home && sameDimension(bot, home) ? Math.round(distanceTo(bot, home)) : null,
      places: Object.fromEntries(Object.entries(getPlaces(agent)).slice(0, 20).map(([k, v]) => [k, fmtPos(v)]))
    }
  }
})
