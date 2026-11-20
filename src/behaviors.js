// Ongoing behaviours: guard mode, self-defence, eating.
import pf from 'mineflayer-pathfinder'

const { goals } = pf
const REACH = 3.2

export function isHostile (e) {
  return e && e.type === 'hostile' && e.isValid !== false
}

export function nearestHostile (bot, from, radius) {
  return bot.nearestEntity(e => isHostile(e) && e.position.distanceTo(from) <= radius)
}

/**
 * Attacks a target: walks up to it and swings until it's gone or out of range.
 * Resolves when the fight ends.
 */
export async function fight (bot, target, { maxMs = 20000 } = {}) {
  const start = Date.now()
  bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true)
  try {
    while (target.isValid && Date.now() - start < maxMs) {
      const dist = bot.entity.position.distanceTo(target.position)
      if (dist > 24) break
      if (dist <= REACH) {
        await bot.lookAt(target.position.offset(0, target.height * 0.8, 0), true)
        bot.attack(target)
      }
      await bot.waitForTicks(12) // ~1.6 attacks/s, full sword cooldown is ~0.6s
    }
  } finally {
    bot.pathfinder.setGoal(null)
  }
}

export async function equipBestWeapon (bot) {
  const order = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword',
    'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe']
  for (const name of order) {
    const item = bot.inventory.items().find(i => i.name === name)
    if (item) {
      if (bot.heldItem?.name !== name) await bot.equip(item, 'hand').catch(() => {})
      return item
    }
  }
  return null
}

/** Eats the best vanilla food in the inventory when hungry (or always, with force). */
export async function eatIfHungry (bot, { force = false } = {}) {
  if (bot._buddyEating || bot.food >= 20 || (!force && bot.food >= 15)) return false
  const foods = bot.registry.foodsByName || {}
  const food = bot.inventory.items()
    .filter(i => foods[i.name] && !['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'suspicious_stew'].includes(i.name))
    .sort((a, b) => (foods[b.name].foodPoints || 0) - (foods[a.name].foodPoints || 0))[0]
  if (!food) return false
  bot._buddyEating = true
  try {
    await bot.equip(food, 'hand')
    await bot.consume()
    return true
  } catch {
    return false
  } finally {
    bot._buddyEating = false
  }
}
