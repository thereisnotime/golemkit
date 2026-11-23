// The survival benchmark's pure helpers: tool tiers, gathered items, stuck loops, distance,
// vitals, the test bot's profile clean-up, start checks and the summary / compare math.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  aliveSeconds, compare, compareTable, failureKey, gathered, metric, parseResults, pathLength, startFor, stat, stuckLoops,
  summaryTable, testSettings, tooClose, toolTier, vitals, countTrees, terrainNote, KEEP_AWAY, SCENARIOS, TEST_AREAS, type RunResult
} from '../scripts/survival-stats.ts'

test('toolTier: best tool among items, armour and other items ignored', () => {
  assert.equal(toolTier([]), 0)
  assert.equal(toolTier(['oak_log', 'iron_helmet']), 0)
  assert.equal(toolTier(['wooden_pickaxe', 'stick']), 1)
  assert.equal(toolTier(['wooden_pickaxe', 'stone_axe']), 2)
  assert.equal(toolTier(['minecraft:iron_sword', 'stone_pickaxe']), 3)
  assert.equal(toolTier(['golden_pickaxe']), 1)
})

test('gathered: logs, cobble, food and the rest', () => {
  const g = gathered([{ oak_log: 4, birch_log: 2, oak_planks: 16 }, { cobblestone: 10, cooked_beef: 3, bread: 1 }, { stripped_oak_log: 1, cobbled_deepslate: 2 }])
  assert.deepEqual(g, { logs: 6, cobble: 12, food: 4, other: 17 })
})

