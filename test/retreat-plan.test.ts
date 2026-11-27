// Leaving fights in time (src/skills/retreatPlan.ts): the damage estimate, the leave rule with
// its floor and hysteresis, fight picking, the escape routes and recovery.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  incomingDamage, retreatDecision, engageDecision, planEscape, homeThroughThreats, recoverStep, retreatSettings,
  afterArmour, armourDefence, difficultyDamage, mobHit, ESCAPE_ROUTES, RETREAT_DEFAULTS, RetreatSchema, type EscapeInput
} from '../src/skills/retreatPlan.ts'
import { TOGGLES } from '../src/core/toggles.ts'

const S = RETREAT_DEFAULTS
const bare = { points: 0, toughness: 0 }
const zombies = (n: number, dist = 1.5) => Array.from({ length: n }, () => ({ name: 'zombie', dist }))

test('estimate: two zombies on an unarmoured bot over 2 s is 4 hits, 12 damage', () => {
  const r = incomingDamage({ threats: zombies(2), defence: bare, hits: 2 })
  assert.equal(r.hits, 4)
  assert.equal(r.damage, 12)
  assert.equal(r.dps, 6)
  assert.equal(r.from, '2 zombie')
})

test('estimate: count, approach time and cooldowns matter', () => {
  assert.equal(incomingDamage({ threats: zombies(1), defence: bare, hits: 2 }).damage, 6)
  // a zombie 8 blocks off needs 2.6 s to arrive: nothing in a 2 s window
  assert.equal(incomingDamage({ threats: zombies(1, 8), defence: bare, hits: 2 }).hits, 0)
  // 4 blocks off: arrives in 0.9 s, hits then and a second later
  assert.equal(incomingDamage({ threats: zombies(1, 4), defence: bare, hits: 2 }).hits, 2)
  assert.equal(incomingDamage({ threats: zombies(1, 6), defence: bare, hits: 2 }).hits, 1)
  // a skeleton shoots every 2 s on normal, every 1 s on hard
  const sk = [{ name: 'skeleton', dist: 10, los: true }]
  assert.equal(incomingDamage({ threats: sk, defence: bare, hits: 2 }).hits, 1)
  assert.equal(incomingDamage({ threats: sk, defence: bare, hits: 2, difficulty: 'hard' }).hits, 2)
  // no line of sight: it can't shoot
  assert.equal(incomingDamage({ threats: [{ name: 'skeleton', dist: 10, los: false }], defence: bare, hits: 2 }).hits, 0)
  // creepers are the creeper rules' business
  assert.equal(incomingDamage({ threats: [{ name: 'creeper', dist: 2 }], defence: bare, hits: 2 }).hits, 0)
})

test('estimate: armour, toughness, shield and difficulty scale it down or up', () => {
  const iron = armourDefence(['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'])
  assert.deepEqual(iron, { points: 15, toughness: 0 })
  assert.deepEqual(armourDefence(['diamond_chestplate', null, 'stone_sword']), { points: 8, toughness: 2 })
  const r = incomingDamage({ threats: zombies(2), defence: iron, hits: 2 })
  assert.ok(r.damage > 5 && r.damage < 6, `iron: ${r.damage}`)
  assert.equal(afterArmour(10, { points: 0, toughness: 0 }), 10)
  assert.equal(Math.round(afterArmour(10, { points: 20, toughness: 8 }) * 10) / 10, 3)
  assert.ok(afterArmour(4, { points: 0, toughness: 0, epf: 10 }) < 2.5)
  assert.equal(incomingDamage({ threats: zombies(2), defence: { ...bare, shield: true }, hits: 2, shieldBlocks: 0.5 }).damage, 6)
  assert.equal(difficultyDamage(3, 'easy'), 2.5)
  assert.equal(difficultyDamage(3, 'hard'), 4.5)
  assert.equal(difficultyDamage(3, 'peaceful'), 0)
  assert.equal(difficultyDamage(3, null), 3)
  assert.equal(mobHit('some_modded_mob')?.damage, 4)
})

