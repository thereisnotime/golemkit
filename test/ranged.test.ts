import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isShooter, incoming, patrolCount, rangedResponse, activeShooters, canEatUnderFire, lineBlocked, findCover, retreatPoint,
  gearScore, gearNeeded, hideMs, stillHiding, leaveCover, coverHoldMs, cappedRetreat, planWall,
  heavyFire, quickCover, quickWall, exposureHits, shieldWhileFleeing, fleePoint, FLEE_CAP,
  type RangedState, type ShooterView
} from '../src/skills/ranged-plan.ts'
import { rangedDanger } from '../src/adapters/minecraft-java/behaviors/safety.ts'
import { creeperMove } from '../src/skills/tactics.ts'
import { threatReason, rankGuardThreats, etaToPlayer, interceptPoint, pullPlan, type GuardThreat } from '../src/skills/guard-plan.ts'

test('shooters: archers, pillagers, witches, blazes, ghasts; drowned only with a trident', () => {
  for (const n of ['skeleton', 'stray', 'bogged', 'pillager', 'witch', 'blaze', 'ghast']) assert.ok(isShooter(n), n)
  assert.ok(isShooter('drowned', 'trident'))
  assert.ok(!isShooter('drowned', null))
  assert.ok(!isShooter('zombie'))
  assert.ok(!isShooter('vindicator'))
})

test('projectiles: an arrow on course for the bot is incoming, one going past is not', () => {
  const bot = { x: 0, y: 64, z: 0 }
  // fired from 15 blocks east at chest height, flat and fast: hits
  const hit = incoming({ name: 'arrow', pos: { x: 15, y: 65.5, z: 0 }, vel: { x: -2.4, y: 0.12, z: 0 } }, bot)
  assert.ok(hit, 'straight at the bot')
  assert.ok(hit!.ticks > 4 && hit!.ticks < 9, `about 6 ticks, got ${hit!.ticks}`)
  // same speed, aimed 5 blocks to the side
  assert.equal(incoming({ name: 'arrow', pos: { x: 15, y: 65.5, z: 5 }, vel: { x: -2.4, y: 0.12, z: 0 } }, bot), null)
  // flying away from the bot
  assert.equal(incoming({ name: 'arrow', pos: { x: 3, y: 65, z: 0 }, vel: { x: 2.4, y: 0.1, z: 0 } }, bot), null)
  // stuck in the ground
  assert.equal(incoming({ name: 'arrow', pos: { x: 1, y: 64, z: 0 }, vel: { x: 0, y: 0, z: 0 } }, bot), null)
  // a ghast fireball has no gravity: aimed level it stays level
  assert.ok(incoming({ name: 'fireball', pos: { x: 0, y: 65, z: 30 }, vel: { x: 0, y: 0, z: -1 } }, bot))
  // a lobbed splash potion from a witch comes down on the bot
  assert.ok(incoming({ name: 'potion', pos: { x: 6, y: 65.5, z: 0 }, vel: { x: -0.6, y: 0.3, z: 0 } }, bot, { radius: 1.5 }))
})

test('patrol: pillagers, vindicators, ravagers within range are counted, witches and far ones are not', () => {
  const c = { x: 0, y: 64, z: 0 }
  const mobs = [
    { name: 'pillager', pos: { x: 5, y: 64, z: 0 } },
    { name: 'pillager', pos: { x: 8, y: 64, z: 3 } },
    { name: 'vindicator', pos: { x: 6, y: 64, z: -2 } },
    { name: 'pillager', pos: { x: 40, y: 64, z: 0 } },
    { name: 'witch', pos: { x: 3, y: 64, z: 0 } },
    { name: 'skeleton', pos: { x: 3, y: 64, z: 0 } }
  ]
  assert.equal(patrolCount(mobs, c), 3)
  assert.equal(patrolCount(mobs, c, 7), 2)
})

const sh = (o: Partial<ShooterView> & { name: string }): ShooterView => ({ id: Math.floor(Math.random() * 1e6), dist: 12, los: true, ...o })
const st = (o: Partial<RangedState>): RangedState => ({ health: 20, armor: 0, bow: false, shield: false, melee: true, shooters: [], patrol: 0, coverNear: true, ...o })

