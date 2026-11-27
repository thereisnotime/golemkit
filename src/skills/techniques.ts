// Pure decisions for the skilled-player techniques (no bot, unit-tested). fight.ts, the reflexes
// and the combat skill turn them into control states. Numbers and sources are on
// docs/concepts/combat-research.md. Toggles (settings.combat.*, live via !config_set):
//   sprintReset  W-tap: re-sprint into ground hits for extra knockback when no crit is possible
//   sweep        plain ground sword hits when mobs bunch around the target (sweep attack)
//   shieldMelee  shield up against melee mobs between slow swings, and against a creeper that
//                can't be outrun; an axe hit is still blocked, then the shield is down for 5 s
//   totem        a totem of undying goes into the offhand at low health or in a lethal fall
//   goldenApple  eat a golden apple mid-fight at low health instead of waiting for a lull
//   waterClutch  water bucket against a damaging fall, and to put out fire
//   endermanGaze never look an enderman in the eyes unless fighting it
//   chokepoints  outnumbered with health left: fight from a 1-wide gap so mobs come one at a time
//   fightFastMobs  no low-health back-off from mobs that outrun the bot (vindicators, spiders...);
//                  the water back-off (waterFightAbove) still applies

export interface V3 { x: number, y: number, z: number }

// ---- hits ----

export type HitStyle = 'crit' | 'sprint' | 'sweep' | 'plain'

/**
 * Sweep attack worth it? A sword hit on the ground, not sprinting and not a crit, also hits every
 * mob within 1 block of the target for 1 + damage * level / (level + 1) (Sweeping Edge). It costs
 * the crit's +50% on the main target, so it pays when the extra damage beats that.
 */
export function sweepWorth (s: { weapon: string | null | undefined, damage: number, sweepingLevel?: number, bunched: number }): boolean {
  if (!s.weapon?.endsWith('_sword') || s.bunched <= 0) return false
  const lvl = s.sweepingLevel ?? 0
  const each = 1 + s.damage * lvl / (lvl + 1)
  return s.bunched * each >= 0.5 * s.damage
}

/**
 * Whether a knockback hit beats a crit right now: a creeper (pushes it out of fuse range), low
 * health (keeps the mob out of its own reach), or a crowd (spaces the front one back).
 */
export function wantKnockback (s: { target: string, health: number, meleeNear: number }): boolean {
  if (s.target === 'creeper') return true
  if (s.health <= 8) return true
  return s.meleeNear >= 3
}

/**
 * How to land the next charged hit. Crits (x1.5) need a fall; a sprint hit adds a knockback level
 * and can't crit or sweep; a sweep needs a plain ground hit with a sword.
 */
export function hitStyle (s: { canCrit: boolean, sweepWorth: boolean, wantKnockback: boolean, sprintReset: boolean, sweep: boolean }): HitStyle {
  if (s.sweep && s.sweepWorth) return 'sweep'
  if (s.sprintReset && s.wantKnockback) return 'sprint'
  if (s.canCrit) return 'crit'
  return s.sprintReset ? 'sprint' : 'plain'
}

/** ms before the charge completes at which to press sprint again (W-tap): the start-sprint packet goes out a tick before the hit. */
export const SPRINT_LEAD_MS = 150

// ---- shield ----

/** Mobs whose melee hit is an axe: the hit is blocked, then the shield is disabled for 5 s (set_cooldown). */
export const SHIELD_BREAKERS = new Set(['vindicator', 'piglin_brute'])
/** A shield needs 5 ticks after it goes up before it blocks. */
export const SHIELD_DELAY_MS = 250

export function breaksShields (name: string | undefined, held?: string | null): boolean {
  if (SHIELD_BREAKERS.has(name ?? '')) return true
  return name === 'player' && !!held && held.endsWith('_axe')
}

/**
 * Raise the shield against a melee attacker between swings: only while the next swing is far
 * enough off that the shield is up long enough to count (5 ticks to raise, lowered a tick before
 * the hit) and the attacker is close. Against an axe (vindicators, brutes, players) it still pays:
 * the axe hit is blocked in full, then the shield is down for 5 s, which `disabled` reports.
 */
export function shieldAgainstMelee (s: {
  enabled: boolean, hasShield: boolean, attacker: string, attackerHeld?: string | null, dist: number,
  cooldownLeftMs: number, disabled?: boolean
}): boolean {
  if (!s.enabled || !s.hasShield || s.disabled) return false
  if (s.attacker === 'creeper') return false // handled by creeperEscape
  if (s.dist > 3.5) return false
  return s.cooldownLeftMs > SHIELD_DELAY_MS + 100
}

/**
 * Distance gained per second backing off from a creeper that follows (walking 4.3 blocks/s, the
 * creeper a bit over half that while it chases).
 */
const GAIN = 2.0
/** A creeper stops fusing once its target is 7 blocks away; the blast (power 3) hurts out to about 6. */
const FUSE_CANCEL = 7

/**
 * A creeper with a lit fuse (1.5 s): run if backing off for the rest of the fuse gets the bot past
 * the 7 blocks where the fuse stops, otherwise face it with a shield up (a blocked explosion does
 * no damage). Without a shield, run. `gain` is the distance gained per second (GAIN walking,
 * LEAP_GAIN sprint-jumping).
 */