test('leave: when health would not survive the estimate, at the floor, not with nothing in reach', () => {
  const two = incomingDamage({ threats: zombies(2), defence: bare, hits: 2 })
  assert.equal(retreatDecision({ health: 12, risk: two, leaving: false, settings: S }).leave, true)
  assert.match(retreatDecision({ health: 12, risk: two, leaving: false, settings: S }).why!, /would not survive 2 zombie/)
  assert.equal(retreatDecision({ health: 13, risk: two, leaving: false, settings: S }).leave, false)
  const one = incomingDamage({ threats: zombies(1), defence: bare, hits: 2 })
  assert.equal(retreatDecision({ health: 7, risk: one, leaving: false, settings: S }).leave, false)
  assert.equal(retreatDecision({ health: 6, risk: one, leaving: false, settings: S }).leave, true)
  // floor: a weak mob still sends it off at 4
  const fish = incomingDamage({ threats: [{ name: 'silverfish', dist: 1 }], defence: bare, hits: 2 })
  assert.match(retreatDecision({ health: 4, risk: fish, leaving: false, settings: S }).why!, /floor/)
  assert.equal(retreatDecision({ health: 4, risk: fish, leaving: false, settings: { ...S, floor: 0 } }).leave, false)
  const none = incomingDamage({ threats: [], defence: bare, hits: 2 })
  assert.equal(retreatDecision({ health: 2, risk: none, leaving: false, settings: S }).leave, false)
})

test('leave: hysteresis keeps it leaving a little above the bar', () => {
  const one = incomingDamage({ threats: zombies(1), defence: bare, hits: 2 })
  assert.equal(retreatDecision({ health: 9, risk: one, leaving: true, settings: S }).leave, true)
  assert.equal(retreatDecision({ health: 11, risk: one, leaving: true, settings: S }).leave, false)
  assert.equal(retreatDecision({ health: 9, risk: one, leaving: true, settings: { ...S, hysteresis: 0 } }).leave, false)
})

test('engage: two of no armour, night, outnumbered avoid the open; owners and fast mobs override', () => {
  const base = { armour: 0, night: false, meleeNear: 1, ownerThreatened: false, allFaster: false, settings: S }
  assert.equal(engageDecision(base).fight, true, 'one zombie by day, no armour: fight')
  const night = engageDecision({ ...base, night: true })
  assert.equal(night.fight, false)
  assert.equal(night.why, 'no armour, night')
  assert.equal(engageDecision({ ...base, meleeNear: 2 }).fight, false)
  assert.equal(engageDecision({ ...base, armour: 15, night: true }).fight, true)
  assert.equal(engageDecision({ ...base, armour: 15, night: true, meleeNear: 3 }).fight, false)
  assert.equal(engageDecision({ ...base, night: true, ownerThreatened: true }).fight, true)
  assert.equal(engageDecision({ ...base, night: true, allFaster: true }).fight, true)
  assert.equal(engageDecision({ ...base, night: true, settings: { ...S, avoidFactors: 3 } }).fight, true, 'bolder profile')
  assert.equal(engageDecision({ ...base, night: true, settings: { ...S, avoidOpen: false } }).fight, true)
  assert.equal(engageDecision({ ...base, night: true, settings: { ...S, enabled: false } }).fight, true)
})

const input = (o: Partial<EscapeInput> = {}): EscapeInput => ({
  home: { dist: 20, throughThreats: false }, canPlace: true, blocks: 16, headroom: 4, protectedHere: false,
  canDig: true, sealable: true, roofed: false, inWater: false, threats: [{ name: 'zombie', ranged: false, flying: false }], settings: S, ...o
})

test('escape: routes in the configured order, each with its own refusal', () => {
  assert.deepEqual(planEscape(input(), S.routes, ESCAPE_ROUTES).usable, ['home', 'pillar', 'bunker', 'sprint'])
  assert.deepEqual(planEscape(input(), ['sprint', 'pillar'], ESCAPE_ROUTES).usable, ['sprint', 'pillar'], 'order and on/off from settings')
  const far = planEscape(input({ home: { dist: 90, throughThreats: false } }), S.routes, ESCAPE_ROUTES)
  assert.deepEqual(far.skipped, [{ id: 'home', why: 'home is 90 blocks away' }])
  assert.equal(planEscape(input({ home: { dist: 20, throughThreats: true } }), ['home'], ESCAPE_ROUTES).skipped[0]!.why, 'the way home runs through them')
  assert.equal(planEscape(input({ home: null }), ['home'], ESCAPE_ROUTES).usable.length, 0)
})

