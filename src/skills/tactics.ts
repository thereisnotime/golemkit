// Pure combat decisions (no bot, unit-tested): attack cooldown, when to jump for a critical hit,
// which mob to fight first, when to disengage, which armour to wear and how to aim an arrow.
// fight() in combat.ts turns these into movement; nothing here touches the world.
import { enchantList } from './enchants.ts'

/** Vanilla 1.21 attack speed (attacks per second) of what is in the main hand. */
const SPEED: Record<string, number> = {
  wooden_axe: 0.8, stone_axe: 0.8, iron_axe: 0.9, golden_axe: 1.0, diamond_axe: 1.0, netherite_axe: 1.0,
  trident: 1.1, mace: 0.6
}

export function attackSpeed (item: string | undefined | null): number {
  const n = item ?? ''
  if (SPEED[n] !== undefined) return SPEED[n]!
  if (n.endsWith('_sword')) return 1.6
  if (n.endsWith('_axe')) return 0.9 // modded axes: middle of the vanilla range
  if (n.endsWith('_pickaxe')) return 1.2
  if (n.endsWith('_shovel')) return 1.0
  if (n.endsWith('_hoe')) return /^(wooden|golden)/.test(n) ? 1.0 : /^stone/.test(n) ? 2.0 : /^iron/.test(n) ? 3.0 : 4.0
  return 4.0 // fist and any other item
}

/**
 * Full attack cooldown in ms for an item: 1 / attack speed (sword 625 ms, stone axe 1250, iron
 * axe ~1111). The server reaches full charge half a tick sooner, so this is never early.
 * Switching the held item resets the charge.
 */
export function attackCooldownMs (item: string | undefined | null): number {
  return Math.round(1000 / attackSpeed(item))
}

export interface SwingState {
  /** ms until the weapon is fully charged (<= 0: ready). */
  cooldownLeftMs: number
  /** Eye-to-hitbox distance, blocks. */
  reach: number
  onGround: boolean
  /** Vertical velocity, blocks/tick (negative = falling). */
  velY: number
  inLiquid: boolean
  /** Room above the head for a jump (no ceiling within 2 blocks over the eyes). */
  headroom: boolean
  /** combat.crits */
  crits: boolean
  /** First hit of the fight: sprint into it for extra knockback instead of a crit. */
  firstHit: boolean
  /** The target hits back hard if we wait (creeper about to blow, we're low): don't spend time jumping. */
  hurry?: boolean
}

export type SwingDecision = 'swing' | 'jump' | 'wait' | 'sprint_hit'

export const MELEE_REACH = 3.0
/** A jump peaks after ~6 ticks; the fall that makes a crit starts then. */
export const JUMP_TO_FALL_MS = 300

/**
 * What to do this tick in melee. Crits need: falling (not on the ground, moving down), not in
 * water or on a ladder, not sprinting, full charge. Jump early enough that the fall starts as
 * the cooldown runs out; if we're already falling, hit the moment we're charged.
 */
export function swingDecision (s: SwingState): SwingDecision {
  const inReach = s.reach <= MELEE_REACH
  if (s.firstHit && inReach && s.cooldownLeftMs <= 0) return 'sprint_hit'
  const canCrit = s.crits && !s.inLiquid && s.headroom && !s.hurry && !s.firstHit
  const falling = !s.onGround && s.velY < -0.01
  if (s.cooldownLeftMs <= 0) {
    if (!inReach) return 'wait'
    if (!canCrit || falling) return 'swing'
    // Charged but on the ground: a jump costs ~300 ms for 1.5x damage, worth it unless airborne going up.
    if (s.onGround) return 'jump'
    return 'wait' // rising: the fall comes in a few ticks
  }
  if (canCrit && s.onGround && inReach && s.cooldownLeftMs <= JUMP_TO_FALL_MS) return 'jump'
  return 'wait'
}

/** Damage factor of a hit (vanilla): 0.2 + 0.8 * charge^2, times 1.5 for a crit. */
export function hitFactor (charge: number, crit: boolean): number {
  const c = Math.max(0, Math.min(1, charge))
  return (0.2 + 0.8 * c * c) * (crit && c > 0.9 ? 1.5 : 1)
}

// ---- targets ----

export interface ThreatInfo {
  id: number
  name: string
  /** Distance from the bot, blocks. */
  dist: number
  /** Clear line of sight between the bot's eyes and the mob. */
  los: boolean
  fuseLit?: boolean
  /** Hit us in the last few seconds (neutral mobs only count when this is true). */
  attacking?: boolean
}

