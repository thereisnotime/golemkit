import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  planPlacement, familyOf, blockNameFor, yawFor, facingOfYaw, doorHingeCursor, hingeFromCursor, rotateState, parseStateString,
  checkCell, fixFor, summarize, skipReason, rankStands, distToBlock, FACINGS, opposite, DIR_VEC,
  type Dir, type PlaceEnv, type Facing
} from '../src/skills/blockstate.ts'
import {
  parseBlueprint, loadBlueprints, rotate, placeCells, resolveRoles, orderCells, diffCells, solidCells, roleAccepts, fillCells,
  pickFacing, facingsToward, chooseSite, renderBlueprint, swapWood, pickTheme, BLUEPRINTS_DIR, type Column
} from '../src/skills/blueprint.ts'
import { planWood, wantsForRoles, concreteName, countWant, woodRecipe } from '../src/skills/materials.ts'

/** A world where only the listed neighbours are solid. */
const env = (solid: Dir[], extra: Partial<PlaceEnv> = {}): PlaceEnv => ({ solid: d => solid.includes(d), ...extra })
const ALL: Dir[] = ['down', 'up', 'north', 'south', 'east', 'west']

// ------------------------------------------------------------------ blueprint format

const STATEFUL = `
name: gable
description: a little roof
facing: south
stairs: roof
roles:
  roof: { default: oak_stairs, accept: "_stairs$", wood: true }
  ridge: { default: oak_slab, accept: "_slab$", wood: true, state: { type: bottom } }
  post: { default: oak_log, accept: "_log$", wood: true, state: { axis: y } }
  door: { default: oak_door, accept: "_door$", kind: door, wood: true }
  bed: { default: white_bed, accept: "_bed$", kind: furnish, optional: true }
  light: { default: torch, accept: "^(wall_)?torch$", kind: attachment, optional: true }
palette:
  "|": post
  "-": "post[axis=x]"
  s: ridge
  T: { role: ridge, state: { type: top } }
  D: "door[facing=north,hinge=right]"
  B: "bed[facing=north,part=foot]"
  b: "bed[facing=north,part=head]"
  t: "light[facing=south]"
  o: "minecraft:oak_trapdoor[facing=east,open=true]"
  g: { block: glass }
  ".": air
meta: { tags: [test], author: me, source: hand }
layers:
  - ["|-|", "bD.", "B.t"]
  - ["vvv", "sTo", "^^g"]
`

