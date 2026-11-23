import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseBedMessage, clickOutcome, noteSpawnSet, noteRespawn, spawnAtHome, bedsWorkIn, planBedSpot, bedSpotProblem, nextBedStep,
  bestWool, recordSheepSearch, sleepAskStep, noteSleepMessage, askText, nameList, SLEEP_ASK_DEFAULTS, SHEEP_RING_MEMORY_MS,
  type BedCell, type CellAt, type BedWorld, type SleepAskState, type OwnChest
} from '../src/skills/bedPlan.ts'

const home = { x: 560, y: 68, z: -46, dimension: 'overworld' }
const now = 1_000_000_000

test('parseBedMessage: 1.21.1 texts and keys', () => {
  assert.deepEqual(parseBedMessage('Respawn point set'), { kind: 'set_spawn' })
  assert.deepEqual(parseBedMessage('You can sleep only at night or during thunderstorms'), { kind: 'no_sleep' })
  assert.deepEqual(parseBedMessage('You may not rest now; there are monsters nearby'), { kind: 'not_safe' })
  assert.deepEqual(parseBedMessage('You may not rest now; the bed is too far away'), { kind: 'too_far' })
  assert.deepEqual(parseBedMessage('This bed is obstructed'), { kind: 'obstructed' })
  assert.deepEqual(parseBedMessage('This bed is occupied'), { kind: 'occupied' })
  assert.deepEqual(parseBedMessage('You have no home bed or charged respawn anchor, or it was obstructed'), { kind: 'spawn_not_valid' })
  assert.deepEqual(parseBedMessage('1/3 players sleeping'), { kind: 'players_sleeping', sleeping: 1, needed: 3 })
  assert.deepEqual(parseBedMessage('Sleeping through this night'), { kind: 'skipping_night' })
  assert.deepEqual(parseBedMessage('block.minecraft.set_spawn'), { kind: 'set_spawn' })
  assert.equal(parseBedMessage('<Robin> Respawn point set'), null, 'player chat does not count')
  assert.equal(parseBedMessage('Pax joined the game'), null)
})

test('clickOutcome: the point is set before the day and monster checks', () => {
  assert.equal(clickOutcome('no_sleep')?.set, true)
  assert.equal(clickOutcome('not_safe')?.set, true)
  assert.equal(clickOutcome('set_spawn')?.set, true)
  assert.deepEqual(clickOutcome('too_far'), { set: false, retry: 'closer', why: 'the bed is too far away' })
  assert.equal(clickOutcome('obstructed')?.set, false)
  assert.equal(clickOutcome('occupied')?.set, false)
  assert.equal(clickOutcome('players_sleeping'), null)
})

test('noteRespawn: next to the bed confirms it, world spawn loses it', () => {
  const rec = noteSpawnSet({ x: 561, y: 68, z: -45 }, 'overworld', now, 'click')
  assert.equal(spawnAtHome(rec, home, 8), true)
  const back = noteRespawn(rec, { x: 562.5, y: 68, z: -44.5 }, 'overworld', now + 1)
  assert.equal(back.status, 'set')
  assert.equal(back.how, 'respawn')
  const away = noteRespawn(rec, { x: 546, y: 80, z: 39 }, 'overworld', now + 2)
  assert.equal(away.status, 'lost')
  assert.match(away.reason!, /respawned at 546 80 39, \d+ blocks from the bed/)
  assert.equal(spawnAtHome(away, home, 8), false)
  const never = noteRespawn({ status: 'unknown' }, { x: 546, y: 80, z: 39 }, 'overworld', now)
  assert.equal(never.status, 'lost')
  assert.match(never.reason!, /no bed set/)
  // a bed far from home is set, but not at home
  assert.equal(spawnAtHome(noteSpawnSet({ x: 0, y: 64, z: 0 }, 'overworld', now, 'click'), home, 8), false)
})

test('bedsWorkIn: not in the Nether or the End', () => {
  assert.equal(bedsWorkIn('overworld'), true)
  assert.equal(bedsWorkIn('minecraft:overworld'), true)
  assert.equal(bedsWorkIn('the_nether'), false)
  assert.equal(bedsWorkIn('minecraft:the_end'), false)
})

// A small world: floor at y=67 (stone), air above, with extra blocks set by the test.
function world (extra: Record<string, string> = {}): CellAt {
  return (x, y, z) => {
    const name = extra[`${x} ${y} ${z}`] ?? (y <= 67 ? 'stone' : 'air')
    const free = name === 'air' || name === 'short_grass'
    const solid = !free && !/door|gate|trapdoor|_bed$|chest/.test(name)
    return { name, solid, free } satisfies BedCell
  }
}

