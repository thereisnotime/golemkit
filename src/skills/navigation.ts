// Navigation around a home base: wander near it, go back to it, remember named places.
// Home and places live in agent.storage, so they survive restarts.
import type { Bot } from 'mineflayer'
import type { Agent } from '../core/index.ts'
import {
  defineSkill, defineAction, z, noParams, ok, fail, goals, fmtPos, nearestHostile,
  checkAborted
} from '../core/index.ts'
import { gotoWithin as walkWithin, GotoTimeoutError } from './world.ts'

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

/** Finds a block to stand on at x/z near height y (solid below, two free blocks above). */
export function findStandable (bot: Bot, x: number, y: number, z: number, span = 6): Place | null {
  for (let dy = span; dy >= -span; dy--) {
    const ground = bot.blockAt(at(bot, x, y + dy - 1, z))
    if (!ground || !isStandable(ground)) continue
    const feet = bot.blockAt(ground.position.offset(0, 1, 0))
    const head = bot.blockAt(ground.position.offset(0, 2, 0))
    if (isPassable(feet) && isPassable(head)) return { x, y: y + dy, z }
  }
  return null
}

function inWater (bot: Bot): boolean {
  const p = bot.entity.position
  return bot.blockAt(p)?.name === 'water' || bot.blockAt(p.offset(0, 1, 0))?.name === 'water'
}

/**
 * Swims to the nearest dry spot within 12 blocks (does nothing when not in water). Returns
 * whether it ended out of the water. For actions that end with the bot afloat: an idle bot
 * in deep water sinks and drowns.
 */
export async function reachDryLand (bot: Bot, signal: AbortSignal): Promise<boolean> {
  if (!inWater(bot)) return true
  const p = bot.entity.position
  for (let r = 2; r <= 12; r += 2) {
    for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]] as const) {
      const spot = findStandable(bot, Math.floor(p.x) + dx, Math.floor(p.y), Math.floor(p.z) + dz, 6)
      if (!spot || bot.blockAt(at(bot, spot.x, spot.y, spot.z))?.name === 'water') continue
      const there = await gotoWithin(bot, new goals.GoalNear(spot.x, spot.y, spot.z, 1), signal, 20000).catch(() => { checkAborted(signal); return false })
      if (there || !inWater(bot)) return true
    }
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
    for (let attempt = 0; attempt < 10; attempt++) {
      const angle = Math.random() * Math.PI * 2
      const dist = radius * Math.sqrt(Math.random())
      const tx = Math.floor(center.x + Math.cos(angle) * dist)
      const tz = Math.floor(center.z + Math.sin(angle) * dist)
      const spot = findStandable(bot, tx, Math.floor(pos.y), tz)
      if (!spot) continue
      const arrived = await gotoWithin(bot, new goals.GoalNear(spot.x, spot.y, spot.z, 1), signal, 20000)
        .catch(() => false)
      if (arrived) return ok(`wandered to ${fmtPos(bot.entity.position)}`)
    }
    return fail('found nowhere to wander to')
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

const goHome = defineAction({
  name: 'go_home',
  description: 'Walk back to the remembered home position.',
  params: z.object({ range: z.number().min(0).max(16).default(2).describe('how close to get, in blocks') }),
  async run ({ agent, bot, signal }, { range }) {
    const home = getHome(agent)
    if (!home) return fail('no home set')
    if (!sameDimension(bot, home)) return fail(`home is in ${home.dimension}`)
    // already there (inside the walls, a floor up or down): nothing to walk, and no path to fail
    if (atHome(bot.entity.position, home, range)) return ok(`already home (${fmtPos(home)})`)
    let arrived = false
    try {
      arrived = await gotoWithin(bot, new goals.GoalNear(home.x, home.y, home.z, range), signal, 60000)
    } catch (e) {
      checkAborted(signal)
      if (atHome(bot.entity.position, home, range)) return ok(`home at ${fmtPos(home)}`)
      return fail(`couldn't get home (${(e as Error).message}), at ${fmtPos(bot.entity.position)}`)
    }
    if (!arrived && !atHome(bot.entity.position, home, range)) return fail(`couldn't get home in time, at ${fmtPos(bot.entity.position)}`)
    return ok(`home at ${fmtPos(home)}`)
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
  actions: [wander, setHomeAction, goHome, rememberPlace, forgetPlace, places, gotoPlace, flee],
  observe: (agent, bot) => {
    const home = getHome(agent)
    return {
      home: home ? fmtPos(home) : null,
      homeDistance: home && sameDimension(bot, home) ? Math.round(distanceTo(bot, home)) : null,
      places: Object.fromEntries(Object.entries(getPlaces(agent)).slice(0, 20).map(([k, v]) => [k, fmtPos(v)]))
    }
  }
})
