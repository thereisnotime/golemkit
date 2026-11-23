import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  sweepWorth, wantKnockback, hitStyle, shieldAgainstMelee, breaksShields, creeperEscape, totemSwap, goldenAppleNow,
  fallDamage, clutchDecision, extinguishDecision, gazeProvokes, avertGaze, rangedUseless, findChokepoint, wantChokepoint, viewVector
} from '../src/skills/techniques.ts'
import { pvpDecision, pvpRefusal, pvpMode } from '../src/skills/pvp.ts'
import { pickOffhand } from '../src/skills/tactics.ts'
import { meleeDamage, SHIELDED } from '../src/skills/weapons.ts'
import { findToggle, parseToggleValue } from '../src/core/toggles.ts'

test('sweep: only with a sword, and only when the extra mobs outweigh the lost crit', () => {
  assert.equal(sweepWorth({ weapon: 'iron_sword', damage: 6, bunched: 0 }), false, 'nothing around the target')
  assert.equal(sweepWorth({ weapon: 'iron_sword', damage: 6, bunched: 2 }), false, '2 x 1 damage < half of 6')
  assert.equal(sweepWorth({ weapon: 'iron_sword', damage: 6, bunched: 3 }), true, '3 x 1 = half of 6')
  assert.equal(sweepWorth({ weapon: 'iron_sword', damage: 6, sweepingLevel: 3, bunched: 1 }), true, 'Sweeping Edge III: 1 + 4.5 per mob')
  assert.equal(sweepWorth({ weapon: 'iron_axe', damage: 9, bunched: 5 }), false, 'axes do not sweep')
})

test('knockback beats a crit against creepers, at low health and in a crowd', () => {
  assert.equal(wantKnockback({ target: 'creeper', health: 20, meleeNear: 1 }), true)
  assert.equal(wantKnockback({ target: 'zombie', health: 8, meleeNear: 1 }), true)
  assert.equal(wantKnockback({ target: 'zombie', health: 20, meleeNear: 3 }), true)
  assert.equal(wantKnockback({ target: 'zombie', health: 20, meleeNear: 1 }), false)
})

test('hit style: sweep > knockback sprint > crit > W-tap sprint > plain', () => {
  const b = { canCrit: true, sweepWorth: false, wantKnockback: false, sprintReset: true, sweep: true }
  assert.equal(hitStyle(b), 'crit')
  assert.equal(hitStyle({ ...b, sweepWorth: true }), 'sweep')
  assert.equal(hitStyle({ ...b, sweepWorth: true, sweep: false }), 'crit', 'sweep toggle off')
  assert.equal(hitStyle({ ...b, wantKnockback: true }), 'sprint')
  assert.equal(hitStyle({ ...b, canCrit: false }), 'sprint', 'no crit possible: W-tap for knockback')
  assert.equal(hitStyle({ ...b, canCrit: false, sprintReset: false }), 'plain')
  assert.equal(hitStyle({ ...b, wantKnockback: true, sprintReset: false }), 'crit')
})

test('shield against melee: between slow swings, never against axes or creepers', () => {
  const s = { enabled: true, hasShield: true, attacker: 'zombie', dist: 2, cooldownLeftMs: 600 }
  assert.equal(shieldAgainstMelee(s), true)
  assert.equal(shieldAgainstMelee({ ...s, cooldownLeftMs: 300 }), false, 'not up long enough to count before the swing')
  assert.equal(shieldAgainstMelee({ ...s, attacker: 'vindicator' }), true, 'the axe hit is blocked, then the shield is down')
  assert.equal(shieldAgainstMelee({ ...s, attacker: 'vindicator', disabled: true }), false, 'disabled by the last axe hit')
  assert.equal(shieldAgainstMelee({ ...s, attacker: 'player', attackerHeld: 'diamond_sword' }), true)
  assert.equal(shieldAgainstMelee({ ...s, attacker: 'creeper' }), false)
  assert.equal(shieldAgainstMelee({ ...s, dist: 5 }), false)
  assert.equal(shieldAgainstMelee({ ...s, disabled: true }), false)
  assert.equal(shieldAgainstMelee({ ...s, enabled: false }), false)
  assert.ok(breaksShields('piglin_brute'))
  assert.ok(!breaksShields('zombie'))
})

test('creeper escape: run when backing off gets the bot past 7 blocks before the blast, shield otherwise', () => {
  assert.equal(creeperEscape({ dist: 4.5, msLeft: 1400, shield: true }), 'run', '4.5 + 2 x 1.4 > 7')
  assert.equal(creeperEscape({ dist: 3, msLeft: 1500, shield: true }), 'shield', 'close at the start of the fuse')
  assert.equal(creeperEscape({ dist: 2, msLeft: 500, shield: true }), 'shield')
  assert.equal(creeperEscape({ dist: 2, msLeft: 500, shield: false }), 'run', 'nothing to block with')
})

