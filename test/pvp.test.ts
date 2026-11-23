import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  pvpMode, pvpSettings, aggressive, aggression, addRevenge, pruneRevenge, revengeKill, revengeWorthy, activeRevenge, pickPvpTarget,
  afterArmor, duelOdds, engageCheck, chaseVerdict, pvpRefusal, modeLine, type AggroCheck, type Fighter
} from '../src/skills/pvp.ts'
import {
  trackVelocity, teleported, predict, enemyReadyIn, shieldCovers, pvpWeapon, pvpShield, pvpMove, pvpKnockback, edgeStep, pvpRange,
  pvpSustain, reengage
} from '../src/skills/pvp-tactics.ts'
import { parseIntent } from '../src/brains/intents/parse.ts'
import { findToggle, parseToggleValue } from '../src/core/toggles.ts'

const NOW = 1_000_000

test('pvp modes: off by default, unknown values are off', () => {
  assert.equal(pvpMode(undefined), 'off')
  assert.equal(pvpMode('everyone'), 'off')
  for (const m of ['off', 'defend', 'revenge', 'targets', 'all']) assert.equal(pvpMode(m), m)
  assert.equal(aggressive('defend'), false)
  assert.equal(aggressive('revenge'), true)
  const s = pvpSettings(undefined)
  assert.equal(s.mode, 'off')
  assert.equal(s.revengeMinutes, 30)
  assert.equal(s.engage, 16)
  assert.equal(s.chase, 48)
  assert.equal(s.lostSec, 30)
  assert.equal(s.spareProtected, true)
  assert.equal(s.taunts, false)
  assert.deepEqual(pvpSettings({ targets: 'Bob, Eve' }).targets, ['Bob', 'Eve'])
  const t = findToggle('combat.pvp')!
  assert.ok(parseToggleValue(t, 'all').ok)
  assert.ok(!parseToggleValue(t, 'everyone').ok)
  assert.ok(findToggle('combat.targets') && findToggle('combat.revengeMinutes') && findToggle('combat.spareProtected') && findToggle('combat.taunts'))
})

test('defending works in every mode but off; owners, friends and creative players never', () => {
  const base = { player: 'Bob', owners: ['robin'], friends: ['Eve'] }
  assert.equal(pvpRefusal({ ...base, mode: 'off' }), 'combat.pvp is off')
  for (const mode of ['defend', 'revenge', 'targets', 'all'] as const) assert.equal(pvpRefusal({ ...base, mode }), null)
  assert.equal(pvpRefusal({ ...base, mode: 'all', player: 'Robin' }), 'an owner')
  assert.equal(pvpRefusal({ ...base, mode: 'all', player: 'eve' }), 'a friend')
  assert.equal(pvpRefusal({ ...base, mode: 'all', invulnerable: true }), 'in creative or spectator')
})

const check = (o: Partial<AggroCheck>): AggroCheck => ({
  mode: 'all', player: 'Bob', self: 'Pax', owners: ['robin'], friends: ['Eve'], targets: [], revenge: [], now: NOW, ...o
})

test('who to attack: never owners, friends, creative, protected areas or itself, in any mode', () => {
  for (const mode of ['revenge', 'targets', 'all'] as const) {
    const grudge = addRevenge([], { player: 'Robin', why: 'killed', victim: 'me', now: NOW, minutes: 30, owners: [], friends: [] })
    assert.equal(aggression(check({ mode, player: 'Robin', targets: ['Robin'], revenge: grudge })).attack, false, `${mode}: owner`)
    assert.equal(aggression(check({ mode, player: 'EVE', targets: ['eve'] })).attack, false, `${mode}: friend`)
    assert.equal(aggression(check({ mode, targets: ['Bob'], invulnerable: true })).attack, false, `${mode}: creative`)
    assert.equal(aggression(check({ mode, targets: ['Bob'], inProtected: true })).attack, false, `${mode}: protected`)
    assert.equal(aggression(check({ mode, player: 'pax', targets: ['Pax'] })).attack, false, `${mode}: itself`)
  }
  assert.deepEqual(aggression(check({ targets: ['Bob'], inProtected: true, spareProtected: false })), { attack: true, why: 'target' })
})

