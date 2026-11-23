// Farm upkeep and growth (planFarmWork), between-meals chores (farmChore), parallel farming in
// the ladder and the shared danger signals. Pure, no server.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planFarmWork, farmWorkCount, type FarmCell, type FarmGrid } from '../src/skills/farmPlan.ts'
import {
  planFood, farmChore, foodDanger, crossesDanger, CHORE_PAUSE_MS,
  type FoodWorld, type FoodStepOptions, type ChoreWorld, type ChoreOptions
} from '../src/skills/foodPlan.ts'
import { useDangerZones, inDangerZone, wayThroughDanger } from '../src/skills/food-danger.ts'

const C = { x: 100, y: 62, z: 200 }

/** A 9x9 grid: water in the middle, `fill` everywhere else, then the overrides ("dx,dz": kind). */
function grid (fill: FarmCell, over: Record<string, FarmCell> = {}): FarmGrid {
  const cells: Record<string, FarmCell> = {}
  for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) cells[`${dx},${dz}`] = fill
  cells['0,0'] = 'water'
  return { center: C, cells: { ...cells, ...over } }
}

/** Pax's farm:1: 7 farmland cells next to the water, 2 planted, the rest grass it could till. */
function paxFarm (): FarmGrid {
  const g = grid('dirt')
  for (const k of ['1,0', '-1,0', '0,1', '0,-1', '1,1', '-1,-1', '1,-1']) g.cells[k] = 'bare'
  g.cells['1,0'] = 'growing'; g.cells['-1,0'] = 'growing'
  // some stone and a fence post on the far side
  g.cells['4,4'] = 'blocked'; g.cells['-4,3'] = 'blocked'
  return g
}

test('planFarmWork: plants bare farmland first, nearest the water', () => {
  const w = planFarmWork(paxFarm(), { seeds: 3 })
  assert.equal(w.plant.length, 3)
  assert.equal(w.retill.length, 0, 'every seed went into bare farmland')
  assert.equal(w.extend.length, 0)
  assert.equal(w.size, 3)
  assert.equal(w.farmland, 7)
  assert.deepEqual(w.plant[0], { x: C.x, y: C.y, z: C.z - 1 }, 'next to the water first, ties broken the same way every time')
})

test('planFarmWork: re-tills trampled dirt inside the farm before growing it', () => {
  const g = paxFarm()
  g.cells['-1,1'] = 'dirt' // trampled, inside the 3x3
  const w = planFarmWork(g, { seeds: 10, seedReserve: 4 })
  assert.equal(w.plant.length, 5)
  assert.deepEqual(w.retill, [{ x: C.x - 1, y: C.y, z: C.z + 1 }])
  // 10 seeds - 5 planted - 1 re-tilled = 4 left, all of it the reserve: no growth
  assert.equal(w.extend.length, 0)
  assert.ok(w.seedsWanted > 0, 'wants seeds to grow')
})

test('planFarmWork: grows a ring at a time with seeds beyond the reserve, never past the target', () => {
  const g = grid('dirt', { '1,0': 'growing', '-1,0': 'growing', '0,1': 'growing', '0,-1': 'growing', '1,1': 'growing', '-1,-1': 'growing', '1,-1': 'growing', '-1,1': 'growing' })
  const w = planFarmWork(g, { seeds: 12, seedReserve: 4 })
  assert.equal(w.extend.length, 8)
  assert.ok(w.extend.every(p => Math.max(Math.abs(p.x - C.x), Math.abs(p.z - C.z)) === 2), 'the next ring out first')
  const small = planFarmWork(g, { seeds: 30, seedReserve: 4, targetSize: 5 })
  assert.equal(small.extend.length, 16, 'a 5x5 target stops at the second ring')
  assert.ok(small.extend.every(p => Math.max(Math.abs(p.x - C.x), Math.abs(p.z - C.z)) <= 2))
  assert.equal(planFarmWork(g, { seeds: 4, seedReserve: 4 }).extend.length, 0, 'the reserve is kept')
  assert.equal(planFarmWork(g, { seeds: 30, canTill: false }).extend.length, 0, 'no hoe or no digging: plant only')
})

