// Starting over somewhere else (src/skills/startOverPlan.ts): settings, the pack ranking, the
// heading, the site verdict and the state machine.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  startOverSettings, START_OVER_DEFAULTS, packPlan, dryLegHeading, packValue, gearSlot, chooseHeading, headingAfterBlock, angleCompass,
  siteVerdict, fallbackOk, startOverStep, betterBest, inAvoided, nameMatches,
  type StartOverState, type SiteFacts, type StepFacts
} from '../src/skills/startOverPlan.ts'

const FOOD: Record<string, number> = { bread: 5, cooked_beef: 8, apple: 4, rotten_flesh: 0 }
const fp = (n: string) => FOOD[n] ?? 0
const stack = (n: string) => /_sword$|_pickaxe$|_axe$|_helmet$|_chestplate$|_leggings$|_boots$|shield|bow|_bed$|bucket/.test(n) ? 1 : n === 'snowball' || n === 'ender_pearl' ? 16 : 64

test('settings: per-key fallback', () => {
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
  assert.ok(inAvoided({ x: 545, z: 100 }, [spawn]))
  // a leg over water turns to the first dry detour
  assert.equal(dryLegHeading(270, 0, h => h === 270 ? true : h === 315 ? true : null), 225)
  assert.equal(dryLegHeading(270, 0, () => false), 270)
  assert.equal(dryLegHeading(270, 0, () => true), 270)
})

const GOOD: SiteFacts = { biome: 'plains', snowy: false, grass: 120, logs: 30, water: 4, animals: 5, buildBlocks: 0, protected: false }

test('site verdict', () => {
  const s = START_OVER_DEFAULTS
  assert.equal(siteVerdict(GOOD, s).ok, true)
  const snow = siteVerdict({ ...GOOD, snowy: true, biome: 'snowy_taiga' }, s)
  assert.equal(snow.ok, false)
  assert.match(snow.why, /snowy/)
  assert.match(siteVerdict({ ...GOOD, buildBlocks: 40 }, s).why, /build/)
  assert.match(siteVerdict({ ...GOOD, animals: 0 }, s).why, /few animals/)
  assert.ok(siteVerdict(GOOD, s).score > siteVerdict({ ...GOOD, logs: 2 }, s).score)
  assert.equal(fallbackOk({ ...GOOD, animals: 0, water: 0 }, s), true)
  assert.equal(fallbackOk({ ...GOOD, snowy: true }, s), false)
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
  assert.equal(startOverStep(st({ shelterFails: 3 }), day({ x: 100, z: 0 }, { isNight: true, daylightMs: 0 }), S).do, 'leg')
  assert.equal(startOverStep(st({}), day({ x: 100, z: 0 }, { daylightMs: 10_000 }), S).do, 'wait')
  // a blocked leg turns 45 degrees
  const det = startOverStep(st({ fails: 1 }), day({ x: 100, z: 0 }), S)
  if (det.do === 'leg') assert.equal(det.heading, 45); else assert.fail(det.do)
})

test('state machine: looks once far enough, settles on a good place', () => {
  assert.equal(startOverStep(st({}), day({ x: 520, z: 0 }), S).do, 'look')
  const good = startOverStep(st({}), day({ x: 520, z: 0 }, { site: GOOD }), S)
  assert.equal(good.do, 'settle')
  const bad = startOverStep(st({}), day({ x: 520, z: 0 }, { site: { ...GOOD, snowy: true } }), S)
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
  if (turn.do === 'turn') assert.equal(turn.heading, 90)
  // after a turn the range counts the legs since
  assert.equal(startOverStep(st({ turns: 1, legsSinceTurn: 2 }), far, S).do, 'leg')
  assert.equal(startOverStep(st({ turns: 2, legsSinceTurn: 10 }), far, S).do, 'give_up')
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
  const r = abandonedState(k => store[k], { x: 560, y: 67, z: -43, dim: 'overworld' })
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

test('state machine: snow look after look turns the heading', () => {
  const t = startOverStep(st({ snowyLooks: 3 }), day({ x: 600, z: 0 }), S)
  assert.equal(t.do, 'turn')
  if (t.do === 'turn') assert.equal(t.heading, 90)
  assert.equal(startOverStep(st({ snowyLooks: 2 }), day({ x: 600, z: 0 }), S).do, 'look')
  assert.equal(startOverStep(st({ snowyLooks: 3, turns: 2 }), day({ x: 600, z: 0 }), S).do, 'look', 'no turns left')
  assert.equal(startOverStep(st({ snowyLooks: 5 }), day({ x: 600, z: 0 }), startOverSettings({ snowTurnAfter: 0 })).do, 'look')
})

test('night shelter fallback: protected ground does not count', async () => {
  const { shelterFallback } = await import('../src/skills/startOverPlan.ts')
  assert.deepEqual(shelterFallback("can't dig in here (protected area); move away first"), { counts: false, step: 24 })
  assert.deepEqual(shelterFallback('ground here is too thin or unsafe to dig a shelter'), { counts: true, step: 12 })
})