test('planBedSpot: right next to home, the home spot stays free', () => {
  const s = planBedSpot(home, world())!
  assert.ok(s)
  const cells = [s.foot, s.head]
  assert.ok(!cells.some(c => c.x === 560 && c.y === 68 && c.z === -46), 'not on the home spot')
  assert.equal(s.foot.y, 68)
  assert.ok(Math.hypot(s.foot.x - 560, s.foot.z + 46) <= 1.01, 'foot right beside home')
})

test('planBedSpot: avoids doors, chests, protected cells and a missing floor', () => {
  const extra: Record<string, string> = {}
  // doors on every side of home, a chest and a hole: pushes the bed further out
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) extra[`${560 + dx * 2} 68 ${-46 + dz * 2}`] = 'oak_door'
  const s = planBedSpot(home, world(extra))!
  for (const c of [s.foot, s.head]) {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) assert.notEqual(extra[`${c.x + dx} 68 ${c.z + dz}`], 'oak_door', 'not in front of a door')
  }
  const avoid = (p: { x: number, z: number }) => p.x >= 555 && p.x <= 565
  const far = planBedSpot(home, world(), { avoid, range: 8 })!
  assert.ok(far.foot.x < 555 || far.foot.x > 565)
  assert.ok(far.head.x < 555 || far.head.x > 565)
  // floating: no floor anywhere near
  const sky: CellAt = (x, y, z) => ({ name: 'air', solid: false, free: true })
  assert.equal(planBedSpot(home, sky), null)
})

test('bedSpotProblem: passage, headroom, chest, nowhere to stand', () => {
  const at = world()
  assert.equal(bedSpotProblem(at, { x: 10, y: 68, z: 10 }, 'east'), null)
  assert.equal(bedSpotProblem(world({ '10 69 10': 'stone' }), { x: 10, y: 68, z: 10 }, 'east'), 'no headroom')
  assert.equal(bedSpotProblem(world({ '10 67 10': 'air' }), { x: 10, y: 68, z: 10 }, 'east'), 'no floor')
  assert.match(bedSpotProblem(world({ '10 68 11': 'chest' }), { x: 10, y: 68, z: 10 }, 'east')!, /chest/)
  // a 1-wide corridor along z: walls at x=9 and x=11
  const walls: Record<string, string> = {}
  for (let z = 0; z <= 20; z++) for (const x of [9, 11]) for (const y of [68, 69]) walls[`${x} ${y} ${z}`] = 'stone'
  assert.equal(bedSpotProblem(world(walls), { x: 10, y: 68, z: 10 }, 'north'), 'would block a passage')
  // boxed in: no free cell next to it to stand on
  const box: Record<string, string> = {}
  for (let x = 8; x <= 13; x++) for (let z = 8; z <= 12; z++) for (const y of [68, 69]) if (!((x === 10 || x === 11) && z === 10)) box[`${x} ${y} ${z}`] = 'stone'
  assert.equal(bedSpotProblem(world(box), { x: 10, y: 68, z: 10 }, 'east'), 'nowhere to stand next to it')
  assert.equal(bedSpotProblem(at, home, 'east', { keepFree: [home] }), 'keeps the home spot free')
})

function bedWorld (over: Partial<BedWorld> = {}): BedWorld {
  return {
    now,
    home,
    inHomeDim: true,
    spawn: { status: 'unknown' },
    spawnBed: 'unknown',
    ownBed: null,
    inv: {},
    chests: [],
    shearable: 0,
    huntable: 0,
    night: false,
    searches: [],
    can: { craft: true, hunt: true, shear: true, search: true, withdraw: true, place: true, use: true },
    ...over
  }
}

test('nextBedStep: done when the respawn bed at home is still there', () => {
  const spawn = noteSpawnSet({ x: 561, y: 68, z: -45 }, 'overworld', now, 'click')
  assert.equal(nextBedStep(bedWorld({ spawn, spawnBed: 'bed' })), null)
  assert.equal(nextBedStep(bedWorld({ spawn, spawnBed: 'unknown' })), null, 'not loaded: trust the record')
  assert.equal(nextBedStep(bedWorld({ spawn, spawnBed: 'gone', inv: { red_bed: 1 } }))?.do, 'place', 'bed broken: redo')
  assert.equal(nextBedStep(bedWorld({ spawn: { ...spawn, status: 'lost' }, ownBed: { x: 561, y: 68, z: -45 } }))?.do, 'use')
})

test('nextBedStep: no home, home in the Nether, away from home', () => {
  assert.match((nextBedStep(bedWorld({ home: null })) as any).why, /no home/)
  assert.match((nextBedStep(bedWorld({ home: { ...home, dimension: 'the_nether' } })) as any).why, /explode/)
  assert.equal(nextBedStep(bedWorld({ inHomeDim: false }))?.do, 'stuck')
})

