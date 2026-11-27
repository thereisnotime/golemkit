import type { Bot } from 'mineflayer'
import type { Block } from 'prismarine-block'
import type { Vec3 } from 'vec3'
import { defineSkill, defineAction, z, ok, fail, sleep, checkAborted, fmtPos, itemName, goals, type ActionResult, type Agent } from '../core/index.ts'
import { reachBlock, placeAt, findFreeSpot, findItem, countItem, gotoWithin } from './world.ts'
import { stationSpotBlocked, leaveSpawnPoint, inSpawnProtection, refusedPlacementText, isPlacementRefusal, spotKey, SPAWN_PROTECTION, type StationRules } from './stationPlan.ts'
import { makeRoom, dropsNear } from './efficiency.ts'
import { pickupNearby } from './pickup.ts'
import { inWater, reachDryLand } from './navigation.ts'

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

/**
 * Orders a recipe's variants (stone tools from cobblestone, cobbled deepslate or blackstone; planks
 * of any wood) for what it holds. Pure. The ones it can run come first, most runs first; then the
 * fewest items short; ties go to the variant whose inputs it holds most of, so "need 1 cobblestone"
 * beats "need 2 cobbled_deepslate" for a bot with one cobblestone. Stable otherwise.
 */
export function rankRecipes<T extends { delta: DeltaEntry[] }> (recipes: readonly T[], have: (id: number) => number): T[] {
  const short = (r: T) => missingFor(r.delta, have).reduce((n, x) => n + x.need, 0)
  const held = (r: T) => r.delta.filter(d => d.count < 0).reduce((n, d) => n + Math.min(have(d.id), -d.count), 0)
  return recipes.map((r, i) => ({ r, i, runs: maxCrafts(r.delta, have), short: short(r), held: held(r) }))
    .sort((a, b) => b.runs - a.runs || a.short - b.short || b.held - a.held || a.i - b.i)
    .map(x => x.r)
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

// ---- where stations go: outside spawn protection and protected areas ----

interface StationContext { agent: Agent, refused: Set<string> }
const stationCtx = new WeakMap<Bot, StationContext>()

/** The spawn-protection radius: settings.world.spawnProtection, default 16 (server.properties spawn-protection). */
export function spawnProtectionOf (agent: Agent | undefined): number {
  const v = Number((agent?.settings as { world?: { spawnProtection?: unknown } } | undefined)?.world?.spawnProtection)
  return Number.isFinite(v) && v >= 0 ? v : SPAWN_PROTECTION
}

function stationRules (bot: Bot): StationRules & { ctx?: StationContext } {
  const ctx = stationCtx.get(bot)
  const spawn = (bot as { spawnPoint?: { x: number, z: number } }).spawnPoint ?? null
  return {
    ctx,
    spawn,
    spawnRadius: spawnProtectionOf(ctx?.agent),
    isProtected: ctx?.agent.protectedAreas ? p => ctx.agent.protectedAreas.isProtected(p) : undefined,
    refused: ctx?.refused
  }
}

/**
 * Puts a crafting table or furnace down next to the bot, outside spawn protection and protected
 * areas. A spot the server refuses is remembered (and reported as protected, so a second refusal
 * nearby makes it a protected area); the next try is another spot, and when every spot near is
 * ruled out inside spawn protection it walks out of it first. Returns the placed block or why not.
 */
export async function placeStation (bot: Bot, item: 'crafting_table' | 'furnace', signal: AbortSignal): Promise<Block | string> {
  const r = stationRules(bot)
  const refused: Set<string> = r.ctx?.refused ?? new Set<string>()
  const rules = { ...r, refused }
  const skip = (p: Vec3) => !!stationSpotBlocked(p, rules)
  let why = `no room to put down a ${item.replace('_', ' ')}`
  for (let i = 0; i < 4; i++) {
    checkAborted(signal)
    let spot = findFreeSpot(bot, skip)
    if (!spot) {
      const out = leaveSpawnPoint(bot.entity.position, r.spawn, r.spawnRadius)
      if (!out) break
      // every spot near is inside spawn protection: walk out of it first
      try {
        await gotoWithin(bot, new goals.GoalNearXZ(out.x, out.z, 2), signal, 30_000)
      } catch (e) {
        checkAborted(signal)
        return `${why}; couldn't walk out of spawn protection: ${(e as Error).message}`
      }
      spot = findFreeSpot(bot, skip)
      if (!spot) continue
    }
    try {
      await placeAt(bot, item, spot, signal)
    } catch (e) {
      checkAborted(signal)
      const msg = (e as Error).message
      if (!isPlacementRefusal(msg)) { why = msg; await sleep(400, signal); continue }
      refused.add(spotKey(spot))
      why = refusedPlacementText(item, spot, rules)
      r.ctx?.agent.markProtected?.(spot, { confirmed: inSpawnProtection(spot, r.spawn, r.spawnRadius) })
      continue
    }
    const b = bot.blockAt(spot)
    if (b?.name === item) return b
    refused.add(spotKey(spot))
    why = refusedPlacementText(item, spot, rules)
  }
  return `could not place a ${item.replace('_', ' ')}: ${why}`
}

/**
 * Gets out of the water before opening a furnace or crafting table: Pax smelted charcoal afloat in
 * a flooded shaft and sank while the furnace window stayed open. True when on dry ground.
 */
export async function dryFooting (bot: Bot, signal: AbortSignal): Promise<boolean> {
  if (!inWater(bot)) return true
  try { return await reachDryLand(bot, signal) } catch (e) { checkAborted(signal); return false }
}

/** Nearest crafting table, or one we place (from inventory, or crafted from planks). */
async function getTable (bot: Bot, signal: AbortSignal): Promise<{ table: Block, placed: boolean } | string> {
  const tableId = bot.registry.blocksByName.crafting_table.id
  const near = bot.findBlock({ matching: tableId, maxDistance: TABLE_SEARCH })
  if (near) return { table: near, placed: false }
  if (!findItem(bot, 'crafting_table')) {
    let r = bot.recipesFor(bot.registry.itemsByName.crafting_table.id, null, 1, null)[0]
    if (!r) {
      // logs but too few planks: one log makes the 4 planks a table takes (the mine trip came up with 6 logs and 2 planks and stopped here)
      const log = bot.inventory.items().find(i => /_(log|stem)$/.test(i.name) && !i.name.startsWith('stripped_'))
      const planks = log && bot.registry.itemsByName[log.name.replace(/_(log|stem)$/, '_planks')]
      const pr = planks ? bot.recipesFor(planks.id, null, 1, null)[0] : undefined
      if (pr) { await bot.craft(pr, 1).catch(() => {}); await sleep(SETTLE_MS, signal) }
      r = bot.recipesFor(bot.registry.itemsByName.crafting_table.id, null, 1, null)[0]
    }
    if (!r) return 'needs a crafting table and there is none nearby (and no planks to make one)'
    await bot.craft(r, 1)
    await sleep(SETTLE_MS, signal)
  }
  checkAborted(signal)
  const table = await placeStation(bot, 'crafting_table', signal)
  if (typeof table === 'string') return table
  return { table, placed: true }
}

const withTimeout = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<void>(resolve => setTimeout(resolve, ms))])