test('planFarmWork: blocked cells and cells out of the water\'s reach are never tilled', () => {
  const g: FarmGrid = { center: C, cells: {} }
  // a 9x9 square with no water at all: nothing can be kept wet
  for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) g.cells[`${dx},${dz}`] = 'dirt'
  g.cells['0,0'] = 'blocked'
  const dry = planFarmWork(g, { seeds: 30 })
  assert.equal(farmWorkCount(dry), 0)
  assert.match(dry.reason, /water is gone/)
  // with a bucket the water goes back in the middle, and the plot can be tilled again
  const wet = planFarmWork(g, { seeds: 30, canWater: true })
  assert.deepEqual(wet.water, C)
  assert.ok(wet.extend.length > 0)
  const fenced = planFarmWork(grid('blocked', { '1,0': 'dirt' }), { seeds: 10, seedReserve: 0 })
  assert.equal(fenced.extend.length, 1, 'only the one dirt cell')
})

test('planFarmWork: a full, planted farm has nothing to do', () => {
  const w = planFarmWork(grid('growing'), { seeds: 20 })
  assert.equal(farmWorkCount(w), 0)
  assert.equal(w.size, 9)
  assert.equal(w.farmland, 80)
  assert.equal(w.seedsWanted, 0, 'the reserve is there')
  assert.match(w.reason, /nothing to do/)
})

// ------------------------------------------------------------------ chores between meals

const NOW = 1_000_000_000
const MIN = 60_000
const choreOpts: ChoreOptions = { growFarm: true, startFarm: true, breed: true, minSeeds: 8, farmAbove: 14, tendRange: 128 }
const fed: ChoreWorld = {
  food: 18, night: false, danger: false, hasFarm: true, canStartFarm: true, seeds: 6, grass: true, farmDistance: 30,
  farmWork: 5, farmSeedsWanted: 20, farmSize: 3, farmTarget: 9, canBreed: true, now: NOW
}

test('farmChore: tend and grow the farm, then seeds, then breed', () => {
  assert.equal(farmChore(fed, choreOpts)?.chore, 'tend_farm')
  assert.equal(farmChore({ ...fed, farmWork: 0 }, choreOpts)?.chore, 'seeds', 'small farm short of seeds: break grass')
  assert.equal(farmChore({ ...fed, farmWork: 0, grass: false }, choreOpts)?.chore, 'breed')
  assert.equal(farmChore({ ...fed, farmWork: 0, farmSize: 9, farmSeedsWanted: 2 }, choreOpts)?.chore, 'breed', 'full size: no seed walks')
  assert.equal(farmChore({ ...fed, farmDistance: 300 }, choreOpts)?.chore, 'breed', 'the farm is too far to tend')
})

test('farmChore: starts a farm with seeds even when food is around', () => {
  const none = { ...fed, hasFarm: false, farmDistance: null, farmWork: 0, farmSize: 0 }
  assert.equal(farmChore({ ...none, seeds: 9 }, choreOpts)?.chore, 'start_farm')
  assert.equal(farmChore({ ...none, seeds: 3 }, choreOpts)?.chore, 'seeds')
  assert.equal(farmChore({ ...none, seeds: 9 }, { ...choreOpts, startFarm: false })?.chore, 'breed', 'farming off: breeding still')
})

test('farmChore: never when hungry, at night or in danger; paused after it ran', () => {
  assert.equal(farmChore({ ...fed, food: 12 }, choreOpts), null, 'the ladder\'s turn')
  assert.equal(farmChore({ ...fed, night: true }, choreOpts), null)
  assert.equal(farmChore({ ...fed, danger: true }, choreOpts), null)
  const paused = { ...fed, paused: { tend_farm: NOW + CHORE_PAUSE_MS.tend_farm.ok } }
  assert.equal(farmChore(paused, choreOpts)?.chore, 'seeds')
  assert.equal(farmChore({ ...paused, now: NOW + 5 * MIN }, choreOpts)?.chore, 'tend_farm')
  assert.equal(farmChore({ ...fed, farmWork: 0, grass: false }, { ...choreOpts, breed: false }), null)
})

// ------------------------------------------------------------------ parallel farming in the ladder

const opts: FoodStepOptions = {
  chests: true, harvest: true, hunt: true, cook: true, eatRaw: true, scout: true, startFarm: true, radius: 32,
  rings: [48, 120, 250], ringMemoryMs: 20 * MIN, minSeeds: 8, keepAtLeast: 2
}
const bare: FoodWorld = {
  hasReadyFood: false, raw: [], safeRaw: false, canCook: false, canBake: false, foodChest: false, ripeCrops: 0, animals: 0,
  herd: 0, food: 15, health: 12, canScout: true, canStartFarm: true, hasFarm: false, seeds: 0, grass: false, searches: [], now: NOW
}

