// Dodging, planned (no bot, unit-tested in test/dodge-plan.test.ts). dodge.ts reads the world
// into these and turns the answers into leaps; fight.ts calls it once per tick from the movement
// part of the loop. Settings: settings.combat.dodge (live: !config_set combat.dodge.*).
//
// Vanilla only sprints forward, but a bot turns in one tick: a leap is "face the way to go,
// sprint, jump, snap back to the target". It covers about 1.5 blocks in 6 ticks, which is what
// gets the 0.6-wide body out of an arrow's path or out of a zombie's reach.
//
// Techniques (DODGE_TECHNIQUES, a list: add one there, nothing in the loop changes):
//   draws        an archer close by is about to let go (skeleton bow drawn ~20 ticks, a pillager's
//                crossbow charged): leap just before the release, so the shot goes where it was
//   arrows       a projectile in flight will hit the hitbox (ballistic check, the bot's own
//                motion included): leap to the side that clears it in time
//   meleeTiming  each melee mob's attack cooldown (20 ticks for zombies) from its swings and the
//                hits taken: stand in while it recharges, be out of its reach before it is ready
// The creeper leap (sprint-jumping away from a lit fuse instead of walking) is not a per-tick
// technique: fight.ts runs it where tactics.creeperMove says to back off.
// Every leap is checked first (landingProblem): no water, lava, fire, powder snow, wall, or a
// drop deeper than maxDrop on the way or where it comes down.

import { z } from 'zod'

export interface V3 { x: number, y: number, z: number }
export interface V2 { x: number, z: number }

// ---- settings ----

/** settings.combat.dodge (profile `settings: combat: dodge:`, live with config_set combat.dodge.*). */
export interface DodgeSettings {
  /** Master switch for the whole dodge layer. Default true. */
  enabled: boolean
  /** Leap when an archer close by is about to release (bow drawn, crossbow charged). Default true. */
  draws: boolean
  /** Leap out of the path of a projectile in flight that would hit. Default true. */
  arrows: boolean
  /** Track melee mobs' attack cooldowns: stand in while they recharge, get out before they swing. Default true. */
  meleeTiming: boolean
  /** Sprint-jump away from a lit creeper instead of walking. Default true. */
  creeperLeap: boolean
  /** Round trip to the server, ms: what the bot sees is this old, and its moves land this late. Default 75. */
  latencyMs: number
  /** Within this many blocks react to the draw (the arrow is too fast to see coming); beyond it, to the arrow. Default 10. */
  drawRange: number
  /** Extra room around the hitbox when judging whether a projectile hits, blocks. Default 0.15. */
  arrowMargin: number
  /** How long a leap faces away before snapping back to the target, ms. Default 200. */
  leapMs: number
  /** How far along a leap the ground is checked, blocks. Default 2.5. */
  leapDistance: number
  /** Deepest drop a leap may land in, blocks. Default 2. */
  maxDrop: number
  /** Blocks beyond a melee mob's reach to be at when its next swing is ready. Default 0.35. */
  meleeMargin: number
  /** Be out of reach this long before a melee mob's next swing, ms (on top of latencyMs). Default 150. */
  meleeLeadMs: number
  /** Attack cooldown of melee mobs not in the table, ms (zombies and most others: 20 ticks). Default 1000. */
  meleeCooldownMs: number
  /** Longest the creeper leap keeps sprint-jumping away, ms; it stops sooner once the fuse is out or the creeper is 7.2 blocks off. Default 1500. */
  creeperLeapMs: number
  /** Shortest gap between two leaps, ms (a leap that just ended needs its landing). Default 300. */
  minGapMs: number
}

export const DODGE_DEFAULTS: DodgeSettings = {
  enabled: true,
  draws: true,
  arrows: true,
  meleeTiming: true,
  creeperLeap: true,
  latencyMs: 75,
  drawRange: 10,
  arrowMargin: 0.15,
  leapMs: 200,
  leapDistance: 2.5,
  maxDrop: 2,
  meleeMargin: 0.35,
  meleeLeadMs: 150,
  meleeCooldownMs: 1000,
  creeperLeapMs: 1500,
  minGapMs: 300
}

