// Pure decisions about mobs that shoot at the bot (no bot, unit-tested): which mobs shoot, whether
// a projectile in flight will hit the bot, how big a pillager patrol is, what to do about the
// shooters given health and gear (shoot back, shield up and close in, take cover, back off), and
// where the nearest cover is (a spot with a solid block between it and every shooter).
// ranged.ts reads the world into these and runs the response; nothing here touches the world.

export interface V3 { x: number, y: number, z: number }

/** Mobs that attack from range. Drowned only count while they hold a trident (isShooter). */
export const SHOOTERS = new Set(['skeleton', 'stray', 'bogged', 'pillager', 'witch', 'blaze', 'ghast'])
/** Mobs of a pillager patrol or raid. */
export const ILLAGERS = new Set(['pillager', 'vindicator', 'evoker', 'illusioner', 'ravager'])
/** Projectile entities that hurt, with their gravity (blocks/tick^2) and drag per tick. */
export const PROJECTILES: Record<string, { gravity: number, drag: number }> = {
  arrow: { gravity: 0.05, drag: 0.99 },
  spectral_arrow: { gravity: 0.05, drag: 0.99 },
  trident: { gravity: 0.05, drag: 0.99 },
  potion: { gravity: 0.05, drag: 0.99 },
  splash_potion: { gravity: 0.05, drag: 0.99 },
  lingering_potion: { gravity: 0.05, drag: 0.99 },
  small_fireball: { gravity: 0, drag: 1 },
  fireball: { gravity: 0, drag: 1 },
  wither_skull: { gravity: 0, drag: 1 },
  shulker_bullet: { gravity: 0, drag: 1 },
  llama_spit: { gravity: 0.06, drag: 0.99 }
}

/** Whether a mob shoots: skeletons, strays, bogged, pillagers, witches, blazes, ghasts, and drowned holding a trident. */
export function isShooter (name: string | undefined, held?: string | null): boolean {
  const n = name ?? ''
  if (SHOOTERS.has(n)) return true
  return n === 'drowned' && held === 'trident'
}

/** How far each shooter attacks from (vanilla follow/attack ranges, blocks). Beyond it the bot is out of range. */
export function shooterRange (name: string): number {
  if (name === 'ghast') return 64
  if (name === 'blaze') return 48
  if (name === 'pillager') return 16 // shoots inside 8, but walks up from 16+
  if (name === 'witch') return 10
  if (name === 'drowned') return 10
  return 16 // skeleton, stray, bogged
}

/**
 * Whether a projectile at `pos` moving with `vel` (blocks per tick) passes through the bot's body
 * (a column `radius` wide around `target`, the bot's feet, 1.8 tall) within `horizon` ticks.
 * Simulates gravity and drag per tick. Returns the ticks until it gets there and how close it
 * passes, or null when it misses or is not moving.
 */
export function incoming (p: { name?: string, pos: V3, vel: V3 }, target: V3, opts: { radius?: number, height?: number, horizon?: number } = {}): { ticks: number, miss: number } | null {
  const phys = PROJECTILES[p.name ?? 'arrow'] ?? PROJECTILES.arrow!
  const radius = opts.radius ?? 1.0
  const height = opts.height ?? 1.8
  const horizon = opts.horizon ?? 40
  let { x, y, z } = p.pos
  let { x: vx, y: vy, z: vz } = p.vel
  if (Math.hypot(vx, vy, vz) < 0.15) return null // lying in the ground
  let best = Infinity
  let bestT = 0
  for (let t = 1; t <= horizon; t++) {
    // sub-steps: an arrow moves ~3 blocks a tick, the body is 0.6 wide
    for (let s = 1; s <= 4; s++) {
      const f = s / 4
      const px = x + vx * f
      const py = y + vy * f
      const pz = z + vz * f
      const dy = py < target.y ? target.y - py : py > target.y + height ? py - (target.y + height) : 0
      const d = Math.hypot(px - target.x, pz - target.z, dy)
      if (d < best) { best = d; bestT = t - 1 + f }
    }
    x += vx; y += vy; z += vz
    vx *= phys.drag; vy = vy * phys.drag - phys.gravity; vz *= phys.drag
    // past the bot and moving away: stop looking
    if (t > 2 && (x - target.x) * vx + (z - target.z) * vz > 0 && Math.hypot(x - target.x, z - target.z) > 3) break
  }
  return best <= radius ? { ticks: Math.round(bestT * 10) / 10, miss: Math.round(best * 100) / 100 } : null
}

/** Pillager-patrol mobs (pillagers, vindicators, evokers, ravagers) within `radius` of `center`. */
export function patrolCount (mobs: readonly { name: string, pos: V3 }[], center: V3, radius = 24): number {
  let n = 0
  for (const m of mobs) {
    if (ILLAGERS.has(m.name) && Math.hypot(m.pos.x - center.x, m.pos.y - center.y, m.pos.z - center.z) <= radius) n++
  }
  return n
}

