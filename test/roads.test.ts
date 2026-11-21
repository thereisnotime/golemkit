// Road and staircase planner: synthetic height maps (flat, slope, cliff, house, junction, lake,
// a hill with six doors) and the geometry checks (walking heights, stairs, lanes).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  terrainFrom, planRoad, roadGeometry, geometryProblems, routeProblems, layRoad, addBuilding, connect, cellIndex, laneCells,
  facingIndex, BLOCKED, MARGIN, LIQUID, ROAD, type RouteCell, type RoadTerrain, type RoadGeometry, type RoadEnd
} from '../src/skills/road-plan.ts'
import { mergeRuns } from '../src/skills/creative-build.ts'

const flat = (x0: number, z0: number, x1: number, z1: number, y = 64) => terrainFrom({ x0, z0, x1, z1 }, () => y)

function planned (t: RoadTerrain, from: RoadEnd, to: RoadEnd, opts = {}): { route: RouteCell[], geo: RoadGeometry } {
  const r = planRoad(t, { from: [from], to: [to] }, opts)
  assert.ok(r.ok, r.ok ? '' : r.reason)
  const geo = roadGeometry(r.route, t)
  assert.deepEqual(geometryProblems(r.route, geo), [])
  assert.deepEqual(geo.conflicts, [])
  return { route: r.route, geo }
}

/** Indices of the rises (either way) along a route. */
const changes = (route: RouteCell[]) => route.map((c, i) => (i && c.f !== route[i - 1]!.f ? i : -1)).filter(i => i > 0)

/** Every lane and railing column of a route avoids `bad` flags (lanes) / BLOCKED (railings). */
function assertClear (t: RoadTerrain, geo: RoadGeometry, laneBad: number): void {
  for (const c of geo.surface) {
    const i = cellIndex(t, c.x, c.z)
    assert.ok(i >= 0 && !(t.flags[i]! & laneBad), `lane ${c.x} ${c.z} is on a forbidden cell`)
  }
  for (const r of geo.rails) assert.ok(!(t.flags[cellIndex(t, r.x, r.z)]! & BLOCKED), `railing ${r.x} ${r.z} in a building`)
}

test('flat field: a straight road with no stairs', () => {
  const t = flat(-10, -10, 40, 10)
  const { route, geo } = planned(t, { x: 0, z: 0 }, { x: 30, z: 0 })
  assert.equal(route.length, 31)
  assert.ok(route.every(c => c.f === 65 && c.z === 0 && !c.turn))
  assert.equal(geo.stats.stairs, 0)
  assert.equal(geo.stats.landings, 0)
  assert.equal(geo.surface.length, 31 * 3, 'three lanes all the way')
  assert.equal(geo.rails.length, 0, 'no railings without a drop')
  assert.ok(geo.blocks.every(b => b.block === 'stone_bricks' && b.y === 64))
})

test('1-in-3 slope: stairs spread out evenly, each facing up', () => {
  const t = terrainFrom({ x0: -10, z0: -10, x1: 60, z1: 10 }, x => 64 + Math.floor(Math.max(0, x) / 3))
  const { route, geo } = planned(t, { x: 0, z: 0 }, { x: 45, z: 0 })
  assert.ok(route.every(c => !c.turn && c.z === 0), 'straight up the slope')
  assert.equal(route.at(-1)!.f - route[0]!.f, 15)
  const rises = changes(route)
  assert.equal(rises.length, 15)
  const gaps = rises.slice(1).map((r, i) => r - rises[i]!)
  assert.ok(Math.max(...gaps) - Math.min(...gaps) <= 1, `uneven gaps ${gaps.join(',')}`)
  assert.equal(geo.stats.stairs, 15)
  const stairs = geo.blocks.filter(b => b.part === 'stair')
  assert.equal(stairs.length, 45, 'a stair on all three lanes of every rise')
  assert.ok(stairs.every(b => b.state?.facing === 'east' && b.state.half === 'bottom'))
})