test('who to attack: off and defend never start fights; revenge only grudges; targets the list; all everyone', () => {
  assert.equal(aggression(check({ mode: 'off', targets: ['Bob'] })).attack, false)
  assert.equal(aggression(check({ mode: 'defend', targets: ['Bob'] })).attack, false)
  assert.deepEqual(aggression(check({ mode: 'revenge', targets: ['Bob'] })), { attack: false, why: 'no grudge' })
  const grudge = addRevenge([], { player: 'Bob', why: 'attacked', victim: 'me', now: NOW, minutes: 30, owners: [], friends: [] })
  assert.deepEqual(aggression(check({ mode: 'revenge', revenge: grudge })), { attack: true, why: 'revenge' })
  assert.deepEqual(aggression(check({ mode: 'targets', targets: ['bob'] })), { attack: true, why: 'target' })
  assert.deepEqual(aggression(check({ mode: 'targets', revenge: grudge })), { attack: true, why: 'revenge' })
  assert.deepEqual(aggression(check({ mode: 'targets' })), { attack: false, why: 'not a target' })
  assert.deepEqual(aggression(check({ mode: 'all' })), { attack: true, why: 'all' })
  // expired grudge
  assert.equal(aggression(check({ mode: 'revenge', revenge: grudge, now: NOW + 31 * 60_000 })).attack, false)
})

test('revenge: never owners or friends, kills outrank attacks, expiry, forgiven after N kills', () => {
  const o = { why: 'attacked' as const, victim: 'me', now: NOW, minutes: 30, owners: ['robin'], friends: ['Eve'], self: 'Pax' }
  assert.deepEqual(addRevenge([], { ...o, player: 'Robin' }), [])
  assert.deepEqual(addRevenge([], { ...o, player: 'eve' }), [])
  assert.deepEqual(addRevenge([], { ...o, player: 'Pax' }), [])
  assert.deepEqual(addRevenge([], { ...o, player: 'Bob', minutes: 0 }), [])
  let l = addRevenge([], { ...o, player: 'Bob' })
  assert.equal(l.length, 1)
  assert.equal(l[0]!.until, NOW + 30 * 60_000)
  l = addRevenge(l, { ...o, player: 'bob', why: 'killed', victim: 'robin', now: NOW + 60_000 })
  assert.equal(l.length, 1)
  assert.equal(l[0]!.why, 'killed')
  assert.equal(l[0]!.victim, 'robin')
  assert.equal(l[0]!.since, NOW)
  l = addRevenge(l, { ...o, player: 'Bob', now: NOW + 120_000 })
  assert.equal(l[0]!.why, 'killed', 'a later attack does not downgrade a kill')
  assert.ok(activeRevenge(l, 'BOB', NOW + 120_000))
  assert.deepEqual(pruneRevenge(l, NOW + 33 * 60_000), [])
  assert.deepEqual(pruneRevenge(l, NOW, [], ['bob']), [], 'made a friend since')
  const two = revengeKill(l, 'Bob', 2)
  assert.equal(two.forgiven, false)
  assert.equal(two.list[0]!.kills, 1)
  assert.deepEqual(revengeKill(two.list, 'Bob', 2), { list: [], forgiven: true })
})

test('revenge is noted only in the attacking modes and only for the bot, owners and the guarded player', () => {
  const s = { mode: 'revenge' as const, self: 'Pax', owners: ['robin'], guarded: 'Ann' }
  assert.equal(revengeWorthy({ ...s, victim: 'me' }), true)
  assert.equal(revengeWorthy({ ...s, victim: 'Robin' }), true)
  assert.equal(revengeWorthy({ ...s, victim: 'ann' }), true)
  assert.equal(revengeWorthy({ ...s, victim: 'Stranger' }), false)
  assert.equal(revengeWorthy({ ...s, mode: 'defend', victim: 'me' }), false)
  assert.equal(revengeWorthy({ ...s, mode: 'off', victim: 'me' }), false)
})

