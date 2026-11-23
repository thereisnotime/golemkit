// Getting the bot's own drops back after a death: the go / wait / skip decision, the checks on the
// way, and the report line.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  recoverDecision, tripCheck, recoveryReport, threatPoints, gearForThreat, expectedMobs, mobKey,
  type DeathSite, type RecoverWorld
} from '../src/skills/recoverPlan.ts'
import type { GearView } from '../src/skills/ranged-plan.ts'

const T0 = 1_000_000
const NAKED: GearView = { armor: 0, shield: false, weaponDamage: 1, bow: false, arrows: 0, health: 20 }
const IRON: GearView = { armor: 15, shield: true, weaponDamage: 6, bow: false, arrows: 0, health: 20 }

const site = (o: Partial<DeathSite> = {}): DeathSite => ({
  diedAt: T0, pos: { x: 100, y: 64, z: 0 }, dimension: 'overworld', kind: 'fall', recentDamage: ['fall'], hostiles: {},
  lost: [{ name: 'stone_sword', count: 1 }, { name: 'cobblestone', count: 30 }], night: false, openSky: true, ...o
})
const world = (o: Partial<RecoverWorld> = {}): RecoverWorld => ({
  now: T0 + 10_000, here: { x: 0, y: 64, z: 0 }, dimension: 'overworld', gear: NAKED, night: false, carried: 0, players: ['Robin'], ...o
})

test('recoverDecision: a fall 100 blocks away by day is worth the walk', () => {
  const d = recoverDecision(site(), world())
  assert.equal(d.do, 'go')
  if (d.do === 'go') { assert.equal(d.distance, 100); assert.ok(d.etaMs > 25_000 && d.etaMs < 35_000) }
})

