// Starting over somewhere else (src/skills/startOverPlan.ts): settings, the pack ranking, the
// heading, the site verdict and the state machine.
import { test } from 'node:test'
import { TOGGLES, getPath } from '../src/core/toggles.ts'
import assert from 'node:assert/strict'
import {
  startOverSettings, START_OVER_DEFAULTS, packPlan, dryLegHeading, packValue, gearSlot, chooseHeading, headingAfterBlock, angleCompass,
  siteVerdict, fallbackOk, startOverStep, betterBest, inAvoided, nameMatches,
  type StartOverState, type SiteFacts, type StepFacts
} from '../src/skills/startOverPlan.ts'

const FOOD: Record<string, number> = { bread: 5, cooked_beef: 8, apple: 4, rotten_flesh: 0 }
const fp = (n: string) => FOOD[n] ?? 0
const stack = (n: string) => /_sword$|_pickaxe$|_axe$|_helmet$|_chestplate$|_leggings$|_boots$|shield|bow|_bed$|bucket/.test(n) ? 1 : n === 'snowball' || n === 'ender_pearl' ? 16 : 64

test('settings: per-key fallback from the toggle schemas', () => {
  // every settings key has a toggle (one source of truth for its type and range) and vice versa
  const keys = (o: object, pre = ''): string[] => Object.entries(o).flatMap(([k, v]) => v && typeof v === 'object' && !Array.isArray(v) ? keys(v, `${pre}${k}.`) : [`${pre}${k}`])
  const toggles = TOGGLES.filter(t => t.key.startsWith('startOver.')).map(t => t.key.slice('startOver.'.length)).sort()
  assert.deepEqual(keys(START_OVER_DEFAULTS).sort(), toggles)
  // the defaults pass their own schemas
  for (const t of TOGGLES.filter(t => t.key.startsWith('startOver.'))) assert.ok(t.schema.safeParse(getPath(START_OVER_DEFAULTS as never, t.key.slice(10))).success, t.key)
  const n = startOverSettings({ weights: { grass: 2, logs: 'x' }, fallback: { grass: 3 }, detours: [30, 60, 120], badBiomes: 'desert, *_badlands' })
  assert.equal(n.weights.grass, 2)
  assert.equal(n.weights.logs, START_OVER_DEFAULTS.weights.logs)
  assert.deepEqual(n.fallback, { grass: 3, logs: START_OVER_DEFAULTS.fallback.logs })
  assert.deepEqual(n.detours, [30, 60, 120])
  assert.deepEqual(n.badBiomes, ['desert', '*_badlands'])
  assert.equal(startOverSettings({ avoidRadius: 50, avoid: [{ x: 1, z: 2 }] }).avoid[0]!.radius, 50)
  assert.equal(startOverSettings({ maxTurns: 9 }).maxTurns, START_OVER_DEFAULTS.maxTurns)
  // defaults are not shared between calls
  startOverSettings({}).badBiomes.push('x')
  assert.ok(!START_OVER_DEFAULTS.badBiomes.includes('x'))

  const s = startOverSettings({ go: true, minDistance: 'far', maxDistance: 900, direction: 'NE', take: 'spruce_log, *_sapling', avoid: [{ x: 1, z: 2 }, { x: 'a' }] })
  assert.equal(s.go, true)
  assert.equal(s.minDistance, START_OVER_DEFAULTS.minDistance)
  assert.equal(s.maxDistance, 900)
  assert.equal(s.direction, 'ne')
  assert.deepEqual(s.take, ['spruce_log', '*_sapling'])
  assert.deepEqual(s.avoid, [{ x: 1, z: 2, radius: 400 }])
  assert.equal(startOverSettings({ direction: 'up' }).direction, '')
  assert.equal(startOverSettings(undefined).go, false)
  // max is always beyond min
  assert.ok(startOverSettings({ minDistance: 1000, maxDistance: 500 }).maxDistance > 1000)
})