test('target pick: in range and in sight, revenge first, then targets, then nearest; cooling ones wait', () => {
  const list = [
    { player: 'A', dist: 5, why: 'all' as const, visible: true },
    { player: 'B', dist: 12, why: 'target' as const, visible: true },
    { player: 'C', dist: 14, why: 'revenge' as const, visible: false },
    { player: 'D', dist: 20, why: 'revenge' as const, visible: true }
  ]
  assert.equal(pickPvpTarget(list, 16)?.player, 'B', 'C is out of sight, D out of range')
  assert.equal(pickPvpTarget([...list, { player: 'E', dist: 3, why: 'revenge', visible: false }], 16)?.player, 'E', 'close enough to hear')
  assert.equal(pickPvpTarget(list, 16, new Set(['b']))?.player, 'A')
  assert.equal(pickPvpTarget([], 16), null)
})

test('odds: armour formula, even kits are even, a naked bot against iron loses badly', () => {
  assert.equal(afterArmor(10, 0), 10)
  assert.ok(Math.abs(afterArmor(6, 15) - 6 * (1 - Math.max(3, 15 - 24 / 8) / 25)) < 1e-9)
  const iron: Fighter = { health: 20, armor: 15, damage: 6, speed: 1.6, shield: true }
  assert.equal(duelOdds(iron, iron), 1)
  const naked: Fighter = { health: 20, armor: 0, damage: 1, speed: 4 }
  assert.ok(duelOdds(naked, iron) < 0.2)
  assert.ok(duelOdds(iron, naked) > 5)
  assert.ok(duelOdds({ ...iron, totem: true, apples: 2 }, iron) > 1.5)
  assert.equal(engageCheck({ why: 'all', odds: 0.5, minOdds: 0.7, revengeIgnoresOdds: false }), 'odds 0.5 under 0.7')
  assert.equal(engageCheck({ why: 'revenge', odds: 0.5, minOdds: 0.7, revengeIgnoresOdds: true }), null)
  assert.equal(engageCheck({ why: 'target', odds: 1, minOdds: 0.7, revengeIgnoresOdds: false }), null)
})

test('chase: distance, out of sight, pearls', () => {
  const b = { fromStart: 10, dist: 6, chase: 48, outOfSightMs: 0, lostSec: 30 }
  assert.equal(chaseVerdict(b), null)
  assert.equal(chaseVerdict({ ...b, fromStart: 50 }), 'chased 50 blocks')
  assert.equal(chaseVerdict({ ...b, outOfSightMs: 31_000 }), 'out of sight 31 s')
  assert.equal(chaseVerdict({ ...b, jump: 20, dist: 30 }), 'pearled away')
  assert.equal(chaseVerdict({ ...b, jump: 20, dist: 10 }), null, 'a short pearl is still in reach')
})

test('mode lines go to owners and name who set it', () => {
  assert.match(modeLine('all', 'Robin'), /every player.*set by Robin/)
  assert.match(modeLine('off', null), /leave players alone$/)
})

// ---- tactics ----

test('enemy reading: velocity smoothing, teleports, prediction, swing charge, shield arc', () => {
  const v = trackVelocity({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0.5, y: 0, z: 0 }, 2, 1)
  assert.deepEqual(v, { x: 0.25, y: 0, z: 0 })
  assert.deepEqual(trackVelocity({ x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 20, y: 0, z: 0 }, 1), { x: 0, y: 0, z: 0 })
  assert.equal(teleported({ x: 0, y: 0, z: 0 }, { x: 9, y: 0, z: 0 }), true)
  assert.deepEqual(predict({ x: 0, y: 64, z: 0 }, { x: 0.2, y: 0.4, z: -0.1 }, 5), { x: 1, y: 64, z: -0.5 })
  assert.deepEqual(predict({ x: 0, y: 64, z: 0 }, { x: 1, y: 0, z: 0 }, 50), { x: 10, y: 64, z: 0 }, 'capped')
  assert.equal(enemyReadyIn(0, 'iron_sword'), 625)
  assert.equal(enemyReadyIn(700, 'iron_sword'), 0)
  assert.equal(enemyReadyIn(700, 'iron_axe'), 411)
  // yaw 0 faces north (-z)
  assert.equal(shieldCovers(0, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -3 }), true)
  assert.equal(shieldCovers(0, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 3 }), false)
})

