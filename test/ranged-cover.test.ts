import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  rangedResponse, planWall, lineBlocked, holdDecision, digInRefusal, digInSeconds, coverCell, pickCoverBlock, feetCellY,
  COMMIT_MS, type RangedState, type ShooterView, type DigInView, type RangedDecision
} from '../src/skills/ranged-plan.ts'

// Pax, 25 Nov 2026: stone tools, no armour or shield, 3 pillagers on snowy ground. It flapped between
// "cover 7 blocks off is too slow" and "cover 15 blocks off is too slow" retreats and was shot dead.
const pax = { armor: 0, shield: false, melee: true, weaponDamage: 5 }
let ids = 1
const sh = (o: Partial<ShooterView> = {}): ShooterView => ({ id: ids++, name: 'pillager', dist: 10, los: true, ...o })
const three = () => [sh({ dist: 9 }), sh({ dist: 11 }), sh({ dist: 13 })]
const st = (o: Partial<RangedState>): RangedState => ({ health: 14, armor: 0, bow: false, shield: false, melee: true, shooters: [], patrol: 0, coverNear: false, ...pax, ...o })

test('heavy fire, cover 7 blocks off: build a 2-block wall here instead', () => {
  const d = rangedResponse(st({ shooters: three(), coverNear: true, coverDist: 7, canBuild: true, wallBlocks: 2 }))!
  assert.equal(d.act, 'build')
  assert.match(d.why, /building here \(cover 7 blocks off is too slow\)/)
})

test('heavy fire, cover 15 blocks off: build here or dig in, never run', () => {
  assert.equal(rangedResponse(st({ shooters: three(), coverNear: true, coverDist: 15, canBuild: true, wallBlocks: 2 }))!.act, 'build')
  const dig = rangedResponse(st({ shooters: three(), coverNear: true, coverDist: 15, digInSeconds: digInSeconds(400, 1) }))!
  assert.equal(dig.act, 'dig_in')
  assert.match(dig.why, /digging in here \(cover 15 blocks off is too slow\)/)
  // a pillar wall is slower than digging in: the quicker one wins
  assert.equal(rangedResponse(st({ shooters: three(), canBuild: true, wallBlocks: 4, wallPillar: 2, digInSeconds: digInSeconds(300, 0) }))!.act, 'dig_in')
})

test('light fire, cover 3 blocks off: walk to it', () => {
  const one = [sh({ name: 'skeleton', dist: 12 })]
  assert.equal(rangedResponse(st({ health: 6, shooters: one, coverNear: true, coverDist: 3, canBuild: true, wallBlocks: 2 }))!.act, 'cover')
  // not heavy: cover first, then a wall, then digging in, then backing off
  const hide = { hide: 'asked to take cover', health: 20, shooters: one }
  assert.equal(rangedResponse(st({ ...hide, coverNear: true, coverDist: 3 }))!.act, 'cover')
  assert.equal(rangedResponse(st({ ...hide, canBuild: true, digInSeconds: 1 }))!.act, 'build')
  assert.equal(rangedResponse(st({ ...hide, digInSeconds: 1 }))!.act, 'dig_in')
})

test('no blocks and no dig: back off towards home', () => {
  const d = rangedResponse(st({ shooters: three(), home: true }))!
  assert.equal(d.act, 'retreat')
  assert.equal(d.toward, 'home')
  assert.match(d.why, /getting out of sight, towards home/)
  const away = rangedResponse(st({ shooters: three() }))!
  assert.equal(away.act, 'retreat')
  assert.equal(away.toward, 'away')
})

test('snow under the feet: the wall goes into the snow cells, placed against real blocks', () => {
  // ground at y <= 63, a snow layer in every cell at y = 64 (replaceable, no collision)
  const placed = new Set<string>()
  const k = (x: number, y: number, z: number) => `${x},${y},${z}`
  const solid = (x: number, y: number, z: number) => y <= 63 || placed.has(k(x, y, z))
  const snow = (_x: number, y: number) => y === 64
  const placeable = (x: number, y: number, z: number) => !solid(x, y, z) && coverCell({ name: snow(x, y) ? 'snow' : 'air', replaceable: true, layers: 1, canDig: false }) === 'place'
  // standing on two layers of snow (feet at 64.125): planned from the snow cell
  const bot = { x: 0.5, y: feetCellY(64.125), z: 0.5 }
  assert.equal(bot.y, 64)
  const shooter = { x: 12.5, y: 65.5, z: 0.5 }
  const plan = planWall({ bot, shooters: [shooter], solid, placeable })!
  assert.equal(plan.pillar, 0)
  assert.deepEqual(plan.blocks, [{ x: 1, y: 64, z: 0 }, { x: 1, y: 65, z: 0 }], 'into the snow cell east of it, then on top')
  for (const b of plan.blocks) {
    const faces = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
    const refs = faces.map(([dx, dy, dz]) => [b.x + dx!, b.y + dy!, b.z + dz!] as const).filter(([x, y, z]) => solid(x, y, z))
    assert.ok(refs.length, `a solid block next to ${k(b.x, b.y, b.z)}`)
    assert.ok(refs.every(([x, y, z]) => !snow(x, y) || placed.has(k(x, y, z))), 'never a snow layer as the reference')
    placed.add(k(b.x, b.y, b.z))
  }
  for (const dy of [1.0, 1.62]) assert.ok(lineBlocked({ x: 0.5, y: 64 + dy, z: 0.5 }, shooter, solid))
})

