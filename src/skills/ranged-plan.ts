// Pure decisions about mobs that shoot at the bot (no bot, unit-tested): which mobs shoot, whether
// a projectile in flight will hit the bot, how big a pillager patrol is, what to do about the
// shooters given health and a graded gear score (shoot back, shield up and close in, take cover,
// build cover, back off), where the nearest cover is (a spot with a solid block between it and every
// shooter), where to put blocks for cover on open ground, how long to hide and how far to back off.
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
  /** Damage of its best melee weapon (iron sword 6). Default 6 with `melee`, else 1 (fist). */
  weaponDamage?: number
  /** Arrows carried (with `bow`). Default 16 when `bow`. */
  arrows?: number
  shooters: readonly ShooterView[]
  /** Pillager-patrol mobs around (patrolCount). */
  patrol: number
  /** A spot behind a block was found nearby. */
  coverNear: boolean
  /** No cover, but it can build some here (blocks in the inventory, placing allowed, a wall plan fits). */
  canBuild?: boolean
  /** Backing off would still gain distance without passing the retreat cap. Default true. */
  canRetreat?: boolean
  /** Combat flags: combat.ranged and combat.shield (default on). */
  useBow?: boolean
  useShield?: boolean
  /** Hide whatever the gear, with this reason (asked for cover, or a charge that just failed). */
  hide?: string
}

export type RangedAct = 'shoot' | 'shield_close' | 'charge' | 'cover' | 'build' | 'retreat'
export interface RangedDecision { act: RangedAct, target: number | null, why: string }

/** Health at or below which the bot stops trading shots and hides or backs off. */
export const RANGED_LOW_HEALTH = 8
/** Shooters (or patrol mobs) from which the gear score decides between fighting and hiding. */
export const RANGED_OUTNUMBERED = 3
/** Armour points of a full iron set. Kept for callers of the old single threshold; the decision now uses gearScore. */
export const GOOD_ARMOR = 15

// ---- gear score ----

export interface GearView {
  /** Armour points worn (0-20). */
  armor: number
  shield: boolean
  /** Damage of the best melee weapon (fist 1, iron sword 6, netherite sword 8). */
  weaponDamage: number
  /** A bow or crossbow. */
  bow: boolean
  arrows: number
  health: number
}

/** Points each part of the gear is worth at most (they add up to 100). */
export const GEAR_WEIGHTS = { armor: 35, shield: 20, weapon: 15, bow: 15, health: 15 } as const

/**
 * How well equipped the bot is against shooters, 0-100: armour points (35 for a full 20), a
 * shield (20), the best melee weapon's damage (15 at 8+), a bow or crossbow with arrows (15 at
 * 16+ arrows, none without arrows) and health (15 at 20). Iron armour, a shield and an iron
 * sword at full health score about 72; the same with a bow and arrows about 88; a bare-handed
 * bot at full health 17.
 */
export function gearScore (g: GearView): number {
  const w = GEAR_WEIGHTS
  const armor = Math.max(0, Math.min(20, g.armor)) / 20 * w.armor
  const shield = g.shield ? w.shield : 0
  const weapon = Math.max(0, Math.min(8, g.weaponDamage)) / 8 * w.weapon
  const bow = g.bow ? Math.min(16, Math.max(0, g.arrows)) / 16 * w.bow : 0
  const health = Math.max(0, Math.min(20, g.health)) / 20 * w.health
  return Math.round((armor + shield + weapon + bow + health) * 10) / 10
}

/**
 * The gear score needed to stand and fight `n` shooters (or patrol mobs). Below RANGED_OUTNUMBERED
 * nothing is needed (the rest of rangedResponse decides); 3 need 65, and each one more 5 more,
 * so iron, a shield and a sword at full health (72) take on 4, and need a bow for 5 or 6.
 */
export function gearNeeded (n: number): number {
  if (n < RANGED_OUTNUMBERED) return 0
  return 65 + 5 * (n - RANGED_OUTNUMBERED)
}

/** The gear view of a RangedState (filling in the defaults). */
export function gearOf (s: Pick<RangedState, 'armor' | 'shield' | 'bow' | 'melee' | 'weaponDamage' | 'arrows' | 'health' | 'useBow' | 'useShield'>): GearView {
  const bow = s.bow && s.useBow !== false
  return {
    armor: s.armor,
    shield: s.shield && s.useShield !== false,
    weaponDamage: s.weaponDamage ?? (s.melee ? 6 : 1),
    bow,
    arrows: bow ? (s.arrows ?? 16) : 0,
    health: s.health
  }
}

