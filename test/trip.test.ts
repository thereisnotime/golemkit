// Trip preparation and the turn-back budget (src/core/trip.ts), plus the pantry pick and
// daylight reading of the Minecraft wiring (src/skills/trip.ts, containers.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  tripSettings, planTripPrep, tripNotReadyText, tripStart, turnBackReason, walkHomeMs,
  beginTrip, activeTrip, endTrip, checkTrip, TripTurnBackError, TRIP_DEFAULTS, DAYLIGHT_MS,
  type TripKit, type TripSample
} from '../src/core/trip.ts'
import { foodToTake } from '../src/skills/containers.ts'
import { daylightMs } from '../src/skills/trip.ts'
import { tripRun } from '../src/adapters/minecraft-java/behaviors/trip.ts'

const S = TRIP_DEFAULTS
const kit = (k: Partial<TripKit> = {}): TripKit => ({ foodItems: 8, pantryItems: 0, weapon: true, health: 20, bar: 20, ...k })
const at = (s: Partial<TripSample> = {}): TripSample => ({ bar: 20, carried: 0, items: 0, distanceHome: 200, daylightMs: 600_000, ...s })

test('settings: defaults, overrides, junk ignored', () => {
  assert.deepEqual(tripSettings(undefined), S)
  const s = tripSettings({ food: 12, minFood: 20, turnBackAt: 3, speed: 0, needWeapon: 'yes', minHealth: -1 })
  assert.equal(s.food, 12)
  assert.equal(s.minFood, 12, 'never more than it tops up to')
  assert.equal(s.turnBackAt, 1)
  assert.equal(s.speed, S.speed)
  assert.equal(s.needWeapon, true)
  assert.equal(s.minHealth, S.minHealth)
})

test('prep: ready with food, weapon, health', () => {
  const p = planTripPrep(kit(), S, 'wood')
  assert.equal(p.go, true)
  assert.equal(p.topUp, 0)
  assert.deepEqual(p.missing, [])
})

test('prep: tops up from the pantry to trips.food', () => {
  assert.equal(planTripPrep(kit({ foodItems: 2, pantryItems: 30 }), S, 'wood').topUp, 6)
  assert.equal(planTripPrep(kit({ foodItems: 2, pantryItems: 3 }), S, 'wood').topUp, 3)
  const p = planTripPrep(kit({ foodItems: 0, pantryItems: 3 }), S, 'wood')
  assert.equal(p.go, false, '3 items after the top-up is under minFood 4')
  assert.match(tripNotReadyText(p, 'looking for trees'), /not ready for a trip \(looking for trees\): food 3 of 4 items/)
})

test('prep: no weapon or low health keeps it home', () => {
  const p = planTripPrep(kit({ weapon: false, health: 8 }), S, 'ore')
  assert.equal(p.go, false)
  assert.deepEqual(p.missing, ['no weapon', 'health 8/20 (needs 12)'])
  assert.equal(planTripPrep(kit({ weapon: false }), S, 'wood', ['weapon']).go, true, 'a waived check')
})

test('prep: a food trip needs no food along, but the weapon unless starving', () => {
  assert.equal(planTripPrep(kit({ foodItems: 0, bar: 12 }), S, 'food').go, true)
  const armed = planTripPrep(kit({ foodItems: 0, bar: 12, weapon: false }), S, 'food')
  assert.equal(armed.go, false)
  const starving = planTripPrep(kit({ foodItems: 0, bar: 4, weapon: false, health: 6 }), S, 'food')
  assert.equal(starving.go, true)
  assert.equal(starving.starving, true)
  assert.equal(planTripPrep(kit({ foodItems: 0, bar: 4, weapon: false }), S, 'wool').go, false, 'only food trips go starving')
})

test('prep: trips.enabled off always goes', () => {
  assert.equal(planTripPrep(kit({ weapon: false, foodItems: 0, health: 2 }), { ...S, enabled: false }, 'ore').go, true)
})

test('budget: turn back at half the food it left with (the Pax trip: 12 -> 0)', () => {
  const start = tripStart(at({ bar: 12, carried: 0 }))
  assert.equal(turnBackReason(start, at({ bar: 8 }), S), null)
  assert.match(turnBackReason(start, at({ bar: 6 }), S)!, /food down to 6 of the 12 I left with/)
})

test('budget: carried food counts, eating it does not', () => {
  const start = tripStart(at({ bar: 20, carried: 40, items: 8 }))
  // ate two pieces of bread (5 each) and the bar is back up: nothing spent overall
  assert.equal(turnBackReason(start, at({ bar: 20, carried: 30, items: 6 }), S), null)
  assert.match(turnBackReason(start, at({ bar: 14, carried: 16, items: 3 }), S)!, /food down to 30 of the 60/)
})

