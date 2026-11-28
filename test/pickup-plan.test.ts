import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickupSettings, newPickupMemory, recordAirBreak, dropUnreachable, reachableDrops, prunePickupMemory, isAirBreak, PICKUP_DEFAULTS } from '../src/skills/pickupPlan.ts'

const s = PICKUP_DEFAULTS
const drop = (id: number, x = 10, y = 50, z = 10) => ({ id, pos: { x, y, z } })
const MIN = 60_000

test('pickup settings: defaults and per-key fallback', () => {
  assert.deepEqual(pickupSettings(undefined), { maxAirBreaks: 2, unreachableMinutes: 10, matchRadius: 2 })
  assert.deepEqual(pickupSettings({ maxAirBreaks: 3, unreachableMinutes: -1, matchRadius: 'x' }), { maxAirBreaks: 3, unreachableMinutes: 10, matchRadius: 2 })
  assert.deepEqual(pickupSettings([1]), PICKUP_DEFAULTS)
})

test('pickup: a drop is given up after maxAirBreaks air breaks, once', () => {
  const m = newPickupMemory()
  assert.deepEqual(recordAirBreak(m, drop(1), 0, s), { breaks: 1, gaveUp: false })
  assert.equal(dropUnreachable(m, drop(1), 1000, s), false)
  assert.deepEqual(recordAirBreak(m, drop(1), 5000, s), { breaks: 2, gaveUp: true })
  assert.equal(dropUnreachable(m, drop(1), 6000, s), true)
  // a third break doesn't log again
  assert.deepEqual(recordAirBreak(m, drop(1), 7000, s), { breaks: 3, gaveUp: false })
})

test('pickup: drops lying with it (or the same one drifted) count as the same spot; far ones do not', () => {
  const m = newPickupMemory()
  recordAirBreak(m, drop(1), 0, s)
  recordAirBreak(m, drop(2, 11, 50, 10), 1000, s) // a second drop a block away: same record
  assert.equal(dropUnreachable(m, drop(3, 10, 49, 11), 2000, s), true)
  assert.equal(dropUnreachable(m, drop(1, 14, 50, 10), 2000, s), true, 'by id after drifting')
  assert.equal(dropUnreachable(m, drop(4, 20, 50, 10), 2000, s), false)
})

test('pickup: given-up drops are forgotten after unreachableMinutes, and so are old air breaks', () => {
  const m = newPickupMemory()
  recordAirBreak(m, drop(1), 0, s)
  recordAirBreak(m, drop(1), 1000, s)
  assert.equal(dropUnreachable(m, drop(1), 1000 + 9 * MIN, s), true)
  assert.equal(dropUnreachable(m, drop(1), 1000 + 10 * MIN, s), false)
  const m2 = newPickupMemory()
  recordAirBreak(m2, drop(1), 0, s)
  // eleven minutes later the first break is gone: one break is not enough
  assert.deepEqual(recordAirBreak(m2, drop(1), 11 * MIN, s), { breaks: 1, gaveUp: false })
  prunePickupMemory(m2, 30 * MIN, s)
  assert.equal(m2.records.length, 0)
})

test('pickup: maxAirBreaks 0 never gives up; 1 gives up on the first break', () => {
  const never = { ...s, maxAirBreaks: 0 }
  const m = newPickupMemory()
  for (let i = 0; i < 5; i++) assert.equal(recordAirBreak(m, drop(1), i, never).gaveUp, false)
  assert.equal(dropUnreachable(m, drop(1), 10, never), false)
  const m1 = newPickupMemory()
  assert.equal(recordAirBreak(m1, drop(1), 0, { ...s, maxAirBreaks: 1 }).gaveUp, true)
})

test('pickup: reachableDrops filters the given-up ones', () => {
  const m = newPickupMemory()
  recordAirBreak(m, drop(1), 0, s)
  recordAirBreak(m, drop(1), 0, s)
  const left = reachableDrops([drop(1), drop(2, 10.5, 50, 10), drop(3, 30, 64, 30)], m, 100, s)
  assert.deepEqual(left.map(d => d.id), [3])
})

test('pickup: what counts as an air break', () => {
  assert.equal(isAirBreak({ underwaterError: true, aborted: false, headInWater: false, oxygen: 20 }), true)
  assert.equal(isAirBreak({ underwaterError: false, aborted: true, headInWater: true, oxygen: 8 }), true)
  assert.equal(isAirBreak({ underwaterError: false, aborted: true, headInWater: false, oxygen: 8 }), false)
  assert.equal(isAirBreak({ underwaterError: false, aborted: true, headInWater: true, oxygen: 20 }), false)
  assert.equal(isAirBreak({ underwaterError: false, aborted: false, headInWater: true, oxygen: 5 }), false, 'a path failure under water is not an air break')
})