test('nextBedStep: own bed, bed item, bed in a chest, then crafting', () => {
  assert.deepEqual(nextBedStep(bedWorld({ ownBed: { x: 561, y: 68, z: -45 } }))?.do, 'use')
  assert.deepEqual(nextBedStep(bedWorld({ inv: { white_bed: 1 } })), { do: 'place', item: 'white_bed', why: 'placing my white_bed near home' })
  const chest = { x: 558, y: 68, z: -44, contents: { blue_bed: 1, cobblestone: 20 } }
  assert.deepEqual(nextBedStep(bedWorld({ chests: [chest] })), { do: 'withdraw', item: 'blue_bed', count: 1, from: { x: 558, y: 68, z: -44 }, why: 'a blue_bed in my chest' })
  // 3 white wool + planks of one kind: the bed
  assert.deepEqual(nextBedStep(bedWorld({ inv: { white_wool: 3, oak_planks: 4 } })), { do: 'craft', item: 'white_bed', count: 1, why: '3 white wool and planks: crafting a bed' })
  // mixed planks don't make a bed: planks from a log first
  const s = nextBedStep(bedWorld({ inv: { white_wool: 3, oak_planks: 1, spruce_planks: 1, birch_log: 1 } }))
  assert.equal(s?.do, 'craft')
  assert.equal((s as any).item, 'birch_planks')
  // no wood at all: stuck with a wood need
  assert.deepEqual(nextBedStep(bedWorld({ inv: { white_wool: 3 } })), { do: 'stuck', why: 'I have the wool for a bed but no wood for 3 planks', need: 'wood' })
})

test('nextBedStep: wool from a chest tops up one colour', () => {
  const chests: OwnChest[] = [
    { x: 1, y: 68, z: 1, contents: { red_wool: 1 } },
    { x: 2, y: 68, z: 2, contents: { white_wool: 5 } }
  ]
  const s = nextBedStep(bedWorld({ inv: { white_wool: 1, red_wool: 1 }, chests }))
  assert.deepEqual(s, { do: 'withdraw', item: 'white_wool', count: 2, from: { x: 2, y: 68, z: 2 }, why: 'white_wool in my chest' })
  assert.deepEqual(bestWool({ white_wool: 2, red_wool: 2, black_wool: 1 }), { colour: 'white', count: 2 })
  assert.equal(bestWool({ oak_planks: 3 }), null)
})

test('nextBedStep: shear, shears from iron, hunt, then search rings by day', () => {
  assert.equal(nextBedStep(bedWorld({ inv: { shears: 1 }, shearable: 2, huntable: 1 }))?.do, 'shear')
  assert.deepEqual(nextBedStep(bedWorld({ inv: { iron_ingot: 2 }, shearable: 2, huntable: 1 })), { do: 'craft', item: 'shears', count: 1, why: 'shears to get wool' })
  assert.deepEqual(nextBedStep(bedWorld({ inv: { white_wool: 1 }, shearable: 3, huntable: 1 })), { do: 'hunt', count: 1, why: 'need 2 more wool, hunting sheep' })
  assert.equal(nextBedStep(bedWorld({ inv: { iron_ingot: 2 }, shearable: 0, huntable: 0 }))?.do, 'search', 'no sheep: shears can wait')
  assert.deepEqual(nextBedStep(bedWorld({ night: true })), { do: 'stuck', why: 'it is night; I look for sheep by day' })
  let searches = recordSheepSearch([], 64, false, now - 1000)
  assert.deepEqual(nextBedStep(bedWorld({ searches })), { do: 'search', radius: 128, covered: 64, why: 'no sheep within 64, looking 128 out' })
  searches = recordSheepSearch(searches, 128, false, now - 900)
  searches = recordSheepSearch(searches, 250, false, now - 800)
  const stuck = nextBedStep(bedWorld({ searches }))
  assert.equal(stuck?.do, 'stuck')
  assert.equal((stuck as any).why, 'no sheep found within 250')
  assert.equal((stuck as any).retryInMs, SHEEP_RING_MEMORY_MS - 1000)
  // forgotten after the memory
  assert.equal(nextBedStep(bedWorld({ searches, now: now + SHEEP_RING_MEMORY_MS }))?.do, 'search')
  // can't place: says so
  assert.equal((nextBedStep(bedWorld({ inv: { white_bed: 1 }, can: { ...bedWorld().can, place: false } })) as any).why, 'I may not place blocks')
})

