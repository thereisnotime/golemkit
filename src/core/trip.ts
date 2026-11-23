// Trips away from home: what to have before leaving (food, a weapon, health) and when to turn
// back (food spent, daylight running out). The planner is pure and game-agnostic (test/trip.test.ts);
// the adapter samples the body (food bar, carried food, daylight left, distance home) and walks.
//
// Pax starved twice on 2026-11-23: keep_fed scouted 120 and 250 blocks out for food, the food bar
// went 12 -> 0 in six minutes, and it died out there (shot, drowned). These rules are the answer:
// top up from the pantry before leaving, and turn back at half of what it left with.
//
// A trip is registered per game client (activeTrip) so code deep inside a walk (the adapter's
// travel legs, scouting loops) sees it without being handed it. The adapter's check timer sets
// `turnBack` and aborts `signal`; travel then throws TripTurnBackError, and whoever started the
// trip walks home and reports "turned back: ...".

/** settings.trips (profile `settings: trips:`, live with config_set trips.*). */
export interface TripSettings {
  /** Prepare for and budget trips that behaviours start. Default true. */
  enabled: boolean
  /** Food items to top up to from the pantry or the bot's own chests before leaving. Default 8. */
  food: number
  /** Fewest food items to leave with when the top-up falls short (it says so and stays). Default 4. */
  minFood: number
  /** Hold a weapon (sword or axe) for the trip; with none it stays. Default true. */
  needWeapon: boolean
  /** Health (of 20) below which it doesn't leave. Default 12. */
  minHealth: number
  /** Turn back when the food left (bar + carried) drops to this fraction of what it left with. Default 0.5. */
  turnBackAt: number
  /** Turn back when the food bar is at or below this and no food is carried (0 = off). Default 6. */
  foodFloor: number
  /** Turn back when the daylight left is about the walk home plus this many seconds. Default 60. */
  daylightMarginS: number
  /** Walking speed for the way home, blocks per second (paths wind; walking is 4.3). Default 3. */
  speed: number
  /** Trips shorter than this (blocks from home) need no preparation. Default 64. */
  minDistance: number
  /** Also prepare and budget actions an owner ordered (chop_tree, find_food, upgrade_tools). Default false. */
  ownerOrders: boolean
}

export const TRIP_DEFAULTS: TripSettings = {
  enabled: true,
  food: 8,
  minFood: 4,
  needWeapon: true,
  minHealth: 12,
  turnBackAt: 0.5,
  foodFloor: 6,
  daylightMarginS: 60,
  speed: 3,
  minDistance: 64,
  ownerOrders: false
}

/** settings.trips merged over the defaults; wrong types fall back to the default. */
export function tripSettings (raw: unknown): TripSettings {
  const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const out: TripSettings = { ...TRIP_DEFAULTS }
  for (const k of Object.keys(TRIP_DEFAULTS) as (keyof TripSettings)[]) {
    const v = o[k]
    if (v === undefined || typeof v !== typeof TRIP_DEFAULTS[k]) continue
    if (typeof v === 'number' && (!Number.isFinite(v) || v < 0)) continue
    (out as unknown as Record<string, unknown>)[k] = v
  }
  if (out.speed <= 0) out.speed = TRIP_DEFAULTS.speed
  if (out.turnBackAt > 1) out.turnBackAt = 1
  if (out.minFood > out.food) out.minFood = out.food
  return out
}

/** What the trip is for: food trips may go hungry, the others need the kit. */
export type TripKind = 'food' | 'wood' | 'wool' | 'ore' | 'travel'

/** What the bot has before leaving. */
export interface TripKit {
  /** Food items carried (edible, not rotten flesh or poison). */
  foodItems: number
  /** Food items it could take from its pantry or own chests within reach (known contents). */
  pantryItems: number
  /** Holds or carries a weapon. */
  weapon: boolean
  health: number
  /** Food bar, 0-20. */
  bar: number
}

export interface TripPrep {
  /** Leave now. */
  go: boolean
  /** Food items to fetch from the pantry first (0 = none). */
  topUp: number
  /** Hold the weapon it carries. */
  equipWeapon: boolean
  /** What is missing, short ("no weapon", "food 1 of 4 items", "health 8/20 (needs 12)"). */
  missing: string[]
  /** Starving and the trip is for food: it goes whatever is missing, and the food rule of the budget is off (home has nothing either). */
  starving?: boolean
}

