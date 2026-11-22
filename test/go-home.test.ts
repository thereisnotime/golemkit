// go_home / stay_safe loop: an at-home check that measures in 3D with some vertical slack,
// stay_safe's night hysteresis and go_home back-off, and the controller's flip back-off.
import { test } from 'node:test'
import { minecraftView } from './fake-attach.ts'
import assert from 'node:assert/strict'
import { flipCooldown, isFlip } from '../src/brains/npc/select.ts'
import { NpcController } from '../src/brains/npc/controller.ts'
import type { Behavior } from '../src/brains/npc/index.ts'
import { ok, createLogger, type ActionResult } from '../src/core/index.ts'
import { atHome, homeOffset, navigation } from '../src/skills/navigation.ts'
import {
  assessDanger, needsHome, homeBackoffMs, newHomeTrips, HOME_BACKOFF_MS, MAX_HOME_BACKOFF_MS, HOME_SETTLE_MS
} from '../src/adapters/minecraft-java/behaviors/safety.ts'

// Pax's home and spots from the log of the loop
const HOME = { x: 560, y: 68, z: -46 }

// ------------------------------------------------------------------ at home

test('homeOffset: horizontal to the middle of the home block, height only beyond 3 blocks', () => {
  assert.equal(homeOffset({ x: 560.5, y: 68, z: -45.5 }, HOME), 0)
  assert.equal(homeOffset({ x: 560.5, y: 71, z: -45.5 }, HOME), 0, 'a floor up still counts as on the spot')
  assert.equal(homeOffset({ x: 560.5, y: 63, z: -45.5 }, HOME), 2, '5 down: 2 beyond the slack')
  assert.ok(Math.abs(homeOffset({ x: 564, y: 68, z: -38 }, HOME) - Math.hypot(3.5, 7.5)) < 1e-9)
})

test('atHome: inside the walls or a few blocks up or down is home', () => {
  assert.ok(atHome({ x: 562.3, y: 68, z: -44.1 }, HOME, 4), 'two blocks off, same floor')
  assert.ok(atHome({ x: 561, y: 70, z: -45 }, HOME, 4), 'up the stairs')
  assert.ok(atHome({ x: 560.5, y: 65, z: -45.5 }, HOME, 4), 'in the cellar')
  assert.ok(!atHome({ x: 564, y: 68, z: -38 }, HOME, 4), '8 blocks south is not home')
  assert.ok(atHome({ x: 560.7, y: 68, z: -45.2 }, HOME, 0), 'range 0 still allows the home block itself')
})

function goHomeAction () {
  return (navigation().actions ?? []).find(a => a.name === 'go_home')!
}

function homeBot (pos: { x: number, y: number, z: number }, onGoto: () => Promise<void>) {
  const gotos: unknown[] = []
  const bot: any = {
    entity: { position: pos },
    game: { dimension: 'overworld' },
    pathfinder: {
      goto: (g: unknown) => { gotos.push(g); return onGoto() },
      stop () {},
      setGoal () {}
    }
  }
  const agent: any = { storage: { get: (k: string, d: unknown) => k === 'home' ? { ...HOME, dimension: 'overworld' } : d } }
  return { bot, agent, gotos }
}

test('go_home succeeds at once, without pathing, when already within range', async () => {
  const { bot, agent, gotos } = homeBot({ x: 561, y: 70, z: -43 }, () => Promise.reject(new Error('should not path')))
  const r = await goHomeAction().run({ agent, bot, signal: new AbortController().signal } as any, { range: 4 }) as ActionResult
  assert.equal(r.ok, true)
  assert.match(r.message, /already home/)
  assert.equal(gotos.length, 0)
})

test('go_home retries a path stopped at the start, then reports the real reason', async () => {
  const stopped = () => Promise.reject(new Error('Path was stopped before it could be completed! Thus, the desired goal was not reached.'))
  // stopped once (the previous action's stop landing late), then the walk works
  let n = 0
  const a = homeBot({ x: 580, y: 68, z: -46 }, () => (n++ === 0 ? stopped() : Promise.resolve()))
  const r1 = await goHomeAction().run({ agent: a.agent, bot: a.bot, signal: new AbortController().signal } as any, { range: 4 }) as ActionResult
  assert.equal(r1.ok, true, r1.message)
  assert.equal(a.gotos.length, 2)
  // stopped every time: one retry only, and a message that says what happened
  const b = homeBot({ x: 580, y: 68, z: -46 }, stopped)
  const r2 = await goHomeAction().run({ agent: b.agent, bot: b.bot, signal: new AbortController().signal } as any, { range: 4 }) as ActionResult
  assert.equal(r2.ok, false)
  assert.equal(b.gotos.length, 2)
  assert.match(r2.message, /kept being stopped/)
})

// ------------------------------------------------------------------ stay_safe night hysteresis and back-off

test('needsHome: starts beyond homeRange, keeps going until arriveRange, more slack just after arriving', () => {
  const base = { homeRange: 8, arriveRange: 4, running: false, sinceArrivedMs: Infinity }
  assert.equal(needsHome(7.9, base), false)
  assert.equal(needsHome(8.5, base), true)
  assert.equal(needsHome(6, { ...base, running: true }), true, 'on the way: no stop at the edge of homeRange')
  assert.equal(needsHome(3.9, { ...base, running: true }), false)
  assert.equal(needsHome(10, { ...base, sinceArrivedMs: 1000 }), false, 'just got home: a chore 10 blocks out is fine')
  assert.equal(needsHome(12.5, { ...base, sinceArrivedMs: 1000 }), true)
  assert.equal(needsHome(10, { ...base, sinceArrivedMs: HOME_SETTLE_MS }), true)
})