test('response: only shooters with a line to the bot (or that just hit it) count', () => {
  assert.equal(rangedResponse(st({ shooters: [sh({ name: 'skeleton', los: false })] })), null)
  assert.ok(rangedResponse(st({ shooters: [sh({ name: 'skeleton', los: false, hurtMe: true })] })))
  assert.deepEqual(activeShooters([sh({ name: 'skeleton', id: 1, dist: 30 }), sh({ name: 'skeleton', id: 2, dist: 10 })]).map(s => s.id), [2], 'beyond 24 blocks is ignored')
})

test('response: by health and gear', () => {
  const one = [sh({ name: 'skeleton', id: 9, dist: 12 })]
  assert.equal(rangedResponse(st({ shooters: one, bow: true }))!.act, 'shoot')
  assert.equal(rangedResponse(st({ shooters: one, bow: true }))!.target, 9)
  assert.equal(rangedResponse(st({ shooters: [sh({ name: 'skeleton', dist: 3 })], bow: true, shield: true }))!.act, 'shield_close', 'too close to draw a bow')
  assert.equal(rangedResponse(st({ shooters: one, shield: true }))!.act, 'shield_close')
  assert.equal(rangedResponse(st({ shooters: one }))!.act, 'charge', 'healthy with a sword against one skeleton')
  assert.equal(rangedResponse(st({ shooters: one, health: 12 }))!.act, 'cover', 'no shield and hurt: hide')
  assert.equal(rangedResponse(st({ shooters: one, health: 12, coverNear: false }))!.act, 'retreat')
  assert.equal(rangedResponse(st({ shooters: one, melee: false }))!.act, 'cover', 'bare hands')
  // low health hides whatever the gear
  assert.equal(rangedResponse(st({ shooters: one, health: 6, bow: true, shield: true, armor: 20 }))!.act, 'cover')
  assert.equal(rangedResponse(st({ shooters: one, useBow: false, bow: true, shield: true }))!.act, 'shield_close', 'combat.ranged off')
  assert.deepEqual(rangedResponse(st({ shooters: one, bow: true, hide: 'asked to take cover' }))!.why, 'asked to take cover')
})

test('response: a pillager patrol outnumbers a bot without good gear', () => {
  const patrol = [sh({ name: 'pillager', dist: 8 }), sh({ name: 'pillager', dist: 10 }), sh({ name: 'pillager', dist: 11 })]
  assert.equal(rangedResponse(st({ shooters: patrol, bow: true, shield: true }))!.act, 'cover')
  assert.equal(rangedResponse(st({ shooters: patrol, bow: true, shield: true, coverNear: false }))!.act, 'retreat')
  // one pillager in sight, but the patrol around is three strong
  assert.equal(rangedResponse(st({ shooters: [patrol[0]!], shield: true, patrol: 3 }))!.act, 'cover')
  // iron armour and a shield: fight
  assert.equal(rangedResponse(st({ shooters: patrol, bow: true, shield: true, armor: 15 }))!.act, 'shoot')
})

test('response: ghasts and blazes', () => {
  assert.equal(rangedResponse(st({ shooters: [sh({ name: 'ghast', dist: 20 })], shield: true }))!.act, 'cover', 'no bow: a ghast can not be reached')
  assert.equal(rangedResponse(st({ shooters: [sh({ name: 'ghast', dist: 20 })], bow: true }))!.act, 'shoot')
  assert.equal(rangedResponse(st({ shooters: [sh({ name: 'blaze', dist: 10 })] }))!.act, 'cover')
  assert.equal(rangedResponse(st({ shooters: [sh({ name: 'blaze', dist: 10 })], shield: true }))!.act, 'shield_close')
})

test('eating under fire: only out of sight and with nothing in flight', () => {
  const base = { health: 8, food: 14, hasFood: true, exposed: false, incoming: false }
  assert.ok(canEatUnderFire(base))
  assert.ok(!canEatUnderFire({ ...base, exposed: true }), 'not in the open')
  assert.ok(!canEatUnderFire({ ...base, incoming: true }))
  assert.ok(!canEatUnderFire({ ...base, hasFood: false }))
  assert.ok(!canEatUnderFire({ ...base, health: 20, food: 20 }), 'nothing to gain')
})