// ---- the response ----

export interface ShooterView {
  id: number
  name: string
  /** Distance to the bot, blocks. */
  dist: number
  /** Clear line between the bot's eyes and the mob. */
  los: boolean
  /** Hurt the bot (projectile or melee) in the last few seconds. */
  hurtMe?: boolean
}

export interface RangedState {
  health: number
  /** Armour points worn (iron set = 15). */
  armor: number
  /** A bow or crossbow and arrows. */
  bow: boolean
  shield: boolean
  /** A sword or an axe. */
  melee: boolean
  shooters: readonly ShooterView[]
  /** Pillager-patrol mobs around (patrolCount). */
  patrol: number
  /** A spot behind a block was found nearby. */
  coverNear: boolean
  /** Combat flags: combat.ranged and combat.shield (default on). */
  useBow?: boolean
  useShield?: boolean
  /** Hide whatever the gear, with this reason (asked for cover, or a charge that just failed). */
  hide?: string
}

export type RangedAct = 'shoot' | 'shield_close' | 'charge' | 'cover' | 'retreat'
export interface RangedDecision { act: RangedAct, target: number | null, why: string }

/** Health at or below which the bot stops trading shots and hides or backs off. */
export const RANGED_LOW_HEALTH = 8
/** Shooters (or patrol mobs) from which the bot counts as outnumbered without good gear. */
export const RANGED_OUTNUMBERED = 3
/** Armour points that count as good gear against a patrol (a full iron set). */
export const GOOD_ARMOR = 15

/** The shooters that matter now: those with a line to the bot and those that just hurt it. */
export function activeShooters<T extends ShooterView> (list: readonly T[], range = 24): T[] {
  return list.filter(s => (s.los && s.dist <= range) || s.hurtMe).sort((a, b) => a.dist - b.dist)
}

/**
 * What to do about mobs shooting at the bot, or null when none has a line to it. In order:
 *  - at RANGED_LOW_HEALTH or less: cover when there is some, else back out of range;
 *  - outnumbered (3+ shooters or a patrol of 3+) without good gear (iron armour and a shield): the same;
 *  - a ghast or blaze it can't shoot: cover (or a shield against a blaze);
 *  - a bow or crossbow with arrows: shoot back (the nearest shooter, from 5+ blocks);
 *  - a shield: raise it and close in on the nearest;
 *  - a weapon, health 14+ and at most 2 shooters: charge the nearest in a zig-zag;
 *  - otherwise cover, or back out of range.
 */
export function rangedResponse (s: RangedState): RangedDecision | null {
  const active = activeShooters(s.shooters)
  if (!active.length) return null
  const nearest = active[0]!
  const hide = (why: string): RangedDecision => s.coverNear ? { act: 'cover', target: nearest.id, why } : { act: 'retreat', target: nearest.id, why }
  const bow = s.bow && s.useBow !== false
  const shield = s.shield && s.useShield !== false
  if (s.hide) return hide(s.hide)
  if (s.health <= RANGED_LOW_HEALTH) return hide(`health ${Math.ceil(s.health)}`)
  const many = Math.max(active.length, s.patrol)
  const goodGear = s.armor >= GOOD_ARMOR && shield
  if (many >= RANGED_OUTNUMBERED && !goodGear) return hide(`${many} shooting at me without good gear`)
  if (nearest.name === 'ghast' && !bow) return hide('a ghast and nothing to shoot it with')
  if (nearest.name === 'blaze' && !bow && !shield) return hide('a blaze and no bow or shield')
  if (bow && nearest.dist >= 5) return { act: 'shoot', target: nearest.id, why: `bow against the ${nearest.name}` }
  if (shield) return { act: 'shield_close', target: nearest.id, why: `shield up, closing on the ${nearest.name}` }
  if (s.melee && s.health >= 14 && active.length <= 2 && nearest.name !== 'ghast') return { act: 'charge', target: nearest.id, why: `charging the ${nearest.name}` }
  return hide(`no bow or shield against the ${nearest.name}`)
}

/**
 * Whether to eat now while shooters are around: only out of their sight (behind cover or out of
 * range) and with nothing in flight at the bot, when hurt or hungry enough that food helps.
 */
export function canEatUnderFire (s: { health: number, food: number, hasFood: boolean, exposed: boolean, incoming: boolean }): boolean {
  if (!s.hasFood || s.exposed || s.incoming) return false
  return s.health < 16 || s.food < 18
}

// ---- cover ----

/**
 * Whether the straight line from `a` to `b` passes through a solid block (a voxel walk, Amanatides
 * & Woo). The cells holding the two end points don't count.
 */
