// Base safety settings: keeping a bot's base mob-proof (profile key `baseSafety:`) and keeping it
// out of the spot where it just died (`deathSpots:`). Game-agnostic: plain numbers and technique
// names. The Minecraft side (src/skills/baseSafety*.ts) scans the ground under and around the
// base for caves, holes and mine entrances and fixes them; the danger memory (danger.ts) holds
// the death spots. See docs/guide/base-safety.md.
import { z } from 'zod'

/** Ways to make a dangerous cavity safe, tried in this order by default (settings baseSafety.techniques). */
export const SAFETY_TECHNIQUES = ['cap', 'fill', 'seal', 'light'] as const
export type SafetyTechnique = typeof SAFETY_TECHNIQUES[number]
/** What goes on a mine entrance near or inside the base. */
export const CAP_KINDS = ['trapdoor', 'slab', 'block', 'light', 'none'] as const
export type CapKind = typeof CAP_KINDS[number]
/** Where a new staircase mine may start relative to the base. */
export const MINE_PLACEMENTS = ['outside', 'inside', 'either'] as const
export type MinePlacement = typeof MINE_PLACEMENTS[number]

export const BaseSafetySettingsSchema = z.object({
  enabled: z.boolean().optional().describe('check the base for caves, holes and mine entrances mobs can use, and fix them (default on)'),
  margin: z.number().int().min(0).max(16).optional().describe('blocks around the base footprint that are checked too (default 4)'),
  depth: z.number().int().min(1).max(24).optional().describe('blocks below the floor that are checked (default 8)'),
  techniques: z.array(z.enum(SAFETY_TECHNIQUES)).optional().describe('fixes to use, in this order: cap (mine entrances), fill (small cavities), seal (block the openings), light (torches); leave one out to turn it off (default cap, fill, seal, light)'),
  fillMax: z.number().int().min(0).max(2000).optional().describe('cavities up to this many blocks are filled in whole; bigger ones are sealed or lit (default 48)'),
  sealMax: z.number().int().min(0).max(500).optional().describe('at most this many openings of one cavity are sealed (default 24)'),
  lightSpacing: z.number().int().min(2).max(13).optional().describe('torches in a cavity that stays open, at most this many blocks apart (default 7)'),
  capWith: z.enum(CAP_KINDS).optional().describe('a mine entrance near or inside the base gets: trapdoor | slab | block (filler) over its opening, light (torches only) or none (default trapdoor; a block when it has no trapdoor and can\'t make one)'),
  keepOutDepth: z.number().int().min(0).max(32).optional().describe('digging for stone or ore stays out of the ground under the base and its margin down to this many blocks (default 8; 0 = off)'),
  mineClearance: z.number().int().min(0).max(32).optional().describe('a staircase mine starts at least this many blocks from the base walls (default 4)'),
  minePlacement: z.enum(MINE_PLACEMENTS).optional().describe('where a new mine may start: inside the walls under a hatch (default), outside the walls, or either (inside first)'),
  mineHatch: z.boolean().optional().describe('a mine inside the walls: shut the hatch behind it on the way down and on the way up, so the base stays closed while it is down there (default on)'),
  mineKeepClear: z.number().int().min(0).max(8).optional().describe('a mine inside the walls starts at least this many blocks from the gate (default 2)'),
  retireCloseMines: z.boolean().optional().describe('a known mine outside the walls and within mineClearance of them is capped and no longer used; a new one is started (default on)'),
  useOutsideMines: z.boolean().optional().describe('with minePlacement inside: trips still go down a known mine outside the walls (far enough from them) instead of digging one inside (default off)'),
  floorHoles: z.boolean().optional().describe('also find holes in the floor surface inside the walls (open to the sky, so not a cavity) and fill them; dirt in a farm plot (default on)')
}).strict()

export interface BaseSafetySettings {
  enabled: boolean
  margin: number
  depth: number
  techniques: SafetyTechnique[]
  fillMax: number
  sealMax: number
  lightSpacing: number
  capWith: CapKind
  keepOutDepth: number
  mineClearance: number
  minePlacement: MinePlacement
  mineHatch: boolean
  mineKeepClear: number
  retireCloseMines: boolean
  useOutsideMines: boolean
  floorHoles: boolean
}

