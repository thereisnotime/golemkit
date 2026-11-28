// A bed at home and the respawn point on it: tracks where the respawn point is (server bed
// messages, sleeping, where the bot comes back after dying), places a bed near home
// (place_bed), clicks it to set the respawn point (set_spawn, which at night sleeps and waits a
// little for the others, asking them to go to bed), and shears sheep for wool (shear).
// The planning is pure, in bedPlan.ts; keep_spawn_bed (the behaviour) strings the steps
// together.
import type { Bot } from 'mineflayer'
import type { Block } from 'prismarine-block'
import type { Entity } from 'prismarine-entity'
import { defineSkill, defineAction, z, ok, fail, goals, sleep, checkAborted, fmtPos, itemName, type Agent, type ActionResult } from '../core/index.ts'
import { vec, findItem, isReplaceable, isPlaceFace, reachBlock, gotoWithin } from './world.ts'
import { placeBlockState } from './placement.ts'
import { getHome, sameDimension } from './navigation.ts'
import { pickupNearby } from './pickup.ts'
import { inPen } from './combat.ts'
import { inDangerZone } from './food-danger.ts'
import {
  parseBedMessage, clickOutcome, noteSpawnSet, noteSpawnLost, noteRespawn, planBedSpot, bedSpotProblem, bedsWorkIn, isBedItem,
  sleepAskStep, noteSleepMessage, askText, SLEEP_ASK_DEFAULTS, DEFAULT_ASK_TEXT, DEFAULT_REMIND_TEXT,
  type SpawnRecord, type BedMessage, type CellAt, type Facing, type Pos, type SleepAskState, type SleepPlayer
} from './bedPlan.ts'
import { baseAnchored } from '../core/baseAnchored.ts'

// the spawn bed it keeps is at home
baseAnchored({ keys: ['spawnBed'] })

export const SPAWN_KEY = 'spawnBed'
export const OWN_BEDS_KEY = 'spawnBed.own'

const P = (p: { x: number, y: number, z: number }): Pos => ({ x: p.x, y: p.y, z: p.z })

export function getSpawn (agent: Agent): SpawnRecord {
  return agent.storage.get<SpawnRecord>(SPAWN_KEY, { status: 'unknown' })
}

function saveSpawn (agent: Agent, rec: SpawnRecord, note?: string): void {
  const before = getSpawn(agent)
  agent.storage.set(SPAWN_KEY, rec)
  if (before.status !== rec.status || (rec.bed && before.bed && (before.bed.x !== rec.bed.x || before.bed.z !== rec.bed.z))) {
    agent.log.info(`respawn point ${rec.status}${rec.bed ? ` at bed ${fmtPos(rec.bed)}` : ''}${rec.reason && rec.status === 'lost' ? `: ${rec.reason}` : ''}${note ? ` (${note})` : ''}`)
  }
}

/** Beds this bot placed itself (foot cells), remembered across restarts. */
export function ownBeds (agent: Agent): (Pos & { dim?: string })[] {
  return agent.storage.get<(Pos & { dim?: string })[]>(OWN_BEDS_KEY, [])
}

function rememberOwnBed (agent: Agent, p: Pos, dim?: string): void {
  const list = ownBeds(agent).filter(b => !(Math.abs(b.x - p.x) <= 1 && b.y === p.y && Math.abs(b.z - p.z) <= 1))
  agent.storage.set(OWN_BEDS_KEY, [...list, { ...P(p), ...(dim ? { dim } : {}) }].slice(-8))
}

function forgetOwnBed (agent: Agent, p: Pos): void {
  agent.storage.set(OWN_BEDS_KEY, ownBeds(agent).filter(b => !(b.x === p.x && b.y === p.y && b.z === p.z)))
}

const isBed = (b: Block | null | undefined): b is Block => !!b && /_bed$/.test(b.name)

/**
 * Its own beds near `center` that are still there (or not loaded, so maybe), nearest first.
 * A loaded spot without a bed is forgotten.
 */