export function creeperEscape (s: { dist: number, msLeft: number, shield: boolean, gain?: number }): 'run' | 'shield' {
  const reach = s.dist + (s.gain ?? GAIN) * Math.max(0, s.msLeft) / 1000
  if (reach >= FUSE_CANCEL || !s.shield) return 'run'
  return 'shield'
}

/** Distance gained per second sprint-jumping away from a creeper (combat.dodge.creeperLeap): ~7 blocks/s against its ~2.5, kept low to be safe. */
export const LEAP_GAIN = 3.5

/** Creeper fuse, ms. */
export const CREEPER_FUSE_MS = 1500

// ---- totem, golden apples ----

/**
 * Put a totem of undying in the offhand now: health at or below `below` (default 8), or a fall or
 * burn that could kill. Keeping a shield there is worth more only while health is comfortable.
 */
export function totemSwap (s: { enabled: boolean, hasTotem: boolean, offhand: string | null | undefined, health: number, below?: number, lethalFall?: boolean, burning?: boolean }): boolean {
  if (!s.enabled || !s.hasTotem || s.offhand === 'totem_of_undying') return false
  if (s.lethalFall) return true
  if (s.burning && s.health <= 10) return true
  return s.health > 0 && s.health <= (s.below ?? 8)
}

/**
 * Eat a golden apple in the middle of the fight (1.6 s, absorption 4 and regeneration II): at 8
 * health or less, or 12 or less with three or more melee mobs on us, not with a lit creeper close,
 * and not again within 8 s (the effects from the last one are still running).
 */
export function goldenAppleNow (s: { enabled: boolean, health: number, hasGoldenApple: boolean, meleeNear: number, litCreeperNear: boolean, sinceLastMs: number }): boolean {
  if (!s.enabled || !s.hasGoldenApple || s.litCreeperNear || s.health <= 0) return false
  if (s.sinceLastMs < 8000) return false
  return s.health <= 8 || (s.health <= 12 && s.meleeNear >= 3)
}

// ---- water bucket ----

/** Fall damage (vanilla): one point per block past 3, less with Feather Falling (12% per level, to 48%). */
export function fallDamage (blocks: number, featherFalling = 0): number {
  const raw = Math.max(0, Math.ceil(blocks - 3))
  return Math.round(raw * (1 - Math.min(0.48, 0.12 * featherFalling)))
}

/** Bucket reach from the eyes (block interaction range 4.5), a little short to be safe. */
const BUCKET_REACH = 4.2
const EYE = 1.62

export type ClutchAct = 'none' | 'prepare' | 'place'

/**
 * Water bucket clutch (MLG): during a fall that would hurt, hold the bucket and look down
 * ('prepare'), then place water on the ground ('place') once it is within reach of the eyes and at
 * most two ticks of fall away. Never in the Nether (water evaporates), never when the landing is
 * water already. `groundY` is the top of the block it will land on (null: nothing below in range).
 */
export function clutchDecision (s: {
  enabled: boolean, hasBucket: boolean, dimension: string, fallStartY: number, y: number, velY: number,
  groundY: number | null, landingSoft: boolean, health: number, featherFalling?: number, minDamage?: number
}): { act: ClutchAct, damage: number } {
  if (!s.enabled || !s.hasBucket || s.groundY === null || s.landingSoft || /nether/.test(s.dimension)) return { act: 'none', damage: 0 }
  const damage = fallDamage(s.fallStartY - s.groundY, s.featherFalling)
  if (damage < (s.minDamage ?? 3) && damage < s.health) return { act: 'none', damage }
  if (s.velY >= -0.1) return { act: 'none', damage }
  const eyeAbove = s.y + EYE - s.groundY
  // place when the ground is within bucket reach; earlier would put the water out of reach
  if (eyeAbove <= BUCKET_REACH) return { act: 'place', damage }
  return { act: 'prepare', damage }
}

/** On fire, not in water or rain, with a bucket, outside the Nether: put water at the feet, then scoop it back. */
export function extinguishDecision (s: { enabled: boolean, burning: boolean, inWater: boolean, inLava: boolean, hasBucket: boolean, dimension: string, solidBelow: boolean }): boolean {
  if (!s.enabled || !s.burning || s.inWater || s.inLava || !s.hasBucket || !s.solidBelow) return false
  return !/nether/.test(s.dimension)
}

// ---- enderman gaze ----

/** Enderman eye height above its feet. */
export const ENDERMAN_EYE = 2.55

/** Look direction (mineflayer: yaw 0 = north/-z, pitch up positive). */
export function viewVector (yaw: number, pitch: number): V3 {
  return { x: -Math.sin(yaw) * Math.cos(pitch), y: Math.sin(pitch), z: -Math.cos(yaw) * Math.cos(pitch) }
}

/**
 * Vanilla EnderMan.isLookingAtMe: the player's view vector against the vector to the enderman's
 * eyes; provoked when their dot product exceeds 1 - 0.025 / distance (a cone that narrows with
 * distance). Line of sight and the carved pumpkin are the caller's business.
 */
