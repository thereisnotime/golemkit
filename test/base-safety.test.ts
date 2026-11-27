// Base safety around the planner: the builder keeping the gate door in for outside repairs
// (blueprint.enclosedColumns), attachments with nothing to hang on (basePlan.supportOf and the
// stage survey), death spots with a height band (danger.ts), the keep-out exit (baseArea.ts),
// stuck and waiting reasons in the project queue, and mine entrances by the base walls.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadBlueprints, rotate, placeCells, resolveRoles, solidCells, enclosedColumns, type Pos } from '../src/skills/blueprint.ts'
import { blueprintStages, stageCells, surveyStage, supportOf } from '../src/skills/basePlan.ts'
import { rememberDanger, isInDanger, crossesDanger, type DangerZone } from '../src/core/danger.ts'
import { keepOutExit } from '../src/skills/baseArea.ts'
import { projectQueue, nextStep, fmtQueue, stuckReason, projectsSettings, emptyProjectState, noteSession } from '../src/core/projects.ts'
import { entranceProblem, STAIR_MINE_DEFAULTS } from '../src/skills/stairMinePlan.ts'

const { blueprints } = loadBlueprints()
const fortress = blueprints.get('fortress')!
const ORIGIN = { x: 560, y: 67, z: -43 }
const key = (p: Pos) => `${p.x},${p.y},${p.z}`

function fort () {
  const turned = rotate(fortress, 'north')
  const cells = placeCells(turned, ORIGIN)
  const roles = resolveRoles(turned, {})
  const stages = blueprintStages(fortress)
  return { cells, roles, stages }
}

test('door: the whole fortress closes its yard in behind the gate; walls, gate torches and the walls stage alone do not', () => {
  const { cells, roles, stages } = fort()
  const isWall = (c: { x: number, y: number, z: number }) => { const w = c as typeof cells[number]; return w.role !== 'air' && roles[w.role]?.kind !== 'attachment' }
  const door = cells.find(c => roles[c.role]?.kind === 'door' && !c.passive)!
  const closed = enclosedColumns(cells, isWall, door.y)
  // the middle of the yard is closed in (a floor or a chest there needs the door out)
  assert.ok(closed.has(`${ORIGIN.x},${ORIGIN.z}`))
  // no wall cell, no gate torch and nothing outside is
  const walls = stageCells(cells, stages[0]!, stages)
  for (const c of solidCells(walls)) assert.equal(closed.has(`${c.x},${c.z}`), false, `${key(c)} ${c.role}`)
  // the walls stage alone (towers not built: open corners) closes nothing in: a wall repair keeps the door
  assert.equal(enclosedColumns(walls, isWall, door.y).size, 0)
  // a wall with a gap is no enclosure
  const gap = cells.filter(c => !(c.z === door.z && c.x === door.x && c.y <= door.y + 1))
  assert.equal(enclosedColumns(gap, isWall, door.y).size, 0)
})

test('attachments: a ladder hangs on the block behind it, a standing torch on the one below', () => {
  assert.deepEqual(supportOf('ladder', { facing: 'north' }, { x: 0, y: 0, z: 0 }), { x: 0, y: 0, z: 1 })
  assert.deepEqual(supportOf('torch', undefined, { x: 0, y: 5, z: 0 }), { x: 0, y: 4, z: 0 })
  assert.deepEqual(supportOf('torch', { facing: 'east' }, { x: 0, y: 0, z: 0 }), { x: -1, y: 0, z: 0 })
  assert.equal(supportOf('cobblestone', undefined, { x: 0, y: 0, z: 0 }), null)
})

