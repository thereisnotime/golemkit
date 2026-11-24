// Armour and offhand. Until now bots crafted iron armour (keep_tools_upgraded armour: true) and
// never put it on. equipGear() wears the best armour in the inventory and puts a totem or a
// shield in the offhand; the reflexes brain runs it (gear_up) whenever there is an upgrade
// (combat.autoArmor, default on).
import type { Bot } from 'mineflayer'
import { defineAction, z, ok, fail } from '../core/index.ts'
import { pickArmor, pickOffhand, armorScore, type ArmorSlot, type ArmorItem } from './tactics.ts'

const SLOT_INDEX: Record<ArmorSlot, number> = { head: 5, torso: 6, legs: 7, feet: 8 }
const OFFHAND = 45

function asArmor (it: any): ArmorItem & { item: any } {
  const max = it.maxDurability
  return { name: it.name, enchants: it.enchants ?? [], durabilityLeft: max ? max - (it.durabilityUsed ?? 0) : undefined, item: it }
}

export interface GearPlan { armor: Partial<Record<ArmorSlot, string>>, offhand: string | null }

/** What equipGear would change right now (empty = nothing to do). */
export function gearPlan (bot: Bot, opts: { danger?: boolean } = {}): GearPlan {
  const worn: Partial<Record<ArmorSlot, ArmorItem | null>> = {}
  for (const [slot, i] of Object.entries(SLOT_INDEX) as [ArmorSlot, number][]) {
    const w = bot.inventory.slots[i]
    worn[slot] = w ? asArmor(w) : null
  }
  const inv = bot.inventory.items().filter(i => armorScore({ name: i.name })).map(asArmor)
  const picks = pickArmor(inv, worn)
  const armor: Partial<Record<ArmorSlot, string>> = {}
  for (const [slot, it] of Object.entries(picks) as [ArmorSlot, ArmorItem][]) armor[slot] = it.name
  const items = bot.inventory.items()
  const off = bot.inventory.slots[OFFHAND]?.name
  const want = pickOffhand({
    hasTotem: off === 'totem_of_undying' || items.some(i => i.name === 'totem_of_undying'),
    hasShield: off === 'shield' || items.some(i => i.name === 'shield'),
    health: bot.health,
    current: off ?? null,
    danger: opts.danger
  })
  return { armor, offhand: want && want !== off ? want : null }
}

export const hasGearUpgrade = (p: GearPlan) => Object.keys(p.armor).length > 0 || p.offhand !== null

/** Wears the best armour and fills the offhand. Returns what changed. */
export async function equipGear (bot: Bot, opts: { danger?: boolean } = {}): Promise<string[]> {
  const plan = gearPlan(bot, opts)
  const done: string[] = []
  for (const [slot, name] of Object.entries(plan.armor) as [ArmorSlot, string][]) {
    // re-find: the inventory may have moved since the plan was made
    const it = bot.inventory.items().find(i => i.name === name)
    if (!it) continue
    try { await bot.equip(it, slot); done.push(name) } catch {}
  }
  if (plan.offhand) {
    const it = bot.inventory.items().find(i => i.name === plan.offhand)
    if (it) { try { await bot.equip(it, 'off-hand'); done.push(`${plan.offhand} (offhand)`) } catch {} }
  }
  return done
}

/** Armour points worn (vanilla values), for observe and the night check. */
export function wornArmorPoints (bot: Bot): number {
  let n = 0
  for (const i of Object.values(SLOT_INDEX)) {
    const w = bot.inventory.slots[i]
    if (w) n += Math.floor(armorScore({ name: w.name })?.score ?? 0)
  }
  return n
}

export const gearUp = defineAction({
  name: 'gear_up',
  capabilities: ['inventory'],
  description: 'Put on the best armour in the inventory and put a totem of undying or a shield in the offhand.',
  params: z.object({ danger: z.boolean().optional().describe('a fall or fire that could kill: the totem goes in the offhand whatever the health') }),
  // Moves items between inventory slots only; runs beside the current action, but never while a
  // container or crafting window is open (its slot numbers differ).
  exclusive: false,
  async run ({ bot }, { danger }) {
    if (bot.currentWindow) return fail('a container window is open; try again when it is closed')
    if (!hasGearUpgrade(gearPlan(bot, { danger }))) return ok(`already wearing the best I have (${wornArmorPoints(bot)} armour points)`)
    const done = await equipGear(bot, { danger })
    return done.length ? ok(`equipped ${done.join(', ')} (${wornArmorPoints(bot)} armour points)`) : fail('could not equip anything')
  }
})

/** Items carried, worn and in the offhand, by name. */
export function heldCounts (bot: Bot): Record<string, number> {
  const out: Record<string, number> = {}
  for (const i of bot.inventory?.items?.() ?? []) out[i.name] = (out[i.name] ?? 0) + i.count
  for (const i of [...Object.values(SLOT_INDEX), OFFHAND]) {
    const w = bot.inventory?.slots?.[i]
    if (w) out[w.name] = (out[w.name] ?? 0) + w.count
  }
  return out
}
