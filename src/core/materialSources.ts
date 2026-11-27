// Material sources: where a bot gets the blocks a build or a repair still needs, as an ordered
// list it works through (profile key `materials:`). Game-agnostic: plain source names and
// numbers. The Minecraft side (src/skills/materialSourcePlan.ts plans, materialSources.ts does
// the work) turns them into chest withdrawals, crafting, digging and mine trips. See
// docs/guide/base-projects.md#where-materials-come-from.
import { z } from 'zod'

/**
 * Where materials come from, tried in this order by default:
 * chests (its own chests, from container memory), substitutes (other blocks the blueprint role
 * accepts, carried or in its chests), craft (items made from wood or stone it has or chops),
 * nearby (digging and chopping close by), mine (a trip down its own staircase mine, which yields
 * stone), far (stone dug further out, past the ground it keeps whole under its base).
 */
export const MATERIAL_SOURCES = ['chests', 'substitutes', 'craft', 'nearby', 'mine', 'far'] as const
export type MaterialSource = typeof MATERIAL_SOURCES[number]

export const MaterialSourcesSettingsSchema = z.object({
  sources: z.array(z.enum(MATERIAL_SOURCES)).optional().describe('where materials come from, in this order: chests, substitutes (other blocks the blueprint accepts), craft, nearby (dig and chop close by), mine (its own staircase mine), far (stone dug further out); leave one out to turn it off (default all, in that order)'),
  retryMinutes: z.number().min(0).max(1440).optional().describe('a source that gave nothing of an item is skipped for that item this long (default 30; 0 = always try again)'),
  mineMinutes: z.number().min(1).max(60).optional().describe('longest trip down its own mine for build blocks (default 6)'),
  farDistance: z.number().int().min(8).max(160).optional().describe('far: how many blocks past the base (and its keep-out) to start digging for stone (default 32)'),
  farTries: z.number().int().min(1).max(8).optional().describe('far: spots tried, nearest first, before giving up (default 3)')
}).strict()

export interface MaterialSourcesSettings {
  sources: MaterialSource[]
  retryMinutes: number
  mineMinutes: number
  farDistance: number
  farTries: number
}

export const MATERIAL_SOURCES_DEFAULTS: MaterialSourcesSettings = {
  sources: [...MATERIAL_SOURCES], retryMinutes: 30, mineMinutes: 6, farDistance: 32, farTries: 3
}

const obj = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
const num = (v: unknown, d: number, min: number, max: number): number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : d

/** settings.materials with defaults; wrong values fall back to the default. Pure. */
export function materialSourcesSettings (raw: unknown): MaterialSourcesSettings {
  const o = obj(raw)
  const d = MATERIAL_SOURCES_DEFAULTS
  const sources = Array.isArray(o.sources)
    ? [...new Set(o.sources.filter((t): t is MaterialSource => (MATERIAL_SOURCES as readonly string[]).includes(t as string)))]
    : [...d.sources]
  return {
    sources,
    retryMinutes: num(o.retryMinutes, d.retryMinutes, 0, 1440),
    mineMinutes: num(o.mineMinutes, d.mineMinutes, 1, 60),
    farDistance: Math.round(num(o.farDistance, d.farDistance, 8, 160)),
    farTries: Math.round(num(o.farTries, d.farTries, 1, 8))
  }
}
