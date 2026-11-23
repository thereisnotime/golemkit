import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { ok, fail, createLogger, type ActionResult } from '../src/core/index.ts'
import {
  nextFoodStep, nextFarmTask, keepFed, defaultBehaviorRegistry,
  type FoodWorld, type FoodStepOptions, type FarmState, type FarmTaskOptions
} from './behaviors-helpers.ts'
import {
  scoutWaypoints, scoutStopReason, nextWaypoint, sectorsText, compass, DEFAULT_SCOUT_LIMITS,
  mergeSpot, markSpotEmpty, rankSpots, SPOT_EMPTY_PAUSE_MS,
  scoreSite, chooseFarmSite, plotLayout, pickFarmSeed, breadToBake,
  BREED_FOOD, breedFoodFor, breedPlan,
  type SiteCandidate, type CellKind, type FoodSpot, type ScoutProgress
} from '../src/skills/foodPlan.ts'
import { herdSurplus } from '../src/skills/combat.ts'

const require = createRequire(import.meta.url)
const mcData = require('minecraft-data')('1.21.1')

// ------------------------------------------------------------------ nextFoodStep

const allOn: FoodStepOptions = { chests: true, harvest: true, hunt: true, cook: true, eatRaw: true, scout: true, startFarm: true, radius: 32 }
const empty: FoodWorld = { hasReadyFood: false, raw: [], safeRaw: false, canCook: false, canBake: false, foodChest: false, ripeCrops: 0, animals: 0 }

test('food order: eat, cook, bread, farm, known spot, hunt, scout, start a farm', () => {
  const w: FoodWorld = { ...empty, farmDistance: 90, spotDistance: 20, animals: 2, herd: 4, canScout: true, canStartFarm: true }
  assert.equal(nextFoodStep({ ...w, hasReadyFood: true }, allOn), 'eat')
  assert.equal(nextFoodStep({ ...w, raw: ['beef'], canCook: true }, allOn), 'cook')
  assert.equal(nextFoodStep({ ...w, canBake: true }, allOn), 'bread')
  assert.equal(nextFoodStep(w, allOn), 'farm', 'own farm before anything out in the world')
  assert.equal(nextFoodStep(w, allOn, new Set(['farm'])), 'spot', 'a known spot in range comes before hunting')
  assert.equal(nextFoodStep(w, allOn, new Set(['farm', 'spot'])), 'hunt')
  assert.equal(nextFoodStep(w, allOn, new Set(['farm', 'spot', 'hunt'])), 'scout')
  assert.equal(nextFoodStep(w, allOn, new Set(['farm', 'spot', 'hunt', 'scout'])), 'start_farm')
  assert.equal(nextFoodStep(w, allOn, new Set(['farm', 'spot', 'hunt', 'scout', 'start_farm'])), null)
})

test('a far known spot only wins when there is nothing to hunt here', () => {
  const w: FoodWorld = { ...empty, spotDistance: 150, animals: 2 }
  assert.equal(nextFoodStep(w, allOn), 'hunt')
  assert.equal(nextFoodStep({ ...w, animals: 0 }, allOn), 'spot')
  assert.equal(nextFoodStep({ ...w, spotDistance: 8 }, allOn), 'hunt', 'already standing at the spot: hunt')
})

test('keepAtLeast: the herd is spared unless starving', () => {
  const w: FoodWorld = { ...empty, animals: 0, herd: 2, canScout: true }
  assert.equal(nextFoodStep(w, allOn), 'scout', 'two cows left and keepAtLeast 2: look elsewhere')
  assert.equal(nextFoodStep({ ...w, starving: true }, allOn), 'hunt', 'starving: eat the herd')
  assert.deepEqual(herdSurplus({ cow: 5, pig: 2, sheep: 1 }, 2), { cow: 3, pig: 0, sheep: 0 })
  assert.deepEqual(herdSurplus({ cow: 1 }, 0), { cow: 1 })
})

test('no far trips at night unless scoutAtNight; nearby work still happens', () => {
  const w: FoodWorld = { ...empty, night: true, farmDistance: 90, spotDistance: 120, canScout: true, canStartFarm: true }
  assert.equal(nextFoodStep(w, allOn), null, 'at night stay_safe gets the bot home instead')
  assert.equal(nextFoodStep({ ...w, farmDistance: 10 }, allOn), 'farm', 'a farm in range is fine at night')
  assert.equal(nextFoodStep(w, { ...allOn, scoutAtNight: true }), 'farm')
  assert.equal(nextFoodStep({ ...w, animals: 1 }, allOn), 'hunt', 'hunting in range is fine at night')
})

