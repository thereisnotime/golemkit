import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { rankStands, standCost, standCandidatesIn, underForeignRoof, standKey, distToBlock, EYE, type StandBlock } from '../src/skills/blockstate.ts'
import { orderCells, pickNearby, isNaturalBlock } from '../src/skills/blueprint.ts'
import { standPathMs } from '../src/skills/placement.ts'
import { keepClimbing } from '../src/skills/survival.ts'
import { movement } from '../src/skills/movement.ts'

type P = { x: number, y: number, z: number }
const k = (p: P) => `${p.x},${p.y},${p.z}`

// ------------------------------------------------------------------ stand spots

test('stand ranking: failed spots are never tried again in the same build', () => {
  const cands = [{ x: 0, y: 64, z: 2 }, { x: 1, y: 64, z: 2 }]
  const failed = new Set([standKey({ x: 0, y: 64, z: 2 })])
  const ranked = rankStands(cands, { x: 0, y: 64, z: 0 }, [], { x: 0.5, y: 64, z: 2.5 }, 4.4, { failed })
  assert.deepEqual(ranked, [{ x: 1, y: 64, z: 2 }])
})

test('stand ranking: at or above the target level beats a spot below it, even a bit closer', () => {
  const target = { x: 0, y: 67, z: 0 }
  const below = { x: 1, y: 65, z: 1 }
  const level = { x: 2, y: 67, z: 0 }
  const bot = { x: 1.5, y: 66, z: 1.5 }
  const ranked = rankStands([below, level], target, [], bot, 4.4, { target })
  assert.deepEqual(ranked[0], level)
  assert.ok(standCost(below, target, bot) > standCost(level, target, bot))
})

test('stand ranking: sealed pockets and cells still to build come last', () => {
  const target = { x: 0, y: 64, z: 0 }
  const bot = { x: 0.5, y: 64, z: 3.5 }
  const open = { x: 2, y: 64, z: 0 }
  const sealed = { x: 0, y: 64, z: 2, sealed: true }
  const inWall = { x: 1, y: 64, z: 2 }
  const unbuilt = (p: P) => p.x === 1 && p.z === 2
  const ranked = rankStands([sealed, inWall, open], target, [], bot, 4.4, { unbuilt })
  assert.deepEqual(ranked.map(c => `${c.x},${c.z}`), ['2,0', '1,2', '0,2'])
})

test('stand path budget: a few seconds, a little more when further, capped', () => {
  assert.ok(standPathMs(0) >= 3000 && standPathMs(0) <= 6000)
  assert.ok(standPathMs(10) > standPathMs(2))
  assert.ok(standPathMs(500) <= 8000, 'never the 15 s that used to be spent per spot')
})

// A fake world: ground (dirt) up to y=67 everywhere, air above; a 5x5 plank hut (walls y 68-70,
// roof y 71) centred on 560 -46 with a door gap; a sealed air pocket under the floor at 556 64..65 -43.
function hutWorld () {
  const hut = { x0: 558, x1: 562, z0: -48, z1: -44 }
  const at = (p: P): StandBlock => {
    const inHut = p.x >= hut.x0 && p.x <= hut.x1 && p.z >= hut.z0 && p.z <= hut.z1
    const edge = inHut && (p.x === hut.x0 || p.x === hut.x1 || p.z === hut.z0 || p.z === hut.z1)
    if (p.x === 556 && p.z === -43 && (p.y === 64 || p.y === 65)) return { name: 'cave_air', boundingBox: 'empty' }
    if (p.y <= 67) return { name: p.y === 67 ? 'grass_block' : 'dirt', boundingBox: 'block' }
    if (inHut && p.y === 71) return { name: 'oak_planks', boundingBox: 'block' }
    const door = p.x === 560 && p.z === hut.z1 && (p.y === 68 || p.y === 69)
    if (edge && p.y <= 70 && !door) return { name: 'oak_planks', boundingBox: 'block' }
    return { name: 'air', boundingBox: 'empty' }
  }
  return { at, hut }
}

test('fake world: a floor under an existing hut is placed from outside, never from inside the hut or a pocket below', () => {
  const { at, hut } = hutWorld()
  // the fortress floor is layer y=67; nothing above it is part of the plan here
  const planCell = (p: P) => p.y === 67
  const inside = (p: P) => underForeignRoof(at, p, planCell, isNaturalBlock)
  // a floor cell at the hut's wall line: the clicked block is the floor neighbour outside it
  const target = { x: 558, y: 67, z: -46 }
  const ref = { x: 557, y: 67, z: -46 }
  const cands = standCandidatesIn(at, target, { inside })
  assert.ok(cands.length > 0)
  for (const c of cands) {
    const inHut = c.x > hut.x0 && c.x < hut.x1 && c.z > hut.z0 && c.z < hut.z1
    assert.ok(!inHut, `no spot inside the hut (${k(c)})`)
  }
  // the pocket under the floor is sealed, so it ranks behind every open spot
  const pocket = cands.find(c => c.x === 556 && c.y === 64 && c.z === -43)
  assert.ok(pocket?.sealed, 'the air pocket under the floor counts as sealed')
  const bot = { x: 553.5, y: 68, z: -46.5 }
  const ranked = rankStands(cands, ref, [target], bot, 4.4, { target })
  assert.ok(ranked.length > 0)
  assert.equal(ranked[0]!.y, 68, 'stands on the ground at floor level, not below it')
  assert.ok(ranked.indexOf(pocket!) === -1 || ranked.indexOf(pocket!) > ranked.findIndex(c => !c.sealed))
  const best = ranked[0]!
  assert.ok(distToBlock({ x: best.x + 0.5, y: best.y + EYE, z: best.z + 0.5 }, ref) <= 4.4)
  // without the foreign-roof rule the inside of the hut would have been on the list
  const all = standCandidatesIn(at, target)
  assert.ok(all.some(c => c.x === 559 && c.y === 68 && c.z === -46), 'the hut interior is standable, just ruled out')
})

