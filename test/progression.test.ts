import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextToolUpgrade, heldTier, isCheapStep, SMALL_BATCH, type UpgradeStep } from '../src/skills/progression.ts'
import { planStep, digHazard, standHazard, inStoneLayer, type BlockLook, type P } from '../src/skills/mining.ts'
import { woodBalance, woodUnits, chooseWallMaterial, perMinute, junkToToss } from '../src/skills/efficiency.ts'
import { planWood } from '../src/skills/materials.ts'

const S = 'survival'

test('nextToolUpgrade: no wood -> logs, wood -> wooden pickaxe', () => {
  assert.deepEqual(nextToolUpgrade({}, {}, S)?.do, 'gather')
  assert.equal((nextToolUpgrade({}, {}, S) as any).item, 'logs')
  const s = nextToolUpgrade({ oak_log: 3 }, {}, S)
  assert.equal(s?.do, 'craft')
  assert.equal((s as any).item, 'wooden_pickaxe')
  assert.equal(nextToolUpgrade({}, { trees: false }, S), null)
})

test('nextToolUpgrade: wooden pickaxe -> mine cobblestone for every stone tool, then craft them', () => {
  const s = nextToolUpgrade({ wooden_pickaxe: 1, oak_planks: 8 }, { stone: true }, S, { upTo: 'stone' })!
  assert.equal(s.do, 'gather')
  assert.equal((s as any).item, 'cobblestone')
  assert.equal((s as any).count, 3 + 3 + 1 + 2) // pickaxe, axe, shovel, sword
  // with iron next, 8 more for the furnace
  assert.equal((nextToolUpgrade({ wooden_pickaxe: 1, oak_planks: 8 }, { stone: true }, S) as any).count, 9 + 8)
  const c = nextToolUpgrade({ wooden_pickaxe: 1, oak_planks: 8, cobblestone: 3 }, { stone: true }, S)!
  assert.deepEqual([c.do, (c as any).item], ['craft', 'stone_pickaxe'])
  assert.ok(isCheapStep(c))
  // cobbled deepslate counts as stone
  assert.equal((nextToolUpgrade({ wooden_pickaxe: 1, stick: 4, cobbled_deepslate: 3 }, {}, S) as any).item, 'stone_pickaxe')
})

test('nextToolUpgrade: stone -> iron needs ore, a furnace and fuel', () => {
  const stone = { stone_pickaxe: 1, stone_axe: 1, stone_shovel: 1, stone_sword: 1, oak_planks: 10 }
  assert.equal(nextToolUpgrade(stone, { ironOre: false }, S), null, 'no iron known: stops at stone')
  const p = nextToolUpgrade(stone, { ironOre: false, stone: true }, S, { prospect: true })!
  assert.deepEqual([p.do, (p as any).item], ['gather', 'raw_iron'], 'prospecting digs for iron')
  const g = nextToolUpgrade(stone, { ironOre: true }, S)!
  assert.deepEqual([g.do, (g as any).item, (g as any).count], ['gather', 'raw_iron', 3])
  assert.equal(isCheapStep(g), false)
  const f = nextToolUpgrade({ ...stone, raw_iron: 3, cobblestone: 8 }, {}, S)!
  assert.equal(f.do, 'craft_furnace')
  const m = nextToolUpgrade({ ...stone, raw_iron: 3 }, { stone: true }, S)!
  assert.deepEqual([m.do, (m as any).item, (m as any).count], ['gather', 'cobblestone', 8])
  const coal = nextToolUpgrade({ ...stone, raw_iron: 3, coal: 1 }, { furnace: true }, S)!
  assert.deepEqual([coal.do, (coal as any).input, (coal as any).fuel], ['smelt', 'raw_iron', 'coal'])
  const craft = nextToolUpgrade({ ...stone, iron_ingot: 3 }, {}, S)!
  assert.deepEqual([craft.do, (craft as any).item], ['craft', 'iron_pickaxe'])
})

test('nextToolUpgrade: charcoal from logs when there is no coal', () => {
  const stone = { stone_pickaxe: 1, stone_axe: 1, stone_shovel: 1, stone_sword: 1, furnace: 1 }
  // a few ingots: planks straight in the furnace
  const few = nextToolUpgrade({ ...stone, raw_iron: SMALL_BATCH, oak_planks: 4 }, {}, S)!
  assert.deepEqual([few.do, (few as any).input, (few as any).fuel], ['smelt', 'raw_iron', 'planks'])
  // more: make charcoal from a log first
  const many = nextToolUpgrade({ ...stone, raw_iron: 9, oak_log: 3, oak_planks: 2 }, {}, S)!
  assert.deepEqual([many.do, (many as any).input, (many as any).fuel], ['smelt', 'oak_log', 'planks'])
  assert.equal((many as any).count, 2) // 9 raw iron need 2 charcoal
  // once there is charcoal, smelt the iron with it
  const iron = nextToolUpgrade({ ...stone, raw_iron: 9, charcoal: 2 }, {}, S)!
  assert.deepEqual([iron.do, (iron as any).fuel], ['smelt', 'charcoal'])
  // nothing to burn: get logs
  const logs = nextToolUpgrade({ ...stone, raw_iron: 9 }, {}, S)!
  assert.deepEqual([logs.do, (logs as any).item], ['gather', 'logs'])
})

