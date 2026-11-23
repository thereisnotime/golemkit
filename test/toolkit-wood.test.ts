import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { ensureSticks, plankTopUp, usablePlankUnits, plankUnits, craftableTiers, woodSummary } from '../src/skills/toolkit.ts'
import { nextToolUpgrade } from '../src/skills/progression.ts'

const require = createRequire(import.meta.url)
const registry = require('minecraft-data')('1.21.1')
const Recipe = require('prismarine-recipe')(registry).Recipe

/** Inventory and 2x2 crafting with the real recipes (one plank kind per recipe, as mineflayer has them). */
function craftingBot (inv: Record<string, number>) {
  const items = () => Object.entries(inv).filter(([, c]) => c > 0).map(([name, count]) => ({ name, count, type: registry.itemsByName[name].id }))
  const count = (id: number) => items().filter(i => i.type === id).reduce((n, i) => n + i.count, 0)
  const recipes = (id: number, n: number) => Recipe.find(id, null).filter((r: any) => !r.requiresTable &&
    r.delta.every((d: any) => count(d.id) + d.count * Math.ceil((n ?? 1) / r.result.count) >= 0))
  return {
    registry,
    inventory: { items, count, slots: [], emptySlotCount: () => 20, firstEmptyInventorySlot: () => 20, selectedItem: null },
    entities: {},
    entity: { position: { distanceTo: () => 0 } },
    findBlock: () => null,
    recipesAll: (id: number) => Recipe.find(id, null).filter((r: any) => !r.requiresTable),
    recipesFor: (id: number, _m: unknown, n: number, table: unknown) => table ? [] : recipes(id, n),
    craft: async (r: any) => { for (const d of r.delta) { const nm = registry.items[d.id].name; inv[nm] = (inv[nm] ?? 0) + d.count } }
  } as any
}

test('usablePlankUnits: lone planks of different kinds make nothing', () => {
  assert.equal(plankUnits({ oak_planks: 1, spruce_planks: 1 }), 2)
  assert.equal(usablePlankUnits({ oak_planks: 1, spruce_planks: 1 }), 0)
  assert.equal(usablePlankUnits({ oak_planks: 1, spruce_planks: 1, spruce_log: 2 }), 9) // the spruce plank joins the logs
  assert.equal(usablePlankUnits({ oak_planks: 3 }), 3)
  // Pax live: 1 oak + 1 spruce plank, no sticks and no logs: no stone tool, wood is needed
  assert.deepEqual(craftableTiers({ oak_planks: 1, spruce_planks: 1, cobblestone: 18 }, 'pickaxe'), [])
  const s = nextToolUpgrade({ wooden_pickaxe: 1, oak_planks: 1, spruce_planks: 1, cobblestone: 18 }, { craftingTable: true }, 'survival')
  assert.deepEqual([s?.do, (s as any)?.item], ['gather', 'logs'])
})

test('plankTopUp: tops up one kind, the one with planks already', () => {
  assert.equal(plankTopUp({ oak_planks: 4 }, 2), 'enough')
  assert.deepEqual(plankTopUp({ oak_planks: 1, spruce_planks: 1, spruce_log: 8 }, 2), { log: 'spruce_log', planks: 'spruce_planks', runs: 1 })
  // spruce gets to 6 at most, oak gets to 8
  assert.deepEqual(plankTopUp({ oak_log: 3, spruce_log: 1, spruce_planks: 2 }, 7), { log: 'oak_log', planks: 'oak_planks', runs: 2 })
  assert.equal(plankTopUp({ oak_planks: 1 }, 2), null)
  assert.equal(plankTopUp({ blue_archwood_log: 2 }, 2, p => p !== 'blue_archwood_planks'), null)
  assert.equal(woodSummary({ oak_planks: 1, spruce_planks: 1 }), '1 oak_planks, 1 spruce_planks, no logs')
})

test('ensureSticks: 1 oak + 1 spruce plank and spruce logs still make sticks (seen live on Pax)', async () => {
  const inv: Record<string, number> = { spruce_log: 8, spruce_planks: 1, oak_planks: 1, cobblestone: 18 }
  assert.equal(await ensureSticks(craftingBot(inv), new AbortController().signal, 2), true)
  assert.ok(inv.stick! >= 2)
  assert.equal(inv.spruce_log, 7)
  assert.equal(inv.oak_planks, 1)
})
