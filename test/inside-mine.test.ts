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

// Pax, live: base safety said mine:1 (on the east wall) must be capped and retired and a mine dug
// inside the walls. For hours the cap step failed with "torch is already there" (the first trip
// had put a torch on the first stair step, the cap cell), so mine:1 was never capped or retired;
// and every trip went down mine:2, an old mine 16 blocks outside the walls, so no inside mine
// was ever dug.
import { clearForCap, retireMine, mineFindings, planMineCaps, type Cell, type Pos } from '../src/skills/baseSafetyPlan.ts'
import { mineFitsPlacement, pickMine, type MineSite } from '../src/skills/stairMinePlan.ts'

test('a torch in the cap cell is taken out first; solid blocks, caps and air are not', () => {
  assert.equal(clearForCap('torch', false, false), true)
  assert.equal(clearForCap('wall_torch', false, false), true)
  assert.equal(clearForCap('rail', false, false), true)
  assert.equal(clearForCap('ladder', false, false), true)
  assert.equal(clearForCap('cobblestone', true, false), false)
  assert.equal(clearForCap('spruce_trapdoor', false, false), false)
  assert.equal(clearForCap('air', false, true), false)
  assert.equal(clearForCap('short_grass', false, true), false)
  assert.equal(clearForCap('chest', false, false), false, 'never anything that holds items')
  assert.equal(clearForCap(undefined, false, true), false)
})

test("Pax's mine on the wall: the torch cell is a cap step, capping retires it", () => {
  // walls x 560..568, inside 561..567; mine:1 entrance on the east wall going east
  const area = { min: { x: 560, z: -50 }, max: { x: 568, z: -40 }, inside: (x: number, z: number) => x > 560 && x < 568 && z > -50 && z < -40 }
  const mine = { id: 'mine:1', entrance: { x: 568, y: 68, z: -46 }, cells: [{ x: 569, y: 67, z: -46 }, { x: 569, y: 68, z: -46 }, { x: 569, y: 69, z: -46 }] }
  const look = (p: Pos): Cell => p.x === 569 && p.y === 67 && p.z === -46 ? { name: 'torch', solid: false } : { name: 'stone', solid: true }
  const [f] = mineFindings([mine], area, look, 4)
  assert.ok(f && !f.capped)
  assert.deepEqual(f.caps, [{ x: 569, y: 67, z: -46 }])
  const caps = planMineCaps([f], { techniques: ['cap'], capWith: 'trapdoor', lightSpacing: 7 })
  assert.equal(caps.steps.length, 1)
  assert.equal(clearForCap(look(caps.steps[0]!.pos).name, false, false), true)
  const s = baseSafetySettings({})
  assert.equal(retireMine({}, true, s), true, 'capped, outside, placement inside: retired')
  assert.equal(retireMine({}, false, s), false, 'not until it is capped')
  assert.equal(retireMine({ inside: true }, true, s), false, 'its own inside mine keeps its hatch')
  assert.equal(retireMine({ retired: { at: 1, why: 'x' } }, true, s), false)
  assert.equal(retireMine({}, true, baseSafetySettings({ minePlacement: 'outside' })), false)
  assert.equal(retireMine({}, true, baseSafetySettings({ retireCloseMines: false })), false)
})

const site = (o: Partial<MineSite>): MineSite => ({ id: 'mine:1', entrance: { x: 576, y: 70, z: -46 }, dir: { x: 0, z: 1 }, path: [], deepest: 70, mainSteps: 0, branches: 0, torches: 0, stairSteps: 0, trips: 0, lastAt: 0, got: {}, ...o })

test('placement inside: an old mine outside the walls is not used, so the next trip digs one inside', () => {
  const s = baseSafetySettings({})
  assert.equal(s.useOutsideMines, false)
  assert.equal(mineFitsPlacement({ inside: false }, 'inside', false), false)
  assert.equal(mineFitsPlacement({ inside: true }, 'inside', false), true)
  assert.equal(mineFitsPlacement({ inside: false }, 'inside', true), true, 'useOutsideMines keeps the old one')
  assert.equal(mineFitsPlacement({ inside: false }, 'either', false), true)
  assert.equal(mineFitsPlacement({ inside: true }, 'outside', false), true)
  const home = { x: 560, y: 68, z: -46 }
  const old = site({ id: 'mine:2', bottom: { x: 623, y: 16, z: -40 }, mainSteps: 74 })
  const wall = site({ id: 'mine:1', entrance: { x: 568, y: 68, z: -46 }, retired: { at: 1, why: 'capped' } })
  const fits = (m: MineSite) => mineFitsPlacement({ inside: !!m.inside }, s.minePlacement, s.useOutsideMines)
  assert.equal(pickMine([wall, old], home, 32, 'overworld', () => false, fits), null, 'no mine to use: a new one goes inside')
  const own = site({ id: 'mine:3', entrance: { x: 563, y: 68, z: -44 }, inside: true })
  assert.equal(pickMine([wall, old, own], home, 32, 'overworld', () => false, fits)?.id, 'mine:3', 'once dug, its inside mine is used')
  assert.equal(pickMine([wall, old], home, 32, 'overworld', () => false)?.id, 'mine:2', 'without the placement check the old one wins')
})