export function ownBedsNear (agent: Agent, bot: Bot, center: Pos, range: number): { pos: Pos, loaded: boolean }[] {
  const out: { pos: Pos, loaded: boolean, d: number }[] = []
  for (const b of ownBeds(agent)) {
    if (b.dim && bot.game?.dimension && b.dim !== bot.game.dimension) continue
    const d = Math.hypot(b.x - center.x, b.z - center.z)
    if (d > range) continue
    const block = bot.blockAt(vec(bot, b.x, b.y, b.z))
    if (block && !isBed(block)) { forgetOwnBed(agent, b); continue }
    out.push({ pos: P(b), loaded: !!block, d })
  }
  return out.sort((a, b) => a.d - b.d).map(({ pos, loaded }) => ({ pos, loaded }))
}

/** The block at the remembered respawn bed: a bed, gone, or not loaded. */
export function spawnBedState (bot: Bot, rec: SpawnRecord): 'bed' | 'gone' | 'unknown' {
  if (!rec.bed) return 'unknown'
  if (rec.dim && bot.game?.dimension && rec.dim !== bot.game.dimension) return 'unknown'
  const b = bot.blockAt(vec(bot, rec.bed.x, rec.bed.y, rec.bed.z))
  if (!b) return 'unknown'
  return isBed(b) ? 'bed' : 'gone'
}

/** Marks the respawn point lost when its bed is loaded and gone. Returns the record. */
export function checkSpawnBed (agent: Agent, bot: Bot): SpawnRecord {
  const rec = getSpawn(agent)
  if (rec.status === 'set' && spawnBedState(bot, rec) === 'gone') {
    const lost = noteSpawnLost(rec, Date.now(), `the bed at ${fmtPos(rec.bed!)} is gone`)
    saveSpawn(agent, lost)
    return lost
  }
  return rec
}

function nearestBed (bot: Bot, maxDistance = 5): Block | null {
  return bot.findBlock({ matching: b => isBed(b), maxDistance }) ?? null
}

// ------------------------------------------------------------------ session state

interface Session {
  lastClick?: { at: number, bed: Pos }
  sleep: SleepAskState | null
  listeners: Set<(m: BedMessage) => void>
}
const sessions = new WeakMap<Bot, Session>()
function sessionOf (bot: Bot): Session {
  let s = sessions.get(bot)
  if (!s) sessions.set(bot, s = { sleep: null, listeners: new Set() })
  return s
}

function setup (agent: Agent, bot: Bot): () => void {
  const s = sessionOf(bot)
  let awaitingRespawn = false
  let respawnTimer: ReturnType<typeof setTimeout> | null = null
  const dim = () => bot.game?.dimension
  const onMessage = (text: string, position: string) => {
    if (position === 'chat') return
    const m = parseBedMessage(text)
    if (!m) return
    for (const l of s.listeners) l(m)
    if (s.sleep) s.sleep = noteSleepMessage(s.sleep, m)
    const recent = s.lastClick && Date.now() - s.lastClick.at < 4000 ? s.lastClick : null
    if (m.kind === 'set_spawn') {
      const bed = recent?.bed ?? (nearestBed(bot) ? P(nearestBed(bot)!.position) : null)
      if (bed) saveSpawn(agent, noteSpawnSet(bed, dim(), Date.now(), 'message'))
    } else if ((m.kind === 'no_sleep' || m.kind === 'not_safe') && recent) {
      saveSpawn(agent, noteSpawnSet(recent.bed, dim(), Date.now(), 'click'))
    } else if (m.kind === 'spawn_not_valid') {
      saveSpawn(agent, noteSpawnLost(getSpawn(agent), Date.now(), 'the server found no bed to respawn at (broken or blocked)'))
    }
  }
  const onSleep = () => {
    const bed = s.lastClick?.bed ?? (nearestBed(bot, 3) ? P(nearestBed(bot, 3)!.position) : null)
    if (bed) saveSpawn(agent, noteSpawnSet(bed, dim(), Date.now(), 'slept'))
  }
  const onSpawnReset = () => saveSpawn(agent, noteSpawnLost(getSpawn(agent), Date.now(), 'no respawn bed available (the server reset the spawn point)'))
  const onDeath = () => { awaitingRespawn = true }
  const onSpawn = () => {
    if (!awaitingRespawn) return
    awaitingRespawn = false
    // the position packet can come a moment after the respawn
    if (respawnTimer) clearTimeout(respawnTimer)
    respawnTimer = setTimeout(() => {
      respawnTimer = null
      if (!bot.entity) return
      const rec = getSpawn(agent)
      saveSpawn(agent, noteRespawn(rec, P(bot.entity.position), dim(), Date.now()))
    }, 1500)
  }
  bot.on('messagestr', onMessage)
  bot.on('sleep', onSleep)
  bot.on('spawnReset' as any, onSpawnReset)
  bot.on('death', onDeath)
  bot.on('spawn', onSpawn)
  return () => {
    bot.off('messagestr', onMessage)
    bot.off('sleep', onSleep)
    bot.off('spawnReset' as any, onSpawnReset)
    bot.off('death', onDeath)
    bot.off('spawn', onSpawn)
    if (respawnTimer) clearTimeout(respawnTimer)
  }
}

