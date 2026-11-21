import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseBlueprint, loadBlueprints, rotate, placeCells, resolveRoles, materials, orderCells, diffCells, cellState,
  chooseSite, facingToward, isNaturalBlock, type Column, type Pos
} from '../src/skills/blueprint.ts'
import { planWood, countWant, wantsForRoles, woodRecipe } from '../src/skills/materials.ts'
import { bestToolIn, craftableTiers, planksFor, plankUnits, toolKindFor, minTierFor } from '../src/skills/toolkit.ts'

const SMALL = `
name: box
description: test box
facing: south
roles:
  wall: { default: oak_planks, accept: "_planks$", material: true }
  door: { default: oak_door, accept: "_door$", kind: door }
  light: { default: torch, kind: attachment, optional: true }
palette: { "#": wall, D: door, T: light, ".": air }
layers:
  - ["###", "###", "###"]
  - ["###", "#T#", "#D#"]
  - ["###", "###", "###"]
`

// ------------------------------------------------------------------ parsing

const xyz = (c: { x: number, y: number, z: number, role: string }) => ({ x: c.x, y: c.y, z: c.z, role: c.role })

test('blueprints parse into cells; " " is ignored', () => {
  const bp = parseBlueprint(SMALL)
  assert.equal(bp.name, 'box')
  assert.deepEqual([bp.width, bp.depth, bp.height], [3, 3, 3])
  assert.equal(bp.cells.length, 27)
  assert.equal(bp.cells.filter(c => c.role === 'wall').length, 25)
  assert.deepEqual(xyz(bp.cells.find(c => c.role === 'door')!), { x: 1, y: 1, z: 2, role: 'door' })
  const gap = parseBlueprint(SMALL.replace('"#D#"', '"# #"'))
  assert.equal(gap.cells.length, 26)
})

test('blueprint validation names the problem', () => {
  assert.throws(() => parseBlueprint(SMALL.replace('"#T#"', '"#X#"')), /"X" is not in the palette/)
  assert.throws(() => parseBlueprint(SMALL.replace('D: door', 'D: gate')), /unknown role "gate"/)
  assert.throws(() => parseBlueprint(SMALL.replace('["###", "###", "###"]\n  - ["###", "#T#"', '["###", "###"]\n  - ["###", "#T#"')), /rows/)
  assert.throws(() => parseBlueprint(SMALL.replace('name: box', 'name: Big Box')), /lowercase/)
  assert.throws(() => parseBlueprint(SMALL.replace('layers:', 'nope:')), /layers/)
})

test('shipped blueprints all load', () => {
  const { blueprints, errors } = loadBlueprints()
  assert.deepEqual(errors, [])
  for (const n of ['hut', 'shelter', 'wall_segment', 'platform', 'tower']) assert.ok(blueprints.has(n), n)
  const hut = blueprints.get('hut')!
  assert.deepEqual([hut.width, hut.depth, hut.height], [5, 5, 4])
  assert.equal(hut.cells.filter(c => c.role === 'door').length, 1)
  assert.equal(blueprints.get('shelter')!.site, 'here')
})

// ------------------------------------------------------------------ rotation & placement

test('rotation turns the entrance to the requested side', () => {
  const bp = parseBlueprint(SMALL)
  const door = (b: typeof bp) => xyz(b.cells.find(c => c.role === 'door')!)
  assert.deepEqual(door(rotate(bp, 'south')), { x: 1, y: 1, z: 2, role: 'door' })
  assert.deepEqual(door(rotate(bp, 'west')), { x: 0, y: 1, z: 1, role: 'door' })
  assert.deepEqual(door(rotate(bp, 'north')), { x: 1, y: 1, z: 0, role: 'door' })
  assert.deepEqual(door(rotate(bp, 'east')), { x: 2, y: 1, z: 1, role: 'door' })
  const wall = parseBlueprint(SMALL.replace(/layers:[\s\S]*/, 'layers:\n  - ["#####"]\n'))
  const r = rotate(wall, 'east')
  assert.deepEqual([r.width, r.depth], [1, 5], 'non-square footprints swap sides')
})