test('recoverDecision: drops that are gone for good', () => {
  assert.deepEqual(recoverDecision(site({ kind: 'lava', recentDamage: ['lava'] }), world()), { do: 'skip', why: 'my things burned in lava', gone: true })
  assert.equal(recoverDecision(site({ kind: 'slain', killer: 'Zombie', recentDamage: ['lava', 'zombie'] }), world()).why, 'my things burned in lava')
  assert.match(recoverDecision(site({ kind: 'void', pos: { x: 0, y: -70, z: 0 } }), world()).why, /out of the world/)
  assert.match(recoverDecision(site({ kind: 'fall', pos: { x: 0, y: -80, z: 0 } }), world()).why, /out of the world/)
  assert.match(recoverDecision(site({ dimension: 'the_nether' }), world()).why, /died in the_nether and respawned in overworld/)
  assert.match(recoverDecision(site({ lost: [] }), world()).why, /nothing on me/)
  assert.match(recoverDecision(site(), world({ carried: 31 })).why, /kept my inventory/)
  assert.match(recoverDecision(site({ pos: null }), world()).why, /don't know where/)
  assert.match(recoverDecision(site(), world({ now: T0 + 301_000 })).why, /despawned/)
})

test('recoverDecision: deep water is out of reach, a little water is fine', () => {
  const s = site({ kind: 'drowning', pos: { x: 20, y: 40, z: 0 } })
  const deep = recoverDecision(s, world({ waterAbove: 20 }))
  assert.equal(deep.do, 'skip')
  assert.match(deep.why, /20 blocks under water/)
  assert.equal(recoverDecision(s, world({ waterAbove: 3 })).do, 'go')
  assert.equal(recoverDecision(s, world({ waterAbove: 20 }), { maxWaterDepth: 30 }).do, 'go')
})

test('recoverDecision: distance and the time left at walking speed with a margin', () => {
  // 500 blocks: over maxDistance
  assert.match(recoverDecision(site({ pos: { x: 500, y: 64, z: 0 } }), world()).why, /500 blocks away \(more than 400\)/)
  // 350 blocks: about 106 s at 4.3 b/s with the path factor, fine right after the death...
  assert.equal(recoverDecision(site({ pos: { x: 350, y: 64, z: 0 } }), world()).do, 'go')
  // ...not with 2 minutes left
  const late = recoverDecision(site({ pos: { x: 350, y: 64, z: 0 } }), world({ now: T0 + 180_000 }))
  assert.equal(late.do, 'skip')
  assert.match(late.why, /despawn in 2 min/)
  assert.equal(recoverDecision(site({ pos: { x: 500, y: 64, z: 0 } }), world(), { maxDistance: 600 }).do, 'go')
})

test('recoverDecision: killed by 3 skeletons with no gear waits, in iron it goes', () => {
  const s = site({ kind: 'shot', killer: 'Skeleton', recentDamage: ['skeleton'], hostiles: { skeleton: 3 }, openSky: false })
  const naked = recoverDecision(s, world())
  assert.equal(naked.do, 'wait')
  assert.match(naked.why, /3 skeleton by my things/)
  assert.equal(recoverDecision(s, world({ gear: IRON })).do, 'go')
  // no time left to wait: give up instead
  const late = recoverDecision(s, world({ now: T0 + 230_000 }))
  assert.equal(late.do, 'skip')
})

test('recoverDecision: what is seen at the spot now beats the report', () => {
  const s = site({ kind: 'slain', killer: 'Zombie', hostiles: { zombie: 2, skeleton: 1 }, openSky: false })
  assert.equal(recoverDecision(s, world()).do, 'wait')
  assert.equal(recoverDecision(s, world({ liveHostiles: {} })).do, 'go')
  assert.equal(recoverDecision(s, world({ liveHostiles: { zombie: 1 } })).do, 'go')
})

test('recoverDecision: undead under open sky burn by day', () => {
  const s = site({ kind: 'slain', killer: 'Zombie', hostiles: { zombie: 3 }, night: true, openSky: true })
  assert.equal(recoverDecision(s, world()).do, 'go') // day now: 3 zombies burning are 0.75 points
  assert.equal(recoverDecision({ ...s, openSky: false }, world()).do, 'wait') // in a cave they don't
})

test('recoverDecision: a player killer and the mobs nobody walks into', () => {
  const pvp = recoverDecision(site({ kind: 'slain', killer: 'Robin' }), world())
  assert.deepEqual(pvp, { do: 'skip', why: 'Robin killed me there' })
  assert.equal(recoverDecision(site({ kind: 'slain', killer: 'Robin' }), world(), { avoidPlayerKillers: false }).do, 'go')
  const warden = recoverDecision(site({ kind: 'slain', killer: 'Warden' }), world({ gear: IRON }))
  assert.equal(warden.do, 'skip')
  assert.match(warden.why, /warden/)
})

test('recoverDecision: a creeper that blew the bot up is gone', () => {
  const s = site({ kind: 'explosion', killer: 'Creeper', hostiles: { creeper: 1 } })
  assert.deepEqual(expectedMobs(s), {})
  assert.equal(recoverDecision(s, world()).do, 'go')
})

test('recoverDecision: night, naked and far waits; close is fine; geared is fine', () => {
  const s = site({ pos: { x: 150, y: 64, z: 0 } })
  const d = recoverDecision(s, world({ night: true }))
  assert.equal(d.do, 'wait')
  assert.match(d.why, /night, 150 blocks out/)
  assert.equal(recoverDecision(site({ pos: { x: 30, y: 64, z: 0 } }), world({ night: true })).do, 'go')
  assert.equal(recoverDecision(s, world({ night: true, gear: IRON })).do, 'go')
  // night adds fresh spawns: one zombie reported is too much naked at night
  assert.equal(recoverDecision(site({ pos: { x: 30, y: 64, z: 0 }, hostiles: { zombie: 1 } }), world({ night: true })).do, 'wait')
})

test('threat points and the gear they need', () => {
  assert.equal(threatPoints({ skeleton: 3 }), 4.5)
  assert.equal(threatPoints({ Zombie: 2 }), 2)
  assert.equal(threatPoints({ zombie: 4 }, { burning: true }), 1)
  assert.equal(threatPoints({ warden: 1 }), Infinity)
  assert.equal(gearForThreat(1), 0)
  assert.equal(gearForThreat(4.5), 69)
  assert.equal(mobKey('Cave Spider'), 'cave_spider')
})

test('tripCheck: hurt badly, despawn near, a danger zone at the spot', () => {
  const t = { now: T0, deadline: T0 + 120_000, remaining: 60, health: 20 }
  assert.deepEqual(tripCheck(t), { go: true })
  assert.match((tripCheck({ ...t, health: 6 }) as { why: string }).why, /hurt badly on the way \(health 6\)/)
  assert.match((tripCheck({ ...t, deadline: T0 + 20_000 }) as { why: string }).why, /despawn before I get there/)
  const zone = tripCheck({ ...t, remaining: 10, hostilesHere: { skeleton: 3 }, gear: NAKED })
  assert.equal(zone.go, false)
  assert.match((zone as { why: string }).why, /too dangerous there: 3 skeleton/)
  assert.deepEqual(tripCheck({ ...t, remaining: 10, hostilesHere: { skeleton: 3 }, gear: IRON }), { go: true })
})

test('recoveryReport: counts what came back, tools first, capped at what was lost', () => {
  const lost = [{ name: 'cobblestone', count: 25 }, { name: 'stone_sword', count: 1 }, { name: 'bread', count: 5 }, { name: 'iron_pickaxe', count: 1 }]
  const r = recoveryReport(lost, {}, { cobblestone: 20, stone_sword: 1, bread: 2, dirt: 9 })
  assert.equal(r.got, 23)
  assert.equal(r.of, 32)
  assert.equal(r.text, 'got back 23 of 32 items: stone sword, 20 cobblestone, 2 bread; still missing iron pickaxe, 5 cobblestone, 3 bread')
  const none = recoveryReport(lost, {}, {}, 'hurt badly on the way (health 7)')
  assert.equal(none.text, 'got nothing back of 32 items (hurt badly on the way (health 7))')
  const all = recoveryReport([{ name: 'stone_sword', count: 1 }], { stone_sword: 0 }, { stone_sword: 1 })
  assert.equal(all.text, 'got back 1 of 1 item: stone sword')
})