// a flat world at y 63 (ground) with a few extra blocks
function world (blocks: [number, number, number][]) {
  const set = new Set(blocks.map(b => b.join(',')))
  const solid = (x: number, y: number, z: number) => y <= 63 || set.has(`${x},${y},${z}`)
  const standable = (x: number, y: number, z: number) => solid(x, y - 1, z) && !solid(x, y, z) && !solid(x, y + 1, z)
  return { solid, standable }
}

test('cover: a line through a block is blocked, a clear one is not', () => {
  const { solid } = world([[5, 64, 0], [5, 65, 0]])
  assert.ok(lineBlocked({ x: 0.5, y: 65.6, z: 0.5 }, { x: 10.5, y: 65.6, z: 0.5 }, solid))
  assert.ok(!lineBlocked({ x: 0.5, y: 65.6, z: 3.5 }, { x: 10.5, y: 65.6, z: 3.5 }, solid))
  assert.ok(!lineBlocked({ x: 0.5, y: 65.6, z: 0.5 }, { x: 0.5, y: 65.6, z: 0.5 }, solid), 'zero length')
})

test('cover: the nearest spot behind a 2-high wall, on the far side from the shooter', () => {
  // wall at x = 3, z -2..2, two high; shooter 12 blocks east; bot in the open 2 blocks west of... the wall's east side
  const wall: [number, number, number][] = []
  for (let z = -2; z <= 2; z++) for (const y of [64, 65]) wall.push([3, y, z])
  const { solid, standable } = world(wall)
  const spot = findCover({ bot: { x: 5.5, y: 64, z: 0.5 }, shooters: [{ x: 16.5, y: 65.5, z: 0.5 }], solid, standable })
  assert.ok(spot, 'found cover')
  assert.ok(spot!.x < 3, `west of the wall, got ${spot!.x}`)
  assert.ok(Math.abs(spot!.z - 0.5) <= 2, 'behind the wall, not beside it')
  // open field: nothing
  const open = world([])
  assert.equal(findCover({ bot: { x: 0.5, y: 64, z: 0.5 }, shooters: [{ x: 12.5, y: 65.5, z: 0.5 }], solid: open.solid, standable: open.standable }), null)
})

test('cover: two shooters on opposite sides need a spot blocked from both', () => {
  // a 2x? pillar box: blocks at x=0 east and west walls; standing between two walls x=-1 and x=1 at z=0
  const blocks: [number, number, number][] = []
  for (const y of [64, 65]) { blocks.push([2, y, 0]); blocks.push([-2, y, 0]) }
  const { solid, standable } = world(blocks)
  const spot = findCover({ bot: { x: 0.5, y: 64, z: 3.5 }, shooters: [{ x: 12.5, y: 65.5, z: 0.5 }, { x: -11.5, y: 65.5, z: 0.5 }], solid, standable })
  assert.ok(spot)
  assert.equal(Math.floor(spot!.z), 0)
  assert.ok(Math.floor(spot!.x) > -2 && Math.floor(spot!.x) < 2, 'between the two walls')
})

test('retreat point: straight away from the shooters', () => {
  const p = retreatPoint({ x: 0, y: 64, z: 0 }, [{ x: 10, y: 64, z: 0 }, { x: 10, y: 64, z: 4 }], 20)
  assert.ok(p.x < -18)
  assert.ok(Math.abs(p.z) < 5)
})

test('stay_safe ranged danger: hurt, outnumbered, escorting', () => {
  const base = { active: 1, patrol: 0, health: 20, armor: 0, shield: true, escorting: false }
  assert.ok(!rangedDanger(base), 'one skeleton at full health: the reflex handles it')
  assert.ok(rangedDanger({ ...base, health: 12 }))
  assert.ok(rangedDanger({ ...base, patrol: 3 }), 'a patrol without armour')
  assert.ok(!rangedDanger({ ...base, patrol: 3, armor: 15 }), 'iron and a shield')
  assert.ok(!rangedDanger({ ...base, active: 0, health: 4 }), 'nobody with a shot')
  assert.ok(!rangedDanger({ ...base, health: 12, escorting: true }), 'a bodyguard stays with its player')
  assert.ok(rangedDanger({ ...base, health: 8, escorting: true }))
})