test('options switch steps off; old callers without the new fields behave as before', () => {
  const w: FoodWorld = { ...empty, canScout: true, canStartFarm: true }
  assert.equal(nextFoodStep(w, { ...allOn, scout: false }), 'start_farm')
  assert.equal(nextFoodStep(w, { ...allOn, scout: false, startFarm: false }), null)
  assert.equal(nextFoodStep({ ...w, hasFarm: true }, { ...allOn, scout: false }), null, 'only one farm')
  const legacy = { chests: true, harvest: true, hunt: true, cook: true, eatRaw: true }
  assert.equal(nextFoodStep(w, legacy), null, 'scouting and farming are opt-in for direct callers')
  assert.equal(nextFoodStep({ ...empty, animals: 2 }, legacy), 'hunt')
})

// ------------------------------------------------------------------ scouting

test('scout pattern: rings out to the radius, spread around, protected spots skipped', () => {
  const wps = scoutWaypoints({ x: 0, z: 0 }, 200)
  const rings = [...new Set(wps.map(w => w.ring))]
  assert.deepEqual(rings, [1, 2, 3], 'rings at 64, 128 and 192 (200 is too close to 192 for another)')
  assert.ok(wps.every(w => Math.hypot(w.x, w.z) <= 201))
  assert.ok(wps.filter(w => w.ring === 1).length >= 4)
  assert.ok(new Set(wps.filter(w => w.ring === 3).map(w => w.sector)).size >= 7, 'outer rings cover every direction')
  // rings are visited inside out
  for (let i = 1; i < wps.length; i++) assert.ok(wps[i]!.ring >= wps[i - 1]!.ring)
  const east = scoutWaypoints({ x: 0, z: 0 }, 128, { skip: p => p.x > 20 })
  assert.ok(east.every(w => w.x <= 20) && east.length > 0)
  assert.equal(compass({ x: 0, z: 0 }, { x: 100, z: 0 }), 'east')
  assert.equal(compass({ x: 0, z: 0 }, { x: 0, z: -100 }), 'north')
  assert.equal(compass({ x: 0, z: 0 }, { x: -70, z: 70 }), 'south-west')
})

test('scout ring radii: a last partial ring only when it is far enough out', () => {
  const r = (radius: number) => [...new Set(scoutWaypoints({ x: 0, z: 0 }, radius).map(w => w.distance))]
  assert.deepEqual(r(200), [64, 128, 192], '200 is within half a step of 192')
  assert.deepEqual(r(240), [64, 128, 192, 240])
  assert.deepEqual(r(100), [64, 100])
  assert.deepEqual(r(40), [40])
})

test('scout give-up: night, health, mobs, stuck, distance and time', () => {
  const p: ScoutProgress = { legs: 3, consecutiveFailures: 0, walked: 300, elapsedMs: 60_000, night: false, health: 20, hostilesNear: 0 }
  assert.equal(scoutStopReason(p), null)
  assert.match(String(scoutStopReason({ ...p, night: true })), /night/)
  assert.equal(scoutStopReason({ ...p, night: true }, { ...DEFAULT_SCOUT_LIMITS, atNight: true }), null)
  assert.match(String(scoutStopReason({ ...p, health: 5, hostilesNear: 1 })), /health/)
  assert.match(String(scoutStopReason({ ...p, hostilesNear: 3 })), /mobs/)
  assert.match(String(scoutStopReason({ ...p, consecutiveFailures: 4 })), /stuck 4 times/)
  assert.match(String(scoutStopReason({ ...p, walked: 5000 })), /walked 5000 blocks/)
  assert.match(String(scoutStopReason({ ...p, elapsedMs: 9 * 60_000 })), /9 minutes/)
})

test('a stuck sector is skipped further out, other directions go on', () => {
  const wps = scoutWaypoints({ x: 0, z: 0 }, 192)
  const visited = new Set<number>()
  const first = nextWaypoint(wps, visited, new Map())
  assert.equal(first, 0)
  visited.add(0)
  const blocked = new Map([[wps[0]!.sector, wps[0]!.ring + 1]])
  const rest: number[] = []
  for (let i = nextWaypoint(wps, visited, blocked); i >= 0; i = nextWaypoint(wps, visited, blocked)) { visited.add(i); rest.push(i) }
  assert.ok(rest.length > 0)
  assert.ok(rest.every(i => wps[i]!.sector !== wps[0]!.sector || wps[i]!.ring <= wps[0]!.ring), 'nothing further out that way')
  assert.equal(sectorsText([0]), 'east')
  assert.equal(sectorsText([6, 0, 7]), 'east, north and north-east')
  assert.equal(sectorsText([0, 1, 2, 3, 4, 5, 6, 7]), 'all around')
})

