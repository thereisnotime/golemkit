// Pure PvP tactics (no bot, unit-tested). Players are not mobs: they strafe, block, crit, shoot,
// pearl and heal. pvp-fight.ts turns these into control states every 50 ms. Mechanics and sources
// are on docs/concepts/combat-research.md (cooldown, crits, W-tap, shields and axes, totems,
// golden apples, arrow physics).
import { attackCooldownMs, MELEE_REACH } from './tactics.ts'
import { SHIELD_DELAY_MS } from './techniques.ts'

export interface V3 { x: number, y: number, z: number }

// ---- reading the enemy ----

/**
 * Smoothed velocity (blocks per tick) from two positions `dtTicks` apart. `k` weighs the new
 * sample. A jump over 8 blocks in a sample is a teleport (pearl), not movement: it resets to 0.
 */
export function trackVelocity (prev: V3, from: V3, to: V3, dtTicks: number, k = 0.5): V3 {
  if (dtTicks <= 0) return prev
  const dx = to.x - from.x
  const dy = to.y - from.y
  const dz = to.z - from.z
  if (Math.hypot(dx, dy, dz) > 8) return { x: 0, y: 0, z: 0 }
  return { x: prev.x * (1 - k) + dx / dtTicks * k, y: prev.y * (1 - k) + dy / dtTicks * k, z: prev.z * (1 - k) + dz / dtTicks * k }
}

/** A teleport (ender pearl, /tp) between two samples: more than 8 blocks at once. */
export function teleported (from: V3, to: V3): boolean {
  return Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z) > 8
}

/** Where the target will be in `ticks` ticks, horizontally only (jumps don't carry), capped at `cap` ticks. */
export function predict (pos: V3, vel: V3, ticks: number, cap = 10): V3 {
  const t = Math.max(0, Math.min(cap, ticks))
  return { x: pos.x + vel.x * t, y: pos.y, z: pos.z + vel.z * t }
}

/** ms until an enemy who swung `sinceSwingMs` ago with `held` is charged again (0: ready now). */
export function enemyReadyIn (sinceSwingMs: number, held: string | null | undefined): number {
  return Math.max(0, attackCooldownMs(held) - sinceSwingMs)
}

/** Is a direction (from the target towards `to`) inside the 180-degree arc a raised shield covers? */
export function shieldCovers (targetYaw: number, target: V3, from: V3): boolean {
  // mineflayer yaw: facing vector (-sin yaw, -cos yaw)
  const fx = -Math.sin(targetYaw)
  const fz = -Math.cos(targetYaw)
  return fx * (from.x - target.x) + fz * (from.z - target.z) > 0
}

// ---- weapon ----

/**
 * Sword or axe. Against a player who carries a shield the axe is the main weapon: every hit on a
 * raised shield turns it off for 5 s, and against armour its big hits lose less (armour takes a
 * smaller share of a big hit), so it comes out even on damage per second with the sword while
 * never wasting a swing on a block. Swapping resets the charge, so it doesn't swap back and forth
 * during the 5 s. Without a shield on them: the sword (1.6 hits a second). Measured in the
 * bot-vs-bot benchmark: the old loop, which always takes the axe against shield users, beat an
 * earlier sword-first version.
 */
export function pvpWeapon (s: { sword: boolean, axe: boolean, enemyShield: boolean, enemyBlocking?: boolean }): 'sword' | 'axe' | null {
  if (s.axe && (s.enemyShield || s.enemyBlocking)) return 'axe'
  if (s.sword) return 'sword'
  return s.axe ? 'axe' : null
}

/** After an axe hit on a raised shield it stays down this long (100 ticks). */
export const SHIELD_DISABLE_MS = 5000

// ---- shield ----

/**
 * Raise or lower our shield. Up against an arrow on its way or a bow drawn at us, and in reach
 * whenever our own hit is more than 5 ticks (the raise delay) plus a margin from charged: a
 * player's hit can come any time, and an axe hit on the raised shield is still blocked in full
 * (the shield is then off for 5 s). Down a tick before our hit, and when it's disabled.
 */
export function pvpShield (s: {
  hasShield: boolean, disabled: boolean, dist: number, myCdLeftMs: number, arrowIncoming: boolean, enemyDrawing: boolean
}): 'raise' | 'lower' {
  if (!s.hasShield || s.disabled) return 'lower'
  if (s.arrowIncoming || (s.enemyDrawing && s.dist > 4)) return 'raise'
  if (s.myCdLeftMs <= SHIELD_DELAY_MS + 100) return 'lower'
  if (s.dist <= MELEE_REACH + 0.8) return 'raise'
  return 'lower'
}

/** Our shield goes down this long before our charge completes. */
export const SHIELD_LOWER_MS = 60

// ---- moving ----

