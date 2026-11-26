// Safe mining: readiness gate, depth, caves, torches, underground retreat (src/skills/minePlan.ts),
// and how progression and the staircase planner use it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  miningSettings, miningReadiness, notReadyText, shieldWouldDo, surfaceAbove, targetDepth, depthAllowed,
  caveHazard, torchDue, torchCrafts, isUnderground, undergroundRetreat, MINING_DEFAULTS, type BlockLook, type P
} from '../src/skills/minePlan.ts'
import { planStep } from '../src/skills/mining.ts'
import { nextToolUpgrade } from '../src/skills/progression.ts'

const S = 'survival'
const D = MINING_DEFAULTS

function world (blocks: Record<string, string>, surface = 64, sky?: (p: P) => number | undefined): BlockLook {
  return (p: P) => {
    const name = blocks[`${p.x},${p.y},${p.z}`] ?? (p.y >= surface ? 'air' : 'stone')
    const s = sky?.(p)
    return { name, solid: !/air|water|lava|torch/.test(name), ...(s !== undefined ? { sky: s } : {}) }
  }
}

test('miningSettings: defaults, overrides, bad values ignored', () => {
  assert.deepEqual(miningSettings(undefined), D)
  const s = miningSettings({ gear: 'shield_or_armour', safeDepth: 4, minFood: 'lots', torches: false, gear2: 1 })
  assert.equal(s.gear, 'shield_or_armour')
  assert.equal(s.safeDepth, 4)
  assert.equal(s.minFood, D.minFood, 'a string is not a number')
  assert.equal(s.torches, false)
  assert.equal(miningSettings({ gear: 'diamond' }).gear, 'none')
})

test('miningReadiness: weapon, food and gear, with a clear reason', () => {
  const pax = { weapon: false, food: 0, armour: 0, shield: false }
  const r = miningReadiness(pax, miningSettings({ gear: 'shield_or_armour' }))
  assert.equal(r.ready, false)
  assert.deepEqual(r.missing, ['no weapon', 'no food', 'no shield or armour'])
  assert.equal(r.need, 'weapon')
  assert.equal(notReadyText(r), 'not ready to mine: no weapon, no food, no shield or armour')
  // Pax live: a stone sword and 29 cooked beef, no armour. Ready by default, not with gear asked for.
  const live = { weapon: true, food: 29, armour: 0, shield: false }
  assert.equal(miningReadiness(live, D).ready, true)
  const g = miningReadiness(live, miningSettings({ gear: 'shield_or_armour' }))
  assert.deepEqual([g.ready, g.need], [false, 'gear'])
  assert.equal(miningReadiness({ ...live, shield: true }, miningSettings({ gear: 'shield_or_armour' })).ready, true)
  assert.equal(miningReadiness({ ...live, shield: true }, miningSettings({ gear: 'armour' })).ready, false, 'a shield is not armour')
  assert.deepEqual(miningReadiness({ ...live, armour: 3 }, miningSettings({ gear: 'armour', minArmour: 6 })).missing, ['armour 3/6'])
  assert.deepEqual(miningReadiness({ ...live, food: 1 }, D).missing, ['food 1/3'])
  assert.equal(miningReadiness(pax, miningSettings({ safe: false })).ready, true, 'safe mining off: always ready')
})

test('shieldWouldDo: only when shield_or_armour is the gap', () => {
  const s = miningSettings({ gear: 'shield_or_armour' })
  assert.equal(shieldWouldDo({ weapon: true, food: 5, armour: 0, shield: false }, s), true)
  assert.equal(shieldWouldDo({ weapon: true, food: 5, armour: 0, shield: true }, s), false)
  assert.equal(shieldWouldDo({ weapon: true, food: 5, armour: 0, shield: false }, D), false)
})

test('surfaceAbove and targetDepth: open sky, a roof, leaves ignored, a cave far below', () => {
  const at = world({ '0,70,0': 'oak_leaves', '0,71,0': 'oak_leaves' })
  assert.equal(surfaceAbove(at, { x: 0, y: 64, z: 0 }), 64, 'standing on the surface, leaves over it')
  assert.equal(surfaceAbove(at, { x: 0, y: 10, z: 0 }, 60), 64, 'ore at y 10 under 54 blocks of stone')
  assert.equal(surfaceAbove(at, { x: 0, y: 10, z: 0 }, 9), 20, 'a short scan: covered by at least 9')
  // the live case: Pax at the surface (~70), iron ore in a cave at y 10
  const depth = targetDepth(70, { x: 592, y: 10, z: -60 }, 70)
  assert.equal(depth, 60)
  assert.equal(depthAllowed(depth, false, D), false)
  assert.equal(depthAllowed(depth, true, D), true)
  assert.equal(depthAllowed(5, false, D), true, 'shallow ore is fine without readiness')
  assert.equal(depthAllowed(depth, false, miningSettings({ safe: false })), true)
  // ore up a cliff is not deep
  assert.equal(targetDepth(64, { x: 0, y: 75, z: 0 }, 76), 1)
})

test('caveHazard: air pockets below the surface stop the dig, the tunnel and the open sky do not', () => {
  const stand = { x: 1, y: 50, z: 0 }
  const dig = [{ x: 1, y: 51, z: 0 }, { x: 1, y: 50, z: 0 }]
  const open = new Set(['0,50,0', '0,51,0'])
  assert.equal(caveHazard(world({}), dig, stand, open, 63), null)
  assert.match(caveHazard(world({ '2,50,0': 'air' }), dig, stand, open, 63)!, /cave next to 1 50 0/)
  assert.match(caveHazard(world({ '1,48,0': 'cave_air' }), dig, stand, open, 63)!, /cave under/)
  assert.equal(caveHazard(world({ '2,50,0': 'air' }), dig, stand, new Set([...open, '2,50,0']), 63), null, 'our own tunnel')
  // a ravine wall: the air has full sky light
  const ravine = world({ '2,50,0': 'air' }, 64, p => p.x === 2 ? 15 : 0)
  assert.equal(caveHazard(ravine, dig, stand, open, 63), null)
  // at the surface the staircase starts in the open
  assert.equal(caveHazard(world({}), [{ x: 1, y: 64, z: 0 }], { x: 1, y: 63, z: 0 }, new Set(), 63), null)
})

