// Where the bot's base is, without reading the world: the base blueprint placed at the spot the
// settings name (projects.base) or the one base projects settled on (storage projects.spots).
// Small and cached, so mining can ask it for every block it thinks of digging: digging for stone
// or ore stays out of the ground under the base (settings.baseSafety.keepOutDepth) and out of a
// recent death spot (settings.deathSpots). See docs/guide/base-safety.md.
import type { Agent } from '../core/index.ts'
import { projectsSettings, baseSafetySettings, dangerMemory, DEATH_ZONE_KIND } from '../core/index.ts'
import { loadLibrary, libraryDirs } from './blueprint-library.ts'
import { rotate, placeCells, bounds, type Facing, type Pos, type WorldCell } from './blueprint.ts'
import { blueprintStages, interiorOf } from './basePlan.ts'
import { inFootprint, type BaseArea } from './baseSafetyPlan.ts'

export interface SettledBase {
  template: string
  origin: Pos
  facing: Facing
  cells: WorldCell[]
  area: BaseArea
}

type AgentLike = Pick<Agent, 'storage' | 'settings'>

const cache = new WeakMap<object, { at: number, sig: string, base: SettledBase | null }>()
const TTL_MS = 30_000

/** The base's spot from the settings or from what base projects settled on, or null. */
function anchorOf (agent: AgentLike): { template: string, origin: Pos, facing?: Facing } | null {
  const s = projectsSettings((agent.settings as { projects?: unknown }).projects)
  if (s.base) return { template: s.template, origin: { x: Math.floor(s.base.x), y: Math.floor(s.base.y), z: Math.floor(s.base.z) }, ...(s.base.facing ? { facing: s.base.facing } : {}) }
  const a = agent.storage.get<{ anchor?: { origin: Pos, facing: Facing } }>('projects.spots', {})?.anchor
  return a ? { template: s.template, origin: a.origin, facing: a.facing } : null
}

/** The settled base (blueprint, footprint, inside), or null when there is none yet. Cached for 30 s. */
export function settledBase (agent: AgentLike, now = Date.now()): SettledBase | null {
  const a = anchorOf(agent)
  const sig = a ? `${a.template}@${a.origin.x},${a.origin.y},${a.origin.z}/${a.facing ?? ''}` : ''
  const c = cache.get(agent)
  if (c && c.sig === sig && now - c.at < TTL_MS) return c.base
  let base: SettledBase | null = null
  if (a) {
    try {
      const bp = loadLibrary(libraryDirs(agent as Agent)).blueprints.get(a.template)
      if (bp) {
        const facing = a.facing ?? bp.facing
        const turned = rotate(bp, facing)
        const cells = placeCells(turned, a.origin)
        const box = bounds(turned, a.origin)
        const floorRoles = blueprintStages(bp).find(s => s.name === 'floor')?.roles ?? ['floor']
        const interior = interiorOf(cells, floorRoles)
        const inside = new Set((interior?.cols ?? []).map(c => `${c.x},${c.z}`))
        base = {
          template: a.template, origin: a.origin, facing, cells,
          area: { min: { x: box.min.x, z: box.min.z }, max: { x: box.max.x, z: box.max.z }, floorY: interior?.y ?? a.origin.y, inside: (x, z) => inside.has(`${x},${z}`) }
        }
      }
    } catch { base = null }
  }
  cache.set(agent, { at: now, sig, base })
  return base
}

/**
 * Whether digging for resources at `p` is off limits, and why: the ground under the base and its
 * margin down to keepOutDepth (a bot that mines its stone right under the floor digs the cave it
 * dies in), or a recent death spot. Builds and fixes don't ask this; only stone and ore digging.
 */
export function digKeepOut (agent: AgentLike, p: Pos): string | null {
  const s = baseSafetySettings((agent.settings as { baseSafety?: unknown }).baseSafety)
  if (s.enabled && s.keepOutDepth > 0) {
    const b = settledBase(agent)
    if (b) {
      const m = s.margin
      const a = b.area
      if (inFootprint({ min: { x: a.min.x - m, z: a.min.z - m }, max: { x: a.max.x + m, z: a.max.z + m } }, p.x, p.z) && p.y <= a.floorY && p.y >= a.floorY - s.keepOutDepth) return 'under the base'
    }
  }
  if (dangerMemory(agent).isInDanger(p, 0, DEATH_ZONE_KIND)) return 'a recent death spot'
  return null
}

/**
 * When `p` stands over the base's keep-out ground: the nearest column just outside it (so a stone
 * dig starts there, not through the floor), else null. Pure apart from the cached base.
 */
export function stepOutOfKeepOut (agent: AgentLike, p: Pos): { x: number, z: number } | null {
  const s = baseSafetySettings((agent.settings as { baseSafety?: unknown }).baseSafety)
  if (!s.enabled || s.keepOutDepth <= 0) return null
  const b = settledBase(agent)
  if (!b) return null
  return keepOutExit(b.area, s.margin, p)
}

/** The nearest column outside footprint + margin (+1), or null when `p` is outside already. Pure. */
export function keepOutExit (a: Pick<BaseArea, 'min' | 'max'>, margin: number, p: { x: number, z: number }): { x: number, z: number } | null {
  const x0 = a.min.x - margin
  const x1 = a.max.x + margin
  const z0 = a.min.z - margin
  const z1 = a.max.z + margin
  if (p.x < x0 || p.x > x1 || p.z < z0 || p.z > z1) return null
  const opts = [
    { x: x0 - 1, z: p.z, d: p.x - x0 + 1 },
    { x: x1 + 1, z: p.z, d: x1 + 1 - p.x },
    { x: p.x, z: z0 - 1, d: p.z - z0 + 1 },
    { x: p.x, z: z1 + 1, d: z1 + 1 - p.z }
  ].sort((u, v) => u.d - v.d)
  return { x: Math.floor(opts[0]!.x), z: Math.floor(opts[0]!.z) }
}