test('go_home back-off: 60 s, doubling, capped', () => {
  assert.equal(homeBackoffMs(0), 0)
  assert.equal(homeBackoffMs(1), HOME_BACKOFF_MS)
  assert.equal(homeBackoffMs(2), 2 * HOME_BACKOFF_MS)
  assert.equal(homeBackoffMs(9), MAX_HOME_BACKOFF_MS)
})

function nightCtx (pos: { x: number, y: number, z: number }, current: string | null = null, now = 1_000_000) {
  const agent: any = { storage: { get: (k: string, d: unknown) => k === 'home' ? HOME : d }, protectedAreas: { isProtected: () => false }, getAction: () => null, canDig: false }
  const bot: any = { entity: { position: pos }, health: 20, entities: {}, inventory: { items: () => [] } }
  const bb: any = { facts: { isNight: true, sleeping: false, homeDistance: 9 } }
  return { agent, bot, bb, current, now }
}

const O = { retreatBelow: 10, mobRadius: 10, surroundedBy: 3, pillar: true, avoidWater: true, homeAtNight: true, homeRange: 8, shelterUnprepared: true, ranged: true }

test('stay_safe: no flapping at the edge of homeRange', () => {
  // from the log: 564 68 -38 is 8.3 out, 561 61 -39 only 7.7 once the height slack applies
  assert.equal(assessDanger(nightCtx({ x: 564, y: 68, z: -38 }), O), 'night')
  assert.equal(assessDanger(nightCtx({ x: 561, y: 61, z: -39 }), O), null)
  // walking back it doesn't drop out at 8 ("no longer applies"), only once within go_home's range
  assert.equal(assessDanger(nightCtx({ x: 563, y: 68, z: -40 }, 'stay_safe'), O), 'night')
  assert.equal(assessDanger(nightCtx({ x: 561, y: 68, z: -44 }, 'stay_safe'), O), null)
  // just got home: a chore at 8.3 blocks doesn't send it back
  const trips = { ...newHomeTrips(), arrivedAt: 1_000_000 - 30_000 }
  assert.equal(assessDanger(nightCtx({ x: 564, y: 68, z: -38 }), O, trips), null)
})

test('stay_safe: after a failed go_home it holds position until the back-off ends', () => {
  const trips = { ...newHomeTrips(), failures: 1, backoffUntil: 1_000_000 + 30_000 }
  assert.equal(assessDanger(nightCtx({ x: 570, y: 68, z: -30 }), O, trips), 'hold')
  assert.equal(assessDanger(nightCtx({ x: 570, y: 68, z: -30 }, null, 1_000_000 + 31_000), O, trips), 'night')
})

// ------------------------------------------------------------------ controller flip back-off

test('flipCooldown: the first flip is free, then 5 s doubling to a minute', () => {
  assert.equal(flipCooldown(0), 0)
  assert.equal(flipCooldown(1), 0)
  assert.equal(flipCooldown(2), 5000)
  assert.equal(flipCooldown(3), 10_000)
  assert.equal(flipCooldown(20), 60_000)
  assert.ok(isFlip(1760))
  assert.ok(!isFlip(15_000))
})

function fakeAgent () {
  return {
    log: createLogger('test'),
    storage: { get: (_k: string, fb?: unknown) => fb, set () {} },
    currentAction: null,
    getAction: (n: string) => ({ name: n }),
    act: () => Promise.resolve(ok('done'))
  }
}

function waiting (name: string, score: { v: number }): Behavior {
  return {
    name,
    score: () => score.v,
    async run (ctx) {
      await ctx.act('wander')
      await new Promise<void>(resolve => ctx.signal.addEventListener('abort', () => resolve(), { once: true }))
    }
  }
}

test('controller: a behaviour that keeps flipping on and off is held back unless urgent', async () => {
  const clock = { t: 100_000 }
  const bot: any = { entity: { position: { x: 0, y: 64, z: 0, distanceTo: () => 0 } }, food: 20, health: 20, time: { timeOfDay: 1000 }, entities: {}, players: {}, game: { dimension: 'overworld' }, inventory: { items: () => [] } }
  const safe = { v: 0 }
  const chore = { v: 28 }
  const c = new NpcController({ ...fakeAgent(), adapter: minecraftView(bot) } as any, bot, { behaviors: [waiting('stay_safe', safe), waiting('chore', chore)], now: () => clock.t, autoHome: false })
  const step = async (ms: number) => { clock.t += ms; await c.tick(); await new Promise(r => setImmediate(r)) }
  await step(0)
  assert.equal(c.current, 'chore')
  for (let i = 0; i < 2; i++) {
    safe.v = 70; await step(4000)
    assert.equal(c.current, 'stay_safe', `flip ${i + 1} starts`)
    safe.v = 0; await step(1000)
    assert.equal(c.current, 'chore')
  }
  safe.v = 70; await step(4000)
  assert.equal(c.current, 'chore', 'second quick drop-out: held back for 5 s')
  safe.v = 78; await step(1000)
  assert.equal(c.current, 'stay_safe', 'a real danger (water escape, 78) still gets through')
  safe.v = 70; await step(2000)
  assert.equal(c.current, 'stay_safe', 'the running one keeps its score')
  c.stop()
})