const bool = z.boolean()
/** Per-key schemas (the live toggles in core/toggles.ts use the same bounds). */
export const DODGE_SCHEMA: { [K in keyof DodgeSettings]: z.ZodType } = {
  enabled: bool,
  draws: bool,
  arrows: bool,
  meleeTiming: bool,
  creeperLeap: bool,
  latencyMs: z.number().min(0).max(500),
  drawRange: z.number().min(0).max(32),
  arrowMargin: z.number().min(0).max(1),
  leapMs: z.number().min(50).max(600),
  leapDistance: z.number().min(1).max(5),
  maxDrop: z.number().int().min(0).max(4),
  meleeMargin: z.number().min(0).max(2),
  meleeLeadMs: z.number().min(0).max(1000),
  meleeCooldownMs: z.number().min(250).max(3000),
  creeperLeapMs: z.number().min(0).max(3000),
  minGapMs: z.number().min(0).max(2000)
}

/** settings.combat.dodge over the defaults; values that fail their schema fall back to the default. `dodge: false` turns it off. */
export function dodgeSettings (raw: unknown): DodgeSettings {
  if (raw === false) return { ...DODGE_DEFAULTS, enabled: false }
  const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const out: DodgeSettings = { ...DODGE_DEFAULTS }
  for (const k of Object.keys(DODGE_DEFAULTS) as (keyof DodgeSettings)[]) {
    if (o[k] === undefined) continue
    const r = DODGE_SCHEMA[k].safeParse(o[k])
    if (r.success) (out as unknown as Record<string, unknown>)[k] = r.data
  }
  return out
}

// ---- movement model ----

export const TICK_MS = 50
/** Half the player's width (0.6) and its height. */
export const BODY_HALF = 0.3
export const BODY_HEIGHT = 1.8

/**
 * Horizontal distance a sprint-jump covers in `ticks` (from standing, 1.21 physics on normal
 * ground): the jump tick moves ~0.33 (sprint plus the 0.2 jump boost), then the air keeps
 * 91% a tick, plus a little air acceleration while forward is still held (`holdTicks`).
 */
export function leapTravel (ticks: number, holdTicks = 4): number {
  let d = 0
  let v = 0
  for (let t = 1; t <= Math.floor(ticks); t++) {
    if (t === 1) { d += 0.33; v = 0.18; continue }
    v = v * 0.91 + (t <= holdTicks ? 0.026 : 0)
    d += v
  }
  return d
}

/** Horizontal distance walking (back or sideways, no sprint) covers in `ticks` from standing: ~0.1, then towards 0.216 a tick. */
export function walkTravel (ticks: number): number {
  let d = 0
  let v = 0
  for (let t = 1; t <= Math.floor(ticks); t++) {
    v = v * 0.546 + 0.098
    d += v
  }
  return d
}

/** Mineflayer yaw of a horizontal direction (yaw 0 faces -z, forward = (-sin yaw, -cos yaw)). */
export function yawOf (d: V2): number {
  return Math.atan2(-d.x, -d.z)
}

export function unit (d: V2): V2 {
  const l = Math.hypot(d.x, d.z)
  return l < 1e-9 ? { x: 0, z: 0 } : { x: d.x / l, z: d.z / l }
}

// ---- landing check ----

/** What a block cell is, for a leap. */
export type Cell = 'air' | 'solid' | 'water' | 'lava' | 'fire' | 'powder_snow' | 'danger' | 'unknown'

/** Block name to Cell (danger: magma, cactus, berry bushes, wither roses, campfires). */
export function cellOf (name: string | undefined | null, solid: boolean): Cell {
  if (!name) return 'unknown'
  if (/^(water|bubble_column)$/.test(name) || /kelp|seagrass/.test(name)) return 'water'
  if (name === 'lava') return 'lava'
  if (/^(soul_)?fire$/.test(name)) return 'fire'
  if (name === 'powder_snow') return 'powder_snow'
  if (/^(magma_block|cactus|sweet_berry_bush|wither_rose|(soul_)?campfire|pointed_dripstone)$/.test(name)) return 'danger'
  return solid ? 'solid' : 'air'
}