test('ladder: not urgent, the farm comes before a long search; hungry, food comes first', () => {
  const farmed = { ...bare, hasFarm: true, farmWork: 6, seeds: 6 }
  const d = planFood(farmed, opts)
  assert.equal(d.step, 'plant')
  assert.match(d.reason, /not urgent/)
  assert.equal(planFood({ ...farmed, food: 10 }, opts).step, 'scout', 'hungry: search first')
  assert.equal(planFood({ ...farmed, animals: 3 }, opts).step, 'hunt', 'animals in range still come first')
  assert.equal(planFood({ ...farmed, hasReadyFood: true }, opts).step, 'eat')
  assert.equal(planFood({ ...bare, seeds: 10 }, opts).step, 'start_farm', 'enough seeds: start one alongside')
  assert.equal(planFood({ ...bare, seeds: 10 }, { ...opts, growFarm: false }).step, 'scout')
  assert.equal(planFood({ ...farmed, danger: true }, opts).step, 'plant', 'with mobs near the search is off and the farm fallback tends it')
  assert.equal(planFood({ ...farmed, night: true, farmWork: 6 }, opts).step, 'plant', 'planting in range is fine at night')
})

test('ladder: farm work counts from planFarmWork; seeds are gathered when the farm is short', () => {
  const exhausted = { ...bare, food: 10, searches: [{ radius: 250, at: NOW - MIN, found: false }], hasFarm: true }
  assert.equal(planFood({ ...exhausted, farmWork: 0, farmEmpty: 4, seeds: 3 }, opts).step !== 'plant', true, 'no doable work: no plant step')
  assert.equal(planFood({ ...exhausted, farmWork: 0, farmSeedsWanted: 12, grass: true }, opts).step, 'seeds')
})

test('ladder: kelp and berries forage as stopgaps, apples only when critical', () => {
  const exhausted = { ...bare, food: 10, searches: [{ radius: 250, at: NOW - MIN, found: false }], canStartFarm: false }
  assert.equal(planFood({ ...exhausted, forage: 2 }, opts).step, 'forage')
  assert.equal(planFood({ ...exhausted, apples: 5 }, opts).step, null, 'not critical: leaves are not worth it')
  const d = planFood({ ...exhausted, food: 4, apples: 5 }, opts)
  assert.equal(d.step, 'forage')
  assert.equal(d.apples, true)
})

// ------------------------------------------------------------------ danger

test('foodDanger: the shared signals', () => {
  const calm = { ranged: false, close: 0, near: 0, health: 20, inZone: false }
  assert.equal(foodDanger(calm), null)
  assert.equal(foodDanger({ ...calm, ranged: true }), 'shooters around')
  assert.equal(foodDanger({ ...calm, close: 2, near: 2 }), null, 'two zombies at 6 blocks with full health is not a reason to stay home')
  assert.match(foodDanger({ ...calm, close: 3, near: 3 })!, /3 hostiles close/)
  assert.match(foodDanger({ ...calm, near: 1, health: 6 })!, /hurt/)
  assert.match(foodDanger({ ...calm, inZone: true })!, /danger zone/)
})

test('crossesDanger and the danger-zone adapter: no search towards a remembered zone', () => {
  const zone = (p: { x: number, z: number }) => Math.hypot(p.x - 60, p.z) < 10
  assert.equal(crossesDanger({ x: 0, z: 0 }, { x: 120, z: 0 }, zone), true, 'east goes through it')
  assert.equal(crossesDanger({ x: 0, z: 0 }, { x: 0, z: 120 }, zone), false, 'south is clear')
  assert.equal(inDangerZone(undefined, { x: 60, z: 0 }), false, 'no agent: no memory, nothing is a zone')
  useDangerZones(p => zone(p))
  try {
    assert.equal(inDangerZone(undefined, { x: 60, z: 0 }), true)
    assert.equal(wayThroughDanger(undefined, { x: 0, z: 0 }, { x: 120, z: 0 }), true)
    assert.equal(wayThroughDanger(undefined, { x: 0, z: 0 }, { x: -120, z: 0 }), false)
    useDangerZones(() => { throw new Error('broken') })
    assert.equal(inDangerZone(undefined, { x: 0, z: 0 }), false, 'a broken helper never blocks food')
  } finally { useDangerZones(null) }
})
