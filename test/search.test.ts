import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import {
  resolveTarget, isResolveError, normalizeTarget, singulars, searchPhases, prospectable, villageVerdict, portalVerdict,
  describeFind, gatherSource, bringSteps, ingredientFor, pickaxeFor, isOwnChest, parseChestList, tossAccount, dropsTrip, progressDue, itemOfBlock,
  type RegistryNames, type ResolvedTarget, type BringState
} from '../src/skills/searchPlan.ts'
import { scoutWaypoints, scoutStopReason, nextWaypoint, DEFAULT_SCOUT_LIMITS, type ScoutProgress } from '../src/skills/foodPlan.ts'

const require = createRequire(import.meta.url)
const mcData = require('minecraft-data')('1.21.1')

const names: RegistryNames = {
  blocks: [...mcData.blocksArray.map((b: { name: string }) => b.name), 'create:andesite_casing'],
  items: [...mcData.itemsArray.map((i: { name: string }) => i.name), 'create:andesite_alloy', 'create:andesite_casing'],
  entities: [...mcData.entitiesArray.map((e: { name: string }) => e.name), 'ars_nouveau:wilden_hunter'],
  biomes: mcData.biomesArray.map((b: { name: string }) => b.name)
}

const res = (s: string): ResolvedTarget => {
  const r = resolveTarget(s, names)
  if (isResolveError(r)) throw new Error(`${s}: ${r.error}`)
  return r
}

// ------------------------------------------------------------------ target resolution

test('normalize: articles, case, namespace and spaces', () => {
  assert.equal(normalizeTarget('The Nearest Nether Portal'), 'nether_portal')
  assert.equal(normalizeTarget('minecraft:Oak_Log'), 'oak_log')
  assert.equal(normalizeTarget('some diamonds!'), 'diamonds')
  assert.deepEqual(singulars('wolves').slice(0, 2), ['wolves', 'wolf'])
  assert.ok(singulars('endermen').includes('enderman'))
  assert.ok(singulars('cows').includes('cow'))
})

test('resolve: ore families with deepslate variants and the drop', () => {
  const iron = res('iron')
  assert.equal(iron.kind, 'block')
  assert.deepEqual(iron.blocks, ['iron_ore', 'deepslate_iron_ore'])
  assert.equal(iron.item, 'raw_iron')
  assert.equal(iron.ore, 'iron')
  assert.equal(res('diamonds').ore, 'diamond')
  assert.equal(res('coal').item, 'coal')
  assert.equal(res('lapis').item, 'lapis_lazuli')
  assert.equal(res('iron ore').key, 'iron')
  assert.equal(res('diamond block').kind, 'block')
  assert.equal(res('diamond block').ore, undefined)
})

test('resolve: logs, sand, liquids and crops', () => {
  const logs = res('logs')
  assert.ok(logs.blocks!.includes('oak_log') && logs.blocks!.includes('birch_log'))
  assert.equal(logs.fetch, 'chop')
  assert.equal(res('trees').key, 'logs')
  const sand = res('sand')
  assert.deepEqual(sand.blocks, ['sand'])
  assert.equal(sand.fetch, 'collect')
  const water = res('water')
  assert.equal(water.liquid, true)
  assert.equal(water.item, 'water_bucket')
  assert.equal(res('lava').liquid, true)
  const wheat = res('wheat')
  assert.equal(wheat.ripe, true)
  assert.equal(wheat.fetch, 'harvest')
  assert.deepEqual(res('carrots').blocks, ['carrots'])
  assert.equal(res('carrots').item, 'carrot')
})

test('resolve: mobs, plural or not, and items that are also mobs', () => {
  assert.deepEqual(res('sheep').mobs, ['sheep'])
  assert.deepEqual(res('cows').mobs, ['cow'])
  assert.equal(res('a villager').kind, 'mob')
  assert.equal(res('chickens').kind, 'mob')
  assert.deepEqual(res('wolves').mobs, ['wolf'])
  assert.ok(res('animals').mobs!.includes('pig'))
})

test('resolve: structures and chests', () => {
  assert.equal(res('village').structure, 'village')
  assert.equal(res('a village').kind, 'structure')
  assert.equal(res('nether portal').structure, 'nether_portal')
  assert.equal(res('portal').structure, 'nether_portal')
  const chest = res('chest')
  assert.ok(chest.blocks!.includes('chest'))
  assert.equal(chest.fetch, undefined, 'chests are never dug up')
  assert.equal(res('bell').fetch, undefined)
})