test('foreign roof: our own roof-in-progress and natural overhangs do not rule a spot out', () => {
  const at = (p: P): StandBlock => (p.y === 70 ? { name: p.x === 0 ? 'stone' : 'oak_planks', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' })
  assert.equal(underForeignRoof(at, { x: 0, y: 66, z: 0 }, () => false, isNaturalBlock), false, 'stone overhang')
  assert.equal(underForeignRoof(at, { x: 1, y: 66, z: 0 }, () => true, isNaturalBlock), false, 'our plan cell')
  assert.equal(underForeignRoof(at, { x: 1, y: 66, z: 0 }, () => false, isNaturalBlock), true, 'somebody else\'s planks')
})

// ------------------------------------------------------------------ order and batching

test('floor order: with something solid at the edge, every cell has a neighbour to click when its turn comes', () => {
  // a 5x5 floor over a dip (no ground under it), one existing block west of the first row
  const cells: (P & { role: string })[] = []
  for (let x = 0; x < 5; x++) for (let z = 0; z < 5; z++) cells.push({ x, y: 64, z, role: 'floor' })
  const solidNow = (p: P) => p.x === -1 && p.y === 64 && p.z === 2
  const order = orderCells(cells, { floor: { kind: 'block' } }, () => false, solidNow)
  assert.equal(order.length, 25)
  const placed = new Set<string>()
  for (const c of order) {
    const n = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => { const q = { x: c.x + dx!, y: 64, z: c.z + dz! }; return solidNow(q) || placed.has(k(q)) })
    assert.ok(n, `${k(c)} has a neighbour when placed`)
    placed.add(k(c))
  }
  assert.deepEqual([order[0]?.x, order[0]?.z], [0, 2], 'starts next to what stands')
})

test('batching: the nearest ready cell in reach goes next, within the same layer only', () => {
  const todo = [
    { x: 10, y: 64, z: 0, l: 'a' }, // far
    { x: 1, y: 64, z: 0, l: 'a' }, // near but nothing to click yet
    { x: 2, y: 64, z: 0, l: 'a' }, // near and ready
    { x: 0, y: 65, z: 0, l: 'b' } // nearest, but the next layer
  ]
  const bot = { x: 0, y: 64, z: 0 }
  const dist = (c: P) => Math.hypot(c.x - bot.x, c.y - bot.y, c.z - bot.z)
  const ready = (c: { x: number }) => c.x !== 1
  const inReach = (c: P) => dist(c) <= 4
  assert.equal(pickNearby(todo, 0, c => c.l, ready, inReach, dist), 2)
  // nothing in reach: the nearest ready one
  assert.equal(pickNearby(todo, 0, c => c.l, ready, () => false, dist), 2)
  // nothing ready: keep the order
  assert.equal(pickNearby(todo, 0, c => c.l, () => false, inReach, dist), 0)
  // the first cell itself ready and in reach: no reshuffling
  assert.equal(pickNearby(todo, 2, c => c.l, ready, inReach, dist), 2)
})

// ------------------------------------------------------------------ climbing out under attack

test('climbing out: keeps climbing from archers and mobs below, fights a melee mob on top of it', () => {
  assert.equal(keepClimbing({ dist: 8, dy: 0, ranged: true }), true, 'skeleton in the cave')
  assert.equal(keepClimbing({ dist: 1, dy: -3, ranged: false }), true, 'zombie at the foot of the pillar')
  assert.equal(keepClimbing({ dist: 6, dy: 0, ranged: false }), true, 'zombie still walking up')
  assert.equal(keepClimbing({ dist: 1.5, dy: 0, ranged: false }), false, 'zombie hitting us at our level')
  assert.equal(keepClimbing({ dist: 3, dy: 0, ranged: false, creeper: true }), false, 'creeper close by')
  assert.equal(keepClimbing({ dist: 3, dy: -4, ranged: false, creeper: true }), true, 'creeper far below')
})

test('goto: a fight preempting the climb out pauses it (aborts), it is not reported as a failure', async () => {
  const goto = movement().actions!.find(a => a.name === 'goto')!
  // underground: stone everywhere above y=41, the bot at 636 41 29
  const bot: any = {
    entity: { position: new Vec3(636.5, 41, 29.5) },
    blockAt: (p: Vec3) => ({ name: p.y > 42 || p.y < 41 ? 'stone' : 'air', boundingBox: p.y > 42 || p.y < 41 ? 'block' : 'empty', position: p })
  }
  const ctl = new AbortController()
  ctl.abort('preempted')
  const log: any = { info () {}, debug () {}, warn () {}, child () { return log } }
  await assert.rejects(Promise.resolve(goto.run({ bot, signal: ctl.signal, log, agent: {} as any, caller: { kind: 'brain', name: 'behaviors' } }, { x: 689, y: 102, z: 69 })),
    (e: Error) => e.name === 'ActionAbortedError')
})