const RANGED = new Set(['skeleton', 'stray', 'bogged', 'pillager', 'blaze', 'ghast', 'witch'])
const FLYERS = new Set(['phantom', 'ghast', 'vex', 'blaze', 'breeze', 'bee'])

/**
 * Threat score (higher first): a creeper close by (lit fuse highest), then an archer that can
 * see us, then the nearest melee mob. Distance breaks ties inside each band.
 */
export function threatScore (t: ThreatInfo): number {
  const near = Math.max(0, 30 - t.dist) // 0..30
  if (t.name === 'creeper' && t.dist <= 6) return (t.fuseLit ? 400 : 300) + near
  if (RANGED.has(t.name) && t.los && t.dist <= 20) return 200 + near
  if (FLYERS.has(t.name)) return (t.dist <= 6 ? 150 : 60) + near
  return 100 + near + (t.attacking ? 5 : 0)
}

export function rankTargets<T extends ThreatInfo> (list: T[]): T[] {
  return list.slice().sort((a, b) => threatScore(b) - threatScore(a))
}

/** Neutral mobs fought only while they attack (us, or the player a bodyguard protects). */
export const NEUTRAL_FIGHTABLE = new Set(['enderman', 'piglin', 'zombified_piglin', 'wolf', 'polar_bear', 'llama', 'trader_llama', 'bee', 'panda', 'goat'])
/** Never attacked, whatever they do. */
export const NEVER_ATTACK = new Set(['villager', 'wandering_trader', 'iron_golem', 'snow_golem', 'allay', 'cat', 'parrot', 'horse', 'donkey', 'mule', 'axolotl'])

/** Never fought, only avoided: the warden (500 health, hits through shields). */
export const AVOID = new Set(['warden'])

/** What the attack rule looks at; combatRefusal() reads these off a mineflayer entity. */
export interface AttackCandidate {
  name: string
  /** A player (type player or a username). */
  player: boolean
  /** Has a custom name (name tag). */
  named: boolean
  /** Has an owner (tamed). */
  owned: boolean
  /** isHostile(). */
  hostile: boolean
  /** Hit us (or the protected player) in the last few seconds. */
  attacking: boolean
}

/**
 * Why an entity must not be attacked, or null when it may: never players, villagers, golems,
 * pets, named mobs; neutral mobs (endermen, piglins, wolves...) only while they attack.
 */
export function attackRefusal (c: AttackCandidate): string | null {
  if (c.player) return 'a player'
  if (AVOID.has(c.name)) return `a ${c.name} (too strong: get away from it)`
  if (NEVER_ATTACK.has(c.name) || /golem$/.test(c.name)) return `a ${c.name}`
  if (c.named) return 'named'
  if (c.owned) return 'someone\'s pet'
  if (c.hostile) return null
  if (NEUTRAL_FIGHTABLE.has(c.name) && c.attacking) return null
  return 'not hostile'
}

export interface DisengageState {
  health: number
  maxHealth?: number
  /** Melee (ground, not ranged) hostiles within 6 blocks. */
  meleeNear: number
}

/** Outnumbered: 3+ melee mobs close and health under half. Then pillar, go home or back off. */
export function outnumbered (s: DisengageState): boolean {
  return s.meleeNear >= 3 && s.health < (s.maxHealth ?? 20) / 2
}

/**
 * combat.disengageToHeal: at 4 health or less, back off briefly to heal, then come back. Only
 * when backing off actually heals: something edible right now (normal food needs a hunger bar
 * below 20, golden apples always work), or a hunger bar of 18+ so natural regeneration runs.
 * Independent of reflexes.retreatBelow (0 = stand ground).
 */
export function shouldDisengageToHeal (s: { enabled: boolean, health: number, food: number, hasFood: boolean, hasGoldenApple: boolean }): boolean {
  if (!s.enabled || s.health > 4 || s.health <= 0) return false
  return s.hasGoldenApple || (s.hasFood && s.food < 20) || s.food >= 18
}

/**
 * Eat in a lull: nothing within 4 blocks and hunger blocks regeneration (natural regen needs
 * food >= 18) or health is low and a golden apple is at hand.
 */
export function shouldEatInLull (s: { health: number, food: number, nearestMob: number, hasFood: boolean, hasGoldenApple: boolean }): boolean {
  if (s.nearestMob < 4) return false
  if (s.hasGoldenApple && s.health <= 10) return true
  return s.hasFood && s.food < 18 && s.health < 20
}

// ---- gear ----

