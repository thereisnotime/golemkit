import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import { defineSkill, defineAction, z, noParams, ok, fail, goals, playerEntity, nearestHostile, isHostile, FLYING, sleep, checkAborted } from '../core/index.ts'
import { pickupNearby } from './pickup.ts'
import { equipForTarget, hasRanged, shootAt, blockWithShield, isRangedMob, weaponFlags, type WeaponFlags } from './weapons.ts'

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

/**
 * Walks up to the target and swings until it dies, escapes or the signal aborts. With
 * adaptive weapons (default) it re-picks the best item for this target before each swing,
 * shoots flyers and out-of-reach targets when it has a bow and arrows, and blocks ranged mobs
 * with a shield between swings. Flags: settings.combat (live via !config_set combat.*).
 */
export async function fight (bot: Bot, target: Entity, signal: AbortSignal, maxMs = 20000, flags: WeaponFlags = { adaptive: true, ranged: true, shield: true }): Promise<boolean> {
  await equipForTarget(bot, target, flags)
  const start = Date.now()
  // Flyers (phantoms...) can't be chased on foot: hold position, track them and swing when
  // they dive into reach. Ground mobs: follow and hit.
  const flying = FLYING.has(target.name ?? '')
  if (!flying) {
    const mv = (bot.pathfinder as any).movements
    if (mv) mv.allowSprinting = true
    bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true)
  }
  try {
    while ((target as any).isValid !== false && Date.now() - start < maxMs) {
      checkAborted(signal)
      const dist = bot.entity.position.distanceTo(target.position)
      // A creeper whose fuse is lit (it swells, ~1.5 s): get away now, finish it after the fizzle.
      if (target.name === 'creeper' && creeperFuseLit(target) && dist < 5) {
        bot.pathfinder.setGoal(new goals.GoalInvert(new goals.GoalFollow(target, 7)), true)
        await sleep(1500, signal)
        bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true)
        continue
      }
      if (dist > (flying ? 40 : 24)) return false
      if (flying) await bot.lookAt(target.position.offset(0, target.height * 0.5, 0), true).catch(() => {})
      if (dist <= REACH + (flying ? 0.5 : 0)) {
        await equipForTarget(bot, target, flags) // health changes: re-pick (finisher, shield...)
        if (!flying) await bot.lookAt(target.position.offset(0, target.height * 0.8, 0), true)
        bot.attack(target)
        if (target.name === 'creeper') {
          // Hit and step back: the knockback plus distance keeps us out of the blast; never stand next to it.
          bot.pathfinder.setGoal(null)
          bot.setControlState('back', true)
          bot.setControlState('sprint', true)
          await sleep(700, signal).finally(() => { bot.setControlState('back', false); bot.setControlState('sprint', false) })
          bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true)
          continue
        }
        await sleep(600, signal) // full sword cooldown
      } else if (flags.ranged && hasRanged(bot) && (flying || dist > 6) && dist < 32) {
        await shootAt(bot, target, signal) // flyers and targets out of reach: shoot
      } else if (flags.shield && isRangedMob(target.name) && dist > REACH) {
        await blockWithShield(bot, 600) // skeleton aiming at us while we close in
      } else {
        await sleep(flying ? 100 : 300, signal) // flyers dive fast: check often
      }
    }
    return (target as any).isValid === false
  } finally {
    bot.pathfinder.setGoal(null)
  }
}

/** Creeper fuse state: metadata "swell direction" is 1 while it is about to explode. */
function creeperFuseLit (e: Entity): boolean {
  const md = (e as any).metadata as unknown[] | undefined
  return !!md && (md[16] === 1 || md[18] === true) // 1.21 creeper: 16 = state (-1 idle, 1 fusing), 17 = charged, 18 = ignited (flint and steel)
}

