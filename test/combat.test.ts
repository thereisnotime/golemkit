import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  attackCooldownMs, swingDecision, hitFactor, rankTargets, threatScore, outnumbered, shouldDisengageToHeal, shouldEatInLull,
  pickArmor, armorScore, pickOffhand, aimArrow, arrowHeightAt, spacing, chaseRefusal, unpreparedForNight, type SwingState
} from '../src/skills/tactics.ts'

test('attack cooldown follows the weapon attack speed', () => {
  assert.equal(attackCooldownMs('iron_sword'), 625)
  assert.equal(attackCooldownMs('netherite_sword'), 625)
  assert.equal(attackCooldownMs('stone_axe'), 1250)
  assert.equal(attackCooldownMs('iron_axe'), 1111)
  assert.equal(attackCooldownMs('diamond_axe'), 1000)
  assert.equal(attackCooldownMs('iron_pickaxe'), 833)
  assert.equal(attackCooldownMs('trident'), 909)
  assert.equal(attackCooldownMs(null), 250, 'fist')
  assert.equal(attackCooldownMs('modpack:steel_sword'), 625, 'modded swords by name')
})

const base: SwingState = { cooldownLeftMs: 0, reach: 2.5, onGround: true, velY: 0, inLiquid: false, headroom: true, crits: true, firstHit: false }

test('crit timing: jump before the cooldown ends, hit while falling', () => {
  assert.equal(swingDecision({ ...base, cooldownLeftMs: 500 }), 'wait', 'too early to jump')
  assert.equal(swingDecision({ ...base, cooldownLeftMs: 250 }), 'jump', 'jump so the fall starts as the charge completes')
  assert.equal(swingDecision({ ...base, cooldownLeftMs: 0, onGround: false, velY: 0.3 }), 'wait', 'still rising')
  assert.equal(swingDecision({ ...base, cooldownLeftMs: 0, onGround: false, velY: -0.2 }), 'swing', 'falling and charged: crit')
  assert.equal(swingDecision({ ...base, cooldownLeftMs: 100, onGround: false, velY: -0.2 }), 'wait', 'never swing uncharged')
  assert.equal(swingDecision({ ...base, cooldownLeftMs: 0 }), 'jump', 'charged on the ground: jump for the crit')
  assert.equal(swingDecision({ ...base, reach: 3.4 }), 'wait', 'out of reach')
})

test('crit timing: no jumping in water, under a ceiling, with crits off or when hurried', () => {
  assert.equal(swingDecision({ ...base, inLiquid: true }), 'swing')
  assert.equal(swingDecision({ ...base, headroom: false }), 'swing')
  assert.equal(swingDecision({ ...base, crits: false }), 'swing')
  assert.equal(swingDecision({ ...base, hurry: true }), 'swing')
  assert.equal(swingDecision({ ...base, crits: false, cooldownLeftMs: 200 }), 'wait')
})

test('first hit is a sprint knockback hit', () => {
  assert.equal(swingDecision({ ...base, firstHit: true }), 'sprint_hit')
  assert.equal(swingDecision({ ...base, firstHit: true, cooldownLeftMs: 200 }), 'wait', 'no jump before the first hit')
})

test('hit factor: charge squared, crits x1.5 only when charged', () => {
  assert.equal(hitFactor(1, false), 1)
  assert.equal(hitFactor(1, true), 1.5)
  assert.ok(Math.abs(hitFactor(0.5, false) - 0.4) < 1e-9)
  assert.ok(Math.abs(hitFactor(0.5, true) - 0.4) < 1e-9, 'uncharged crits do not count')
})

test('threat ranking: close creeper > archer in sight > nearest melee', () => {
  const list = [
    { id: 1, name: 'zombie', dist: 3, los: true },
    { id: 2, name: 'skeleton', dist: 12, los: true },
    { id: 3, name: 'creeper', dist: 5, los: true },
    { id: 4, name: 'zombie', dist: 2, los: true },
    { id: 5, name: 'skeleton', dist: 8, los: false }
  ]
  assert.deepEqual(rankTargets(list).map(t => t.id), [3, 2, 4, 1, 5])
  assert.ok(threatScore({ id: 0, name: 'creeper', dist: 4, los: true, fuseLit: true }) > threatScore({ id: 0, name: 'creeper', dist: 2, los: true }), 'lit fuse first')
  assert.ok(threatScore({ id: 0, name: 'creeper', dist: 15, los: true }) < threatScore({ id: 0, name: 'zombie', dist: 3, los: true }), 'far creeper waits')
})

