import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  threatReason, rankGuardThreats, guardSpot, blockSpot, feedDecision, WarnLimiter, compass, relativeDir, warnText, warnKey,
  motion, facingTowards, shouldRetarget, inLineOfFire, type GuardThreat, type FeedState
} from '../src/skills/guard-plan.ts'
import { attackRefusal, type AttackCandidate } from '../src/skills/tactics.ts'
import { assessDanger } from '../src/brains/behaviors/library/safety.ts'
import { setEscort, escorting } from '../src/skills/bodyguard.ts'
import { defaultBehaviorRegistry } from '../src/brains/behaviors/index.ts'

const mob = (o: Partial<GuardThreat> & { name: string }): GuardThreat => ({ id: Math.floor(Math.random() * 1e6), distPlayer: 10, distBot: 10, losPlayer: true, hostile: true, ...o })

test('threats to the player: creepers within 6 always come first', () => {
  const ranked = rankGuardThreats([
    mob({ name: 'zombie', distPlayer: 2, hurtPlayer: true }),
    mob({ name: 'skeleton', distPlayer: 8, losPlayer: true, hurtPlayer: true }),
    mob({ name: 'creeper', distPlayer: 5.5 }),
    mob({ name: 'phantom', distPlayer: 4, diving: true })
  ], 16)
  assert.equal(ranked[0]!.name, 'creeper')
  assert.equal(ranked[1]!.name, 'zombie', 'a zombie hitting the player beats an archer')
  assert.equal(ranked[2]!.name, 'skeleton')
  const loose = rankGuardThreats([mob({ name: 'zombie', distPlayer: 5, hurtPlayer: true }), mob({ name: 'skeleton', distPlayer: 8, losPlayer: true, hurtPlayer: true })], 16)
  assert.equal(loose[0]!.name, 'skeleton', 'an archer that hit the player beats melee that is not on them')
  const contact = rankGuardThreats([mob({ name: 'zombie', distPlayer: 1.5, hurtPlayer: true }), mob({ name: 'creeper', distPlayer: 5.9 })], 16)
  assert.equal(contact[0]!.name, 'creeper', 'a creeper by the player still goes first')
  const lit = rankGuardThreats([mob({ name: 'creeper', distPlayer: 6 }), mob({ name: 'creeper', id: 7, distPlayer: 5.9, fuseLit: true })], 16)
  assert.equal(lit[0]!.id, 7, 'lit fuse first')
})

test('threats to the player: ranking is measured from the player, not the bot', () => {
  const nearPlayer = mob({ name: 'zombie', id: 1, distPlayer: 3, distBot: 12, approaching: true })
  const nearBot = mob({ name: 'zombie', id: 2, distPlayer: 14, distBot: 3 })
  const ranked = rankGuardThreats([nearBot, nearPlayer], 16)
  assert.deepEqual(ranked.map(t => t.id), [1, 2])
  assert.equal(ranked[1]!.reason, 'on me', 'mobs that only bother the bot still count, after the player\'s')
})

test('threat signals: archers need a shot, flyers must dive, melee must come for the player', () => {
  assert.equal(threatReason(mob({ name: 'skeleton', distPlayer: 14, losPlayer: false }), 16), null, 'skeleton behind a wall')
  assert.equal(threatReason(mob({ name: 'skeleton', distPlayer: 10, losPlayer: false, facing: true, approaching: true }), 16), null, 'skeleton in a cave below, looking up')
  assert.equal(threatReason(mob({ name: 'skeleton', distPlayer: 14, losPlayer: true }), 16), 'has a shot at the player')
  assert.equal(threatReason(mob({ name: 'phantom', distPlayer: 18 }), 16), null, 'circling phantom')
  assert.equal(threatReason(mob({ name: 'phantom', distPlayer: 18, diving: true }), 16), 'diving at the player')
  assert.equal(threatReason(mob({ name: 'zombie', distPlayer: 12 }), 16), null, 'idle zombie')
  assert.equal(threatReason(mob({ name: 'zombie', distPlayer: 12, facing: true }), 16), 'coming for the player')
  assert.equal(threatReason(mob({ name: 'zombie', distPlayer: 20, approaching: true }), 16), null, 'outside range')
  assert.equal(threatReason(mob({ name: 'creeper', distPlayer: 7 }), 16), null, 'creeper rule is 6 blocks')
})