const attack = defineAction({
  name: 'attack',
  description: 'Fight the nearest hostile mob, or a specific entity by id.',
  params: z.object({
    entityId: z.number().optional().describe('entity id; default nearest hostile mob'),
    radius: z.number().default(16)
  }),
  async run ({ bot, agent, signal }, { entityId, radius }) {
    const target = entityId !== undefined ? bot.entities[entityId] : nearestHostile(bot, bot.entity.position, radius)
    if (!target) return fail('no target nearby')
    const killed = await fight(bot, target, signal, 20000, weaponFlags(agent))
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
  async run ({ bot, agent, signal }) {
    // Flyers hit and climb away, so look further for them.
    // Flyers hit and climb away, and archers (skeletons...) shoot from ~16 blocks: look further for them.
    const mob = nearestHostile(bot, bot.entity.position, 6) ??
      bot.nearestEntity(e => isHostile(e) && FLYING.has(e.name ?? '') && e.position.distanceTo(bot.entity.position) < 20) ??
      bot.nearestEntity(e => isHostile(e) && isRangedMob(e.name) && e.position.distanceTo(bot.entity.position) < 24)
    if (!mob) return fail('nothing to fight')
    // Archers back off while shooting: chase them longer (and sprint) instead of giving up after 10 s.
    const long = FLYING.has(mob.name ?? '') || isRangedMob(mob.name)
    await fight(bot, mob, signal, long ? 25000 : 10000, weaponFlags(agent))
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

/** Passive animals the bot may hunt for food. Pets, horses, villagers etc. are never on it. */
export const HUNTABLE = ['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom'] as const

/** The parts of an entity the hunt filter looks at (a mineflayer Entity has all of them). */
export interface HuntCandidate {
  id: number
  name?: string
  type?: string
  username?: string
  metadata?: unknown[]
  /** mineflayer stores a leash holder (attach_entity) here. */
  vehicle?: unknown
}

function meta (e: HuntCandidate, keys: string[] | undefined, key: string, fallback: number): unknown {
  const i = keys?.indexOf(key) ?? -1
  return e.metadata?.[i >= 0 ? i : fallback]
}

/**
 * Why an entity must not be hunted, or null when it may. Only listed passive animals; never
 * players, villagers, pets (anything with an owner or the tamed flag), named (name tag) or
 * leashed animals, and babies (they drop nothing).
 */
export function huntRefusal (e: HuntCandidate, opts: { animals?: readonly string[], metadataKeys?: string[], babies?: boolean } = {}): string | null {
  const animals = opts.animals ?? HUNTABLE
  if (e.type === 'player' || e.username) return 'player'
  const name = e.name ?? ''
  if (!animals.includes(name) || !(HUNTABLE as readonly string[]).includes(name)) return 'not a huntable animal'
  if (e.type && e.type !== 'animal') return 'not an animal'
  const keys = opts.metadataKeys
  const customName = meta(e, keys, 'custom_name', 2)
  if (customName !== undefined && customName !== null && customName !== '') return 'named'
  if (e.vehicle) return 'leashed'
  const owner = meta(e, keys, 'owneruuid', -1)
  if (owner) return 'tamed'
  const flags = keys?.includes('flags') ? meta(e, keys, 'flags', -1) : undefined
  if (typeof flags === 'number' && (flags & 0x04)) return 'tamed'
  if (!opts.babies && meta(e, keys, 'baby', 16) === true) return 'baby'
  return null
}

/** True if a fence or fence gate is within `r` blocks: animals there are probably someone's farm. */
export function inPen (bot: Bot, e: Entity, r = 3): boolean {
  const base = e.position.floored()
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        const b = bot.blockAt(base.offset(dx, dy, dz))
        if (b && /(_fence|_fence_gate|_wall)$/.test(b.name)) return true
      }
    }
  }
  return false
}

const hunt = defineAction({
  name: 'hunt',
  description: 'Hunt passive animals (cow, pig, sheep, chicken, rabbit, mooshroom) for food and pick up the drops. ' +
    'Never touches pets, named, tamed or leashed animals, babies, villagers or players, and by default leaves fenced animals alone.',
  params: z.object({
    animal: z.enum(HUNTABLE).optional().describe('which animal; default the nearest huntable one'),
    count: z.number().int().min(1).max(8).default(1).describe('how many to kill'),
    radius: z.number().min(4).max(64).default(24).describe('how far to look, in blocks'),
    pens: z.boolean().default(false).describe('also hunt animals inside fences (only your own farm)')
  }),
  async run ({ bot, agent, signal, log }, { animal, count, radius, pens }) {
    const animals = animal ? [animal] : HUNTABLE
    const skipped = new Set<number>()
    const total = () => bot.inventory.items().reduce((n, i) => n + i.count, 0)
    const before = total()
    let killed = 0
    const names: string[] = []
    while (killed < count) {
      checkAborted(signal)
      const target = bot.nearestEntity(e => {
        if (skipped.has(e.id) || e.position.distanceTo(bot.entity.position) > radius) return false
        const keys = (bot.registry as any).entitiesByName?.[e.name ?? '']?.metadataKeys as string[] | undefined
        if (huntRefusal(e as HuntCandidate, { animals, metadataKeys: keys })) return false
        if (agent.protectedAreas.isProtected(e.position)) return false
        return pens || !inPen(bot, e)
      })
      if (!target) break
      log.debug('hunting', { animal: target.name, id: target.id })
      const dead = await fight(bot, target, signal, 25_000)
      if (!dead) { skipped.add(target.id); continue }
      killed++
      names.push(target.name ?? 'animal')
      await sleep(400, signal)
      await pickupNearby(bot, signal, { radius: 6, maxMs: 8000 })
    }
    if (!killed) return fail(`no animal I may hunt within ${radius} blocks${animal ? ` (${animal})` : ''}`)
    await sleep(500, signal) // drops can arrive a moment after the last pickup walk
    const picked = Math.max(0, total() - before)
    const tally = [...new Set(names)].map(n => `${names.filter(x => x === n).length} ${n}`).join(', ')
    return ok(`hunted ${tally}, picked up ${picked} item${picked === 1 ? '' : 's'}`)
  }
})

export const combat = () => defineSkill({
  name: 'combat',
  description: 'Fighting hostile mobs, guarding players and hunting animals for food.',
  actions: [attack, guard, defend, retreat, hunt],
  observe: (_agent, bot) => {
    const mob = nearestHostile(bot, bot.entity.position, 16)
    return { nearestHostile: mob ? { name: mob.name, distance: Math.round(mob.position.distanceTo(bot.entity.position)) } : null }
  }
})