/**
 * Why a leap from `from` (feet, block coordinates as numbers) along `dir` for `dist` blocks is
 * not safe, or null when it is. `look(x, y, z)` gives the cell at integer coordinates. Checks every
 * ~0.3 blocks along the way: feet and head cells must be air (a wall stops the leap; one block up
 * counts as a wall too, a sprint-jump onto it is not worth the risk), nothing that hurts or slows
 * (water, lava, fire, powder snow), and the ground under each point no deeper than `maxDrop`.
 */
export function landingProblem (look: (x: number, y: number, z: number) => Cell, from: V3, dir: V2, dist: number, maxDrop: number): string | null {
  const u = unit(dir)
  if (!u.x && !u.z) return 'no direction'
  const fy = Math.floor(from.y + 0.01)
  const steps = Math.max(1, Math.ceil(dist / 0.3))
  for (let i = 1; i <= steps; i++) {
    const f = (i / steps) * dist
    const x = Math.floor(from.x + u.x * f)
    const z = Math.floor(from.z + u.z * f)
    for (const dy of [0, 1, 2]) {
      const c = look(x, fy + dy, z)
      if (c === 'unknown') return 'unloaded'
      if (c === 'lava') return 'lava'
      if (c === 'fire' || c === 'danger') return 'fire or a block that hurts'
      if (c === 'powder_snow') return 'powder snow'
      if (c === 'water' && dy < 2) return 'water'
      if (c === 'solid' && dy < 2) return 'wall'
    }
    // the ground: the first non-air cell below the feet, no deeper than maxDrop
    let ground = -1
    for (let dy = 1; dy <= maxDrop + 1; dy++) {
      const c = look(x, fy - dy, z)
      if (c === 'unknown') return 'unloaded'
      if (c === 'air') continue
      if (c === 'lava') return 'lava below'
      if (c === 'water') return 'water below'
      if (c === 'fire' || c === 'danger' || c === 'powder_snow') return 'bad ground'
      ground = dy
      break
    }
    if (ground < 0) return `a drop deeper than ${maxDrop}`
  }
  return null
}

// ---- side choice ----

export interface SideCandidate {
  /** Direction to leap, horizontal unit vector. */
  dir: V2
  /** Blocks it has to move this way to be clear (Infinity: it can't clear). */
  need: number
  /** Blocks it can move this way in the time there is. */
  can: number
  /** The landing check passed. */
  safe: boolean
  /** Hostiles near where it would land (crowding the landing is worse). */
  crowd?: number
}

/**
 * Picks one of the sides to leap to: only safe sides that clear in time; of those, the one with
 * fewer mobs where it lands, and between equal ones at random (`rnd`), so the side is not
 * predictable. `lastSides` (the side indexes picked last, newest last) keeps it from going the
 * same way three times running when the other side is just as good. Returns the index or -1.
 */
export function pickSide (cands: readonly SideCandidate[], rnd: () => number, lastSides: readonly number[] = []): number {
  const ok = cands.map((c, i) => ({ c, i })).filter(x => x.c.safe && x.c.can >= x.c.need)
  if (!ok.length) return -1
  const least = Math.min(...ok.map(x => x.c.crowd ?? 0))
  let best = ok.filter(x => (x.c.crowd ?? 0) === least)
  if (best.length > 1 && lastSides.length >= 2) {
    const a = lastSides[lastSides.length - 1]
    const b = lastSides[lastSides.length - 2]
    if (a === b) {
      const other = best.filter(x => x.i !== a)
      if (other.length) best = other
    }
  }
  return best[Math.min(best.length - 1, Math.floor(rnd() * best.length))]!.i
}

// ---- projectiles ----

/** Projectile physics per tick (move, then velocity *= drag, then vy -= gravity) and half size. */
export const PROJECTILE_PHYSICS: Record<string, { gravity: number, drag: number, half: number }> = {
  arrow: { gravity: 0.05, drag: 0.99, half: 0.25 },
  spectral_arrow: { gravity: 0.05, drag: 0.99, half: 0.25 },
  trident: { gravity: 0.05, drag: 0.99, half: 0.25 },
  small_fireball: { gravity: 0, drag: 1, half: 0.156 },
  fireball: { gravity: 0, drag: 1, half: 0.5 },
  wither_skull: { gravity: 0, drag: 1, half: 0.156 },
  llama_spit: { gravity: 0.06, drag: 0.99, half: 0.125 },
  splash_potion: { gravity: 0.05, drag: 0.99, half: 0.125 },
  potion: { gravity: 0.05, drag: 0.99, half: 0.125 }
}

