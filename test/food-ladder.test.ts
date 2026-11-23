// The keep_fed food ladder (planFood): pure decisions, no server.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  planFood, nextRing, recordSearch, dryWaypoint, scoutWaypoints, riskyRing, RING_MEMORY_MS, STEP_PAUSE_MS,
  type FoodWorld, type FoodStepOptions, type SearchRecord
} from '../src/skills/foodPlan.ts'
import { ringsFor } from '../src/adapters/minecraft-java/behaviors/keepFed.ts'

const NOW = 1_000_000_000
const MIN = 60_000

/** keep_fed's defaults as the planner sees them. */
const opts: FoodStepOptions = {
  chests: true, harvest: true, hunt: true, cook: true, eatRaw: true, scout: true, startFarm: true, radius: 32,
  rings: [48, 120, 250], ringMemoryMs: 20 * MIN, minSeeds: 8, keepAtLeast: 2
}
/** Hungry (13/20) by day, nothing around, can search and farm. */
const bare: FoodWorld = {
  hasReadyFood: false, raw: [], safeRaw: false, canCook: false, canBake: false, foodChest: false, ripeCrops: 0, animals: 0,
  herd: 0, food: 13, health: 20, canScout: true, canStartFarm: true, hasFarm: false, seeds: 0, grass: false, searches: [], now: NOW
}
const empty = (radius: number, minsAgo: number): SearchRecord => ({ radius, at: NOW - minsAgo * MIN, found: false })

test('ladder order: inventory, then known sources, then search, then farm', () => {
  const w: FoodWorld = { ...bare, farmDistance: 60, spotDistance: 24, animals: 3, herd: 5 }
  const steps: string[] = []
  const tried = new Set<any>()
  for (const extra of [{ hasReadyFood: true }, { raw: ['beef'], canCook: true }, { canBake: true }, { foodChest: true }, { ripeCrops: 4 }]) {
    const d = planFood({ ...w, ...extra }, opts)
    steps.push(`${d.rung}:${d.step}`)
  }
  assert.deepEqual(steps, ['inventory:eat', 'inventory:cook', 'inventory:bread', 'known:withdraw', 'known:harvest'])
  const seq: string[] = []
  for (let i = 0; i < 6; i++) {
    const d = planFood(w, opts, tried)
    if (!d.step) break
    seq.push(`${d.rung}:${d.step}`)
    tried.add(d.step)
  }
  assert.deepEqual(seq, ['known:farm', 'known:spot', 'known:hunt', 'search:scout', 'farm:start_farm'])
})

test('every decision carries a reason for the log', () => {
  const d = planFood(bare, opts)
  assert.equal(d.step, 'scout')
  assert.match(d.reason, /searching 48 blocks out/)
  const none = planFood({ ...bare, night: true, canStartFarm: false }, opts)
  assert.equal(none.step, null)
  assert.match(none.reason, /night/)
})

test('search widens only after the smaller ring came up empty', () => {
  assert.deepEqual([planFood(bare, opts).radius, planFood(bare, opts).minRadius], [48, 0], 'close first')
  const w1 = { ...bare, searches: [empty(48, 2)] }
  assert.deepEqual([planFood(w1, opts).radius, planFood(w1, opts).minRadius], [120, 48], 'then wider, skipping the inner ring')
  assert.match(planFood(w1, opts).reason, /nothing within 48 blocks, widening to 120/)
  const w2 = { ...bare, searches: [empty(48, 9), empty(120, 3)] }
  assert.equal(planFood(w2, opts).radius, 250, 'then wide')
  // a ring that found food does not count as empty
  const found = { ...bare, searches: [{ radius: 48, at: NOW - MIN, found: true }] }
  assert.equal(planFood(found, opts).radius, 48)
  // an empty wide search covers the small rings too
  assert.equal(nextRing([empty(120, 1)], [48, 120, 250], NOW)?.radius, 250)
})

test('empty rings are remembered for a while, then searched again', () => {
  const all = { ...bare, canStartFarm: false, searches: [empty(48, 30), empty(120, 15), empty(250, 5)] }
  // 48 is older than 20 min: forgotten, but 120 and 250 still cover it
  assert.equal(nextRing(all.searches, [48, 120, 250], NOW, RING_MEMORY_MS), null)
  assert.equal(planFood(all, opts).step, null, 'all rings empty and no farm fallback: nothing to do')
  assert.match(planFood(all, opts).reason, /every ring out to 250 came up empty/)
  const later = { ...all, now: NOW + 16 * MIN } // the 250 search is now 21 min old: every ring forgotten
  assert.equal(planFood(later, opts).radius, 48, 'after ringMemory the close ring is searched again')
  // the record list stays short
  let recs: SearchRecord[] = []
  for (let i = 0; i < 20; i++) recs = recordSearch(recs, { radius: 48, at: NOW + i * MIN, found: false })
  assert.equal(recs.length, 12)
  assert.equal(recordSearch([empty(48, 200)], { radius: 120, at: NOW, found: false }).length, 1, 'very old records dropped')
})

