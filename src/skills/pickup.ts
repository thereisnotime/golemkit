import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import { defineSkill, defineAction, z, ok, fail, goals, sleep, checkAborted, itemName, fmtPos, headInWater, oxygen, TravelUnderwaterError } from '../core/index.ts'
import { gotoWithin } from './world.ts'
import { pickupSettings, newPickupMemory, recordAirBreak, dropUnreachable, prunePickupMemory, isAirBreak, PICKUP_DEFAULTS, type PickupMemory, type PickupSettings } from './pickupPlan.ts'

/** Name of the item a dropped-item entity carries, or null if unknown. */
export function droppedItemName (e: Entity): string | null {
  try {
    const it = e.getDroppedItem()
    return it ? itemName(it) : null
  } catch {
    return null
  }
}

// ---- drops it gave up on (too many air breaks going for them; pickupPlan.ts) ----

interface PickupBinding { settings: () => PickupSettings, log: (m: string) => void }
const memories = new WeakMap<object, PickupMemory>()
const bindings = new WeakMap<object, PickupBinding>()
const agentMemories = new WeakMap<object, PickupMemory>()

const memoryOf = (bot: Bot): PickupMemory => {
  let m = memories.get(bot)
  if (!m) { m = newPickupMemory(); memories.set(bot, m) }
  return m
}
const settingsOf = (bot: Bot): PickupSettings => bindings.get(bot)?.settings() ?? PICKUP_DEFAULTS

/**
 * A dropped item it gave up on: going for it ran out of air pickup.maxAirBreaks times, and
 * pickup.unreachableMinutes haven't passed since. pickup_items and the collect behaviours skip it.
 */
export function unreachableDrop (bot: Bot, e: Entity, now = Date.now()): boolean {
  const m = memories.get(bot)
  return !!m && m.records.length > 0 && dropUnreachable(m, { id: e.id, pos: e.position }, now, settingsOf(bot))
}

/** Dropped items within radius (optionally only `item`) that aren't given up on. */
export function reachableDropsNear (bot: Bot, radius: number, item?: string): Entity[] {
  if (!bot.entity) return []
  const now = Date.now()
  return Object.values(bot.entities ?? {}).filter(e =>
    e.name === 'item' && e.position && e.position.distanceTo(bot.entity.position) <= radius &&
    (!item || droppedItemName(e) === item) && !unreachableDrop(bot, e, now))
}

function noteAirBreak (bot: Bot, drop: Entity): void {
  const s = settingsOf(bot)
  const r = recordAirBreak(memoryOf(bot), { id: drop.id, pos: drop.position }, Date.now(), s)
  if (r.gaveUp) {
    const what = droppedItemName(drop) ?? 'item'
    bindings.get(bot)?.log(`giving up on the ${what} drop at ${fmtPos(drop.position)}: ran out of air ${r.breaks} times going for it; skipping drops there for ${s.unreachableMinutes} min`)
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
    const now = Date.now()
    const drop = bot.nearestEntity(e =>
      e.name === 'item' && !skipped.has(e.id) &&
      e.position.distanceTo(bot.entity.position) <= radius &&
      (!opts.item || droppedItemName(e) === opts.item) &&
      !unreachableDrop(bot, e, now))
    if (!drop) break
    try {
      const p = drop.position
      await gotoWithin(bot, new goals.GoalNear(p.x, p.y, p.z, 0.5), signal, Math.max(1000, Math.min(15_000, deadline - Date.now())))
      await sleep(250, signal) // give the server a moment to hand the item over
    } catch (e) {
      // cut short by air (the air reflex took over under water, or travel kept running out of air): count it against the drop
      if (isAirBreak({ underwaterError: e instanceof TravelUnderwaterError, aborted: signal.aborted, headInWater: headInWater(bot), oxygen: oxygen(bot) })) noteAirBreak(bot, drop)
      checkAborted(signal)
    }
    if ((drop as any).isValid !== false && bot.entities[drop.id]) skipped.add(drop.id)
  }
  return Math.max(0, inventoryTotal(bot) - before)
}

const pickupItems = defineAction({
  name: 'pickup_items',
  description: 'Walk over dropped items lying nearby to pick them up. Skips drops it kept running out of air going for (deep water).',
  params: z.object({
    radius: z.number().min(1).max(32).default(12).describe('how far to look for drops, in blocks'),
    item: z.string().optional().describe('only pick up this item, e.g. oak_log; default everything')
  }),
  aliases: ['pickup'],
  async run ({ bot, signal }, { radius, item }) {
    const any = bot.nearestEntity(e => e.name === 'item' && e.position.distanceTo(bot.entity.position) <= radius)
    if (!any) return fail('no dropped items nearby')
    if (!reachableDropsNear(bot, radius, item).length) return fail('the dropped items nearby are under water out of reach (ran out of air going for them)')
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
  setup (agent, client) {
    const bot = client as Bot
    const log = agent.log.child('pickup')
    bindings.set(bot, { settings: () => pickupSettings((agent.settings as { pickup?: unknown } | undefined)?.pickup), log: m => log.info(m) })
    // the memory lives with the agent across reconnects; entity ids start over, so only the positions carry over
    let m = agentMemories.get(agent)
    if (!m) { m = newPickupMemory(); agentMemories.set(agent, m) }
    prunePickupMemory(m, Date.now(), settingsOf(bot))
    for (const r of m.records) r.ids = []
    memories.set(bot, m)
  },
  observe: (_agent, bot) => ({
    droppedItemsNearby: reachableDropsNear(bot as Bot, 12).length
  })
})
