// Boxed in: solid on all four sides at the feet and at the head, with a lid a few blocks up. That is
// what a bunker leaves when something interrupts it before it climbs out: Pax sat sealed 3 blocks
// down for an hour while go_home timed out every 5 minutes (28 Nov 2026). A room in a house has an
// open side, so it doesn't count; travel climbs out of a box first.

/** sides: the 4 cells next to the feet then the 4 next to the head, true when solid. roofDy: blocks to the first solid block above the head, or null. */
export function boxedIn (sides: readonly boolean[], roofDy: number | null, maxRoof = 3): boolean {
  if (roofDy === null || roofDy > maxRoof) return false
  return sides.length >= 8 && sides.slice(0, 8).every(Boolean)
}

/** What to do about a box before walking: climb out by day; at night the sealed pit is the safest place (Pax climbed out at night and was killed twice in 10 minutes). */
export function pitAction (boxed: boolean, night: boolean): 'none' | 'climb' | 'stay' {
  if (!boxed) return 'none'
  return night ? 'stay' : 'climb'
}