test('budget: food floor with nothing left to eat', () => {
  const start = tripStart(at({ bar: 20, carried: 100, items: 20 }))
  assert.match(turnBackReason(start, at({ bar: 6, carried: 0, items: 0 }), { ...S, turnBackAt: 0 })!, /food bar at 6 and nothing left to eat/)
  assert.equal(turnBackReason(start, at({ bar: 6, carried: 0, items: 0 }), { ...S, turnBackAt: 0, foodFloor: 0 }), null)
})

test('budget: starving food trips have no food rule', () => {
  const start = tripStart(at({ bar: 5 }), true)
  assert.equal(turnBackReason(start, at({ bar: 1 }), S), null)
})

test('budget: daylight about the walk home plus the margin', () => {
  const start = tripStart(at())
  // 240 blocks at 3 b/s = 80 s home, + 60 s margin = 140 s
  assert.equal(turnBackReason(start, at({ distanceHome: 240, daylightMs: 200_000 }), S), null)
  assert.match(turnBackReason(start, at({ distanceHome: 240, daylightMs: 130_000 }), S)!, /130 s of daylight left and 80 s of walking home \(240 blocks\)/)
  assert.match(turnBackReason(start, at({ distanceHome: 240, daylightMs: 0 }), S)!, /getting dark/)
  assert.match(turnBackReason(start, at({ storm: true }), S)!, /thunderstorm/)
  assert.equal(walkHomeMs(300, 3), 100_000)
})

test('budget: no daylight rule for night trips, expeditions, or near home', () => {
  assert.equal(turnBackReason(tripStart(at({ daylightMs: 0 })), at({ daylightMs: 0 }), S), null, 'started in the dark')
  const far = tripStart(at(), false, 3500)
  assert.equal(far.dark, true, 'the way back from 3500 blocks is longer than a day')
  assert.equal(turnBackReason(far, at({ daylightMs: 10_000, distanceHome: 2000 }), S), null)
  assert.equal(turnBackReason(tripStart(at()), at({ distanceHome: 10, daylightMs: 0, bar: 1 }), S), null)
  assert.equal(turnBackReason(tripStart(at()), at({ distanceHome: null, daylightMs: 1000 }), S), null, 'no home, nowhere to turn back to')
  assert.equal(turnBackReason(tripStart(at({ bar: 12 })), at({ bar: 2, daylightMs: 0 }), { ...S, enabled: false }), null)
})

test('trip context: one per client, turn() aborts its signal, stale end is ignored', () => {
  const client = {}
  assert.equal(activeTrip(client), null)
  const trip = beginTrip(client, { purpose: 'scouting', kind: 'food', settings: S, start: tripStart(at()) })
  assert.equal(activeTrip(client), trip)
  checkTrip(client)
  trip.turn('food down to 6 of the 12 I left with')
  assert.equal(trip.signal.aborted, true)
  assert.ok(trip.signal.reason instanceof TripTurnBackError)
  assert.throws(() => checkTrip(client), /turned back: food down to 6/)
  trip.returning = true
  checkTrip(client)
  trip.turn('again')
  assert.equal(trip.turnBack, 'food down to 6 of the 12 I left with', 'first reason kept')
  const next = beginTrip(client, { purpose: 'b', kind: 'wood', settings: S, start: tripStart(at()) })
  endTrip(client, trip)
  assert.equal(activeTrip(client), next)
  endTrip(client, next)
  assert.equal(activeTrip(client), null)
})

test('pantry: best food first, up to what is wanted', () => {
  const pts: Record<string, number> = { bread: 5, cooked_beef: 8, apple: 4 }
  const points = (n: string) => pts[n] ?? 0
  assert.deepEqual(foodToTake({ bread: 10, cooked_beef: 3, cobblestone: 64 }, 8, points), { cooked_beef: 3, bread: 5 })
  assert.deepEqual(foodToTake({ cobblestone: 64 }, 8, points), {})
  assert.deepEqual(foodToTake({ apple: 2 }, 0, points), {})
})

test('daylight from the world time', () => {
  const bot = (t: number) => ({ time: { timeOfDay: t } }) as any
  assert.equal(daylightMs(bot(12_542)), 0)
  assert.equal(daylightMs(bot(18_000)), 0)
  assert.equal(daylightMs(bot(6_000)), (12_542 - 6_000) * 50)
  assert.equal(daylightMs(bot(23_500)), (24_000 - 23_500 + 12_542) * 50)
  assert.equal(daylightMs({} as any), DAYLIGHT_MS)
})

// ------------------------------------------------------------------ tripRun (behaviours)

