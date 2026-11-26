// The staircase mine planner (src/skills/stairMinePlan.ts): settings, readiness, where the mine
// goes, the trip decisions, ore in the walls, junk, the mine as a site.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  stairMineSettings, stairMineReadiness, entranceProblem, pickEntrance, mineTargetY, mineTripStep, branchEvery, sides, mineJunk,
  visibleOre, tunnelAir, oreWanted, nextMineName, pickMine, mineLit, mineTripDue, mineSiteVerdict, STAIR_MINE_DEFAULTS,
  type EntranceCandidate, type MineSite, type TripState, type BlockLook, type P
} from '../src/skills/stairMinePlan.ts'
import { miningSettings } from '../src/skills/minePlan.ts'
import { planStep } from '../src/skills/mining.ts'

const S = STAIR_MINE_DEFAULTS
const M = miningSettings({ gear: 'shield_or_armour', minFood: 4 })

function world (blocks: Record<string, string>, surface = 64): BlockLook {
  return (p: P) => {
    const name = blocks[`${p.x},${p.y},${p.z}`] ?? (p.y >= surface ? 'air' : 'stone')
    return { name, solid: !/air|water|lava|torch/.test(name) }
  }
}

test('stairMineSettings: defaults, overrides, bad values, off', () => {
  assert.deepEqual(stairMineSettings(undefined), S)
  const s = stairMineSettings({ depthY: -20, gear: 'armour', ores: ['iron'], minutes: 'long', radius: 48 })
  assert.equal(s.depthY, -20)
  assert.equal(s.gear, 'armour')
  assert.deepEqual(s.ores, ['iron'])
  assert.equal(s.minutes, S.minutes)
  assert.equal(s.radius, 48)
  assert.equal(stairMineSettings({ gear: 'chainmail' }).gear, 'none')
  assert.equal(stairMineSettings(false).enabled, false)
})

test('stairMineReadiness: Pax (stone tools, food, no armour) may go down its own mine though mining.gear asks for a shield', () => {
  const pax = { weapon: true, food: 12, armour: 0, shield: false }
  assert.equal(stairMineReadiness(pax, 20, S, M).ready, true)
  assert.deepEqual(stairMineReadiness({ ...pax, food: 2 }, 20, S, M).missing, ['food 2/4'])
  assert.deepEqual(stairMineReadiness(pax, 9, S, M).missing, ['health 9/14'])
  const g = stairMineReadiness(pax, 20, { ...S, gear: 'shield_or_armour' }, M)
  assert.deepEqual([g.ready, g.need], [false, 'gear'])
  assert.equal(stairMineReadiness({ ...pax, weapon: false }, 20, S, M).need, 'weapon')
  assert.equal(stairMineReadiness({ weapon: false, food: 0, armour: 0, shield: false }, 1, S, miningSettings({ safe: false })).ready, true)
})

const cand = (o: Partial<EntranceCandidate>): EntranceCandidate => ({ pos: { x: 0, y: 64, z: 0 }, dir: { x: 1, z: 0 }, homeDist: 12, safeSteps: 4, ...o })

test('entrances: near home but out of the base, dry, unprotected, not roofed, not on a farm, 4 safe steps', () => {
  assert.equal(entranceProblem(cand({}), S), null)
  assert.match(entranceProblem(cand({ homeDist: 40 }), S)!, /more than 32/)
  assert.match(entranceProblem(cand({ homeDist: 3 }), S)!, /closer than 8/)
  assert.equal(entranceProblem(cand({ protectedArea: true }), S), 'protected')
  assert.match(entranceProblem(cand({ wet: true }), S)!, /water/)
  assert.match(entranceProblem(cand({ roofed: true }), S)!, /roof/)
  assert.match(entranceProblem(cand({ farm: true }), S)!, /farm/)
  assert.match(entranceProblem(cand({ safeSteps: 2 }), S)!, /2 safe steps/)
  const p = pickEntrance([cand({ homeDist: 20 }), cand({ homeDist: 10, wet: true }), cand({ homeDist: 14 })], S)
  assert.ok('pick' in p && p.pick.homeDist === 14)
  // Pax's frozen lake: everything wet, and it says so
  const none = pickEntrance([cand({ wet: true }), cand({ wet: true }), cand({ protectedArea: true })], S)
  assert.ok('none' in none && /2 water, ice or lava close by, 1 protected/.test(none.none), JSON.stringify(none))
})