test('pack: precious things first, junk stays', () => {
  const chests = { snowball: 400, dirt: 200, gravel: 100, cobblestone: 800, spruce_log: 500, raw_copper: 101, redstone: 6, arrow: 12, diamond: 3, iron_ingot: 20, bread: 10, wheat_seeds: 30, iron_sword: 1, white_bed: 1, string: 1 }
  const picks = packPlan({ chests, inventory: { stone_sword: 1, stone_pickaxe: 1 }, freeSlots: 30, stackSize: stack, foodPoints: fp, keepFree: 2 })
  const names = picks.map(p => p.name)
  assert.equal(names[0], 'diamond')
  assert.ok(names.includes('iron_sword'), 'better sword than the stone one')
  assert.ok(names.includes('white_bed'))
  assert.ok(!names.includes('snowball') && !names.includes('dirt') && !names.includes('gravel'))
  assert.equal(picks.find(p => p.name === 'spruce_log')!.count, 64, 'a stack of logs')
  assert.equal(picks.find(p => p.name === 'cobblestone')!.count, 64)
  assert.equal(picks.find(p => p.name === 'bread')!.count, 10)
  assert.ok(names.indexOf('iron_ingot') < names.indexOf('spruce_log'))
})

test('pack: only as much as fits, the most valuable first', () => {
  const chests = { diamond: 5, iron_ingot: 300, spruce_log: 500, cobblestone: 500 }
  const picks = packPlan({ chests, inventory: {}, freeSlots: 3, stackSize: stack, foodPoints: fp })
  assert.deepEqual(picks.map(p => [p.name, p.count]), [['diamond', 5], ['iron_ingot', 128]])
})

test('pack: partial stacks fill without new slots', () => {
  const picks = packPlan({ chests: { torch: 30 }, inventory: { torch: 20 }, freeSlots: 0, stackSize: stack, foodPoints: fp })
  // caps at 64 carried, and the 44 free in its stack fit without a slot
  assert.deepEqual(picks, [{ name: 'torch', count: 30, value: 60, why: 'stock' }])
})

test('pack: gear only when better than what it carries', () => {
  const picks = packPlan({ chests: { stone_sword: 1, iron_pickaxe: 1, wooden_pickaxe: 2, iron_helmet: 1 }, inventory: { diamond_sword: 1, stone_pickaxe: 1 }, freeSlots: 10, stackSize: stack, foodPoints: fp })
  assert.deepEqual(picks.map(p => p.name).sort(), ['iron_helmet', 'iron_pickaxe'])
})

test('pack: take and leave lists', () => {
  const picks = packPlan({ chests: { snowball: 32, diamond: 2, granite: 10 }, inventory: {}, freeSlots: 10, stackSize: stack, foodPoints: fp, take: ['gran*'], leave: ['diamond'] })
  assert.deepEqual(picks.map(p => p.name), ['granite'])
  assert.equal(packValue('rotten_flesh', fp), null)
  assert.ok(nameMatches('*_sapling', 'oak_sapling'))
  assert.equal(gearSlot('red_bed'), 'bed')
})

test('pack: food capped at a stack in total', () => {
  const picks = packPlan({ chests: { bread: 50, cooked_beef: 50 }, inventory: { apple: 10 }, freeSlots: 10, stackSize: stack, foodPoints: fp })
  assert.equal(picks.reduce((s, p) => s + p.count, 0), 54)
  assert.equal(picks[0]!.name, 'cooked_beef')
})

