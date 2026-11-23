import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  planTorches, torchSpotProblem, torchFor, estimateLight, torchSupplyStep, plankFor, lightCheckDue, placingOrder, manhattan,
  surfaceCells, spotProblems,
  type LightCell, type LightSource
} from '../src/skills/lightPlan.ts'

const cell = (x: number, z: number, extra: Partial<LightCell> = {}, y = 64): LightCell => ({
  x, y, z, light: 0, spawnable: true, block: 'air', floor: 'grass_block', floorTorch: true, ...extra
})

/** A flat square of grass from -r..r. */
function field (r: number, extra: (x: number, z: number) => Partial<LightCell> = () => ({})): LightCell[] {
  const out: LightCell[] = []
  for (let x = -r; x <= r; x++) for (let z = -r; z <= r; z++) out.push(cell(x, z, extra(x, z)))
  return out
}

/** Light at every spawnable cell with the plan's torches added. */
function after (cells: LightCell[], sources: LightSource[], torches: { x: number, y: number, z: number }[]): number[] {
  const all = [...sources, ...torches.map(t => ({ ...t, level: 14 }))]
  return cells.filter(c => c.spawnable).map(c => estimateLight(c, all))
}

test('estimateLight: real light, raised by sources by Manhattan distance', () => {
  assert.equal(estimateLight({ x: 0, y: 64, z: 0, light: 3 }, []), 3)
  assert.equal(estimateLight({ x: 0, y: 64, z: 0, light: null }, [{ x: 2, y: 64, z: 1, level: 14 }]), 11)
  assert.equal(estimateLight({ x: 0, y: 64, z: 0, light: 12 }, [{ x: 20, y: 64, z: 0, level: 14 }]), 12)
  assert.equal(estimateLight({ x: 0, y: 64, z: 0 }, [{ x: 0, y: 64, z: 30, level: 15 }]), 0)
})

test('planTorches: target 1 on a flat field, torches about 12 blocks apart and every spot lit', () => {
  const cells = field(12)
  const plan = planTorches(cells, [], { target: 1, maxTorches: 32 })
  assert.equal(plan.dark, 625)
  assert.equal(plan.left, 0)
  assert.ok(plan.torches.length <= 8, `${plan.torches.length} torches`)
  assert.ok(after(cells, [], plan.torches).every(l => l >= 1))
  for (const t of plan.torches) assert.equal(t.kind, 'floor')
})

test('planTorches: a higher target needs more torches and still covers everything', () => {
  const cells = field(12)
  const one = planTorches(cells, [], { target: 1, maxTorches: 64 })
  const eight = planTorches(cells, [], { target: 8, maxTorches: 64 })
  assert.equal(eight.left, 0)
  assert.ok(eight.torches.length > one.torches.length)
  assert.ok(after(cells, [], eight.torches).every(l => l >= 8))
})

test('planTorches: lit areas need nothing; existing torches and real light count', () => {
  const lit = field(5, () => ({ light: 9 }))
  assert.deepEqual(planTorches(lit, [], { target: 8 }).torches, [])
  const dark = field(5, () => ({ light: null }))
  const plan = planTorches(dark, [{ x: 0, y: 65, z: 0, level: 14 }], { target: 1 })
  assert.equal(plan.dark, 0)
  assert.equal(plan.torches.length, 0)
})

test('planTorches: only spawnable spots need light', () => {
  const cells = field(6, () => ({ spawnable: false, floor: 'glass' }))
  const plan = planTorches(cells, [], { target: 8 })
  assert.equal(plan.dark, 0)
  assert.equal(plan.spawnable, 0)
})

test('planTorches: max torches per run, the rest is reported left', () => {
  const plan = planTorches(field(20), [], { target: 8, maxTorches: 3 })
  assert.equal(plan.torches.length, 3)
  assert.ok(plan.left > 0)
  assert.equal(plan.dark, 41 * 41)
})