test('creeper: back off a lit fuse, shoot from range, else hit and step back', () => {
  assert.equal(creeperMove({ dist: 2.5, fuseLit: true, bow: true }), 'back_off')
  assert.equal(creeperMove({ dist: 4.5, fuseLit: true, bow: false }), 'back_off')
  assert.equal(creeperMove({ dist: 8, fuseLit: false, bow: true }), 'shoot')
  assert.equal(creeperMove({ dist: 8, fuseLit: false, bow: true, holdFire: true }), 'melee', 'player in the line')
  assert.equal(creeperMove({ dist: 3, fuseLit: false, bow: true }), 'melee')
  assert.equal(creeperMove({ dist: 8, fuseLit: false, bow: false }), 'melee')
})

const gm = (o: Partial<GuardThreat> & { name: string }): GuardThreat => ({ id: Math.floor(Math.random() * 1e6), distPlayer: 10, distBot: 10, losPlayer: true, hostile: true, ...o })

test('intercept: a mob walking at the player 6-12 blocks out', () => {
  assert.equal(threatReason(gm({ name: 'zombie', distPlayer: 10, approaching: true }), 16), 'intercept')
  assert.equal(threatReason(gm({ name: 'zombie', distPlayer: 14, approaching: true }), 16), 'coming for the player')
  assert.equal(threatReason(gm({ name: 'zombie', distPlayer: 10, facing: true }), 16), 'coming for the player', 'only looking: not yet')
  assert.equal(threatReason(gm({ name: 'skeleton', distPlayer: 10, approaching: true, losPlayer: true }), 16), 'has a shot at the player')
  // of two zombies the same distance out, the faster one goes first
  const r = rankGuardThreats([gm({ name: 'zombie', id: 1, distPlayer: 9, approaching: true, eta: 4 }), gm({ name: 'zombie', id: 2, distPlayer: 9, approaching: true, eta: 1.5 })], 16)
  assert.equal(r[0]!.id, 2)
})

test('intercept: eta and the meeting point', () => {
  assert.equal(etaToPlayer({ dist: 10, y: 0, flat: 10, at: 0 }, { dist: 9, y: 0, flat: 9, at: 1000 }), 7, '1 block/s, 7 blocks to go')
  assert.equal(etaToPlayer({ dist: 10, y: 0, flat: 10, at: 0 }, { dist: 10, y: 0, flat: 10, at: 1000 }), undefined)
  const player = { x: 0, y: 64, z: 0 }
  // zombie 10 east walking west at 2 b/s, bot next to the player: meet it part way
  const at = interceptPoint(player, { x: 10, y: 64, z: 0 }, { x: -2, z: 0 }, { x: 1, y: 64, z: 0 })
  assert.ok(at.x > 3 && at.x < 10, `between, got ${at.x}`)
  assert.deepEqual(interceptPoint(player, { x: 10, y: 64, z: 0 }, null, { x: 1, y: 64, z: 0 }), { x: 10, y: 64, z: 0 })
})

test('pull aggro: two mobs on the player, hit the untagged one, then step off the player', () => {
  const player = { x: 0, y: 64, z: 0 }
  const bot = { x: 3, y: 64, z: 0 }
  const mobs = [
    { id: 1, name: 'zombie', pos: { x: -1, y: 64, z: 1 }, distPlayer: 1.4, hurtPlayer: true },
    { id: 2, name: 'zombie', pos: { x: -2, y: 64, z: -1 }, distPlayer: 2.2, hurtPlayer: true },
    { id: 3, name: 'skeleton', pos: { x: -3, y: 64, z: 0 }, distPlayer: 3, hurtPlayer: true }
  ]
  const p = pullPlan(mobs, player, bot, new Set())
  assert.equal(p!.id, 1)
  assert.ok(p!.spot.x > 5, 'on the bot\'s side, 6 out')
  assert.equal(pullPlan(mobs, player, bot, new Set([1]))!.id, 2)
  assert.equal(pullPlan(mobs, player, bot, new Set([1, 2])), null, 'all tagged')
  assert.equal(pullPlan(mobs.slice(0, 1), player, bot, new Set()), null, 'one mob: just fight it')
})

// ---- follow-ups: graded gear, build cover, hide time, retreat cap ----