test('heading: away from spawn, given direction wins', () => {
  const base = { x: 560, z: -43 }
  const spawn = { x: 545, z: 45, radius: 300 }
  const village = { x: -2770, z: 1090, radius: 400 }
  const h = chooseHeading(base, [spawn, village], 1500)
  // spawn is south of the base: anything with a southern part runs into it
  assert.ok(['n', 'ne', 'nw'].includes(angleCompass(h)), angleCompass(h))
  assert.equal(angleCompass(chooseHeading(base, [spawn], 1500, 'e')), 'e')
  assert.equal(chooseHeading(base, [], 1000), 0)
  assert.equal(headingAfterBlock(0, 0), 0)
  assert.equal(headingAfterBlock(0, 1), 45)
  assert.equal(headingAfterBlock(0, 2), -45)
  assert.equal(headingAfterBlock(0, 5), 45)
  assert.equal(headingAfterBlock(0, 3, [30, 60]), 60)
  assert.equal(dryLegHeading(0, 0, h => h === 0, [20]), 20)
  assert.ok(inAvoided({ x: 545, z: 100 }, [spawn]))
  // a leg over water turns to the first dry detour
  assert.equal(dryLegHeading(270, 0, h => h === 270 ? true : h === 315 ? true : null), 225)
  assert.equal(dryLegHeading(270, 0, () => false), 270)
  assert.equal(dryLegHeading(270, 0, () => true), null, 'water all round: none')
})

const GOOD: SiteFacts = { biome: 'plains', cold: false, grass: 120, logs: 30, water: 4, animals: 5, buildBlocks: 0, protected: false }

test('site verdict', () => {
  const s = START_OVER_DEFAULTS
  assert.equal(siteVerdict(GOOD, s).ok, true)
  const snow = siteVerdict({ ...GOOD, biome: 'snowy_taiga' }, s)
  assert.equal(snow.ok, false)
  assert.match(snow.why, /bad biome/)
  assert.match(siteVerdict({ ...GOOD, cold: true }, s).why, /cold/)
  // the bad biomes are a setting: any list, empty = any biome, cold only with badCold
  assert.equal(siteVerdict({ ...GOOD, biome: 'snowy_taiga', cold: true }, { ...s, badBiomes: [], badCold: false }).ok, true)
  assert.equal(siteVerdict({ ...GOOD, biome: 'desert' }, { ...s, badBiomes: ['desert', '*_badlands'] }).ok, false)
  assert.equal(siteVerdict({ ...GOOD, biome: 'minecraft:wooded_badlands' }, { ...s, badBiomes: ['desert', '*_badlands'] }).ok, false)
  assert.ok(siteVerdict({ ...GOOD, biome: 'snowy_taiga' }, s).score === siteVerdict(GOOD, s).score - s.weights.badBiome)
  // the score weights are knobs too
  assert.ok(siteVerdict(GOOD, { ...s, weights: { ...s.weights, animals: 100 } }).score > siteVerdict(GOOD, s).score)
  assert.match(siteVerdict({ ...GOOD, buildBlocks: 40 }, s).why, /build/)
  assert.match(siteVerdict({ ...GOOD, animals: 0 }, s).why, /few animals/)
  assert.ok(siteVerdict(GOOD, s).score > siteVerdict({ ...GOOD, logs: 2 }, s).score)
  assert.equal(fallbackOk({ ...GOOD, animals: 0, water: 0 }, s), true)
  assert.equal(fallbackOk({ ...GOOD, biome: 'frozen_river' }, s), false)
  assert.equal(fallbackOk({ ...GOOD, grass: 10 }, { ...s, fallback: { grass: 20, logs: 4 } }), false)
})

const S = startOverSettings({ minDistance: 500, maxDistance: 1500, legLength: 100 })
const origin = { x: 0, y: 64, z: 0 }
const st = (o: Partial<StartOverState>): StartOverState => ({ phase: 'travelling', startedAt: 0, by: 'pe4ka', origin, heading: 0, ...o })
const day = (pos: { x: number, z: number }, o: Partial<StepFacts> = {}): StepFacts => ({ pos: { ...pos, y: 64 }, isNight: false, daylightMs: 300_000, ...o })

