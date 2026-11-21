// Placing a block in a given state: the bot side of the placement planner (blockstate.ts).
// For a cell and a wanted state it asks the planner which neighbour to click, on which face,
// where, and which way to look; picks a spot to stand within reach of that neighbour (not in
// the cell itself), walks there, looks, clicks, and reads the block back. A wrong facing or
// half gets one more go (broken and placed again, the next option first); a trapdoor that
// should be open is used once.
import type { Bot } from 'mineflayer'
import type { Vec3 } from 'vec3'
import type { Logger } from '../core/index.ts'
import { goals, checkAborted, sleep } from '../core/index.ts'
import { vec, findItem, isPlaceFace, isReplaceable, gotoWithin, digBlock } from './world.ts'
import { equipFor } from './toolkit.ts'
import { isCreative, flyNear } from './creative.ts'
import {
  planPlacement, checkCell, rankStands, standCandidatesIn, standKey, distToBlock, blockNameFor, familyOf, DIR_VEC, EYE,
  type BlockState, type CellCheck, type Dir, type PlacementOption, type StandCandidate, type Facing
} from './blockstate.ts'

/** The server allows 4.5 blocks to the clicked block's nearest point, plus a little slack. */
export const PLACE_REACH = 4.6

/** Nothing to click that gives the wanted state yet (a log with no neighbour along its axis). Try again later. */
export class NotPlaceableYet extends Error {
  constructor (msg: string) { super(msg); this.name = 'NotPlaceableYet' }
}

export interface PlaceStateResult {
  /** The block is there in the right state (or only a cosmetic property differs). */
  ok: boolean
  check: CellCheck
  /** The planner option that was used last. */
  via?: string
  attempts: number
}

const P = (v: { x: number, y: number, z: number }) => ({ x: v.x, y: v.y, z: v.z })

/** Neighbour lookups for the planner. */
function envAt (bot: Bot, pos: Vec3) {
  const at = (d: Dir) => bot.blockAt(pos.offset(DIR_VEC[d].x, DIR_VEC[d].y, DIR_VEC[d].z))
  return {
    solid: (d: Dir) => { const b = at(d); return !!b && !isReplaceable(b.name) && isPlaceFace(b) },
    name: (d: Dir) => at(d)?.name,
    free: (d: Dir) => isReplaceable(at(d)?.name)
  }
}

/** Free spots to stand around a target: solid below, room for the body (see standCandidatesIn). */
function standCandidates (bot: Bot, target: Vec3, inside?: (p: { x: number, y: number, z: number }) => boolean, radius = 4): StandCandidate[] {
  return standCandidatesIn(p => bot.blockAt(vec(bot, p.x, p.y, p.z)), P(target), { radius, inside })
}

/**
 * Time to walk to a stand spot: a short budget (a few blocks away is a few seconds; an
 * unreachable spot otherwise eats the whole pathfinder think timeout), a bit more when further.
 */
export function standPathMs (distance: number): number {
  return Math.round(Math.min(STAND_PATH_MAX_MS, STAND_PATH_BASE_MS + distance * 250))
}
const STAND_PATH_BASE_MS = 4000
const STAND_PATH_MAX_MS = 8000
/** Stand spots tried per reference block before giving up on it. */
const STANDS_PER_REF = 3

/**
 * Remembers what a build learned about standing spots, shared by every placement of one build:
 * spots that couldn't be reached, which spots to rule out (inside other structures) and which
 * cells are still to be built (standing there gets in the way later).
 */
export interface StandMemory {
  failed: Set<string>
  inside?: (p: { x: number, y: number, z: number }) => boolean
  unbuilt?: (p: { x: number, y: number, z: number }) => boolean
}

export function newStandMemory (opts: Omit<StandMemory, 'failed'> = {}): StandMemory {
  return { failed: new Set(), ...opts }
}