test('escape: no pillar against archers, spiders or without blocks; no bunker without digging', () => {
  const archer = planEscape(input({ threats: [{ name: 'zombie', ranged: false, flying: false }, { name: 'skeleton', ranged: true, flying: false }] }), ['pillar'], ESCAPE_ROUTES)
  assert.match(archer.skipped[0]!.why, /skeleton would shoot it off/)
  assert.match(planEscape(input({ threats: [{ name: 'spider', ranged: false, flying: false }] }), ['pillar'], ESCAPE_ROUTES).skipped[0]!.why, /spider gets up/)
  assert.match(planEscape(input({ blocks: 1 }), ['pillar'], ESCAPE_ROUTES).skipped[0]!.why, /1 blocks/)
  assert.match(planEscape(input({ headroom: 1 }), ['pillar'], ESCAPE_ROUTES).skipped[0]!.why, /no room/)
  assert.match(planEscape(input({ canPlace: false }), ['pillar'], ESCAPE_ROUTES).skipped[0]!.why, /may not place/)
  assert.match(planEscape(input({ protectedHere: true }), ['pillar', 'bunker'], ESCAPE_ROUTES).skipped[1]!.why, /protected/)
  assert.match(planEscape(input({ canDig: false }), ['bunker'], ESCAPE_ROUTES).skipped[0]!.why, /may not dig/)
  assert.match(planEscape(input({ roofed: true }), ['bunker'], ESCAPE_ROUTES).skipped[0]!.why, /roof/)
  assert.match(planEscape(input({ sealable: false }), ['bunker'], ESCAPE_ROUTES).skipped[0]!.why, /seal/)
})

test('escape: running from a mob that outruns the bot is refused', () => {
  const v = planEscape(input({ threats: [{ name: 'vindicator', ranged: false, flying: false }] }), S.routes, ESCAPE_ROUTES)
  assert.deepEqual(v.usable, ['pillar', 'bunker'])
  assert.deepEqual(v.skipped.map(x => x.id), ['home', 'sprint'])
})

test('home through threats: home on the mobs\' side with a mob in between', () => {
  assert.equal(homeThroughThreats({ x: 20, z: 0 }, [{ x: 3, z: 1 }]), true)
  assert.equal(homeThroughThreats({ x: 20, z: 0 }, [{ x: -3, z: 0 }]), false, 'mob behind')
  assert.equal(homeThroughThreats({ x: 20, z: 0 }, [{ x: 0, z: 4 }]), false, 'mob to the side')
  assert.equal(homeThroughThreats({ x: 5, z: 0 }, [{ x: 10, z: 0 }]), false, 'mob beyond home')
  assert.equal(homeThroughThreats({ x: 20, z: 0 }, []), false)
})

test('recover: fight when cornered, eat when it heals, come back healthy, give up in time', () => {
  const r = (o: Partial<Parameters<typeof recoverStep>[0]>) => recoverStep({ health: 8, food: 15, hasFood: true, mobInReach: false, elapsedMs: 0, settings: S, ...o })
  assert.equal(r({ mobInReach: true }), 'fight')
  assert.equal(r({}), 'eat')
  assert.equal(r({ food: 20 }), 'wait')
  assert.equal(r({ hasFood: false }), 'wait')
  assert.equal(r({ health: 16 }), 'healed')
  assert.equal(r({ elapsedMs: 61_000 }), 'give_up')
})

test('settings: defaults, bad values keep the default, every key has a toggle', () => {
  assert.equal(S.hits, 2)
  assert.equal(S.floor, 4)
  assert.deepEqual(S.routes, ['home', 'pillar', 'bunker', 'sprint'])
  const s = retreatSettings({ hits: 3, floor: 'x', routes: ['sprint', 'teleport'], avoidFactors: 3 })
  assert.equal(s.hits, 3)
  assert.equal(s.floor, 4)
  assert.deepEqual(s.routes, ['home', 'pillar', 'bunker', 'sprint'])
  assert.equal(s.avoidFactors, 3)
  assert.deepEqual(retreatSettings(undefined), S)
  const keys = new Set(TOGGLES.filter(t => t.key.startsWith('retreat.')).map(t => t.key.slice(8)))
  assert.deepEqual([...keys].sort(), Object.keys(RetreatSchema.shape).sort())
  // and the toggle schemas accept the defaults
  for (const t of TOGGLES.filter(t => t.key.startsWith('retreat.'))) assert.ok(t.schema.safeParse((S as any)[t.key.slice(8)]).success, t.key)
})