test('disengage decisions', () => {
  assert.equal(outnumbered({ health: 9, meleeNear: 3 }), true)
  assert.equal(outnumbered({ health: 10, meleeNear: 3 }), false, 'half health is not under half')
  assert.equal(outnumbered({ health: 4, meleeNear: 2 }), false)
  const heal = { enabled: true, health: 4, food: 12, hasFood: true, hasGoldenApple: false }
  assert.equal(shouldDisengageToHeal(heal), true)
  assert.equal(shouldDisengageToHeal({ ...heal, health: 5 }), false)
  assert.equal(shouldDisengageToHeal({ ...heal, enabled: false }), false)
  assert.equal(shouldDisengageToHeal({ ...heal, hasFood: false }), false, 'nothing to eat: keep fighting')
  assert.equal(shouldDisengageToHeal({ ...heal, food: 20 }), false, 'full bar: normal food cannot be eaten')
  assert.equal(shouldDisengageToHeal({ ...heal, food: 20, hasGoldenApple: true }), true, 'golden apples always work')
  assert.equal(shouldEatInLull({ health: 14, food: 16, nearestMob: 8, hasFood: true, hasGoldenApple: false }), true)
  assert.equal(shouldEatInLull({ health: 14, food: 16, nearestMob: 3, hasFood: true, hasGoldenApple: false }), false, 'not with a mob close')
  assert.equal(shouldEatInLull({ health: 14, food: 19, nearestMob: 8, hasFood: true, hasGoldenApple: false }), false, 'regenerating already')
})

test('armour choice: best per slot, only upgrades', () => {
  const inv = [{ name: 'leather_helmet' }, { name: 'iron_helmet' }, { name: 'iron_chestplate' }, { name: 'golden_boots' }, { name: 'stick' }]
  const picks = pickArmor(inv, { head: null, torso: { name: 'diamond_chestplate' }, legs: null, feet: { name: 'iron_boots' } })
  assert.deepEqual(Object.fromEntries(Object.entries(picks).map(([k, v]) => [k, v!.name])), { head: 'iron_helmet' })
  assert.equal(armorScore({ name: 'stick' }), null)
  const prot = pickArmor([{ name: 'iron_chestplate', enchants: [{ name: 'protection', lvl: 4 }] }], { torso: { name: 'iron_chestplate' } })
  assert.equal(prot.torso?.name, 'iron_chestplate', 'enchanted beats plain')
  const worn = pickArmor([{ name: 'iron_chestplate', durabilityLeft: 3 }], { torso: { name: 'chainmail_chestplate' } })
  assert.equal(worn.torso, undefined, 'nearly broken piece is not an upgrade')
})

test('offhand: totem when it matters, shield otherwise', () => {
  assert.equal(pickOffhand({ hasTotem: true, hasShield: true, health: 20 }), 'shield')
  assert.equal(pickOffhand({ hasTotem: true, hasShield: true, health: 8 }), 'totem_of_undying')
  assert.equal(pickOffhand({ hasTotem: true, hasShield: false, health: 20 }), 'totem_of_undying')
  assert.equal(pickOffhand({ hasTotem: false, hasShield: false, health: 20 }), null)
})

test('ballistic aim lands on the target, with gravity and lead', () => {
  const from = { x: 0, y: 65, z: 0 }
  for (const d of [8, 20, 35]) {
    const a = aimArrow(from, { x: 0, y: 65, z: -d })!
    assert.ok(a, `solution at ${d}`)
    assert.ok(a.pitch > 0, 'aims above a level target')
    assert.ok(Math.abs(a.yaw) < 1e-9, 'north is yaw 0')
    assert.ok(Math.abs(arrowHeightAt(3, a.pitch, d)!) < 0.05, `lands within 5 cm at ${d}`)
  }
  assert.ok(aimArrow(from, { x: 0, y: 65, z: -35 })!.pitch > aimArrow(from, { x: 0, y: 65, z: -10 })!.pitch, 'further = higher')
  // moving target: aim where it will be
  const still = aimArrow(from, { x: 20, y: 65, z: 0 })!
  const moving = aimArrow(from, { x: 20, y: 65, z: 0 }, { x: 0, y: 0, z: 0.2 })!
  assert.notEqual(Math.sign(moving.yaw - still.yaw), 0)
  const t = moving.ticks
  const predicted = { x: 20, z: 0.2 * t }
  assert.ok(Math.abs(Math.atan2(-predicted.x, -predicted.z) - moving.yaw) < 0.01, 'yaw points at the predicted position')
  assert.equal(aimArrow(from, { x: 0, y: 65, z: -500 }), null, 'out of range')
})

test('spacing and chase limits', () => {
  assert.equal(spacing(1.5), 'back')
  assert.equal(spacing(2.5), 'strafe')
  assert.equal(spacing(3.5), 'forward')
  const ok = { fromStart: 5, maxChase: 16, targetInLiquid: false, dropBelow: 0, targetInDark: false, botInDark: false }
  assert.equal(chaseRefusal(ok), null)
  assert.match(chaseRefusal({ ...ok, fromStart: 17 })!, /chased/)
  assert.match(chaseRefusal({ ...ok, targetInLiquid: true })!, /water/)
  assert.match(chaseRefusal({ ...ok, dropBelow: 6 })!, /drop/)
  assert.match(chaseRefusal({ ...ok, targetInDark: true })!, /cave/)
  assert.equal(chaseRefusal({ ...ok, targetInDark: true, botInDark: true }), null, 'already in the cave')
})

test('night readiness', () => {
  assert.equal(unpreparedForNight({ armorPoints: 15, hasWeapon: true, hasFood: true }), null)
  assert.equal(unpreparedForNight({ armorPoints: 0, hasWeapon: true, hasFood: true }), 'no armour')
  assert.equal(unpreparedForNight({ armorPoints: 0, hasWeapon: false, hasFood: false }), 'no armour, no weapon, no food')
})