function fakeCtx (o: { prep?: { ok: boolean, message: string, data?: unknown }, settings?: Record<string, unknown>, food?: number } = {}) {
  const calls: { name: string, params: unknown }[] = []
  const said: string[] = []
  const store: Record<string, unknown> = { home: { x: 0, y: 64, z: 0 } }
  const bot = {
    food: o.food ?? 12,
    health: 20,
    time: { timeOfDay: 1000 },
    game: { dimension: 'overworld' },
    entity: { position: { x: 200, y: 64, z: 0 } },
    inventory: { items: () => [] },
    registry: { foodsByName: {} },
    players: {}
  }
  const agent = {
    settings: o.settings ?? {},
    owners: ['Robin'],
    storage: { get: (k: string, d?: unknown) => store[k] ?? d, set: (k: string, v: unknown) => { store[k] = v } },
    getAction: () => ({}),
    say: (t: string) => { said.push(t) },
    whisper: (_p: string, t: string) => { said.push(t) }
  }
  const ctx = {
    agent, bot, log: { debug () {}, info () {}, warn () {} },
    async act (name: string, params: unknown) {
      calls.push({ name, params })
      if (name === 'prepare_trip') return o.prep ?? { ok: true, message: 'ready', data: { prep: { go: true, topUp: 0, equipWeapon: true, missing: [] } } }
      return { ok: true, message: `${name} done` }
    }
  }
  return { ctx: ctx as any, calls, said, bot }
}

test('tripRun: a refused preparation is the result, nothing else runs', async () => {
  const f = fakeCtx({ prep: { ok: false, message: 'not ready for a trip: no weapon', data: { trip: true } } })
  let went = false
  const r = await tripRun(f.ctx, { purpose: 'looking for sheep', kind: 'wool', distance: 120 }, async () => { went = true; return { ok: true, message: 'x' } })
  assert.equal(went, false)
  assert.equal(r.ok, false)
  assert.match(r.message, /no weapon/)
})

test('tripRun: short trips and trips.enabled off skip the preparation', async () => {
  const f = fakeCtx()
  await tripRun(f.ctx, { purpose: 'p', kind: 'food', distance: 30 }, async () => ({ ok: true, message: 'x' }))
  const g = fakeCtx({ settings: { trips: { enabled: false } } })
  await tripRun(g.ctx, { purpose: 'p', kind: 'food', distance: 300 }, async () => ({ ok: true, message: 'x' }))
  assert.deepEqual([...f.calls, ...g.calls], [])
})

test('tripRun: a turn-back walks home and reports it', async () => {
  const f = fakeCtx({ food: 12 })
  const r = await tripRun(f.ctx, { purpose: 'scouting 250 blocks out for food', kind: 'food', distance: 250 }, async () => {
    const trip = activeTrip(f.bot)!
    assert.ok(trip, 'the trip is registered while it runs')
    f.bot.food = 5
    // the budget timer would notice within 2 s; call the planner directly to keep the test fast
    trip.turn(turnBackReason(trip.start, { bar: 5, carried: 0, items: 0, distanceHome: 200, daylightMs: 500_000 }, S)!)
    throw new TripTurnBackError(trip.turnBack!)
  })
  assert.equal(r.ok, false)
  assert.match(r.message, /^turned back: food down to 5 of the 12 I left with \(scouting 250 blocks out for food\), back home$/)
  assert.deepEqual(f.calls.map(c => c.name), ['prepare_trip', 'go_home'])
  assert.equal(f.said.length, 0, 'no owner online: the turn-back is only logged, not said in public chat')
  assert.equal(activeTrip(f.bot), null, 'trip ended')
})

test('planTripPrep: well fed with nothing to take along may leave; with food in the pantry it takes some', async () => {
  const { planTripPrep, tripSettings } = await import('../src/core/trip.ts')
  const S2 = tripSettings({})
  const kit = { foodItems: 0, pantryItems: 0, weapon: true, health: 20, bar: 20 }
  assert.equal(planTripPrep(kit, S2, 'wood').go, true, 'full bar, no pantry: the bar is the food it brings')
  assert.equal(planTripPrep({ ...kit, bar: 12 }, S2, 'wood').go, false, 'half a bar and nothing along: stays')
  const withPantry = planTripPrep({ ...kit, pantryItems: 16 }, S2, 'wood')
  assert.equal(withPantry.go, true)
  assert.equal(withPantry.topUp, S2.food)
})

test('planTripPrep: a food trip leaves from foodMinHealth when the bar is under 18 (waiting would not heal)', () => {
  // Pax at 6 health, 12 food: every food trip refused for health, and health never came back
  assert.equal(planTripPrep(kit({ health: 6, bar: 12 }), S, 'food').go, true)
  assert.equal(planTripPrep(kit({ health: 5, bar: 12 }), S, 'food').go, false)
  // well fed: it heals by waiting, so the normal 12 applies
  assert.equal(planTripPrep(kit({ health: 6, bar: 18 }), S, 'food').go, false)
  // other trips keep the normal rule
  assert.equal(planTripPrep(kit({ health: 6, bar: 12 }), S, 'wood').go, false)
})