const players = (list: { name: string, sleeping?: boolean, seen?: boolean, spectator?: boolean }[]) => list
const opts = { ...SLEEP_ASK_DEFAULTS, graceMs: 12_000, intervalMs: 5000, maxAsks: 3 }

test('sleepAskStep: asks the players seen awake, reminds, then gets up after the grace', () => {
  let s: SleepAskState = { startedAt: now, asks: 0 }
  const w = { now, inBed: true, night: true, self: 'Pax', players: players([{ name: 'Pax' }, { name: 'Robin', seen: true }, { name: 'Alex', seen: true, sleeping: true }]) }
  const a = sleepAskStep(s, w, opts)
  assert.deepEqual(a, { do: 'ask', players: ['Robin'], first: true, missing: 1 })
  s = { ...s, asks: 1, lastAskAt: now }
  assert.equal(sleepAskStep(s, { ...w, now: now + 2000 }, opts).do, 'wait', 'not again within 5 s')
  const r = sleepAskStep(s, { ...w, now: now + 5000 }, opts)
  assert.equal(r.do, 'ask')
  assert.equal((r as any).first, false)
  s = { ...s, asks: 3, lastAskAt: now + 10_000 }
  assert.equal(sleepAskStep(s, { ...w, now: now + 11_000 }, opts).do, 'wait', 'max asks reached')
  assert.deepEqual(sleepAskStep(s, { ...w, now: now + 12_000 }, opts), { do: 'leave', why: 'nobody else went to bed in 12 s' })
})

test('sleepAskStep: night skipped, morning, out of bed, ask off', () => {
  const s: SleepAskState = { startedAt: now, asks: 0 }
  const w = { now, inBed: true, night: true, self: 'Pax', players: players([{ name: 'Robin', seen: true }]) }
  assert.equal(sleepAskStep(s, { ...w, night: false }, opts).do, 'done')
  assert.deepEqual(sleepAskStep({ ...s, skipping: true }, { ...w, inBed: false }, opts), { do: 'done', why: 'the night was skipped' })
  assert.equal(sleepAskStep({ ...s, skipping: true }, { ...w, now: now + 13_000 }, opts).do, 'wait', 'skipping: keep lying down past the grace')
  assert.equal(sleepAskStep(s, w, { ...opts, ask: false }).do, 'wait')
  assert.equal(sleepAskStep({ ...s, impossible: true }, w, opts).do, 'leave')
  // alone: nobody to ask, the night skips on its own
  assert.equal(sleepAskStep(s, { ...w, players: [] }, opts).do, 'wait')
})

test('sleepAskStep: the server count decides whether unseen players are asked', () => {
  const s0: SleepAskState = { startedAt: now, asks: 0 }
  const w = { now, inBed: true, night: true, self: 'Pax', players: players([{ name: 'Robin', seen: true }, { name: 'Steve' }, { name: 'Spec', spectator: true }]) }
  // 1/2 sleeping: one more needed, Robin is in sight, Steve (maybe in the Nether) is left alone
  let s = noteSleepMessage(s0, parseBedMessage('1/2 players sleeping'))
  assert.deepEqual(sleepAskStep(s, w, opts), { do: 'ask', players: ['Robin'], first: true, missing: 1 })
  // 1/3: two more needed, only one in sight, so Steve must be in the overworld too
  s = noteSleepMessage(s0, parseBedMessage('1/3 players sleeping'))
  assert.deepEqual((sleepAskStep(s, w, opts) as any).players, ['Robin', 'Steve'])
  // 2/2: enough
  s = noteSleepMessage(s0, parseBedMessage('2/2 players sleeping'))
  assert.equal(sleepAskStep(s, w, opts).do, 'wait')
  // no count yet: the percentage decides (50% of 3 players = 2 needed, 1 asleep)
  assert.deepEqual((sleepAskStep(s0, w, { ...opts, percentage: 50 }) as any).players, ['Robin'])
  assert.equal(sleepAskStep(s0, w, { ...opts, percentage: 0 }).do, 'wait')
  // ignored players are never asked
  assert.equal(sleepAskStep(s0, w, { ...opts, ignore: ['robin', 'steve'] }).do, 'wait')
  assert.equal(noteSleepMessage(s0, parseBedMessage('Sleeping through this night')).skipping, true)
})

test('askText and nameList', () => {
  assert.equal(nameList(['A']), 'A')
  assert.equal(nameList(['A', 'B', 'C']), 'A, B and C')
  assert.equal(askText('{players}, bed please ({sleeping}/{needed})', ['Robin', 'Alex'], { sleeping: 1, needed: 3 }), 'Robin and Alex, bed please (1/3)')
  assert.equal(askText('{players}: {sleeping}/{needed}', ['Robin']), 'Robin: 1/2')
})