test('cells are centred on the origin; facingToward picks the dominant axis', () => {
  const cells = placeCells(parseBlueprint(SMALL), { x: 100, y: 64, z: -20 })
  const xs = cells.map(c => c.x), zs = cells.map(c => c.z), ys = cells.map(c => c.y)
  assert.deepEqual([Math.min(...xs), Math.max(...xs)], [99, 101])
  assert.deepEqual([Math.min(...zs), Math.max(...zs)], [-21, -19])
  assert.deepEqual([Math.min(...ys), Math.max(...ys)], [64, 66])
  assert.equal(facingToward({ x: 0, z: 0 }, { x: 5, z: 1 }), 'east')
  assert.equal(facingToward({ x: 0, z: 0 }, { x: 1, z: -5 }), 'north')
})

// ------------------------------------------------------------------ materials

test('material accounting: any planks count unless the player named one', () => {
  const bp = parseBlueprint(SMALL)
  const inv = { spruce_planks: 10, oak_planks: 4, oak_door: 1 }
  const roles = resolveRoles(bp, inv)
  assert.equal(roles.wall!.item, 'spruce_planks', 'picks what it has most of')
  const rows = materials(bp.cells, roles, inv)
  const wall = rows.find(r => r.role === 'wall')!
  assert.deepEqual([wall.need, wall.have, wall.missing], [25, 14, 11])
  assert.match(wall.label, /any _planks/)
  assert.equal(rows.find(r => r.role === 'door')!.missing, 0)
  assert.equal(rows.find(r => r.role === 'light')!.optional, true)

  const strict = resolveRoles(bp, inv, 'oak_planks')
  assert.equal(materials(bp.cells, strict, inv).find(r => r.role === 'wall')!.have, 4, 'material=oak_planks only counts oak')
  assert.equal(resolveRoles(bp, {}).wall!.item, 'oak_planks', 'default when the inventory has none')
})

test('blueprint materials become a generic shopping list', () => {
  const hut = loadBlueprints().blueprints.get('hut')!
  const w = wantsForRoles(hut.cells, resolveRoles(hut, {}))
  assert.deepEqual(w.required, { planks: 78, door: 1 })
  assert.deepEqual(w.optional, { glass_pane: 2, torch: 1 })
})

// ------------------------------------------------------------------ order

test('placement order: floor, walls, roof from the edges in, then torch, door last', () => {
  const bp = parseBlueprint(SMALL)
  const order = orderCells(bp.cells, bp.roles)
  const ys = order.filter(c => bp.roles[c.role]?.kind === 'block').map(c => c.y)
  assert.deepEqual(ys, [...ys].sort((a, b) => a - b), 'layers bottom-up')
  assert.equal(order.at(-1)!.role, 'door')
  assert.equal(order.at(-2)!.role, 'light')

  // a roof over a ring of walls: the middle comes after an edge neighbour
  const roof = parseBlueprint(`
name: roofed
description: r
roles: { w: { default: stone } }
palette: { "#": w }
layers:
  - ["###", "# #", "###"]
  - ["###", "###", "###"]
`)
  const o = orderCells(roof.cells, roof.roles).filter(c => c.y === 1)
  const mid = o.findIndex(c => c.x === 1 && c.z === 1)
  assert.equal(mid, o.length - 1, 'centre of the roof has no wall below, it goes in last')
})

// ------------------------------------------------------------------ resume / world diff

