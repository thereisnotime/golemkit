// The owner: "why not make a proper hatch/trapdoor and have its own mine like normal players do".
// A bot's staircase mine starts inside its walls, through its own floor, under a trapdoor hatch.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { insideEntrances, stairDigCells, hatchCells, HATCH_STEPS } from '../src/skills/stairMinePlan.ts'
import { baseSafetySettings } from '../src/core/index.ts'

// a 7x7 yard (x 0..6, z 0..6), gate in the middle of the south wall
const cols: { x: number, z: number }[] = []
for (let x = 0; x <= 6; x++) for (let z = 0; z <= 6; z++) cols.push({ x, z })
const gate = [{ x: 3, z: 6 }]

test('inside spots: a straight free line, along a wall first, away from the gate', () => {
  const spots = insideEntrances({ cols, free: () => true, avoid: gate, keepClear: 2 })
  assert.ok(spots.length > 0)
  const best = spots[0]!
  assert.equal(best.alongWall, true)
  for (let k = 0; k <= HATCH_STEPS; k++) {
    const q = { x: best.pos.x + best.dir.x * k, z: best.pos.z + best.dir.z * k }
    assert.ok(cols.some(c => c.x === q.x && c.z === q.z), 'every column inside')
    assert.ok(Math.abs(q.x - 3) + Math.abs(q.z - 6) > 2, 'clear of the gate')
  }
})

test('inside spots: reserved columns (farm plot, workshop) are never used', () => {
  const plot = (c: { x: number, z: number }) => c.x >= 2 && c.x <= 4 && c.z >= 2 && c.z <= 4
  const spots = insideEntrances({ cols, free: c => !plot(c), avoid: gate })
  for (const s of spots) for (let k = 0; k <= HATCH_STEPS; k++) assert.ok(!plot({ x: s.pos.x + s.dir.x * k, z: s.pos.z + s.dir.z * k }))
  assert.equal(insideEntrances({ cols, free: () => false }).length, 0)
})

test('the hatch sits on the floor over the stair columns the first steps cut', () => {
  const e = { x: 10, y: 68, z: 5 }
  const d = { x: 1, z: 0 }
  const hatch = hatchCells(e, d)
  assert.deepEqual(hatch, [{ x: 11, y: 67, z: 5 }, { x: 12, y: 67, z: 5 }, { x: 13, y: 67, z: 5 }])
  const dig = stairDigCells(e, d)
  for (const h of hatch) assert.ok(dig.some(c => c.x === h.x && c.y === h.y && c.z === h.z), 'the stairs dig through each hatch cell')
})

test('defaults: the mine goes inside under a hatch; outside and either stay options', () => {
  const d = baseSafetySettings({})
  assert.equal(d.minePlacement, 'inside')
  assert.equal(d.mineHatch, true)
  assert.equal(d.retireCloseMines, true)
  assert.equal(baseSafetySettings({ minePlacement: 'outside' }).minePlacement, 'outside')
})