export type ArmorSlot = 'head' | 'torso' | 'legs' | 'feet'

const MATERIAL: Record<string, { head: number, torso: number, legs: number, feet: number, tough: number }> = {
  leather: { head: 1, torso: 3, legs: 2, feet: 1, tough: 0 },
  golden: { head: 2, torso: 5, legs: 3, feet: 1, tough: 0 },
  chainmail: { head: 2, torso: 5, legs: 4, feet: 1, tough: 0 },
  iron: { head: 2, torso: 6, legs: 5, feet: 2, tough: 0 },
  diamond: { head: 3, torso: 8, legs: 6, feet: 3, tough: 2 },
  netherite: { head: 3, torso: 8, legs: 6, feet: 3, tough: 3 }
}
const PIECE: Record<string, ArmorSlot> = { helmet: 'head', chestplate: 'torso', leggings: 'legs', boots: 'feet' }

export interface ArmorItem { name: string, enchants?: { name: string, lvl: number }[], durabilityLeft?: number }

/** Slot and score of an armour item (armour points + toughness + protection), or null. */
export function armorScore (it: ArmorItem): { slot: ArmorSlot, score: number } | null {
  if (it.name === 'turtle_helmet') return { slot: 'head', score: 2 + prot(it) }
  const m = /^([a-z]+)_(helmet|chestplate|leggings|boots)$/.exec(it.name)
  if (!m) return null
  const mat = MATERIAL[m[1]!]
  const slot = PIECE[m[2]!]!
  if (!mat) return null
  let score = mat[slot] + mat.tough * 0.5 + prot(it)
  if (it.durabilityLeft !== undefined && it.durabilityLeft < 10) score -= 4 // about to break
  return { slot, score }
}

function prot (it: ArmorItem): number {
  return enchantList(it.enchants).reduce((n, e) => n + (/protection$/.test(e.name) ? e.lvl * (e.name === 'protection' ? 0.75 : 0.4) : 0), 0)
}

/**
 * Which inventory items to put on: per slot, the best item that beats what is worn. Pure: give
 * it the inventory and the four worn items (null = empty slot).
 */
export function pickArmor<T extends ArmorItem> (inventory: T[], worn: Partial<Record<ArmorSlot, ArmorItem | null>>): Partial<Record<ArmorSlot, T>> {
  const out: Partial<Record<ArmorSlot, T>> = {}
  const best: Partial<Record<ArmorSlot, number>> = {}
  for (const slot of ['head', 'torso', 'legs', 'feet'] as const) {
    const w = worn[slot]
    best[slot] = w ? (armorScore(w)?.score ?? 0) : -Infinity
  }
  for (const it of inventory) {
    const s = armorScore(it)
    if (!s) continue
    if (s.score > best[s.slot]!) { best[s.slot] = s.score; out[s.slot] = it }
  }
  return out
}

/**
 * Offhand item: a totem when it matters (low health, a lethal fall or burn: `danger`, or nothing
 * else), otherwise a shield. A totem already in the offhand stays until health is back above 14,
 * so it doesn't swap back and forth around 10.
 */
export function pickOffhand (s: { hasTotem: boolean, hasShield: boolean, health: number, current?: string | null, danger?: boolean }): 'totem_of_undying' | 'shield' | null {
  if (s.hasTotem && (!s.hasShield || s.health <= 10 || s.danger)) return 'totem_of_undying'
  if (s.hasTotem && s.current === 'totem_of_undying' && s.health <= 14) return 'totem_of_undying'
  if (s.hasShield) return 'shield'
  return s.hasTotem ? 'totem_of_undying' : null
}

// ---- ranged ----

export interface V3 { x: number, y: number, z: number }

/** Arrow physics per tick (1.21): move, then velocity *= 0.99, then y -= 0.05. */
const DRAG = 0.99
const GRAVITY = 0.05

/** Height an arrow fired at `pitch` (radians, up positive) has after travelling `horiz` blocks, and the ticks it took. */
function flight (speed: number, pitch: number, horiz: number): { dy: number, ticks: number } | null {
  let vx = Math.cos(pitch) * speed
  let vy = Math.sin(pitch) * speed
  let x = 0
  let y = 0
  for (let t = 1; t <= 200; t++) {
    const nx = x + vx
    if (nx >= horiz) {
      const f = (horiz - x) / vx
      return { dy: y + vy * f, ticks: t - 1 + f }
    }
    x = nx
    y += vy
    vx *= DRAG
    vy = vy * DRAG - GRAVITY
    if (vx < 1e-3) return null
  }
  return null
}