test('neutral mobs only when they attack the player or the bot', () => {
  assert.equal(threatReason(mob({ name: 'enderman', hostile: false, distPlayer: 2 }), 16), null)
  assert.equal(threatReason(mob({ name: 'enderman', hostile: false, distPlayer: 2, hurtPlayer: true }), 16), 'hurt the player')
  assert.equal(threatReason(mob({ name: 'wolf', hostile: false, distBot: 2, hurtBot: true }), 16), 'attacked me')
})

test('never attack players, pets, villagers, golems or named mobs', () => {
  const c = (o: Partial<AttackCandidate>): AttackCandidate => ({ name: 'zombie', player: false, named: false, owned: false, hostile: true, attacking: false, ...o })
  assert.equal(attackRefusal(c({})), null)
  assert.equal(attackRefusal(c({ name: 'player', player: true, attacking: true })), 'a player')
  assert.equal(attackRefusal(c({ name: 'villager', hostile: false, attacking: true })), 'a villager')
  assert.equal(attackRefusal(c({ name: 'iron_golem', hostile: false, attacking: true })), 'a iron_golem')
  assert.equal(attackRefusal(c({ name: 'snow_golem', hostile: false })), 'a snow_golem')
  assert.equal(attackRefusal(c({ named: true })), 'named', 'a named zombie is somebody\'s')
  assert.equal(attackRefusal(c({ name: 'wolf', hostile: false, owned: true, attacking: true })), 'someone\'s pet')
  assert.equal(attackRefusal(c({ name: 'cat', hostile: false, attacking: true })), 'a cat')
  assert.equal(attackRefusal(c({ name: 'wolf', hostile: false })), 'not hostile', 'wild wolf minding its business')
  assert.equal(attackRefusal(c({ name: 'wolf', hostile: false, attacking: true })), null, 'wild wolf attacking')
  assert.equal(attackRefusal(c({ name: 'piglin', hostile: false, attacking: true })), null)
  assert.equal(attackRefusal(c({ name: 'cow', hostile: false, attacking: true })), 'not hostile')
})

test('guard spot: between the player and the threat, at the follow distance', () => {
  const p = { x: 0, y: 64, z: 0 }
  const s = guardSpot(p, { x: 10, y: 64, z: 0 }, 3)!
  assert.deepEqual(s, { x: 3, y: 64, z: 0 })
  const half = guardSpot(p, { x: 0, y: 64, z: -4 }, 3)!
  assert.ok(Math.abs(half.z + 2) < 1e-9, 'never further than halfway to the mob')
  const minimum = guardSpot(p, { x: 2, y: 64, z: 0 }, 3)!
  assert.equal(minimum.x, 1.5, 'not inside the player')
  assert.equal(guardSpot(p, { x: 0.3, y: 64, z: 0.2 }, 3), null)
})

test('line-of-sight blocking spot', () => {
  const p = { x: 0, y: 64, z: 0 }
  const level = blockSpot(p, { x: 0, y: 64, z: 15 })!
  assert.ok(level.covers)
  assert.ok(Math.abs(level.spot.z - 1.5) < 1e-9 && level.spot.x === 0, 'on the line, 1.5 out')
  const ridge = blockSpot(p, { x: 10, y: 72, z: 0 })!
  assert.ok(ridge.spot.x < 1.5, 'archer above: stand closer so the steep line still crosses the body')
  assert.ok(ridge.covers)
  const cliff = blockSpot(p, { x: 4, y: 80, z: 0 })!
  assert.equal(cliff.covers, false, 'shooting almost straight down: no spot covers it, close in instead')
  assert.equal(blockSpot(p, { x: 2, y: 64, z: 0 }), null, 'too close to bother blocking')
})

