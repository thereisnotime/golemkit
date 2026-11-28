// Picks the most effective item for each attack (feature flags, live via !config_set):
//   combat.adaptiveWeapon  score melee weapons per target (damage x speed, enchantments,
//                          one-hit kills, axes vs shields); off = old fixed sword>axe order
//   combat.ranged          bow/crossbow for flyers and targets out of reach, if it has arrows
//   combat.shield          raise a shield against ranged mobs while not swinging
// and how fight() moves (combat.ts):
//   combat.crits           jump and hit while falling (x1.5), sprint into the first hit
//   combat.strafe          keep spacing and circle melee mobs between swings
//   combat.disengageToHeal back off to eat at <= 4 health when there is food, then re-engage
//   combat.maxChase        give up a chase this many blocks from where the fight started
import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import type { Agent } from '../core/index.ts'
import { aimArrow } from './tactics.ts'
import { dodgeSettings, type DodgeSettings } from './dodgePlan.ts'
import { retreatSettings, type RetreatSettings } from './retreatPlan.ts'
import { enchantsOf } from './enchants.ts'

/** Vanilla 1.21 attack damage and attacks per second. */
const MELEE: Record<string, { damage: number, speed: number }> = {
  wooden_sword: { damage: 4, speed: 1.6 }, golden_sword: { damage: 4, speed: 1.6 }, stone_sword: { damage: 5, speed: 1.6 },
  iron_sword: { damage: 6, speed: 1.6 }, diamond_sword: { damage: 7, speed: 1.6 }, netherite_sword: { damage: 8, speed: 1.6 },
  wooden_axe: { damage: 7, speed: 0.8 }, golden_axe: { damage: 7, speed: 1.0 }, stone_axe: { damage: 9, speed: 0.8 },
  iron_axe: { damage: 9, speed: 0.9 }, diamond_axe: { damage: 9, speed: 1.0 }, netherite_axe: { damage: 10, speed: 1.0 },
  trident: { damage: 9, speed: 1.1 }, mace: { damage: 6, speed: 0.6 },
  wooden_pickaxe: { damage: 2, speed: 1.2 }, stone_pickaxe: { damage: 3, speed: 1.2 }, iron_pickaxe: { damage: 4, speed: 1.2 },
  diamond_pickaxe: { damage: 5, speed: 1.2 }, netherite_pickaxe: { damage: 6, speed: 1.2 },
  wooden_shovel: { damage: 2.5, speed: 1 }, stone_shovel: { damage: 3.5, speed: 1 }, iron_shovel: { damage: 4.5, speed: 1 },
  diamond_shovel: { damage: 5.5, speed: 1 }, netherite_shovel: { damage: 6.5, speed: 1 }
}
const FIST = { damage: 1, speed: 4 }

/** Base attack damage of a held item (1 for a fist or anything that isn't a weapon). */
export function meleeDamage (item: string | null | undefined): number {
  const n = item ?? ''
  return MELEE[n]?.damage ?? (/_sword$/.test(n) ? 6 : /_axe$/.test(n) ? 8 : FIST.damage)
}

const UNDEAD = new Set(['zombie', 'zombie_villager', 'husk', 'drowned', 'skeleton', 'stray', 'wither_skeleton', 'bogged', 'phantom', 'zombified_piglin', 'zoglin', 'wither', 'skeleton_horse', 'zombie_horse'])
const ARTHROPOD = new Set(['spider', 'cave_spider', 'silverfish', 'endermite', 'bee'])
const RANGED_MOBS = new Set(['skeleton', 'stray', 'bogged', 'pillager', 'blaze', 'ghast', 'witch'])
// No mob blocks with a shield (vindicators and piglin brutes carry axes, which disable the bot's
// shield instead: techniques.SHIELD_BREAKERS). Only players do; equipForTarget checks them.
export const SHIELDED = new Set<string>()

export interface WeaponFlags {
  adaptive: boolean
  ranged: boolean
  shield: boolean
  /** Fight tactics; missing = on (maxChase 16). */
  crits?: boolean
  strafe?: boolean
  disengageToHeal?: boolean
  maxChase?: number
  /** Skilled-player techniques (techniques.ts); missing = on. */
  sprintReset?: boolean
  sweep?: boolean
  shieldMelee?: boolean
  goldenApple?: boolean
  /** combat.dodge.* (dodgePlan.ts); missing = the defaults (on). */
  dodge?: DodgeSettings
  /** settings.retreat (retreatPlan.ts); missing = the old fixed 4-health rule. */
  retreat?: RetreatSettings
}