test('20-high cliff over 8 blocks: a switchback, a stair for every rise, no turns on rises, straight flights', () => {
  // the plateaus are 16 apart: a single flight can't climb 20 there, the road has to fold
  const t = terrainFrom({ x0: -16, z0: -16, x1: 24, z1: 16 }, x => (x < 0 ? 64 : x > 8 ? 84 : 64 + Math.round(x * 2.5)))
  const { route, geo } = planned(t, { x: -4, z: 0 }, { x: 12, z: 0 }, { maxCut: 6, maxFill: 10 })
  assert.equal(route.at(-1)!.f - route[0]!.f, 20)
  assert.deepEqual(routeProblems(route), [])
  // a 180 degree turn: two landings, a short connector, flights on parallel lines with a gap
  const turns = route.map((c, i) => (c.turn ? i : -1)).filter(i => i > 0)
  const hairpin = turns.slice(1).some((j, k) => {
    const i = turns[k]!
    return facingIndex(route[i - 1]!.dir) === (facingIndex(route[j]!.dir) + 2) % 4 && j - i === 4
  })
  assert.ok(hairpin, 'no switchback')
  // flights are straight: the direction changes only on landings, and a landing is flat on both sides
  route.forEach((c, i) => {
    if (i === 0 || c.turn) return
    assert.equal(route[i - 1]!.dir === c.dir || route[i - 1]!.turn, true, `bend without a landing at ${i}`)
  })
  for (const i of turns) {
    assert.equal(route[i - 1]!.f, route[i]!.f)
    assert.equal(route[i + 1]!.f, route[i]!.f)
  }
  // every rise has its stair on the higher cell, facing the way up, on all three lanes
  for (const i of changes(route)) {
    const hi = route[i]!.f > route[i - 1]!.f ? i : i - 1
    const up = route[i]!.f > route[i - 1]!.f ? route[i]!.dir : ({ north: 'south', south: 'north', east: 'west', west: 'east' } as const)[route[i]!.dir]
    const lanes = laneCells(route[hi]!.x, route[hi]!.z, facingIndex(route[hi]!.dir), false, 1)
    for (const l of lanes) {
      const s = geo.blocks.find(b => b.x === l.x && b.z === l.z && b.y === route[hi]!.f - 1)
      assert.equal(s?.part, 'stair', `no stair at ${l.x} ${l.z}`)
      assert.equal(s?.state?.facing, up)
    }
  }
  assert.ok(geo.rails.length > 0, 'railings where the road stands high')
})

test('around a house footprint, never through it or its margin', () => {
  const t = flat(-10, -16, 40, 16)
  addBuilding(t, { x0: 10, z0: -4, x1: 18, z1: 4 }, 1)
  const { route, geo } = planned(t, { x: 0, z: 0 }, { x: 30, z: 0 })
  assert.ok(route.some(c => c.turn), 'it has to turn to get round')
  assertClear(t, geo, BLOCKED | MARGIN)
})

test('a door: straight out first, arrives straight in', () => {
  const t = flat(-10, -16, 40, 16)
  addBuilding(t, { x0: -6, z0: -2, x1: -2, z1: 2 }, 1)
  addBuilding(t, { x0: 26, z0: 6, x1: 30, z1: 10 }, 1)
  // doors at the east wall of the first house and the north wall of the second
  const { route, geo } = planned(t, { x: -1, z: 0, out: 'east' }, { x: 28, z: 5, out: 'north' })
  assert.ok(route.slice(0, 4).every(c => c.dir === 'east' && !c.turn))
  assert.ok(route.slice(-4).every(c => c.dir === 'south'))
  assertClear(t, geo, BLOCKED)
})

test('T-junction onto an existing road at the same height, no overlap', () => {
  const t = flat(-10, -20, 40, 20)
  const old = planned(t, { x: 20, z: -18 }, { x: 20, z: 18 })
  layRoad(t, old.geo)
  const r = planRoad(t, { from: [{ x: 0, z: 3, out: 'east' }], to: [], toRoads: old.geo.surface })
  assert.ok(r.ok, r.ok ? '' : r.reason)
  const last = r.route.at(-1)!
  assert.ok(last.junction && last.x === 19 && last.f === 65, `ends at ${last.x} ${last.z}`)
  assert.equal(r.toEnd, -2)
  const geo = roadGeometry(r.route, t)
  assert.deepEqual(geometryProblems(r.route, geo), [])
  const oldCells = new Set(old.geo.surface.map(c => `${c.x},${c.z}`))
  assert.ok(geo.surface.every(c => !oldCells.has(`${c.x},${c.z}`)), 'the new road does not overwrite the old one')
  assert.ok(geo.blocks.every(b => !oldCells.has(`${b.x},${b.z}`)))
})