test('totem: low health, lethal falls, burning at half health', () => {
  const s = { enabled: true, hasTotem: true, offhand: 'shield', health: 14 }
  assert.equal(totemSwap(s), false)
  assert.equal(totemSwap({ ...s, health: 8 }), true)
  assert.equal(totemSwap({ ...s, lethalFall: true }), true)
  assert.equal(totemSwap({ ...s, health: 10, burning: true }), true)
  assert.equal(totemSwap({ ...s, health: 8, offhand: 'totem_of_undying' }), false, 'already there')
  assert.equal(totemSwap({ ...s, health: 8, enabled: false }), false)
  assert.equal(totemSwap({ ...s, health: 8, hasTotem: false }), false)
})

test('offhand keeps a totem until health is back above 14, and takes it in danger', () => {
  assert.equal(pickOffhand({ hasTotem: true, hasShield: true, health: 12, current: 'totem_of_undying' }), 'totem_of_undying')
  assert.equal(pickOffhand({ hasTotem: true, hasShield: true, health: 16, current: 'totem_of_undying' }), 'shield')
  assert.equal(pickOffhand({ hasTotem: true, hasShield: true, health: 12, current: 'shield' }), 'shield')
  assert.equal(pickOffhand({ hasTotem: true, hasShield: true, health: 20, danger: true }), 'totem_of_undying')
})

test('golden apple mid-fight', () => {
  const s = { enabled: true, health: 8, hasGoldenApple: true, meleeNear: 1, litCreeperNear: false, sinceLastMs: 60_000 }
  assert.equal(goldenAppleNow(s), true)
  assert.equal(goldenAppleNow({ ...s, health: 12 }), false)
  assert.equal(goldenAppleNow({ ...s, health: 12, meleeNear: 3 }), true, 'surrounded: earlier')
  assert.equal(goldenAppleNow({ ...s, litCreeperNear: true }), false, 'get away from the creeper first')
  assert.equal(goldenAppleNow({ ...s, sinceLastMs: 3000 }), false, 'the last one is still working')
  assert.equal(goldenAppleNow({ ...s, enabled: false }), false)
})

test('fall damage and feather falling', () => {
  assert.equal(fallDamage(3), 0)
  assert.equal(fallDamage(4), 1)
  assert.equal(fallDamage(23), 20)
  assert.equal(fallDamage(23, 4), 10, 'Feather Falling IV caps at 48%')
})

test('water clutch: prepare during the fall, place when the ground is in bucket reach', () => {
  const s = { enabled: true, hasBucket: true, dimension: 'minecraft:overworld', fallStartY: 100, y: 90, velY: -1.2, groundY: 70, landingSoft: false, health: 20 }
  assert.deepEqual(clutchDecision(s), { act: 'prepare', damage: 27 })
  assert.equal(clutchDecision({ ...s, y: 72.5 }).act, 'place', 'eyes 4.1 above the ground')
  assert.equal(clutchDecision({ ...s, landingSoft: true }).act, 'none', 'landing in water')
  assert.equal(clutchDecision({ ...s, dimension: 'minecraft:the_nether' }).act, 'none', 'water evaporates')
  assert.equal(clutchDecision({ ...s, fallStartY: 75, y: 74 }).act, 'none', '5 blocks: 2 damage, not worth it')
  assert.equal(clutchDecision({ ...s, fallStartY: 75, y: 74, health: 2 }).act, 'prepare', 'but it is when it would kill')
  assert.equal(clutchDecision({ ...s, hasBucket: false }).act, 'none')
  assert.equal(clutchDecision({ ...s, groundY: null }).act, 'none')
})

test('extinguish: burning on solid ground with a bucket, not in the Nether', () => {
  const s = { enabled: true, burning: true, inWater: false, inLava: false, hasBucket: true, dimension: 'minecraft:overworld', solidBelow: true }
  assert.equal(extinguishDecision(s), true)
  assert.equal(extinguishDecision({ ...s, inLava: true }), false, 'get out of the lava first')
  assert.equal(extinguishDecision({ ...s, dimension: 'minecraft:the_nether' }), false)
  assert.equal(extinguishDecision({ ...s, burning: false }), false)
})