// ------------------------------------------------------------------ place_bed

/** The spot planner's view of the world around the bot. */
export function cellReader (bot: Bot): CellAt {
  return (x, y, z) => {
    const b = bot.blockAt(vec(bot, x, y, z))
    if (!b) return null
    const liquid = /water|lava|bubble_column/.test(b.name)
    return { name: b.name, solid: b.boundingBox === 'block' && isPlaceFace(b) && !liquid, free: isReplaceable(b.name) && !liquid }
  }
}

const placeBed = defineAction({
  name: 'place_bed',
  capabilities: ['place'],
  description: 'Put a bed from the inventory down near home (or near the bot without a home): an air spot with a floor and headroom, ' +
    'next to the home spot if possible, never in front of a door, on a chest, in a one-wide passage or in a protected area. ' +
    'With x y z (and facing) it goes exactly there. Remembers the bed as its own.',
  params: z.object({
    item: z.string().optional().describe('which bed; default the first one in the inventory'),
    x: z.number().int().optional(),
    y: z.number().int().optional(),
    z: z.number().int().optional(),
    facing: z.enum(['north', 'south', 'east', 'west']).optional().describe('which way the head goes from x y z'),
    range: z.number().min(2).max(16).default(6).describe('how far from home to look for a spot')
  }),
  async run ({ bot, agent, signal, log }, p): Promise<ActionResult> {
    const item = p.item ?? bot.inventory.items().map(itemName).find(isBedItem)
    if (!item || !findItem(bot, item)) return fail(p.item ? `no ${p.item} in the inventory` : 'no bed in the inventory')
    if (!bedsWorkIn(bot.game?.dimension)) return fail(`beds explode in ${bot.game?.dimension}`)
    const at = cellReader(bot)
    const avoid = (q: Pos) => agent.protectedAreas.isProtected(q) || inDangerZone(agent, q)
    let foot: Pos
    let facing: Facing
    if (p.x !== undefined && p.y !== undefined && p.z !== undefined) {
      foot = { x: p.x, y: p.y, z: p.z }
      facing = p.facing ?? 'north'
      const why = bedSpotProblem(at, foot, facing, { avoid })
      if (why) return fail(`can't put a bed at ${fmtPos(foot)} facing ${facing}: ${why}`)
    } else {
      const home = getHome(agent)
      const center = home && sameDimension(bot, home) ? home : P(bot.entity.position.floored())
      const spot = planBedSpot(center, at, { range: p.range, avoid })
      if (!spot) return fail(`no free spot for a bed within ${p.range} blocks of ${home ? 'home' : 'here'} (needs floor, headroom, away from doors and chests)`)
      foot = spot.foot
      facing = spot.facing
    }
    try {
      await placeBlockState(bot, item, vec(bot, foot.x, foot.y, foot.z), { facing }, signal, { canDig: false, log })
    } catch (e) {
      checkAborted(signal)
      return fail(`could not place the bed at ${fmtPos(foot)}: ${(e as Error).message}`)
    }
    await sleep(300, signal)
    const placed = bot.blockAt(vec(bot, foot.x, foot.y, foot.z))
    if (!isBed(placed)) return fail(`placing ${item} at ${fmtPos(foot)} did nothing`)
    const realFacing = (placed.getProperties() as { facing?: Facing }).facing ?? facing
    rememberOwnBed(agent, foot, bot.game?.dimension)
    return ok(`placed ${item} at ${fmtPos(foot)}, head ${realFacing}`, { x: foot.x, y: foot.y, z: foot.z, facing: realFacing })
  }
})