test('palette states: object, [k=v] form, role defaults, arrows, passive halves, plain blocks', () => {
  const bp = parseBlueprint(STATEFUL)
  const at = (x: number, y: number, z: number) => bp.cells.find(c => c.x === x && c.y === y && c.z === z)!
  assert.deepEqual(at(0, 0, 0).state, { axis: 'y' }, 'role default state')
  assert.deepEqual(at(1, 0, 0).state, { axis: 'x' }, 'palette overrides the role state')
  assert.deepEqual(at(1, 0, 1).state, { facing: 'north', hinge: 'right' })
  assert.deepEqual(at(0, 1, 0).state, { facing: 'south', half: 'bottom' }, 'v = stairs climbing south')
  assert.deepEqual(at(0, 1, 2).state, { facing: 'north', half: 'bottom' }, '^ = stairs climbing north')
  assert.equal(at(0, 1, 0).role, 'roof')
  assert.deepEqual(at(1, 1, 1).state, { type: 'top' }, 'object entry merges over the role state')
  assert.equal(at(0, 0, 1).passive, true, "the bed's head is passive")
  assert.equal(at(0, 0, 2).passive, undefined)
  assert.equal(at(2, 1, 1).role, 'block:oak_trapdoor', 'minecraft:block[...] gets a role of its own')
  assert.deepEqual(at(2, 1, 1).state, { facing: 'east', open: 'true' })
  assert.equal(at(2, 1, 2).role, 'block:glass')
  assert.equal(bp.roles['block:glass']!.default, 'glass')
  assert.deepEqual((bp.meta as { tags: string[] }).tags, ['test'], 'meta is kept, not validated')
  assert.equal(solidCells(bp.cells).length, 15, 'passive and air cells are not placed')
  assert.throws(() => parseBlueprint(STATEFUL.replace('hinge=right', 'hinge=up')), /bad hinge "up"/)
  assert.throws(() => parseBlueprint(STATEFUL.replace('"door[facing=north,hinge=right]"', '"door[facing=north"')), /can't read/)
  assert.deepEqual(parseStateString('roof[facing=north, half=top]'), { role: 'roof', state: { facing: 'north', half: 'top' } })
  assert.deepEqual(parseStateString('wall'), { role: 'wall' })
})

test('rotation turns facings and log axes with the blueprint', () => {
  const bp = parseBlueprint(STATEFUL)
  const r = rotate(bp, 'west') // south -> west is one quarter turn clockwise
  const door = r.cells.find(c => c.role === 'door')!
  assert.equal(door.state!.facing, 'east', 'north turned once is east')
  assert.equal(door.state!.hinge, 'right', 'hinge is relative and stays')
  assert.equal(r.cells.find(c => c.state?.axis === 'z' && c.role === 'post')!.glyph, '-', 'axis x becomes z')
  assert.ok(r.cells.filter(c => c.role === 'post' && c.glyph === '|').every(c => c.state!.axis === 'y'), 'axis y stays')
  const back = rotate(rotate(r, 'north'), 'south')
  assert.deepEqual(back.cells.map(c => c.state), bp.cells.map(c => c.state), 'four turns are the identity')
  assert.deepEqual(rotateState({ facing: 'north', half: 'top' }, 2), { facing: 'south', half: 'top' })
  assert.deepEqual(rotateState({ axis: 'x' }, 3), { axis: 'z' })
})

test('roles: wood themes, fallbacks, and the passive bed head in the diff', () => {
  const bp = loadBlueprints().blueprints.get('small_house')!
  const spruce = resolveRoles(bp, { spruce_log: 3, oak_planks: 2 }, undefined, 'spruce')
  assert.equal(spruce.roof!.item, 'spruce_stairs', 'theme picks the default in that wood')
  assert.equal(spruce.wall!.item, 'oak_planks', 'but what the bot carries comes first when it has no theme planks')
  assert.equal(spruce.window!.fallbacks![0]!.item, 'spruce_fence', 'fallbacks follow the theme')
  assert.ok(roleAccepts(spruce.window!, 'birch_fence'), 'any wood fence fills a window')
  assert.equal(swapWood('oak_stairs', 'dark_oak'), 'dark_oak_stairs')
  assert.equal(swapWood('glass_pane', 'birch'), 'glass_pane')
  assert.equal(pickTheme({ birch_log: 2, oak_planks: 5, cobblestone: 64 }), 'birch', 'logs count four')
  assert.equal(pickTheme({ dirt: 3 }), null)

  const cells = placeCells(bp, { x: 0, y: 64, z: 0 })
  const head = cells.find(c => c.passive)!
  const world = new Map<string, string>()
  const key = (p: { x: number, y: number, z: number }) => `${p.x},${p.y},${p.z}`
  const d = diffCells(cells, p => world.get(key(p)) ?? 'air', spruce, true)
  assert.ok(d.done.includes(head), 'an empty bed head is fine')
  world.set(key(head), 'white_bed')
  assert.ok(diffCells(cells, p => world.get(key(p)) ?? 'air', spruce, true).done.includes(head))
  world.set(key(head), 'chest')
  assert.ok(diffCells(cells, p => world.get(key(p)) ?? 'air', spruce, true).blocked.includes(head), 'something player-made there blocks')
})

test('blueprints load from several directories, later ones override by name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-'))
  writeFileSync(join(dir, 'hut.yaml'), 'name: hut\ndescription: mine\nroles: { w: { default: stone } }\npalette: { "#": w }\nlayers: [["#"]]\n')
  writeFileSync(join(dir, 'broken.yaml'), 'name: Broken\n')
  const { blueprints, errors } = loadBlueprints([BLUEPRINTS_DIR, dir, join(dir, 'nope')])
  assert.equal(blueprints.get('hut')!.description, 'mine')
  assert.ok(blueprints.has('cottage'))
  assert.equal(errors.length, 2, 'the broken file and the missing directory are reported')
})