test('planTorches: never on farmland, paths, near doors, in water, off limits or where a torch was taken', () => {
  const cells = field(8, (x, z) => {
    if (x <= -2) return { floor: 'farmland', block: 'wheat', spawnable: false }
    if (x === 0) return { floor: 'dirt_path', spawnable: false }
    if (x === 1 && z === 0) return { nearDoor: true }
    if (x === 2) return { water: true, block: 'water', spawnable: false }
    if (x >= 6) return { offLimits: true }
    if (x === 4) return { removed: true }
    return {}
  })
  const plan = planTorches(cells, [], { target: 8, maxTorches: 64 })
  for (const t of plan.torches) {
    const c = cells.find(q => q.x === t.x && q.z === t.z)!
    assert.equal(torchSpotProblem(c), null, `torch at ${t.x} ${t.z} on ${c.floor}`)
    assert.ok(t.x === -1 || t.x === 1 || t.x === 3 || t.x === 5, `torch at x ${t.x}`)
  }
})

test('torchSpotProblem: the reasons', () => {
  assert.equal(torchSpotProblem(cell(0, 0)), null)
  assert.equal(torchSpotProblem(cell(0, 0, { floor: 'farmland' })), 'farmland')
  assert.equal(torchSpotProblem(cell(0, 0, { floor: 'dirt_path' })), 'a path')
  assert.equal(torchSpotProblem(cell(0, 0, { block: 'wheat' })), 'wheat is there')
  assert.equal(torchSpotProblem(cell(0, 0, { block: 'short_grass' })), 'short_grass is there', 'never replaces plants')
  assert.equal(torchSpotProblem(cell(0, 0, { water: true })), 'water')
  assert.equal(torchSpotProblem(cell(0, 0, { nearDoor: true })), 'in front of a door')
  assert.equal(torchSpotProblem(cell(0, 0, { offLimits: true })), 'off limits')
  assert.equal(torchSpotProblem(cell(0, 0, { removed: true })), 'a torch there was taken away')
  assert.equal(torchSpotProblem(cell(0, 0, { floorTorch: false })), 'nothing to put a torch on')
  assert.equal(torchSpotProblem(cell(0, 0, { floor: 'oak_leaves' })), 'nothing to put a torch on')
})

test('torchFor: floor first, the wall when the floor takes no torch', () => {
  assert.deepEqual(torchFor(cell(3, 4)), { x: 3, y: 64, z: 4, kind: 'floor', against: { x: 3, y: 63, z: 4 } })
  assert.deepEqual(torchFor(cell(3, 4, { floorTorch: false, wall: { x: 4, y: 64, z: 4 } })), { x: 3, y: 64, z: 4, kind: 'wall', against: { x: 4, y: 64, z: 4 } })
  assert.deepEqual(torchFor(cell(3, 4, { wall: { x: 4, y: 64, z: 4 } }))?.kind, 'floor')
})

test('planTorches: wall torches in a corridor whose floor takes none', () => {
  // a 1-wide corridor of bottom slabs (spawnable cells aside): floor torches impossible, walls on the side
  const cells: LightCell[] = []
  for (let x = 0; x < 30; x++) cells.push(cell(x, 0, { floorTorch: false, wall: { x, y: 64, z: 1 } }))
  const plan = planTorches(cells, [], { target: 1 })
  assert.equal(plan.left, 0)
  assert.ok(plan.torches.length >= 2 && plan.torches.length <= 3)
  for (const t of plan.torches) assert.equal(t.kind, 'wall')
})

test('planTorches: spots no torch can reach are left, not forced', () => {
  // a dark pocket far from any allowed spot
  const cells = [...field(2, () => ({ offLimits: true })), cell(40, 40, { offLimits: true })]
  const plan = planTorches(cells, [], { target: 1 })
  assert.equal(plan.torches.length, 0)
  assert.equal(plan.left, plan.dark)
})

test('planTorches: stable whatever the input order', () => {
  const cells = field(10)
  const a = planTorches(cells, [], { target: 4 })
  const b = planTorches([...cells].reverse(), [], { target: 4 })
  assert.deepEqual(a.torches, b.torches)
})