// ------------------------------------------------------------------ set_spawn

const PLAYER_POSE = 6
const SLEEPING_POSE = 2

function playerSleeping (bot: Bot, e: Entity | undefined): boolean {
  if (!e) return false
  const keys = (bot.registry as any).entitiesByName?.player?.metadataKeys as string[] | undefined
  const pi = keys?.indexOf('pose') ?? -1
  const si = keys?.indexOf('sleeping_pos') ?? -1
  const pose: unknown = e.metadata?.[pi >= 0 ? pi : PLAYER_POSE]
  const bedAt = si >= 0 ? e.metadata?.[si] : undefined
  return pose === SLEEPING_POSE || pose === 'sleeping' || !!bedAt
}

/** Who else is online, as the sleep-ask planner sees them. */
export function sleepPlayers (bot: Bot): SleepPlayer[] {
  return Object.entries(bot.players ?? {})
    .filter(([name]) => name !== bot.username)
    .map(([name, pl]) => ({
      name,
      seen: !!pl.entity,
      sleeping: playerSleeping(bot, pl.entity),
      spectator: pl.gamemode === 3
    }))
}

function isNightOrStorm (bot: Bot): boolean {
  const t = bot.time?.timeOfDay ?? 0
  return (t >= 12542 && t <= 23459) || (bot.isRaining && (bot as any).thunderState > 0)
}

/** Clicks the bed and waits for the server's answer (a message, or the bot lying down). */
async function clickBed (bot: Bot, bed: Block, signal: AbortSignal): Promise<{ msg: BedMessage | null, slept: boolean }> {
  const s = sessionOf(bot)
  let got: BedMessage | null = null
  const l = (m: BedMessage) => { if (!got && clickOutcome(m.kind)) got = m }
  s.listeners.add(l)
  try {
    s.lastClick = { at: Date.now(), bed: P(bed.position) }
    await bot.activateBlock(bed)
    const until = Date.now() + 2500
    while (Date.now() < until && !got && !bot.isSleeping) await sleep(100, signal)
    // "Respawn point set" can come just before "only at night": take a moment for the second
    if (got && (got as BedMessage).kind === 'set_spawn') await sleep(200, signal)
    return { msg: got, slept: bot.isSleeping }
  } finally {
    s.listeners.delete(l)
  }
}