test('gear score: armour, shield, weapon, bow and arrows, health', () => {
  const g = { armor: 0, shield: false, weaponDamage: 1, bow: false, arrows: 0, health: 20 }
  assert.equal(gearScore(g), 16.9, 'bare hands at full health')
  const iron = { ...g, armor: 15, shield: true, weaponDamage: 6 }
  assert.equal(gearScore(iron), 72.5, 'iron armour, shield, iron sword')
  assert.equal(gearScore({ ...iron, bow: true, arrows: 32 }), 87.5, 'and a bow')
  assert.equal(gearScore({ ...iron, bow: true, arrows: 0 }), 72.5, 'a bow without arrows is worth nothing')
  assert.equal(gearScore({ ...iron, bow: true, arrows: 8 }), 80, 'half the arrows, half the points')
  assert.ok(gearScore({ ...iron, health: 10 }) < gearScore(iron), 'hurt scores lower')
  assert.equal(gearScore({ armor: 20, shield: true, weaponDamage: 8, bow: true, arrows: 64, health: 20 }), 100)
  assert.equal(gearNeeded(2), 0, 'one or two shooters: no gear check')
  assert.equal(gearNeeded(3), 65)
  assert.equal(gearNeeded(5), 75)
})

test('response: graded gear decides how many shooters it takes on', () => {
  const n = (k: number) => Array.from({ length: k }, (_, i) => sh({ name: 'pillager', id: i + 1, dist: 8 + i }))
  const iron = { armor: 15, shield: true, melee: true, weaponDamage: 6 }
  assert.equal(rangedResponse(st({ ...iron, shooters: n(4) }))!.act, 'shield_close', 'iron, shield and a sword take on 4')
  assert.equal(rangedResponse(st({ ...iron, shooters: n(5) }))!.act, 'cover', '5 is too many without a bow')
  assert.equal(rangedResponse(st({ ...iron, bow: true, arrows: 32, shooters: n(5) }))!.act, 'shoot', 'with a bow, 5 is fine')
  assert.equal(rangedResponse(st({ ...iron, health: 14, shooters: n(4) }))!.act, 'cover', 'hurt, the same gear only takes 3')
  assert.equal(rangedResponse(st({ ...iron, health: 14, shooters: n(3) }))!.act, 'shield_close')
  assert.match(rangedResponse(st({ shooters: n(3), shield: true }))!.why, /gear \d+ of 65/)
  assert.equal(rangedResponse(st({ ...iron, bow: true, arrows: 0, shooters: n(5) }))!.act, 'cover', 'no arrows')
})

test('response: no cover nearby, build some, else back off; at the cap stand with the shield', () => {
  const three = [sh({ name: 'skeleton', dist: 10 }), sh({ name: 'skeleton', dist: 12 }), sh({ name: 'pillager', dist: 9 })]
  assert.equal(rangedResponse(st({ shooters: three, coverNear: false, canBuild: true }))!.act, 'build')
  assert.equal(rangedResponse(st({ shooters: three, coverNear: true, canBuild: true }))!.act, 'cover', 'walking to cover beats building')
  assert.equal(rangedResponse(st({ shooters: three, coverNear: false }))!.act, 'retreat')
  const capped = rangedResponse(st({ shooters: three, coverNear: false, canRetreat: false, shield: true }))!
  assert.equal(capped.act, 'shield_close')
  assert.match(capped.why, /nowhere left to back off/)
  assert.equal(rangedResponse(st({ shooters: three, coverNear: false, canRetreat: false, melee: false }))!.act, 'retreat', 'nothing to fight with')
  assert.equal(rangedResponse(st({ shooters: three, coverNear: false, canRetreat: false, shield: true, health: 6 }))!.act, 'retreat', 'about to die: keep running')
})