test('resume: blocks already right are skipped, natural clutter dug, player blocks refuse', () => {
  const bp = parseBlueprint(SMALL)
  const roles = resolveRoles(bp, { oak_planks: 30 })
  const cells = placeCells(bp, { x: 0, y: 64, z: 0 })
  const world = new Map<string, string>()
  const key = (p: Pos) => `${p.x},${p.y},${p.z}`
  // first 10 cells of the floor were placed in an earlier, interrupted run (with spruce)
  for (const c of cells.filter(c => c.y === 64).slice(0, 5)) world.set(key(c), 'spruce_planks')
  world.set(key(cells.find(c => c.y === 65 && c.role === 'wall')!), 'short_grass')
  world.set(key(cells.find(c => c.y === 66)!), 'dirt')
  const d = diffCells(cells, p => world.get(key(p)) ?? 'air', roles, true)
  assert.equal(d.done.length, 5)
  assert.equal(d.dig.length, 1)
  assert.equal(d.blocked.length, 0)
  assert.equal(d.place.length, 27 - 5 - 1)
  assert.equal(diffCells(cells, p => world.get(key(p)) ?? 'air', roles, false).blocked.length, 1, 'no digging: dirt in the way blocks')

  world.set(key(cells.find(c => c.y === 66)!), 'chest')
  assert.equal(diffCells(cells, p => world.get(key(p)) ?? 'air', roles, true).blocked.length, 1, 'a chest is never dug')
  assert.equal(cellState({ role: 'air' }, 'poppy', roles, true), 'clear')
  assert.equal(cellState({ role: 'air' }, 'cobblestone', roles, true), 'blocked')
  assert.equal(cellState({ role: 'door' }, 'spruce_door', roles, true), 'done')
  assert.ok(isNaturalBlock('grass_block') && isNaturalBlock('oak_leaves') && !isNaturalBlock('oak_log') && !isNaturalBlock('oak_planks'))
})

// ------------------------------------------------------------------ site

test('site choice: flat natural ground near the player, away from builds, water and forbidden areas', () => {
  const flat = (y = 63): Column => ({ ground: y, groundName: 'grass_block', soft: 0, foreign: false, liquid: false })
  const world = (x: number, z: number): Column => {
    if (x >= 3 && x <= 8 && z >= -2 && z <= 2) return { ...flat(), foreign: true } // a player's house east
    if (x <= -4) return { ...flat(), liquid: true, groundName: 'water' } // a lake west
    if (z >= 5) return flat(63 + ((x + z) % 3)) // bumpy south
    return flat()
  }
  const site = chooseSite(world, 5, 5, { x: 0, z: 0 }, { radius: 10, canDig: false })!
  assert.ok(site, 'found a site')
  assert.equal(site.origin.y, 64, 'floor goes on top of the ground')
  const x0 = site.origin.x - 2, z0 = site.origin.z - 2
  for (let x = x0; x < x0 + 5; x++) for (let z = z0; z < z0 + 5; z++) {
    const c = world(x, z)
    assert.ok(!c.foreign && !c.liquid, `site cell ${x},${z} is clear`)
  }
  assert.ok(!(0 >= x0 - 1 && 0 <= x0 + 5 && 0 >= z0 - 1 && 0 <= z0 + 5), 'not on top of the player')

  const forbidden = (p: Pos) => p.z < 10
  const far = chooseSite(world, 5, 5, { x: 0, z: 0 }, { radius: 6, canDig: false, forbidden })
  assert.equal(far, null, 'nothing allowed and flat within the radius')

  const bump = (x: number, z: number): Column => flat(x === 1 && z === 1 ? 64 : 63)
  const dug = chooseSite(bump, 3, 3, { x: 1, z: 6 }, { radius: 6, canDig: true })!
  assert.equal(dug.origin.y, 64)
  const noDig = chooseSite((x, z) => ({ ...flat(), soft: x === 0 ? 1 : 0 }), 3, 3, { x: 0, z: 0 }, { radius: 4, canDig: false })!
  assert.ok(noDig.origin.x - 1 > 0 || noDig.origin.x + 1 < 0, 'without digging, flowers in the way are avoided')
})