test('state machine: phases', () => {
  assert.equal(startOverStep(null, day({ x: 0, z: 0 }), S).do, 'none')
  assert.equal(startOverStep(st({ phase: 'packing' }), day({ x: 0, z: 0 }), S).do, 'pack')
  assert.equal(startOverStep(st({ phase: 'packing' }), day({ x: 0, z: 0 }, { isNight: true, daylightMs: 0 }), S).do, 'wait')
  assert.equal(startOverStep(st({ phase: 'packing' }), day({ x: 0, z: 0 }, { daylightMs: 60_000 }), S).do, 'wait')
  assert.equal(startOverStep(st({ phase: 'settled' }), day({ x: 0, z: 0 }), S).do, 'none')
  assert.equal(startOverStep(st({ phase: 'failed' }), day({ x: 0, z: 0 }), S).do, 'none')
  const settle = startOverStep(st({ phase: 'settling', target: { x: 600, y: 70, z: 0, why: 'ok' } }), day({ x: 0, z: 0 }), S)
  assert.deepEqual(settle, { do: 'settle', at: { x: 600, y: 70, z: 0, why: 'ok' }, why: 'ok' })
})

test('state machine: walks by day, shelters by night, waits at dusk', () => {
  const near = startOverStep(st({}), day({ x: 100, z: 0 }), S)
  assert.equal(near.do, 'leg')
  if (near.do === 'leg') assert.deepEqual(near.target, { x: 200, z: 0 })
  assert.equal(startOverStep(st({}), day({ x: 100, z: 0 }, { isNight: true, daylightMs: 0 }), S).do, 'shelter')
  assert.equal(startOverStep(st({ shelterFails: 3 }), day({ x: 100, z: 0 }, { isNight: true, daylightMs: 0 }), S).do, 'wait')
  assert.equal(startOverStep(st({}), day({ x: 100, z: 0 }, { daylightMs: 10_000 }), S).do, 'wait')
  // a blocked leg turns 45 degrees
  const det = startOverStep(st({ fails: 1 }), day({ x: 100, z: 0 }), S)
  if (det.do === 'leg') assert.equal(det.heading, 45); else assert.fail(det.do)
})

test('state machine: looks once far enough, settles on a good place', () => {
  assert.equal(startOverStep(st({}), day({ x: 520, z: 0 }), S).do, 'look')
  const good = startOverStep(st({}), day({ x: 520, z: 0 }, { site: GOOD }), S)
  assert.equal(good.do, 'settle')
  const bad = startOverStep(st({}), day({ x: 520, z: 0 }, { site: { ...GOOD, biome: 'snowy_plains' } }), S)
  assert.equal(bad.do, 'leg')
  // inside an avoided area: doesn't look, walks on
  assert.equal(startOverStep(st({}), day({ x: 520, z: 0 }, { avoided: true }), S).do, 'leg')
})

test('state machine: range used up: best fallback, else turn, else give up', () => {
  const far = day({ x: 1500, z: 0 }, { site: null })
  const best = { x: 900, y: 70, z: 0, score: 50, why: 'grass 30', fallback: true }
  assert.equal(startOverStep(st({ best }), far, S).do, 'settle')
  const turn = startOverStep(st({ best: { ...best, fallback: false } }), far, S)
  assert.equal(turn.do, 'turn')
  // away from the old base, not back and not the way it came
  if (turn.do === 'turn') assert.ok(['se', 'ne'].includes(angleCompass(turn.heading)), angleCompass(turn.heading))
  // after a turn the range counts the legs since
  assert.equal(startOverStep(st({ turns: 1, legsSinceTurn: 2 }), far, S).do, 'leg')
  // the range after a turn counts blocks walked, not legs (short mountain legs)
  assert.equal(startOverStep(st({ turns: 1, legsSinceTurn: 20, walkedSinceTurn: 400 }), far, S).do, 'leg')
  assert.equal(startOverStep(st({ turns: 1, legsSinceTurn: 2, walkedSinceTurn: 1000, best: { ...best, fallback: false } }), far, S).do, 'turn')
  assert.equal(startOverStep(st({ turns: 2, legsSinceTurn: 10 }), far, S).do, 'give_up')
  // out of turns with a place looked at: settle at the best one even if it isn't fallback-worthy
  assert.equal(startOverStep(st({ turns: 2, legsSinceTurn: 10, best: { ...best, fallback: false } }), far, S).do, 'settle')
})