// ------------------------------------------------------------------ placement planner

test('planner: stairs face the look direction, half from the face or the cursor height', () => {
  for (const f of FACINGS) {
    const [best] = planPlacement('oak_stairs', { facing: f, half: 'bottom' }, env(ALL))
    assert.equal(best!.ref, 'down')
    assert.equal(best!.face, 'up')
    assert.equal(facingOfYaw(best!.yaw!), f, `yaw looks ${f}`)
  }
  const top = planPlacement('oak_stairs', { facing: 'east', half: 'top' }, env(ALL))
  assert.ok(!top.some(o => o.ref === 'down'), 'never the top of the block below for an upside-down stair')
  assert.deepEqual(top.find(o => o.ref === 'up')!.cursor, { x: 0.5, y: 0, z: 0.5 })
  const side = planPlacement('oak_stairs', { facing: 'east', half: 'top' }, env(['north']))
  assert.equal(side.length, 1)
  assert.equal(side[0]!.face, 'south', 'clicks the south face of the block to the north')
  assert.deepEqual(side[0]!.cursor, { x: 0.5, y: 0.75, z: 1 }, 'upper half of that face')
  const low = planPlacement('oak_stairs', { facing: 'east', half: 'bottom' }, env(['west']))
  assert.equal(low[0]!.cursor.y, 0.25)
  assert.deepEqual(planPlacement('oak_stairs', { facing: 'east' }, env([])), [], 'nothing to click yet')
})

test('planner: slabs by half, and never merged into a double slab', () => {
  assert.equal(planPlacement('oak_slab', { type: 'bottom' }, env(ALL))[0]!.ref, 'down')
  assert.equal(planPlacement('oak_slab', { type: 'top' }, env(ALL))[0]!.ref, 'north')
  assert.ok(!planPlacement('oak_slab', { type: 'top' }, env(ALL)).some(o => o.ref === 'down'))
  const onSlab = planPlacement('oak_slab', { type: 'bottom' }, env(['down', 'east'], { name: d => (d === 'down' ? 'oak_slab' : 'oak_planks') }))
  assert.deepEqual(onSlab.map(o => o.ref), ['east'], 'the top of a bottom oak slab would merge')
  assert.equal(onSlab[0]!.cursor.y, 0.25)
})

test('planner: logs click a face on their axis', () => {
  assert.deepEqual(planPlacement('spruce_log', { axis: 'x' }, env(ALL)).map(o => o.ref), ['west', 'east'])
  assert.deepEqual(planPlacement('spruce_log', { axis: 'z' }, env(['down', 'north'])).map(o => o.ref), ['north'])
  assert.deepEqual(planPlacement('spruce_log', { axis: 'x' }, env(['down', 'north'])), [], 'waits for a neighbour on x')
  assert.deepEqual(planPlacement('oak_log', undefined, env(['down'])).map(o => o.face), ['up'], 'upright by default')
})