test('farm fallback: only once every ring is empty; seeds first, then start, then fill the farm', () => {
  const exhausted = { ...bare, searches: [empty(250, 1)] }
  assert.equal(planFood({ ...bare, seeds: 10 }, opts).step, 'scout', 'rings left: search before farming')
  // no farm yet
  assert.equal(planFood({ ...exhausted, seeds: 10 }, opts).step, 'start_farm')
  assert.equal(planFood({ ...exhausted, seeds: 2, grass: true }, opts).step, 'seeds', 'too few seeds with grass near: gather first')
  assert.equal(planFood({ ...exhausted, seeds: 2, grass: false }, opts).step, 'start_farm', 'no grass here: start_farm looks further for grass')
  assert.equal(planFood({ ...exhausted, seeds: 10 }, { ...opts, startFarm: false }).step, null, 'farm fallback off')
  // has a farm: plant its bare farmland, get seeds for it, breed, berries
  const farmed = { ...exhausted, hasFarm: true, canStartFarm: true }
  assert.equal(planFood({ ...farmed, farmEmpty: 7, seeds: 3 }, opts).step, 'plant')
  assert.equal(planFood({ ...farmed, farmEmpty: 7, seeds: 0, grass: true }, opts).step, 'seeds')
  assert.equal(planFood({ ...farmed, canBreed: true }, opts).step, 'breed')
  assert.equal(planFood({ ...farmed, forage: 3 }, opts).step, 'forage', 'berries as a stopgap while the wheat grows')
  const growing = planFood({ ...farmed, farmGrowing: 12 }, opts)
  assert.equal(growing.step, null)
  assert.equal(growing.retryMs, 3 * MIN, 'checks the growing farm again in a few minutes, not a flat 5')
  // its own farm, once ripe, comes before everything out in the world
  assert.equal(planFood({ ...farmed, farmDistance: 20 }, opts).step, 'farm')
  // night: no new farm, no seed walks; planting its farm in range is fine
  assert.equal(planFood({ ...exhausted, seeds: 10, night: true }, opts).step, null)
  assert.equal(planFood({ ...farmed, farmEmpty: 7, seeds: 3, night: true }, opts).step, 'plant')
})

test('animals scarce or the search too dangerous also lead to the farm, never into danger', () => {
  const danger = { ...bare, danger: true, seeds: 10 }
  const d = planFood(danger, opts)
  assert.equal(d.step, 'start_farm', 'hostiles near: no search, farm near home instead')
  assert.match(d.reason, /hostiles near/)
  assert.equal(planFood({ ...danger, spotDistance: 100 }, opts).step, 'start_farm', 'no far trip to a spot with mobs around')
})

test('seeds are collected while searching when a farm might be needed', () => {
  assert.equal(planFood({ ...bare, seeds: 3 }, opts).seeds, 5, 'asks find_food for the 5 it lacks')
  assert.equal(planFood({ ...bare, seeds: 12 }, opts).seeds, undefined, 'enough already')
  assert.equal(planFood({ ...bare, seeds: 0 }, { ...opts, startFarm: false }).seeds, undefined, 'no farm fallback: no seed picking')
})

test('breeders are kept unless starving or keepBreeders is off', () => {
  // two cows in range, both breeders: not food
  const w = { ...bare, animals: 0, herd: 2 }
  assert.equal(planFood(w, opts).step, 'scout', 'look elsewhere')
  assert.equal(planFood(w, opts).keepAtLeast, 2, 'and find_food only counts animals beyond the breeders')
  const starving = planFood({ ...w, starving: true, food: 4 }, opts)
  assert.equal(starving.step, 'hunt')
  assert.equal(starving.keepAtLeast, 0)
  // keepBreeders off: keep_fed passes keepAtLeast 0, and senseFood counts every adult as huntable
  assert.equal(planFood({ ...w, animals: 2 }, { ...opts, keepAtLeast: 0 }).keepAtLeast, 0)
  assert.equal(planFood({ ...bare, animals: 3, herd: 5 }, opts).keepAtLeast, 2)
})