test('feed decision', () => {
  const s: FeedState = {
    playerHealth: 6,
    playerFood: null,
    distance: 3,
    foods: [{ name: 'bread', count: 5, points: 5 }, { name: 'cooked_beef', count: 2, points: 8 }],
    keepForSelf: 4,
    sinceLastFedMs: Infinity,
    threatClose: false
  }
  assert.deepEqual(feedDecision(s), { give: 'cooked_beef', count: 2, why: 'health 6' })
  assert.ok('skip' in feedDecision({ ...s, playerHealth: null }), 'no metadata: skip honestly')
  assert.equal((feedDecision({ ...s, playerHealth: null }) as { skip: string }).skip, "can't see their health or hunger")
  assert.ok('skip' in feedDecision({ ...s, playerHealth: 15 }), 'healthy')
  assert.ok('skip' in feedDecision({ ...s, sinceLastFedMs: 10_000 }), 'just fed them')
  assert.ok('skip' in feedDecision({ ...s, threatClose: true }))
  assert.ok('skip' in feedDecision({ ...s, distance: 9 }))
  assert.ok('skip' in feedDecision({ ...s, foods: [{ name: 'bread', count: 4, points: 5 }] }), 'keeps its own reserve')
  assert.deepEqual(feedDecision({ ...s, foods: [{ name: 'bread', count: 5, points: 5 }] }), { give: 'bread', count: 1, why: 'health 6' }, 'only what is spare')
  assert.deepEqual(feedDecision({ ...s, playerHealth: null, playerFood: 4 }), { give: 'cooked_beef', count: 2, why: 'food 4' })
})

test('warning rate limit: a gap between warnings, longer before the same one', () => {
  const l = new WarnLimiter(5000, 30_000)
  assert.equal(l.allow('creeper:north', 0), true)
  assert.equal(l.allow('skeleton:east', 1000), false, 'global gap')
  assert.equal(l.allow('skeleton:east', 5000), true)
  assert.equal(l.allow('creeper:north', 11_000), false, 'same warning again too soon')
  assert.equal(l.allow('creeper:north', 30_000), true)
})

test('warning directions and texts', () => {
  assert.equal(compass(0, -5), 'north')
  assert.equal(compass(5, 0), 'east')
  assert.equal(compass(5, 5), 'south-east')
  assert.equal(compass(-3, -3), 'north-west')
  // yaw 0 faces north (-z)
  assert.equal(relativeDir(0, 0, 5), 'behind you')
  assert.equal(relativeDir(0, 0, -5), 'ahead of you')
  assert.equal(relativeDir(0, -5, 0), 'to your left')
  assert.equal(relativeDir(0, 5, 0), 'to your right')
  assert.equal(relativeDir(Math.PI / 2, -5, 0), 'ahead of you', 'yaw pi/2 faces west')
  const p = { x: 0, y: 64, z: 0 }
  assert.equal(warnText('creeper', p, 0, { x: 0, y: 64, z: 4 }), 'creeper behind you')
  assert.equal(warnText('skeleton', p, 0, { x: 12, y: 69, z: 1 }), 'skeleton on the ridge east')
  assert.equal(warnText('skeleton', p, 0, { x: 0, y: 64, z: 12 }), 'skeleton south')
  assert.equal(warnText('phantom', p, 0, { x: 0, y: 80, z: 0 }, 3), 'phantoms incoming')
  assert.equal(warnText('zombie', p, 0, { x: -5, y: 64, z: 0 }, 2), '2 zombies to your left')
  assert.equal(warnKey('skeleton', p, { x: 12, y: 69, z: 1 }), 'skeleton:east')
})

test('motion: approaching and diving from two samples', () => {
  assert.deepEqual(motion(undefined, { dist: 5, y: 70, flat: 5, at: 1000 }), { approaching: false, descending: false })
  assert.deepEqual(motion({ dist: 10, y: 80, flat: 8, at: 0 }, { dist: 7, y: 76, flat: 6, at: 1000 }), { approaching: true, descending: true })
  assert.deepEqual(motion({ dist: 10, y: 80, flat: 8, at: 0 }, { dist: 10.2, y: 80, flat: 8, at: 1000 }), { approaching: false, descending: false })
  assert.equal(facingTowards(0, { x: 0, y: 0, z: 10 }, { x: 0, y: 0, z: 0 }), true, 'yaw 0 looks north, the player is north')
  assert.equal(facingTowards(Math.PI, { x: 0, y: 0, z: 10 }, { x: 0, y: 0, z: 0 }), false)
})

test('stay_safe does not go home at night while a bodyguard escorts someone', () => {
  const agent: any = { storage: { get: (_k: string, d: unknown) => d }, protectedAreas: { isProtected: () => false }, getAction: () => null, canDig: false }
  const home = { x: 100, y: 64, z: 100 }
  agent.storage.get = (k: string, d: unknown) => k === 'home' ? home : d
  const bot: any = { entity: { position: { x: 0, y: 64, z: 0, offset: () => ({}) } }, health: 20, entities: {}, inventory: { items: () => [] } }
  const bb: any = { facts: { isNight: true, sleeping: false, homeDistance: 141 } }
  const o = { retreatBelow: 10, mobRadius: 10, surroundedBy: 3, pillar: true, avoidWater: true, homeAtNight: true, homeRange: 8, shelterUnprepared: true, ranged: true }
  const before = assessDanger({ agent, bot, bb }, o)
  setEscort(agent, 'Owner')
  assert.equal(escorting(agent), 'Owner')
  assert.equal(assessDanger({ agent, bot, bb }, o), null)
  assert.notEqual(before, null, 'sanity: without the escort it does want to leave')
})