test('cover cells: one snow layer takes a block, deeper snow needs digging first, lava never', () => {
  assert.equal(coverCell({ name: 'snow', replaceable: true, layers: 1, canDig: false }), 'place')
  assert.equal(coverCell({ name: 'snow', replaceable: true, layers: 3, canDig: true }), 'dig')
  assert.equal(coverCell({ name: 'snow', replaceable: true, layers: 3, canDig: false }), null)
  assert.equal(coverCell({ name: 'short_grass', replaceable: true, canDig: false }), 'place')
  assert.equal(coverCell({ name: 'stone', replaceable: false, canDig: true }), null)
  assert.equal(coverCell({ name: 'lava', replaceable: true, canDig: true }), null)
  assert.equal(feetCellY(64), 64)
  assert.equal(feetCellY(63.9375), 64, 'on a path block the feet are in the layer above')
})

test('cover block: cobblestone and dirt before logs, enough for the wall', () => {
  assert.equal(pickCoverBlock([{ name: 'spruce_log', count: 30 }, { name: 'cobblestone', count: 12 }, { name: 'dirt', count: 3 }]), 'cobblestone')
  assert.equal(pickCoverBlock([{ name: 'spruce_log', count: 30 }, { name: 'cobblestone', count: 1 }]), 'spruce_log', 'one cobblestone is not a wall')
  assert.equal(pickCoverBlock([{ name: 'snow_block', count: 8 }, { name: 'oak_planks', count: 4 }]), 'oak_planks')
  assert.equal(pickCoverBlock([]), null)
})

test('dig in: quick floor, safe below, no liquid, not protected', () => {
  const ok: DigInView = { canDig: true, floor: 'dirt', floorSolid: true, below: 'stone', belowSolid: true, sides: ['dirt', 'dirt', 'stone', 'grass_block'], feet: 'snow', digMs: 750, protected: false }
  assert.equal(digInRefusal(ok), null)
  assert.match(digInRefusal({ ...ok, canDig: false })!, /digging is off/)
  assert.match(digInRefusal({ ...ok, protected: true })!, /protected/)
  assert.match(digInRefusal({ ...ok, floor: 'ice' })!, /ice/, 'ice turns to water')
  assert.match(digInRefusal({ ...ok, floor: 'obsidian' })!, /obsidian/)
  assert.match(digInRefusal({ ...ok, digMs: 4000 })!, /too slow/)
  assert.match(digInRefusal({ ...ok, digMs: null })!, /too slow/)
  assert.match(digInRefusal({ ...ok, below: 'air', belowSolid: false })!, /nothing safe/, 'a drop or the void')
  assert.match(digInRefusal({ ...ok, below: 'lava', belowSolid: false })!, /nothing safe/)
  assert.match(digInRefusal({ ...ok, below: 'magma_block' })!, /nothing safe/)
  assert.match(digInRefusal({ ...ok, sides: ['dirt', 'water', 'dirt', 'dirt'] })!, /liquid beside/)
  assert.match(digInRefusal({ ...ok, feet: 'water' })!, /liquid/)
  assert.equal(digInSeconds(750, 2), 2)
})

test('hysteresis: a way of hiding is kept for a moment while still possible', () => {
  const retreat: RangedDecision = { act: 'retreat', target: 1, why: 'heavy fire, getting out of sight' }
  const cover: RangedDecision = { act: 'cover', target: 2, why: 'heavy fire, the nearest cover' }
  const all = () => true
  const prev = { d: retreat, at: 1000 }
  assert.equal(holdDecision(prev, cover, 1500, all).act, 'retreat', 'kept')
  assert.equal(holdDecision(prev, cover, 1500, all).target, 2, 'the target follows the newest pick')
  assert.equal(holdDecision(prev, cover, 1000 + COMMIT_MS, all).act, 'cover', 'commit time over')
  assert.equal(holdDecision(prev, cover, 1500, a => a !== 'retreat').act, 'cover', 'no longer possible')
  assert.equal(holdDecision(prev, { act: 'shoot', target: 1, why: 'bow' }, 1500, all).act, 'shoot', 'fighting back switches at once')
  assert.equal(holdDecision(null, cover, 1500, all).act, 'cover')
})
