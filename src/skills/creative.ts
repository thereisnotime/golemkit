// Creative mode: items come straight from the creative inventory instead of being chopped,
// mined or crafted, and the bot can fly to where it needs to stand. Survival never gets here.
import type { Bot } from 'mineflayer'
import type { Vec3 } from 'vec3'
import { createRequire } from 'node:module'
import { checkAborted, sleep } from '../core/index.ts'

export function isCreative (bot: Bot): boolean {
  return bot.game?.gameMode === 'creative'
}

// prismarine-item is mineflayer's own dependency: load the copy mineflayer uses.
const requireHere = createRequire(import.meta.url)
let itemLoader: ((registry: unknown) => new (type: number, count: number) => unknown) | null = null
function itemClass (bot: Bot): new (type: number, count: number) => unknown {
  if (!itemLoader) itemLoader = createRequire(requireHere.resolve('mineflayer'))('prismarine-item')
  return itemLoader!(bot.registry)
}

/** How long the server gets to confirm one creative slot before we stop asking. */
const SLOT_TIMEOUT_MS = 6000

/**
 * Puts the given items into empty inventory slots from the creative inventory. Returns how
 * many items actually arrived (read back from the inventory) and the names it doesn't know.
 * A server that doesn't answer stops it after a few seconds instead of hanging the caller.
 */
export async function takeFromCreative (bot: Bot, signal: AbortSignal, take: Record<string, number>, slotTimeoutMs = SLOT_TIMEOUT_MS): Promise<{ taken: number, unknown: string[], error?: string }> {
  const Item = itemClass(bot)
  const unknown: string[] = []
  const filled: { slot: number, id: number, n: number }[] = []
  let error: string | undefined
  outer: for (const [name, count] of Object.entries(take)) {
    const def = bot.registry.itemsByName[name]
    if (!def) { unknown.push(name); continue }
    let left = count
    while (left > 0) {
      checkAborted(signal)
      // inventory slots 9..44 (main and hotbar); keep away from armour and the crafting grid
      const slot = bot.inventory.slots.findIndex((s, i) => i >= 9 && i <= 44 && !s && !filled.some(f => f.slot === i))
      if (slot < 0) break outer
      const n = Math.min(left, def.stackSize || 64)
      let timer: NodeJS.Timeout | undefined
      try {
        await Promise.race([
          bot.creative.setInventorySlot(slot, new Item(def.id, n) as never),
          new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`the server didn't confirm creative slot ${slot}`)), slotTimeoutMs) })
        ])
      } catch (e) {
        error = (e as Error).message
        break outer
      } finally {
        clearTimeout(timer)
      }
      filled.push({ slot, id: def.id, n })
      left -= n
    }
  }
  // count what is really there (a server can refuse a slot without saying so)
  const taken = filled.reduce((sum, f) => sum + (bot.inventory.slots[f.slot]?.type === f.id ? (bot.inventory.slots[f.slot]?.count ?? 0) : 0), 0)
  return { taken, unknown, ...(error ? { error } : {}) }
}

/** Blocks per physics tick when flying (mineflayer's own flyTo speed). */
const FLY_STEP = 0.5

/** Feet and head cells at a point are free to fly through (unloaded counts as not free). */
function flyable (bot: Bot, p: Vec3): boolean {
  for (const dy of [0, 1]) {
    const b = bot.blockAt(p.offset(0, dy, 0).floored())
    if (!b || b.boundingBox !== 'empty') return false
  }
  return true
}

/** One straight leg of a flight; false when something solid is in the way or time runs out. */
async function flyLeg (bot: Bot, to: Vec3, signal: AbortSignal, deadline: number): Promise<boolean> {
  while (true) {
    checkAborted(signal)
    const pos = bot.entity.position
    const v = to.minus(pos)
    const m = Math.hypot(v.x, v.y, v.z)
    const next = m <= FLY_STEP ? to.clone() : pos.plus(v.scaled(FLY_STEP / m))
    if (!flyable(bot, next) || Date.now() > deadline) return false
    bot.physics.gravity = 0
    bot.entity.velocity.set(0, 0, 0)
    bot.entity.position = next
    if (m <= FLY_STEP) return true
    await sleep(50, signal)
  }
}

/**
 * Flies to a point (creative only); false when it didn't get there. Goes up first, across, then
 * down, never into a block, and gives up after a time limit: mineflayer's creative.flyTo flies
 * straight through terrain (the server pulls the bot back) and then waits for a 'move' event
 * without a timeout, which hung a creative build for minutes.
 */
export async function flyNear (bot: Bot, dest: Vec3, signal: AbortSignal): Promise<boolean> {
  checkAborted(signal)
  const start = bot.entity.position.clone()
  const flat = Math.hypot(dest.x - start.x, dest.z - start.z)
  const deadline = Date.now() + Math.min(30_000, 3000 + start.distanceTo(dest) * 250)
  try { bot.creative?.startFlying?.() } catch {}
  const high = Math.max(start.y, dest.y) + (flat > 3 ? 2 : 0)
  const legs = flat > 3
    ? [start.clone().set(start.x, high, start.z), dest.clone().set(dest.x, high, dest.z), dest.clone()]
    : [dest.clone()]
  for (const leg of legs) {
    if (!await flyLeg(bot, leg, signal, deadline)) break
  }
  await sleep(100, signal) // a physics tick to send the position
  return bot.entity.position.distanceTo(dest) < 1.5
}