/** Food bar at or above which a trip may leave without food items when there are none to take along. */
export const FED_ENOUGH_BAR = 16

/** Food bar at or below which a food trip goes whatever is missing (nothing at home helps). */
export const STARVING_BAR = 6

/**
 * The pre-trip check: top up food from the pantry to `food` items, hold a weapon, have the
 * health. A trip that can't be made ready doesn't start, unless the bot is starving and the trip
 * is for food. Food trips don't need `minFood` items (getting food is the point). `waive` lists checks the caller lifts (a wood trip with no weapon and no wood:
 * the wood is what makes the weapon).
 */
export function planTripPrep (kit: TripKit, s: TripSettings, kind: TripKind, waive: ('weapon' | 'food' | 'health')[] = []): TripPrep {
  if (!s.enabled) return { go: true, topUp: 0, equipWeapon: false, missing: [] }
  const topUp = Math.max(0, Math.min(s.food - kit.foodItems, kit.pantryItems))
  const after = kit.foodItems + topUp
  const missing: string[] = []
  if (s.needWeapon && !kit.weapon && !waive.includes('weapon')) missing.push('no weapon')
  // a food trip is how it gets food: it can't take along what it hasn't got (the pantry top-up still runs).
  // Well fed with nothing to take along (no pantry, a bot starting from nothing): the bar is the
  // food it brings, and the budget turns it back at half of it. Seen in the survival bench: a
  // full bar and no food items kept it from ever fetching wood, so it never got tools or food.
  const fedEnough = kit.bar >= FED_ENOUGH_BAR && kit.pantryItems === 0
  if (after < s.minFood && kind !== 'food' && !fedEnough && !waive.includes('food')) missing.push(after ? `food ${after} of ${s.minFood} items` : 'no food to take along')
  if (kit.health < s.minHealth && !waive.includes('health')) missing.push(`health ${Math.round(kit.health)}/20 (needs ${s.minHealth})`)
  const starving = kind === 'food' && kit.bar <= STARVING_BAR
  return {
    go: missing.length === 0 || starving,
    topUp,
    equipWeapon: kit.weapon,
    missing,
    ...(starving ? { starving: true } : {})
  }
}

/** "not ready for a trip: no weapon, food 1 of 4 items". */
export function tripNotReadyText (p: TripPrep, purpose?: string): string {
  return `not ready for ${purpose ? `a trip (${purpose})` : 'a trip'}: ${p.missing.join(', ')}`
}

/** The body at a moment on the trip. */
export interface TripSample {
  /** Food bar, 0-20. */
  bar: number
  /** Food points carried (sum over food items). */
  carried: number
  /** Food items carried. */
  items: number
  /** Distance home (horizontal), null without a home. */
  distanceHome: number | null
  /** Milliseconds of daylight left; 0 at night or in a storm; null when the game has no day and night. */
  daylightMs: number | null
  /** A thunderstorm (mobs spawn as at night). */
  storm?: boolean
}

/** What a trip remembers from its start. */
export interface TripStart {
  /** Food it left with: bar + carried food points. */
  reserve: number
  bar: number
  /** Started in the dark (an allowed night trip): no daylight rule. */
  dark: boolean
  /** Started starving for food: no food rule (home has nothing either). */
  starving: boolean
  /** One-way distance planned; a trip whose way back alone takes more than a day has no daylight rule. */
  planned?: number
}

/** Length of a Minecraft day's light (ticks 23460 -> 12542, about 654 s); a game passes its own. */
export const DAYLIGHT_MS = 654_000

export function tripStart (s: TripSample, starving = false, planned?: number, dayMs = DAYLIGHT_MS, sp = TRIP_DEFAULTS.speed): TripStart {
  const out: TripStart = { reserve: s.bar + s.carried, bar: s.bar, dark: s.daylightMs === 0, starving }
  if (planned !== undefined) out.planned = planned
  // an expedition (the way back alone is longer than a day): it can't be home by night anyway
  if (planned !== undefined && planned / sp * 1000 > dayMs) out.dark = true
  return out
}