test('no junction onto a road at another height or on its stairs', () => {
  const t = flat(-10, -20, 40, 20)
  const old = planned(t, { x: 20, z: -18 }, { x: 20, z: 18 })
  layRoad(t, old.geo)
  for (const c of old.geo.surface) t.roadF[cellIndex(t, c.x, c.z)] = 80
  assert.equal(planRoad(t, { from: [{ x: 0, z: 3, out: 'east' }], to: [], toRoads: old.geo.surface }).ok, false, 'too high to reach')
  for (const c of old.geo.surface) { t.roadF[cellIndex(t, c.x, c.z)] = 65; t.roadStair[cellIndex(t, c.x, c.z)] = 0 }
  const r = planRoad(t, { from: [{ x: 0, z: 3, out: 'east' }], to: [], toRoads: old.geo.surface })
  assert.equal(r.ok, false)
})

test('a lake: no route without bridging, a deck with railings when bridging', () => {
  const t = terrainFrom({ x0: -10, z0: -12, x1: 40, z1: 12 }, x => (x >= 10 && x <= 20 ? 62 : 64), x => (x >= 10 && x <= 20 ? LIQUID : 0))
  const no = planRoad(t, { from: [{ x: 0, z: 0 }], to: [{ x: 30, z: 0 }] })
  assert.equal(no.ok, false)
  assert.match(no.ok ? '' : no.reason, /cut off|water/)
  const r = planRoad(t, { from: [{ x: 0, z: 0 }], to: [{ x: 30, z: 0 }] }, { bridge: true })
  assert.ok(r.ok, r.ok ? '' : r.reason)
  const geo = roadGeometry(r.route, t)
  assert.deepEqual(geometryProblems(r.route, geo), [])
  const over = geo.surface.filter(c => t.flags[cellIndex(t, c.x, c.z)]! & LIQUID)
  assert.ok(over.length >= 33, 'the road crosses the water')
  assert.ok(over.every(c => c.f - 1 >= 62), 'the deck is at or above the water')
  assert.ok(geo.rails.some(rl => t.flags[cellIndex(t, rl.x, rl.z)]! & LIQUID), 'railings on the bridge')
})

test('connect: six doors on a hill, all joined, no overlaps', () => {
  const peak = (x: number, z: number) => 64 + Math.round(26 * Math.exp(-(x * x + z * z) / (2 * 14 * 14)))
  const t = terrainFrom({ x0: -40, z0: -40, x1: 40, z1: 40 }, peak)
  const houses = [
    { x0: -3, z0: -3, x1: 3, z1: 3, door: { x: 0, z: 4, out: 'south' as const } },
    { x0: 14, z0: -6, x1: 18, z1: -2, door: { x: 13, z: -4, out: 'west' as const } },
    { x0: -20, z0: 4, x1: -16, z1: 8, door: { x: -15, z: 6, out: 'east' as const } },
    { x0: 6, z0: 18, x1: 10, z1: 22, door: { x: 8, z: 17, out: 'north' as const } },
    { x0: -14, z0: -24, x1: -10, z1: -20, door: { x: -12, z: -19, out: 'south' as const } },
    { x0: 22, z0: 14, x1: 26, z1: 18, door: { x: 21, z: 16, out: 'west' as const } }
  ]
  for (const h of houses) addBuilding(t, h, 1)
  const ends: RoadEnd[] = houses.map(h => ({ ...h.door, f: peak(h.door.x, h.door.z) + 1 }))
  const res = connect(t, ends, { maxCut: 6, maxFill: 8 })
  assert.equal(res.groups.length, 1, `not all joined: ${JSON.stringify(res.failed)}`)
  assert.equal(res.roads.length, 5)
  const owner = new Map<string, number>()
  res.roads.forEach((r, n) => {
    assert.deepEqual(geometryProblems(r.route, r.geometry), [], `road ${n}`)
    for (const c of r.geometry.surface) {
      const k = `${c.x},${c.z}`
      assert.ok(!owner.has(k), `roads ${owner.get(k)} and ${n} overlap at ${k}`)
      owner.set(k, n)
    }
  })
  // railings don't stand on another road, and every lane stays out of the houses
  res.roads.forEach((r, n) => {
    // (a later road may replace an earlier railing where it joins that road)
    for (const rl of r.geometry.rails) {
      const on = owner.get(`${rl.x},${rl.z}`)
      assert.ok(on === undefined || on > n, `railing of ${n} on the earlier road ${on}`)
    }
    assertClear(t, r.geometry, BLOCKED)
  })
  // every door is used once at most, and the rest join with T-junctions
  const doors = res.roads.flatMap(r => [r.from, r.to]).filter(i => i >= 0)
  assert.equal(new Set(doors).size, doors.length)
  assert.ok(res.terrain.flags.some(f => f & ROAD))
})