test('nextToolUpgrade: iron armour after iron tools, diamonds only up to diamond', () => {
  const iron = { iron_pickaxe: 1, iron_axe: 1, iron_shovel: 1, iron_sword: 1 }
  assert.equal(nextToolUpgrade({ ...iron, iron_ingot: 8 }, {}, S), null)
  const a = nextToolUpgrade({ ...iron, iron_ingot: 8 }, {}, S, { armour: true })!
  assert.deepEqual([a.do, (a as any).kind], ['craft', 'armour'])
  assert.equal(nextToolUpgrade({ ...iron, diamond: 3 }, {}, S), null, 'upTo iron by default')
  assert.equal((nextToolUpgrade({ ...iron, diamond: 3 }, {}, S, { upTo: 'diamond' }) as any).item, 'diamond_pickaxe')
  assert.equal((nextToolUpgrade(iron, { diamondOre: true }, S, { upTo: 'diamond' }) as any).item, 'diamond')
})

test('nextToolUpgrade: creative takes tools, spectator does nothing', () => {
  const s = nextToolUpgrade({}, {}, 'creative', { upTo: 'iron' }) as UpgradeStep
  assert.deepEqual([s.do, (s as any).item], ['creative_get', 'iron_pickaxe'])
  assert.equal(nextToolUpgrade({ iron_pickaxe: 1, iron_axe: 1, iron_shovel: 1, iron_sword: 1 }, {}, 'creative'), null)
  assert.equal(nextToolUpgrade({}, {}, 'spectator'), null)
})

test('heldTier', () => {
  assert.equal(heldTier({ wooden_pickaxe: 1, stone_pickaxe: 1 }, 'pickaxe'), 'stone')
  assert.equal(heldTier({ oak_planks: 4 }, 'axe'), 'none')
})

test('planWood: cobblestone without a pickaxe plans the wood for one', () => {
  const p = planWood({ cobblestone: 64 }, {})
  assert.equal(p.mine.cobblestone, 64)
  assert.ok(p.logsToChop >= 2, `logs ${p.logsToChop}`) // 3 planks + 2 sticks (2 planks) + table (4) = 9 planks -> 3 logs
  assert.equal(p.needTable, true)
  assert.equal(planWood({ cobblestone: 64 }, { wooden_pickaxe: 1 }).logsToChop, 0)
})

test('wood accounting: logs broken vs wood kept', () => {
  assert.equal(woodUnits({ oak_log: 2, oak_planks: 3, stick: 4, crafting_table: 1, wooden_axe: 1 }), 8 + 3 + 2 + 4 + 4)
  const b = woodBalance({ spruce_log: 10, dirt: 3 }, {}, { spruce_log: 2, spruce_planks: 28, stick: 4 })
  assert.deepEqual(b, { broken: 10, kept: 9.5, lost: 0.5 })
  // crafting doesn't change the balance
  assert.equal(woodBalance({ oak_log: 4 }, { oak_log: 0 }, { oak_planks: 16 }).lost, 0)
  // logs left behind show up as lost
  assert.equal(woodBalance({ oak_log: 8 }, {}, { oak_log: 5 }).lost, 3)
  assert.equal(perMinute(30, 60_000), 30)
  assert.equal(perMinute(0, 1000), 0)
})

// ------------------------------------------------------------------ strip mine safety

function world (blocks: Record<string, string>, fill = 'stone'): BlockLook {
  return (p: P) => {
    const name = blocks[`${p.x},${p.y},${p.z}`] ?? (p.y >= 64 ? 'air' : fill)
    return { name, solid: !/air|water|lava/.test(name) }
  }
}

test('planStep: staircase digs forward and down, never straight down', () => {
  const at = world({})
  const feet = { x: 0, y: 64, z: 0 }
  const plan = planStep(at, feet, { x: 1, z: 0 }, true)
  assert.ok(typeof plan !== 'string')
  assert.deepEqual(plan.stand, { x: 1, y: 63, z: 0 })
  assert.deepEqual(plan.dig, [{ x: 1, y: 65, z: 0 }, { x: 1, y: 64, z: 0 }, { x: 1, y: 63, z: 0 }])
  assert.ok(plan.dig.every(p => p.x !== feet.x || p.z !== feet.z), 'nothing under our own feet')
})

