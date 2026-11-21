// Creative mode: items come straight from the creative inventory instead of being chopped,
// mined or crafted, and the bot can fly to where it needs to stand. Survival never gets here.
import type { Bot } from 'mineflayer'
import type { Vec3 } from 'vec3'
import { createRequire } from 'node:module'
import { checkAborted } from '../core/index.ts'

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

/**
 * Puts the given items into empty inventory slots from the creative inventory. Returns how
 * many items it took and the names it doesn't know.
 */
export async function takeFromCreative (bot: Bot, signal: AbortSignal, take: Record<string, number>): Promise<{ taken: number, unknown: string[] }> {
  const Item = itemClass(bot)
  const unknown: string[] = []
  let taken = 0
  for (const [name, count] of Object.entries(take)) {
    const def = bot.registry.itemsByName[name]
    if (!def) { unknown.push(name); continue }
    let left = count
    while (left > 0) {
      checkAborted(signal)
      // inventory slots 9..44 (main and hotbar); keep away from armour and the crafting grid
      const slot = bot.inventory.slots.findIndex((s, i) => i >= 9 && i <= 44 && !s)
      if (slot < 0) return { taken, unknown }
      const n = Math.min(left, def.stackSize || 64)
      await bot.creative.setInventorySlot(slot, new Item(def.id, n) as never)
      taken += n
      left -= n
    }
  }
  return { taken, unknown }
}

/** Flies to a point (creative only); false when it didn't get there. */
export async function flyNear (bot: Bot, dest: Vec3, signal: AbortSignal): Promise<boolean> {
  checkAborted(signal)
  try {
    await bot.creative.flyTo(dest)
    return bot.entity.position.distanceTo(dest) < 1.5
  } catch {
    return false
  }
}