test('best place so far', () => {
  const a = betterBest(undefined, { x: 1, y: 2, z: 3 }, { ok: false, score: 10, why: 'a' }, false)
  const b = betterBest(a, { x: 4, y: 5, z: 6 }, { ok: false, score: 5, why: 'b' }, true)
  assert.equal(b!.x, 4, 'fallback-worthy beats a higher score')
  const c = betterBest(b, { x: 7, y: 8, z: 9 }, { ok: false, score: 50, why: 'c' }, false)
  assert.equal(c!.x, 4)
  const d = betterBest(c, { x: 7, y: 8, z: 9 }, { ok: false, score: 50, why: 'd' }, true)
  assert.equal(d!.x, 7)
})

test('leaving the old base: anchored state dropped, world knowledge kept', async () => {
  const { abandonedState } = await import('../src/skills/startOverPlan.ts')
  const store: Record<string, unknown> = {
    home: { x: 560, y: 68, z: -46 },
    places: { fortress: { x: 560, y: 68, z: -43 }, 'farm:3': { x: 2000, y: 64, z: 0 }, hut_outside: { x: 539, y: 95, z: 83 }, 'found:iron': { x: 3000, y: 40, z: 10 } },
    sites: { 'farm|farm:1': { kind: 'farm', pos: { x: 561, y: 62, z: -20 } }, 'mine|m': { kind: 'mine', pos: { x: 3000, y: 10, z: 0 } }, 'chest|a': { kind: 'chest', pos: { x: 559, y: 69, z: -47 } } },
    'containers.memory': { 'srv|overworld': { '559 69 -47': { block: 'chest' }, '3000 64 0': { block: 'barrel' } } },
    foodSpots: [{ kind: 'animals', x: 586, z: -64 }, { kind: 'animals', x: 1500, z: 900 }],
    foodLadder: { searches: [{ radius: 48 }], paused: { farm: 1 } }
  }
  const r = abandonedState(k => store[k], { x: 560, y: 67, z: -43, dim: 'overworld' }, 256, { keys: ['projects.spots', 'farms'], places: ['farm:*', 'fortress'] })
  assert.ok(r.del.includes('home') && r.del.includes('projects.spots') && r.del.includes('farms'))
  assert.deepEqual(Object.keys(r.set.places as object).sort(), ['found:iron', 'old_base'])
  assert.deepEqual((r.set.places as Record<string, unknown>).old_base, { x: 560, y: 67, z: -43, dimension: 'overworld' })
  assert.deepEqual(Object.keys(r.set.sites as object), ['mine|m'])
  assert.deepEqual(Object.keys((r.set['containers.memory'] as Record<string, object>)['srv|overworld']!), ['3000 64 0'])
  assert.equal((r.set.foodSpots as unknown[]).length, 1)
  assert.deepEqual(r.set.foodLadder, { searches: [], paused: { farm: 1 } })
})

test('chests pinned at the old base no longer count', async () => {
  const { atOldBase } = await import('../src/skills/startOverPlan.ts')
  const { configuredChests, configuredChestRoles } = await import('../src/skills/containers.ts')
  const places: Record<string, unknown> = { old_base: { x: 560, y: 68, z: -46 } }
  assert.equal(atOldBase(places, { x: 559, z: -47 }), true)
  assert.equal(atOldBase(places, { x: 1559, z: -47 }), false)
  assert.equal(atOldBase({}, { x: 559, z: -47 }), false)
  const store = new Map<string, unknown>([['places', places]])
  const agent = { settings: { storage: { chests: [{ at: [559, 69, -47], role: 'pantry' }, { at: [2000, 64, 0], role: 'gear' }] } }, storage: { get: (k: string, fb?: unknown) => store.has(k) ? store.get(k) : fb } } as never
  assert.deepEqual(configuredChests(agent), [{ x: 2000, y: 64, z: 0 }])
  assert.deepEqual(configuredChestRoles(agent).map(c => c.role), ['gear'])
  store.delete('places')
  assert.equal(configuredChests(agent).length, 2)
})