// ------------------------------------------------------------------ food spots

test('food spots: merge nearby, rank fresh and plentiful first, drop after two empty visits', () => {
  const now = 10 * 3600_000
  const cows: FoodSpot = { kind: 'animals', x: 100, y: 64, z: 0, seen: now - 60_000, count: 3, animals: ['cow'] }
  let spots = mergeSpot([], cows)
  spots = mergeSpot(spots, { ...cows, x: 110, count: 5, seen: now })
  assert.equal(spots.length, 1, 'same kind within 32 blocks replaces')
  assert.equal(spots[0]!.count, 5)
  spots = mergeSpot(spots, { kind: 'animals', x: -150, y: 64, z: 0, seen: now, count: 1 })
  spots = mergeSpot(spots, { kind: 'water', x: 10, y: 62, z: 10, seen: now, count: 4 })
  const ranked = rankSpots(spots, ['animals'], now, { x: 0, z: 0 })
  assert.deepEqual(ranked.map(s => s.x), [110, -150])
  assert.deepEqual(rankSpots(spots, ['animals'], now + 7 * 3600_000, { x: 0, z: 0 }), [], 'animal sightings go stale')
  assert.equal(rankSpots(spots, ['water'], now + 7 * 3600_000, { x: 0, z: 0 }).length, 1, 'water stays')
  spots = markSpotEmpty(spots, 'animals', { x: 110, z: 0 }, now)
  assert.deepEqual(rankSpots(spots, ['animals'], now + 1000, { x: 0, z: 0 }).map(s => s.x), [-150], 'just found empty: wait')
  assert.equal(rankSpots(spots, ['animals'], now + SPOT_EMPTY_PAUSE_MS, { x: 0, z: 0 }).length, 2)
  spots = markSpotEmpty(spots, 'animals', { x: 110, z: 0 }, now + SPOT_EMPTY_PAUSE_MS)
  assert.equal(spots.filter(s => s.kind === 'animals').length, 1, 'second empty visit forgets it')
})

// ------------------------------------------------------------------ farm site and plot

function site (fill: CellKind, opts: { water?: XZ[], set?: Record<string, CellKind>, around?: CellKind[], distance?: number } = {}): SiteCandidate {
  const cells: Record<string, CellKind> = {}
  for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) cells[`${dx},${dz}`] = fill
  cells['0,0'] = 'water'
  for (const w of opts.water ?? []) cells[`${w.x},${w.z}`] = 'water'
  Object.assign(cells, opts.set ?? {})
  return { water: { x: 0, y: 63, z: 0 }, cells, around: opts.around ?? [], distance: opts.distance ?? 10 }
}
interface XZ { x: number, z: number }

test('farm site: flat grass by water, never protected, near builds or on fields', () => {
  assert.ok(scoreSite(site('tillable'))! > 70)
  assert.equal(scoreSite(site('tillable', { set: { '2,2': 'protected' } })), null)
  assert.equal(scoreSite(site('tillable', { around: ['build'] })), null, 'next to somebody\'s house')
  assert.equal(scoreSite(site('tillable', { set: { '1,0': 'farmland' } })), null, 'somebody\'s field')
  assert.ok(scoreSite(site('tillable', { set: { '1,0': 'farmland' } }), { allowFarmland: true }) !== null)
  assert.equal(scoreSite(site('other')), null, 'sand or stone')
  const strip: Record<string, CellKind> = {}
  for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 3; dz++) strip[`${dx},${dz}`] = 'other'
  strip['0,0'] = 'water'
  assert.ok(scoreSite(site('tillable', { set: strip }))! > 0, 'a 9-block strip along the shore is enough')
  strip['4,4'] = 'other'
  strip['3,4'] = 'other'
  assert.equal(scoreSite(site('tillable', { set: strip })), null, 'fewer than 8 tillable cells is not')
  const near = site('tillable', { distance: 5 })
  const far = site('tillable', { distance: 60 })
  const lake = site('tillable', { water: [{ x: 1, z: 0 }, { x: 2, z: 0 }, { x: 1, z: 1 }], distance: 5 })
  assert.equal(chooseFarmSite([far, near, lake]), near)
  assert.equal(chooseFarmSite([site('tillable', { around: ['protected'] })]), null)
})