test('planner: door facing from the look, hinge from the cursor (DoorBlock rule)', () => {
  for (const f of FACINGS) {
    for (const h of ['left', 'right'] as const) {
      const [o] = planPlacement('oak_door', { facing: f, hinge: h }, env(['down'], { free: () => true }))
      assert.equal(o!.ref, 'down')
      assert.equal(facingOfYaw(o!.yaw!), f)
      assert.equal(hingeFromCursor(f, o!.cursor.x, o!.cursor.z), h, `${f} ${h}`)
      assert.deepEqual({ x: o!.cursor.x, z: o!.cursor.z }, doorHingeCursor(f, h))
    }
  }
  assert.deepEqual(planPlacement('oak_door', { facing: 'north' }, env(['down'], { free: d => d !== 'up' })), [], 'no headroom')
  assert.equal(planPlacement('oak_door', { facing: 'north', open: 'true' }, env(['down']))[0]!.activate, true)
})

test('planner: trapdoors hinge on a side face, or face away from the look on top/bottom', () => {
  const t = planPlacement('spruce_trapdoor', { facing: 'south', half: 'top', open: 'true' }, env(ALL))
  assert.equal(t[0]!.ref, 'north', 'clicks the south face of the block behind it')
  assert.equal(t[0]!.face, 'south')
  assert.equal(t[0]!.cursor.y, 0.75)
  assert.equal(t[0]!.activate, true)
  const v = t.find(o => o.ref === 'up')!
  assert.equal(facingOfYaw(v.yaw!), 'north', 'looking north gives a trapdoor facing south')
  const bottom = planPlacement('spruce_trapdoor', { facing: 'west', half: 'bottom' }, env(['down']))
  assert.equal(bottom.length, 1)
  assert.equal(facingOfYaw(bottom[0]!.yaw!), 'east')
})

test('planner: wall torches and ladders need the wall behind them and a level look at it', () => {
  for (const f of FACINGS) {
    const [o] = planPlacement('torch', { facing: f }, env(ALL))
    assert.equal(o!.ref, opposite(f), `torch facing ${f} hangs on the ${opposite(f)} wall`)
    assert.equal(o!.face, f)
    assert.equal(o!.pitch, 0)
    assert.equal(facingOfYaw(o!.yaw!), opposite(f))
  }
  assert.deepEqual(planPlacement('ladder', { facing: 'south' }, env(['down', 'south'])), [], 'no wall to the north')
  assert.equal(planPlacement('ladder', { facing: 'south' }, env(['north']))[0]!.ref, 'north')
  const standing = planPlacement('torch', undefined, env(ALL))
  assert.equal(standing.length, 1)
  assert.equal(standing[0]!.ref, 'down')
  assert.ok(standing[0]!.pitch! < -1.5, 'looks straight down so it stands up')
  assert.equal(planPlacement('lantern', { hanging: 'true' }, env(ALL))[0]!.ref, 'up')
  assert.equal(familyOf('torch', { facing: 'east' }), 'wall_mounted')
  assert.equal(blockNameFor('torch', { facing: 'east' }), 'wall_torch')
  assert.equal(blockNameFor('soul_torch', { facing: 'east' }), 'soul_wall_torch')
  assert.equal(blockNameFor('torch'), 'torch')
})

test('planner: beds look along their facing and need room for the head; chests face the player', () => {
  const [bed] = planPlacement('white_bed', { facing: 'west', part: 'foot' }, env(['down'], { free: () => true }))
  assert.equal(facingOfYaw(bed!.yaw!), 'west')
  assert.deepEqual(planPlacement('white_bed', { facing: 'west' }, env(['down'], { free: d => d !== 'west' })), [])
  const chest = planPlacement('chest', { facing: 'south' }, env(['down']))
  assert.equal(facingOfYaw(chest[0]!.yaw!), 'north', 'a chest facing south is placed looking north')
  assert.equal(planPlacement('oak_fence_gate', { facing: 'east' }, env(['down']))[0]!.yaw, yawFor('east'))
  assert.equal(planPlacement('glass_pane', undefined, env(['west']))[0]!.yaw, undefined, 'plain blocks just look at the face')
  for (const f of FACINGS) assert.equal(facingOfYaw(yawFor(f)), f)
})