test('mineTargetY: depthY, above the world floor, below the start', () => {
  assert.equal(mineTargetY(67, S), 16)
  assert.equal(mineTargetY(10, S), 9)
  assert.equal(mineTargetY(67, { depthY: -70 }), -58)
})

const trip = (o: Partial<TripState>): TripState => ({ phase: 'down', y: 40, targetY: 16, elapsedMs: 60_000, freeSlots: 20, food: 8, pickaxe: true, want: 9, got: 0, branches: 0, ...o })

test('mineTripStep: down to depth, then the main tunnel and branches, back up on any limit', () => {
  assert.deepEqual(mineTripStep(trip({}), S), { go: 'down' })
  assert.deepEqual(mineTripStep(trip({ y: 16 }), S), { go: 'main' })
  assert.deepEqual(mineTripStep(trip({ phase: 'main', y: 16 }), S), { go: 'main' })
  assert.deepEqual(mineTripStep(trip({ retreat: 'health 9/20 underground' }), S), { back: 'health 9/20 underground' })
  assert.match((mineTripStep(trip({ got: 9 }), S) as { back: string }).back, /got the 9/)
  assert.deepEqual(mineTripStep(trip({ want: 0, got: 30 }), S), { go: 'down' }, 'no target: mine on')
  assert.match((mineTripStep(trip({ elapsedMs: 16 * 60_000 }), S) as { back: string }).back, /15 minutes/)
  assert.deepEqual(mineTripStep(trip({ freeSlots: 2 }), S), { back: 'inventory full' })
  assert.deepEqual(mineTripStep(trip({ pickaxe: false }), S), { back: 'no pickaxe left' })
  assert.deepEqual(mineTripStep(trip({ food: 0 }), S), { back: 'out of food' })
  assert.match((mineTripStep(trip({ phase: 'main', y: 16, branches: 6 }), S) as { back: string }).back, /6 branches/)
  assert.equal(branchEvery(S), 4)
  assert.deepEqual(sides({ x: 1, z: 0 }), [{ x: 0, z: -1 }, { x: 0, z: 1 }])
})

test('visibleOre: wanted ore touching the tunnel and its vein, by pickaxe tier', () => {
  const at = world({ '1,10,0': 'iron_ore', '2,10,0': 'iron_ore', '2,11,0': 'deepslate_iron_ore', '-1,10,0': 'diamond_ore', '0,12,0': 'coal_ore', '5,10,0': 'iron_ore' })
  const spots = [{ x: 0, y: 10, z: 0 }, { x: 0, y: 11, z: 0 }]
  const stone = visibleOre(at, spots, 2, S.ores).map(p => `${p.x},${p.y}`)
  assert.deepEqual(stone.sort(), ['0,12', '1,10', '2,10', '2,11'].sort(), 'vein followed, diamond needs iron, far ore unseen')
  assert.ok(visibleOre(at, spots, 3, S.ores).some(p => p.x === -1), 'iron pickaxe: diamonds too')
  assert.equal(visibleOre(at, spots, 2, ['coal']).length, 1)
  assert.equal(oreWanted('copper_ore', 2, S.ores), true)
  assert.equal(oreWanted('gold_ore', 3, S.ores), false, 'not in the list')
})