test('plot layout: 9x9 around the water, fence ring with a gap, torches on the corners', () => {
  const p = plotLayout({ x: 10, y: 63, z: -5 }, 9)
  assert.equal(p.size, 9)
  assert.equal(p.till.length, 80)
  assert.ok(p.till.every(c => c.y === 63 && Math.abs(c.x - 10) <= 4 && Math.abs(c.z + 5) <= 4))
  assert.ok(!p.till.some(c => c.x === 10 && c.z === -5), 'the water stays')
  assert.ok(Math.abs(p.till[0]!.x - 10) + Math.abs(p.till[0]!.z + 5) === 1, 'nearest the water first')
  assert.equal(p.fence.length, 4 * 10 - 1, '11x11 ring minus the gap')
  assert.ok(p.fence.every(f => f.y === 64 && Math.max(Math.abs(f.x - 10), Math.abs(f.z + 5)) === 5))
  assert.deepEqual(p.gap, { x: 10, y: 64, z: 0 })
  assert.equal(p.torches.length, 4)
  assert.equal(plotLayout({ x: 0, y: 0, z: 0 }, 12).size, 9, 'one water block hydrates 4 blocks out at most')
  assert.equal(plotLayout({ x: 0, y: 0, z: 0 }, 4).size, 3)
  assert.equal(plotLayout({ x: 0, y: 0, z: 0 }, 5).till.length, 24)
})

test('ripeness reads block properties as prismarine-block gives them (strings)', async () => {
  const { isMature } = await import('../src/skills/farming.ts')
  const Block = require('prismarine-block')('1.21.1')
  const ripe = Block.fromStateId(mcData.blocksByName.wheat.maxStateId, 0)
  const young = Block.fromStateId(mcData.blocksByName.wheat.minStateId, 0)
  assert.equal(isMature('wheat', ripe.getProperties().age), true)
  assert.equal(isMature('wheat', young.getProperties().age), false)
  assert.equal(isMature('wheat', 7), true)
  assert.equal(isMature('beetroots', '3'), true)
})

test('seeds and bread: plant what there is most of, bake but keep wheat for breeding', () => {
  assert.equal(pickFarmSeed({ wheat_seeds: 3, carrot: 7 }), 'carrot')
  assert.equal(pickFarmSeed({ wheat: 9 }), null)
  assert.equal(breadToBake(10), 3)
  assert.equal(breadToBake(10, 4), 2)
  assert.equal(breadToBake(2), 0)
})

// ------------------------------------------------------------------ breeding

test('breeding food: what each animal eats and when there is enough', () => {
  assert.deepEqual(BREED_FOOD.cow, ['wheat'])
  assert.ok(BREED_FOOD.pig!.includes('carrot') && BREED_FOOD.pig!.includes('potato') && BREED_FOOD.pig!.includes('beetroot'))
  assert.ok(BREED_FOOD.chicken!.includes('wheat_seeds'))
  assert.equal(breedFoodFor('sheep', { wheat: 2 }), 'wheat')
  assert.equal(breedFoodFor('sheep', { wheat: 1 }), null, 'two animals need two')
  assert.equal(breedFoodFor('villager', { wheat: 64 }), null)
  for (const a of Object.keys(BREED_FOOD)) for (const f of BREED_FOOD[a]!) assert.ok(mcData.itemsByName[f], `${f} is a real item`)
})

test('breed plan: a pair with food, under the herd cap, seeds kept for replanting', () => {
  assert.deepEqual(breedPlan({ cow: 3, pig: 2 }, { wheat: 4 }), { animal: 'cow', food: 'wheat' })
  assert.deepEqual(breedPlan({ cow: 3, pig: 2 }, { carrot: 2 }), { animal: 'pig', food: 'carrot' })
  assert.equal(breedPlan({ cow: 1 }, { wheat: 10 }), null, 'needs two adults')
  assert.equal(breedPlan({ cow: 12 }, { wheat: 10 }), null, 'herd is big enough')
  assert.equal(breedPlan({ chicken: 2 }, { wheat_seeds: 9 }), null, '8 seeds are kept, 1 is not enough for two')
  assert.deepEqual(breedPlan({ chicken: 2 }, { wheat_seeds: 10 }), { animal: 'chicken', food: 'wheat_seeds' })
  assert.deepEqual(breedPlan({ chicken: 2 }, { wheat_seeds: 2 }, { keepSeeds: 0 }), { animal: 'chicken', food: 'wheat_seeds' })
  assert.equal(breedPlan({ cow: 4 }, { wheat: 4 }, { animals: ['pig'] }), null)
})