export interface PvpMoveState {
  /** Horizontal distance between centres. */
  hd: number
  /** ms until our weapon is charged. */
  myCdLeftMs: number
  /** ms until theirs is (0: they can hit now). */
  enemyReadyInMs: number
  /** They hold a bow or crossbow and are drawing it. */
  enemyDrawing: boolean
  /** Our health below theirs by this much (positive: we are losing). */
  behind: number
  /** We have a working shield to block with. */
  shield?: boolean
}

export type PvpMove = { dir: 'forward' | 'back' | 'strafe', sprint: boolean, strafe: boolean }

/**
 * Footwork: close in sprinting (strafing so a bow line misses) when far, step into reach as our
 * hit charges (the sprint makes it a knockback hit, W-tap), keep about 3 blocks while it
 * charges, circle at that distance (stepping out of their reach instead when we have no
 * shield and their hit is ready), and back off inside 2.4 blocks.
 */
export function pvpMove (s: PvpMoveState): PvpMove {
  if (s.enemyDrawing && s.hd > 4) return { dir: 'forward', sprint: true, strafe: true }
  if (s.hd > 6) return { dir: 'forward', sprint: true, strafe: s.hd < 14 }
  if (s.hd < 2.4) return { dir: 'back', sprint: false, strafe: true }
  const charged = s.myCdLeftMs <= 250
  if (s.hd > 3.2) {
    // in only when our hit is (almost) ready; otherwise circle at the edge of their reach
    if (charged) return { dir: 'forward', sprint: true, strafe: false }
    return { dir: 'strafe', sprint: false, strafe: true }
  }
  // inside reach while charging: circle (the shield covers us); out of reach when we have none and they're ready
  if (!charged && !s.shield && s.enemyReadyInMs <= 200 && s.behind > -4) return { dir: 'back', sprint: false, strafe: true }
  return { dir: 'strafe', sprint: false, strafe: true }
}

/**
 * Knockback (sprint hit) over a crit: the enemy stands with a drop or lava behind them (knock
 * them off), or we are losing and need the space. Otherwise crits do more.
 */
export function pvpKnockback (s: { enemyEdge: boolean, health: number, enemyHealth: number }): boolean {
  if (s.enemyEdge) return true
  return s.health <= 8 && s.enemyHealth > s.health + 4
}

/**
 * Standing with a drop or lava behind us is how players get knocked to their death. Step
 * sideways to whichever side is safe so the danger ends up beside us, or press forward into the
 * enemy when both sides are unsafe too. Null when the ground behind is fine.
 */
export function edgeStep (s: { backSafe: boolean, leftSafe: boolean, rightSafe: boolean }): 'left' | 'right' | 'forward' | null {
  if (s.backSafe) return null
  if (s.leftSafe) return 'left'
  if (s.rightSafe) return 'right'
  return 'forward'
}

/** Strafe direction flips after this long (ms, jittered by the caller), so the circle isn't predictable. */
export const STRAFE_FLIP_MS = 600

// ---- ranged ----

/**
 * Bow or melee: the bow at 12 to 40 blocks with arrows, while the enemy isn't blocking (a raised
 * shield stops arrows) and isn't closing in fast; melee otherwise. Closing speed is blocks per
 * second towards us.
 */
export function pvpRange (s: { dist: number, bow: boolean, arrows: number, enemyBlocking: boolean, closing: number }): 'bow' | 'melee' {
  if (!s.bow || s.arrows <= 0 || s.enemyBlocking) return 'melee'
  if (s.dist < 12 || s.dist > 40) return 'melee'
  // a full draw takes 1.1 s: don't start one they'll walk through
  if (s.dist - s.closing * 1.3 < 5) return 'melee'
  return 'bow'
}

// ---- sustain ----

export type Sustain = 'totem' | 'apple' | 'eat' | 'retreat' | null

/**
 * What to do about health this tick, most urgent first: a totem into the offhand at 10 or less
 * (PvP damage comes in bursts: crits of 9+), a golden apple at 10 or less (when the enemy isn't
 * on us, or at 6 or less whatever), back off when low with nothing to heal and losing, and
 * normal food when they are well away.
 */
export function pvpSustain (s: {
  health: number, enemyDist: number, hasTotem: boolean, totemInOffhand: boolean, hasApple: boolean, sinceAppleMs: number,
  hasFood: boolean, food: number, odds: number
}): Sustain {
  if (s.health <= 0) return null
  if (s.hasTotem && !s.totemInOffhand && s.health <= 10) return 'totem'
  if (s.hasApple && s.sinceAppleMs > 6000 && (s.health <= 6 || (s.health <= 10 && s.enemyDist > 3.5))) return 'apple'
  if (s.health <= 6 && !s.hasApple && !s.totemInOffhand && s.odds < 1.2) return 'retreat'
  if (s.enemyDist > 10 && s.hasFood && s.food < 18 && s.health < 20) return 'eat'
  return null
}

/** Back in after a retreat: healed to 14, or healthier than them by 4. */
export function reengage (s: { health: number, enemyHealth: number }): boolean {
  return s.health >= 14 || s.health >= s.enemyHealth + 4
}