test('stand spots: within reach of the clicked block, never in the cells being filled', () => {
  const cands = [{ x: 0, y: 64, z: 0 }, { x: 0, y: 64, z: 2 }, { x: 9, y: 64, z: 9 }, { x: 1, y: 63, z: 0 }]
  const ranked = rankStands(cands, { x: 0, y: 66, z: 1 }, [{ x: 0, y: 64, z: 0 }, { x: 0, y: 65, z: 0 }], { x: 0.5, y: 64, z: 2.5 })
  assert.deepEqual(ranked, [{ x: 0, y: 64, z: 2 }, { x: 1, y: 63, z: 0 }])
  assert.equal(distToBlock({ x: 0.5, y: 70, z: 0.5 }, { x: 0, y: 66, z: 0 }), 3, 'measured to the nearest face')
})

// ------------------------------------------------------------------ verification and fixes

test('quality check: names, hard and soft properties, and what to do about each', () => {
  const stairs = (n: string) => /_stairs$/.test(n)
  const repl = (n: string) => n === 'air' || n === 'short_grass'
  const ok = checkCell(stairs, { facing: 'north', half: 'bottom' }, 'spruce_stairs', { facing: 'north', half: 'bottom', shape: 'outer_left', waterlogged: false }, repl)
  assert.equal(ok.status, 'ok', 'shape and waterlogged are not asked for')
  const wrong = checkCell(stairs, { facing: 'north', half: 'bottom' }, 'oak_stairs', { facing: 'east', half: 'bottom' }, repl)
  assert.deepEqual([wrong.status, wrong.hard], ['wrong_state', ['facing']])
  assert.equal(checkCell(stairs, { facing: 'north' }, 'short_grass', {}, repl).status, 'missing')
  assert.equal(checkCell(stairs, {}, 'cobblestone', {}, repl).status, 'wrong_block')
  const hinge = checkCell(n => /_door$/.test(n), { facing: 'north', hinge: 'left' }, 'oak_door', { facing: 'north', hinge: 'right', half: 'lower', open: false }, repl)
  assert.equal(hinge.status, 'soft', 'hinge follows the neighbours: reported, not fixed')
  assert.equal(checkCell(stairs, { shape: 'outer' }, 'oak_stairs', { shape: 'outer_right' }, repl).status, 'ok', '"outer" means either side')
  const pane = checkCell(n => /pane|fence/.test(n), { facing: 'south' }, 'oak_fence', { north: true, south: false }, repl)
  assert.equal(pane.status, 'ok', 'a fallback without that property is fine')
  const shut = checkCell(n => /trapdoor/.test(n), { facing: 'south', open: 'true' }, 'oak_trapdoor', { facing: 'south', open: false }, repl)

  assert.equal(fixFor(ok, 'stairs', true), 'none')
  assert.equal(fixFor(wrong, 'stairs', true), 'replace')
  assert.equal(fixFor(wrong, 'stairs', false), 'report', 'no digging: leave it')
  assert.equal(fixFor(shut, 'trapdoor', true), 'toggle', 'only open/closed wrong: use it')
  assert.equal(fixFor(checkCell(stairs, {}, 'air', {}, repl), 'stairs', true), 'place')
  assert.equal(fixFor(hinge, 'door', true), 'none')
  assert.equal(fixFor(checkCell(stairs, {}, 'dirt', {}, repl), 'stairs', true), 'report', 'never break a foreign block')
})