test('resolve: biomes by word and by registry name', () => {
  const desert = res('desert')
  assert.equal(desert.kind, 'biome')
  assert.deepEqual(desert.biomes, ['desert'])
  const snow = res('snow')
  assert.equal(snow.kind, 'biome')
  assert.ok(snow.biomes!.includes('snowy_plains'))
  assert.ok(snow.biomes!.includes('frozen_river'))
  const ocean = res('ocean')
  assert.ok(ocean.biomes!.includes('deep_ocean') && ocean.biomes!.includes('warm_ocean'))
  assert.equal(res('cherry grove').kind, 'biome')
  assert.equal(res('dark_forest').kind, 'biome')
})

test('resolve: modded names from the registry, items, unknowns', () => {
  const alloy = res('andesite alloy')
  assert.equal(alloy.key, 'create:andesite_alloy')
  assert.equal(alloy.modded, true)
  assert.equal(res('create:andesite_casing').kind, 'item')
  assert.equal(res('wilden hunter').kind, 'mob')
  assert.equal(res('iron ingot').kind, 'item')
  assert.equal(res('iron ingot').item, 'iron_ingot')
  const bad = resolveTarget('blorptastic', names)
  assert.ok(isResolveError(bad))
  assert.ok(isResolveError(resolveTarget('', names)))
})

test('itemOfBlock: what digging gives', () => {
  assert.equal(itemOfBlock('deepslate_iron_ore'), 'raw_iron')
  assert.equal(itemOfBlock('stone'), 'cobblestone')
  assert.equal(itemOfBlock('sand'), 'sand')
})

// ------------------------------------------------------------------ phases, spiral and stop rules

test('phases: view, memory, scout; prospecting only for reachable ores when asked', () => {
  const o = { prospect: true, canDig: true, feetY: 64 }
  assert.deepEqual(searchPhases(res('sheep'), o), ['view', 'memory', 'scout'])
  assert.deepEqual(searchPhases(res('desert'), o), ['view', 'scout'])
  assert.deepEqual(searchPhases(res('iron'), o), ['view', 'memory', 'scout', 'prospect'])
  assert.deepEqual(searchPhases(res('iron'), { ...o, prospect: false }), ['view', 'memory', 'scout'])
  assert.deepEqual(searchPhases(res('iron'), { ...o, canDig: false }), ['view', 'memory', 'scout'])
  // a 20 block staircase from y=64 never reaches diamond level, from y=30 it does
  assert.ok(!searchPhases(res('diamonds'), o).includes('prospect'))
  assert.ok(searchPhases(res('diamonds'), { ...o, feetY: 30 }).includes('prospect'))
  assert.deepEqual(searchPhases(res('iron ingot'), o), [])
  assert.equal(prospectable('emerald', 64), false)
  assert.equal(prospectable('coal', 70), true)
})

test('scout: the spiral skips protected waypoints and stops by the food rules', () => {
  const wps = scoutWaypoints({ x: 0, z: 0 }, 160, { skip: p => p.x > 100 })
  assert.ok(wps.length > 8)
  assert.ok(wps.every(w => w.x <= 100))
  assert.ok(wps.every(w => w.distance <= 160))
  const blocked = new Map([[wps[0]!.sector, 1]])
  const i = nextWaypoint(wps, new Set(), blocked)
  assert.notEqual(wps[i]!.sector, wps[0]!.sector)
  const base: ScoutProgress = { legs: 0, consecutiveFailures: 0, walked: 0, elapsedMs: 0, night: false, health: 20, hostilesNear: 0 }
  const limits = { ...DEFAULT_SCOUT_LIMITS, maxMs: 8 * 60_000 }
  assert.equal(scoutStopReason(base, limits), null)
  assert.equal(scoutStopReason({ ...base, night: true }, limits), 'night fell')
  assert.equal(scoutStopReason({ ...base, night: true }, { ...limits, atNight: true }), null)
  assert.match(scoutStopReason({ ...base, health: 5, hostilesNear: 1 }, limits)!, /health is low/)
  assert.equal(scoutStopReason({ ...base, health: 5 }, limits), null)
  assert.match(scoutStopReason({ ...base, elapsedMs: 8 * 60_000 }, limits)!, /8 minutes/)
})

// ------------------------------------------------------------------ village and portal

test('village: bell with beds or villagers, villagers with beds, abandoned with paths', () => {
  const none = { beds: 0, bells: 0, villagers: 0, workstations: 0, paths: 0 }
  assert.equal(villageVerdict({ ...none, bells: 1, beds: 3 }).village, true)
  assert.equal(villageVerdict({ ...none, bells: 1, villagers: 1 }).village, true)
  assert.equal(villageVerdict({ ...none, villagers: 4, beds: 3 }).village, true)
  assert.equal(villageVerdict({ ...none, villagers: 2, beds: 2, workstations: 1 }).village, true)
  assert.equal(villageVerdict({ ...none, beds: 4, workstations: 3, paths: 12 }).village, true)
  assert.match(villageVerdict({ ...none, beds: 4, workstations: 3, paths: 12 }).why, /nobody home/)
  // not a village: a couple of villagers alone, a bedroom, a bell on its own
  assert.equal(villageVerdict({ ...none, villagers: 2 }).village, false)
  assert.equal(villageVerdict({ ...none, beds: 2 }).village, false)
  assert.equal(villageVerdict({ ...none, bells: 1 }).village, false)
  assert.ok(villageVerdict({ ...none, bells: 1, beds: 5, villagers: 6 }).score > villageVerdict({ ...none, villagers: 3, beds: 2 }).score)
})

