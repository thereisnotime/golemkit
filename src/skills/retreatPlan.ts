// Leaving fights in time, pure and unit tested (test/retreat-plan.test.ts). Three decisions:
//   - risk: how much damage the threats in reach will do over the next N attack cycles (mob
//     damage table, how many, their cooldowns and approach time, the bot's armour, toughness,
//     protection and shield, the difficulty), and whether the bot's health survives it. With
//     hysteresis, so it doesn't step in and out at the edge.
//   - engage: whether to take a fight in the open at all. Without armour, at night or
//     outnumbered (two of the three by default) the bot goes home or to a chokepoint instead,
//     unless an owner is in trouble or there is nowhere better to fight.
//   - escape: where to go, from a small ordered list of routes (home through a door, pillar up,
//     bunker, sprint away), each with its own pure check; the order and which ones run are
//     settings. Then recover: eat, wait to heal, come back when healthy.
// The Mineflayer glue is in retreat.ts (reading the world) and escape.ts (running the routes).
//
// Why: Pax died 62 times in `defend`, median health 1.7 before the last hit, with no armour and
// a stone sword. The old rule left at 4 health, which against two zombies is one swing from death.
import { z } from 'zod'

// ---- settings ----

export const ROUTE_IDS = ['home', 'pillar', 'bunker', 'sprint'] as const
export type RouteId = typeof ROUTE_IDS[number]
export const AVOID_ROUTE_IDS = ['home', 'chokepoint'] as const
export type AvoidRouteId = typeof AVOID_ROUTE_IDS[number]

/** settings.retreat (profile `settings: retreat:`, live with config_set retreat.*). */
export const RetreatSchema = z.object({
  enabled: z.boolean().default(true).describe('risk-based retreat; off = the old fixed rule (back off to eat at 4 health, pillar when outnumbered)'),
  hits: z.number().min(0.5).max(10).default(2).describe('leave when health would not survive what lands in the next this many attack cycles (1 s each) from every threat in reach'),
  floor: z.number().min(0).max(20).default(4).describe('always leave at or below this health, whatever the estimate (0 = no floor)'),
  hysteresis: z.number().min(0).max(20).default(4).describe('once leaving, keep leaving until health is this much above the estimate'),
  shieldBlocks: z.number().min(0).max(1).default(0.4).describe('share of hits a shield in the offhand is expected to block'),
  returnAbove: z.number().min(1).max(20).default(16).describe('after escaping, come back to the fight only at this health or more'),
  healSeconds: z.number().min(0).max(600).default(60).describe('longest wait for health to come back after escaping'),
  comeBack: z.boolean().default(true).describe('after healing, fight the mobs still around (at home after going home, where it left otherwise)'),
  maxEscapes: z.number().int().min(0).max(10).default(2).describe('escapes per defend run; after that it fights where it stands'),
  routes: z.array(z.enum(ROUTE_IDS)).default(['home', 'pillar', 'bunker', 'sprint']).describe('escape routes tried in this order; leave one out to turn it off'),
  homeRadius: z.number().min(0).max(256).default(40).describe('go home to escape only when home is this close (blocks)'),
  closeDoors: z.boolean().default(true).describe('shut open doors next to it once home'),
  pillarHeight: z.number().int().min(1).max(4).default(2).describe('blocks to pillar up (2 is above zombie reach, low enough to hit down)'),
  sprintDistance: z.number().min(6).max(48).default(24).describe('how far to sprint away from the threats'),
  avoidOpen: z.boolean().default(true).describe('prefer not to fight in the open when poorly placed (see avoidFactors): go home or to a chokepoint'),
  avoidFactors: z.number().int().min(1).max(3).default(2).describe('how many of no armour, night, outnumbered make it avoid an open fight (3 = only all three)'),
  minArmour: z.number().min(0).max(20).default(1).describe('armour points below this count as no armour'),
  outnumberedAt: z.number().int().min(2).max(10).default(2).describe('this many melee mobs within 8 blocks count as outnumbered for avoidOpen'),
  avoidRoutes: z.array(z.enum(AVOID_ROUTE_IDS)).default(['home', 'chokepoint']).describe('where to go instead of an open fight, in this order')
})
export type RetreatSettings = z.infer<typeof RetreatSchema>
export const RETREAT_DEFAULTS: RetreatSettings = RetreatSchema.parse({})