const setSpawn = defineAction({
  name: 'set_spawn',
  capabilities: ['sleep', 'move'],
  description: 'Set the respawn point at a bed: its own bed near home (or the bed at x y z) by right-clicking it. By day that only sets the ' +
    'point; at night it lies down, waits a few seconds for the night to skip and asks players still up to go to bed (a few polite asks at most), ' +
    'then gets up. Never in the Nether or the End (beds explode there).',
  params: z.object({
    x: z.number().int().optional(),
    y: z.number().int().optional(),
    z: z.number().int().optional(),
    grace_seconds: z.number().min(0).max(120).default(12).describe('at night: how long to stay in bed waiting for the others'),
    ask: z.boolean().default(true).describe('at night: ask players who are still up to go to bed'),
    ask_text: z.string().max(200).default(DEFAULT_ASK_TEXT).describe('first ask; {players} is replaced by the names'),
    remind_text: z.string().max(200).default(DEFAULT_REMIND_TEXT).describe('reminders; {players}, {sleeping}, {needed}'),
    ask_every_seconds: z.number().min(3).max(60).default(5).describe('between asks'),
    max_asks: z.number().int().min(0).max(5).default(3).describe('asks per night, the first one included'),
    sleeping_percentage: z.number().int().min(0).max(101).default(100).describe("the server's playersSleepingPercentage, until the server reports a count"),
    ignore: z.array(z.string()).default([]).describe('players never asked (other bots)'),
    stay: z.boolean().default(false).describe('stay in bed until morning instead of getting up after the grace')
  }),
  async run ({ bot, agent, signal, log }, p): Promise<ActionResult> {
    if (!bedsWorkIn(bot.game?.dimension)) return fail(`not here: beds explode in ${bot.game?.dimension}`)
    let bed: Block | null = null
    if (p.x !== undefined && p.y !== undefined && p.z !== undefined) {
      bed = bot.blockAt(vec(bot, p.x, p.y, p.z))
      if (!isBed(bed)) return fail(`no bed at ${p.x} ${p.y} ${p.z}`)
    } else {
      const own = ownBedsNear(agent, bot, P(bot.entity.position), 48)[0]
      if (!own) return fail('no bed of mine nearby (place_bed first, or give x y z)')
      if (!own.loaded) await gotoWithin(bot, new goals.GoalNear(own.pos.x, own.pos.y, own.pos.z, 2), signal, 60_000).catch(() => { checkAborted(signal) })
      bed = bot.blockAt(vec(bot, own.pos.x, own.pos.y, own.pos.z))
      if (!isBed(bed)) return fail(`my bed at ${fmtPos(own.pos)} is gone`)
    }
    let answer: { msg: BedMessage | null, slept: boolean } = { msg: null, slept: false }
    for (const range of [2, 1]) {
      checkAborted(signal)
      try { await reachBlock(bot, bed.position, signal, range, 30_000) } catch (e) { checkAborted(signal); return fail(`can't get to the bed at ${fmtPos(bed.position)}: ${(e as Error).message}`) }
      answer = await clickBed(bot, bed, signal)
      if (answer.msg?.kind !== 'too_far') break
    }
    const pos = P(bed.position)
    if (!answer.slept) {
      const out = answer.msg ? clickOutcome(answer.msg.kind) : null
      if (!out) return fail(`the server did not answer the click on the bed at ${fmtPos(pos)}`)
      if (!out.set) return fail(`${out.why} (bed at ${fmtPos(pos)})`)
      saveSpawn(agent, noteSpawnSet(pos, bot.game?.dimension, Date.now(), 'click'))
      return ok(`${out.why} at the bed ${fmtPos(pos)}`, { x: pos.x, y: pos.y, z: pos.z, slept: false })
    }
    saveSpawn(agent, noteSpawnSet(pos, bot.game?.dimension, Date.now(), 'slept'))
    if (p.stay) {
      while (bot.isSleeping && isNightOrStorm(bot)) await sleep(2000, signal)
      return ok(`respawn point set at the bed ${fmtPos(pos)}; slept until morning`, { x: pos.x, y: pos.y, z: pos.z, slept: true })
    }
    // In bed at night: wait for the night to skip, ask the others, get up when the grace runs out.
    const s = sessionOf(bot)
    s.sleep = { startedAt: Date.now(), asks: 0 }
    const opts = { ...SLEEP_ASK_DEFAULTS, graceMs: p.grace_seconds * 1000, ask: p.ask, intervalMs: p.ask_every_seconds * 1000, maxAsks: p.max_asks, percentage: p.sleeping_percentage, ignore: p.ignore }
    let end = ''
    let asked: string[] = []
    try {
      for (;;) {
        checkAborted(signal)
        const step = sleepAskStep(s.sleep, { now: Date.now(), inBed: bot.isSleeping, night: isNightOrStorm(bot), self: bot.username, players: sleepPlayers(bot) }, opts)
        if (step.do === 'done') { end = step.why; break }
        if (step.do === 'leave') { end = `got up: ${step.why}`; break }
        if (step.do === 'ask') {
          agent.say(askText(step.first ? p.ask_text : p.remind_text, step.players, s.sleep.count))
          asked = step.players
          s.sleep = { ...s.sleep, asks: s.sleep.asks + 1, lastAskAt: Date.now() }
          log.debug('asked players to sleep', { players: step.players.join(','), missing: step.missing })
          continue
        }
        await sleep(step.ms, signal)
      }
    } finally {
      s.sleep = null
      if (bot.isSleeping) await bot.wake().catch(() => {})
    }
    const who = asked.length && end.startsWith('got up') ? ` (asked ${asked.join(', ')})` : ''
    return ok(`respawn point set at the bed ${fmtPos(pos)}; ${end}${who}`, { x: pos.x, y: pos.y, z: pos.z, slept: true })
  }
})