test('quality summary: built/total and optional parts skipped with a reason', () => {
  const okc = { status: 'ok' as const, hard: [], soft: [] }
  const miss = { status: 'missing' as const, hard: [], soft: [] }
  const rows = [
    ...Array.from({ length: 182 }, () => ({ role: 'wall', label: 'wall', optional: false, check: okc })),
    { role: 'bed', label: 'bed', optional: true, check: miss },
    { role: 'window', label: 'window', optional: true, check: miss },
    { role: 'window', label: 'window', optional: true, check: miss },
    { role: 'roof', label: 'roof', optional: false, check: { status: 'wrong_state' as const, hard: ['facing'], soft: [] } }
  ]
  const s = summarize(rows)
  assert.deepEqual([s.built, s.total, s.missingRequired, s.wrongState], [182, 186, 1, 1])
  assert.deepEqual(s.skipped, { bed: 1, window: 2 })
  assert.equal(skipReason('white_bed'), 'no wool')
  assert.equal(skipReason('glass_pane'), 'no glass')
  assert.equal(skipReason('torch'), 'no coal')
})

// ------------------------------------------------------------------ materials

test('materials plan: stairs, slabs, fences, trapdoors, ladders, beds, furnaces, panes, torches', () => {
  assert.deepEqual(woodRecipe('oak_stairs'), { planks: 6, out: 4, table: true })
  assert.deepEqual(woodRecipe('white_bed'), { planks: 3, wool: 3, out: 1, table: true })
  assert.equal(woodRecipe('cobblestone_stairs'), null, 'stone stairs are not wood')
  const p = planWood({ stairs: 31, slab: 5, fence: 4, trapdoor: 2, ladder: 5 }, { wooden_axe: 1, crafting_table: 1 })
  // stairs 8 crafts * 6 = 48, slabs 1 * 3, fences 2 * 4 (+4 sticks), trapdoors 1 * 6, ladders 2 crafts (14 sticks)
  // sticks 18 -> 5 stick crafts = 10 planks; total 48 + 3 + 8 + 6 + 10 = 75 planks -> 19 logs
  assert.equal(p.planks, 75)
  assert.equal(p.sticks, 18)
  assert.equal(p.logsToChop, 19)
  assert.equal(p.needTable, false)

  const bed = planWood({ bed: 1, furnace: 1, glass_pane: 8 }, { wooden_axe: 1, crafting_table: 1, cobblestone: 2 })
  assert.equal(bed.wool, 3)
  assert.equal(bed.glass, 6, 'one pane craft takes 6 glass')
  assert.deepEqual(bed.mine, { cobblestone: 6 }, 'furnace: 8 cobblestone, 2 held')
  assert.equal(bed.makePickaxe, true)
  assert.equal(bed.needFurnace, true)
  assert.equal(bed.furnaceCobble, 0, 'the wanted furnace doubles as the smelting one')
  assert.equal(bed.fuelPlanks, 4, '6 glass need 4 planks of fuel')

  const torch = planWood({ torch: 4 }, { stick: 1 })
  assert.equal(torch.coalShort, 1)
  assert.equal(torch.charcoal, 1, 'charcoal from one log when there is no coal')
  assert.equal(torch.furnaceCobble, 8)
  assert.equal(planWood({ torch: 4 }, { stick: 1, coal: 1 }).charcoal, 0)
  assert.equal(countWant('bed', { red_bed: 1, oak_planks: 4 }), 1)
  assert.equal(countWant('fence', { oak_fence: 2, oak_fence_gate: 1 }), 2)
  assert.equal(countWant('glass_pane', { glass: 2, glass_pane: 3 }), 3, 'glass blocks are crafted into panes, not counted as panes')
})

test('blueprint shopping lists use generic wood names and carry fallbacks', () => {
  const bp = loadBlueprints().blueprints.get('small_house')!
  const w = wantsForRoles(bp.cells, resolveRoles(bp, {}))
  assert.deepEqual(w.required, { planks: 65, stairs: 31, log: 12, door: 1, slab: 5 })
  assert.deepEqual(w.optional, { chest: 1, bed: 1, crafting_table: 1, torch: 2, glass_pane: 2 })
  assert.deepEqual(w.fallbacks, { glass_pane: { fence: 2 } })
  const cottage = loadBlueprints().blueprints.get('cottage')!
  const c = wantsForRoles(cottage.cells, resolveRoles(cottage, {}))
  assert.equal(c.required.cobblestone, 30)
  assert.equal(c.optional.carpet, undefined, 'carpet is never gathered')
  assert.equal(concreteName('stairs', { oak_planks: 40, spruce_planks: 10 }, 'spruce'), 'spruce_stairs', 'theme wood first')
  assert.equal(concreteName('stairs', { oak_planks: 40 }, 'spruce'), 'oak_stairs', 'unless there are no theme planks')
  assert.equal(concreteName('bed', {}, undefined, 'white'), 'white_bed')
  assert.equal(concreteName('bed', {}, undefined, null), null)
})