/** The shooters that matter now: those with a line to the bot and those that just hurt it. */
export function activeShooters<T extends ShooterView> (list: readonly T[], range = 24): T[] {
  return list.filter(s => (s.los && s.dist <= range) || s.hurtMe).sort((a, b) => a.dist - b.dist)
}

/**
 * What to do about mobs shooting at the bot, or null when none has a line to it. In order:
 *  - at RANGED_LOW_HEALTH or less: hide (below);
 *  - 3+ shooters (or a patrol of 3+) and a gear score under gearNeeded for that many: hide;
 *  - a ghast or blaze it can't shoot: hide (or a shield against a blaze);
 *  - a bow or crossbow with arrows: shoot back (the nearest shooter, from 5+ blocks);
 *  - a shield: raise it and close in on the nearest;
 *  - a weapon, health 14+ and at most 2 shooters: charge the nearest in a zig-zag;
 *  - otherwise hide.
 * Hiding means cover when there is some nearby, else building cover when it can, else backing
 * off; when backing off would pass the retreat cap (canRetreat false) it stands its ground with
 * the bow, shield or weapon it has, except at RANGED_LOW_HEALTH or less, where it backs off anyway.
 */
export function rangedResponse (s: RangedState): RangedDecision | null {
  const active = activeShooters(s.shooters)
  if (!active.length) return null
  const nearest = active[0]!
  const bow = s.bow && s.useBow !== false
  const shield = s.shield && s.useShield !== false
  const hide = (why: string): RangedDecision => {
    if (s.coverNear) return { act: 'cover', target: nearest.id, why }
    if (s.canBuild) return { act: 'build', target: nearest.id, why }
    // at the cap it stands its ground, unless it is about to die: then it keeps running (the caller allows a little more)
    if (s.canRetreat === false && s.health > RANGED_LOW_HEALTH) {
      if (bow && nearest.dist >= 5) return { act: 'shoot', target: nearest.id, why: `${why}, nowhere left to back off` }
      if (shield) return { act: 'shield_close', target: nearest.id, why: `${why}, nowhere left to back off` }
      if (s.melee && s.health > RANGED_LOW_HEALTH && nearest.name !== 'ghast') return { act: 'charge', target: nearest.id, why: `${why}, nowhere left to back off` }
    }
    return { act: 'retreat', target: nearest.id, why }
  }
  if (s.hide) return hide(s.hide)
  if (s.health <= RANGED_LOW_HEALTH) return hide(`health ${Math.ceil(s.health)}`)
  const many = Math.max(active.length, s.patrol)
  const need = gearNeeded(many)
  if (need) {
    const score = gearScore(gearOf(s))
    if (score < need) return hide(`${many} shooting at me, gear ${Math.round(score)} of ${need} needed`)
  }
  if (nearest.name === 'ghast' && !bow) return hide('a ghast and nothing to shoot it with')
  if (nearest.name === 'blaze' && !bow && !shield) return hide('a blaze and no bow or shield')
  if (bow && nearest.dist >= 5) return { act: 'shoot', target: nearest.id, why: `bow against the ${nearest.name}` }
  if (shield) return { act: 'shield_close', target: nearest.id, why: `shield up, closing on the ${nearest.name}` }
  if (s.melee && s.health >= 14 && active.length <= 2 && nearest.name !== 'ghast') return { act: 'charge', target: nearest.id, why: `charging the ${nearest.name}` }
  return hide(`no bow or shield against the ${nearest.name}`)
}

// ---- how long to hide ----

/**
 * After a fight against shooters went badly (it had to back off to heal, was outnumbered or gave
 * up): how long to keep hiding before fighting again. Short when healthy (3 s at 16+), up to 15 s
 * at 8 or less.
 */
export function hideMs (health: number): number {
  if (health >= 16) return 3000
  if (health >= 12) return 6000
  if (health > RANGED_LOW_HEALTH) return 10_000
  return 15_000
}

/** Whether the "last fight went badly" hiding still applies: until it runs out, or at once when healthy (16+) and no shooter can see the bot. */
export function stillHiding (s: { until: number, now: number, health: number, seen: boolean }): boolean {
  if (s.now >= s.until) return false
  return !(s.health >= 16 && !s.seen)
}

/** Longest stay behind one cover spot, by health: 4 s at 16+, 8 s at 12+, 15 s below. */
export function coverHoldMs (health: number): number {
  if (health >= 16) return 4000
  if (health >= 12) return 8000
  return 15_000
}