// ------------------------------------------------------------------ farm_setup

const farmOpts: FarmTaskOptions = { tend: true, tendRange: 128, minRipe: 8, bake: true, breed: true }
const quiet: FarmState = { night: false, hungry: false, hasFarm: true, canSetUp: true, farmDistance: 10, ripe: 0, due: false, bake: 0, canBreed: false }

test('farm_setup: set up once, then tend, bake and breed; never at night or hungry', () => {
  assert.equal(nextFarmTask({ ...quiet, hasFarm: false, farmDistance: null }, farmOpts), 'setup')
  assert.equal(nextFarmTask({ ...quiet, hasFarm: false, farmDistance: null, canSetUp: false }, farmOpts), null)
  assert.equal(nextFarmTask(quiet, farmOpts), null)
  assert.equal(nextFarmTask({ ...quiet, ripe: 9 }, farmOpts), 'tend')
  assert.equal(nextFarmTask({ ...quiet, ripe: 3 }, farmOpts), null, 'not enough ripe yet')
  assert.equal(nextFarmTask({ ...quiet, due: true, farmDistance: 100 }, farmOpts), 'tend', 'out of sight and due a visit')
  assert.equal(nextFarmTask({ ...quiet, due: true, farmDistance: 300 }, farmOpts), null, 'too far to walk')
  assert.equal(nextFarmTask({ ...quiet, bake: 2, canBreed: true }, farmOpts), 'bake')
  assert.equal(nextFarmTask({ ...quiet, canBreed: true }, farmOpts), 'breed')
  assert.equal(nextFarmTask({ ...quiet, canBreed: true }, { ...farmOpts, breed: false }), null)
  assert.equal(nextFarmTask({ ...quiet, ripe: 20, night: true }, farmOpts), null)
  assert.equal(nextFarmTask({ ...quiet, hasFarm: false, hungry: true }, farmOpts), null, 'keep_fed first')
})

test('farm_setup and the new keep_fed options validate and coerce from chat', () => {
  const reg = defaultBehaviorRegistry()
  assert.ok(reg.get('farm_setup'))
  assert.deepEqual(reg.coerce('keep_fed', 'scout=true scoutRadius=200'), { scout: true, scoutRadius: 200 })
  const v = reg.validate('keep_fed', { scoutRadius: 300, keepAtLeast: 3, scoutAtNight: false })
  assert.ok(v.ok)
  assert.ok(!reg.validate('keep_fed', { scoutRadius: 5000 }).ok)
  const f = reg.validate('farm_setup', {})
  assert.ok(f.ok && (f.options as any).size === 9)
})

// ------------------------------------------------------------------ keep_fed run with scouting

test('keep_fed: nothing in range, searches close, wider, wide, then far, finds nothing, starts a farm and says so', async () => {
  const inv = [{ name: 'wheat_seeds', count: 5, type: mcData.itemsByName.wheat_seeds.id }]
  const pos: any = { x: 0, y: 64, z: 0, distanceTo: () => 0, offset: () => pos, floored: () => pos, clone: () => ({ set: () => pos }) }
  const bot: any = {
    food: 8, health: 12, entity: { position: pos }, registry: mcData, time: { timeOfDay: 2000 }, game: { dimension: 'minecraft:overworld' },
    inventory: { items: () => inv, emptySlotCount: () => 30 }, entities: {}, findBlock: () => null, findBlocks: () => []
  }
  const actions = ['eat', 'hunt', 'smelt', 'craft', 'harvest', 'goto', 'find_food', 'start_farm']
  const calls: string[] = []
  const params: any[] = []
  const farms: any[] = []
  const agent: any = {
    canDig: true,
    getAction: (n: string) => actions.includes(n) ? { name: n } : undefined,
    protectedAreas: { isProtected: () => false },
    storage: { get: (k: string, fb: unknown) => k === 'farms' ? farms : fb, set: () => {} }
  }
  const act = async (name: string, p: any = {}): Promise<ActionResult> => {
    calls.push(name)
    params.push(p)
    if (name === 'find_food') return fail('scouted 180 blocks east and north-east of home, no animals or village crops; stopped: walked 24 legs')
    if (name === 'start_farm') { farms.push({ name: 'farm:1', x: 5, y: 63, z: 5, size: 9, created: Date.now() }); return ok('started a 9x9 wheat farm at 5 63 5 (farm:1): tilled 80, planted 5') }
    return fail('unexpected')
  }
  const o = defaultBehaviorRegistry().validate('keep_fed', {})
  const b = keepFed.create!((o as any).options, { agent })
  const r: any = await b.run({ agent, bot, bb: { needs: { hunger: 0.6 } }, log: createLogger('t'), now: 0, current: null, signal: new AbortController().signal, act, wait: async () => {} } as any)
  assert.deepEqual(calls, ['find_food', 'find_food', 'find_food', 'find_food', 'find_food', 'start_farm'])
  assert.deepEqual(params.slice(0, 5).map(p => [p.radius, p.minRadius, p.seeds]), [[48, 0, 3], [120, 48, 3], [250, 120, 3], [400, 250, 3], [600, 400, 3]],
    'each ring only after the smaller one came up empty; picks up the 3 seeds it lacks on the way')
  assert.equal(r.ok, false)
  assert.match(r.message, /still hungry \(food 8\/20\)/)
  assert.match(r.message, /scouted 180 blocks east/)
  assert.match(r.message, /started a 9x9 wheat farm at 5 63 5/)
})