/** The cells the new block will fill (two for doors and beds): the bot must not stand there. */
function footprint (item: string, state: BlockState | undefined, pos: Vec3): { x: number, y: number, z: number }[] {
  const cells = [P(pos)]
  const fam = familyOf(item, state)
  if (fam === 'door') cells.push({ x: pos.x, y: pos.y + 1, z: pos.z })
  if (fam === 'bed') {
    const v = DIR_VEC[(state?.facing ?? 'north') as Facing]
    cells.push({ x: pos.x + v.x, y: pos.y, z: pos.z + v.z })
  }
  return cells
}

const eyeOf = (bot: Bot) => { const p = bot.entity.position; return { x: p.x, y: p.y + EYE, z: p.z } }
const feetOf = (bot: Bot) => { const p = bot.entity.position; return { x: Math.floor(p.x), y: Math.floor(p.y + 0.01), z: Math.floor(p.z) } }
const inCells = (here: { x: number, y: number, z: number }, occupied: { x: number, y: number, z: number }[]) =>
  occupied.some(o => o.x === here.x && o.z === here.z && (o.y === here.y || o.y === here.y + 1))

/** The reference block is in reach from where the bot stands now, and it isn't standing in the cells to fill. */
function reachableFromHere (bot: Bot, refPos: Vec3, occupied: { x: number, y: number, z: number }[]): boolean {
  return !inCells(feetOf(bot), occupied) && distToBlock(eyeOf(bot), P(refPos)) <= PLACE_REACH - 0.2
}

/**
 * Walks to a spot from which the reference block is in reach. False when none is reachable.
 * Each spot gets a short path budget; a spot that fails goes into `memory.failed` and isn't
 * tried again in this build. The last resort is a short walk towards the target.
 */
async function standFor (bot: Bot, refPos: Vec3, target: Vec3, occupied: { x: number, y: number, z: number }[], signal: AbortSignal, log?: Logger, memory?: StandMemory): Promise<boolean> {
  if (reachableFromHere(bot, refPos, occupied)) return true
  const me = bot.entity.position
  const ranked = rankStands(standCandidates(bot, target, memory?.inside), P(refPos), occupied, P(me), PLACE_REACH - 0.2,
    { target: P(target), failed: memory?.failed, unbuilt: memory?.unbuilt })
  if (isCreative(bot)) {
    // creative: fly there, no scaffolding needed (a spot in the air next to the target when nothing stands)
    const c = ranked[0]
    const dest = c ? vec(bot, 0, 0, 0).set(c.x + 0.5, c.y, c.z + 0.5) : flySpot(bot, target, occupied)
    if (await flyNear(bot, dest, signal)) {
      if (distToBlock(eyeOf(bot), P(refPos)) <= PLACE_REACH) return true
    }
  }
  for (const c of ranked.slice(0, STANDS_PER_REF)) {
    checkAborted(signal)
    const ms = standPathMs(bot.entity.position.distanceTo(vec(bot, c.x + 0.5, c.y, c.z + 0.5)))
    const t0 = Date.now()
    try {
      await gotoWithin(bot, new goals.GoalBlock(c.x, c.y, c.z), signal, ms)
      if (distToBlock(eyeOf(bot), P(refPos)) <= PLACE_REACH) return true
    } catch (e) {
      checkAborted(signal)
      memory?.failed.add(standKey(c))
      log?.debug('placement: stand spot unreachable', { at: `${c.x} ${c.y} ${c.z}`, ms: Date.now() - t0, error: (e as Error).message })
    }
  }
  // last resort: a short walk towards the target, then check the reach
  await gotoWithin(bot, new goals.GoalNear(target.x, target.y, target.z, 2), signal, STAND_PATH_BASE_MS).catch(() => { checkAborted(signal) })
  return !inCells(feetOf(bot), occupied) && distToBlock(eyeOf(bot), P(refPos)) <= PLACE_REACH
}

