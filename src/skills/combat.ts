import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import { defineSkill, defineAction, z, noParams, ok, fail, goals, playerEntity, nearestHostile, sleep, checkAborted } from '../core/index.ts'

const REACH = 3.2
const WEAPONS = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword',
  'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe']

export async function equipBestWeapon (bot: Bot): Promise<void> {
  for (const name of WEAPONS) {
    const item = bot.inventory.items().find(i => i.name === name)
    if (item) {
      if (bot.heldItem?.name !== name) await bot.equip(item, 'hand').catch(() => {})
      return
    }
  }
}

/** Walks up to the target and swings until it dies, escapes or the signal aborts. */
export async function fight (bot: Bot, target: Entity, signal: AbortSignal, maxMs = 20000): Promise<boolean> {
  await equipBestWeapon(bot)
  const start = Date.now()
  bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true)
  try {
    while ((target as any).isValid !== false && Date.now() - start < maxMs) {
      checkAborted(signal)
      const dist = bot.entity.position.distanceTo(target.position)
      if (dist > 24) return false
      if (dist <= REACH) {
        await bot.lookAt(target.position.offset(0, target.height * 0.8, 0), true)
        bot.attack(target)
      }
      await sleep(600, signal) // full sword cooldown
    }
    return (target as any).isValid === false
  } finally {
    bot.pathfinder.setGoal(null)
  }
}

const attack = defineAction({
  name: 'attack',
  description: 'Fight the nearest hostile mob, or a specific entity by id.',
  params: z.object({
    entityId: z.number().optional().describe('entity id; default nearest hostile mob'),
    radius: z.number().default(16)
  }),
  async run ({ bot, signal }, { entityId, radius }) {
    const target = entityId !== undefined ? bot.entities[entityId] : nearestHostile(bot, bot.entity.position, radius)
    if (!target) return fail('no target nearby')
    const killed = await fight(bot, target, signal)
    return killed ? ok(`killed ${target.name}`) : ok(`stopped fighting ${target.name}`)
  }
})

const guard = defineAction({
  name: 'guard',
  description: 'Stay near a player and kill hostile mobs that come close to them, until stopped.',
  params: z.object({
    player: z.string().optional().describe('player to protect; defaults to the requesting player'),
    radius: z.number().default(12)
  }),
  longRunning: true,
  async run ({ bot, signal, player: caller }, { player, radius }) {
    const who = player ?? caller
    if (!who) return fail('guard whom?')
    while (!signal.aborted) {
      const owner = playerEntity(bot, who)
      const center = owner?.position ?? bot.entity.position
      const mob = nearestHostile(bot, center, radius)
      if (mob) {
        await fight(bot, mob, signal)
      } else if (owner && bot.entity.position.distanceTo(owner.position) > 4) {
        bot.pathfinder.setGoal(new goals.GoalFollow(owner, 3), true)
      }
      await sleep(500, signal).catch(() => {})
    }
    bot.pathfinder.setGoal(null)
    return ok(`stopped guarding ${who}`)
  }
})

const defend = defineAction({
  name: 'defend',
  description: 'Fight back against whatever hostile mob is closest (used by reflexes).',
  params: noParams,
  internal: true,
  async run ({ bot, signal }) {
    const mob = nearestHostile(bot, bot.entity.position, 6)
    if (!mob) return fail('nothing to fight')
    await fight(bot, mob, signal, 10000)
    return ok(`fought ${mob.name}`)
  }
})

const retreat = defineAction({
  name: 'retreat',
  description: 'Back off from nearby hostile mobs (used by reflexes at low health).',
  params: z.object({ distance: z.number().min(6).max(32).default(18) }),
  internal: true,
  async run ({ bot, signal }, { distance }) {
    const mob = nearestHostile(bot, bot.entity.position, distance)
    if (!mob) return ok('nothing to back off from')
    bot.pathfinder.setGoal(new goals.GoalInvert(new goals.GoalFollow(mob, distance)), true)
    try {
      const until = Date.now() + 12_000
      while (Date.now() < until) {
        checkAborted(signal)
        if (!(mob as any).isValid || bot.entity.position.distanceTo(mob.position) >= distance) break
        await sleep(400, signal)
      }
    } finally {
      bot.pathfinder.setGoal(null)
    }
    const d = Math.round(bot.entity.position.distanceTo(mob.position))
    return d >= distance - 2 ? ok(`backed off from ${mob.name}`) : fail(`couldn't get away from ${mob.name} (${d} blocks)`)
  }
})

export const combat = () => defineSkill({
  name: 'combat',
  description: 'Fighting hostile mobs and guarding players.',
  actions: [attack, guard, defend, retreat],
  observe: (_agent, bot) => {
    const mob = nearestHostile(bot, bot.entity.position, 16)
    return { nearestHostile: mob ? { name: mob.name, distance: Math.round(mob.position.distanceTo(bot.entity.position)) } : null }
  }
})
