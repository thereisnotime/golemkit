import { test } from 'node:test'
import assert from 'node:assert/strict'
import { craftsNeeded, maxCrafts, missingFor, fuelValue, pickFuel, fuelNeeded } from '../src/skills/crafting.ts'
import { selectDeposits, isToolOrArmor, tally, fmtTally } from '../src/skills/containers.ts'
import { isMature, seedFor, SEEDS } from '../src/skills/farming.ts'
import { woodType, saplingFor, isNaturalLeaves } from '../src/skills/woodcutting.ts'
import { isReplaceable, isInteractive } from '../src/skills/world.ts'
import { extendedSkills, standardSkills } from '../src/skills/index.ts'

test('crafts needed rounds up per recipe output', () => {
  assert.equal(craftsNeeded(4, 4), 1)
  assert.equal(craftsNeeded(5, 4), 2)
  assert.equal(craftsNeeded(1, 1), 1)
})

test('max crafts is limited by the scarcest input', () => {
  const inv: Record<number, number> = { 1: 10, 2: 3 }
  const have = (id: number) => inv[id] ?? 0
  // 2x item 1 + 1x item 2 -> 1 result
  assert.equal(maxCrafts([{ id: 1, count: -2 }, { id: 2, count: -1 }, { id: 9, count: 1 }], have), 3)
  assert.equal(maxCrafts([{ id: 5, count: -1 }], have), 0)
  assert.deepEqual(missingFor([{ id: 1, count: -12 }, { id: 2, count: -1 }], have), [{ id: 1, need: 2 }])
})

test('fuel choice prefers coal and never burns the input', () => {
  assert.equal(pickFuel(['oak_planks', 'coal', 'stick']), 'coal')
  assert.equal(pickFuel(['stick', 'oak_planks']), 'oak_planks')
  assert.equal(pickFuel(['oak_log'], 'oak_log'), null)
  assert.equal(pickFuel(['modded#900', 'dirt']), null)
  assert.equal(fuelValue('spruce_log'), 1.5)
  assert.equal(fuelValue('stripped_oak_log'), 1.5)
  assert.equal(fuelNeeded('coal', 9), 2)
  assert.equal(fuelNeeded('oak_planks', 3), 2)
})

test('deposit all keeps tools, armour, food and the keep list', () => {
  const items = [
    { name: 'cobblestone', count: 64 }, { name: 'iron_pickaxe', count: 1 }, { name: 'bread', count: 5 },
    { name: 'iron_helmet', count: 1 }, { name: 'torch', count: 10 }, { name: 'modded#1234', count: 3 }
  ]
  const isFood = (n: string) => n === 'bread'
  const picked = selectDeposits(items, { item: 'all', keep: ['torch'], isFood }).map(i => i.name)
  assert.deepEqual(picked, ['cobblestone', 'modded#1234'])
  assert.deepEqual(selectDeposits(items, { item: 'bread', isFood }).map(i => i.name), ['bread'])
  assert.equal(selectDeposits(items, { item: 'all', keepEssentials: false }).length, 6)
  assert.ok(isToolOrArmor('netherite_sword'))
  assert.ok(!isToolOrArmor('stick'))
  assert.equal(fmtTally(tally([{ name: 'a', count: 2 }, { name: 'a', count: 3 }])), '5x a')
  assert.equal(fmtTally({}), 'empty')
})

test('crop maturity uses the age property', () => {
  assert.ok(isMature('wheat', 7))
  assert.ok(!isMature('wheat', 6))
  assert.ok(isMature('beetroots', 3))
  assert.ok(!isMature('oak_log', 7))
  assert.ok(!isMature('carrots', undefined))
  assert.equal(seedFor('potatoes'), 'potato')
  assert.equal(SEEDS.wheat_seeds, 'wheat')
})

test('wood types and saplings', () => {
  assert.equal(woodType('oak_log'), 'oak')
  assert.equal(woodType('dark_oak_log'), 'dark_oak')
  assert.equal(woodType('crimson_stem'), 'crimson')
  assert.equal(woodType('stripped_birch_log'), null)
  assert.equal(woodType('mushroom_stem'), null)
  assert.equal(woodType('oak_planks'), null)
  assert.equal(woodType('modded_block'), null)
  assert.equal(saplingFor('mangrove'), 'mangrove_propagule')
  assert.equal(saplingFor('cherry'), 'cherry_sapling')
  assert.equal(saplingFor('warped'), null)
  assert.ok(isNaturalLeaves('oak_leaves', { persistent: false }))
  assert.ok(!isNaturalLeaves('oak_leaves', { persistent: true }))
  assert.ok(!isNaturalLeaves('stone', {}))
})

test('placement helpers', () => {
  assert.ok(isReplaceable('air'))
  assert.ok(isReplaceable('short_grass'))
  assert.ok(!isReplaceable('stone'))
  assert.ok(isInteractive('chest'))
  assert.ok(isInteractive('oak_door'))
  assert.ok(!isInteractive('cobblestone'))
})

test('extended skills have unique, described actions', () => {
  const names = new Set<string>()
  for (const s of [...standardSkills(), ...extendedSkills()]) {
    for (const a of s.actions ?? []) {
      assert.ok(!names.has(a.name), `duplicate action ${a.name}`)
      names.add(a.name)
      assert.ok(a.description.length > 0, `${a.name} needs a description`)
    }
  }
  for (const n of ['craft', 'smelt', 'deposit', 'withdraw', 'list_container', 'harvest', 'plant', 'till', 'chop_tree', 'place_block', 'pickup_items']) {
    assert.ok(names.has(n), `missing ${n}`)
  }
})

test('rankRecipes: the stone variant it holds, not the first listed (cobbled_deepslate)', async () => {
  const { rankRecipes } = await import('../src/skills/crafting.ts')
  // stone_sword in 1.21.1: cobbled_deepslate (9), blackstone (1228), cobblestone (35), each with a stick (848)
  const variants = [9, 1228, 35].map(id => ({ id, delta: [{ id, count: -2 }, { id: 848, count: -1 }, { id: 823, count: 1 }] }))
  const inv = (c: Record<number, number>) => (id: number) => c[id] ?? 0
  assert.equal(rankRecipes(variants, inv({ 35: 5, 848: 2 }))[0]!.id, 35, 'it can make the cobblestone one')
  assert.equal(rankRecipes(variants, inv({ 35: 1, 848: 2 }))[0]!.id, 35, 'one short of cobblestone beats two short of deepslate')
  assert.equal(rankRecipes(variants, inv({ 1228: 2, 35: 1, 848: 1 }))[0]!.id, 1228, 'blackstone when that is what it holds')
  assert.equal(rankRecipes(variants, inv({}))[0]!.id, 9, 'nothing held: the order it came in')
})

test('remakeable: a worn tool it can make again from what it carries', async () => {
  const { remakeable } = await import('../src/skills/toolkit.ts')
  assert.deepEqual(remakeable({ cobblestone: 2, stick: 1 }, 'stone_sword'), { ok: true, sticks: 0 })
  assert.deepEqual(remakeable({ cobbled_deepslate: 3, oak_planks: 2 }, 'stone_pickaxe'), { ok: true, sticks: 2 })
  assert.equal(remakeable({ stick: 4 }, 'stone_sword').ok, false, 'no stone of any kind')
  assert.equal(remakeable({ iron_ingot: 1, stick: 2 }, 'iron_sword').ok, false)
  assert.equal(remakeable({ cobblestone: 9 }, 'golden_sword').ok, false)
})