/** Seconds to walk home from `distance` at `speed` blocks/s. */
export function walkHomeMs (distance: number, speed: number): number {
  return distance / Math.max(0.1, speed) * 1000
}

/**
 * Why to turn back now, or null to carry on: the food left (bar + carried) at or below
 * `turnBackAt` of what it left with; the bar at the floor with nothing to eat; or daylight left
 * about the walk home plus the margin (a storm counts as dark). Near home there is nothing to
 * turn back from.
 */
export function turnBackReason (start: TripStart, now: TripSample, s: TripSettings): string | null {
  if (!s.enabled) return null
  if (now.distanceHome !== null && now.distanceHome < 16) return null
  const reserve = now.bar + now.carried
  if (!start.starving && start.reserve > 0 && reserve <= start.reserve * s.turnBackAt) {
    return `food down to ${Math.round(reserve)} of the ${Math.round(start.reserve)} I left with`
  }
  if (!start.starving && s.foodFloor > 0 && now.items === 0 && now.bar <= s.foodFloor && start.bar > s.foodFloor) {
    return `food bar at ${now.bar} and nothing left to eat`
  }
  if (!start.dark && now.distanceHome !== null && now.daylightMs !== null) {
    const back = walkHomeMs(now.distanceHome, s.speed)
    if (now.storm) return `a thunderstorm, ${Math.round(now.distanceHome)} blocks from home`
    if (now.daylightMs <= back + s.daylightMarginS * 1000) {
      return now.daylightMs <= 0
        ? `it is getting dark, ${Math.round(now.distanceHome)} blocks from home`
        : `${Math.round(now.daylightMs / 1000)} s of daylight left and ${Math.round(back / 1000)} s of walking home (${Math.round(now.distanceHome)} blocks)`
    }
  }
  return null
}

// ------------------------------------------------------------------ the shared trip context

export interface Trip {
  purpose: string
  kind: TripKind
  settings: TripSettings
  start: TripStart
  startedAt: number
  /** Set once the budget says turn back. */
  turnBack: string | null
  /** Walking home after turning back: travel no longer stops for the budget. */
  returning: boolean
  /** Aborted when the budget says turn back. */
  signal: AbortSignal
  /** Sets turnBack and aborts signal (the adapter's check timer calls it). */
  turn (reason: string): void
}

/** Thrown by travel and scouting loops when the trip's budget says turn back. */
export class TripTurnBackError extends Error {
  constructor (reason: string) { super(`turned back: ${reason}`) }
}

const trips = new WeakMap<object, Trip>()

/** Registers a trip for a game client (one at a time; an inner trip joins the outer one). */
export function beginTrip (client: object, o: { purpose: string, kind: TripKind, settings: TripSettings, start: TripStart, now?: number }): Trip {
  const ctl = new AbortController()
  const trip: Trip = {
    purpose: o.purpose,
    kind: o.kind,
    settings: o.settings,
    start: o.start,
    startedAt: o.now ?? Date.now(),
    turnBack: null,
    returning: false,
    signal: ctl.signal,
    turn (reason: string) {
      if (trip.turnBack || trip.returning) return
      trip.turnBack = reason
      ctl.abort(new TripTurnBackError(reason))
    }
  }
  trips.set(client, trip)
  return trip
}

/** The trip a client is on, if any. */
export function activeTrip (client: object | null | undefined): Trip | null {
  return client ? trips.get(client) ?? null : null
}

/** Ends a trip (only the one given, so a stale end can't drop a newer trip). */
export function endTrip (client: object, trip: Trip): void {
  if (trips.get(client) === trip) trips.delete(client)
}

/** Throws TripTurnBackError when the client's trip has turned back and isn't walking home yet. */
export function checkTrip (client: object | null | undefined): void {
  const t = activeTrip(client)
  if (t?.turnBack && !t.returning) throw new TripTurnBackError(t.turnBack)
}

/** Re-throws a turn-back caught by a loop that swallows leg errors. */
export function rethrowTurnBack (e: unknown): void {
  if (e instanceof TripTurnBackError) throw e
}