/** A free point in the air beside a target (creative flying), outside the cells being filled. */
function flySpot (bot: Bot, target: Vec3, occupied: { x: number, y: number, z: number }[]): Vec3 {
  for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2], [2, 2], [-2, -2]] as const) {
    const p = target.offset(dx, -1, dz)
    const free = [0, 1].every(dy => { const b = bot.blockAt(p.offset(0, dy, 0)); return !b || b.boundingBox === 'empty' })
    if (free && !occupied.some(o => o.x === p.x && o.z === p.z)) return p.offset(0.5, 0, 0.5)
  }
  return target.offset(0.5, 2, 0.5)
}

/** One click following a planner option. */
async function clickOption (bot: Bot, pos: Vec3, opt: PlacementOption, signal: AbortSignal): Promise<void> {
  const v = DIR_VEC[opt.ref]
  const ref = bot.blockAt(pos.offset(v.x, v.y, v.z))
  if (!ref) throw new Error('reference block not loaded')
  const f = DIR_VEC[opt.face]
  const face = vec(bot, 0, 0, 0).set(f.x, f.y, f.z)
  const delta = vec(bot, 0, 0, 0).set(opt.cursor.x, opt.cursor.y, opt.cursor.z)
  const placeWith = (bot as any)._placeBlockWithOptions as ((r: unknown, f: Vec3, o: Record<string, unknown>) => Promise<void>) | undefined
  if (opt.yaw !== undefined || opt.pitch !== undefined) {
    // The server reads the facing from the player's look when the click arrives: send the look
    // first and give the physics loop a tick to put it on the wire.
    let yaw = opt.yaw
    if (yaw === undefined) {
      const d = ref.position.offset(opt.cursor.x, opt.cursor.y, opt.cursor.z).minus(bot.entity.position.offset(0, EYE, 0))
      yaw = Math.atan2(-d.x, -d.z)
    }
    await bot.look(yaw, opt.pitch ?? 0, true)
    await sleep(150, signal)
    if (placeWith) await placeWith.call(bot, ref, face, { delta, forceLook: 'ignore', swingArm: 'right' })
    else await bot.placeBlock(ref, face)
  } else if (placeWith) {
    await placeWith.call(bot, ref, face, { delta, forceLook: true, swingArm: 'right' })
  } else {
    await bot.placeBlock(ref, face)
  }
}

export interface PlaceStateOptions {
  /** Block names that count as right for this cell (the role's accept). Default: the item's block. */
  accepts?: (name: string) => boolean
  /** May break a wrongly placed block to try again. */
  canDig?: boolean
  log?: Logger
  /** Shared by the placements of one build: failed stand spots, spots to rule out. */
  stands?: StandMemory
  /** Walk to at most this many reference blocks (others only if in reach from where the bot ends up). Default 2. */
  maxWalks?: number
}

/**
 * Places `item` at `pos` so it ends up in `state`. Throws NotPlaceableYet when no neighbour
 * gives that state yet, and a plain Error when the spot is taken or unreachable. Otherwise
 * returns what the block looks like afterwards (ok false = still a wrong facing/half).
 */
