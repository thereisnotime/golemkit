// Pure bodyguard decisions (no bot, unit-tested): which mobs threaten the protected player and
// in what order, where to stand between the player and a threat, where to stand to block an
// archer's line of fire, when to hand the player food, and the rate-limited warning texts.
// protect (bodyguard.ts) turns these into movement and fights; nothing here touches the world.
import { threatScore } from './tactics.ts'

export interface V3 { x: number, y: number, z: number }

const RANGED = new Set(['skeleton', 'stray', 'bogged', 'pillager', 'blaze', 'ghast', 'witch'])
const FLYERS = new Set(['phantom', 'ghast', 'vex', 'blaze', 'breeze', 'bee'])

export interface GuardThreat {
  id: number
  name: string
  /** Distance to the protected player, blocks. */
  distPlayer: number
  /** Distance to the bot, blocks. */
  distBot: number
  /** Clear line from the mob's eyes to the player. */
  losPlayer: boolean
  fuseLit?: boolean
  /** isHostile(). Neutral mobs count only when they hurt the player or the bot. */
  hostile: boolean
  /** Hurt the player in the last few seconds (damage event source, or right next to them when they got hurt). */
  hurtPlayer?: boolean
  /** Hurt the bot in the last few seconds. */
  hurtBot?: boolean
  /** Getting closer to the player. */
  approaching?: boolean
  /** Looking at the player. */
  facing?: boolean
  /** A flyer coming down towards the player. */
  diving?: boolean
}

/**
 * Why a mob is a threat to the player (or to the bot itself while it guards), or null when it
 * is not one yet. Creepers within 6, archers with a shot, diving phantoms, mobs coming for
 * the player inside `range`, anything that hurt the player; neutral mobs only when they attack.
 */
export function threatReason (t: GuardThreat, range: number): string | null {
  if (t.hurtPlayer) return 'hurt the player'
  if (!t.hostile) return t.hurtBot ? 'attacked me' : null
  if (t.name === 'creeper' && t.distPlayer <= 6) return 'creeper close'
  if (RANGED.has(t.name) && t.losPlayer && t.distPlayer <= range) return 'has a shot at the player'
  if (FLYERS.has(t.name)) {
    if (t.distPlayer <= 6 || (t.diving && t.distPlayer <= 24)) return 'diving at the player'
    return t.hurtBot ? 'attacked me' : null
  }
  if (t.distPlayer <= range && (t.approaching || t.facing)) return 'coming for the player'
  if (t.distPlayer <= 5) return 'next to the player'
  if (t.hurtBot || t.distBot <= 4) return 'on me'
  return null
}

/**
 * Threat score relative to the player (higher first): tactics.threatScore measured from the
 * player, so a creeper within 6 of them stays on top (300+, 400+ with a lit fuse), then archers
 * with a shot, then the rest; hurting the player and closing in add to it, and mobs that only
 * bother the bot come after everything that bothers the player.
 */
export function guardScore (t: GuardThreat, range = 16): number {
  const base = threatScore({ id: t.id, name: t.name, dist: t.distPlayer, los: t.losPlayer, fuseLit: t.fuseLit, attacking: t.hurtPlayer })
  let s = base + (t.hurtPlayer ? 40 : 0) + (t.approaching || t.diving ? 10 : 0)
  const reason = threatReason(t, range)
  if (reason === 'on me' || reason === 'attacked me') s -= 60
  return s
}

/** The threats among `list`, most urgent first, each with its reason. */
export function rankGuardThreats<T extends GuardThreat> (list: T[], range: number): (T & { reason: string, score: number })[] {
  const out: (T & { reason: string, score: number })[] = []
  for (const t of list) {
    const reason = threatReason(t, range)
    if (reason) out.push({ ...t, reason, score: guardScore(t, range) })
  }
  return out.sort((a, b) => b.score - a.score)
}

/**
 * Where to stand to be between the player and a threat: on the line from the player towards it,
 * `distance` blocks out (at most halfway, at least 1.5 so the bot doesn't stand in the player).
 * Null when the threat is right on top of the player (nothing to stand between).
 */
