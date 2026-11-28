// Base-anchored state: storage keys and place names that only mean something around the base a
// bot works from (a base project's progress, its farms, ring searches around home). Modules that
// keep such state register it here when they load; whatever moves a bot to a new base (start_over)
// drops what is registered instead of naming other modules' keys. Game-agnostic.

const KEYS = new Set<string>()
const PLACES = new Set<string>()

/**
 * Registers storage keys (exact) and place names (exact, prefix* or *suffix) tied to the base.
 * Call it at module load: `baseAnchored({ keys: ['farms'], places: ['farm:*'] })`.
 */
export function baseAnchored (o: { keys?: readonly string[], places?: readonly string[] }): void {
  for (const k of o.keys ?? []) KEYS.add(k)
  for (const p of o.places ?? []) PLACES.add(p)
}

/** The registered base-anchored storage keys, sorted. */
export function baseAnchoredKeys (): string[] {
  return [...KEYS].sort()
}

/** The registered base-anchored place name patterns, sorted. */
export function baseAnchoredPlaces (): string[] {
  return [...PLACES].sort()
}