export async function placeBlockState (bot: Bot, item: string, pos: Vec3, state: BlockState | undefined, signal: AbortSignal, opts: PlaceStateOptions = {}): Promise<PlaceStateResult> {
  const target = bot.blockAt(pos)
  if (!target) throw new Error('that spot is not loaded')
  if (!isReplaceable(target.name)) throw new Error(`${target.name} is already there`)
  const blockName = blockNameFor(item, state)
  const accepts = opts.accepts ?? ((n: string) => n === blockName)
  const occupied = footprint(item, state, pos)
  // every option gives the wanted state: the ones whose clicked block is in reach from here go first
  const fromHere = (o: PlacementOption) => { const d = DIR_VEC[o.ref]; return reachableFromHere(bot, pos.offset(d.x, d.y, d.z), occupied) }
  const hereFirst = (opts: PlacementOption[]) => [...opts.filter(fromHere), ...opts.filter(o => !fromHere(o))]
  let options = hereFirst(planPlacement(item, state, envAt(bot, pos)))
  let walks = 0
  const maxWalks = opts.maxWalks ?? 2
  if (!options.length) throw new NotPlaceableYet(`nothing to place ${item}${state ? ` [${Object.entries(state).map(([k, v]) => `${k}=${v}`).join(',')}]` : ''} against yet`)
  const read = (): CellCheck => {
    const b = bot.blockAt(pos)
    return checkCell(accepts, state, b?.name, b?.getProperties?.() as Record<string, unknown> | undefined, isReplaceable)
  }
  let attempts = 0
  let last: CellCheck = { status: 'missing', hard: [], soft: [] }
  let via: string | undefined
  let lastError: Error | null = null
  for (let i = 0; i < options.length && attempts < 3; i++) {
    const opt = options[i]!
    checkAborted(signal)
    const v = DIR_VEC[opt.ref]
    const refPos = pos.offset(v.x, v.y, v.z)
    const unreachable = () => { lastError = new Error(`can't get within reach of ${item} at ${pos.x} ${pos.y} ${pos.z}`) }
    if (!reachableFromHere(bot, refPos, occupied)) {
      // walking to a stand spot is the slow part: only for the first few options
      if (walks >= maxWalks) { unreachable(); continue }
      walks++
      if (!await standFor(bot, refPos, pos, occupied, signal, opts.log, opts.stands)) { unreachable(); continue }
    }
    const it = findItem(bot, item)
    if (!it) throw new Error(`no ${item} in inventory`)
    await bot.equip(it, 'hand')
    checkAborted(signal)
    attempts++
    via = opt.why
    try {
      await clickOption(bot, pos, opt, signal)
    } catch (e) {
      // placeBlock waits for a block update and sometimes times out although it worked
      await sleep(300, signal)
      if (isReplaceable(bot.blockAt(pos)?.name)) { lastError = new Error(`could not place ${item}: ${(e as Error).message}`); continue }
    }
    await sleep(100, signal)
    last = read()
    if (last.status === 'missing') { lastError = new Error(`placing ${item} did nothing`); continue }
    if (last.status === 'wrong_state' && last.hard.length === 1 && last.hard[0] === 'open') {
      const b = bot.blockAt(pos)
      if (b) { await bot.activateBlock(b).catch(() => {}); await sleep(250, signal); last = read() }
    }
    if (last.status === 'ok' || last.status === 'soft') return { ok: true, check: last, via, attempts }
    if (last.status !== 'wrong_state') return { ok: false, check: last, via, attempts }
    opts.log?.debug('placement: wrong state, trying again', { item, at: `${pos.x} ${pos.y} ${pos.z}`, wrong: last.hard.join(','), via })
    // wrong facing/half/axis: break it and try again (the next option, or the same one again)
    if (!opts.canDig) return { ok: false, check: last, via, attempts }
    const b = bot.blockAt(pos)
    if (!b) break
    await equipFor(bot, b)
    await digBlock(bot, b, signal)
    await sleep(200, signal)
    options = hereFirst(planPlacement(item, state, envAt(bot, pos)))
    if (i + 1 >= options.length) i = -1 // only one way: same option once more
  }
  if (last.status === 'missing' && lastError) throw lastError
  return { ok: last.status === 'ok' || last.status === 'soft', check: last, via, attempts }
}

/**
 * Walks to a spot from which a block can be dug (no line of sight needed, only reach), using
 * the same stand-spot search as placing. Throws when none is reachable.
 */
export async function reachToDig (bot: Bot, pos: Vec3, signal: AbortSignal, log?: Logger, stands?: StandMemory): Promise<void> {
  if (!await standFor(bot, pos, pos, [], signal, log, stands)) throw new Error(`can't get within reach of ${pos.x} ${pos.y} ${pos.z}`)
}

/** Uses a door, trapdoor or gate once (to open or close it). */
export async function toggleBlock (bot: Bot, pos: Vec3, signal: AbortSignal): Promise<void> {
  const b = bot.blockAt(pos)
  if (!b) return
  await gotoWithin(bot, new goals.GoalLookAtBlock(b.position, bot.world), signal, 15_000).catch(() => { checkAborted(signal) })
  await bot.activateBlock(b)
  await sleep(250, signal)
}