/** settings.retreat merged over the defaults; a value that doesn't fit its schema keeps the default. */
export function retreatSettings (raw: unknown): RetreatSettings {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  const out: Record<string, unknown> = { ...RETREAT_DEFAULTS }
  for (const [k, schema] of Object.entries(RetreatSchema.shape)) {
    if (o[k] === undefined) continue
    const r = (schema as z.ZodType).safeParse(o[k])
    if (r.success) out[k] = r.data
  }
  return out as RetreatSettings
}

// ---- mob damage ----

export interface MobHit {
  /** Damage per hit on Normal before armour (vanilla 1.21, held weapons included where mobs spawn with them). */
  damage: number
  /** Seconds between hits on Normal (and on Hard where it differs). */
  cooldown: number
  cooldownHard?: number
  /** Shoots from range (needs a line of sight); else melee. */
  ranged?: boolean
  /** Walking speed, blocks per second (approach time). */
  speed: number
}

const melee = (damage: number, speed = 2.3, cooldown = 1): MobHit => ({ damage, cooldown, speed })
const shooter = (damage: number, cooldown: number, cooldownHard?: number): MobHit => ({ damage, cooldown, ranged: true, speed: 2.5, ...(cooldownHard ? { cooldownHard } : {}) })

/**
 * Per-hit damage and timing by mob (Normal difficulty). Creepers are left out: the blast is the
 * fight loop's creeper rules' business, and counting it here would make every creeper a retreat.
 */
export const MOB_HITS: Record<string, MobHit> = {
  zombie: melee(3), husk: melee(3), drowned: melee(3), zombie_villager: melee(3),
  zombified_piglin: melee(8), piglin: melee(5), piglin_brute: melee(13, 3.5), wither_skeleton: melee(8),
  spider: melee(2, 3), cave_spider: melee(3, 3), // cave spider: 2 plus poison
  enderman: melee(7, 3), vindicator: melee(13, 3.5), ravager: melee(12, 3, 2), hoglin: melee(6, 3, 1.5), zoglin: melee(6, 3, 1.5),
  slime: melee(4, 2), magma_cube: melee(6, 2), silverfish: melee(1, 2.5), endermite: melee(2, 2.5),
  wolf: melee(4, 3.5), polar_bear: melee(6, 2.5), bee: melee(2, 3), goat: melee(2, 2.5, 3), vex: melee(9, 5),
  phantom: { damage: 2, cooldown: 4, speed: 6 }, warden: melee(30, 2.5, 1.5),
  skeleton: shooter(3.5, 2, 1), stray: shooter(3.5, 2, 1), bogged: shooter(3.5, 3.5, 2.5),
  pillager: shooter(4, 2.5), witch: shooter(6, 3), blaze: shooter(5, 1.7), ghast: shooter(6, 3),
  guardian: shooter(6, 3), elder_guardian: shooter(8, 3), evoker: shooter(6, 5), breeze: shooter(1, 2)
}
const UNKNOWN_HOSTILE: MobHit = melee(4)
const NO_HIT = new Set(['creeper'])

export function mobHit (name: string): MobHit | null {
  if (NO_HIT.has(name)) return null
  return MOB_HITS[name] ?? UNKNOWN_HOSTILE
}

export type Difficulty = 'peaceful' | 'easy' | 'normal' | 'hard'

/** Vanilla difficulty scaling of damage a mob does to a player: easy min(d/2+1, d), hard x1.5. */
export function difficultyDamage (d: number, difficulty: Difficulty | null | undefined): number {
  if (difficulty === 'peaceful') return 0
  if (difficulty === 'easy') return Math.min(d / 2 + 1, d)
  if (difficulty === 'hard') return d * 1.5
  return d
}

// ---- armour ----