test('hide time: short when healthy, long when hurt, over early when out of sight', () => {
  assert.equal(hideMs(20), 3000)
  assert.equal(hideMs(12), 6000)
  assert.equal(hideMs(10), 10_000)
  assert.equal(hideMs(6), 15_000)
  assert.ok(stillHiding({ until: 10_000, now: 1000, health: 10, seen: false }))
  assert.ok(!stillHiding({ until: 10_000, now: 1000, health: 18, seen: false }), 'healthy and nobody sees it: over')
  assert.ok(stillHiding({ until: 10_000, now: 1000, health: 18, seen: true }))
  assert.ok(!stillHiding({ until: 10_000, now: 10_000, health: 4, seen: true }))
  const base = { health: 10, heldMs: 1000, seen: false, shooters: 2, underFire: true }
  assert.ok(!leaveCover(base))
  assert.ok(!leaveCover({ ...base, seen: true, heldMs: 60_000 }), 'seen: look for other cover, not leave')
  assert.ok(leaveCover({ ...base, shooters: 0 }), 'the shooters are gone')
  assert.ok(leaveCover({ ...base, health: 18, underFire: false }), 'healthy and out of sight')
  assert.ok(!leaveCover({ ...base, health: 18 }), 'healthy but still under fire')
  assert.ok(leaveCover({ ...base, health: 18, heldMs: coverHoldMs(18) }), '4 s at most when healthy')
  assert.ok(!leaveCover({ ...base, heldMs: 10_000 }))
  assert.ok(leaveCover({ ...base, heldMs: 15_000 }), '15 s at most when hurt')
})

test('retreat cap: at most 24 blocks from where the shooting started', () => {
  const origin = { x: 0, y: 64, z: 0 }
  const p = cappedRetreat(origin, origin, [{ x: 10, y: 64, z: 0 }], 20)!
  assert.ok(p.x < -18, 'a first retreat goes the full way')
  const far = cappedRetreat(origin, { x: -15, y: 64, z: 0 }, [{ x: 0, y: 64, z: 0 }], 20)!
  assert.ok(Math.hypot(far.x, far.z) <= 24.01, `capped, got ${far.x}`)
  assert.equal(cappedRetreat(origin, { x: -23.5, y: 64, z: 0 }, [{ x: -5, y: 64, z: 0 }], 20), null, 'at the cap: nowhere to go')
  assert.ok(cappedRetreat(origin, { x: -23.5, y: 64, z: 0 }, [{ x: -5, y: 64, z: 0 }], 20, 40), 'a bigger cap lets it go on')
})

test('build cover: a 1x2 wall towards one shooter covers head and chest', () => {
  const { solid } = world([])
  const placeable = (x: number, y: number, z: number) => !solid(x, y, z)
  const bot = { x: 0.5, y: 64, z: 0.5 }
  const shooter = { x: 12.5, y: 65.5, z: 0.5 }
  const plan = planWall({ bot, shooters: [shooter], solid, placeable })!
  assert.ok(plan)
  assert.equal(plan.pillar, 0)
  assert.equal(plan.blocks.length, 2)
  assert.deepEqual(plan.blocks, [{ x: 1, y: 64, z: 0 }, { x: 1, y: 65, z: 0 }], 'the lower block first, east of the bot')
  const after = world(plan.blocks.map(b => [b.x, b.y, b.z] as [number, number, number]))
  for (const dy of [1.0, 1.62]) assert.ok(lineBlocked({ x: 0.5, y: 64 + dy, z: 0.5 }, shooter, after.solid))
})

test('build cover: shooters on both sides, never in the cells its body overlaps, protected cells skipped', () => {
  const { solid } = world([])
  const free = (x: number, y: number, z: number) => !solid(x, y, z)
  const shooters = [{ x: 12.5, y: 65.5, z: 0.5 }, { x: -11.5, y: 65.5, z: 2.5 }]
  const two = planWall({ bot: { x: 0.5, y: 64, z: 0.5 }, shooters, solid, placeable: free })!
  assert.equal(two.blocks.length, 4)
  const after = world(two.blocks.map(b => [b.x, b.y, b.z] as [number, number, number]))
  for (const s of shooters) for (const dy of [1.0, 1.62]) assert.ok(lineBlocked({ x: 0.5, y: 64 + dy, z: 0.5 }, s, after.solid))
  // standing at the east edge of its cell: the body pokes into x = 1, so the wall goes one further out
  const edge = planWall({ bot: { x: 0.85, y: 64, z: 0.5 }, shooters: [{ x: 12.5, y: 65.5, z: 0.5 }], solid, placeable: free })!
  assert.ok(edge.blocks.every(b => b.x !== 1 || b.z !== 0), 'not in the cell the body overlaps')
  // x = 1 and 2 protected: no wall to the east (a pillar can't help: the shooter still sees over the wall cells it may use)
  const prot = (x: number, y: number, z: number) => free(x, y, z) && x < 1
  const p = planWall({ bot: { x: 0.5, y: 64, z: 0.5 }, shooters: [{ x: 12.5, y: 65.5, z: 0.5 }], solid, placeable: prot })
  assert.ok(!p || p.blocks.every(b => b.x < 1), 'never a protected cell')
  assert.equal(planWall({ bot: { x: 0.5, y: 64, z: 0.5 }, shooters: [{ x: 12.5, y: 65.5, z: 0.5 }], solid, placeable: () => false }), null, 'nowhere to place')
  assert.equal(planWall({ bot: { x: 0.5, y: 64, z: 0.5 }, shooters: [{ x: 12.5, y: 65.5, z: 0.5 }], solid, placeable: free, maxBlocks: 1 }), null, 'one block is not enough')
})

