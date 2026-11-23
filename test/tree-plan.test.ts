import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  nextTreeStep, mergeTreeSpot, markTreeSpotEmpty, rankTreeSpots, recordTreeSearch, treeRetryInMs, woodToTake, woodValue,
  TREE_RING_MEMORY_MS, TREE_SPOT_PAUSE_MS, type TreeSpot
} from '../src/skills/treePlan.ts'

const home = { x: 560, z: -46 }
const now = 1_000_000_000

test('nextTreeStep: rings widen after empty searches, scans first, trips past 64', () => {
  const w = { from: home, now, spots: [], searches: [] as { radius: number, at: number, found: boolean }[] }
  assert.deepEqual(nextTreeStep(w), { step: 'scan', radius: 32, reason: 'looking 32 out' })
  w.searches = recordTreeSearch(w.searches, 32, false, now - 1000)
  assert.equal(nextTreeStep(w)?.step, 'scan')
  assert.equal((nextTreeStep(w) as any).radius, 64)
  w.searches = recordTreeSearch(w.searches, 64, false, now - 900)
  assert.deepEqual(nextTreeStep(w), { step: 'scout', radius: 128, covered: 64, reason: 'nothing within 64, scouting 128 out' })
  w.searches = recordTreeSearch(w.searches, 128, false, now - 800)
  w.searches = recordTreeSearch(w.searches, 250, false, now - 700)
  assert.equal(nextTreeStep(w), null, 'every ring empty')
  assert.equal(treeRetryInMs(w.searches, now), TREE_RING_MEMORY_MS - 1000)
  // forgotten after the memory: back to the first ring
  assert.equal((nextTreeStep({ ...w, now: now + TREE_RING_MEMORY_MS }) as any).radius, 32)
})

test('nextTreeStep: rings tried in this run count as empty; custom rings', () => {
  const w = { from: home, now, spots: [], searches: [] }
  assert.equal((nextTreeStep(w, { tried: new Set(['ring:32']) }) as any).radius, 64)
  assert.equal((nextTreeStep(w, { rings: [48, 300] }) as any).radius, 48)
  assert.equal(nextTreeStep(w, { rings: [48, 300], tried: new Set(['ring:48']) })?.step, 'scout')
})

test('nextTreeStep: remembered trees first, nearest, not when found empty lately, not in danger', () => {
  const near: TreeSpot = { x: 620, y: 70, z: -40, count: 3, seen: now - 60_000 }
  const far: TreeSpot = { x: 760, y: 70, z: -46, count: 6, seen: now - 60_000 }
  const tooFar: TreeSpot = { x: 960, y: 70, z: -46, count: 6, seen: now - 60_000 }
  const spots = [far, near, tooFar]
  const s = nextTreeStep({ from: home, now, spots, searches: [] })
  assert.equal(s?.step, 'spot')
  assert.equal((s as any).spot.x, 620)
  // tried this run: the next one; beyond the widest ring: never
  assert.equal((nextTreeStep({ from: home, now, spots, searches: [] }, { tried: new Set(['620,-40']) }) as any).spot.x, 760)
  assert.equal(nextTreeStep({ from: home, now, spots, searches: [] }, { tried: new Set(['620,-40', '760,-46']) })?.step, 'scan')
  // found empty: paused, then offered again
  const emptied = markTreeSpotEmpty(spots, near, now - 1000)
  assert.equal((nextTreeStep({ from: home, now, spots: emptied, searches: [] }) as any).spot.x, 760)
  assert.equal((nextTreeStep({ from: home, now: now + TREE_SPOT_PAUSE_MS, spots: emptied, searches: [] }) as any).spot.x, 620)
  // a spot in a danger zone is skipped
  assert.equal((nextTreeStep({ from: home, now, spots, searches: [] }, { skip: p => p.x === 620 }) as any).spot.x, 760)
  // other dimension
  assert.deepEqual(rankTreeSpots(spots, home, now, { dim: 'the_nether' }), [])
})

test('mergeTreeSpot: one spot per cluster, newest first, capped', () => {
  let spots: TreeSpot[] = []
  spots = mergeTreeSpot(spots, { x: 0, y: 64, z: 0, count: 2, seen: 1 })
  spots = mergeTreeSpot(spots, { x: 10, y: 64, z: 5, count: 1, seen: 2 })
  assert.equal(spots.length, 1)
  assert.deepEqual([spots[0]!.x, spots[0]!.count, spots[0]!.seen], [10, 2, 2])
  for (let i = 1; i < 40; i++) spots = mergeTreeSpot(spots, { x: i * 100, y: 64, z: 0, count: 1, seen: i })
  assert.equal(spots.length, 24)
  assert.equal(spots[0]!.x, 3900)
})

test('woodToTake: logs first, planks of one kind, never a lone plank', () => {
  assert.deepEqual(woodToTake({ spruce_log: 10, oak_planks: 30, cobblestone: 64 }, 8), { spruce_log: 2 })
  assert.deepEqual(woodToTake({ oak_planks: 30, spruce_planks: 1 }, 5), { oak_planks: 5 })
  assert.deepEqual(woodToTake({ spruce_planks: 1 }, 5), {})
  assert.deepEqual(woodToTake({ oak_log: 1, birch_planks: 6 }, 8), { oak_log: 1, birch_planks: 4 })
  assert.equal(woodValue('mushroom_stem'), 0)
  assert.equal(woodValue('crimson_stem'), 4)
})