test('weapon: the axe against shield carriers, the sword otherwise', () => {
  assert.equal(pvpWeapon({ sword: true, axe: true, enemyShield: true }), 'axe')
  assert.equal(pvpWeapon({ sword: true, axe: true, enemyShield: false, enemyBlocking: true }), 'axe', 'a shield in the main hand')
  assert.equal(pvpWeapon({ sword: true, axe: true, enemyShield: false }), 'sword')
  assert.equal(pvpWeapon({ sword: false, axe: true, enemyShield: false }), 'axe')
  assert.equal(pvpWeapon({ sword: true, axe: false, enemyShield: true }), 'sword')
  assert.equal(pvpWeapon({ sword: false, axe: false, enemyShield: true }), null)
})

test('shield: up in reach while our hit charges and for arrows, down to hit', () => {
  const s = { hasShield: true, disabled: false, dist: 3, myCdLeftMs: 500, arrowIncoming: false, enemyDrawing: false }
  assert.equal(pvpShield(s), 'raise')
  assert.equal(pvpShield({ ...s, myCdLeftMs: 40 }), 'lower', 'our hit is ready')
  assert.equal(pvpShield({ ...s, myCdLeftMs: 300 }), 'lower', 'no time for the 5-tick delay')
  assert.equal(pvpShield({ ...s, dist: 6 }), 'lower', 'out of their reach')
  assert.equal(pvpShield({ ...s, dist: 10, arrowIncoming: true, myCdLeftMs: 0 }), 'raise')
  assert.equal(pvpShield({ ...s, dist: 10, enemyDrawing: true, myCdLeftMs: 0 }), 'raise')
  assert.equal(pvpShield({ ...s, disabled: true, arrowIncoming: true }), 'lower')
  assert.equal(pvpShield({ ...s, hasShield: false }), 'lower')
})

test('footwork: sprint in, zig-zag against a bow, step in only when charged, back off point-blank', () => {
  const s = { hd: 10, myCdLeftMs: 0, enemyReadyInMs: 0, enemyDrawing: false, behind: 0 }
  assert.deepEqual(pvpMove(s), { dir: 'forward', sprint: true, strafe: true })
  assert.deepEqual(pvpMove({ ...s, hd: 20 }), { dir: 'forward', sprint: true, strafe: false })
  assert.deepEqual(pvpMove({ ...s, hd: 5, enemyDrawing: true }), { dir: 'forward', sprint: true, strafe: true })
  assert.deepEqual(pvpMove({ ...s, hd: 3.6 }), { dir: 'forward', sprint: true, strafe: false }, 'charged: W-tap in')
  assert.deepEqual(pvpMove({ ...s, hd: 3.6, myCdLeftMs: 400 }), { dir: 'strafe', sprint: false, strafe: true }, 'charging: circle')
  assert.deepEqual(pvpMove({ ...s, hd: 2.8, myCdLeftMs: 400 }), { dir: 'back', sprint: false, strafe: true }, 'they are ready, we are not, no shield')
  assert.deepEqual(pvpMove({ ...s, hd: 2.8, myCdLeftMs: 400, shield: true }), { dir: 'strafe', sprint: false, strafe: true }, 'blocking instead')
  assert.deepEqual(pvpMove({ ...s, hd: 2.0 }), { dir: 'back', sprint: false, strafe: true })
  assert.equal(pvpKnockback({ enemyEdge: true, health: 20, enemyHealth: 20 }), true)
  assert.equal(pvpKnockback({ enemyEdge: false, health: 6, enemyHealth: 16 }), true)
  assert.equal(pvpKnockback({ enemyEdge: false, health: 20, enemyHealth: 20 }), false)
})