test('state machine: rejected look after look turns the heading', () => {
  const t = startOverStep(st({ rejects: 3 }), day({ x: 600, z: 0 }), S)
  assert.equal(t.do, 'turn')
  assert.equal(startOverStep(st({ rejects: 2 }), day({ x: 600, z: 0 }), S).do, 'look')
  assert.equal(startOverStep(st({ rejects: 3, turns: 2 }), day({ x: 600, z: 0 }), S).do, 'look', 'no turns left')
  assert.equal(startOverStep(st({ rejects: 5 }), day({ x: 600, z: 0 }), startOverSettings({ turnAfterRejects: 0 })).do, 'look')
  assert.equal(startOverStep(st({ rejects: 4 }), day({ x: 600, z: 0 }), startOverSettings({ turnAfterRejects: 5 })).do, 'look')
})

test('night shelter fallback: protected ground does not count', async () => {
  const { shelterFallback } = await import('../src/skills/startOverPlan.ts')
  assert.deepEqual(shelterFallback("can't dig in here (protected area); move away first"), { counts: false, step: 24 })
  assert.deepEqual(shelterFallback('ground here is too thin or unsafe to dig a shelter'), { counts: true, step: 12 })
})

test('go fires once per run id; settle retries', async () => {
  const { goFires, settleRetry } = await import('../src/skills/startOverPlan.ts')
  assert.equal(goFires(null, { go: true, run: '' }), true)
  assert.equal(goFires(null, { go: false, run: '' }), false)
  assert.equal(goFires({ phase: 'settled' }, { go: true, run: '' }), false)
  assert.equal(goFires({ phase: 'settled' }, { go: true, run: '2' }), true)
  assert.equal(goFires({ phase: 'settled', run: '2' }, { go: true, run: '2' }), false)
  assert.equal(goFires({ phase: 'travelling' }, { go: true, run: '3' }), false, 'not while one runs')
  assert.equal(startOverSettings({ run: 2 }).run, '2')
  assert.equal(settleRetry(0, 600), true)
  assert.equal(settleRetry(5, 600), false)
  assert.equal(settleRetry(0, 30), false)
})

test('a second start-over keeps the first old base', async () => {
  const { abandonedState } = await import('../src/skills/startOverPlan.ts')
  const store: Record<string, unknown> = { places: { old_base: { x: 560, y: 68, z: -46 } } }
  const r = abandonedState(k => store[k], { x: 1092, y: 148, z: -68 })
  assert.deepEqual((r.set.places as Record<string, unknown>).old_base, { x: 560, y: 68, z: -46 })
})

test('a new run id while travelling redirects the run', async () => {
  const { redirected } = await import('../src/skills/startOverPlan.ts')
  const cur = st({ heading: 270, turns: 2, walkedSinceTurn: 900, rejects: 2, run: '2' })
  const r = redirected(cur, { go: true, run: '3', direction: 'w' })!
  assert.equal(r.heading, 180)
  assert.equal(r.turns, 0)
  assert.equal(r.walkedSinceTurn, 0)
  assert.equal(r.rejects, 0)
  assert.equal(r.run, '3')
  assert.deepEqual(r.origin, cur.origin)
  assert.equal(redirected(cur, { go: true, run: '2', direction: 'w' }), null)
  assert.equal(redirected({ ...cur, phase: 'settled' }, { go: true, run: '3', direction: 'w' }), null)
})

test('ice counts as water for legs', async () => {
  const { wetTop } = await import('../src/skills/startOverPlan.ts')
  for (const n of ['water', 'ice', 'packed_ice', 'blue_ice', 'kelp']) assert.equal(wetTop(n), true, n)
  for (const n of ['grass_block', 'snow_block', 'snow', 'dirt', 'stone']) assert.equal(wetTop(n), false, n)
})