test('enderman gaze: vanilla cone, and averting it lowers the pitch', () => {
  const eye = { x: 0, y: 65.62, z: 0 }
  const end = { x: 0, y: 64, z: -10 } // 10 north, eyes at 66.55
  const pitchAtEyes = Math.atan2(66.55 - 65.62, 10)
  assert.equal(gazeProvokes(eye, 0, pitchAtEyes, end), true, 'looking straight at its eyes')
  assert.equal(gazeProvokes(eye, 0, 0, end), false, 'the cone is narrow: a level gaze at 10 blocks misses its eyes')
  assert.equal(gazeProvokes(eye, 0, 0, { x: 0, y: 63, z: -2 }), true, 'but not at 2 blocks')
  assert.equal(gazeProvokes(eye, 0, -0.4, end), false, 'looking at its feet')
  assert.equal(gazeProvokes(eye, Math.PI / 2, pitchAtEyes, end), false, 'looking west')
  assert.equal(gazeProvokes(eye, 0, pitchAtEyes, { x: 0, y: 64, z: -80 }), false, 'beyond 64 blocks')
  const p = avertGaze(eye, 0, pitchAtEyes, [end])!
  assert.ok(p < pitchAtEyes && !gazeProvokes(eye, 0, p, end))
  assert.equal(avertGaze(eye, Math.PI, 0, [end]), 0, 'facing away: unchanged')
  const v = viewVector(0, 0)
  assert.ok(Math.abs(v.z + 1) < 1e-9, 'yaw 0 looks north (-z)')
})

test('arrows are wasted on endermen and breezes', () => {
  assert.ok(rangedUseless('enderman'))
  assert.ok(rangedUseless('breeze'))
  assert.ok(!rangedUseless('skeleton'))
})

test('chokepoint: a 1-wide corridor facing the mobs', () => {
  // walls everywhere except an open field south (z >= 3) and a corridor x = 0, z = -2..2
  const open = (dx: number, dz: number) => dz >= 3 || (dx === 0 && dz >= -2 && dz <= 2)
  const c = findChokepoint(open, { x: 0, z: 8 }, 6)
  assert.ok(c)
  assert.equal(c!.dx, 0)
  assert.ok(c!.dz >= -2 && c!.dz <= 1, 'inside the corridor with corridor in front')
  assert.deepEqual(c!.face, { x: 0, z: 1 })
  // an open field has none
  assert.equal(findChokepoint(() => true, { x: 0, z: 8 }, 6), null)
  // mobs behind the corridor's closed end: the corridor doesn't face them
  const dead = (dx: number, dz: number) => dz >= 3 || (dx === 0 && dz >= -2 && dz <= 2)
  const r = findChokepoint(dead, { x: 0, z: -8 }, 6)
  assert.ok(r === null || r.face.z === -1)
  assert.equal(wantChokepoint({ enabled: true, meleeNear: 3, health: 14 }), true)
  assert.equal(wantChokepoint({ enabled: true, meleeNear: 3, health: 8 }), false, 'under half: escape instead')
  assert.equal(wantChokepoint({ enabled: false, meleeNear: 5, health: 20 }), false)
})

test('pvp: off by default, defend only against attackers, never owners or friends', () => {
  const s = { mode: 'defend' as const, player: 'Griefer', owners: ['robin'], friends: ['Ally'], sinceHitMs: 1000, dist: 3 }
  assert.deepEqual(pvpDecision(s), { act: 'fight' })
  assert.equal(pvpDecision({ ...s, mode: 'off' }).act, 'stop')
  assert.deepEqual(pvpDecision({ ...s, sinceHitMs: 6000 }), { act: 'stop', why: 'stopped attacking' })
  assert.deepEqual(pvpDecision({ ...s, dist: 14 }), { act: 'stop', why: 'ran off' })
  assert.equal(pvpRefusal({ ...s, player: 'Robin' }), 'an owner')
  assert.equal(pvpRefusal({ ...s, player: 'ally' }), 'a friend')
  assert.equal(pvpRefusal({ ...s, invulnerable: true }), 'in creative or spectator')
  assert.equal(pvpMode(undefined), 'off')
  assert.equal(pvpMode('defend'), 'defend')
  assert.equal(pvpMode('attack'), 'off', 'anything else is off')
})

test('combat toggles parse', () => {
  for (const k of ['sprintReset', 'sweep', 'shieldMelee', 'totem', 'goldenApple', 'waterClutch', 'endermanGaze', 'chokepoints']) {
    const d = findToggle(`combat.${k}`)
    assert.ok(d, k)
    assert.deepEqual(parseToggleValue(d!, 'off'), { ok: true, value: false })
  }
  assert.deepEqual(parseToggleValue(findToggle('combat.pvp')!, 'defend'), { ok: true, value: 'defend' })
  assert.equal(parseToggleValue(findToggle('combat.pvp')!, 'attack').ok, false, 'there is no attack mode')
  assert.deepEqual(parseToggleValue(findToggle('combat.friends')!, 'a, b'), { ok: true, value: ['a', 'b'] })
})

test('no mob counts as shielded; weapon damage lookup', () => {
  assert.equal(SHIELDED.has('vindicator'), false)
  assert.equal(meleeDamage('iron_sword'), 6)
  assert.equal(meleeDamage(null), 1)
})

test('the warden is never fought', async () => {
  const { attackRefusal } = await import('../src/skills/tactics.ts')
  const r = attackRefusal({ name: 'warden', player: false, named: false, owned: false, hostile: true, attacking: true })
  assert.match(r ?? '', /too strong/)
})