const ARMOUR: Record<string, { head: number, torso: number, legs: number, feet: number, tough: number }> = {
  leather: { head: 1, torso: 3, legs: 2, feet: 1, tough: 0 },
  golden: { head: 2, torso: 5, legs: 3, feet: 1, tough: 0 },
  chainmail: { head: 2, torso: 5, legs: 4, feet: 1, tough: 0 },
  iron: { head: 2, torso: 6, legs: 5, feet: 2, tough: 0 },
  diamond: { head: 3, torso: 8, legs: 6, feet: 3, tough: 2 },
  netherite: { head: 3, torso: 8, legs: 6, feet: 3, tough: 3 }
}
const SLOT: Record<string, 'head' | 'torso' | 'legs' | 'feet'> = { helmet: 'head', chestplate: 'torso', leggings: 'legs', boots: 'feet' }

export interface Defence {
  /** Armour points worn (0-20+). */
  points: number
  /** Armour toughness worn. */
  toughness: number
  /** Enchantment protection factor (protection I-IV is 1-4 per piece), capped at 20 by the game. */
  epf?: number
  /** A shield in the offhand. */
  shield?: boolean
}

/** Armour points and toughness of the worn pieces (item names; anything else counts 0). */
export function armourDefence (worn: readonly (string | null | undefined)[]): { points: number, toughness: number } {
  let points = 0
  let toughness = 0
  for (const n of worn) {
    if (!n) continue
    if (n === 'turtle_helmet') { points += 2; continue }
    const m = /^([a-z]+)_(helmet|chestplate|leggings|boots)$/.exec(n)
    const mat = m ? ARMOUR[m[1]!] : undefined
    if (!m || !mat) continue
    points += mat[SLOT[m[2]!]!]
    toughness += mat.tough
  }
  return { points, toughness }
}

/** Damage left after armour (vanilla 1.21: armour - 4d/(toughness+8), at least armour/5, at most 20, 4% each) and protection. */
export function afterArmour (damage: number, d: Pick<Defence, 'points' | 'toughness' | 'epf'>): number {
  const f = Math.min(20, Math.max(d.points / 5, d.points - 4 * damage / (d.toughness + 8)))
  const armoured = damage * (1 - f / 25)
  return armoured * (1 - Math.min(20, d.epf ?? 0) / 25)
}

// ---- risk ----

export interface Threat {
  name: string
  /** Distance from the bot, blocks. */
  dist: number
  /** Line of sight (ranged mobs only shoot with one). Default true. */
  los?: boolean
}

export interface RiskInput {
  threats: readonly Threat[]
  defence: Defence
  difficulty?: Difficulty | null
  /** Attack cycles to look ahead (settings.hits). */
  hits: number
  /** Share of hits a shield blocks (settings.shieldBlocks). */
  shieldBlocks?: number
}

export interface Risk {
  /** Damage expected over the look-ahead window. */
  damage: number
  /** Damage per second from the threats in reach right now. */
  dps: number
  /** How many hits land in the window. */
  hits: number
  /** The mobs that contribute, "2 zombie, skeleton". */
  from: string
}

const MELEE_REACH = 2
const RANGED_REACH = 16
/** Mobs further than this are not part of this fight's next few seconds. */
const LOOK_RADIUS = 12

/**
 * Damage expected in the next `hits` attack cycles (1 s each: one zombie swing) from every threat:
 * each mob hits first when it arrives (melee: walking to 2 blocks; ranged: at once with a line of
 * sight within 16 blocks) and then every cooldown. Armour, toughness, protection, a shield and the
 * difficulty scale each hit. Two zombies on an unarmoured bot over 2 s: 4 hits, 12 damage.
 */
export function incomingDamage (i: RiskInput): Risk {
  const window = i.hits
  const hard = i.difficulty === 'hard'
  const block = i.defence.shield ? Math.max(0, Math.min(1, i.shieldBlocks ?? 0)) : 0
  let damage = 0
  let dps = 0
  let hits = 0
  const names = new Map<string, number>()
  for (const t of i.threats) {
    const h = mobHit(t.name)
    if (!h || t.dist > (h.ranged ? RANGED_REACH : LOOK_RADIUS)) continue
    if (h.ranged && t.los === false) continue
    const cd = hard && h.cooldownHard ? h.cooldownHard : h.cooldown
    const arrive = h.ranged ? 0 : Math.max(0, t.dist - MELEE_REACH) / h.speed
    if (arrive >= window) continue
    const n = Math.floor((window - arrive) / cd - 1e-9) + 1
    const per = afterArmour(difficultyDamage(h.damage, i.difficulty), i.defence) * (1 - block)
    damage += n * per
    hits += n
    if (arrive === 0) dps += per / cd
    names.set(t.name, (names.get(t.name) ?? 0) + 1)
  }
  const from = [...names.entries()].map(([n, c]) => c > 1 ? `${c} ${n}` : n).join(', ')
  return { damage: round(damage), dps: round(dps), hits, from }
}