/**
 * Yaw/pitch (mineflayer convention: yaw = atan2(-dx, -dz), pitch up positive) to hit a moving
 * target with an arrow. `vel` is the target's velocity in blocks per tick. Iterates: flight
 * time -> predicted position -> flat-trajectory pitch by bisection. Null when out of range.
 */
export function aimArrow (from: V3, target: V3, vel: V3 = { x: 0, y: 0, z: 0 }, speed = 3.0): { yaw: number, pitch: number, ticks: number } | null {
  let ticks = 0
  let sol: { yaw: number, pitch: number, ticks: number } | null = null
  for (let iter = 0; iter < 4; iter++) {
    const px = target.x + vel.x * ticks - from.x
    const py = target.y + vel.y * ticks - from.y
    const pz = target.z + vel.z * ticks - from.z
    const horiz = Math.hypot(px, pz)
    if (horiz < 0.5) return { yaw: Math.atan2(-px, -pz), pitch: Math.atan2(py, Math.max(horiz, 1e-3)), ticks: 0 }
    // dy at a given pitch rises monotonically up to ~45 degrees: bisect for the flat solution
    let lo = -Math.PI / 2 + 0.01
    let hi = Math.PI / 4
    const top = flight(speed, hi, horiz)
    if (!top || top.dy < py) return sol // out of range even at 45 degrees
    let f: { dy: number, ticks: number } | null = null
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2
      f = flight(speed, mid, horiz)
      if (!f || f.dy > py) hi = mid
      else lo = mid
    }
    const pitch = (lo + hi) / 2
    f = flight(speed, pitch, horiz)
    if (!f) return sol
    ticks = f.ticks
    sol = { yaw: Math.atan2(-px, -pz), pitch, ticks }
  }
  return sol
}

/** Simulated landing height for tests and debugging: where an arrow at yaw/pitch is after `horiz` blocks. */
export function arrowHeightAt (speed: number, pitch: number, horiz: number): number | null {
  return flight(speed, pitch, horiz)?.dy ?? null
}

// ---- movement ----

/**
 * Spacing against a melee mob, from horizontal centre distance: back off inside 2.2 (zombie
 * reach is ~1.4 between centres, ours 3 from the eyes), close in beyond 2.9, strafe in between.
 */
export function spacing (hDist: number): 'back' | 'forward' | 'strafe' {
  if (hDist < 2.2) return 'back'
  if (hDist > 2.9) return 'forward'
  return 'strafe'
}

/**
 * Whether to keep chasing: not past maxChase from where the fight started, and the mob is not
 * somewhere we shouldn't follow it.
 */
export function chaseRefusal (s: { fromStart: number, maxChase: number, targetInLiquid: boolean, dropBelow: number, targetInDark: boolean, botInDark: boolean }): string | null {
  if (s.fromStart > s.maxChase) return `chased ${Math.round(s.fromStart)} blocks from where the fight started`
  if (s.targetInLiquid) return 'it is in water or lava'
  if (s.dropBelow > 4) return 'it is down a drop'
  if (s.targetInDark && !s.botInDark) return 'it went into a dark cave'
  return null
}

/**
 * What to do about a creeper the bot fights: back off when its fuse is lit within 5 blocks (the
 * blast hurts out to ~7; never stand within 3 of a lit fuse), shoot it from 5+ blocks with a bow
 * (unless the shot is held, a bodyguard's player in the line), otherwise hit once and step back.
 * With `leap` (combat.dodge.creeperLeap) the back-off is a sprint-jump away ('leap', dodge.ts)
 * instead of a walk; the caller falls back to 'back_off' when no leap is safe.
 */
export function creeperMove (s: { dist: number, fuseLit: boolean, bow: boolean, holdFire?: boolean, leap?: boolean }): 'back_off' | 'leap' | 'shoot' | 'melee' {
  if (s.fuseLit && s.dist < 5) return s.leap ? 'leap' : 'back_off'
  if (s.bow && !s.holdFire && s.dist >= 5 && s.dist < 24) return 'shoot'
  return 'melee'
}

/** Not fit to be out at night: no armour, no weapon or no food. stay_safe then goes home or digs in. */
export function unpreparedForNight (s: { armorPoints: number, hasWeapon: boolean, hasFood: boolean }): string | null {
  const missing = [s.armorPoints <= 0 && 'armour', !s.hasWeapon && 'weapon', !s.hasFood && 'food'].filter(Boolean)
  return missing.length ? `no ${missing.join(', no ')}` : null
}