test('keep_fed: after the 250 ring it walks to a known village (foodPlaces) before the far rings', async () => {
  const inv = [{ name: 'wheat_seeds', count: 5, type: mcData.itemsByName.wheat_seeds.id }]
  const pos: any = { x: 0, y: 64, z: 0, distanceTo: () => 0, offset: () => pos, floored: () => pos, clone: () => ({ set: () => pos }) }
  const bot: any = {
    food: 8, health: 12, entity: { position: pos }, registry: mcData, time: { timeOfDay: 2000 }, game: { dimension: 'minecraft:overworld' },
    inventory: { items: () => inv, emptySlotCount: () => 30 }, entities: {}, findBlock: () => null, findBlocks: () => []
  }
  const actions = ['eat', 'hunt', 'smelt', 'craft', 'harvest', 'goto', 'find_food', 'start_farm']
  const calls: string[] = []
  const params: any[] = []
  const agent: any = {
    canDig: true,
    getAction: (n: string) => actions.includes(n) ? { name: n } : undefined,
    protectedAreas: { isProtected: () => false },
    storage: { get: (_k: string, fb: unknown) => fb, set: () => {} },
    say: () => {}
  }
  const act = async (name: string, p: any = {}): Promise<ActionResult> => {
    calls.push(name)
    params.push(p)
    if (name === 'find_food') return fail('scouted, no animals or village crops; stopped: walked 24 legs')
    if (name === 'goto') return ok(`arrived at ${p.x} 70 ${p.z}`)
    if (name === 'harvest') return ok('harvested 20 crops, replanted 20')
    return fail('unexpected')
  }
  const o = defaultBehaviorRegistry().validate('keep_fed', { startFarm: false, foodPlaces: [{ name: 'village', x: -2770, z: 1090, crops: ['wheat', 'carrots'] }] })
  assert.ok(o.ok)
  const b = keepFed.create!((o as any).options, { agent })
  const r: any = await b.run({ agent, bot, bb: { needs: { hunger: 0.6 } }, log: createLogger('t'), now: 0, current: null, signal: new AbortController().signal, act, wait: async () => {} } as any)
  assert.deepEqual(calls.slice(0, 5), ['find_food', 'find_food', 'find_food', 'goto', 'harvest'])
  assert.deepEqual(params[3], { x: -2770, z: 1090 }, 'no y: travel to the surface there')
  assert.deepEqual(params.filter((_p, i) => calls[i] === 'find_food').map(p => p.radius), [48, 120, 250, 400, 600], 'the far rings still come after the trip')
  assert.match(r.message, /trip to village \(2977 blocks away, wheat, carrots\): harvested 20 crops/)
})

test('scouting at low health: allowed when nothing is around, stopped with mobs near', async () => {
  const { scoutStopReason } = await import('../src/skills/foodPlan.ts')
  const base = { night: false, health: 1, hostilesNear: 0, consecutiveFailures: 0, legs: 0, walked: 0, elapsedMs: 0 }
  assert.equal(scoutStopReason(base as any), null, 'starving and alone: go find food')
  assert.match(scoutStopReason({ ...base, hostilesNear: 1 } as any)!, /health is low/)
})