test('planTorches: light spreads in 3D, a torch on another floor counts by Manhattan distance', () => {
  const upper = field(3).map(c => ({ ...c, y: 70 }))
  const plan = planTorches(upper, [{ x: 0, y: 64, z: 0, level: 14 }], { target: 1 })
  // distance 6 up plus up to 6 sideways: 14 - 12 = 2 >= 1
  assert.equal(plan.dark, 0)
})

/**
 * Pax's farm:1 as the survey sees it: a 9x9 wheat field on y 63 with the water in the middle
 * (no cell there), a grass ring, two trees (trunk where a cell would be, leaves on top), a
 * hill rising east from x 8, and a dark cave 6 below the south side. Cells are at y 64 (the
 * centre's level); the cave is sealed, so no sky light there.
 */
function farmSurvey (): LightCell[] {
  const cells: LightCell[] = []
  const R = 14
  const trees = new Set(['-7,-7', '6,-9'])
  for (let x = -R; x <= R; x++) {
    for (let z = -R; z <= R; z++) {
      if (Math.hypot(x, z) > R) continue
      if (x === 0 && z === 0) continue // the water
      if (Math.abs(x) <= 4 && Math.abs(z) <= 4) {
        cells.push(cell(x, z, { spawnable: false, floor: 'farmland', block: x % 2 ? 'wheat' : 'air', floorTorch: false, sky: 15 }))
        continue
      }
      if (trees.has(`${x},${z}`)) {
        cells.push(cell(x, z, { spawnable: false, floor: 'oak_leaves', floorTorch: false, sky: 15 }, 70))
        continue
      }
      const y = x >= 8 ? 64 + Math.min(6, x - 7) : 64 // the hill: one block up per column
      cells.push(cell(x, z, { sky: 15, ...(x === -6 && z % 3 === 0 ? { block: 'short_grass' } : {}) }, y))
      if (z >= 6 && z <= 10 && x >= -10 && x <= 10) cells.push(cell(x, z, { sky: 0 }, 58)) // the cave
    }
  }
  return cells
}

test('surfaceCells: the ground around a farm, not the cave under it', () => {
  const cells = farmSurvey()
  const surface = surfaceCells(cells, { x: 0, y: 64, z: 0 })
  assert.ok(surface.every(c => c.y !== 58), 'cave cells dropped')
  assert.ok(surface.some(c => c.y === 70 && c.floor === 'grass_block'), 'the hill slope stays')
  assert.equal(surface.length, cells.filter(c => c.y !== 58).length)
  // without sky data the hill is still reached by its slope, the cave still not; only the tree
  // tops (on leaves, no spawns) drop out
  const noSky = surfaceCells(cells.map(c => ({ ...c, sky: null })), { x: 0, y: 64, z: 0 })
  assert.equal(noSky.length, surface.length - 2)
  assert.equal(noSky.filter(c => c.spawnable).length, surface.filter(c => c.spawnable).length)
})

test('planTorches: a 9x9 farm gets torches on the ring, none on the field, the water or in the cave', () => {
  const cells = surfaceCells(farmSurvey(), { x: 0, y: 64, z: 0 })
  const plan = planTorches(cells, [], { target: 8, maxTorches: 64 })
  assert.ok(plan.torches.length > 0)
  assert.equal(plan.left, 0, 'every surface spot lit')
  for (const t of plan.torches) {
    const c = cells.find(q => q.x === t.x && q.y === t.y && q.z === t.z)!
    assert.equal(torchSpotProblem(c), null)
    assert.ok(Math.abs(t.x) > 4 || Math.abs(t.z) > 4, `torch at ${t.x} ${t.z} is on the field`)
    assert.notEqual(c.floor, 'farmland')
    assert.notEqual(t.y, 58)
  }
  assert.ok(after(cells, [], plan.torches).every(l => l >= 8))
})