test('stuckLoops: same failure with different numbers counts as one loop', () => {
  assert.equal(failureKey('chop_tree', 'no tree within 32 blocks'), failureKey('chop_tree', 'no tree within 64 blocks'))
  const f = [
    ...Array.from({ length: 6 }, (_, i) => ({ action: 'goto', message: `path stopped at ${i} 70 ${i * 3}` })),
    ...Array.from({ length: 3 }, () => ({ action: 'craft', message: 'no crafting table' }))
  ]
  const loops = stuckLoops(f, 5)
  assert.equal(loops.length, 1)
  assert.equal(loops[0]!.count, 6)
  assert.match(loops[0]!.key, /^goto: path stopped at # # #/)
  assert.equal(stuckLoops(f, 2).length, 2)
})

test('pathLength: skips teleports and steps across deaths', () => {
  const d = pathLength([
    { x: 0, z: 0, life: 0 }, { x: 3, z: 4, life: 0 }, { x: 6, z: 8, life: 0 },
    { x: 500, z: 500, life: 0 }, // teleport
    { x: 0, z: 0, life: 1 }, { x: 0, z: 10, life: 1 }
  ])
  assert.equal(d, 20)
})

test('vitals: time-weighted food, seconds at 0, dead samples left out', () => {
  const v = vitals([
    { t: 0, food: 20, health: 20, alive: true },
    { t: 10, food: 0, health: 6, alive: true },
    { t: 40, food: 0, health: 0, alive: false },
    { t: 50, food: 20, health: 20, alive: true }
  ], 60)
  assert.equal(v.foodMin, 0)
  assert.equal(v.healthMin, 6)
  assert.equal(v.foodZeroS, 30)
  assert.equal(v.foodMean, Math.round((20 * 10 + 0 * 30 + 20 * 10) / 50 * 10) / 10)
  assert.deepEqual(vitals([]), { foodMin: null, foodMean: null, foodZeroS: 0, healthMin: null })
})

test('aliveSeconds: dead time between each death and its respawn', () => {
  assert.equal(aliveSeconds(0, 600_000, [], []), 600)
  assert.equal(aliveSeconds(0, 600_000, [100_000], [110_000]), 590)
  assert.equal(aliveSeconds(0, 600_000, [100_000, 590_000], [105_000]), 585)
})

test('testSettings: no trips home, no owner, no public chat, no shared context', () => {
  const s = testSettings({
    storage: { chests: [[559, 69, -47]] }, mining: { minFood: 4 }, context: '/x/profiles/pax', llm: { model: 'm' },
    behaviors: {
      keep_fed: { below: 14, foodPlaces: [{ name: 'village', x: -2770, z: 1090 }] },
      follow_owner: { player: 'Robin' }, bodyguard: { enabled: false, player: 'Robin' },
      keep_spawn_bed: { homeRange: 6, ask: true }, idle_antics: { chat: 0.15 }, anti_afk: { afterSeconds: 45 }
    }
  })
  const b = s.behaviors as Record<string, any>
  assert.equal(s.storage, undefined)
  assert.equal(s.llm, undefined)
  assert.equal(s.context, false)
  assert.deepEqual(s.mining, { minFood: 4 })
  assert.deepEqual(b.keep_fed, { below: 14 })
  assert.equal(b.follow_owner, false)
  assert.equal(b.bodyguard, false)
  assert.deepEqual(b.keep_spawn_bed, { homeRange: 6, ask: false })
  assert.deepEqual(b.idle_antics, { chat: 0 })
  assert.deepEqual(b.anti_afk, { afterSeconds: 45 })
  assert.deepEqual(testSettings({ llm: { model: 'm' } }, true).llm, { model: 'm' })
})

test('testSettings: arms what NPC mode arms on the real bot (the bench keeps a test owner online)', () => {
  const b = testSettings({ behaviors: { chop_wood_loop: { enabled: false, rings: [32, 64] } } }).behaviors as Record<string, any>
  assert.deepEqual(b.chop_wood_loop, { enabled: true, rings: [32, 64] })
  assert.deepEqual(b.deposit_when_full, { enabled: true })
  const custom = testSettings({ npcMode: { arm: { farm_loop: { radius: 8 } } } }).behaviors as Record<string, any>
  assert.deepEqual(custom.farm_loop, { radius: 8, enabled: true })
  assert.equal(custom.chop_wood_loop, undefined)
  assert.equal((testSettings({ npcMode: false }).behaviors as Record<string, any>).chop_wood_loop, undefined)
})

test('start checks: keep-away distances and seeded spread', () => {
  assert.deepEqual(tooClose(1600, 800, KEEP_AWAY), [])
  assert.deepEqual(tooClose(700, 45, KEEP_AWAY).map(p => p.name), ['spawn', 'fortress'])
  assert.deepEqual(startFor(1600, 800, 0, 1, 200), { x: 1600, z: 800 })
  assert.deepEqual(startFor(1600, 800, 3, 1, 0), { x: 1600, z: 800 })
  const a = startFor(1600, 800, 1, 1, 200)
  assert.deepEqual(a, startFor(1600, 800, 1, 1, 200))
  assert.ok(Math.abs(Math.hypot(a.x - 1600, a.z - 800) - 200) < 1)
  assert.notDeepEqual(a, startFor(1600, 800, 2, 1, 200))
})

test('scenarios: every start is 300+ from the keep-away places, forest also from the other test areas', () => {
  for (const [, sc] of Object.entries(SCENARIOS)) assert.deepEqual(tooClose(sc.start[0], sc.start[1], KEEP_AWAY), [])
  const [fx, fz] = SCENARIOS.forest!.start
  assert.deepEqual(tooClose(fx, fz, TEST_AREAS), [])
})

test('countTrees: touching logs are one tree, groups without natural leaves are not trees', () => {
  const trunk = (x: number, z: number, h: number, leafy = true) => Array.from({ length: h }, (_, i) => ({ x, y: 64 + i, z, leafy: leafy && i === h - 1 }))
  assert.equal(countTrees([]), 0)
  assert.equal(countTrees([...trunk(0, 0, 5), ...trunk(1, 1, 4), ...trunk(10, 0, 6)]), 2) // a 2x2-ish trunk and a separate tree
  assert.equal(countTrees([...trunk(0, 0, 5), ...trunk(20, 20, 3, false)]), 1) // log pile
  assert.equal(terrainNote({ biome: 'forest', trees: 3, grass: 40, waterAt: null, animals: { sheep: 1, cow: 2 } }),
    'forest, 3 trees within 32, grass 40, no water seen, animals: cow 2, sheep 1')
})

const run = (tag: string, repeat: number, deaths: number, logs: number, extra: Record<string, unknown> = {}): RunResult =>
  ({ tag, repeat, deaths, gathered: { logs, cobble: 0, food: 0, other: 0 }, aliveS: 1200 - deaths * 10, realMinutes: 20, firstDeathS: deaths ? 300 : null, spawnSet: false, stuckLoops: [], ...extra })

test('metric and stat: flattened keys, booleans, never-died first death', () => {
  const r = run('a', 1, 0, 7, { spawnSet: true })
  assert.equal(metric(r, 'logs'), 7)
  assert.equal(metric(r, 'spawnSet'), 1)
  assert.equal(metric(r, 'firstDeathMin'), 20)
  assert.equal(metric(r, 'stuckLoopCount'), 0)
  assert.equal(metric(r, 'missing'), null)
  const s = stat([2, 4, 6])
  assert.equal(s.mean, 4)
  assert.equal(s.sd, 2)
  assert.equal(stat([5]).sd, null)
})

test('compare: better/worse only beyond the noise', () => {
  const rows = [run('a', 1, 3, 10), run('a', 2, 5, 12), run('b', 1, 0, 11), run('b', 2, 1, 13)]
  const c = compare(rows, 'a', 'b')
  const deaths = c.find(r => r.metric === 'deaths')!
  assert.equal(deaths.delta, -3.5)
  assert.equal(deaths.verdict, 'better') // sd 1.4 / 0.7, delta 3.5
  const logs = c.find(r => r.metric === 'logs')!
  assert.equal(logs.delta, 1)
  assert.equal(logs.verdict, '~') // sd 1.4
  // one run each: the margin is 25% of the larger mean, at least 1
  const one = compare([run('a', 1, 4, 10), run('b', 1, 3, 30)], 'a', 'b')
  assert.equal(one.find(r => r.metric === 'deaths')!.verdict, '~')
  assert.equal(one.find(r => r.metric === 'logs')!.verdict, 'better')
  assert.match(compareTable(rows, 'a', 'b'), /deaths\s+4±1\.4\s+0\.5±0\.7\s+-3\.5\s+better/)
})

test('summaryTable and parseResults', () => {
  const rows = parseResults([JSON.stringify(run('a', 1, 1, 3, { deathCauses: [{ cause: 'slain by Zombie' }], stuckLoops: [{ key: 'goto: x', count: 9 }] })), 'not json', '', JSON.stringify(run('a', 2, 0, 5))].join('\n'))
  assert.equal(rows.length, 2)
  const t = summaryTable(rows)
  assert.match(t, /a#1\s+a#2\s+mean±sd/)
  assert.match(t, /a#1 deaths: slain by Zombie/)
  assert.match(t, /a#1 stuck: goto: x x9/)
})