test('turns: the best untried heading against the avoid points and the old base', async () => {
  const { turnHeading, applyTurn } = await import('../src/skills/startOverPlan.ts')
  // heading north (270) 600 blocks north of the old base, spawn to the east
  const cur = st({ heading: 270 })
  const spawn = { x: 400, z: -600, radius: 300, name: 'spawn' }
  const h = turnHeading(cur, { x: 0, z: -600 }, [spawn], S)!
  assert.ok(['w', 'nw'].includes(angleCompass(h)), angleCompass(h))
  // every heading tried: none left
  assert.equal(turnHeading(st({ heading: 0, tried: [0, 45, 90, 135, 180, 225, 270, 315] }), { x: 0, z: 0 }, [], S), null)
  // wet headings are left out
  const dry = turnHeading(cur, { x: 0, z: -600 }, [], S, d => d !== 0)
  assert.equal(dry, 0)
  // a turn remembers the headings tried and starts a fresh range
  const t = applyTurn(st({ heading: 270, rejects: 3, fails: 2, walkedSinceTurn: 300, turns: 0 }), 180)
  assert.deepEqual(t.tried, [270, 180])
  assert.deepEqual([t.turns, t.rejects, t.fails, t.walkedSinceTurn, t.heading], [1, 0, 0, 0, 180])
  // a second turn doesn't pick a tried heading
  const again = turnHeading(t, { x: -300, z: -600 }, [], S)!
  assert.ok(![270, 180].includes(again))
})

test('state machine: an ocean ahead turns from land, swims on from the water', () => {
  const allWet = () => true
  const t = startOverStep(st({ heading: 180 }), day({ x: 100, z: 0 }, { wet: allWet }), S)
  assert.equal(t.do, 'leg', 'water everywhere: no dry heading to turn to either, so it swims')
  const someDry = (d: number) => d !== 90
  const o = startOverStep(st({ heading: 180 }), day({ x: 100, z: 0 }, { wet: (d: number) => [180, 225, 135, 270, 90].includes(((d % 360) + 360) % 360) ? true : !someDry(d) }), S)
  assert.equal(o.do, 'turn')
  if (o.do === 'turn') assert.ok(![180, 225, 135, 270, 90].includes(o.heading))
  assert.equal(startOverStep(st({ heading: 180 }), day({ x: 100, z: 0 }, { wet: allWet, swimming: true }), S).do, 'leg')
  assert.equal(startOverStep(st({ heading: 180, turns: 2 }), day({ x: 100, z: 0 }, { wet: allWet }), S).do, 'leg', 'no turns left')
  // around a lake: the first dry detour, marked
  const lake = startOverStep(st({ heading: 0 }), day({ x: 100, z: 0 }, { wet: (d: number) => d === 0 }), S)
  if (lake.do === 'leg') { assert.equal(lake.heading, 45); assert.equal(lake.around, true) } else assert.fail(lake.do)
})

test('state machine: waits outside the old base dimension; dimensions setting', async () => {
  const { dimensionOk } = await import('../src/skills/startOverPlan.ts')
  const w = startOverStep(st({ origin: { ...origin, dim: 'overworld' } }), day({ x: 100, z: 0 }, { dim: 'minecraft:the_nether' }), S)
  assert.equal(w.do, 'wait')
  assert.equal(startOverStep(st({ origin: { ...origin, dim: 'overworld' } }), day({ x: 100, z: 0 }, { dim: 'minecraft:overworld' }), S).do, 'leg')
  assert.equal(dimensionOk('minecraft:the_nether', S), false)
  assert.equal(dimensionOk('overworld', S), true)
  assert.equal(dimensionOk('the_nether', startOverSettings({ dimensions: ['overworld', 'the_nether'] })), true)
})