test('planTorches: too few torches for the farm places the most useful ones and says how many stay dark', () => {
  const cells = surfaceCells(farmSurvey(), { x: 0, y: 64, z: 0 })
  const plan = planTorches(cells, [], { target: 8, maxTorches: 3 })
  assert.equal(plan.torches.length, 3)
  assert.ok(plan.left > 0 && plan.left < plan.dark)
})

test('planTorches: the live bug, every spot off limits leaves nothing to place; spotProblems says why', () => {
  // a learned protected zone (from a refused break while harvesting) covered the whole farm
  const cells = surfaceCells(farmSurvey(), { x: 0, y: 64, z: 0 }).map(c => ({ ...c, offLimits: true }))
  const plan = planTorches(cells, [], { target: 8 })
  assert.equal(plan.torches.length, 0)
  assert.equal(plan.left, plan.dark)
  assert.match(spotProblems(cells), /^\d+ off limits$/)
  assert.equal(spotProblems(farmSurvey().filter(c => c.floor === 'farmland')).split(', ').length, 2)
})

test('placingOrder: nearest first, then nearest to the last', () => {
  const spots = [{ x: 20, y: 64, z: 0 }, { x: 2, y: 64, z: 0 }, { x: 10, y: 64, z: 0 }]
  assert.deepEqual(placingOrder(spots, { x: 0, y: 64, z: 0 }).map(s => s.x), [2, 10, 20])
  assert.equal(manhattan({ x: 0, y: 0, z: 0 }, { x: 1, y: -2, z: 3 }), 6)
})

test('torchSupplyStep: torches in hand', () => {
  assert.deepEqual(torchSupplyStep({ torch: 20 }, 12), { do: 'ready', torches: 12 })
})

test('torchSupplyStep: coal and sticks make torches, 4 per coal', () => {
  assert.deepEqual(torchSupplyStep({ coal: 2, stick: 5 }, 8), { do: 'craft', item: 'torch', count: 8, why: '8 torches from 2 coal' })
  assert.deepEqual(torchSupplyStep({ charcoal: 1, stick: 5 }, 8), { do: 'craft', item: 'torch', count: 4, why: '4 torches from 1 coal' })
  assert.equal(torchSupplyStep({ torch: 2, coal: 1, stick: 1 }, 6).do, 'craft')
})

test('torchSupplyStep: sticks from planks, planks from logs', () => {
  assert.deepEqual(torchSupplyStep({ coal: 3, oak_planks: 4 }, 12), { do: 'craft', item: 'stick', count: 4, why: 'sticks for torches' })
  assert.deepEqual(torchSupplyStep({ coal: 3, spruce_log: 2 }, 12), { do: 'craft', item: 'spruce_planks', count: 4, why: 'planks for sticks' })
  assert.deepEqual(torchSupplyStep({ coal: 3 }, 12), { do: 'stuck', why: 'no sticks, planks or logs for torch handles', need: 'wood' })
})

test('torchSupplyStep: no coal, charcoal from logs with planks as fuel and a furnace', () => {
  // no furnace and no cobblestone: stuck with the reason
  assert.deepEqual(torchSupplyStep({ oak_log: 6 }, 8), { do: 'stuck', why: 'out of coal and charcoal; no furnace and fewer than 8 cobblestone to make one', need: 'coal' })
  // cobblestone: furnace first, on a crafting table (planks for one first when there is none)
  assert.deepEqual(torchSupplyStep({ oak_log: 6, cobblestone: 8 }, 8), { do: 'craft', item: 'oak_planks', count: 4, why: 'planks for a crafting table (for the furnace)' })
  assert.deepEqual(torchSupplyStep({ oak_log: 5, oak_planks: 4, cobblestone: 8 }, 8), { do: 'craft', item: 'furnace', count: 1, why: 'a furnace for charcoal' })
  assert.deepEqual(torchSupplyStep({ oak_log: 6, cobblestone: 8 }, 8, { tableNear: true }), { do: 'craft', item: 'furnace', count: 1, why: 'a furnace for charcoal' })
  // furnace near, no fuel apart from the logs: planks first (never burn the input)
  assert.deepEqual(torchSupplyStep({ oak_log: 6 }, 8, { furnaceNear: true }), { do: 'craft', item: 'oak_planks', count: 4, why: 'planks to burn for charcoal' })
  // fuel there: smelt
  assert.deepEqual(torchSupplyStep({ oak_log: 5, oak_planks: 4 }, 8, { furnaceNear: true }), { do: 'smelt', item: 'oak_log', count: 2, why: 'charcoal from 2 oak_log' })
  assert.deepEqual(torchSupplyStep({ oak_log: 1, furnace: 1 }, 8).do, 'stuck', 'one log is not enough for charcoal and fuel')
})

