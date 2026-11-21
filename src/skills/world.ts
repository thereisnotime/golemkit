// Small world helpers shared by the extended skills: positions, finding items in the
// inventory by name, placing blocks against a neighbour, and walking within reach.
import type { Bot } from 'mineflayer'
import type { Block } from 'prismarine-block'
import type { Item } from 'prismarine-item'
import type { Vec3 } from 'vec3'
import { goals, goto, itemName, isModdedBlock, sleep, checkAborted } from '../core/index.ts'

/** Survival reach for digging/using blocks, a little under the server limit. */
export const REACH = 4.3

/** Blocks a placed block may replace (the server lets you place into them). */
const REPLACEABLE = new Set([
  'air', 'cave_air', 'void_air', 'water', 'lava', 'short_grass', 'grass', 'tall_grass', 'fern', 'large_fern',
  'snow', 'dead_bush', 'vine', 'seagrass', 'tall_seagrass', 'fire'
])

/** Blocks that open a GUI or toggle when right-clicked, so we must not use them as a placement face. */
const INTERACTIVE = /(chest|barrel|shulker_box|crafting_table|furnace|smoker|anvil|door|gate|button|lever|bed|table|loom|stonecutter|grindstone|hopper|dispenser|dropper|beacon|brewing_stand|enchanting|lectern|note_block|repeater|comparator|sign|cake|composter|bell|jukebox|trapdoor|campfire|cauldron|respawn_anchor)/

const DIRS: [number, number, number][] = [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]

/** A Vec3 at x/y/z, built from the bot's own position so we don't import vec3 directly. */
export function vec (bot: Bot, x: number, y: number, z: number): Vec3 {
  return bot.entity.position.clone().set(Math.floor(x), Math.floor(y), Math.floor(z))
}

export function isReplaceable (name: string | undefined): boolean {
  return !name || REPLACEABLE.has(name)
}

export function isInteractive (name: string): boolean {
  return INTERACTIVE.test(name)
}

/** A full solid cube we can safely click on to place against. */
export function isPlaceFace (block: Block | null): block is Block {
  return !!block && block.boundingBox === 'block' && !isModdedBlock(block) && !isInteractive(block.name)
}

export function findItem (bot: Bot, name: string): Item | undefined {
  return bot.inventory.items().find(i => itemName(i) === name)
}

export function countItem (bot: Bot, name: string): number {
  return bot.inventory.items().filter(i => itemName(i) === name).reduce((n, i) => n + i.count, 0)
}

export function within (bot: Bot, pos: Vec3, reach = REACH): boolean {
  return bot.entity.position.offset(0, bot.entity.height * 0.9, 0).distanceTo(pos.offset(0.5, 0.5, 0.5)) <= reach
}

/**
 * goto with a time limit: pathfinder can wander for minutes towards a goal it can't reach.
 * Throws a plain Error on timeout, ActionAbortedError if the action itself was stopped.
 */