test('build cover: pillar up when the ground around will not take blocks', () => {
  // the bot stands on a 1x1 column over a drop: nothing to place against at its feet level except its own column
  const solid = (x: number, y: number, z: number) => (x === 0 && z === 0 && y <= 63) || (y <= 50)
  const placeable = (x: number, y: number, z: number) => !solid(x, y, z) && (y >= 64)
  const plan = planWall({ bot: { x: 0.5, y: 64, z: 0.5 }, shooters: [{ x: 12.5, y: 65.5, z: 0.5 }], solid, placeable })
  assert.ok(plan, 'found a plan')
  assert.ok(plan!.pillar >= 1, `pillared ${plan!.pillar}`)
  assert.deepEqual(plan!.blocks[0], { x: 0, y: 64, z: 0 }, 'the pillar goes first')
  const set = new Set(plan!.blocks.map(b => `${b.x},${b.y},${b.z}`))
  const after = (x: number, y: number, z: number) => solid(x, y, z) || set.has(`${x},${y},${z}`)
  for (const dy of [1.0, 1.62]) assert.ok(lineBlocked({ x: 0.5, y: plan!.stand.y + dy, z: 0.5 }, { x: 12.5, y: 65.5, z: 0.5 }, after))
})

test('stay_safe ranged danger: graded by gear and health', () => {
  const base = { active: 3, patrol: 0, health: 20, armor: 15, shield: true, escorting: false }
  assert.ok(!rangedDanger(base), 'iron, shield and a sword against 3')
  assert.ok(rangedDanger({ ...base, active: 5 }), 'but not 5')
  assert.ok(!rangedDanger({ ...base, active: 5, bow: true, arrows: 32 }), 'unless it has a bow')
  assert.ok(rangedDanger({ ...base, weaponDamage: 1 }), 'no weapon')
})

// Pax, 23 Nov 2026: food 12, stone sword, no armour or shield, 3 skeletons at 665 61 -91. It walked to
// cover 8+ blocks off, held it while being hit, and died in 12 s.
const paxGear = { armor: 0, shield: false, melee: true, weaponDamage: 5 }
const three = () => [sh({ name: 'skeleton', id: 1, dist: 10 }), sh({ name: 'skeleton', id: 2, dist: 12 }), sh({ name: 'skeleton', id: 3, dist: 14 })]

test('heavy fire: outnumbered with poor gear, or low health', () => {
  assert.ok(heavyFire(st({ ...paxGear, shooters: three() })), 'stone sword against 3')
  assert.ok(!heavyFire(st({ ...paxGear, shooters: three().slice(0, 2) })), 'two shooters is not heavy at full health')
  assert.ok(heavyFire(st({ ...paxGear, health: 8, shooters: three().slice(0, 1) })), 'low health')
  assert.ok(!heavyFire(st({ armor: 15, shield: true, melee: true, weaponDamage: 6, shooters: three() })), 'iron, shield and sword take on 3')
})

test('heavy fire: exposure from the time in the open', () => {
  assert.equal(exposureHits(2, 3), 2 * 3 * 0.3)
  assert.equal(exposureHits(-1, 3), 0)
  assert.ok(quickCover(4, 3), '4 blocks with 3 shooting: under a second')
  assert.ok(!quickCover(8, 3), '8 blocks with 3 shooting: too long in the open')
  assert.ok(quickCover(8, 1), '8 blocks with 1 shooting is fine')
  assert.ok(quickWall(2, 0, 3), 'two blocks')
  assert.ok(!quickWall(5, 0, 3), 'five blocks against three')
  assert.ok(!quickWall(3, 2, 3), 'a pillar is slower')
  assert.ok(quickWall(5, 0, 1), 'five blocks against one shooter')
})