// ------------------------------------------------------------------ materials planning & tools

test('wood plan: logs, planks, sticks, table and an axe for big jobs', () => {
  const p = planWood({ planks: 78, door: 1 }, {})
  // 78 + 6 (door) + 4 (table) + axe 3 + sticks 2 planks = 93 planks -> 24 logs
  assert.equal(p.makeAxe, true)
  assert.equal(p.needTable, true)
  assert.equal(p.planks, 93)
  assert.equal(p.logsToChop, 24)
  const have = planWood({ planks: 78, door: 1 }, { oak_log: 30, wooden_axe: 1 })
  assert.equal(have.logsToChop, 0, 'enough logs already')
  assert.equal(have.makeAxe, false)
  const small = planWood({ stick: 4 }, {})
  assert.deepEqual([small.logsToChop, small.makeAxe, small.needTable], [1, false, false], 'sticks: one log, no table, no axe')
  const mixed = planWood({ cobblestone: 20, torch: 4, beacon: 1 }, { stick: 4 })
  assert.deepEqual(mixed.mine, { cobblestone: 20 })
  assert.equal(mixed.coalShort, 1)
  assert.deepEqual(mixed.unsupported, ['beacon'])
  assert.equal(countWant('door', { spruce_door: 1, iron_door: 3 }), 1)
  assert.equal(countWant('planks', { spruce_planks: 3, oak_planks: 2 }), 5)
  assert.equal(woodRecipe('iron_door'), null)
})

test('tool helpers pick the best tier and know what the inventory can make', () => {
  assert.equal(bestToolIn(['wooden_axe', 'iron_axe', 'stone_pickaxe'], 'axe'), 'iron_axe')
  assert.equal(bestToolIn(['stone_pickaxe'], 'axe'), null, 'a pickaxe is not an axe')
  assert.equal(planksFor('dark_oak_log'), 'dark_oak_planks')
  assert.equal(planksFor('stripped_birch_wood'), 'birch_planks')
  assert.equal(planksFor('oak_planks'), null)
  assert.equal(plankUnits({ oak_log: 2, spruce_planks: 3 }), 11)
  assert.deepEqual(craftableTiers({ oak_log: 1 }, 'axe'), [], 'one log is 4 planks: 3 for the head + 2 for sticks is 5')
  assert.deepEqual(craftableTiers({ oak_log: 2 }, 'axe'), ['wooden'])
  assert.deepEqual(craftableTiers({ oak_log: 2 }, 'axe', true), [], 'not with a table to make too')
  assert.deepEqual(craftableTiers({ oak_log: 3 }, 'axe', true), ['wooden'])
  assert.deepEqual(craftableTiers({ cobblestone: 3, stick: 2, oak_planks: 1 }, 'pickaxe'), ['stone'])
  assert.equal(toolKindFor({ material: 'mineable/pickaxe' }), 'pickaxe')
  assert.equal(toolKindFor({ material: 'mineable/axe' }), 'axe')
  assert.equal(toolKindFor({ material: 'plant' }), null)
  const items: Record<number, { name: string }> = { 1: { name: 'wooden_pickaxe' }, 2: { name: 'stone_pickaxe' }, 3: { name: 'iron_pickaxe' } }
  assert.equal(minTierFor({ items }, { harvestTools: { 2: true, 3: true } }), 'stone')
  assert.equal(minTierFor({ items }, { harvestTools: { 1: true, 2: true } }), 'wooden')
})

test('placement order: floor cells over a dip go in after a supported neighbour', () => {
  const bp = parseBlueprint(`
name: pad
description: p
roles: { w: { default: stone } }
palette: { "#": w }
layers:
  - ["###"]
`)
  // the ground under the west cell is missing (a dip)
  const o = orderCells(bp.cells, bp.roles, p => p.x !== 0)
  assert.deepEqual(o.map(c => c.x), [1, 2, 0])
})