test('ledges: sidestep to the safe side, push forward when boxed in', () => {
  assert.equal(edgeStep({ backSafe: true, leftSafe: false, rightSafe: false }), null)
  assert.equal(edgeStep({ backSafe: false, leftSafe: true, rightSafe: true }), 'left')
  assert.equal(edgeStep({ backSafe: false, leftSafe: false, rightSafe: true }), 'right')
  assert.equal(edgeStep({ backSafe: false, leftSafe: false, rightSafe: false }), 'forward')
})

test('ranged: bow at range unless they block or close in, melee up close', () => {
  const s = { dist: 20, bow: true, arrows: 16, enemyBlocking: false, closing: 0 }
  assert.equal(pvpRange(s), 'bow')
  assert.equal(pvpRange({ ...s, dist: 6 }), 'melee')
  assert.equal(pvpRange({ ...s, dist: 50 }), 'melee')
  assert.equal(pvpRange({ ...s, arrows: 0 }), 'melee')
  assert.equal(pvpRange({ ...s, enemyBlocking: true }), 'melee')
  assert.equal(pvpRange({ ...s, dist: 12, closing: 6 }), 'melee', 'sprinting at us')
})

test('sustain: totem at 10, apple at 12, retreat when losing with nothing, food when far', () => {
  const s = { health: 20, enemyDist: 3, hasTotem: true, totemInOffhand: false, hasApple: true, sinceAppleMs: 1e9, hasFood: true, food: 20, odds: 1 }
  assert.equal(pvpSustain(s), null)
  assert.equal(pvpSustain({ ...s, health: 10 }), 'totem')
  assert.equal(pvpSustain({ ...s, health: 12, hasTotem: false }), 'apple')
  assert.equal(pvpSustain({ ...s, health: 13, hasTotem: false }), null)
  assert.equal(pvpSustain({ ...s, health: 10, totemInOffhand: true }), 'apple')
  assert.equal(pvpSustain({ ...s, health: 6, totemInOffhand: true, sinceAppleMs: 2000 }), null, 'the last one is still working')
  assert.equal(pvpSustain({ ...s, health: 5, hasTotem: false, hasApple: false }), 'retreat')
  assert.equal(pvpSustain({ ...s, health: 5, hasTotem: false, hasApple: false, odds: 2 }), null, 'winning anyway')
  assert.equal(pvpSustain({ ...s, health: 16, hasTotem: false, enemyDist: 20, food: 12 }), 'eat')
  assert.equal(reengage({ health: 14, enemyHealth: 20 }), true)
  assert.equal(reengage({ health: 10, enemyHealth: 5 }), true)
  assert.equal(reengage({ health: 10, enemyHealth: 12 }), false)
})

// ---- intents ----

test('intents: PvP phrases, never mobs, and the kill switch', () => {
  const ctx = { speaker: 'Robin' }
  assert.deepEqual(parseIntent('attack bob', ctx), { intent: 'pvp_attack', args: { player: 'bob' }, confidence: 0.85 })
  assert.deepEqual(parseIntent('hunt bob', ctx)?.args, { player: 'bob', hunt: true })
  assert.deepEqual(parseIntent('hunt bob down', ctx)?.args, { player: 'bob', hunt: true })
  assert.deepEqual(parseIntent('stop attacking bob', ctx), { intent: 'pvp_spare', args: { player: 'bob' }, confidence: 0.9 })
  assert.equal(parseIntent("don't attack bob", ctx)?.intent, 'pvp_spare')
  assert.equal(parseIntent('leave bob alone', ctx)?.intent, 'pvp_spare')
  assert.deepEqual(parseIntent('pvp all', ctx)?.args, { mode: 'all' })
  assert.deepEqual(parseIntent('stop attacking', ctx)?.args, { mode: 'off' })
  assert.equal(parseIntent('stop', ctx)?.intent, 'stop')
  for (const t of ['attack zombies', 'kill the zombie', 'attack me', 'hunt for diamonds', 'kill everything', 'attack them']) {
    assert.notEqual(parseIntent(t, ctx)?.intent, 'pvp_attack', t)
  }
  assert.equal((parseIntent('did you attack bob?', ctx)?.confidence ?? 0) < 0.7, true, 'a question is no order')
})