export async function gotoWithin (bot: Bot, goal: any, signal: AbortSignal, ms = 30_000): Promise<void> {
  const ctl = new AbortController()
  const onAbort = () => ctl.abort()
  signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => ctl.abort(), ms)
  try {
    await goto(bot, goal, ctl.signal)
  } catch (e) {
    checkAborted(signal)
    if (ctl.signal.aborted) throw new Error('took too long to get there')
    throw e
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

/** Walks until the block is within reach (does nothing if it already is). */
export async function reachBlock (bot: Bot, pos: Vec3, signal: AbortSignal, range = 2, ms = 30_000): Promise<void> {
  if (within(bot, pos)) return
  const block = bot.blockAt(pos)
  if (block && block.boundingBox === 'block') {
    try {
      await gotoWithin(bot, new goals.GoalLookAtBlock(pos, bot.world, { reach: REACH }), signal, ms)
      return
    } catch (e) {
      checkAborted(signal)
    }
  }
  await gotoWithin(bot, new goals.GoalNear(pos.x, pos.y, pos.z, range), signal, ms)
}

/** Finds a neighbour of pos we can click to place a block there. */
export function findPlaceFace (bot: Bot, pos: Vec3): { ref: Block, face: Vec3 } | null {
  for (const [dx, dy, dz] of DIRS) {
    const ref = bot.blockAt(pos.offset(dx, dy, dz))
    if (isPlaceFace(ref)) return { ref, face: vec(bot, -dx, -dy, -dz) }
  }
  return null
}

/**
 * Places an inventory item at pos: walks close (never into the spot itself), equips it and
 * clicks the first solid neighbour. Throws with a short message on failure.
 */
export async function placeAt (bot: Bot, item: string, pos: Vec3, signal: AbortSignal): Promise<void> {
  const target = bot.blockAt(pos)
  if (!target) throw new Error('that spot is not loaded')
  if (!isReplaceable(target.name)) throw new Error(`${target.name} is already there`)
  const where = findPlaceFace(bot, pos)
  if (!where) throw new Error('nothing solid next to that spot to place against')
  const it = findItem(bot, item)
  if (!it) throw new Error(`no ${item} in inventory`)
  if (!within(bot, pos) || occupies(bot, pos)) {
    await gotoWithin(bot, new goals.GoalPlaceBlock(pos, bot.world, { range: REACH, LOS: false } as any), signal)
  }
  await bot.equip(it, 'hand')
  checkAborted(signal)
  try {
    await bot.placeBlock(where.ref, where.face)
  } catch (e) {
    // placeBlock waits for a block update and sometimes times out although it worked
    await sleep(250, signal)
    if (isReplaceable(bot.blockAt(pos)?.name)) throw new Error(`could not place ${item}: ${(e as Error).message}`)
  }
}

/** True if the bot's body overlaps the block at pos. */
export function occupies (bot: Bot, pos: Vec3): boolean {
  const p = bot.entity.position
  return Math.floor(p.x) === pos.x && Math.floor(p.z) === pos.z && (Math.floor(p.y) === pos.y || Math.floor(p.y) + 1 === pos.y)
}

/** A free spot next to the bot where a block can stand on solid ground (for tables/furnaces). */
export function findFreeSpot (bot: Bot): Vec3 | null {
  const base = bot.entity.position.floored()
  for (let r = 1; r <= 3; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
        for (const dy of [0, -1, 1]) {
          const p = base.offset(dx, dy, dz)
          if (!isReplaceable(bot.blockAt(p)?.name) || bot.blockAt(p)?.name === 'water' || bot.blockAt(p)?.name === 'lava') continue
          if (!isPlaceFace(bot.blockAt(p.offset(0, -1, 0)))) continue
          if (occupies(bot, p)) continue
          return p
        }
      }
    }
  }
  return null
}

export class DigRefusedError extends Error {
  constructor (block: string) {
    super(`the server won't let me break ${block} here (protected area?)`)
    this.name = 'DigRefusedError'
  }
}

/**
 * bot.dig that notices when the server refuses the break. A refused dig (spawn protection,
 * claims) is answered with a block update carrying the old state; mineflayer ignores that and
 * marks the block as air locally anyway. We watch for it, put the real state back into our
 * world and throw DigRefusedError. `settleMs` is how long to wait for that answer (shorter in
 * tunnels, where many blocks are dug in a row and the agent-wide refusal watcher still runs).
 */
export async function digBlock (bot: Bot, block: Block, signal: AbortSignal, settleMs = 250): Promise<void> {
  const pos = block.position
  let refused: number | null = null
  const onChange = (d: any) => {
    const l = d.location
    if (l && l.x === pos.x && l.y === pos.y && l.z === pos.z && d.type !== 0 && bot.registry.blocksByStateId[d.type]?.name !== 'air') refused = d.type
  }
  bot._client.on('block_change', onChange)
  try {
    checkAborted(signal)
    const onAbort = () => bot.stopDigging()
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      await bot.dig(block, true)
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
    checkAborted(signal)
    await sleep(settleMs, signal)
  } finally {
    bot._client.removeListener('block_change', onChange)
  }
  if (refused !== null) {
    try { (bot.world as any).setBlockStateId(pos, refused) } catch {}
    throw new DigRefusedError(block.name)
  }
}