/**
 * Asks the server for the real inventory state, then moves anything left in the 2x2 crafting
 * grid (slots 1-4) or on the cursor back into the inventory. Returns how many stacks it moved.
 */
export async function emptyCraftGrid (bot: Bot): Promise<number> {
  const sync = (bot as any)._syncWindow as ((w: unknown) => Promise<void>) | undefined
  if (sync) await withTimeout(sync(bot.inventory).catch(() => {}), 3000)
  let moved = 0
  try {
    for (const slot of [1, 2, 3, 4]) {
      if (!bot.inventory.slots[slot]) continue
      await bot.clickWindow(slot, 0, 1) // shift-click back into the inventory
      moved++
    }
    if (bot.inventory.selectedItem) {
      const empty = bot.inventory.firstEmptyInventorySlot()
      if (empty !== null) { await bot.clickWindow(empty, 0, 0); moved++ }
    }
  } catch {}
  if (moved && sync) await withTimeout(sync(bot.inventory).catch(() => {}), 3000)
  return moved
}

/**
 * Crafts `count` of an item from the inventory (the craft action's body, for other actions to
 * reuse inside their own lock). Uses a nearby crafting table or puts one down when needed.
 */
export async function craftItem (bot: Bot, signal: AbortSignal, item: string, count = 1): Promise<ActionResult> {
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
      const best = rankRecipes(all, have)[0]!
      return fail(`missing ingredients for ${item}: need ${names(bot, missingFor(best.delta, have))}`)
    }
    const got = await getTable(bot, signal)
    if (typeof got === 'string') return fail(got)
    table = got.table
    placed = got.placed
    await dryFooting(bot, signal)
    await reachBlock(bot, table.position, signal)
  }

  // the variant it can make most of (cobblestone, not the cobbled_deepslate listed first)
  recipes = rankRecipes(recipes, have)
  // A full inventory makes mineflayer toss the crafted item (or the cursor stack) on the ground.
  const inputs = new Set(recipes[0].delta.filter(d => d.count < 0).map(d => bot.registry.items[d.id]?.name ?? ''))
  const thrown = await makeRoom(bot, 2, new Set([item, ...inputs]))
  const dropsBefore = dropsNear(bot, 3)
  const before = countItem(bot, item)
  let runs = craftsNeeded(count, recipes[0].result.count)
  while (runs > 0) {
    checkAborted(signal)
    // re-check every run: a recipe may use up one plank type while another still works
    const pool = table ? bot.recipesFor(def.id, null, 1, table) : bot.recipesFor(def.id, null, 1, null)
    const recipe = rankRecipes(pool, have)[0]
    if (!recipe || maxCrafts(recipe.delta, have) <= 0) break
    // one run per call: batching runs races the server's slot updates and the inventory
    // model drifts (seen live on NeoForge), so craft once and let the slots settle
    await bot.craft(recipe, 1, table ?? undefined)
    await sleep(SETTLE_MS, signal)
    runs--
  }
  // 2x2 crafts in the inventory: mineflayer never re-syncs that window, and a lagging server can
  // leave the ingredient stack in the crafting grid while the model shows it gone (seen live:
  // 15 logs "vanished" until a later window close returned them). Sync and empty the grid.
  const gridBack = table ? 0 : await emptyCraftGrid(bot)
  // anything that fell out while crafting (no room in the model) goes straight back in
  let recovered = 0
  if ([...dropsNear(bot, 3)].some(id => !dropsBefore.has(id))) {
    await sleep(300, signal)
    recovered = await pickupNearby(bot, signal, { radius: 4, maxMs: 4000 })
  }
  const made = countItem(bot, item) - before
  const extra = [thrown ? `threw away ${thrown} to make room` : '', gridBack ? `took ${gridBack} stacks back out of the crafting grid` : '', recovered ? `picked ${recovered} dropped items back up` : ''].filter(Boolean).join(', ')
  const note = (placed && table ? ` (put a crafting table at ${fmtPos(table.position)})` : '') + (extra ? ` (${extra})` : '')
  if (made <= 0) return fail(`could not craft ${item}${note}`)
  return made >= count ? ok(`crafted ${made} ${item}${note}`) : ok(`crafted ${made} of ${count} ${item}, ran out of ingredients${note}`)
}