export function lineBlocked (a: V3, b: V3, solid: (x: number, y: number, z: number) => boolean): boolean {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const dz = b.z - a.z
  const len = Math.hypot(dx, dy, dz)
  if (len < 1e-6) return false
  let x = Math.floor(a.x)
  let y = Math.floor(a.y)
  let z = Math.floor(a.z)
  const ex = Math.floor(b.x)
  const ey = Math.floor(b.y)
  const ez = Math.floor(b.z)
  const sx = Math.sign(dx)
  const sy = Math.sign(dy)
  const sz = Math.sign(dz)
  const next = (p: number, d: number, s: number) => s > 0 ? (Math.floor(p) + 1 - p) / Math.abs(d) : s < 0 ? (p - Math.floor(p)) / Math.abs(d) : Infinity
  let tx = next(a.x, dx, sx)
  let ty = next(a.y, dy, sy)
  let tz = next(a.z, dz, sz)
  const ddx = sx ? 1 / Math.abs(dx) : Infinity
  const ddy = sy ? 1 / Math.abs(dy) : Infinity
  const ddz = sz ? 1 / Math.abs(dz) : Infinity
  for (let i = 0; i < 256; i++) {
    if (tx <= ty && tx <= tz) { if (tx > 1) break; x += sx; tx += ddx } else if (ty <= tz) { if (ty > 1) break; y += sy; ty += ddy } else { if (tz > 1) break; z += sz; tz += ddz }
    if (x === ex && y === ey && z === ez) return false
    if (solid(x, y, z)) return true
  }
  return false
}

export interface CoverQuery {
  /** The bot's feet. */
  bot: V3
  /** The shooters' eyes. */
  shooters: readonly V3[]
  /** A block that stops arrows (full collision box). */
  solid: (x: number, y: number, z: number) => boolean
  /** The bot can stand with its feet in this cell (feet and head free, solid ground, no liquid). */
  standable: (x: number, y: number, z: number) => boolean
  /** Search radius, blocks. Default 8. */
  radius?: number
  /** Height range searched above and below the bot's feet. Default 2. */
  maxDy?: number
}

/**
 * The nearest spot within `radius` where a solid block is between the bot's head and chest and
 * every shooter's eyes. Cost: distance walked, plus a penalty for walking towards the shooters
 * (and more for ending up closer than 4 blocks to one). Null when there is none.
 */
export function findCover (q: CoverQuery): (V3 & { cost: number }) | null {
  const r = q.radius ?? 8
  const maxDy = q.maxDy ?? 2
  const bx = Math.floor(q.bot.x)
  const by = Math.floor(q.bot.y)
  const bz = Math.floor(q.bot.z)
  if (!q.shooters.length) return null
  const cx = q.shooters.reduce((n, s) => n + s.x, 0) / q.shooters.length
  const cz = q.shooters.reduce((n, s) => n + s.z, 0) / q.shooters.length
  const toward = { x: cx - q.bot.x, z: cz - q.bot.z }
  const tl = Math.hypot(toward.x, toward.z) || 1
  const cands: (V3 & { cost: number })[] = []
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      const flat = Math.hypot(dx, dz)
      if (flat > r) continue
      for (let dy = -maxDy; dy <= maxDy; dy++) {
        const p = { x: bx + dx + 0.5, y: by + dy, z: bz + dz + 0.5 }
        const along = (dx * toward.x + dz * toward.z) / tl // > 0: towards the shooters
        let cost = flat + Math.abs(dy) * 1.5 + Math.max(0, along) * 1.5
        const close = Math.min(...q.shooters.map(s => Math.hypot(s.x - p.x, s.z - p.z)))
        if (close < 4) cost += 10
        cands.push({ ...p, cost })
      }
    }
  }
  cands.sort((a, b) => a.cost - b.cost)
  for (const c of cands) {
    if (!q.standable(Math.floor(c.x), c.y, Math.floor(c.z))) continue
    const head = { x: c.x, y: c.y + 1.62, z: c.z }
    const chest = { x: c.x, y: c.y + 1.0, z: c.z }
    if (q.shooters.every(s => lineBlocked(head, s, q.solid) && lineBlocked(chest, s, q.solid))) return c
  }
  return null
}

/**
 * Where to back off to: `dist` blocks from the bot straight away from the shooters' centre.
 * The caller paths there (or as close as it gets).
 */
export function retreatPoint (bot: V3, shooters: readonly V3[], dist = 20): V3 {
  if (!shooters.length) return { ...bot }
  const cx = shooters.reduce((n, s) => n + s.x, 0) / shooters.length
  const cz = shooters.reduce((n, s) => n + s.z, 0) / shooters.length
  let ax = bot.x - cx
  let az = bot.z - cz
  const l = Math.hypot(ax, az)
  if (l < 0.5) { ax = 1; az = 0 } else { ax /= l; az /= l }
  return { x: bot.x + ax * dist, y: bot.y, z: bot.z + az * dist }
}