// ------------------------------------------------------------------ site preparation, orientation, preview

test('site prep: dips under the floor get filled, at most two deep', () => {
  const bp = parseBlueprint('name: pad\ndescription: p\nroles: { w: { default: stone } }\npalette: { "#": w }\nlayers: [["###"]]\n')
  const cells = placeCells(bp, { x: 1, y: 64, z: 0 })
  const ground = (x: number) => ({ 0: 63, 1: 61, 2: 58 } as Record<number, number>)[x]!
  const fills = fillCells(cells, x => ground(x))
  assert.deepEqual(fills.map(f => `${f.x},${f.y}`).sort(), ['1,62', '1,63', '2,62', '2,63'])
  const flat = (y: number): Column => ({ ground: y, groundName: 'grass_block', soft: 0, foreign: false, liquid: false })
  const dippy = (x: number, z: number) => flat(x === 0 && z === 0 ? 61 : 63)
  const site = chooseSite(dippy, 3, 3, { x: 0, z: 5 }, { radius: 4, canDig: true })!
  assert.equal(site.origin.y, 64)
  assert.equal(chooseSite(dippy, 3, 3, { x: 0, z: 5 }, { radius: 1, canDig: false }), null, 'without site prep a 2-deep dip is too much')
})

test('door side: towards the player unless blocked, then the next best open side', () => {
  assert.deepEqual(facingsToward({ x: 0, z: 0 }, { x: 10, z: 3 }).slice(0, 2), ['east', 'south'])
  assert.equal(facingsToward({ x: 0, z: 0 }, { x: 10, z: 3 }).at(-1), 'west')
  assert.equal(pickFacing(['east', 'south', 'north', 'west'], f => f !== 'east'), 'south')
  assert.equal(pickFacing(['east', 'south'], () => false), 'east', 'nothing open: still face the player')
})