test('bodyguard is registered, at behaviour level, with the documented options', () => {
  const reg = defaultBehaviorRegistry()
  const def = reg.get('bodyguard')!
  assert.equal(def.priority, 'behavior')
  const v = reg.validate('bodyguard', { player: 'Robin' })
  assert.ok(v.ok)
  if (v.ok) assert.deepEqual({ ...v.options }, { player: 'Robin', distance: 3, range: 16, feed: true, keepFood: 4, warn: true, chat: true, whisper: false, whenGone: 'stay', catchUp: 48 })
})

test('protect drops its target for a clearly more urgent one, not for a close call', () => {
  const archer = mob({ name: 'skeleton', id: 1, distPlayer: 9, losPlayer: true })
  const zombieOnPlayer = mob({ name: 'zombie', id: 2, distPlayer: 1.2, hurtPlayer: true })
  const ranked = rankGuardThreats([archer, zombieOnPlayer], 16)
  assert.equal(shouldRetarget(1, ranked)?.id, 2, 'chasing an archer while a zombie hits the player')
  assert.equal(shouldRetarget(2, ranked), null, 'already on the top threat')
  const two = rankGuardThreats([mob({ name: 'zombie', id: 3, distPlayer: 4, approaching: true }), mob({ name: 'zombie', id: 4, distPlayer: 6, approaching: true })], 16)
  assert.equal(shouldRetarget(4, two), null, 'two zombies a few blocks apart: keep the current one')
  assert.equal(shouldRetarget(99, two)?.id, 3, 'the current target is no threat any more')
  assert.equal(shouldRetarget(3, []), null)
})

test('stay_safe: a healthy bodyguard keeps fighting in a crowd, a hurt one still gets out', () => {
  const agent: any = { storage: { get: (_k: string, d: unknown) => d }, protectedAreas: { isProtected: () => false }, getAction: () => null, canDig: false }
  const at = (x: number) => ({ x, y: 64, z: 0 })
  const zombie = (id: number, x: number) => ({ id, name: 'zombie', type: 'hostile', position: at(x) })
  const bot: any = { entity: { position: at(0) }, health: 20, entities: { 1: zombie(1, 2), 2: zombie(2, -2), 3: zombie(3, 3) }, inventory: { items: () => [] } }
  const bb: any = { facts: { isNight: false, sleeping: false, homeDistance: null } }
  const o = { retreatBelow: 10, mobRadius: 10, surroundedBy: 3, pillar: true, avoidWater: true, homeAtNight: true, homeRange: 8, shelterUnprepared: false, ranged: true }
  assert.equal(assessDanger({ agent, bot, bb }, o), 'surrounded', 'not escorting: 3 zombies within 6 is surrounded')
  setEscort(agent, 'Owner')
  assert.equal(assessDanger({ agent, bot, bb }, o), null, 'escorting at full health: fight')
  bot.health = 12
  assert.equal(assessDanger({ agent, bot, bb }, o), 'surrounded', 'escorting and hurt: get out')
})

test('protect holds fire when the player is in the line of fire', () => {
  const bot = { x: 0, y: 65.6, z: 0 }
  const skeleton = { x: 10, y: 65, z: 0 }
  assert.equal(inLineOfFire(bot, skeleton, { x: 5, y: 64, z: 0.5 }), true, 'player between the bot and the skeleton')
  assert.equal(inLineOfFire(bot, skeleton, { x: 12, y: 64, z: 0 }), true, 'player just behind the skeleton: a miss hits them')
  assert.equal(inLineOfFire(bot, skeleton, { x: 5, y: 64, z: 4 }), false, 'player off to the side')
  assert.equal(inLineOfFire(bot, skeleton, { x: -3, y: 64, z: 0 }), false, 'player behind the bot')
  assert.equal(inLineOfFire(bot, skeleton, { x: 20, y: 64, z: 0 }), false, 'player far past the skeleton')
})