const round = (x: number) => Math.round(x * 10) / 10

export interface RetreatDecision {
  leave: boolean
  /** Why it leaves (or, when it stays, null). */
  why: string | null
}

/**
 * Leave when health would not survive the estimate (`risk.damage`), or at the floor. Once
 * leaving (`leaving`), keep leaving until health is `hysteresis` above the estimate. With no
 * threat in reach there is nothing to leave.
 */
export function retreatDecision (i: { health: number, risk: Risk, leaving: boolean, settings: Pick<RetreatSettings, 'floor' | 'hysteresis' | 'hits'> }): RetreatDecision {
  const { health, risk, settings: s } = i
  if (health <= 0 || risk.hits === 0) return { leave: false, why: null }
  const hp = Math.ceil(health)
  if (s.floor > 0 && health <= s.floor) return { leave: true, why: `health ${hp} at the floor (${s.floor}) with ${risk.from} close` }
  const bar = i.leaving ? risk.damage + s.hysteresis : risk.damage
  if (health <= bar) {
    return { leave: true, why: `health ${hp} would not survive ${risk.from} for ${s.hits} s (about ${Math.round(risk.damage)} damage)` }
  }
  return { leave: false, why: null }
}

// ---- engage: fight in the open or go somewhere better ----

export interface EngageInput {
  armour: number
  night: boolean
  /** Melee hostiles within 8 blocks. */
  meleeNear: number
  /** An owner close by with a hostile on them: the bot fights for them. */
  ownerThreatened: boolean
  /** Every threat close outruns the bot (spiders, vindicators...): going anywhere only turns its back. */
  allFaster: boolean
  settings: Pick<RetreatSettings, 'enabled' | 'avoidOpen' | 'avoidFactors' | 'minArmour' | 'outnumberedAt'>
}

/** Whether to take the fight where it stands, and the factors against it ("no armour, night"). */
export function engageDecision (i: EngageInput): { fight: boolean, why: string } {
  const s = i.settings
  const factors = [i.armour < s.minArmour && 'no armour', i.night && 'night', i.meleeNear >= s.outnumberedAt && `${i.meleeNear} melee mobs`].filter(Boolean) as string[]
  const list = factors.join(', ')
  if (!s.enabled || !s.avoidOpen) return { fight: true, why: 'avoidOpen off' }
  if (i.ownerThreatened) return { fight: true, why: 'an owner is in trouble' }
  if (i.allFaster) return { fight: true, why: 'they outrun it' }
  if (factors.length >= s.avoidFactors) return { fight: false, why: list }
  return { fight: true, why: list || 'well placed' }
}

// ---- escape routes ----

/** What the routes look at. Distances in blocks. */
export interface EscapeInput {
  /** Home in this dimension: how far, and whether the way there runs into the threats. */
  home: { dist: number, throughThreats: boolean } | null
  canPlace: boolean
  /** Filler blocks carried (dirt, cobblestone, planks...). */
  blocks: number
  /** Free blocks above the head (0-4). */
  headroom: number
  protectedHere: boolean
  canDig: boolean
  /** The bunker can seal itself (a block carried, the ground drops one, or a pickaxe). */
  sealable: boolean
  /** Already under a roof (bunker refuses then). */
  roofed: boolean
  inWater: boolean
  threats: readonly { name: string, ranged: boolean, flying: boolean }[]
  settings: Pick<RetreatSettings, 'homeRadius' | 'pillarHeight'>
}

export interface EscapeRoute<Id extends string = string> {
  id: Id
  /** Why it can't be used now, or null when it can. */
  refuse: (s: EscapeInput) => string | null
}

/** Mobs that run down a sprinting bot: sprinting or walking home only turns its back. */
export const OUTRUN_US = new Set(['vindicator', 'ravager', 'wolf', 'piglin_brute', 'hoglin', 'zoglin', 'vex', 'phantom'])
/** Mobs a pillar doesn't keep off: they climb, teleport or reach up. */
const PILLAR_USELESS = new Set(['spider', 'cave_spider', 'enderman', 'ravager', 'slime', 'magma_cube', 'vex', 'phantom'])