test('tunnelAir: the tunnel from an earlier trip is not a cave', () => {
  // a corridor x 0..4 at y 10-11, and a cave pocket off on its own at x 3, y 14
  const blocks: Record<string, string> = { '3,14,0': 'cave_air' }
  for (let x = 0; x <= 4; x++) { blocks[`${x},10,0`] = 'air'; blocks[`${x},11,0`] = 'air' }
  blocks['2,10,0'] = 'wall_torch'
  const at = world(blocks)
  const t = tunnelAir(at, { x: 4, y: 10, z: 0 })
  assert.ok(t.has('0,10,0') && t.has('2,10,0'))
  assert.equal(t.has('3,14,0'), false)
  // with it, the next step on from the face plans; without, the corridor behind looks like a cave
  const caves = { belowY: 63, tunnel: t }
  assert.equal(typeof planStep(at, { x: 4, y: 10, z: 0 }, { x: 1, z: 0 }, false, () => true, false, caves), 'object')
})

test('mineJunk: extra cobblestone and mining junk, whole stacks, keepCobble kept', () => {
  const stacks = [{ name: 'cobblestone', count: 64 }, { name: 'cobblestone', count: 64 }, { name: 'cobblestone', count: 12 }, { name: 'dirt', count: 20 }, { name: 'granite', count: 5 }, { name: 'raw_iron', count: 4 }]
  const t = mineJunk(stacks, 3, 64)
  assert.deepEqual(t.map(x => x.name), ['dirt', 'granite', 'cobblestone'])
  assert.equal(t.find(x => x.name === 'cobblestone')!.count, 12, 'the smallest cobblestone stack, 128 left')
  assert.equal(mineJunk(stacks, 10, 64).filter(x => x.name === 'cobblestone').reduce((n, x) => n + x.count, 0), 76, 'never below 64 cobblestone')
  assert.deepEqual(mineJunk(stacks, 0, 64), [])
})

const site = (o: Partial<MineSite>): MineSite => ({ id: 'mine:1', entrance: { x: 570, y: 67, z: -60 }, dir: { x: 1, z: 0 }, path: [], deepest: 67, mainSteps: 0, branches: 0, torches: 0, stairSteps: 0, trips: 0, lastAt: 0, got: {}, ...o })

test('the mine as a site: name, which one, lit, due, verdict', () => {
  assert.equal(nextMineName([]), 'mine:1')
  assert.equal(nextMineName(['mine:1', 'mine:4', 'farm:9']), 'mine:5')
  const home = { x: 560, y: 67, z: -43 }
  const a = site({ id: 'mine:1', bottom: { x: 620, y: 16, z: -60 }, mainSteps: 20 })
  const b = site({ id: 'mine:2' })
  const far = site({ id: 'mine:3', entrance: { x: 900, y: 70, z: 0 }, bottom: { x: 950, y: 16, z: 0 }, mainSteps: 99 })
  assert.equal(pickMine([b, a, far], home, 32, 'overworld', () => false)?.id, 'mine:1')
  assert.equal(pickMine([b, a], home, 32, 'overworld', id => id === 'mine:1')?.id, 'mine:2', 'a bad mine is skipped')
  assert.equal(pickMine([far], home, 32, 'overworld', () => false), null)
  assert.equal(mineLit({ torches: 5, stairSteps: 51 }, 8), true)
  assert.equal(mineLit({ torches: 1, stairSteps: 51 }, 8), false)
  assert.equal(mineLit({ torches: 0, stairSteps: 0 }, 8), false)
  assert.equal(mineTripDue(undefined, 1000, S), true)
  assert.equal(mineTripDue(0, 10 * 60_000, S), true)
  assert.equal(mineTripDue(1, 10 * 60_000, S), false)
  assert.equal(mineTripDue(1, 21 * 60_000, S), true)
  assert.deepEqual(mineSiteVerdict({ steps: ['air', 'air', 'air', 'air'] }), { ok: true })
  assert.equal((mineSiteVerdict({ steps: ['air', 'water', 'air', 'air'] }) as { fault: string }).fault, 'flooded')
  assert.equal((mineSiteVerdict({ steps: ['lava', 'air'] }) as { fault: string }).fault, 'unsafe')
  assert.equal((mineSiteVerdict({ steps: ['solid', 'solid', 'solid', 'air'] }) as { fault: string }).fault, 'gone')
})