export interface ProjectileView { id: number, name: string, pos: V3, vel: V3 }
export interface BodyView {
  /** Feet, centre of the hitbox. */
  pos: V3
  /** Blocks per tick. Only the horizontal part is used (where the body will be when it arrives). */
  vel?: V3
  half?: number
  height?: number
}

export interface ProjectileHit {
  /** Ticks until it enters the hitbox. */
  ticks: number
  /** Unit vector perpendicular to its horizontal flight, to its left. */
  side: V2
  /** Where it crosses, relative to the body centre along `side` (positive: left of the centre). */
  offset: number
  /** Half the hitbox (inflated by the projectile and the margin) measured along `side`. */
  extent: number
}

/**
 * Whether a projectile will hit the body: simulates it tick by tick (4 sub-steps, an arrow moves
 * up to 3 blocks a tick) against the body's box, inflated by the projectile's half size and
 * `margin`, with the body moving at its current horizontal velocity. Null when it misses, is
 * lying still, or is moving away.
 */
export function projectileHit (p: ProjectileView, body: BodyView, opts: { margin?: number, horizon?: number } = {}): ProjectileHit | null {
  const phys = PROJECTILE_PHYSICS[p.name] ?? PROJECTILE_PHYSICS.arrow!
  const speed = Math.hypot(p.vel.x, p.vel.y, p.vel.z)
  if (speed < 0.15) return null
  const horiz = Math.hypot(p.vel.x, p.vel.z)
  if (horiz < 1e-3) return null
  const half = (body.half ?? BODY_HALF) + phys.half + (opts.margin ?? 0)
  const height = body.height ?? BODY_HEIGHT
  const bv = body.vel ?? { x: 0, y: 0, z: 0 }
  const side = { x: -p.vel.z / horiz, z: p.vel.x / horiz } // left of the flight, looking along it (yaw convention irrelevant here)
  let { x, y, z } = p.pos
  let { x: vx, y: vy, z: vz } = p.vel
  const horizon = opts.horizon ?? 40
  for (let t = 1; t <= horizon; t++) {
    for (let s = 1; s <= 4; s++) {
      const f = s / 4
      const tt = t - 1 + f
      const px = x + vx * f
      const py = y + vy * f
      const pz = z + vz * f
      const bx = body.pos.x + bv.x * tt
      const bz = body.pos.z + bv.z * tt
      if (Math.abs(px - bx) <= half && Math.abs(pz - bz) <= half && py >= body.pos.y - phys.half && py <= body.pos.y + height + phys.half) {
        const offset = (px - bx) * side.x + (pz - bz) * side.z
        const extent = half * (Math.abs(side.x) + Math.abs(side.z)) // the box's half extent along `side`
        return { ticks: Math.round(tt * 100) / 100, side, offset, extent }
      }
    }
    x += vx; y += vy; z += vz
    vx *= phys.drag; vy = vy * phys.drag - phys.gravity; vz *= phys.drag
    const rx = x - body.pos.x
    const rz = z - body.pos.z
    if (t > 1 && rx * vx + rz * vz > 0 && Math.hypot(rx, rz) > 2) return null // past and moving away
  }
  return null
}

/**
 * Where a projectile is `ticks` after it was seen at `p` (same physics as projectileHit). The
 * server sends arrow positions rarely (every 20 ticks), so the glue keeps the last seen state and
 * moves it forward itself.
 */
export function advanceProjectile (p: ProjectileView, ticks: number): ProjectileView {
  const phys = PROJECTILE_PHYSICS[p.name] ?? PROJECTILE_PHYSICS.arrow!
  let { x, y, z } = p.pos
  let { x: vx, y: vy, z: vz } = p.vel
  const whole = Math.max(0, Math.floor(ticks))
  for (let t = 0; t < whole; t++) {
    x += vx; y += vy; z += vz
    vx *= phys.drag; vy = vy * phys.drag - phys.gravity; vz *= phys.drag
  }
  const f = Math.max(0, ticks - whole)
  return { ...p, pos: { x: x + vx * f, y: y + vy * f, z: z + vz * f }, vel: { x: vx, y: vy, z: vz } }
}