const craft = defineAction({
  name: 'craft',
  description: 'Craft an item from what is in the inventory. Uses a crafting table within 16 blocks when the recipe needs one, or puts one down (from the inventory, or made from planks).',
  params: z.object({
    item: z.string().describe('item to make, e.g. stick, crafting_table, stone_pickaxe'),
    count: z.number().int().min(1).max(256).default(1).describe('how many items to end up with (not recipe runs)')
  }),
  run: ({ bot, signal }, { item, count }) => craftItem(bot, signal, item, count)
})

/**
 * Smelts `count` of an item in a furnace within 32 blocks, or one put down from the inventory
 * (the smelt action's body, for gather_materials to reuse). Adds fuel, waits and takes the
 * output. `data.placed` is where it put a furnace down, if it did.
 */
export async function smeltItem (bot: Bot, signal: AbortSignal, log: { debug: (msg: string, f?: Record<string, unknown>) => void }, item: string, count: number, fuel?: string): Promise<ActionResult> {
  const input = findItem(bot, item)
  if (!input) return fail(`no ${item} to smelt`)
  count = Math.min(count, countItem(bot, item))
  // the furnace window stays open for ~10 s an item: never with the bot afloat (and a furnace put
  // down from the water goes on the rim of a flooded hole)
  if (!await dryFooting(bot, signal)) return fail(`I'm in the water at ${fmtPos(bot.entity.position)} and can't get out; not smelting here`)

  let placed: Block['position'] | null = null
  let furnaceBlock = bot.findBlock({ matching: bot.registry.blocksByName.furnace.id, maxDistance: FURNACE_SEARCH })
  if (!furnaceBlock) {
    if (!findItem(bot, 'furnace')) return fail('no furnace nearby and none in the inventory')
    // a spot can be refused (spawn protection, a mob standing there, a block update race): placeStation tries others
    const put = await placeStation(bot, 'furnace', signal)
    if (typeof put === 'string') return fail(put)
    furnaceBlock = put
    placed = furnaceBlock.position
  }
  const data = placed ? { placed: { x: placed.x, y: placed.y, z: placed.z } } : {}
  await reachBlock(bot, furnaceBlock.position, signal)
  if (inWater(bot)) return fail(`the only spot that reaches the furnace at ${fmtPos(furnaceBlock.position)} is in the water; not smelting there`, data)

  const furnace = await bot.openFurnace(furnaceBlock)
  try {
    const busy = furnace.inputItem()
    if (busy && itemName(busy) !== item) return fail(`the furnace is busy smelting ${itemName(busy)}`, data)
    const out = furnace.outputItem()
    if (out) await furnace.takeOutput()

    // fuel: count what's already burning/loaded, add the rest
    const loaded = furnace.fuelItem()
    let capacity = loaded ? fuelValue(itemName(loaded)) * loaded.count : 0
    if (capacity < count) {
      const fuelName = fuel ?? pickFuel(bot.inventory.items().map(itemName), item)
      if (!fuelName) return fail('no fuel (coal, charcoal, planks or logs)', data)
      if (loaded && itemName(loaded) !== fuelName) return fail(`the furnace already has ${itemName(loaded)} as fuel`, data)
      const need = Math.min(fuelNeeded(fuelName, count - capacity), countItem(bot, fuelName))
      if (need <= 0) return fail(`no ${fuelName} for fuel`, data)
      await furnace.putFuel(bot.registry.itemsByName[fuelName].id, null, need)
      capacity += fuelValue(fuelName) * need
    }
    const toSmelt = Math.min(count, Math.floor(capacity) || count)
    await furnace.putInput(input.type, null, toSmelt)

    let taken = 0
    let idle = 0
    let empty = 0
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
      // the window model can lag right after putInput: only give up after a few empty looks
      if (!furnace.inputItem()) { if (++empty >= 4) break; continue }
      empty = 0
      idle = furnace.progress > 0 || furnace.fuel > 0 ? 0 : idle + 1
      if (idle >= 5) { log.debug('furnace stopped burning', { taken, of: toSmelt }); break }
    }
    const last = furnace.outputItem()
    if (last) { taken += last.count; await furnace.takeOutput().catch(() => {}) }
    const left = furnace.inputItem()
    const inFurnace = left && taken < toSmelt ? ` (${left.count} ${itemName(left)} still in the furnace at ${fmtPos(furnaceBlock.position)})` : ''
    if (!taken) return fail(`nothing came out of the furnace (is ${item} smeltable?)${inFurnace}`, data)
    return taken >= count ? ok(`smelted ${taken} ${item}`, data) : ok(`smelted ${taken} of ${count} ${item}${inFurnace}`, data)
  } finally {
    furnace.close()
  }
}

const smelt = defineAction({
  name: 'smelt',
  description: 'Smelt items in a furnace within 32 blocks (or one placed from the inventory), add fuel, wait and take the results.',
  params: z.object({
    item: z.string().describe('item to smelt, e.g. raw_iron, sand, oak_log'),
    count: z.number().int().min(1).max(64).default(1),
    fuel: z.string().optional().describe('fuel item; default the best one in the inventory (coal, charcoal, planks, logs...)')
  }),
  run: ({ bot, signal, log }, { item, count, fuel }) => smeltItem(bot, signal, log, item, count, fuel)
})

export const crafting = () => defineSkill({
  name: 'crafting',
  capabilities: ['craft'],
  description: 'Crafting and smelting.',
  actions: [craft, smelt],
  // where crafting tables and furnaces may go: the agent's protected areas and spawn-protection setting
  setup: (agent, bot) => {
    stationCtx.set(bot as Bot, { agent, refused: new Set() })
    return () => { stationCtx.delete(bot as Bot) }
  }
})