test('portal: lit portal, an empty 4x5 frame without corners, and loose obsidian', () => {
  assert.equal(portalVerdict([], 2).portal, true)
  const frame = []
  // x plane 10, z from 0..3 (outer width 4), y 60..64 (outer height 5), corners left out
  for (let z = 1; z <= 2; z++) { frame.push({ x: 10, y: 60, z }, { x: 10, y: 64, z }) }
  for (let y = 61; y <= 63; y++) { frame.push({ x: 10, y, z: 0 }, { x: 10, y, z: 3 }) }
  assert.equal(frame.length, 10)
  const v = portalVerdict(frame)
  assert.equal(v.portal, true)
  assert.match(v.why, /4x5/)
  assert.equal(portalVerdict(frame.slice(0, 9)).portal, false)
  const pile = Array.from({ length: 12 }, (_, i) => ({ x: i % 4, y: 60, z: Math.floor(i / 4) }))
  assert.equal(portalVerdict(pile).portal, false)
})

test('describeFind: coordinates, distance and direction, depth for buried blocks', () => {
  const s = describeFind({ x: 100, y: 30, z: 0, what: 'iron ore', count: 3 }, { x: 0, y: 64, z: 0 }, 'you', 70)
  assert.equal(s, '3 iron ore at 100 30 0, 100 blocks east of you (40 below the surface)')
  assert.match(describeFind({ x: 5, y: 40, z: 0, what: 'iron ore', count: 64, capped: true }, null, 'you'), /^64\+ iron ore at 5 40 0$/)
  assert.match(describeFind({ x: 1, y: 64, z: 1, what: 'water' }, { x: 0, y: 64, z: 0 }, 'you'), /right by you/)
  assert.match(describeFind({ x: 0, y: 64, z: -50, what: 'sheep', count: 2 }, { x: 0, y: 64, z: 0 }, 'where I started'), /50 blocks north of where I started/)
})

// ------------------------------------------------------------------ bring_item decision order

const st = (o: Partial<BringState>): BringState => ({ item: 'x', count: 4, have: 0, inOwnChests: 0, uncheckedOwnChests: 0, recipe: false, source: null, canDig: true, ...o })

test('bring order: inventory, own chests, craft, gather, find', () => {
  assert.deepEqual(bringSteps(st({ have: 4 })), ['inventory'])
  assert.deepEqual(bringSteps(st({ have: 1, inOwnChests: 2, recipe: true, source: gatherSource('raw_iron') })), ['inventory', 'chest', 'craft', 'gather', 'find'])
  assert.deepEqual(bringSteps(st({ item: 'bread', recipe: true, source: gatherSource('bread') })), ['craft'])
  // any planks come from the materials pipeline (chop any tree, then craft); oak planks are crafted from oak logs fetched first
  assert.deepEqual(bringSteps(st({ item: 'planks', recipe: false, source: gatherSource('planks') })), ['gather', 'find'])
  assert.deepEqual(bringSteps(st({ item: 'oak_planks', recipe: true, source: gatherSource('oak_planks') })), ['craft'])
  assert.deepEqual(ingredientFor('oak_planks'), { item: 'oak_log', per: 1, makes: 4 })
  assert.equal(ingredientFor('bread')!.item, 'wheat')
  // crops are harvested, not dug: fine with digging off
  assert.deepEqual(bringSteps(st({ item: 'wheat', source: gatherSource('wheat'), canDig: false })), ['gather', 'find'])
  assert.deepEqual(bringSteps(st({ item: 'raw_iron', source: gatherSource('raw_iron'), canDig: false })), [])
  assert.deepEqual(bringSteps(st({ uncheckedOwnChests: 1, creative: true, recipe: true })), ['chest'])
  assert.deepEqual(bringSteps(st({ item: 'create:andesite_alloy' })), [])
  // iron ingots: crafting (from nuggets or a block) is tried, then the furnace from raw iron
  assert.deepEqual(bringSteps(st({ item: 'iron_ingot', recipe: true, source: gatherSource('iron_ingot'), smeltFrom: 'raw_iron' })), ['craft', 'smelt'])
})

