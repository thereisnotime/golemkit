// Base projects, Minecraft planning (src/skills/basePlan.ts): stages, survey, the base's spot,
// what goes where inside, the bill of materials and the session's shopping list.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadBlueprints, rotate, placeCells, resolveRoles, solidCells, type Pos } from '../src/skills/blueprint.ts'
import {
  blueprintStages, stageCells, surveyStage, fitAnchor, interiorOf, fitRow, fitSquare, growPlot, billOfMaterials, chestTakes, sessionWants,
  projectWords, projectNamed, safeToWork
} from '../src/skills/basePlan.ts'
import { goalHolds } from '../src/skills/projects.ts'

const { blueprints } = loadBlueprints()
const fortress = blueprints.get('fortress')!
const ORIGIN = { x: 560, y: 67, z: -43 }
const key = (p: Pos) => `${p.x},${p.y},${p.z}`

function world (bp = fortress, origin = ORIGIN, facing: 'north' | 'south' = 'north') {
  const turned = rotate(bp, facing)
  const cells = placeCells(turned, origin)
  const roles = resolveRoles(turned, {})
  const stages = blueprintStages(bp)
  return { turned, cells, roles, stages }
}

test('fortress stages: every solid cell in exactly one stage, gate torches with the walls, tower torches with the towers', () => {
  const { cells, stages } = world()
  assert.deepEqual(stages.map(s => s.name), ['walls', 'floor', 'walkway', 'towers'])
  const seen = new Map<string, string>()
  for (const s of stages) for (const c of solidCells(stageCells(cells, s, stages))) {
    assert.equal(seen.get(key(c)), undefined, `${key(c)} in ${seen.get(key(c))} and ${s.name}`)
    seen.set(key(c), s.name)
  }
  assert.equal(seen.size, solidCells(cells).length)
  const walls = stageCells(cells, stages[0]!, stages)
  assert.equal(walls.filter(c => c.role === 'light').length, 2)
  assert.equal(stageCells(cells, stages[3]!, stages).filter(c => c.role === 'light').length, 4)
  assert.equal(stages[1]!.skipCovered, true)
})

test('blueprints without stages are one stage', () => {
  const s = blueprintStages(blueprints.get('hut')!)
  assert.equal(s.length, 1)
  assert.equal(s[0]!.name, 'build')
})

test('survey: old plank walls count, dirt is dug, a hut on the floor and someone\'s block are left alone', () => {
  const { cells, roles, stages } = world()
  const floor = stageCells(cells, stages[1]!, stages)
  const walls = stageCells(cells, stages[0]!, stages)
  const blocks = new Map<string, string>()
  for (const c of walls) if (c.role === 'wall') blocks.set(key(c), 'spruce_planks')
  for (const c of floor) blocks.set(key(c), 'dirt')
  const hutAt = floor[40]!
  blocks.set(key({ ...hutAt, y: hutAt.y + 1 }), 'spruce_planks') // the hut's floor on top
  const chestOn = floor[60]!
  blocks.set(key(chestOn), 'chest') // someone's block in the floor itself
  const at = (p: Pos) => blocks.get(key(p)) ?? 'air'
  const planned = new Set(cells.map(key))
  const fs = surveyStage(floor, at, roles, { canDig: true, skipCovered: true, planned: p => planned.has(key(p)) })
  assert.equal(fs.covered.length, 1)
  assert.equal(fs.blocked.length, 1)
  assert.equal(fs.todo.length, fs.total - 2)
  const ws = surveyStage(walls, at, roles, { canDig: true })
  assert.ok(ws.done.length >= walls.filter(c => c.role === 'wall').length - 6) // battlement gaps are air
  // own blocks may be dug
  const own = surveyStage(floor, at, roles, { canDig: true, skipCovered: true, planned: p => planned.has(key(p)), own: p => key(p) === key(chestOn) })
  assert.equal(own.blocked.length, 0)
  // not loaded
  assert.equal(surveyStage(floor, () => undefined, roles, { canDig: true }).unknown.length, floor.length)
})

