// Remembered danger zones, as keep_fed, find_food and hunt see them. The zones live in the core
// danger memory (core/danger.ts, one per agent); the ranged reflex and others write them, and
// this reads them whatever skills are loaded. Tests can swap the check with useDangerZones.
import { dangerMemory, type Agent } from '../core/index.ts'
import { crossesDanger, type XZ } from './foodPlan.ts'

export type DangerZoneCheck = (pos: { x: number, y?: number, z: number }, agent?: Agent) => boolean

/** The default check: the agent's core danger memory. No agent, no zones. */
export const dangerZoneCheck: DangerZoneCheck = (pos, agent) => !!agent && !!dangerMemory(agent).isInDanger(pos)

let check: DangerZoneCheck = dangerZoneCheck

/** Replaces the danger-zone test (tests); null puts the default back. */
export function useDangerZones (fn: DangerZoneCheck | null): void {
  check = fn ?? dangerZoneCheck
}

/** True when `pos` lies in a remembered danger zone. Never throws. */
export function inDangerZone (agent: Agent | undefined, pos: { x: number, y?: number, z: number }): boolean {
  try { return !!check(pos, agent) } catch { return false }
}

/** True when the straight way from `from` to `to` passes through a remembered danger zone. */
export function wayThroughDanger (agent: Agent | undefined, from: XZ, to: XZ): boolean {
  return crossesDanger(from, to, p => inDangerZone(agent, p))
}
