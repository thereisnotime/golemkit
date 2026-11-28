// When the pathfinder may sprint. Sprinting (and the sprint-jumps the pathfinder makes) burns food
// about ten times faster than walking: Pax lost 6 food points in 45 s of a food trip and turned back
// at the trip food floor before it got anywhere (28 Nov 2026). Below `pathfinder.sprintAbove` food
// every walk is a walk; fights still sprint on their own (fight.ts).

export const SPRINT_ABOVE_DEFAULT = 12

/** pathfinder.sprintAbove with fallback: a number 0..20, else the default (0 = always sprint). */
export function sprintAbove (raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? Math.min(20, Math.max(0, raw)) : SPRINT_ABOVE_DEFAULT
}

/** Whether travel may sprint at this food level. Unknown food: yes. */
export function sprintAllowed (food: number | null | undefined, above: number): boolean {
  if (typeof food !== 'number' || above <= 0) return true
  return food > above
}