test('survey: a hole in the floor counts even under a build or a torch on top (only a block in the cell is left alone)', () => {
  const { cells, roles, stages } = world()
  const floor = stageCells(cells, stages[1]!, stages)
  const blocks = new Map<string, string>()
  for (const c of floor) blocks.set(key(c), 'cobblestone')
  const hole = floor[30]!
  blocks.delete(key(hole))
  blocks.set(key({ ...hole, y: hole.y + 1 }), 'chest') // something stands over the gap
  const at = (p: Pos) => blocks.get(key(p)) ?? 'air'
  const planned = new Set(cells.map(key))
  const fs = surveyStage(floor, at, roles, { canDig: true, skipCovered: true, planned: p => planned.has(key(p)) })
  assert.equal(fs.covered.length, 0)
  assert.deepEqual(fs.todo.map(key), [key(hole)])
  assert.equal(fs.done.length, fs.total - 1)
})

test('anchor: fits the fortress one block below the old origin, and picks the gate side', () => {
  const { cells, roles, stages } = world(fortress, ORIGIN, 'north')
  const standing = new Set(solidCells(stageCells(cells, stages[0]!, stages)).filter(c => roles[c.role]!.kind === 'block' && c.y > ORIGIN.y).map(key))
  const score = (o: Pos, f: 'north' | 'south' | 'east' | 'west') => {
    const w = world(fortress, o, f as 'north')
    const ws = solidCells(stageCells(w.cells, w.stages[0]!, w.stages)).filter(c => w.roles[c.role]!.kind === 'block')
    return ws.filter(c => standing.has(key(c))).length / ws.length
  }
  const fit = fitAnchor([{ origin: { x: 560, y: 68, z: -43 }, facing: 'north', source: 'the place fortress' }, { origin: { x: 560, y: 68, z: -43 }, facing: 'south', source: 'x' }], score)
  assert.ok(fit)
  assert.deepEqual(fit.origin, ORIGIN)
  assert.equal(fit.facing, 'north')
  assert.equal(fitAnchor([{ origin: { x: 0, y: 64, z: 0 }, facing: 'north', source: 'home' }], () => 0.1), null)
})

test('inside: floor columns clear of walls and ladder; a row against a wall facing in, away from the gate', () => {
  const { cells, roles } = world(fortress, ORIGIN, 'north')
  const inside = interiorOf(cells, ['floor'])!
  assert.equal(inside.y, ORIGIN.y)
  assert.equal(inside.cols.length, 13 * 13 - 4 - 1) // the floor inside, minus the corners under the towers and the ladder column
  const door = cells.filter(c => roles[c.role]!.kind === 'door').map(c => ({ x: c.x, z: c.z }))
  const fit = fitRow(inside, 4, () => true, { avoid: door, keepClear: 2 })!
  assert.ok(fit)
  assert.equal(fit.cells.length, 4)
  for (const c of fit.cells) for (const d of door) assert.ok(Math.abs(c.x - d.x) + Math.abs(c.z - d.z) > 2)
  // facing into the room: the column behind is outside
  const isIn = (x: number, z: number) => inside.cols.some(c => c.x === x && c.z === z)
  const back = { south: [0, -1], north: [0, 1], east: [-1, 0], west: [1, 0] }[fit.facing]!
  for (const c of fit.cells) assert.equal(isIn(c.x + back[0]!, c.z + back[1]!), false)
  // nothing free: no fit
  assert.equal(fitRow(inside, 4, () => false), null)
  const sq = fitSquare(inside, () => true, { max: 5, min: 3, margin: 1, avoid: door })!
  assert.equal(sq.size, 5)
  const blocked = fitSquare(inside, c => c.z > ORIGIN.z + 3, { max: 5, min: 3 })
  assert.ok(!blocked || blocked.size <= 3)
})