export function guardSpot (player: V3, threat: V3, distance = 3): V3 | null {
  const dx = threat.x - player.x
  const dz = threat.z - player.z
  const flat = Math.hypot(dx, dz)
  if (flat < 1) return null
  const d = Math.max(1.5, Math.min(distance, flat / 2))
  return { x: player.x + dx / flat * d, y: player.y, z: player.z + dz / flat * d }
}

/**
 * Where to stand to block an archer's shot at the player: on the line from the archer's eyes to
 * where it aims (vanilla skeletons aim at a third of the target's height, ~0.6 above the feet),
 * close to the player, where that line passes through the bot's body (feet at the player's feet
 * level, 1.8 tall). An archer high on a ridge shoots down steeply, so the spot moves in next to
 * the player; when no spot covers the line, `covers` is false and the bot should close in
 * instead. Null when the archer is too close for blocking to make sense.
 */
export function blockSpot (player: V3, archer: V3, opts: { near?: number, archerEye?: number } = {}): { spot: V3, covers: boolean } | null {
  const dx = archer.x - player.x
  const dz = archer.z - player.z
  const flat = Math.hypot(dx, dz)
  if (flat < 3) return null
  const AIM = 0.6
  const slope = ((archer.y + (opts.archerEye ?? 1.74)) - (player.y + AIM)) / flat
  const MIN = 0.9 // hitboxes are 0.6 wide: closer than this the two overlap
  // the line's height above the player's feet at horizontal distance n: AIM + slope * n; the bot covers 0.1..1.7
  let near = opts.near ?? 1.5
  if (slope > 0) near = Math.min(near, (1.6 - AIM) / slope)
  else if (slope < 0) near = Math.min(near, (0.2 - AIM) / slope)
  near = Math.max(MIN, near)
  const h = AIM + slope * near
  const covers = h >= 0.1 && h <= 1.7
  return { spot: { x: player.x + dx / flat * near, y: player.y, z: player.z + dz / flat * near }, covers }
}

// ---- feeding ----

export interface FoodItem { name: string, count: number, points: number }

export interface FeedState {
  /** The player's health from entity metadata, or null when the server doesn't send it. */
  playerHealth: number | null
  /** The player's food level: servers don't send it for other players, so usually null. */
  playerFood: number | null
  /** Distance bot to player. */
  distance: number
  /** Food in the bot's inventory (rotten flesh and the like already left out). */
  foods: FoodItem[]
  /** Keep at least this many food items for the bot. */
  keepForSelf: number
  /** ms since the bot last gave this player food. */
  sinceLastFedMs: number
  /** A threat close to the player: fight first. */
  threatClose: boolean
  /** Feed at or below this health. Default 10. */
  lowHealth?: number
  /** Feed at or below this food level (when known). Default 6. */
  lowFood?: number
}

export type FeedDecision = { give: string, count: number, why: string } | { skip: string }

/** Whether to toss the player food now, and what. Never gives away the bot's own reserve. */
export function feedDecision (s: FeedState): FeedDecision {
  if (s.playerHealth === null && s.playerFood === null) return { skip: "can't see their health or hunger" }
  const lowH = s.playerHealth !== null && s.playerHealth > 0 && s.playerHealth <= (s.lowHealth ?? 10)
  const lowF = s.playerFood !== null && s.playerFood <= (s.lowFood ?? 6)
  if (!lowH && !lowF) return { skip: 'they are fine' }
  if (s.sinceLastFedMs < 30_000) return { skip: 'fed them recently' }
  if (s.threatClose) return { skip: 'fight first' }
  if (s.distance > 5) return { skip: 'too far to toss' }
  const total = s.foods.reduce((n, f) => n + f.count, 0)
  const spare = total - s.keepForSelf
  if (spare <= 0) return { skip: `not enough food to share (${total}, keeping ${s.keepForSelf})` }
  const best = s.foods.slice().sort((a, b) => b.points - a.points)[0]!
  const count = Math.max(1, Math.min(2, best.count, spare))
  const why = lowF ? `food ${s.playerFood}` : `health ${Math.ceil(s.playerHealth!)}`
  return { give: best.name, count, why }
}

// ---- warnings ----