test('planStep with cave checks: turns away from a cave the plain planner would open', () => {
  const feet = { x: 0, y: 50, z: 0 }
  const dir = { x: 1, z: 0 }
  const at = world({ '1,50,1': 'air' })
  assert.ok(typeof planStep(at, feet, dir, false) !== 'string', 'without the check it digs on')
  assert.match(planStep(at, feet, dir, false, () => true, false, { belowY: 63, tunnel: new Set() }) as string, /cave/)
  assert.ok(typeof planStep(at, feet, dir, false, () => true, false, { belowY: 63, tunnel: new Set(['1,50,1']) }) !== 'string')
  // wide strip: a side block next to a pocket is left alone
  const side = world({ '1,50,2': 'air' })
  const plan = planStep(side, feet, dir, false, () => true, true, { belowY: 63, tunnel: new Set() })
  assert.ok(typeof plan !== 'string')
  assert.ok(!plan.side.some(p => p.z === 1 && p.y === 50), 'the block between the tunnel and the pocket stays')
})

test('torches: every few steps unless lit, crafted from coal or charcoal and sticks', () => {
  assert.equal(torchDue(7, D), false)
  assert.equal(torchDue(8, D), true)
  assert.equal(torchDue(8, D, 12), false, 'already lit')
  assert.equal(torchDue(20, { torches: false, torchEvery: 8 }), false)
  assert.equal(torchCrafts({}), 0)
  assert.equal(torchCrafts({ coal: 3, stick: 1 }), 1)
  assert.equal(torchCrafts({ charcoal: 2, oak_planks: 2 }), 2, 'two planks make four sticks')
  assert.equal(torchCrafts({ stick: 5 }), 0)
})

test('undergroundRetreat: low health or a crowd underground, never on the surface', () => {
  const pax = miningSettings({ retreatBelow: 12 })
  assert.match(undergroundRetreat({ underground: true, health: 8, hostiles: 1 }, pax)!, /health 8/)
  assert.match(undergroundRetreat({ underground: true, health: 20, hostiles: 2 }, D)!, /2 hostiles/)
  assert.equal(undergroundRetreat({ underground: false, health: 4, hostiles: 3 }, D), null)
  // the live MineTest run: drowned at y 33 after collecting iron in a flooded cave
  assert.match(undergroundRetreat({ underground: true, health: 18, hostiles: 0, air: 4 }, D)!, /air/)
  assert.equal(undergroundRetreat({ underground: true, health: 18, hostiles: 0, air: 20 }, D), null)
  assert.equal(undergroundRetreat({ underground: true, health: 16, hostiles: 1 }, D), null)
  assert.equal(undergroundRetreat({ underground: true, health: 4, hostiles: 3 }, miningSettings({ safe: false })), null)
  assert.equal(undergroundRetreat({ underground: true, health: 4, hostiles: 3 }, miningSettings({ retreatBelow: 0, retreatHostiles: 0 })), null)
  assert.equal(isUnderground(10, 0), true)
  assert.equal(isUnderground(1, 0), false, 'a house roof')
  assert.equal(isUnderground(10, 15), false, 'under an overhang in daylight')
})

test('nextToolUpgrade with safe mining: no prospecting or deep ore when not ready, a shield first', () => {
  const stone = { stone_pickaxe: 1, stone_axe: 1, stone_shovel: 1, stone_sword: 1, oak_planks: 10 }
  // ready: prospects as before
  const p = nextToolUpgrade(stone, { ironOre: false, stone: true }, S, { prospect: true, mining: { ready: true } })!
  assert.deepEqual([p.do, (p as any).item], ['gather', 'raw_iron'])
  // not ready: no staircase hunt, and deep ore (sensed as ironOreDeep) is no step either
  assert.equal(nextToolUpgrade(stone, { ironOre: false, ironOreDeep: true, stone: true }, S, { prospect: true, mining: { ready: false } }), null)
  // shallow ore is fine
  const g = nextToolUpgrade(stone, { ironOre: true, stone: true }, S, { prospect: true, mining: { ready: false } })!
  assert.deepEqual([g.do, (g as any).item], ['gather', 'raw_iron'])
  // shield_or_armour: the first ingot becomes a shield before the iron pickaxe
  const sh = nextToolUpgrade({ ...stone, iron_ingot: 1 }, {}, S, { mining: { ready: false, shieldFirst: true } })!
  assert.deepEqual([sh.do, (sh as any).item, (sh as any).kind], ['craft', 'shield', 'item'])
  const pick = nextToolUpgrade({ ...stone, iron_ingot: 3, shield: 1 }, {}, S, { mining: { ready: true, shieldFirst: false } })!
  assert.equal((pick as any).item, 'iron_pickaxe')
  // no planks for the shield: on to the tools
  const noWood = nextToolUpgrade({ stone_pickaxe: 1, stone_axe: 1, stone_shovel: 1, stone_sword: 1, iron_ingot: 3 }, {}, S, { mining: { ready: false, shieldFirst: true } })!
  assert.equal((noWood as any).item, 'iron_pickaxe')
})