test('geometry: base down to the ground, head-room cut, railings on drops of 2 or more', () => {
  // a ditch beside a flat road: railing on that side only
  const t = terrainFrom({ x0: -5, z0: -5, x1: 20, z1: 5 }, (_x, z) => (z === 2 ? 60 : 64))
  const { geo } = planned(t, { x: 0, z: 0 }, { x: 15, z: 0 })
  assert.ok(geo.rails.length > 0 && geo.rails.every(r => r.z === 2))
  const rails = geo.blocks.filter(b => b.part === 'rail')
  assert.ok(rails.every(b => b.block === 'stone_brick_wall' && b.y === 65))
  const base = geo.blocks.filter(b => b.part === 'base')
  assert.ok(base.every(b => b.z === 2 && b.y >= 61 && b.y <= 64), 'a base under the railing down to the ditch floor')
  assert.ok(geo.clear.every(c => c.y >= 65 && c.y <= 67), 'head-room over the lanes')
  // a cut: the road dug into a bump
  const t2 = terrainFrom({ x0: -5, z0: -5, x1: 30, z1: 5 }, x => (x >= 10 && x <= 14 ? 66 : 64))
  const r2 = planned(t2, { x: 0, z: 0 }, { x: 25, z: 0 }, { riseCost: 50, bumpCost: 50 })
  assert.ok(r2.route.every(c => c.f === 65), 'cuts through a small bump rather than stepping over it')
  assert.equal(r2.geo.stats.maxCut, 2)
  assert.ok(r2.geo.clear.some(c => c.x === 12 && c.y === 66), 'the bump is cut away')
})

test('geometry: lanterns on landing posts and a /fill-friendly block list', () => {
  const t = flat(-10, -16, 40, 16)
  addBuilding(t, { x0: 10, z0: -4, x1: 18, z1: 4 }, 1)
  const r = planRoad(t, { from: [{ x: 0, z: 0 }], to: [{ x: 30, z: 0 }] })
  assert.ok(r.ok)
  const geo = roadGeometry(r.route, t, { lanterns: true })
  const lights = geo.blocks.filter(b => b.part === 'light')
  assert.equal(lights.length, geo.stats.landings)
  assert.ok(lights.every(l => l.y === 66 && geo.blocks.some(b => b.part === 'rail' && b.x === l.x && b.z === l.z && b.y === 65)))
  assert.ok(mergeRuns(geo.blocks.map(b => ({ ...b, block: b.block }))).length < geo.blocks.length / 3, 'flat stretches merge into few /fill boxes')
})

test('search limits: a clear reason when there is no route or the search runs out', () => {
  const t = flat(-10, -10, 40, 10)
  addBuilding(t, { x0: 10, z0: -10, x1: 12, z1: 10 }, 0)
  const r = planRoad(t, { from: [{ x: 0, z: 0 }], to: [{ x: 30, z: 0 }] })
  assert.equal(r.ok, false)
  const t2 = terrainFrom({ x0: -40, z0: -40, x1: 40, z1: 40 }, (x, z) => 64 + Math.round(10 * Math.sin(x / 3) * Math.cos(z / 4)))
  const r2 = planRoad(t2, { from: [{ x: -35, z: -35 }], to: [{ x: 35, z: 35 }] }, { maxNodes: 500 })
  assert.equal(r2.ok, false)
  assert.match(r2.ok ? '' : r2.reason, /gave up after 500/)
})