/** Rate limit for warnings: a gap between any two, and a longer one before the same warning again. */
export class WarnLimiter {
  private last = -Infinity
  private readonly byKey = new Map<string, number>()
  readonly minGapMs: number
  readonly repeatMs: number
  constructor (minGapMs = 5000, repeatMs = 30_000) {
    this.minGapMs = minGapMs
    this.repeatMs = repeatMs
  }

  /** True (and remembered) when a warning with this key may go out now. */
  allow (key: string, now: number): boolean {
    if (now - this.last < this.minGapMs) return false
    const k = this.byKey.get(key)
    if (k !== undefined && now - k < this.repeatMs) return false
    this.last = now
    this.byKey.set(key, now)
    if (this.byKey.size > 64) for (const [kk, t] of this.byKey) if (now - t > this.repeatMs) this.byKey.delete(kk)
    return true
  }
}

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west']

/** 8-point compass direction of an offset (north = -z, east = +x). */
export function compass (dx: number, dz: number): string {
  const a = Math.atan2(dx, -dz) // 0 = north, clockwise
  const i = Math.round(a / (Math.PI / 4))
  return COMPASS[((i % 8) + 8) % 8]!
}

/**
 * Direction of an offset relative to where the player looks (mineflayer yaw: 0 faces north,
 * forward = (-sin yaw, -cos yaw)): "ahead of you", "behind you", "to your left", "to your right".
 */
export function relativeDir (yaw: number, dx: number, dz: number): string {
  const fx = -Math.sin(yaw)
  const fz = -Math.cos(yaw)
  const len = Math.hypot(dx, dz) || 1
  const fwd = (dx * fx + dz * fz) / len
  const left = (dx * fz - dz * fx) / len // left = (fz, -fx)
  if (fwd >= Math.SQRT1_2) return 'ahead of you'
  if (fwd <= -Math.SQRT1_2) return 'behind you'
  return left > 0 ? 'to your left' : 'to your right'
}

/**
 * A short callout for a threat to the player: "creeper behind you", "skeleton on the ridge
 * east", "phantoms incoming", "2 zombies to your left". Melee mobs and creepers are relative to
 * where the player looks, archers by compass (and "on the ridge" when 3+ blocks above them).
 */
export function warnText (name: string, player: V3, playerYaw: number, mob: V3, count = 1): string {
  const label = name.replace(/_/g, ' ')
  const many = count > 1 ? `${count} ${label}s` : label
  const dx = mob.x - player.x
  const dz = mob.z - player.z
  const dy = mob.y - player.y
  if (FLYERS.has(name) && name !== 'blaze') return `${count > 1 ? `${label}s` : label} incoming`
  if (RANGED.has(name)) {
    const where = dy >= 3 ? 'on the ridge ' : dy <= -3 ? 'below, ' : ''
    return `${many} ${where}${compass(dx, dz)}`
  }
  return `${many} ${relativeDir(playerYaw, dx, dz)}`
}

/** Key for the warning rate limit: one per mob kind and rough direction, so a second group elsewhere still gets called out. */
export function warnKey (name: string, player: V3, mob: V3): string {
  return `${name}:${compass(mob.x - player.x, mob.z - player.z)}`
}

// ---- motion ----

export interface Sample { dist: number, y: number, flat: number, at: number }

/** From two samples of a mob (distance to the player, height), whether it closes in and whether it comes down. */
export function motion (prev: Sample | undefined, cur: Sample): { approaching: boolean, descending: boolean } {
  if (!prev || cur.at - prev.at < 200 || cur.at - prev.at > 4000) return { approaching: false, descending: false }
  return {
    approaching: prev.dist - cur.dist >= 0.4,
    descending: prev.y - cur.y >= 0.5 && prev.flat - cur.flat >= -0.5
  }
}

/** Whether a mob with this yaw (mineflayer convention) looks towards a point within `tolerance` radians. */
export function facingTowards (yaw: number, from: V3, to: V3, tolerance = 0.6): boolean {
  const dx = to.x - from.x
  const dz = to.z - from.z
  if (Math.hypot(dx, dz) < 0.5) return true
  const want = Math.atan2(-dx, -dz)
  let d = Math.abs(want - yaw) % (2 * Math.PI)
  if (d > Math.PI) d = 2 * Math.PI - d
  return d <= tolerance
}