export const DEFAULT_MAX_CHASE = 16

export function weaponFlags (agent: Agent): WeaponFlags {
  const c = (agent.settings.combat ?? {}) as Partial<{ adaptiveWeapon: boolean, ranged: boolean, shield: boolean, crits: boolean, strafe: boolean, disengageToHeal: boolean, maxChase: number, sprintReset: boolean, sweep: boolean, shieldMelee: boolean, goldenApple: boolean }>
  return {
    adaptive: c.adaptiveWeapon ?? true,
    ranged: c.ranged ?? true,
    shield: c.shield ?? true,
    crits: c.crits ?? true,
    strafe: c.strafe ?? true,
    disengageToHeal: c.disengageToHeal ?? true,
    maxChase: c.maxChase ?? DEFAULT_MAX_CHASE,
    sprintReset: c.sprintReset ?? true,
    sweep: c.sweep ?? true,
    shieldMelee: c.shieldMelee ?? true,
    goldenApple: c.goldenApple ?? true,
    dodge: dodgeSettings((c as { dodge?: unknown }).dodge),
    retreat: retreatSettings((agent.settings as { retreat?: unknown }).retreat)
  }
}

interface Candidate { name: string, damage: number, speed: number, enchants: { name: string, lvl: number }[] }

/**
 * Damage per hit of the best melee weapon among `items` (names), scaled down for slow weapons the
 * way pickMelee ranks them (an iron axe counts a little under an iron sword). 1 for bare hands.
 */
export function bestMeleeDamage (items: readonly string[]): number {
  let best = FIST.damage
  for (const n of items) {
    const w = MELEE[n]
    if (w) best = Math.max(best, w.damage * Math.min(w.speed, 1.6) / 1.6)
  }
  return Math.round(best * 10) / 10
}

/** Damage of one hit including target-specific enchantments. */
export function hitDamage (w: Candidate, target: string): number {
  let d = w.damage
  for (const e of w.enchants) {
    if (e.name === 'sharpness') d += 0.5 * e.lvl + 0.5
    else if (e.name === 'smite' && UNDEAD.has(target)) d += 2.5 * e.lvl
    else if (e.name === 'bane_of_arthropods' && ARTHROPOD.has(target)) d += 2.5 * e.lvl
  }
  return d
}

/**
 * Best melee weapon for a target (pure, unit-tested): highest damage per second, except take
 * the hardest single hit when one hit kills, and an axe against shield users.
 */
export function pickMelee (candidates: Candidate[], target: { name: string, health?: number, shielded?: boolean }): Candidate | null {
  if (!candidates.length) return null
  const dps = (c: Candidate) => hitDamage(c, target.name) * Math.min(c.speed, 1.6)
  if (target.shielded) {
    const axe = candidates.filter(c => c.name.endsWith('_axe')).sort((a, b) => hitDamage(b, target.name) - hitDamage(a, target.name))[0]
    if (axe) return axe
  }
  if (target.health !== undefined) {
    const finishers = candidates.filter(c => hitDamage(c, target.name) >= target.health!)
    if (finishers.length) return finishers.sort((a, b) => b.speed - a.speed)[0]! // fastest of those that kill in one hit
  }
  return candidates.slice().sort((a, b) => dps(b) - dps(a))[0]!
}

function candidates (bot: Bot): (Candidate & { item: any })[] {
  return bot.inventory.items().flatMap(item => {
    const stats = MELEE[item.name] ?? (/_sword$/.test(item.name) ? { damage: 6, speed: 1.6 } : /_axe$/.test(item.name) ? { damage: 8, speed: 0.9 } : null)
    if (!stats) return []
    const enchants = enchantsOf(item)
    return [{ name: item.name, ...stats, enchants, item }]
  })
}

const FIXED_ORDER = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword',
  'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe']

/** Equips the best melee weapon for this target (or the old fixed order when adaptive is off). */
export async function equipForTarget (bot: Bot, target: Entity | null, flags: WeaponFlags): Promise<string | null> {
  let choice: (Candidate & { item: any }) | null | undefined
  const all = candidates(bot)
  if (!flags.adaptive || !target) {
    choice = FIXED_ORDER.map(n => all.find(c => c.name === n)).find(Boolean)
  } else {
    const health = (target as any).health ?? (target.metadata?.[9] as unknown as number | undefined)
    const shielded = SHIELDED.has(target.name ?? '') || (target.type === 'player' && (target as any).equipment?.some((e: any) => e?.name === 'shield'))
    choice = pickMelee(all, { name: target.name ?? '', health: typeof health === 'number' ? health : undefined, shielded }) as any
  }
  if (!choice) return null
  if (bot.heldItem?.name !== choice.name) await bot.equip(choice.item, 'hand').catch(() => {})
  return choice.name
}