/** Blocks to move along +side (index 0) and -side (index 1) to be clear of a hit. */
export function clearance (h: ProjectileHit): [number, number] {
  return [Math.max(0, h.offset + h.extent), Math.max(0, h.extent - h.offset)]
}

// ---- archers ----

/** A skeleton fires when its bow has been drawn 20 ticks. */
export const BOW_DRAW_MS = 1000
/** A pillager waits 20 to 39 ticks with a charged crossbow before it fires. */
export const CROSSBOW_WAIT_MS: [number, number] = [1000, 2000]
export const BOW_USERS = new Set(['skeleton', 'stray', 'bogged'])

export interface ArcherView {
  id: number
  name: string
  pos: V3
  dist: number
  /** Clear line from it to the bot. */
  los: boolean
  /** ms since it raised its bow (hand active), or null while it isn't drawing. */
  drawingMs: number | null
  /** ms since its crossbow finished charging, or null when it isn't charged. */
  chargedMs: number | null
}

/**
 * When the archer lets go, ms from now: [earliest, latest], or null when it isn't about to.
 * Skeletons fire 20 ticks into the draw; a pillager 20 to 39 ticks after the crossbow is charged.
 */
export function releaseWindow (a: ArcherView): [number, number] | null {
  if (!a.los) return null
  if (BOW_USERS.has(a.name) && a.drawingMs !== null) {
    const t = BOW_DRAW_MS - a.drawingMs
    return t < -300 ? null : [t, t]
  }
  if (a.name === 'pillager' && a.chargedMs !== null) {
    const lo = CROSSBOW_WAIT_MS[0] - a.chargedMs
    const hi = CROSSBOW_WAIT_MS[1] - a.chargedMs
    return hi < -300 ? null : [lo, hi]
  }
  return null
}

// ---- melee mobs ----

/** Vanilla 1.21: a mob's attack box is its own box grown by sqrt(2.04) - 0.6 sideways. */
export const MOB_REACH_GROW = Math.sqrt(2.04) - 0.6

/**
 * How far (per axis, centre to centre: the boxes are axis-aligned, so diagonally it reaches
 * further) a melee mob of this width hits a player. Zombie 0.6 wide: 1.43 along an axis, 2.02
 * on the diagonal.
 */
export function mobReach (width: number, botHalf = BODY_HALF): number {
  return width / 2 + MOB_REACH_GROW + botHalf
}

/** Attack cooldown of a melee mob, ms (MeleeAttackGoal: 20 ticks). */
const MELEE_COOLDOWN: Record<string, number> = {
  slime: 500, magma_cube: 500, iron_golem: 1000, ravager: 2000, warden: 1000, hoglin: 1000, zoglin: 1000
}
export function meleeCooldownMs (name: string, fallback = DODGE_DEFAULTS.meleeCooldownMs): number {
  return MELEE_COOLDOWN[name] ?? fallback
}

export interface AttackerView {
  id: number
  name: string
  /** Its position minus the bot's, horizontal. */
  dx: number
  dz: number
  /** Height difference (its feet minus the bot's). Mobs more than 2 above or below can't reach. */
  dy?: number
  width: number
  /** ms since it last swung at (or hurt) the bot, null: never seen (assume ready). */
  sinceSwingMs: number | null
  cooldownMs: number
}

export type MeleeMove = { act: 'hold' } | { act: 'back', from: number } | { act: 'leap', from: number, dir: V2 }

/**
 * What to do about the melee mobs in reach this tick, or null for no opinion (the loop's spacing).
 * A mob that swung less than its cooldown ago can't hit again yet: while every close mob is in that
 * window the answer is 'hold' (stand in, crit, don't back off). A mob whose swing is ready (or will
 * be within latency + lead) and that has, or will have, the bot inside its reach plus the margin:
 * get out, walking back if a walk covers the gap in the time left, else a leap along the axis that
 * gets out of its (axis-aligned) reach soonest.
 */
