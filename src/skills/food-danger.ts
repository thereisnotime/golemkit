// Remembered danger zones, as keep_fed and find_food see them. The zones themselves belong to
// the safety code (an `isInDanger(pos)` helper); this adapter keeps the food code from
// depending on where that lives. Until a check is registered nothing counts as a zone.
// To switch over, call useDangerZones(isInDanger) where the helper is defined, or import it
// here directly once it exists.
import type { Agent } from '../core/index.ts'
import { crossesDanger, type XZ } from './foodPlan.ts'

export type DangerZoneCheck = (pos: { x: number, y?: number, z: number }, agent?: Agent) => boolean

let check: DangerZoneCheck | null = null

/** Registers the shared danger-zone test (null to clear it, e.g. in tests). */
export function useDangerZones (fn: DangerZoneCheck | null): void {
  check = fn
}

/** True when `pos` lies in a remembered danger zone. Never throws. */
export function inDangerZone (agent: Agent | undefined, pos: { x: number, y?: number, z: number }): boolean {
  if (!check) return false
  try { return !!check(pos, agent) } catch { return false }
}

/** True when the straight way from `from` to `to` passes through a remembered danger zone. */
export function wayThroughDanger (agent: Agent | undefined, from: XZ, to: XZ): boolean {
  if (!check) return false
  return crossesDanger(from, to, p => inDangerZone(agent, p))
}