export function gazeProvokes (eye: V3, yaw: number, pitch: number, enderman: V3): boolean {
  const to = { x: enderman.x - eye.x, y: enderman.y + ENDERMAN_EYE - eye.y, z: enderman.z - eye.z }
  const d = Math.hypot(to.x, to.y, to.z)
  if (d < 1e-3 || d > 64) return false
  const v = viewVector(yaw, pitch)
  const dot = (v.x * to.x + v.y * to.y + v.z * to.z) / d
  return dot > 1 - 0.025 / d
}

/**
 * A pitch that keeps the bot's gaze off every enderman's eyes: unchanged when it already does,
 * else lowered (towards the feet) in small steps; raised if lowering can't clear it. Null when
 * nothing works (it can't happen with a single enderman).
 */
export function avertGaze (eye: V3, yaw: number, pitch: number, endermen: V3[]): number | null {
  const bad = (p: number) => endermen.some(e => gazeProvokes(eye, yaw, p, e))
  if (!bad(pitch)) return pitch
  for (let step = 1; step <= 30; step++) {
    const down = pitch - step * 0.05
    if (down >= -Math.PI / 2 && !bad(down)) return down
  }
  for (let step = 1; step <= 30; step++) {
    const up = pitch + step * 0.05
    if (up <= Math.PI / 2 && !bad(up)) return up
  }
  return null
}

/** Mobs arrows don't work on: endermen teleport away from projectiles, breezes deflect them. */
export function rangedUseless (name: string | undefined): boolean {
  return name === 'enderman' || name === 'breeze'
}

// ---- who not to run from ----

/** Mobs that run down a walking (even a sprinting) player: backing off from them only turns the bot's back. */
export const FASTER_THAN_US = new Set(['vindicator', 'ravager', 'spider', 'cave_spider', 'wolf', 'piglin_brute', 'hoglin', 'zoglin'])

/**
 * combat.fightFastMobs: at low health the reflexes back off from melee mobs (retreatBelow), which
 * against a mob faster than the bot means dying from behind (seen in the vindicator duel). Keep
 * fighting those instead; the golden apple and disengage-to-heal rules still apply.
 */
export function retreatPointless (s: { enabled: boolean, mob: string | undefined }): boolean {
  return s.enabled && FASTER_THAN_US.has(s.mob ?? '')
}

/**
 * Why the reflexes back off from a mob, or null to fight it: 'low' at or below `retreatBelow`
 * health (not from mobs that outrun the bot, `fast`, see retreatPointless), 'water' from a mob in
 * water below `waterFightAbove` (fast or not). Never from flyers, which outrun anything.
 */
export function retreatReason (s: { health: number, retreatBelow: number, waterFightAbove: number, flying: boolean, fast: boolean, mobInWater: boolean }): 'low' | 'water' | null {
  if (s.flying || s.health <= 0) return null
  if (s.health <= s.retreatBelow && !s.fast) return 'low'
  if (s.mobInWater && s.health < s.waterFightAbove) return 'water'
  return null
}

// ---- chokepoints ----

/**
 * A spot to fight a crowd from, so mobs reach the bot one at a time: a standable cell whose two
 * sides are walled along one axis, with the cell in front of it (towards the mobs) walled on both
 * sides too. Mobs then queue in that 1-wide corridor; diagonal cells are walls, so only the front
 * one is in reach. `open(dx, dz)` says whether a cell at the bot's level is standable (floor, two
 * blocks of air). `toward` is the mobs' centre relative to the bot. Nearest first; null when none
 * within `r`.
 */
export function findChokepoint (open: (dx: number, dz: number) => boolean, toward: { x: number, z: number }, r = 6): { dx: number, dz: number, face: { x: number, z: number } } | null {
  let best: { dx: number, dz: number, face: { x: number, z: number }, d: number } | null = null
  const dirs = [{ x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 }]
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      if (!open(dx, dz)) continue
      const d = Math.hypot(dx, dz)
      if (d > r || (best && d >= best.d)) continue
      for (const f of dirs) {
        // front must face the mobs (positive dot with the direction to them from this cell)
        const mx = toward.x - dx
        const mz = toward.z - dz
        if (f.x * mx + f.z * mz <= 0) continue
        const side = { x: f.z, z: f.x } // perpendicular
        const fx = dx + f.x
        const fz = dz + f.z
        if (!open(fx, fz)) continue
        if (open(dx + side.x, dz + side.z) || open(dx - side.x, dz - side.z)) continue
        if (open(fx + side.x, fz + side.z) || open(fx - side.x, fz - side.z)) continue
        best = { dx, dz, face: f, d }
        break
      }
    }
  }
  return best ? { dx: best.dx, dz: best.dz, face: best.face } : null
}

/** Hold a chokepoint when 3+ melee mobs come and there is health to fight with (under half, outnumbered() escapes instead). */
export function wantChokepoint (s: { enabled: boolean, meleeNear: number, health: number, maxHealth?: number }): boolean {
  return s.enabled && s.meleeNear >= 3 && s.health >= (s.maxHealth ?? 20) / 2
}
