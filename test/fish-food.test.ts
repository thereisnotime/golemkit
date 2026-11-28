// The rod plan and the starving rules of the food ladder: rod plan, shore spot, rotten flesh, chest wheat, closest sure food.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planFood, scoutAtNightFor, failPause, NOT_READY_PAUSE_MS, STEP_PAUSE_MS, type FoodWorld, type FoodStepOptions } from '../src/skills/foodPlan.ts'
import { rodPlan } from '../src/skills/fishPlan.ts'

const NOW = 1_000_000_000
const opts: FoodStepOptions = {
  chests: true, harvest: true, hunt: true, cook: true, eatRaw: true, scout: true, startFarm: true, radius: 64,
  rings: [48, 120, 250, 400], ringMemoryMs: 180 * 60_000, minSeeds: 8, keepAtLeast: 2, fish: true, eatRottenAt: 6, starvingRange: 96
}
/** Pax on 28 Nov 2026: food 5, snowy biome, nothing carried, the inner rings searched empty, a village 3500 blocks away. */
const pax: FoodWorld = {
  hasReadyFood: false, raw: [], safeRaw: false, canCook: false, canBake: false, foodChest: false, ripeCrops: 0, animals: 0,
  herd: 0, food: 5, health: 12, starving: true, canScout: true, canStartFarm: true, hasFarm: true, seeds: 0, grass: false,
  searches: [{ radius: 48, at: NOW - 60_000, found: false }, { radius: 120, at: NOW - 60_000, found: false }, { radius: 250, at: NOW - 60_000, found: false }],
  knownPlace: { name: 'village', distance: 3500 }, now: NOW
}

test('rodPlan: carried, in a chest, craftable, string from a chest, or none', () => {
  assert.equal(rodPlan({ inv: { fishing_rod: 1 }, stored: {}, canCraft: true }).step, 'have')
  assert.deepEqual(rodPlan({ inv: {}, stored: { fishing_rod: 1 }, canCraft: false }).take, { fishing_rod: 1 })
  assert.equal(rodPlan({ inv: { string: 2, stick: 3 }, stored: {}, canCraft: true }).step, 'craft')
  assert.equal(rodPlan({ inv: { string: 2, spruce_planks: 2 }, stored: {}, canCraft: true }).step, 'craft')
  const w = rodPlan({ inv: { string: 1, stick: 8 }, stored: { string: 3 }, canCraft: true })
  assert.deepEqual([w.step, w.take], ['withdraw', { string: 1 }])
  const p = rodPlan({ inv: { string: 2 }, stored: { oak_planks: 10 }, canCraft: true })
  assert.deepEqual([p.step, p.take], ['withdraw', { oak_planks: 2 }])
  assert.equal(rodPlan({ inv: { string: 2, spruce_log: 1 }, stored: {}, canCraft: true }).step, 'craft')
  assert.equal(rodPlan({ inv: { stick: 3 }, stored: { string: 1 }, canCraft: true }).step, 'none')
  assert.equal(rodPlan({ inv: { string: 2, stick: 3 }, stored: {}, canCraft: false }).step, 'none')
})

test('starving with rotten flesh and nothing else: eats it first', () => {
  assert.equal(planFood({ ...pax, rotten: 18 }, opts).step, 'eat_rotten')
  // not when real food is carried, not when food is above the threshold, not with the option off
  assert.equal(planFood({ ...pax, rotten: 18, hasReadyFood: true }, opts).step, 'eat')
  assert.notEqual(planFood({ ...pax, rotten: 18, food: 10, starving: false }, opts).step, 'eat_rotten')
  assert.notEqual(planFood({ ...pax, rotten: 18 }, { ...opts, eatRottenAt: 0 }).step, 'eat_rotten')
})

test('wheat in its chests: takes it to bake bread before searching', () => {
  const d = planFood({ ...pax, chestWheat: 2, carriedWheat: 1 }, opts)
  assert.deepEqual([d.step, d.rung], ['bread', 'known'])
  assert.notEqual(planFood({ ...pax, chestWheat: 1, carriedWheat: 1 }, opts).step, 'bread')
})

test('open water near home and a rod: fishes, after hunting and before any trip or search', () => {
  assert.equal(planFood({ ...pax, fishDistance: 25 }, opts).step, 'fish')
  assert.equal(planFood({ ...pax, fishDistance: 25, animals: 2 }, opts).step, 'hunt')
  // at night only when starving
  assert.equal(planFood({ ...pax, fishDistance: 25, night: true }, opts).step, 'fish')
  assert.notEqual(planFood({ ...pax, food: 12, starving: false, fishDistance: 25, night: true }, opts).step, 'fish')
  // hostiles near: no
  assert.notEqual(planFood({ ...pax, fishDistance: 25, danger: true }, opts).step, 'fish')
  // option off
  assert.notEqual(planFood({ ...pax, fishDistance: 25 }, { ...opts, fish: false }).step, 'fish')
})

test('starving: no trip to a food place 3500 blocks away; a near one is fine', () => {
  assert.notEqual(planFood(pax, opts).step, 'trip')
  assert.equal(planFood({ ...pax, knownPlace: { name: 'farm', distance: 80 } }, opts).step, 'trip')
  // not starving: the far place is still worth a trip by day
  assert.equal(planFood({ ...pax, food: 12, starving: false }, opts).step, 'trip')
  // food 7 with starvingRangeAt 8: no trip either (Pax set off at 7 and turned back at 6 within seconds)
  assert.notEqual(planFood({ ...pax, food: 7, starving: false }, { ...opts, starvingRangeAt: 8 }).step, 'trip')
  assert.equal(planFood({ ...pax, food: 9, starving: false }, { ...opts, starvingRangeAt: 8 }).step, 'trip')
})

test('scoutAtNightFor: the near ring at night goes, a wide one does not, the profile option wins', () => {
  assert.equal(scoutAtNightFor(true, 48, { riskyRingsFrom: 48 }), true)
  assert.equal(scoutAtNightFor(true, 120, { riskyRingsFrom: 48 }), false)
  assert.equal(scoutAtNightFor(false, 120, {}), false)
  assert.equal(scoutAtNightFor(true, 400, { scoutAtNight: true }), true)
})

test('failPause: a trip refused before leaving rests a few minutes; other failures keep their pause', () => {
  assert.equal(failPause('scout', 'not ready for a trip (scouting 120 blocks out for food): health 1/20 (needs 6)'), NOT_READY_PAUSE_MS)
  assert.equal(failPause('spot', 'not ready for a trip (going to a animal spot): health 6/20 (needs 12)'), NOT_READY_PAUSE_MS)
  assert.equal(failPause('scout', 'scouted 43 blocks, no animals'), STEP_PAUSE_MS.scout)
  assert.equal(failPause('withdraw', 'no chest with food that I know of'), STEP_PAUSE_MS.withdraw)
})