test('pickaxe per ore: stone for iron, iron for diamonds', () => {
  assert.deepEqual(pickaxeFor('iron'), { rank: 2, upTo: 'stone' })
  assert.deepEqual(pickaxeFor('coal'), { rank: 1, upTo: 'stone' })
  assert.deepEqual(pickaxeFor('diamond'), { rank: 3, upTo: 'iron' })
})

test('gather sources', () => {
  assert.deepEqual(gatherSource('raw_iron'), { how: 'collect', block: 'iron_ore', target: 'iron' })
  assert.equal(gatherSource('oak_planks'), null)
  assert.equal(gatherSource('planks')!.how, 'materials')
  assert.deepEqual(gatherSource('oak_log'), { how: 'chop', block: 'oak_log', target: 'oak_log' })
  assert.equal(gatherSource('birch_log')!.how, 'chop')
  assert.equal(gatherSource('wheat')!.how, 'harvest')
  assert.equal(gatherSource('cobblestone')!.block, 'stone')
  assert.equal(gatherSource('water_bucket')!.how, 'bucket')
  assert.equal(gatherSource('sand')!.how, 'collect')
  assert.equal(gatherSource('chest')!.how, 'materials')
  assert.equal(gatherSource('bread'), null)
  assert.equal(gatherSource('iron_ingot'), null)
})

test('own chests: placed by the bot or configured, nothing else', () => {
  const own = [{ x: 1, y: 64, z: 1 }]
  const cfg = parseChestList(['10 64 10', [20, 64, 20], { x: 30, y: 65, z: 30 }, 'junk', [1, 2]])
  assert.deepEqual(cfg, [{ x: 10, y: 64, z: 10 }, { x: 20, y: 64, z: 20 }, { x: 30, y: 65, z: 30 }])
  assert.equal(isOwnChest({ x: 1, y: 64, z: 1 }, own, cfg), true)
  assert.equal(isOwnChest({ x: 20, y: 64, z: 20 }, own, cfg), true)
  assert.equal(isOwnChest({ x: 2, y: 64, z: 1 }, own, cfg), false)
  assert.deepEqual(parseChestList(undefined), [])
})

// ------------------------------------------------------------------ toss accounting

test('toss: counts what left the inventory and what the player picked up', () => {
  const all = tossAccount({ requested: 16, before: 20, after: 4, pickedUp: 16 }, 'oak_planks', 'Steve')
  assert.deepEqual([all.given, all.pickedUp, all.ok], [16, 16, true])
  assert.equal(all.message, 'gave Steve 16 oak_planks')
  const short = tossAccount({ requested: 16, before: 10, after: 0, pickedUp: 10 }, 'oak_planks', 'Steve')
  assert.equal(short.ok, false)
  assert.match(short.message, /gave Steve 10 oak_planks \(16 asked for, I had 10\)/)
  const lying = tossAccount({ requested: 2, before: 2, after: 0, pickedUp: 0 }, 'bread', 'Steve')
  assert.equal(lying.given, 2)
  assert.match(lying.message, /haven't picked it up/)
  assert.equal(lying.ok, false, 'items on the ground are not delivered')
  const part = tossAccount({ requested: 4, before: 4, after: 0, pickedUp: 3 }, 'bread', 'Steve')
  assert.match(part.message, /picked up 3/)
  const unwatched = tossAccount({ requested: 1, before: 1, after: 0, pickedUp: null }, 'bread', 'Steve')
  assert.equal(unwatched.pickedUp, null)
  assert.match(unwatched.message, /tossed 1 bread/)
  assert.equal(unwatched.ok, true)
  const none = tossAccount({ requested: 1, before: 1, after: 1, pickedUp: 0 }, 'bread', 'Steve')
  assert.equal(none.ok, false)
  // pickups of other items never count for more than was tossed
  assert.equal(tossAccount({ requested: 1, before: 1, after: 0, pickedUp: 5 }, 'bread', 'Steve').pickedUp, 1)
})

// ------------------------------------------------------------------ drops and progress

test('drops trip: go only when it can arrive before the despawn', () => {
  const now = 1_000_000
  assert.equal(dropsTrip({ diedAt: now - 30_000, now, distance: 100 }).go, true)
  const far = dropsTrip({ diedAt: now - 60_000, now, distance: 1000 })
  assert.equal(far.go, false)
  assert.match(far.why, /1000 blocks/)
  const gone = dropsTrip({ diedAt: now - 6 * 60_000, now, distance: 10 })
  assert.equal(gone.go, false)
  assert.match(gone.why, /despawned/)
})

test('progress: milestones rate limited, important ones always', () => {
  assert.equal(progressDue(0, 30_000, false), true)
  assert.equal(progressDue(20_000, 30_000, false), false)
  assert.equal(progressDue(20_000, 30_000, true), true)
  assert.equal(progressDue(20_000, 41_000, false), true)
})