test('preview: top view and layers, stairs drawn by the way they climb', () => {
  const bp = loadBlueprints().blueprints.get('small_house')!
  const text = renderBlueprint(bp)
  assert.match(text, /^small_house: 5x7, 7 high/)
  assert.match(text, /top view:\n {2}vvvvv/)
  assert.match(text, /layer 1:\n\n {2}\|###\|\n {2}#b\.C#/)
  const turned = renderBlueprint(rotate(bp, 'east'), { layers: false })
  assert.match(turned, />>>s<<</, 'turned east, the slopes climb towards the ridge from west and east')
  assert.ok(!turned.includes('layer 0'))
})

test('shipped house blueprints are buildable: every block has something to click in order', () => {
  for (const name of ['small_house', 'cottage', 'cabin', 'watchtower']) {
    const bp = loadBlueprints().blueprints.get(name)!
    const roles = resolveRoles(bp, {})
    const order = orderCells(bp.cells, roles).filter(c => c.role !== 'air' && !c.passive)
    const solid = new Set<string>()
    const key = (x: number, y: number, z: number) => `${x},${y},${z}`
    let deferred = order.slice()
    for (let round = 0; round < 6 && deferred.length; round++) {
      deferred = deferred.filter(c => {
        const e: PlaceEnv = {
          solid: d => { const v = DIR_VEC[d]; return c.y + v.y < 0 || solid.has(key(c.x + v.x, c.y + v.y, c.z + v.z)) },
          free: () => true
        }
        const opts = planPlacement(roles[c.role]!.item, c.state, e)
        if (!opts.length) return true
        solid.add(key(c.x, c.y, c.z))
        return false
      })
    }
    assert.deepEqual(deferred.map(c => `${c.role}@${c.x},${c.y},${c.z}`), [], `${name}: all placeable`)
  }
})

test('the facing helpers agree with each other', () => {
  for (const f of FACINGS as Facing[]) assert.equal(opposite(opposite(f)), f)
})

test('creative: the shopping list becomes concrete items to take, only what is missing', async () => {
  const { creativeStock } = await import('../src/skills/materials.ts')
  const take = creativeStock({ planks: 65, stairs: 31, log: 12, door: 1, bed: 1, glass_pane: 2, cobblestone: 30 }, { spruce_planks: 5, oak_door: 1 }, 'spruce')
  assert.deepEqual(take, { spruce_planks: 60, spruce_stairs: 31, spruce_log: 12, white_bed: 1, glass_pane: 2, cobblestone: 30 })
  assert.deepEqual(creativeStock({ slab: 5 }, {}), { oak_slab: 5 }, 'oak without a theme')
  assert.deepEqual(creativeStock({ planks: 3 }, { birch_planks: 9 }), {})
})

test('a few unreachable blocks finish the build honestly instead of failing forever', async () => {
  const { finishDespiteUnreachable, UNREACHABLE } = await import('../src/skills/blockstate.ts')
  const u = new Set(['1,2,3', '4,5,6', '7,8,9'])
  assert.equal(finishDespiteUnreachable(['1,2,3', '4,5,6', '7,8,9'], u, 197, false), true, '194/197, three out of reach')
  assert.equal(finishDespiteUnreachable(['1,2,3', '0,0,0'], u, 197, false), false, 'one failed for another reason')
  assert.equal(finishDespiteUnreachable(['1,2,3'], u, 197, true), false, 'ran out of materials: not done')
  assert.equal(finishDespiteUnreachable([], u, 197, false), false)
  const many = Array.from({ length: 8 }, (_, i) => `${i},0,0`)
  assert.equal(finishDespiteUnreachable(many, new Set(many), 197, false), false, 'too many to call it built')
  assert.ok(UNREACHABLE.test('Took to long to decide path to goal!'))
  assert.ok(UNREACHABLE.test('No path to the goal!'))
  assert.ok(!UNREACHABLE.test('no oak_planks in inventory'))
})

test('own and mixed blocks: earlier oak planks count for a spruce rebuild; own misplaced blocks may be dug', () => {
  const bp = loadBlueprints().blueprints.get('hut')!
  const roles = resolveRoles(bp, {}, 'spruce_planks')
  const cells = placeCells(bp, { x: 0, y: 64, z: 0 })
  const wall = cells.find(c => c.role === 'wall')!
  const air = cells.find(c => c.role === 'air')!
  const world = new Map<string, string>([[`${wall.x},${wall.y},${wall.z}`, 'oak_planks'], [`${air.x},${air.y},${air.z}`, 'cobblestone']])
  const at = (p: { x: number, y: number, z: number }) => world.get(`${p.x},${p.y},${p.z}`) ?? 'air'
  const d = diffCells(cells, at, roles, true)
  assert.ok(d.done.includes(wall), 'material=spruce_planks still accepts the oak wall that is already there')
  assert.ok(d.blocked.includes(air), 'a stranger\'s cobblestone inside blocks the build')
  const mine = diffCells(cells, at, roles, true, p => p.x === air.x && p.y === air.y && p.z === air.z)
  assert.ok(mine.clear.includes(air), 'our own cobblestone there gets cleared')
  assert.equal(diffCells(cells, at, roles, false, () => true).blocked.length, 1, 'without digging it still blocks')
})
