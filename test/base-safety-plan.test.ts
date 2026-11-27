// Base safety planning (src/skills/baseSafetyPlan.ts): finding cavities under and around a base,
// which of them are threats, the fix techniques and where a mine may start.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scanBase, planHoleFills, describeHole, planFixes, torchSpots, fillOrder, mineSpotProblem, describeCavity, whereOf, mineFindings, planMineCaps, mineCells, type BaseArea, type Cell, type Pos } from '../src/skills/baseSafetyPlan.ts'
import { BASE_SAFETY_DEFAULTS, baseSafetySettings, deathSpotsSettings } from '../src/core/baseSafety.ts'

// a 9x9 base (walls on the ring, inside 1..7) with its floor at y 10 on solid stone; open sky above
const AREA: BaseArea = { min: { x: 0, z: 0 }, max: { x: 8, z: 8 }, floorY: 10, inside: (x, z) => x >= 1 && x <= 7 && z >= 1 && z <= 7 }
const key = (p: Pos) => `${p.x},${p.y},${p.z}`

function world (holes: Pos[] = [], lit: Pos[] = []) {
  const air = new Set(holes.map(key))
  const light = new Set(lit.map(key))
  return (p: Pos): Cell => {
    if (p.y > 10) return { name: 'air', solid: false, sky: 15, light: 0 }
    if (air.has(key(p))) {
      // sky light falls straight down an open shaft
      let sky = 0
      let y = p.y + 1
      while (y <= 10 && air.has(key({ x: p.x, y, z: p.z }))) y++
      if (y > 10) sky = 15
      return { name: 'air', solid: false, sky, light: light.has(key(p)) ? 14 : 0 }
    }
    return { name: 'stone', solid: true }
  }
}
const O = { margin: 3, depth: 8 }
const FIX = { techniques: BASE_SAFETY_DEFAULTS.techniques, fillMax: 48, sealMax: 24, lightSpacing: 7, capWith: BASE_SAFETY_DEFAULTS.capWith }

/** A tunnel along x at y 6 (feet) and 7 (head) from x0 to x1, at z. */
function tunnel (x0: number, x1: number, z: number, y = 6): Pos[] {
  const out: Pos[] = []
  for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) out.push({ x, y, z }, { x, y: y + 1, z })
  return out
}
/** A shaft straight up from y0 to the floor level (10) at x, z. */
function shaft (x: number, z: number, y0: number): Pos[] {
  const out: Pos[] = []
  for (let y = y0; y <= 10; y++) out.push({ x, y, z })
  return out
}

test('base safety: solid ground under the base is fine', () => {
  const r = scanBase(AREA, world(), O)
  assert.equal(r.cavities.length, 0)
  assert.equal(r.threats.length, 0)
})

test('base safety: a sealed pocket under the floor is no threat (no way in or out)', () => {
  const r = scanBase(AREA, world(tunnel(2, 6, 4)), O)
  assert.equal(r.cavities.length, 1)
  assert.equal(r.cavities[0]!.openings.length, 0)
  assert.equal(r.threats.length, 0)
})

test('base safety: a tunnel under the base with a hole up into the floor is a threat that opens inside', () => {
  const holes = [...tunnel(2, 6, 4), ...shaft(4, 4, 8)]
  const r = scanBase(AREA, world(holes), O)
  // the sky-lit column under the hole splits the tunnel in two dark halves, each opening into the base
  assert.ok(r.threats.length >= 1)
  for (const c of r.threats) {
    assert.ok(c.openings.some(o => o.where === 'inside'))
    assert.ok(c.spawnable.length > 0)
    assert.ok(c.under > 0)
    assert.match(describeCavity(c), /opens into the base/)
  }
  // small and closed: filled in whole
  const fixes = planFixes(r.threats, FIX)
  for (const [i, fix] of fixes.entries()) {
    assert.ok(fix.steps.every(s => s.technique === 'fill'))
    assert.equal(fix.steps.length, r.threats[i]!.size)
    assert.equal(fix.unfixed, undefined)
  }
})

test('base safety: a cave mouth next to the walls running under them is a threat; too big to fill, it is sealed', () => {
  // a tunnel from outside (x 10) under the east wall to the middle, with a shaft to the surface at x 10
  const holes = [...tunnel(4, 10, 4), ...shaft(10, 4, 8)]
  const r = scanBase(AREA, world(holes), O)
  assert.equal(r.threats.length, 1)
  const c = r.threats[0]!
  assert.ok(c.openings.every(o => o.where === 'near'))
  const fixes = planFixes(r.threats, { ...FIX, fillMax: 4 })
  assert.ok(fixes[0]!.steps.length > 0)
  assert.ok(fixes[0]!.steps.every(s => s.technique === 'seal' && s.action === 'fill'))
  assert.deepEqual(fixes[0]!.steps.map(s => key(s.pos)).sort(), c.openings.map(key).sort())
})