test('torchSupplyStep: nothing at all, or some torches and nothing to make more', () => {
  assert.deepEqual(torchSupplyStep({}, 4), { do: 'stuck', why: 'out of coal and charcoal, and no logs to make charcoal', need: 'coal' })
  assert.deepEqual(torchSupplyStep({ torch: 3 }, 10), { do: 'ready', torches: 3 })
})

test('plankFor', () => {
  assert.equal(plankFor('oak_log'), 'oak_planks')
  assert.equal(plankFor('stripped_birch_log'), 'birch_planks')
  assert.equal(plankFor('crimson_stem'), 'crimson_planks')
  assert.equal(plankFor('dark_oak_wood'), 'dark_oak_planks')
})

test('lightCheckDue: first time, after the interval, after a mob was seen', () => {
  const now = 10_000_000
  assert.equal(lightCheckDue(undefined, now, 60_000), true)
  assert.equal(lightCheckDue(now - 30_000, now, 60_000), false)
  assert.equal(lightCheckDue(now - 90_000, now, 60_000), true)
  assert.equal(lightCheckDue(now - 30_000, now, 60_000, now - 10_000), true)
  assert.equal(lightCheckDue(now - 30_000, now, 60_000, now - 40_000), false)
})

test('torchOffLimits: a learned break zone stops torches only once two torches were refused in it; spawn always', async () => {
  const { torchOffLimits, zonesRefusingTorches } = await import('../src/skills/lighting.ts')
  const { ProtectedAreas } = await import('../src/core/protection.ts')
  const areas = new ProtectedAreas('/nonexistent/protected.json')
  areas.zones = [{ x: 565, y: 63, z: -18, at: '' }] // the zone harvesting put over Pax's farm
  const agent = { protectedAreas: areas }
  const bot: any = { spawnPoint: { x: 545, y: 70, z: 45 } }
  const ring = { x: 556, y: 63, z: -20 }
  assert.equal(torchOffLimits(agent as any, bot, ring, 24, new Set()), false)
  assert.equal(torchOffLimits(agent as any, bot, ring, 24, new Set(['565,63,-18'])), true)
  assert.deepEqual(zonesRefusingTorches(agent as any, [{ x: 556, y: 64, z: -15 }]), new Set(), 'one refusal can be lag')
  assert.deepEqual(zonesRefusingTorches(agent as any, [{ x: 556, y: 64, z: -15 }, { x: 570, y: 64, z: -25 }, { x: 0, y: 64, z: 0 }]), new Set(['565,63,-18']))
  assert.equal(torchOffLimits(agent as any, bot, { x: 550, y: 70, z: 40 }, 24, new Set()), true, 'near spawn')
})

test('approachPoint: a farm is approached on the ring side facing the bot, not at the water', async () => {
  const { approachPoint } = await import('../src/adapters/minecraft-java/behaviors/light.ts')
  const farm = { key: 'farm:1', label: 'farm:1', x: 561, y: 63, z: -20, radius: 14, farmSize: 9 }
  assert.deepEqual(approachPoint(farm, { x: 560, z: -46 }), { x: 561, y: 63, z: -26 })
  assert.deepEqual(approachPoint(farm, { x: 600, z: -18 }), { x: 567, y: 63, z: -20 })
  assert.deepEqual(approachPoint({ ...farm, farmSize: undefined }, { x: 0, z: 0 }), { x: 561, y: 63, z: -20 })
})