const outrun = (s: EscapeInput) => s.threats.find(t => OUTRUN_US.has(t.name))?.name ?? null

export const ESCAPE_ROUTES: EscapeRoute<RouteId>[] = [
  {
    id: 'home',
    refuse: s => {
      if (!s.home) return 'no home here'
      if (s.home.dist > s.settings.homeRadius) return `home is ${Math.round(s.home.dist)} blocks away`
      if (s.home.throughThreats) return 'the way home runs through them'
      const f = outrun(s)
      return f ? `a ${f} would catch it on the way` : null
    }
  },
  {
    id: 'pillar',
    refuse: s => {
      if (!s.canPlace) return 'may not place blocks'
      if (s.protectedHere) return 'protected area'
      if (s.inWater) return 'in water'
      if (s.blocks < s.settings.pillarHeight) return `${s.blocks} blocks to pillar with`
      if (s.headroom < s.settings.pillarHeight) return 'no room above'
      const r = s.threats.find(t => t.ranged)
      if (r) return `a ${r.name} would shoot it off the top`
      const u = s.threats.find(t => PILLAR_USELESS.has(t.name) || t.flying)
      return u ? `a ${u.name} gets up a pillar` : null
    }
  },
  {
    id: 'bunker',
    refuse: s => {
      if (!s.canDig) return 'may not dig'
      if (s.protectedHere) return 'protected area'
      if (s.inWater) return 'in water'
      if (s.roofed) return 'under a roof already'
      return s.sealable ? null : 'nothing to seal the hole with'
    }
  },
  {
    id: 'sprint',
    refuse: s => {
      const f = outrun(s)
      return f ? `a ${f} outruns it` : null
    }
  }
]

export interface EscapePlan<Id extends string> {
  /** Routes that can be tried now, in order. */
  usable: Id[]
  /** Routes left out and why ("pillar: a skeleton would shoot it off the top"). */
  skipped: { id: Id, why: string }[]
}

/** The routes of `order` that apply now, in that order (unknown ids are ignored). */
export function planEscape<Id extends string> (s: EscapeInput, order: readonly Id[], routes: readonly EscapeRoute<Id>[]): EscapePlan<Id> {
  const usable: Id[] = []
  const skipped: { id: Id, why: string }[] = []
  for (const id of order) {
    const r = routes.find(x => x.id === id)
    if (!r) continue
    const why = r.refuse(s)
    if (why) skipped.push({ id, why })
    else usable.push(id)
  }
  return { usable, skipped }
}

/**
 * Whether home lies on the threats' side: the direction home is within 60 degrees of the
 * threats' centre and a threat is closer than home. Vectors are relative to the bot.
 */
export function homeThroughThreats (home: { x: number, z: number }, threats: readonly { x: number, z: number }[]): boolean {
  const hd = Math.hypot(home.x, home.z)
  if (!threats.length || hd < 2) return false
  for (const t of threats) {
    const td = Math.hypot(t.x, t.z)
    if (td < 1 || td > hd) continue
    const cos = (home.x * t.x + home.z * t.z) / (hd * td)
    if (cos > 0.5) return true
  }
  return false
}

// ---- after escaping ----

export type RecoverStep = 'eat' | 'wait' | 'fight' | 'healed' | 'give_up'

/**
 * One step of recovering after an escape: fight when a mob is right on it, eat when that heals
 * (hungry and has food), stop when healthy enough to come back (`returnAbove`), give up waiting
 * after `healSeconds`, else wait for regeneration.
 */
export function recoverStep (i: { health: number, food: number, hasFood: boolean, mobInReach: boolean, elapsedMs: number, settings: Pick<RetreatSettings, 'returnAbove' | 'healSeconds'> }): RecoverStep {
  if (i.mobInReach) return 'fight'
  if (i.health >= i.settings.returnAbove) return 'healed'
  if (i.elapsedMs >= i.settings.healSeconds * 1000) return 'give_up'
  if (i.hasFood && i.food < 20) return 'eat'
  return 'wait'
}