test('base safety: a cave going on past the scanned box is never filled; with seal off it is lit', () => {
  const holes = [...tunnel(-6, 10, 4), ...shaft(10, 4, 8)]
  const r = scanBase(AREA, world(holes), O)
  const c = r.threats[0]!
  assert.equal(c.edge, true)
  const [fix] = planFixes(r.threats, { ...FIX, techniques: ['fill', 'light'] })
  assert.ok(fix!.steps.length > 0)
  assert.ok(fix!.steps.every(s => s.action === 'torch'))
  // torches no further apart than the spacing
  const spots = torchSpots(c, 7)
  for (const p of c.spawnable) assert.ok(spots.some(t => Math.abs(t.x - p.x) + Math.abs(t.y - p.y) + Math.abs(t.z - p.z) <= 7))
})

test('base safety: nothing fits: the cavity is reported unfixed with the reasons', () => {
  const holes = [...tunnel(-6, 10, 4), ...shaft(10, 4, 8)]
  const r = scanBase(AREA, world(holes), O)
  const [fix] = planFixes(r.threats, { ...FIX, techniques: ['fill', 'seal'], sealMax: 0 })
  assert.equal(fix!.steps.length, 0)
  assert.match(fix!.unfixed!, /goes on past|sealMax 0/)
})

test('base safety: a lit cavity has no spawn spots', () => {
  const holes = [...tunnel(2, 6, 4)]
  const r = scanBase(AREA, world(holes, holes), O)
  assert.equal(r.cavities[0]!.spawnable.length, 0)
})

test('base safety: a staircase mine one block from the wall is found and capped where its stairs cut the ground', () => {
  // entrance at x 9 (feet on the surface, y 11), stairs going east and down, 3 high
  const m = { entrance: { x: 9, y: 11, z: 4 }, dir: { x: 1, z: 0 }, stairSteps: 5 }
  const cells = mineCells(m)
  assert.equal(cells.length, 15)
  const holes = cells.filter(p => p.y <= 10)
  const mine = { id: 'mine:1', entrance: m.entrance, cells }
  const look = world(holes)
  const [f] = mineFindings([mine], AREA, look, 4)
  assert.ok(f)
  assert.equal(f.problem, '1 block from the base walls (mineClearance 4)')
  // the ground layer (y 10) is dug at the first three steps
  assert.deepEqual(f.caps.map(p => `${p.x},${p.y}`), ['10,10', '11,10', '12,10'])
  const plan = planMineCaps([f], FIX)
  assert.equal(plan.steps.length, 3)
  assert.ok(plan.steps.every(s => s.action === 'cap' && s.cap === 'trapdoor' && s.mine === 'mine:1'))
  // light: torches down the stairs; none / cap off: reported
  assert.ok(planMineCaps([f], { ...FIX, capWith: 'light' }).steps.every(s => s.action === 'torch'))
  assert.match(planMineCaps([f], { ...FIX, capWith: 'none' }).unfixed[0]!, /left open \(capWith none\)/)
  assert.match(planMineCaps([f], { ...FIX, techniques: ['fill', 'seal'] }).unfixed[0]!, /cap off/)
  // capped already: nothing to do
  const capped = (p: Pos): Cell => (p.y === 10 && p.x >= 10 && p.x <= 12 && p.z === 4) ? { name: 'oak_trapdoor', solid: false } : look(p)
  const [g] = mineFindings([mine], AREA, capped, 4)
  assert.equal(g!.caps.length, 0)
  assert.equal(g!.capped, true)
  // far enough out: no finding
  assert.equal(mineFindings([{ ...mine, entrance: { x: 20, y: 11, z: 4 } }], AREA, look, 4).length, 0)
})

test('base safety: a cavity a mine runs into is never filled or sealed shut at the mine', () => {
  const holes = [...tunnel(4, 10, 4), ...shaft(10, 4, 8)]
  const mine = { id: 'mine:2', entrance: { x: 10, y: 11, z: 4 }, cells: [{ x: 10, y: 10, z: 4 }, { x: 10, y: 7, z: 4 }, { x: 9, y: 6, z: 4 }] }
  const r = scanBase(AREA, world(holes), O, [mine])
  const c = r.threats[0]!
  assert.deepEqual(c.mines, ['mine:2'])
  const [fix] = planFixes(r.threats, FIX, [mine])
  assert.ok(fix!.steps.every(s => s.technique !== 'fill' || !(s.pos.x === 10 && s.pos.y >= 8)))
})

