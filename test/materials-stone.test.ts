// Stone-family planning in gather_materials: slabs, stairs, walls, stone bricks, smooth stone.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planWood, stoneRecipe, stoneChain, woodRecipe } from '../src/skills/materials.ts'

test('stoneRecipe: vanilla stone-family crafts only', () => {
  assert.deepEqual(stoneRecipe('cobblestone_wall'), { cobble: 6, out: 6, table: true })
  assert.deepEqual(stoneRecipe('cobblestone_slab'), { cobble: 3, out: 6, table: true })
  assert.deepEqual(stoneRecipe('cobblestone_stairs'), { cobble: 6, out: 4, table: true })
  assert.deepEqual(stoneRecipe('stone_slab'), { stone: 3, out: 6, table: true })
  assert.deepEqual(stoneRecipe('stone_brick_wall'), { bricks: 6, out: 6, table: true })
  assert.deepEqual(stoneRecipe('smooth_stone_slab'), { smooth: 3, out: 6, table: true })
  assert.deepEqual(stoneRecipe('stone_bricks'), { stone: 4, out: 4, table: false })
  assert.equal(stoneRecipe('stone_wall'), null, 'no such block')
  assert.equal(stoneRecipe('smooth_stone_stairs'), null)
  assert.equal(stoneRecipe('oak_slab'), null)
  assert.equal(woodRecipe('cobblestone_wall'), null)
})

test('stoneChain: stone bricks come from smelted cobblestone', () => {
  // 8 stone brick stairs = 2 crafts = 12 bricks = 3 brick crafts = 12 stone = 12 cobblestone smelted
  const c = stoneChain({ stone_brick_stairs: 8 }, {})
  assert.deepEqual(c, { cobble: 12, smelt: { stone: 12 }, brickCrafts: 3 })
  // smooth stone slabs: stone smelted twice
  assert.deepEqual(stoneChain({ smooth_stone_slab: 6 }, {}), { cobble: 3, smelt: { stone: 3, smooth_stone: 3 }, brickCrafts: 0 })
  // what is held counts: stone in the bag is not smelted again
  assert.deepEqual(stoneChain({ stone_bricks: 8 }, { stone: 8 }), { cobble: 0, smelt: {}, brickCrafts: 2 })
  assert.deepEqual(stoneChain({ cobblestone_wall: 12 }, { cobblestone_wall: 6 }), { cobble: 6, smelt: {}, brickCrafts: 0 })
})

test('planWood: walls, slabs and stone bricks are no longer unsupported', () => {
  const p = planWood({ cobblestone_wall: 12, cobblestone_slab: 6, stone_bricks: 4 }, { wooden_pickaxe: 1, crafting_table: 1 })
  assert.deepEqual(p.unsupported, [])
  // 12 walls = 12 cobble, 6 slabs = 3 cobble, 4 bricks = 4 stone = 4 cobble smelted
  assert.equal(p.mine.cobblestone, 19)
  assert.deepEqual(p.stoneSmelt, { stone: 4 })
  assert.equal(p.brickCrafts, 1)
  assert.equal(p.needFurnace, true, 'smelting stone needs a furnace')
  assert.ok(p.fuelPlanks >= 3)
  assert.equal(p.makePickaxe, false)
  // mining stone gives cobblestone: plain "stone" is smelted, not mined
  const s = planWood({ stone: 10 }, { stone_pickaxe: 1, furnace: 1 })
  assert.equal(s.mine.cobblestone, 10)
  assert.deepEqual(s.stoneSmelt, { stone: 10 })
  assert.equal(s.needFurnace, false)
})
