import type { Bot } from 'mineflayer'
import type { Block } from 'prismarine-block'
import { defineSkill, defineAction, z, ok, fail, sleep, checkAborted, fmtPos, itemName, type ActionResult } from '../core/index.ts'
import { reachBlock, placeAt, findFreeSpot, findItem, countItem } from './world.ts'

const TABLE_SEARCH = 16
const FURNACE_SEARCH = 32
const SETTLE_MS = 150

interface DeltaEntry { id: number, count: number }

/** How many times a recipe must run to make `want` items when one run makes `perCraft`. */
export function craftsNeeded (want: number, perCraft: number): number {
  return Math.ceil(want / Math.max(1, perCraft))
}

/** How many times a recipe can run with what we have. `delta` uses negative counts for inputs. */
export function maxCrafts (delta: DeltaEntry[], have: (id: number) => number): number {
  let n = Infinity
  for (const d of delta) {
    if (d.count >= 0) continue
    n = Math.min(n, Math.floor(have(d.id) / -d.count))
  }
  return n === Infinity ? 0 : n
}

/** Inputs we lack for one run of a recipe, as {id, need} pairs. */
export function missingFor (delta: DeltaEntry[], have: (id: number) => number): { id: number, need: number }[] {
  return delta.filter(d => d.count < 0 && have(d.id) < -d.count).map(d => ({ id: d.id, need: -d.count - have(d.id) }))
}

/** Items smelted per fuel item (vanilla burn times / 200 ticks). */
export function fuelValue (name: string): number {
  if (name === 'coal' || name === 'charcoal') return 8
  if (name === 'coal_block') return 80
  if (name === 'blaze_rod') return 12
  if (name === 'dried_kelp_block') return 20
  if (/_planks$/.test(name) || /(^|_)(log|wood|stem|hyphae)$/.test(name)) return 1.5
  if (name === 'stick' || /_sapling$/.test(name)) return 0.5
  if (name === 'bamboo' || name === 'scaffolding') return 0.25
  return 0
}

const FUEL_ORDER = ['coal', 'charcoal', 'coal_block', 'blaze_rod', 'dried_kelp_block']

/** Picks a fuel from the inventory names: coal-like first, then wood, then sticks. Never the input itself. */
export function pickFuel (names: string[], input?: string): string | null {
  const candidates = [...new Set(names)].filter(n => n !== input && fuelValue(n) > 0 && !n.startsWith('modded#'))
  candidates.sort((a, b) => {
    const ia = FUEL_ORDER.indexOf(a), ib = FUEL_ORDER.indexOf(b)
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
    return fuelValue(b) - fuelValue(a)
  })
  return candidates[0] ?? null
}

export function fuelNeeded (fuel: string, items: number): number {
  const v = fuelValue(fuel)
  return v > 0 ? Math.ceil(items / v) : 0
}