test('base safety: fill order goes from the far end back towards the opening', () => {
  const c = { cells: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }], openings: [{ x: 0, y: 0, z: 0, where: 'near' as const }] }
  assert.deepEqual(fillOrder(c).map(p => p.x), [2, 1, 0])
})

test('base safety: mine spots: clearance outside, inside only when allowed, never on the walls', () => {
  assert.equal(mineSpotProblem({ x: 14, z: 4 }, AREA, 4, 'outside'), null)
  assert.match(mineSpotProblem({ x: 12, z: 4 }, AREA, 4, 'outside')!, /4 blocks from the base walls/)
  assert.equal(mineSpotProblem({ x: 4, z: 4 }, AREA, 4, 'outside'), 'inside the base walls')
  assert.equal(mineSpotProblem({ x: 4, z: 4 }, AREA, 4, 'inside'), null)
  assert.equal(mineSpotProblem({ x: 4, z: 4 }, AREA, 4, 'either'), null)
  assert.equal(mineSpotProblem({ x: 0, z: 4 }, AREA, 4, 'either'), 'on the base walls')
  assert.match(mineSpotProblem({ x: 20, z: 4 }, AREA, 4, 'inside')!, /outside the base/)
  assert.equal(whereOf(AREA, 0, 4), 'under_wall')
})

test('base safety settings: defaults, wrong values and false', () => {
  const s = baseSafetySettings(undefined)
  assert.deepEqual(s, BASE_SAFETY_DEFAULTS)
  assert.equal(baseSafetySettings(false).enabled, false)
  const t = baseSafetySettings({ techniques: ['light', 'bogus', 'light'], margin: 99, capWith: 'slab' })
  assert.deepEqual(t.techniques, ['light'])
  assert.equal(t.margin, BASE_SAFETY_DEFAULTS.margin)
  assert.equal(t.capWith, 'slab')
  assert.equal(deathSpotsSettings(false).enabled, false)
  assert.equal(deathSpotsSettings({ minutes: 3 }).minutes, 3)
})

test('base safety: a hole in the floor open to the sky is found and filled bottom up, the top in stone', () => {
  // a 2-deep hole in the floor at 3,3: lit, so no cavity, but a hole all the same
  const r = scanBase(AREA, world([{ x: 3, y: 10, z: 3 }, { x: 3, y: 9, z: 3 }]), O)
  assert.equal(r.threats.length, 0)
  assert.equal(r.holes.length, 1)
  assert.deepEqual(r.holes[0]!.cells, [{ x: 3, y: 9, z: 3 }, { x: 3, y: 10, z: 3 }])
  const steps = planHoleFills(r.holes)
  assert.deepEqual(steps.map(s => s.pos.y), [9, 10])
  assert.equal(steps[1]!.floor, true)
  assert.equal(steps[0]!.floor, undefined)
  assert.match(describeHole(r.holes[0]!), /hole in the floor at 3 10 3: 2 blocks deep/)
  // under the walls or outside is not a floor hole; off with floorHoles false
  assert.equal(scanBase(AREA, world([{ x: 0, y: 10, z: 3 }]), O).holes.length, 0)
  assert.equal(scanBase(AREA, world([{ x: 3, y: 10, z: 3 }]), { ...O, floorHoles: false }).holes.length, 0)
})

test('base safety: floor holes in a farm plot get dirt; water and a mine entrance inside are no holes', () => {
  const soil = { ...AREA, soil: (x: number, z: number) => x >= 5 && x <= 6 && z >= 5 && z <= 6 }
  const r = scanBase(soil, world([{ x: 5, y: 10, z: 5 }]), O)
  assert.equal(r.holes[0]!.soil, true)
  assert.equal(planHoleFills(r.holes)[0]!.soil, true)
  const wet = (p: Pos): Cell => (p.x === 4 && p.z === 4 && p.y === 10 ? { name: 'water', solid: false, sky: 15 } : world()(p))
  assert.equal(scanBase(AREA, wet, O).holes.length, 0)
  const mine = { id: 'mine:1', entrance: { x: 2, y: 11, z: 2 }, cells: [{ x: 2, y: 10, z: 2 }] }
  assert.equal(scanBase(AREA, world([{ x: 2, y: 10, z: 2 }]), O, [mine]).holes.length, 0)
})

test('base safety: a hole down into a tunnel is filled down its lit column, the dark tunnel still a threat', () => {
  const holes = [...tunnel(2, 6, 4), ...shaft(4, 4, 8)]
  const r = scanBase(AREA, world(holes), O)
  assert.ok(r.threats.length > 0)
  const h = r.holes.find(x => x.x === 4 && x.z === 4)!
  assert.equal(h.deep, false)
  // the sky-lit column goes down through the tunnel to its floor
  assert.deepEqual(h.cells.map(c => c.y), [6, 7, 8, 9, 10])
})