test('critical food: report once (rate limited), then stay put', () => {
  const stuck: FoodWorld = { ...bare, food: 5, night: true, canStartFarm: false }
  const d = planFood(stuck, opts)
  assert.equal(d.step, 'report')
  assert.equal(d.rung, 'critical')
  assert.match(d.reason, /food 5\/20 and nothing left to try \(night or a storm\)/)
  assert.equal(planFood({ ...stuck, lastReportAt: NOW - 3 * MIN }, opts).step, null, 'reported 3 minutes ago: quiet')
  assert.equal(planFood({ ...stuck, lastReportAt: NOW - 11 * MIN }, opts).step, 'report', 'again after 10 minutes')
  assert.equal(planFood(stuck, opts, new Set(['report'])).step, null, 'once per run')
  assert.equal(planFood({ ...stuck, food: 9 }, opts).step, null, 'not critical: no report')
  // berries come first when critical and the farm fallback is on
  const farmed = { ...bare, food: 4, searches: [empty(250, 1)], hasFarm: true, forage: 2, farmEmpty: 5, seeds: 4 }
  assert.equal(planFood(farmed, opts).step, 'forage')
})

test('the wait after a failed run depends on the rung', () => {
  assert.equal(planFood({ ...bare, night: true, canStartFarm: false }, opts).retryMs, 2 * MIN, 'night: look again in 2 min')
  const all = { ...bare, canStartFarm: false, searches: [empty(250, 1)] }
  assert.equal(planFood(all, opts).retryMs, 5 * MIN, 'nothing at all: 5 min')
  assert.equal(planFood({ ...all, food: 5, lastReportAt: NOW }, opts).retryMs, 2 * MIN, 'critical: sooner')
  assert.equal(planFood({ ...bare, danger: true, canStartFarm: false }, opts).retryMs, 45_000, 'mobs near: they usually pass soon')
})

test('paused steps (failed in an earlier run) are skipped until their pause ends', () => {
  const w = { ...bare, farmDistance: 30, paused: { farm: NOW + 5 * MIN } }
  assert.equal(planFood(w, opts).step, 'scout')
  assert.equal(planFood({ ...w, now: NOW + 6 * MIN }, opts).step, 'farm')
})

test('ringsFor: the old scoutRadius caps the rings', () => {
  assert.deepEqual(ringsFor({ rings: [48, 120, 250] }), [48, 120, 250])
  assert.deepEqual(ringsFor({ rings: [250, 48, 120], scoutRadius: 200 }), [48, 120, 200])
  assert.deepEqual(ringsFor({ rings: [48, 120, 250], scoutRadius: 40 }), [40])
})

test('wet waypoints: a dry spot near it instead, never one known to be wet', () => {
  const c = { x: 0, z: 0 }
  const w = { x: -120, z: 0 } // west, out at sea past x = -100
  const sea = (p: { x: number, z: number }) => p.x < -100
  const alt = dryWaypoint(c, w, sea)!
  assert.ok(alt && !sea(alt), JSON.stringify(alt))
  assert.ok(Math.hypot(alt.x, alt.z) < 120, 'pulled in towards home')
  assert.equal(dryWaypoint(c, w, () => true), null, 'water everywhere around it: skip')
  const unknown = dryWaypoint(c, w, p => p.x < -110 ? true : null)
  assert.ok(unknown, 'not loaded is fine (the walk will see)')
})

test('scout waypoints: a wider search skips the rings a smaller one covered', () => {
  const inner = scoutWaypoints({ x: 0, z: 0 }, 120, { minRadius: 48 })
  assert.ok(inner.every(w => w.distance > 48))
  assert.ok(inner.some(w => w.distance === 64) && inner.some(w => w.distance === 120))
  const wide = scoutWaypoints({ x: 0, z: 0 }, 250, { minRadius: 120 })
  assert.ok(wide.every(w => w.distance > 120))
  assert.deepEqual(scoutWaypoints({ x: 0, z: 0 }, 48).map(w => w.distance)[0], 48)
})