test('step results: look, leg, leave, day, bunker, settle', async () => {
  const { applyLook, applyLeg, applyLeave, applyDay, applyShelterFail, settleNext } = await import('../src/skills/startOverPlan.ts')
  // looks: rejects in a row for any reason, reset by a good one; best kept
  let a = applyLook(st({}), { x: 600, y: 64, z: 0 }, { ...GOOD, animals: 0 }, S)
  assert.equal(a.state.rejects, 1)
  a = applyLook(a.state, { x: 700, y: 64, z: 0 }, { ...GOOD, biome: 'desert' }, { ...S, badBiomes: ['desert'] })
  assert.equal(a.state.rejects, 2)
  assert.equal(a.state.best!.x, 600, 'the fallback-worthy place stays the best')
  assert.equal(applyLook(a.state, { x: 800, y: 64, z: 0 }, GOOD, S).state.rejects, 0)
  // legs: a failed leg that moved under blockedMoved is blocked
  const l = applyLeg(st({ fails: 1 }), { ok: false, moved: 10, dist: 300 }, S)
  assert.deepEqual([l.fails, l.legs, l.walkedSinceTurn, l.farthest], [2, 1, 10, 300])
  assert.equal(applyLeg(st({ fails: 1 }), { ok: false, moved: 40, dist: 300 }, S).fails, 0)
  assert.equal(applyLeg(st({ fails: 1 }), { ok: false, moved: 40, dist: 300 }, { blockedMoved: 64 }).fails, 2)
  // leaving resets everything and remembers the heading as tried
  const lv = applyLeave(st({ phase: 'packing', rejects: 4, turns: 2 }), 90, { diamond: 2 })
  assert.deepEqual([lv.phase, lv.heading, lv.tried, lv.rejects, lv.turns, lv.packed], ['travelling', 90, [90], 0, 0, { diamond: 2 }])
  // day: the night's bunker count goes
  const n = st({ shelterFails: 2 })
  assert.equal(applyDay(n).shelterFails, 0)
  const d0 = st({})
  assert.equal(applyDay(d0), d0)
  // bunkers: counted tries walk shelterStep on until shelterTries, protected ground doesn't count
  let b = applyShelterFail(st({}), 'ground too thin', S)
  assert.deepEqual([b.counts, b.step, b.state.shelterFails], [true, 12, 1])
  b = applyShelterFail(st({ shelterFails: 2 }), 'ground too thin', S)
  assert.deepEqual([b.step, b.state.shelterFails], [0, 3], 'out of tries: waits')
  b = applyShelterFail(st({ shelterFails: 2 }), "can't dig in here (protected area)", { ...S, protectedStep: 40 })
  assert.deepEqual([b.counts, b.step, b.state.shelterFails], [false, 40, 2])
  // settle: retry a far target settleTries times, then here
  const r = settleNext(st({ settleFails: 1 }), 500, S)
  assert.equal(r.do, 'retry')
  if (r.do === 'retry') assert.equal(r.state.settleFails, 2)
  assert.equal(settleNext(st({ settleFails: 5 }), 500, S).do, 'here')
  assert.equal(settleNext(st({}), 30, S).do, 'here')
  assert.equal(settleNext(st({}), 30, { settleTries: 5, settleNear: 10 }).do, 'retry')
})

test('base-anchored keys and places come from the modules that own them', async () => {
  const { abandonedState } = await import('../src/skills/startOverPlan.ts')
  const { baseAnchored, baseAnchoredKeys, baseAnchoredPlaces } = await import('../src/core/baseAnchored.ts')
  // loading the skills registers what each keeps around its base
  await import('../src/skills/index.ts')
  await import('../src/adapters/minecraft-java/behaviors/index.ts')
  for (const k of ['projects.spots', 'projects.state', 'farms', 'build.active', 'spawnBed', 'spawnBed.searches', 'woodcutting.searches', 'food.source', 'food.sources.failed', 'lighting.checked']) {
    assert.ok(baseAnchoredKeys().includes(k), k)
  }
  for (const p of ['farm:*', 'farm_plot', 'furnace']) assert.ok(baseAnchoredPlaces().includes(p), p)
  // a new module adds its own; the drop lists are plain arguments
  baseAnchored({ keys: ['kiln.state'], places: ['kiln'] })
  const store: Record<string, unknown> = { places: { kiln: { x: 5000, y: 64, z: 0 }, 'found:iron': { x: 3000, y: 40, z: 0 } } }
  const r = abandonedState(k => store[k], { x: 0, y: 64, z: 0 }, 256, { keys: baseAnchoredKeys(), places: baseAnchoredPlaces() })
  assert.ok(r.del.includes('kiln.state'))
  assert.deepEqual(Object.keys(r.set.places as object).sort(), ['found:iron', 'old_base'])
})