function names (bot: Bot, ids: { id: number, need: number }[]): string {
  return ids.map(m => `${m.need} ${bot.registry.items[m.id]?.name ?? `#${m.id}`}`).join(', ')
}

/** Nearest crafting table, or one we place (from inventory, or crafted from planks). */
async function getTable (bot: Bot, signal: AbortSignal): Promise<{ table: Block, placed: boolean } | string> {
  const tableId = bot.registry.blocksByName.crafting_table.id
  const near = bot.findBlock({ matching: tableId, maxDistance: TABLE_SEARCH })
  if (near) return { table: near, placed: false }
  if (!findItem(bot, 'crafting_table')) {
    const r = bot.recipesFor(bot.registry.itemsByName.crafting_table.id, null, 1, null)[0]
    if (!r) return 'needs a crafting table and there is none nearby (and no planks to make one)'
    await bot.craft(r, 1)
    await sleep(SETTLE_MS, signal)
  }
  checkAborted(signal)
  const spot = findFreeSpot(bot)
  if (!spot) return 'no room to put down a crafting table'
  await placeAt(bot, 'crafting_table', spot, signal)
  const table = bot.blockAt(spot)
  if (table?.name !== 'crafting_table') return 'could not place a crafting table'
  return { table, placed: true }
}

const craft = defineAction({
  name: 'craft',
  description: 'Craft an item from what is in the inventory. Uses a crafting table within 16 blocks when the recipe needs one, or puts one down (from the inventory, or made from planks).',
  params: z.object({
    item: z.string().describe('item to make, e.g. stick, crafting_table, stone_pickaxe'),
    count: z.number().int().min(1).max(256).default(1).describe('how many items to end up with (not recipe runs)')
  }),
  async run ({ bot, signal }, { item, count }): Promise<ActionResult> {
    const def = bot.registry.itemsByName[item]
    if (!def) return fail(`unknown item ${item}`)
    const have = (id: number) => bot.inventory.count(id, null)
    const all = bot.recipesAll(def.id, null, true)
    if (!all.length) return fail(`I don't know a recipe for ${item}`)

    let table: Block | null = null
    let placed = false
    let recipes = bot.recipesFor(def.id, null, 1, null)
    if (!recipes.length) {
      recipes = bot.recipesFor(def.id, null, 1, true)
      if (!recipes.length) {
        const total = (m: { need: number }[]) => m.reduce((n, x) => n + x.need, 0)
        const best = all.map(r => missingFor(r.delta, have)).sort((a, b) => total(a) - total(b))[0]
        return fail(`missing ingredients for ${item}: need ${names(bot, best)}`)
      }
      const got = await getTable(bot, signal)
      if (typeof got === 'string') return fail(got)
      table = got.table
      placed = got.placed
      await reachBlock(bot, table.position, signal)
    }

    const before = countItem(bot, item)
    let runs = craftsNeeded(count, recipes[0].result.count)
    while (runs > 0) {
      checkAborted(signal)
      // re-check every run: a recipe may use up one plank type while another still works
      const pool = table ? bot.recipesFor(def.id, null, 1, table) : bot.recipesFor(def.id, null, 1, null)
      const recipe = pool.map(r => ({ r, n: maxCrafts(r.delta, have) })).sort((a, b) => b.n - a.n)[0]
      if (!recipe || recipe.n <= 0) break
      // one run per call: batching runs races the server's slot updates and the inventory
      // model drifts (seen live on NeoForge), so craft once and let the slots settle
      await bot.craft(recipe.r, 1, table ?? undefined)
      await sleep(SETTLE_MS, signal)
      runs--
    }
    const made = countItem(bot, item) - before
    const note = placed && table ? ` (put a crafting table at ${fmtPos(table.position)})` : ''
    if (made <= 0) return fail(`could not craft ${item}${note}`)
    return made >= count ? ok(`crafted ${made} ${item}${note}`) : ok(`crafted ${made} of ${count} ${item}, ran out of ingredients${note}`)
  }
})

const smelt = defineAction({
  name: 'smelt',
  description: 'Smelt items in a furnace within 32 blocks (or one placed from the inventory), add fuel, wait and take the results.',
  params: z.object({
    item: z.string().describe('item to smelt, e.g. raw_iron, sand, oak_log'),
    count: z.number().int().min(1).max(64).default(1),
    fuel: z.string().optional().describe('fuel item; default the best one in the inventory (coal, charcoal, planks, logs...)')
  }),
  async run ({ bot, signal, log }, { item, count, fuel }): Promise<ActionResult> {
    const input = findItem(bot, item)
    if (!input) return fail(`no ${item} to smelt`)
    count = Math.min(count, countItem(bot, item))

    let furnaceBlock = bot.findBlock({ matching: bot.registry.blocksByName.furnace.id, maxDistance: FURNACE_SEARCH })
    if (!furnaceBlock) {
      if (!findItem(bot, 'furnace')) return fail('no furnace nearby and none in the inventory')
      const spot = findFreeSpot(bot)
      if (!spot) return fail('no room to put down a furnace')
      await placeAt(bot, 'furnace', spot, signal)
      furnaceBlock = bot.blockAt(spot)
      if (furnaceBlock?.name !== 'furnace') return fail('could not place a furnace')
    }
    await reachBlock(bot, furnaceBlock.position, signal)

    const furnace = await bot.openFurnace(furnaceBlock)
    try {
      const busy = furnace.inputItem()
      if (busy && itemName(busy) !== item) return fail(`the furnace is busy smelting ${itemName(busy)}`)
      const out = furnace.outputItem()
      if (out) await furnace.takeOutput()

      // fuel: count what's already burning/loaded, add the rest
      const loaded = furnace.fuelItem()
      let capacity = loaded ? fuelValue(itemName(loaded)) * loaded.count : 0
      if (capacity < count) {
        const fuelName = fuel ?? pickFuel(bot.inventory.items().map(itemName), item)
        if (!fuelName) return fail('no fuel (coal, charcoal, planks or logs)')
        if (loaded && itemName(loaded) !== fuelName) return fail(`the furnace already has ${itemName(loaded)} as fuel`)
        const need = Math.min(fuelNeeded(fuelName, count - capacity), countItem(bot, fuelName))
        if (need <= 0) return fail(`no ${fuelName} for fuel`)
        await furnace.putFuel(bot.registry.itemsByName[fuelName].id, null, need)
        capacity += fuelValue(fuelName) * need
      }
      const toSmelt = Math.min(count, Math.floor(capacity) || count)
      await furnace.putInput(input.type, null, toSmelt)

      let taken = 0
      let idle = 0
      const deadline = Date.now() + toSmelt * 10_500 + 15_000
      while (taken < toSmelt && Date.now() < deadline) {
        await sleep(1000, signal)
        const o = furnace.outputItem()
        if (o) {
          const n = o.count
          await furnace.takeOutput()
          taken += n
          idle = 0
          continue
        }
        if (!furnace.inputItem()) break
        idle = furnace.progress > 0 || furnace.fuel > 0 ? 0 : idle + 1
        if (idle >= 5) { log.debug('furnace stopped burning', { taken, of: toSmelt }); break }
      }
      if (!taken) return fail(`nothing came out of the furnace (is ${item} smeltable?)`)
      return taken >= count ? ok(`smelted ${taken} ${item}`) : ok(`smelted ${taken} of ${count} ${item}`)
    } finally {
      furnace.close()
    }
  }
})

export const crafting = () => defineSkill({
  name: 'crafting',
  description: 'Crafting and smelting.',
  actions: [craft, smelt]
})