export const BASE_SAFETY_DEFAULTS: BaseSafetySettings = {
  enabled: true, margin: 4, depth: 8, techniques: [...SAFETY_TECHNIQUES], fillMax: 48, sealMax: 24, lightSpacing: 7,
  capWith: 'trapdoor', keepOutDepth: 8, mineClearance: 4, minePlacement: 'inside', mineHatch: true, mineKeepClear: 2, retireCloseMines: true, useOutsideMines: false, floorHoles: true
}

const obj = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
const num = (v: unknown, d: number, min: number, max: number): number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : d
const oneOf = <T extends string>(v: unknown, all: readonly T[], d: T): T => (all as readonly string[]).includes(v as string) ? v as T : d

/** settings.baseSafety with defaults; wrong values fall back to the default. `false` = off. */
export function baseSafetySettings (raw: unknown): BaseSafetySettings {
  const o = raw === false ? { enabled: false } : obj(raw)
  const d = BASE_SAFETY_DEFAULTS
  const techniques = Array.isArray(o.techniques)
    ? [...new Set(o.techniques.filter((t): t is SafetyTechnique => (SAFETY_TECHNIQUES as readonly string[]).includes(t as string)))]
    : [...d.techniques]
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : d.enabled,
    margin: num(o.margin, d.margin, 0, 16),
    depth: num(o.depth, d.depth, 1, 24),
    techniques,
    fillMax: num(o.fillMax, d.fillMax, 0, 2000),
    sealMax: num(o.sealMax, d.sealMax, 0, 500),
    lightSpacing: num(o.lightSpacing, d.lightSpacing, 2, 13),
    capWith: oneOf(o.capWith, CAP_KINDS, d.capWith),
    keepOutDepth: num(o.keepOutDepth, d.keepOutDepth, 0, 32),
    mineClearance: num(o.mineClearance, d.mineClearance, 0, 32),
    minePlacement: oneOf(o.minePlacement, MINE_PLACEMENTS, d.minePlacement),
    mineHatch: typeof o.mineHatch === 'boolean' ? o.mineHatch : d.mineHatch,
    mineKeepClear: num(o.mineKeepClear, d.mineKeepClear, 0, 8),
    retireCloseMines: typeof o.retireCloseMines === 'boolean' ? o.retireCloseMines : d.retireCloseMines,
    useOutsideMines: typeof o.useOutsideMines === 'boolean' ? o.useOutsideMines : d.useOutsideMines,
    floorHoles: typeof o.floorHoles === 'boolean' ? o.floorHoles : d.floorHoles
  }
}

// ------------------------------------------------------------------ death spots

export const DeathSpotsSettingsSchema = z.object({
  enabled: z.boolean().optional().describe('after a death, keep out of the spot for a while (default on)'),
  minutes: z.number().min(0.5).max(240).optional().describe('how long a death spot is avoided (default 10)'),
  radius: z.number().min(1).max(32).optional().describe('blocks around the death spot, horizontally (default 6)'),
  yRange: z.number().min(1).max(64).optional().describe('blocks above and below the death spot that count (default 4: a death in a cave under the base doesn\'t fence off the base above)'),
  stepCost: z.number().min(0).max(50).optional().describe('extra path cost per block walked inside a death spot, so paths go around it (default 8; 0 = paths ignore it)')
}).strict()

export interface DeathSpotsSettings { enabled: boolean, minutes: number, radius: number, yRange: number, stepCost: number }
export const DEATH_SPOTS_DEFAULTS: DeathSpotsSettings = { enabled: true, minutes: 10, radius: 6, yRange: 4, stepCost: 8 }

/** settings.deathSpots with defaults. `false` = off. */
export function deathSpotsSettings (raw: unknown): DeathSpotsSettings {
  const o = raw === false ? { enabled: false } : obj(raw)
  const d = DEATH_SPOTS_DEFAULTS
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : d.enabled,
    minutes: num(o.minutes, d.minutes, 0.5, 240),
    radius: num(o.radius, d.radius, 1, 32),
    yRange: num(o.yRange, d.yRange, 1, 64),
    stepCost: num(o.stepCost, d.stepCost, 0, 50)
  }
}

/** The danger-zone kind a death spot is remembered as. */
export const DEATH_ZONE_KIND = 'death'