export function hasRanged (bot: Bot): { weapon: any, kind: 'bow' | 'crossbow' } | null {
  const arrows = bot.inventory.items().some(i => /arrow$/.test(i.name))
  if (!arrows) return null
  const cross = bot.inventory.items().find(i => i.name === 'crossbow')
  if (cross) return { weapon: cross, kind: 'crossbow' }
  const bow = bot.inventory.items().find(i => i.name === 'bow')
  return bow ? { weapon: bow, kind: 'bow' } : null
}

/**
 * Fires one arrow at the target. Aims with arrow physics (gravity, drag) and leads by the
 * target's velocity, measured from its movement while the bow draws. Returns false if it couldn't.
 */
export async function shootAt (bot: Bot, target: Entity, signal: AbortSignal): Promise<boolean> {
  const r = hasRanged(bot)
  if (!r) return false
  await bot.equip(r.weapon, 'hand').catch(() => {})
  const speed = r.kind === 'crossbow' ? 3.15 : 3.0
  let last = { x: target.position.x, y: target.position.y, z: target.position.z, t: Date.now() }
  let vel = { x: 0, y: 0, z: 0 }
  const sample = () => {
    const now = Date.now()
    const dt = (now - last.t) / 50 // ticks
    if (dt >= 1) {
      const p = target.position
      const k = 0.5 // smoothing
      vel = { x: vel.x * (1 - k) + (p.x - last.x) / dt * k, y: vel.y * (1 - k) + (p.y - last.y) / dt * k, z: vel.z * (1 - k) + (p.z - last.z) / dt * k }
      last = { x: p.x, y: p.y, z: p.z, t: now }
    }
  }
  const aim = async () => {
    sample()
    const eye = bot.entity.position.offset(0, 1.52, 0) // arrows leave 0.1 below the eyes
    const t = target.position.offset(0, target.height * 0.5, 0)
    // falling/jumping mobs: lead only horizontally unless it flies
    const v = { x: vel.x, y: (target as any).onGround === false && target.name !== 'phantom' ? 0 : vel.y, z: vel.z }
    const a = aimArrow(eye, t, v, speed)
    if (a) await bot.look(a.yaw, a.pitch, true)
    else await bot.lookAt(t, true)
  }
  try {
    await aim()
    bot.activateItem()
    const until = Date.now() + (r.kind === 'crossbow' ? 1300 : 1100) // full draw
    while (Date.now() < until && !signal.aborted) { await aim().catch(() => {}); await new Promise(res => setTimeout(res, 50)) }
    await aim().catch(() => {})
    bot.deactivateItem()
    if (r.kind === 'crossbow') { await new Promise(res => setTimeout(res, 100)); bot.activateItem(); await new Promise(res => setTimeout(res, 50)); bot.deactivateItem() }
    return true
  } catch {
    try { bot.deactivateItem() } catch {}
    return false
  }
}

/** Shield in the offhand (equips it from the inventory if needed). */
export async function readyShield (bot: Bot): Promise<boolean> {
  if (bot.inventory.slots[45]?.name === 'shield') return true
  // a totem put there for low health stays (combat.totem): it is worth more than blocking now
  if (bot.inventory.slots[45]?.name === 'totem_of_undying' && bot.health <= 10) return false
  const shield = bot.inventory.items().find(i => i.name === 'shield')
  if (!shield) return false
  await bot.equip(shield, 'off-hand').catch(() => {})
  return bot.inventory.slots[45]?.name === 'shield'
}

/** Raises a shield (offhand) for a moment if a ranged mob is near and aiming. */
export async function blockWithShield (bot: Bot, ms = 800): Promise<boolean> {
  // items() doesn't list the offhand slot: a shield already worn there used to count as none
  if (!await readyShield(bot)) return false
  bot.activateItem(true)
  await new Promise(r => setTimeout(r, ms))
  bot.deactivateItem()
  return true
}

export const isRangedMob = (name: string | undefined) => RANGED_MOBS.has(name ?? '')
