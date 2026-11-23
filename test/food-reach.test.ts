// Food handling fixes: seed gathering stop rules, the reach effort for animals out of reach on
// foot, the far search rings and trips to known food places. Pure parts only, no server.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  planFood, seedStopReason, seedLimits, seedBreakBudget, chorePause, rankFoodPlaces, placeSource,
  CHORE_PAUSE_MS, SEEDS_RETRY_MS, DEFAULT_RINGS, type FoodWorld, type FoodStepOptions, type SearchRecord, type FoodPlace
} from '../src/skills/foodPlan.ts'
import { reachEffort, digIntoLiquid, type ReachSituation } from '../src/skills/reachPlan.ts'
import { ringsFor, knownFoodPlaces } from '../src/adapters/minecraft-java/behaviors/keepFed.ts'

const NOW = 1_000_000_000
const MIN = 60_000

// ------------------------------------------------------------------ seeds

const seedRun = { got: 0, want: 10, broken: 0, elapsedMs: 0, grassLeft: true, failsInRow: 0 }

test('seeds: a run with no seed after 18 grass keeps going', () => {
  const l = seedLimits(5)
  assert.equal(seedStopReason({ ...seedRun, want: 5, broken: 18, elapsedMs: 108_000 }, l), null)
})

test('seeds: stops when it has the seeds, at the time limit, when the grass runs out', () => {
  const l = seedLimits(10)
  assert.match(seedStopReason({ ...seedRun, got: 10, broken: 70 }, l)!, /got the 10 seeds/)
  assert.match(seedStopReason({ ...seedRun, got: 3, elapsedMs: 4 * MIN }, l)!, /time is up \(4 min\)/)
  assert.match(seedStopReason({ ...seedRun, got: 3, grassLeft: false }, l)!, /no more grass/)
  assert.match(seedStopReason({ ...seedRun, failsInRow: 12 }, l)!, /couldn't reach 12/)
  // having the seeds wins over everything else
  assert.match(seedStopReason({ ...seedRun, got: 10, grassLeft: false, elapsedMs: 5 * MIN }, l)!, /got the/)
})

test('seeds: the break budget grows with the seeds wanted (about 8 per seed, room for bad luck)', () => {
  assert.equal(seedBreakBudget(1), 48)
  assert.equal(seedBreakBudget(5), 120)
  assert.equal(seedBreakBudget(10), 240)
  assert.equal(seedBreakBudget(64), 400)
  assert.match(seedStopReason({ ...seedRun, want: 5, broken: 120 }, seedLimits(5))!, /broke 120 grass/)
  assert.equal(seedLimits(5, 3 * MIN).maxMs, 3 * MIN)
})

test('seeds: a short run with grass still around pauses the chore briefly', () => {
  assert.equal(chorePause('seeds', false, { grassLeft: true }), SEEDS_RETRY_MS)
  assert.ok(SEEDS_RETRY_MS < CHORE_PAUSE_MS.seeds.fail)
  assert.equal(chorePause('seeds', false, { grassLeft: false }), CHORE_PAUSE_MS.seeds.fail)
  assert.equal(chorePause('seeds', true, { grassLeft: true }), CHORE_PAUSE_MS.seeds.ok)
  assert.equal(chorePause('tend_farm', false, { grassLeft: true }), CHORE_PAUSE_MS.tend_farm.fail)
})

// ------------------------------------------------------------------ reach effort

const cave: ReachSituation = { canDig: true, canPlace: true, scaffold: 40, distance: 20, dy: -12, protectedTarget: false, dangerTarget: false }

test('reach: bridge or dig within a 16 block budget', () => {
  const d = reachEffort(cave)
  assert.ok(d.ok)
  if (!d.ok) return
  assert.equal(d.budget.blocks, 16, 'never more than the budget')
  assert.equal(d.budget.dig, true)
  assert.equal(d.budget.tower, false, 'the animal is below: no pillar')
  const up = reachEffort({ ...cave, dy: 4, scaffold: 5 })
  assert.ok(up.ok && up.budget.blocks === 5 && up.budget.tower, 'never more blocks than carried; pillar up to an animal above')
  const dig = reachEffort({ ...cave, scaffold: 0 })
  assert.ok(dig.ok && dig.budget.blocks === 0 && dig.budget.dig, 'no blocks: digging only')
  const place = reachEffort({ ...cave, canDig: false })
  assert.ok(place.ok && place.budget.blocks === 16 && !place.budget.dig, 'no digging: blocks only')
  const custom = reachEffort(cave, { maxBlocks: 8, maxMs: 20_000 })
  assert.ok(custom.ok && custom.budget.blocks === 8 && custom.budget.ms === 20_000)
})

test('reach: refusals say why', () => {
  const why = (s: Partial<ReachSituation>) => { const d = reachEffort({ ...cave, ...s }); return d.ok ? null : d.reason }
  assert.match(why({ protectedTarget: true })!, /protected area/)
  assert.match(why({ dangerTarget: true })!, /danger zone/)
  assert.match(why({ liquidAt: 'lava' })!, /lava/)
  assert.match(why({ distance: 70 })!, /70 blocks away/)
  assert.match(why({ dy: -51 })!, /51 blocks below/)
  assert.match(why({ canDig: false, canPlace: false })!, /neither dig nor place/)
  assert.match(why({ canDig: false, scaffold: 0 })!, /no blocks to build with/)
  // in water below: no digging down into it, blocks only
  assert.match(why({ liquidAt: 'water', scaffold: 0 })!, /down in water/)
  const bridge = reachEffort({ ...cave, liquidAt: 'water' })
  assert.ok(bridge.ok && !bridge.budget.dig && bridge.budget.blocks === 16)
})

test('reach: no digging straight down into water or lava', () => {
  assert.equal(digIntoLiquid(['stone', 'lava']), true)
  assert.equal(digIntoLiquid(['water']), true)
  assert.equal(digIntoLiquid(['stone', 'dirt']), false)
  assert.equal(digIntoLiquid([undefined, 'air']), false)
})

// ------------------------------------------------------------------ far rings and trips

const opts: FoodStepOptions = {
  chests: true, harvest: true, hunt: true, cook: true, eatRaw: true, scout: true, startFarm: true, radius: 64,
  rings: [...DEFAULT_RINGS], ringMemoryMs: 20 * MIN, minSeeds: 8, keepAtLeast: 2
}
const bare: FoodWorld = {
  hasReadyFood: false, raw: [], safeRaw: false, canCook: false, canBake: false, foodChest: false, ripeCrops: 0, animals: 0,
  herd: 0, food: 4, health: 20, canScout: true, canStartFarm: false, hasFarm: false, seeds: 0, grass: false, searches: [], now: NOW
}
const empty = (radius: number, minsAgo = 1): SearchRecord => ({ radius, at: NOW - minsAgo * MIN, found: false })
const village = { name: 'village', distance: 3500 }

test('rings: 400 and 600 come after 250, each only after the one before came up empty', () => {
  assert.deepEqual(ringsFor({ rings: [...DEFAULT_RINGS] }), [48, 120, 250, 400, 600])
  assert.equal(planFood({ ...bare, searches: [empty(120)] }, opts).radius, 250)
  assert.equal(planFood({ ...bare, searches: [empty(250)] }, opts).radius, 400)
  assert.equal(planFood({ ...bare, searches: [empty(250), empty(400)] }, opts).radius, 600)
  const all = planFood({ ...bare, searches: [empty(600)] }, opts)
  assert.equal(all.step, 'report')
  assert.match(all.reason, /every ring out to 600/)
})

test('rings: the far ones are searched by day only, even with scoutAtNight', () => {
  const night = { ...bare, night: true, searches: [empty(250)] }
  const bold = { ...opts, scoutAtNight: true }
  const d = planFood(night, bold)
  assert.notEqual(d.step, 'scout')
  assert.match(d.reason, /night: the 400 ring is searched by day only/)
  // the near rings still go at night with scoutAtNight
  assert.equal(planFood({ ...bare, night: true, searches: [empty(48)] }, bold).radius, 120)
  // and the wait is the night wait
  const idle = planFood({ ...night, food: 12 }, bold)
  assert.equal(idle.step, null)
  assert.equal(idle.retryMs, 2 * MIN)
})

test('trips: a known food place comes before the far rings, not before the near ones', () => {
  assert.equal(planFood({ ...bare, knownPlace: village }, opts).step, 'scout', 'the 48 ring first')
  assert.equal(planFood({ ...bare, knownPlace: village, searches: [empty(120)] }, opts).radius, 250, 'then 250')
  const d = planFood({ ...bare, knownPlace: village, searches: [empty(250)] }, opts)
  assert.equal(d.step, 'trip')
  assert.equal(d.rung, 'trip')
  assert.match(d.reason, /before searching 400 blocks out: known food place village 3500 blocks away/)
  // tried this run (or paused): the 400 ring next
  assert.equal(planFood({ ...bare, knownPlace: village, searches: [empty(250)] }, opts, new Set(['trip'])).radius, 400)
  // every ring empty: the trip is still worth it
  assert.equal(planFood({ ...bare, knownPlace: village, searches: [empty(600)] }, opts).step, 'trip')
  // not at night, not in danger, not when trips are off
  assert.notEqual(planFood({ ...bare, knownPlace: village, night: true, searches: [empty(600)] }, opts).step, 'trip')
  assert.notEqual(planFood({ ...bare, knownPlace: village, danger: true, searches: [empty(600)] }, opts).step, 'trip')
  assert.notEqual(planFood({ ...bare, knownPlace: village, searches: [empty(600)] }, { ...opts, trips: false }).step, 'trip')
  // known sources in range still come first
  assert.equal(planFood({ ...bare, knownPlace: village, searches: [empty(250)], ripeCrops: 3 }, opts).step, 'harvest')
})

test('known places: trusted and near first, paused, far, other-dimension and dangerous ones left out', () => {
  const places: FoodPlace[] = [
    { name: 'found:wheat', x: 300, z: 0, source: 'crops' },
    { name: 'village', x: 400, z: 0, source: 'config', crops: ['wheat'] },
    { name: 'food:animals', x: 200, z: 0, source: 'animals' },
    { name: 'farm:2', x: 0, z: 5000, source: 'farm' },
    { name: 'nether', x: 100, z: 0, dim: 'the_nether', source: 'config' },
    { name: 'farm:1', x: 20, z: 0, source: 'farm' },
    { name: 'found:village', x: 0, z: -600, source: 'village' },
    { name: 'food:village_farm', x: 410, z: 10, source: 'crops' }
  ]
  const ranked = rankFoodPlaces(places, { x: 0, z: 0 }, { dim: 'overworld', now: NOW })
  // config 400/1.5 = 267, crops 300/1.2 = 250, animals 200/0.6 = 333, village 600/1 = 600
  assert.deepEqual(ranked.map(p => p.name), ['found:wheat', 'village', 'food:animals', 'found:village'])
  assert.equal(ranked.find(p => p.name === 'village')?.distance, 400)
  const paused = rankFoodPlaces(places, { x: 0, z: 0 }, { dim: 'overworld', now: NOW, paused: { 'found:wheat': NOW + MIN } })
  assert.equal(paused[0]!.name, 'village')
  const safe = rankFoodPlaces(places, { x: 0, z: 0 }, { dim: 'overworld', now: NOW, inDanger: p => p.x > 250 })
  assert.deepEqual(safe.map(p => p.name), ['food:animals', 'found:village'])
  const far = rankFoodPlaces(places, { x: 0, z: 0 }, { now: NOW, maxDistance: 10_000 })
  assert.ok(far.some(p => p.name === 'farm:2'))
})

test('known places: which names count, and the profile list resolves place names', () => {
  assert.equal(placeSource('found:wheat'), 'crops')
  assert.equal(placeSource('found:carrot'), 'crops')
  assert.equal(placeSource('found:village'), 'village')
  assert.equal(placeSource('food:village_farm'), 'crops')
  assert.equal(placeSource('food:animals'), 'animals')
  assert.equal(placeSource('farm:1'), 'farm')
  assert.equal(placeSource('food:water'), null)
  assert.equal(placeSource('found:diamond_ore'), null)
  const store: Record<string, unknown> = {
    places: { 'farm:1': { x: 561, y: 62, z: -20, dimension: 'overworld' }, 'found:village': { x: 900, y: 70, z: 900 }, fortress: { x: 560, y: 68, z: -43 } },
    farms: [{ name: 'farm:1', x: 561, y: 62, z: -20, dim: 'overworld', size: 9, crop: 'wheat', created: 0 }]
  }
  const agent = { storage: { get: (k: string, d: unknown) => store[k] ?? d, set: () => {} } } as any
  const list = knownFoodPlaces(agent, { foodPlaces: [{ name: 'village', x: -2770, z: 1090, crops: ['wheat', 'carrots', 'potatoes'] }, { name: 'own farm', place: 'farm:1' }, { place: 'nowhere' }] })
  assert.deepEqual(list.map(p => `${p.name}:${p.source}`), ['village:config', 'own farm:config', 'farm:1:farm', 'farm:1:farm', 'found:village:village'])
  assert.equal(list[1]!.x, 561)
  // from home near the fortress the village is the trip
  const ranked = rankFoodPlaces(list, { x: 560, z: -46 }, { dim: 'overworld', now: NOW })
  assert.deepEqual(ranked.map(p => p.name), ['found:village', 'village'])
})