test('planStep: refuses lava, water, caves below and unloaded blocks', () => {
  const feet = { x: 0, y: 60, z: 0 }
  const dir = { x: 1, z: 0 }
  assert.match(planStep(world({ '2,60,0': 'lava' }), feet, dir, false) as string, /lava/)
  assert.match(planStep(world({ '1,62,0': 'water' }), feet, dir, false) as string, /water/)
  assert.match(planStep(world({ '1,59,0': 'cave_air' }), feet, dir, false) as string, /no floor/)
  assert.match(planStep(world({ '1,58,0': 'air' }), feet, dir, true) as string, /no floor/)
  const unloaded: BlockLook = p => p.x > 1 ? null : { name: 'stone', solid: true }
  assert.match(planStep(unloaded, feet, dir, false) as string, /unloaded|not loaded/)
  assert.match(planStep(world({ '1,62,0': 'gravel' }), feet, dir, false) as string, /gravel above/)
  // a player's block in the way is not ours to dig
  const allowed = (_p: P, name: string) => name !== 'oak_planks'
  assert.match(planStep(world({ '1,61,0': 'oak_planks' }), feet, dir, false, allowed) as string, /not mine/)
})

test('planStep: flat strip widens with safe side blocks only', () => {
  const feet = { x: 0, y: 50, z: 0 }
  const plan = planStep(world({ '1,50,-2': 'lava' }), feet, { x: 1, z: 0 }, false, () => true, true)
  assert.ok(typeof plan !== 'string')
  // the side block touching the lava is skipped, the other three are mined
  assert.ok(!plan.side.some(p => p.y === 50 && p.z === -1), JSON.stringify(plan.side))
  assert.equal(plan.side.length, 3)
})

test('digHazard and standHazard', () => {
  assert.equal(digHazard(world({}), { x: 0, y: 40, z: 0 }), null)
  assert.match(digHazard(world({ '0,40,0': 'water' }), { x: 0, y: 40, z: 0 })!, /water/)
  assert.equal(standHazard(world({}), { x: 0, y: 40, z: 0 }), null)
  assert.match(standHazard(world({ '0,39,0': 'lava' }), { x: 0, y: 40, z: 0 })!, /lava/)
  assert.equal(inStoneLayer(world({}), { x: 0, y: 50, z: 0 }, { x: 1, z: 0 }), true)
  assert.equal(inStoneLayer(world({ '1,51,0': 'dirt' }), { x: 0, y: 50, z: 0 }, { x: 1, z: 0 }), false)
})

// ------------------------------------------------------------------ material choice

test('chooseWallMaterial', () => {
  const base = { need: 194, planks: 0, cobble: 0, trees: 20, stone: true, pickaxe: true }
  assert.equal(chooseWallMaterial({ ...base, planks: 200 }), 'planks', 'already have planks')
  assert.equal(chooseWallMaterial({ ...base, cobble: 194 }), 'cobblestone', 'already have cobble')
  assert.equal(chooseWallMaterial({ ...base, trees: 2 }), 'cobblestone', 'few trees')
  assert.equal(chooseWallMaterial({ ...base, pickaxe: false }), 'planks', 'no pickaxe')
  assert.equal(chooseWallMaterial({ ...base, stone: false, trees: 2 }), 'planks', 'no stone')
})

test('junkToToss: frees slots with junk only, keeps a reserve and the job\'s items', () => {
  const stacks = [
    { name: 'oak_log', count: 30 }, { name: 'rotten_flesh', count: 3 }, { name: 'oak_sapling', count: 5 },
    { name: 'oak_sapling', count: 12 }, { name: 'dirt', count: 64 }, { name: 'wheat_seeds', count: 10 }
  ]
  assert.deepEqual(junkToToss(stacks, 1), [{ name: 'rotten_flesh', count: 3 }])
  // saplings: 17 held, 8 kept, so only the 5-stack can go; dirt (64 kept) and seeds (10 < 16) stay
  assert.deepEqual(junkToToss(stacks, 3), [{ name: 'rotten_flesh', count: 3 }, { name: 'oak_sapling', count: 5 }])
  assert.deepEqual(junkToToss(stacks, 2, new Set(['rotten_flesh'])), [{ name: 'oak_sapling', count: 5 }])
  assert.deepEqual(junkToToss(stacks, 0), [])
})