test('response under heavy fire: quick cover, else a quick wall, else get out of sight', () => {
  const s = (o: Partial<RangedState>) => rangedResponse(st({ ...paxGear, shooters: three(), ...o }))!
  assert.equal(s({ coverNear: true, coverDist: 3 }).act, 'cover', 'cover 3 blocks away')
  const far = s({ coverNear: true, coverDist: 9 })
  assert.equal(far.act, 'retreat', 'cover 9 blocks away is too slow with 3 shooting')
  assert.match(far.why, /heavy fire/)
  assert.match(far.why, /cover 9 blocks off is too slow/)
  assert.equal(s({ coverNear: false, canBuild: true, wallBlocks: 2 }).act, 'build', 'a 2-block wall is quick')
  assert.equal(s({ coverNear: false, canBuild: true, wallBlocks: 5 }).act, 'retreat', 'a 5-block wall in the open is not')
  assert.equal(s({ coverNear: true, coverDist: 9, canBuild: true, wallBlocks: 2 }).act, 'build', 'a quick wall beats a far spot')
  // nowhere to back off to: the slow cover or wall is still better than the open
  assert.equal(s({ coverNear: true, coverDist: 9, canRetreat: false }).act, 'cover')
  assert.equal(s({ coverNear: false, canBuild: true, wallBlocks: 5, canRetreat: false }).act, 'build')
  // not heavy (good gear): the old order, any cover first
  assert.equal(rangedResponse(st({ armor: 15, health: 12, shooters: three().slice(0, 1), coverNear: true, coverDist: 12 }))!.act, 'cover')
  // the low-health hide is heavy too
  assert.equal(rangedResponse(st({ health: 6, shooters: three(), coverNear: true, coverDist: 10 }))!.act, 'retreat')
})

test('flee point: towards home when it lies away from the shooters, else straight away', () => {
  const bot = { x: 0, y: 64, z: 0 }
  const shooters = [{ x: 10, y: 64, z: 0 }]
  const straight = fleePoint(bot, shooters, 20)
  assert.ok(straight.x < -19 && Math.abs(straight.z) < 0.01)
  const home = fleePoint(bot, shooters, 20, { x: -30, y: 70, z: 30 })
  assert.ok(home.x < 0 && home.z > 0, `towards home (north-west of away), got ${home.x} ${home.z}`)
  assert.ok(Math.abs(Math.hypot(home.x, home.z) - 20) < 0.01, 'still 20 blocks')
  const near = fleePoint(bot, shooters, 20, { x: -8, y: 66, z: 4 })
  assert.equal(near.x, -8); assert.equal(near.y, 66)
  assert.deepEqual(fleePoint(bot, shooters, 20, { x: 30, y: 64, z: 0 }), straight, 'home behind the shooters: not that way')
  assert.deepEqual(fleePoint(bot, shooters, 20, { x: 2, y: 64, z: 1 }), straight, 'home right here')
  // the heavy-fire cap lets it run further than the usual one
  const origin = { x: 0, y: 64, z: 0 }
  assert.equal(cappedRetreat(origin, { x: -24, y: 64, z: 0 }, [{ x: -5, y: 64, z: 0 }], 20), null)
  assert.ok(cappedRetreat(origin, { x: -24, y: 64, z: 0 }, [{ x: -5, y: 64, z: 0 }], 20, FLEE_CAP))
})

test('shield while getting away: an arrow on its way, hurt or few shooting, not too often', () => {
  const b = { shield: true, incoming: true, sinceBlockMs: 5000, health: 10, shooters: 3 }
  assert.ok(shieldWhileFleeing(b))
  assert.ok(!shieldWhileFleeing({ ...b, shield: false }))
  assert.ok(!shieldWhileFleeing({ ...b, incoming: false }))
  assert.ok(!shieldWhileFleeing({ ...b, sinceBlockMs: 800 }))
  assert.ok(!shieldWhileFleeing({ ...b, health: 18 }), 'healthy with 3 shooting: keep running')
  assert.ok(shieldWhileFleeing({ ...b, health: 18, shooters: 2 }))
})