test('keep_fed ladder options validate and coerce from chat', async () => {
  const { defaultBehaviorRegistry } = await import('../src/brains/behaviors/index.ts')
  const reg = defaultBehaviorRegistry()
  const c = reg.coerce('keep_fed', 'rings=40,100,200 ringMemoryMinutes=30 keepBreeders=false startFarm=false')
  assert.deepEqual(c, { rings: [40, 100, 200], ringMemoryMinutes: 30, keepBreeders: false, startFarm: false })
  assert.ok(reg.validate('keep_fed', c).ok)
  const d = reg.validate('keep_fed', {})
  assert.ok(d.ok)
  assert.deepEqual((d.options as any).rings, [48, 120, 250, 400, 600])
  assert.equal((d.options as any).keepBreeders, true)
  assert.ok(!reg.validate('keep_fed', { rings: [5000] }).ok)
})

test('a search that just found food is a source: no farm fallback, the spot comes next', () => {
  const found = { ...bare, searches: [{ radius: 120, at: NOW - MIN, found: true }], seeds: 0, grass: true }
  const d = planFood(found, opts, new Set(['scout', 'hunt']))
  assert.equal(d.step, null, 'not seeds or a farm right after finding rabbits')
  assert.equal(d.retryMs, 20_000, 'and back soon')
  assert.equal(planFood({ ...found, spotDistance: 50 }, opts, new Set(['scout'])).step, 'spot')
  // a failed step pauses itself, but spots never pause globally (each spot has its own empty-visit pause)
  assert.equal(STEP_PAUSE_MS.spot, 0)
})

test('farm chore: a full-size farm with empty cells and no seeds goes for seeds', async () => {
  const { farmChore } = await import('../src/skills/foodPlan.ts')
  const w: any = { night: false, danger: false, food: 15, seeds: 0, grass: true, hasFarm: true, farmDistance: 20, farmWork: 0, farmSeedsWanted: 50, farmSize: 9, farmTarget: 9, canStartFarm: true, canBreed: false, paused: {}, now: 1 }
  const c = farmChore(w, { growFarm: true, startFarm: true, breed: true, minSeeds: 8, farmAbove: 14, tendRange: 128 } as any)
  assert.equal(c?.chore, 'seeds')
})

// Pax, 23 Nov 2026: food 12, stone tools, no armour (gear about 25), its farm replanted and growing.
// The ladder widened to 120 blocks, it met three skeletons out there and died.
test('risky rings: poor gear and food not urgent keep it near home', () => {
  const pax: FoodWorld = { ...bare, food: 12, gear: 25, hasFarm: true, farmGrowing: 5, farmWork: 0, searches: [empty(48, 2)] }
  const d = planFood(pax, opts)
  assert.notEqual(d.step, 'scout', 'no 120-block trip at food 12 with stone tools')
  assert.match(d.reason, /gear 25 is under 40/)
  assert.ok(d.retryMs >= 3 * MIN, 'waits for the crops instead of retrying in 20 s')
  // the near ring is fine
  assert.equal(planFood({ ...pax, searches: [] }, opts).step, 'scout')
  assert.equal(planFood({ ...pax, searches: [] }, opts).radius, 48)
  // farm work to do: it tends the farm instead
  assert.equal(planFood({ ...pax, farmWork: 6, seeds: 6 }, opts).step, 'plant')
  // hungry enough, geared, starving, or the rule off: it goes
  assert.equal(planFood({ ...pax, food: 8 }, opts).radius, 120)
  assert.equal(planFood({ ...pax, gear: 50 }, opts).radius, 120)
  assert.equal(planFood({ ...pax, starving: true }, opts).radius, 120)
  assert.equal(planFood({ ...pax, gear: undefined }, opts).radius, 120, 'no gear reading: the old ladder')
  assert.equal(planFood(pax, { ...opts, scoutGear: 0 }).radius, 120)
  assert.equal(planFood(pax, { ...opts, scoutHungerAt: 12 }).radius, 120)
  assert.equal(planFood(pax, { ...opts, riskyRingsFrom: 120 }).radius, 120)
  // bread from the harvest still comes first
  assert.equal(planFood({ ...pax, canBake: true }, opts).step, 'bread')
})

test('risky rings: the rule on its own', () => {
  assert.equal(riskyRing(48, { gear: 10, food: 14 }), null, 'the near ring is never risky')
  assert.match(riskyRing(120, { gear: 10, food: 14 })!, /not scouting 120 blocks out/)
  assert.equal(riskyRing(120, { gear: 10, food: 8 }), null)
  assert.equal(riskyRing(120, { gear: 40, food: 14 }), null)
  assert.equal(riskyRing(120, { food: 14 }), null)
  assert.equal(riskyRing(250, { gear: 39, food: 9 }, { scoutGear: 40, scoutHungerAt: 8 }) !== null, true)
})