export function meleeTiming (mobs: readonly AttackerView[], s: Pick<DodgeSettings, 'latencyMs' | 'meleeLeadMs' | 'meleeMargin'>): MeleeMove | null {
  let worst: { m: AttackerView, gap: number, left: number } | null = null
  let free = false
  for (const m of mobs) {
    if (Math.abs(m.dy ?? 0) > 2) continue
    const reach = mobReach(m.width) + s.meleeMargin
    const cheb = Math.max(Math.abs(m.dx), Math.abs(m.dz))
    if (cheb > reach + 1.5) continue // not close enough to matter this second
    const readyIn = m.sinceSwingMs === null ? 0 : m.cooldownMs - m.sinceSwingMs
    const left = readyIn - s.latencyMs - s.meleeLeadMs // time to get out before it can swing
    // walking straight back (away from it, the way the bot faces) leaves its box along the dominant axis
    const away = unit({ x: -m.dx, z: -m.dz })
    const gap = (reach - cheb) / (Math.max(Math.abs(away.x), Math.abs(away.z)) || 1)
    if (gap <= 0) continue // out of reach: fine either way
    if (left > walkMs(gap)) { free = true; continue } // in its free window: no hurry
    if (!worst || left < worst.left || (left === worst.left && gap > worst.gap)) worst = { m, gap, left }
  }
  if (!worst) return free ? { act: 'hold' } : null
  const { m, gap, left } = worst
  const ticks = Math.max(1, Math.floor(Math.max(0, left + s.meleeLeadMs) / TICK_MS))
  if (walkTravel(ticks) >= gap) return { act: 'back', from: m.id }
  const dir = Math.abs(m.dx) >= Math.abs(m.dz) ? { x: -Math.sign(m.dx) || 1, z: 0 } : { x: 0, z: -Math.sign(m.dz) || 1 }
  return { act: 'leap', from: m.id, dir }
}

/** ms a walk needs to cover `gap` blocks (from standing). */
function walkMs (gap: number): number {
  for (let t = 1; t <= 40; t++) if (walkTravel(t) >= gap) return t * TICK_MS
  return 40 * TICK_MS
}

// ---- the registry ----

export interface DodgeView {
  now: number
  /** The bot's feet and velocity (blocks per tick). */
  body: BodyView & { vel: V3 }
  /** Bot facing (towards its target), mineflayer yaw. */
  yaw: number
  onGround: boolean
  projectiles: readonly ProjectileView[]
  archers: readonly ArcherView[]
  attackers: readonly AttackerView[]
  /** Landing check for a leap this way (dodge.ts wires landingProblem to the world). */
  safe: (dir: V2) => boolean
  /** Hostiles near where a leap this way lands. */
  crowd?: (dir: V2) => number
  rnd: () => number
  /** Side indexes of the last leaps (see pickSide). */
  lastSides: readonly number[]
  /** Projectile ids and archer draws already dodged (`p:<id>`, `d:<id>:<start>`). */
  handled: ReadonlySet<string>
}

export type DodgeIntent =
  | { kind: 'leap', technique: string, dir: V2, side: number, reason: string, key?: string, arrow?: boolean }
  | { kind: 'back', technique: string, reason: string }
  | { kind: 'hold', technique: string }

export interface DodgeTechnique {
  /** Name, and the settings key that turns it on and off. */
  name: string
  key: keyof DodgeSettings
  /** Works away from melee too (while walking to cover or backing out of range). */
  ranged?: boolean
  plan: (v: DodgeView, s: DodgeSettings) => DodgeIntent | null
}

/** Perpendicular sides to a direction: index 0 its left, 1 its right. */
function sidesOf (d: V2): [V2, V2] {
  const u = unit(d)
  return [{ x: -u.z, z: u.x }, { x: u.z, z: -u.x }]
}