// ------------------------------------------------------------------ shear

/** An adult sheep that still has its wool and may be sheared (not named, leashed or penned). */
export function shearable (bot: Bot, e: Entity, opts: { pens?: boolean } = {}): boolean {
  if (e.name !== 'sheep') return false
  const keys = (bot.registry as any).entitiesByName?.sheep?.metadataKeys as string[] | undefined
  const at = (k: string, fallback: number): unknown => { const i = keys?.indexOf(k) ?? -1; return e.metadata?.[i >= 0 ? i : fallback] }
  const wool = at('wool', 17)
  if (typeof wool === 'number' && (wool & 0x10)) return false
  if (at('baby', 16) === true) return false
  const name = at('custom_name', 2)
  if (name !== undefined && name !== null && name !== '') return false
  if ((e as any).vehicle) return false
  return !!opts.pens || !inPen(bot, e)
}

const shear = defineAction({
  name: 'shear',
  capabilities: ['move', 'inventory'],
  description: 'Shear sheep nearby with shears from the inventory and pick up the wool. Leaves babies, named, leashed and penned sheep alone.',
  params: z.object({
    count: z.number().int().min(1).max(16).default(3).describe('how many sheep to shear'),
    radius: z.number().min(4).max(64).default(24).describe('how far to look'),
    pens: z.boolean().default(false).describe('also shear sheep inside fences (only your own)')
  }),
  async run ({ bot, agent, signal, log }, p): Promise<ActionResult> {
    const before = woolCount(bot)
    let done = 0
    const skipped = new Set<number>()
    while (done < p.count) {
      checkAborted(signal)
      const shearsItem = findItem(bot, 'shears')
      if (!shearsItem) return done ? ok(`sheared ${done} sheep (the shears broke), ${woolCount(bot) - before} wool`) : fail('no shears')
      const target = bot.nearestEntity(e => !skipped.has(e.id) && e.position.distanceTo(bot.entity.position) <= p.radius &&
        shearable(bot, e, { pens: p.pens }) && !agent.protectedAreas.isProtected(e.position))
      if (!target) break
      try {
        await gotoWithin(bot, new goals.GoalFollow(target, 1.5), signal, 20_000)
      } catch (e) {
        checkAborted(signal)
        if (target.position.distanceTo(bot.entity.position) > 3) { skipped.add(target.id); log.debug('shear: could not reach a sheep', { at: fmtPos(target.position) }); continue }
      }
      await bot.equip(shearsItem, 'hand')
      await bot.lookAt(target.position.offset(0, 0.8, 0), true)
      await bot.activateEntity(target).catch(() => {})
      await sleep(400, signal)
      if (shearable(bot, target, { pens: true })) { skipped.add(target.id); continue }
      done++
      await pickupNearby(bot, signal, { radius: 6, maxMs: 5000 })
    }
    const got = woolCount(bot) - before
    if (!done) return fail(`no sheep to shear within ${p.radius} blocks`)
    return ok(`sheared ${done} sheep, picked up ${got} wool`, { wool: got })
  }
})

function woolCount (bot: Bot): number {
  return bot.inventory.items().filter(i => /_wool$/.test(itemName(i))).reduce((n, i) => n + i.count, 0)
}

export const spawnBed = () => defineSkill({
  name: 'spawn_bed',
  description: 'A bed at home and the respawn point on it: place_bed, set_spawn (by day a click, at night a short sleep), shear.',
  actions: [placeBed, setSpawn, shear],
  setup: (agent, bot) => setup(agent, bot as Bot),
  observe: (agent) => {
    const rec = getSpawn(agent)
    if (rec.status === 'unknown') return {}
    return { respawnPoint: rec.status === 'set' && rec.bed ? `bed ${fmtPos(rec.bed)}` : `none (${rec.reason ?? 'lost'})` }
  }
})