test('farm plot: odd sides from plotSize, and growing a small plot inside the walls', () => {
  const { cells, roles } = world()
  const inside = interiorOf(cells, ['floor'])!
  const door = cells.filter(c => roles[c.role]!.kind === 'door').map(c => ({ x: c.x, z: c.z }))
  assert.equal(fitSquare(inside, () => true, { max: 7, min: 3, margin: 1, avoid: door, odd: true })!.size, 7)
  assert.equal(fitSquare(inside, () => true, { max: 6, min: 3, odd: true })!.size, 5, 'never an even side')
  // Pax: a 3x3 at 557 -43 in the fortress at 560 67 -43; the stone floor counts as free, the gate is kept clear
  const old = { x0: 557, z0: -43, size: 3 }
  const inOld = (c: { x: number, z: number }) => c.x >= 557 && c.x <= 559 && c.z >= -43 && c.z <= -41
  const inSq = (s: { x0: number, z0: number, size: number }, c: { x: number, z: number }) => c.x >= s.x0 && c.x < s.x0 + s.size && c.z >= s.z0 && c.z < s.z0 + s.size
  assert.deepEqual(growPlot(inside, () => true, old, { size: 7, margin: 1, avoid: door }), { plot: { x0: 555, z0: -45, size: 7 }, keepsOld: true }, 'the 7x7 around the old plot')
  // a chest row along x 555-558 at z -45: the square keeps off it and still holds the old plot
  const chests = (c: { x: number, z: number }) => !(c.z === -45 && c.x >= 555 && c.x <= 558)
  const g5 = growPlot(inside, chests, old, { size: 7, margin: 1, avoid: door })!
  assert.equal(g5.keepsOld, true)
  for (let x = g5.plot.x0; x < g5.plot.x0 + g5.plot.size; x++) for (let z = g5.plot.z0; z < g5.plot.z0 + g5.plot.size; z++) assert.ok(chests({ x, z }))
  // the old plot's columns count as free (crops and a torch stand on them)
  assert.equal(growPlot(inside, c => !inOld(c), old, { size: 7, avoid: door })!.plot.size, 7)
  // already big enough, or nothing around it free: no growth
  assert.equal(growPlot(inside, () => true, { x0: 555, z0: -45, size: 7 }, { size: 7 }), null)
  assert.equal(growPlot(inside, () => true, old, { size: 3 }), null)
  assert.equal(growPlot(inside, () => false, old, { size: 7 }), null)
  // a reserved column by the old plot (the inside mine's hatch): the square keeps off it, the old plot stays in
  const hatch = { x: 556, z: -42 }
  const gh = growPlot(inside, c => !(c.x === hatch.x && c.z === hatch.z), old, { size: 7, avoid: door })!
  assert.ok(gh.keepsOld); assert.ok(!inSq(gh.plot, hatch))
})

test('bill of materials, chest takes and the session list', () => {
  const { cells, roles, stages } = world()
  const floor = stageCells(cells, stages[1]!, stages)
  const rows = billOfMaterials(floor, roles, { cobblestone: 20 }, { cobblestone: 50, andesite: 15, bread: 200 })
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.need, floor.length)
  assert.equal(rows[0]!.carried, 20)
  assert.equal(rows[0]!.stored, 65)
  assert.equal(rows[0]!.missing, floor.length - 85)
  const takes = chestTakes(rows, roles, { cobblestone: 50, andesite: 15, bread: 200 }, 192)
  assert.deepEqual(takes, { cobblestone: 50, andesite: 15 })
  assert.deepEqual(chestTakes(rows, roles, { cobblestone: 50 }, 10), { cobblestone: 10 })
  assert.deepEqual(sessionWants({ cobblestone: 400, door: 1 }, 200), { cobblestone: 199, door: 1 })
  assert.deepEqual(sessionWants({ cobblestone: 40 }, 200), { cobblestone: 40 })
})

test('names and words; safe needs; an LLM goal holds the building only while it is worked on', () => {
  const words = projectWords(blueprintStages(fortress))
  assert.equal(projectNamed('the towers', words), 'towers')
  assert.equal(projectNamed('chests', words), 'storage')
  assert.equal(projectNamed('farm plot', words), 'farm_plot')
  assert.equal(projectNamed('moat', words), null)
  assert.equal(safeToWork({ health: 20, food: 20, danger: 0, survival: true }, { minHealth: 14, minFood: 12 }), null)
  assert.match(safeToWork({ health: 8, food: 20, danger: 0, survival: true }, { minHealth: 14, minFood: 12 })!, /health/)
  assert.match(safeToWork({ health: 20, food: 20, danger: 0.8, survival: true }, { minHealth: 14, minFood: 12 })!, /hostiles/)
  const now = 10_000_000
  const g = { text: 'Upgrade our fortress to fortress v2', updatedAt: now - 60_000 }
  assert.equal(goalHolds(g, now), true)
  assert.equal(goalHolds({ ...g, paused: 'waiting for the owner' }, now), false)
  assert.equal(goalHolds({ ...g, updatedAt: now - 3_600_000 }, now), false)
  assert.equal(goalHolds({ text: 'find diamonds', updatedAt: now }, now), false)
})