test('walkway survey: ladders whose wall spot holds someone else\'s block are left alone, not retried every session', () => {
  const { cells, roles, stages } = fort()
  const walkway = stageCells(cells, stages[2]!, stages)
  const ladders = walkway.filter(c => c.role === 'ladder')
  assert.equal(ladders.length, 3)
  // everything of the walkway built except two ladders; the wall behind them holds a block the bot may not touch and that isn't a face
  const missing = new Set(ladders.slice(1).map(key))
  const behind = new Set(ladders.slice(1).map(l => key(supportOf('ladder', l.state, l)!)))
  const blockAt = (p: Pos) => missing.has(key(p)) ? 'air' : roles[cells.find(c => key(c) === key(p))?.role ?? '']?.item ?? 'air'
  const solidAt = (p: Pos) => !behind.has(key(p))
  const planned = new Set(solidCells(cells).map(key))
  const sv = surveyStage(walkway, blockAt, roles, { canDig: true, support: { solidAt, willBuild: p => planned.has(key(p)) && !behind.has(key(p)) } })
  assert.equal(sv.todo.length, 0)
  assert.equal(sv.unsupported.length, 2)
  // with the wall there, they are work to do
  const sv2 = surveyStage(walkway, blockAt, roles, { canDig: true, support: { solidAt: () => true, willBuild: () => true } })
  assert.equal(sv2.todo.length, 2)
  assert.equal(sv2.unsupported.length, 0)
})

test('death spots: a zone with a height band leaves the ground above alone', () => {
  let zones: DangerZone[] = []
  zones = rememberDanger(zones, { x: 564, y: 63, z: -43, kind: 'death', radius: 6, yRange: 4 }, 0)
  assert.ok(isInDanger(zones, { x: 563, y: 62, z: -44 }, 1000))
  assert.equal(isInDanger(zones, { x: 561, y: 69, z: -46 }, 1000), null, 'the bed above is not in it')
  assert.equal(isInDanger(zones, { x: 563, y: 62, z: -44 }, 1000, 0, 'skeleton'), null, 'kind filter')
  // a walk across the base above doesn't cross it; one down into the cave does
  assert.equal(crossesDanger({ x: 550, y: 68, z: -43 }, { x: 575, y: 68, z: -43 }, zones, 1000), null)
  assert.ok(crossesDanger({ x: 550, y: 68, z: -43 }, { x: 564, y: 63, z: -43 }, zones, 1000))
  // a second death there extends it
  const again = rememberDanger(zones, { x: 563, y: 63, z: -44, kind: 'death', radius: 6, yRange: 4, ttlMs: 600_000 }, 47_000)
  assert.equal(again.length, 1)
  assert.equal(again[0]!.until, 47_000 + 600_000)
})

test('keep-out: the nearest column outside the base and its margin', () => {
  const a = { min: { x: 552, z: -51 }, max: { x: 568, z: -35 } }
  assert.deepEqual(keepOutExit(a, 4, { x: 566, z: -43 }), { x: 573, z: -43 })
  assert.deepEqual(keepOutExit(a, 4, { x: 560, z: -54 }), { x: 560, z: -56 })
  assert.equal(keepOutExit(a, 4, { x: 600, z: -43 }), null)
})

test('mine entrances: too close to the base walls is a problem for a new mine', () => {
  const c = { pos: { x: 568, y: 68, z: -46 }, dir: { x: 1, z: 0 }, homeDist: 8, safeSteps: 4, base: '1 block from the base walls (mineClearance 4)' }
  assert.equal(entranceProblem(c, STAIR_MINE_DEFAULTS), 'too close to the base walls')
  assert.equal(entranceProblem({ ...c, base: undefined }, STAIR_MINE_DEFAULTS), null)
})

test('project queue: a stuck project says why, and a big one with no owner online says nobody is there to ask', () => {
  const s = projectsSettings({})
  let state = emptyProjectState()
  for (let i = 0; i < 2; i++) state = noteSession(state, 'walkway', { now: 1000 + i, message: 'walkway: built 42/44 blocks, 2 required still missing: nothing to place ladder against at 560 69 -37', progressed: false, done: false })
  const why = stuckReason(state.progress.walkway)
  assert.match(why!, /^2 sessions without progress: built 42\/44/)
  assert.equal(stuckReason(undefined), null)
  const infos = [
    { name: 'walkway', title: 'walkway', left: 2, total: 44, stuck: why! },
    { name: 'towers', title: 'towers', left: 236, total: 236 }
  ]
  const q = projectQueue(infos, state, s, 5000)
  assert.match(fmtQueue(q)[0]!, /stuck: 2 sessions without progress/)
  const onlyTowers = projectQueue([infos[1]!], state, s, 5000)
  const step = nextStep(onlyTowers, state, s, { now: 5000, ownerOnline: false, night: false })
  assert.equal(step.kind, 'none')
  assert.match((step as { why: string }).why, /towers \(236 blocks\) waits for an owner's ok; no owner online to ask/)
})
