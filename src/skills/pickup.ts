import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import { defineSkill, defineAction, z, ok, fail, goals, sleep, checkAborted, itemName } from '../core/index.ts'
import { gotoWithin } from './world.ts'

/** Name of the item a dropped-item entity carries, or null if unknown. */
export function droppedItemName (e: Entity): string | null {
  try {
    const it = e.getDroppedItem()
    return it ? itemName(it) : null
  } catch {
    return null
  }
}

function inventoryTotal (bot: Bot): number {
  return bot.inventory.items().reduce((n, i) => n + i.count, 0)
}

/**
 * Walks to dropped items within radius until none are left (or maxMs passes). Returns how
 * many items ended up in the inventory. Unreachable drops are skipped.
 */
export async function pickupNearby (bot: Bot, signal: AbortSignal, opts: { radius?: number, item?: string, maxMs?: number } = {}): Promise<number> {
  const radius = opts.radius ?? 8
  const deadline = Date.now() + (opts.maxMs ?? 30_000)
  const before = inventoryTotal(bot)
  const skipped = new Set<number>()
  while (Date.now() < deadline) {
    checkAborted(signal)
    if (bot.inventory.emptySlotCount() === 0) break
    const drop = bot.nearestEntity(e =>
      e.name === 'item' && !skipped.has(e.id) &&
      e.position.distanceTo(bot.entity.position) <= radius &&
      (!opts.item || droppedItemName(e) === opts.item))
    if (!drop) break
    try {
      const p = drop.position
      await gotoWithin(bot, new goals.GoalNear(p.x, p.y, p.z, 0.5), signal, Math.max(1000, Math.min(15_000, deadline - Date.now())))
      await sleep(250, signal) // give the server a moment to hand the item over
    } catch (e) {
      checkAborted(signal)
    }
    if ((drop as any).isValid !== false && bot.entities[drop.id]) skipped.add(drop.id)
  }
  return Math.max(0, inventoryTotal(bot) - before)
}

const pickupItems = defineAction({
  name: 'pickup_items',
  description: 'Walk over dropped items lying nearby to pick them up.',
  params: z.object({
    radius: z.number().min(1).max(32).default(12).describe('how far to look for drops, in blocks'),
    item: z.string().optional().describe('only pick up this item, e.g. oak_log; default everything')
  }),
  aliases: ['pickup'],
  async run ({ bot, signal }, { radius, item }) {
    const any = bot.nearestEntity(e => e.name === 'item' && e.position.distanceTo(bot.entity.position) <= radius)
    if (!any) return fail('no dropped items nearby')
    if (bot.inventory.emptySlotCount() === 0) return fail('inventory is full')
    const got = await pickupNearby(bot, signal, { radius, item, maxMs: 60_000 })
    return got ? ok(`picked up ${got} item${got === 1 ? '' : 's'}`) : fail('could not reach the dropped items')
  }
})

export const pickup = () => defineSkill({
  name: 'pickup',
  capabilities: ['move', 'inventory'],
  description: 'Picking up dropped items.',
  actions: [pickupItems],
  observe: (_agent, bot) => ({
    droppedItemsNearby: Object.values(bot.entities)
      .filter(e => e.name === 'item' && e.position.distanceTo(bot.entity.position) <= 12).length
  })
})