const arrows: DodgeTechnique = {
  name: 'arrows',
  key: 'arrows',
  ranged: true,
  plan (v, s) {
    let best: { h: ProjectileHit, p: ProjectileView } | null = null
    for (const p of v.projectiles) {
      if (v.handled.has(`p:${p.id}`)) continue
      const h = projectileHit(p, v.body, { margin: s.arrowMargin })
      if (h && (!best || h.ticks < best.h.ticks)) best = { h, p }
    }
    if (!best) return null
    const { h, p } = best
    const ticks = h.ticks - s.latencyMs / TICK_MS
    const [needL, needR] = clearance(h)
    const can = leapTravel(ticks)
    const cands: SideCandidate[] = [
      { dir: h.side, need: needL, can, safe: v.safe(h.side), crowd: v.crowd?.(h.side) },
      { dir: { x: -h.side.x, z: -h.side.z }, need: needR, can, safe: false, crowd: 0 }
    ]
    cands[1]!.safe = v.safe(cands[1]!.dir)
    cands[1]!.crowd = v.crowd?.(cands[1]!.dir)
    const i = pickSide(cands, v.rnd, v.lastSides)
    if (i < 0) return null
    return { kind: 'leap', technique: 'arrows', dir: cands[i]!.dir, side: i, reason: `${p.name} in ${h.ticks.toFixed(1)} ticks`, key: `p:${p.id}`, arrow: true }
  }
}

const draws: DodgeTechnique = {
  name: 'draws',
  key: 'draws',
  ranged: true,
  plan (v, s) {
    for (const a of v.archers) {
      if (a.dist > s.drawRange) continue
      const w = releaseWindow(a)
      if (!w) continue
      const key = BOW_USERS.has(a.name) ? `d:${a.id}:${Math.round((v.now - (a.drawingMs ?? 0)) / 250)}` : `c:${a.id}:${Math.floor((a.chargedMs ?? 0) / 400)}`
      if (v.handled.has(key)) continue
      // be moving one tick before it lets go (the shot aims where the bot is at the release)
      const lead = s.latencyMs + TICK_MS
      if (w[0] > lead) continue
      if (w[1] < -s.latencyMs) continue
      const to = unit({ x: a.pos.x - v.body.pos.x, z: a.pos.z - v.body.pos.z })
      const [l, r] = sidesOf(to)
      // flight time of the shot: ~1.6 blocks a tick from a bow, ~3.15 from a crossbow
      const flight = a.dist / (a.name === 'pillager' ? 3.15 : 1.6)
      const can = leapTravel(flight + Math.max(0, lead - Math.max(0, w[0])) / TICK_MS)
      const need = BODY_HALF + 0.25 + s.arrowMargin
      const cands: SideCandidate[] = [
        { dir: l, need, can, safe: v.safe(l), crowd: v.crowd?.(l) },
        { dir: r, need, can, safe: v.safe(r), crowd: v.crowd?.(r) }
      ]
      const i = pickSide(cands, v.rnd, v.lastSides)
      if (i < 0) continue
      return { kind: 'leap', technique: 'draws', dir: cands[i]!.dir, side: i, reason: `${a.name} about to shoot at ${a.dist.toFixed(1)}`, key, arrow: true }
    }
    return null
  }
}

const melee: DodgeTechnique = {
  name: 'meleeTiming',
  key: 'meleeTiming',
  plan (v, s) {
    const m = meleeTiming(v.attackers, s)
    if (!m) return null
    if (m.act === 'hold') return { kind: 'hold', technique: 'meleeTiming' }
    if (m.act === 'back') return { kind: 'back', technique: 'meleeTiming', reason: `out of reach of ${m.from}` }
    if (v.safe(m.dir)) return { kind: 'leap', technique: 'meleeTiming', dir: m.dir, side: -1, reason: `leap out of reach of ${m.from}` }
    return { kind: 'back', technique: 'meleeTiming', reason: `out of reach of ${m.from} (no room to leap)` }
  }
}

/** The per-tick techniques, first match wins: draws and arrows before melee (an arrow in the face beats a step back). */
export const DODGE_TECHNIQUES: DodgeTechnique[] = [draws, arrows, melee]

/** Runs the enabled techniques in order; the first intent wins. Null: nothing to dodge, the loop moves as it would. */
export function planDodge (v: DodgeView, s: DodgeSettings, techniques: readonly DodgeTechnique[] = DODGE_TECHNIQUES): DodgeIntent | null {
  if (!s.enabled) return null
  for (const t of techniques) {
    if (s[t.key] !== true) continue
    const i = t.plan(v, s)
    if (i) return i
  }
  return null
}