/**
 * Whether to leave cover now. Not while a shooter sees it (the caller looks for other cover then);
 * yes when every shooter is gone, when healthy (16+) with nothing shooting at it, or when the hold
 * time for its health (coverHoldMs) has run out.
 */
export function leaveCover (s: { health: number, heldMs: number, seen: boolean, shooters: number, underFire: boolean }): boolean {
  if (s.seen) return false
  if (!s.shooters) return true
  if (!s.underFire && s.health >= 16) return true
  return s.heldMs >= coverHoldMs(s.health)
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

/** How far from where the trouble started the bot backs off at most (blocks). */
export const RETREAT_CAP = 24

/**
 * Where to back off to, capped: retreatPoint, pulled in so it stays within `cap` blocks
 * (horizontally) of `origin`, where the bot was when the shooting started. Null when that gains
 * less than 2 blocks or doesn't get further from the shooters: the bot is at the cap, and should
 * hide, build cover or stand its ground instead of running on.
 */
export function cappedRetreat (origin: V3, bot: V3, shooters: readonly V3[], dist = 20, cap = RETREAT_CAP): V3 | null {
  if (!shooters.length) return null
  let p = retreatPoint(bot, shooters, dist)
  const vx = p.x - origin.x
  const vz = p.z - origin.z
  const l = Math.hypot(vx, vz)
  if (l > cap) p = { x: origin.x + vx / l * cap, y: p.y, z: origin.z + vz / l * cap }
  if (Math.hypot(p.x - bot.x, p.z - bot.z) < 2) return null
  const cx = shooters.reduce((n, s) => n + s.x, 0) / shooters.length
  const cz = shooters.reduce((n, s) => n + s.z, 0) / shooters.length
  if (Math.hypot(p.x - cx, p.z - cz) <= Math.hypot(bot.x - cx, bot.z - cz) + 1) return null
  return p
}

// ---- building cover ----

export interface WallQuery {
  /** The bot's feet (fractional: its body can overlap a neighbouring cell). */
  bot: V3
  /** The shooters' eyes. */
  shooters: readonly V3[]
  /** A block that stops arrows (full collision box). */
  solid: (x: number, y: number, z: number) => boolean
  /** A block may go in this cell: loaded, empty or replaceable, not lava, not in a protected area. */
  placeable: (x: number, y: number, z: number) => boolean
  /** Most blocks to place (wall and pillar). Default 6. */
  maxBlocks?: number
  /** Highest pillar to consider, 0-2. Default 2. */
  maxPillar?: number
}

export interface WallPlan {
  /** Cells to fill, in placing order (pillar blocks first, each block placed against one already there). */
  blocks: V3[]
  /** How many of `blocks` are the pillar under the bot (0: it builds where it stands). */
  pillar: number
  /** Where its feet end up. */
  stand: V3
  /** Blocks plus 2 per pillar block (jumping and placing under itself takes longer). */
  cost: number
}

const key = (x: number, y: number, z: number) => `${x},${y},${z}`
const FACES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const

/**
 * Where to put blocks so the bot is covered from every shooter where it stands (open ground, no
 * cover to walk to): a wall in the cells around it, 1 wide and usually 2 high (the head and chest
 * lines run through the layer above the feet, the block below holds it up), or the same on top of
 * a 1-2 block pillar when that is cheaper or the ground around it won't take blocks. Cells the
 * bot's body overlaps are never used (the next ring out is, then). A greedy cover of the sight lines (head and chest to each
 * shooter's eyes): each pick is the cell that blocks the most lines still open. Null when no plan
 * within maxBlocks covers every line.
 */
export function planWall (q: WallQuery): WallPlan | null {
  if (!q.shooters.length) return null
  const maxBlocks = q.maxBlocks ?? 6
  const maxPillar = Math.max(0, Math.min(2, q.maxPillar ?? 2))
  const bx = Math.floor(q.bot.x)
  const by = Math.floor(q.bot.y)
  const bz = Math.floor(q.bot.z)
  let best: WallPlan | null = null
  for (let h = 0; h <= maxPillar; h++) {
    const pillar: V3[] = []
    let ok = true
    for (let i = 0; i < h; i++) {
      if (!q.placeable(bx, by + i, bz)) { ok = false; break }
      pillar.push({ x: bx, y: by + i, z: bz })
    }
    // head room on top of the pillar (feet and head cells free)
    if (h > 0 && (q.solid(bx, by + h, bz) || q.solid(bx, by + h + 1, bz))) ok = false
    if (!ok) continue
    const wall = wallAt(q, { x: q.bot.x, y: by + h, z: q.bot.z }, pillar, maxBlocks - h)
    if (!wall) continue
    const plan: WallPlan = { blocks: [...pillar, ...wall], pillar: h, stand: { x: bx + 0.5, y: by + h, z: bz + 0.5 }, cost: wall.length + 2 * h }
    if (!best || plan.cost < best.cost) best = plan
  }
  return best
}

function wallAt (q: WallQuery, feet: V3, pillar: readonly V3[], budget: number): V3[] | null {
  const fx = Math.floor(feet.x)
  const fy = feet.y
  const fz = Math.floor(feet.z)
  const placed = new Set(pillar.map(p => key(p.x, p.y, p.z)))
  const solidNow = (x: number, y: number, z: number) => q.solid(x, y, z) || placed.has(key(x, y, z))
  const rays: { a: V3, b: V3 }[] = []
  for (const s of q.shooters) {
    for (const dy of [1.62, 1.0]) {
      const a = { x: feet.x, y: fy + dy, z: feet.z }
      if (!lineBlocked(a, s, solidNow)) rays.push({ a, b: s })
    }
  }
  if (!rays.length) return []
  // the bot's body: 0.6 wide, feet and head layers
  const overlapsBody = (x: number, y: number, z: number) => (y === fy || y === fy + 1) &&
    x < feet.x + 0.3 && x + 1 > feet.x - 0.3 && z < feet.z + 0.3 && z + 1 > feet.z - 0.3
  const cands: V3[] = []
  // the cells around it, and one ring further for when its body pokes into a neighbouring cell
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      for (let dy = -1; dy <= 2; dy++) {
        if (dx === 0 && dz === 0 && dy !== 2) continue // own column: only a roof over the head
        const c = { x: fx + dx, y: fy + dy, z: fz + dz }
        if (overlapsBody(c.x, c.y, c.z) || solidNow(c.x, c.y, c.z) || !q.placeable(c.x, c.y, c.z)) continue
        cands.push(c)
      }
    }
  }
  // which open lines each candidate blocks
  const blocks = cands.map(c => rays.map(r => lineBlocked(r.a, r.b, (x, y, z) => x === c.x && y === c.y && z === c.z)))
  const open = new Set(rays.map((_, i) => i))
  const chosen: V3[] = []
  const used = new Set<number>()
  while (open.size) {
    let bi = -1
    let bn = 0
    let bTie = Infinity
    for (let i = 0; i < cands.length; i++) {
      if (used.has(i)) continue
      let n = 0
      for (const r of open) if (blocks[i]![r]) n++
      const c = cands[i]!
      // ties: the nearest ring first, then the chest/head layer, then the side cells over the corners
      const ring = Math.max(Math.abs(c.x - fx), Math.abs(c.z - fz))
      const tie = ring * 2 + Math.abs(c.y - (fy + 0.5)) + (c.x !== fx && c.z !== fz ? 0.25 : 0)
      if (n > bn || (n === bn && n > 0 && tie < bTie)) { bi = i; bn = n; bTie = tie }
    }
    if (bi < 0) return null
    used.add(bi)
    chosen.push(cands[bi]!)
    for (const r of [...open]) if (blocks[bi]![r]) open.delete(r)
    if (chosen.length > budget) return null
  }
  // placing order: each block against something solid; a floating one gets the cell below it first
  const order: V3[] = []
  const has = (x: number, y: number, z: number) => solidNow(x, y, z) || order.some(o => o.x === x && o.y === y && o.z === z)
  const supported = (c: V3) => FACES.some(([dx, dy, dz]) => has(c.x + dx, c.y + dy, c.z + dz))
  const pending = [...chosen].sort((a, b) => a.y - b.y)
  for (let guard = 0; pending.length && guard < 16; guard++) {
    const i = pending.findIndex(supported)
    if (i >= 0) { order.push(pending.splice(i, 1)[0]!); continue }
    const c = pending[0]!
    const below = { x: c.x, y: c.y - 1, z: c.z }
    if (overlapsBody(below.x, below.y, below.z) || has(below.x, below.y, below.z) || !q.placeable(below.x, below.y, below.z) || !supported(below)) return null
    order.push(below)
  }
  if (pending.length || order.length > budget) return null
  return order
}
