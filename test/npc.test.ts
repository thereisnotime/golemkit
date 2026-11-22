import { test } from 'node:test'
import { minecraftView } from './fake-attach.ts'
import assert from 'node:assert/strict'
import { decide, best, failureCooldown } from '../src/brains/npc/select.ts'
import { NpcController } from '../src/brains/npc/controller.ts'
import { actionBehavior, type Behavior } from '../src/brains/npc/index.ts'
import { PRIORITY, ok, fail, type ActionInfo, type ActionResult, createLogger } from '../src/core/index.ts'

// ------------------------------------------------------------------ pure selection

test('best picks the highest positive score, first wins ties', () => {
  assert.equal(best([{ name: 'a', score: 0 }, { name: 'b', score: -3 }]), null)
  assert.equal(best([{ name: 'a', score: 5 }, { name: 'b', score: 9 }, { name: 'c', score: 9 }])?.name, 'b')
})

test('decide starts the best when idle', () => {
  assert.deepEqual(decide([{ name: 'a', score: 10 }, { name: 'b', score: 20 }], null, 0), { kind: 'start', name: 'b', score: 20 })
  assert.deepEqual(decide([{ name: 'a', score: 0 }], null, 0), { kind: 'idle' })
})

test('hysteresis: a challenger needs the margin', () => {
  const scores = [{ name: 'wander', score: 30 }, { name: 'social', score: 35 }]
  assert.equal(decide(scores, { name: 'wander', startedAt: 0 }, 10000).kind, 'keep')
  scores[1]!.score = 41
  assert.equal(decide(scores, { name: 'wander', startedAt: 0 }, 10000).kind, 'switch')
})

test('minRunMs protects a fresh behaviour unless the challenger is urgent', () => {
  const running = { name: 'wander', startedAt: 1000 }
  assert.equal(decide([{ name: 'wander', score: 10 }, { name: 'home', score: 50 }], running, 2000).kind, 'keep')
  assert.equal(decide([{ name: 'wander', score: 10 }, { name: 'danger', score: 90 }], running, 2000).kind, 'switch')
  assert.equal(decide([{ name: 'wander', score: 10 }, { name: 'home', score: 50 }], running, 5000).kind, 'switch')
})

test('a running behaviour that drops to 0 is replaced or stopped', () => {
  const running = { name: 'sleep', startedAt: 0 }
  assert.equal(decide([{ name: 'sleep', score: 0 }, { name: 'wander', score: 5 }], running, 100).kind, 'switch')
  assert.equal(decide([{ name: 'sleep', score: 0 }], running, 100).kind, 'stop')
})

test('failure cooldown doubles and caps', () => {
  assert.equal(failureCooldown(0, 1000, 8000), 0)
  assert.equal(failureCooldown(1, 1000, 8000), 1000)
  assert.equal(failureCooldown(3, 1000, 8000), 4000)
  assert.equal(failureCooldown(10, 1000, 8000), 8000)
})

// ------------------------------------------------------------------ controller with a fake agent

interface Fake {
  agent: any
  bot: any
  calls: { name: string, params: unknown, priority: number }[]
  clock: { t: number }
  /** Make act() hold the body until release() is called. */
  hold: boolean
  release (r?: ActionResult): void
  setForeign (info: ActionInfo | null): void
}

function fake (actions: string[] = ['wander', 'go_home', 'npc_interrupt']): Fake {
  const store = new Map<string, unknown>([['home', { x: 0, y: 64, z: 0 }]])
  let current: ActionInfo | null = null
  let pending: { resolve: (r: ActionResult) => void } | null = null
  const f: Fake = {
    calls: [],
    clock: { t: 100_000 },
    hold: false,
    release (r = ok('done')) { const p = pending; pending = null; current = null; p?.resolve(r) },
    setForeign (info) { current = info },
    bot: {
      entity: { position: { x: 0, y: 64, z: 0, distanceTo: () => 0 } },
      food: 20,
      health: 20,
      time: { timeOfDay: 1000 },
      entities: {},
      players: {},
      game: { dimension: 'overworld' },
      inventory: { items: () => [], inventoryStart: 9, inventoryEnd: 45 }
    },
    agent: {
      log: createLogger('test'),
      storage: { get: (k: string, fb?: unknown) => store.has(k) ? store.get(k) : fb, set: (k: string, v: unknown) => store.set(k, v) },
      get currentAction () { return current },
      getAction: (n: string) => actions.includes(n) ? { name: n } : undefined,
      act (name: string, params: unknown, opts: { caller: any, priority: number }): Promise<ActionResult> {
        f.calls.push({ name, params, priority: opts.priority })
        if (current && current.priority > opts.priority) {
          return Promise.resolve(fail(`busy: ${current.name} (${current.caller.kind} ${current.caller.name})`))
        }
        if (pending) f.release(fail('replaced'))
        if (name === 'npc_interrupt') return Promise.resolve(ok(''))
        current = { name, params, caller: opts.caller, priority: opts.priority }
        if (!f.hold) { current = null; return Promise.resolve(ok('done')) }
        return new Promise(resolve => { pending = { resolve } })
      }
    }
  }
  f.agent.adapter = minecraftView(f.bot)
  return f
}

function controller (f: Fake, behaviors: Behavior[], extra: Record<string, unknown> = {}) {
  return new NpcController(f.agent, f.bot, { behaviors, now: () => f.clock.t, autoHome: false, ...extra })
}

/** Behaviour with a settable score that runs one action and then waits until aborted. */
function manual (name: string, score: { v: number }, action = 'wander'): Behavior {
  return {
    name,
    score: () => score.v,
    async run (ctx) {
      await ctx.act(action)
      await new Promise<void>(resolve => ctx.signal.addEventListener('abort', () => resolve(), { once: true }))
    }
  }
}

const flush = () => new Promise(r => setImmediate(r))

test('controller runs the top behaviour through agent.act at npc priority', async () => {
  const f = fake()
  const c = controller(f, [manual('low', { v: 5 }), manual('high', { v: 20 })])
  await c.tick()
  await flush()
  assert.equal(c.current, 'high')
  assert.equal(f.calls[0]?.name, 'wander')
  assert.equal(f.calls[0]?.priority, PRIORITY.npc)
  c.stop()
})

test('hysteresis in the controller', async () => {
  const f = fake()
  const a = { v: 30 }
  const b = { v: 10 }
  const c = controller(f, [manual('a', a), manual('b', b)], { minRunMs: 0 })
  await c.tick(); await flush()
  assert.equal(c.current, 'a')
  b.v = 35
  f.clock.t += 5000
  await c.tick(); await flush()
  assert.equal(c.current, 'a', 'within margin: keep')
  b.v = 45
  f.clock.t += 5000
  await c.tick(); await flush()
  assert.equal(c.current, 'b', 'beyond margin: switch')
  c.stop()
})

test('backs off while a player holds the body and resumes after the back-off', async () => {
  const f = fake()
  const c = controller(f, [manual('wander', { v: 10 })], { backoffMs: { player: 20000 } })
  f.setForeign({ name: 'follow', params: {}, caller: { kind: 'player', name: 'Steve' }, priority: PRIORITY.player })
  await c.tick(); await flush()
  assert.equal(c.current, null)
  assert.equal(f.calls.length, 0, 'never even tried to act')
  assert.deepEqual((c.status().paused as any).by, 'player:Steve')

  f.setForeign(null) // player done
  f.clock.t += 5000
  await c.tick(); await flush()
  assert.equal(c.current, null, 'still inside the back-off window')
  f.clock.t += 20000
  await c.tick(); await flush()
  assert.equal(c.current, 'wander')
  c.stop()
})

test('a running behaviour yields when a player takes over mid-action', async () => {
  const f = fake()
  f.hold = true
  const c = controller(f, [manual('wander', { v: 10 })])
  await c.tick(); await flush()
  assert.equal(c.current, 'wander')
  // The player preempts: our act() resolves "preempted" and the body is theirs.
  f.release(fail('preempted'))
  f.setForeign({ name: 'come', params: {}, caller: { kind: 'player', name: 'Alex' }, priority: PRIORITY.player })
  await c.settled()
  assert.equal(c.current, null)
  assert.ok(c.status().paused, 'paused after yielding')
  c.stop()
})

test('busy result makes the brain back off', async () => {
  const f = fake()
  const c = controller(f, [manual('wander', { v: 10 })])
  // A reflex holds the body but it only shows up in the act() result (race with the tick).
  const realAct = f.agent.act
  f.agent.act = (...args: any[]) => { f.agent.act = realAct; f.calls.push({ name: args[0], params: args[1], priority: args[2].priority }); return Promise.resolve(fail('busy: defend (reflex reflexes)')) }
  await c.tick()
  await c.settled()
  const paused = c.status().paused as any
  assert.equal(paused.by, 'reflex:reflexes')
  assert.ok(paused.seconds <= 3, 'short reflex back-off')
  c.stop()
})

test('a lower-priority holder does not make the brain back off', async () => {
  const f = fake()
  const c = controller(f, [manual('wander', { v: 10 })])
  f.setForeign({ name: 'look', params: {}, caller: { kind: 'brain', name: 'idle' }, priority: PRIORITY.idle })
  await c.tick(); await flush()
  assert.equal(c.current, 'wander')
  c.stop()
})

test('switching interrupts our own in-flight action', async () => {
  const f = fake()
  f.hold = true
  const a = { v: 20 }
  const b = { v: 0 }
  const c = controller(f, [manual('a', a), manual('b', b, 'go_home')], { minRunMs: 0 })
  await c.tick(); await flush()
  assert.equal(c.current, 'a')
  b.v = 60
  await c.tick(); await flush()
  assert.equal(c.current, 'b')
  assert.ok(f.calls.some(x => x.name === 'npc_interrupt'))
  assert.equal(f.calls.at(-1)?.name, 'go_home')
  c.stop()
})

test('failed behaviours cool down with back-off', async () => {
  const f = fake()
  let runs = 0
  const flaky: Behavior = { name: 'flaky', failureCooldownMs: 1000, score: () => 50, run: async () => { runs++; return fail('nope') } }
  const c = controller(f, [flaky])
  await c.tick(); await c.settled()
  assert.equal(runs, 1)
  f.clock.t += 500
  await c.tick(); await c.settled()
  assert.equal(runs, 1, 'cooling down')
  f.clock.t += 600
  await c.tick(); await c.settled()
  assert.equal(runs, 2)
  f.clock.t += 1100 // second failure doubles the cooldown to 2s
  await c.tick(); await c.settled()
  assert.equal(runs, 2)
  f.clock.t += 1000
  await c.tick(); await c.settled()
  assert.equal(runs, 3)
  c.stop()
})

test('actionBehavior scores 0 when the action is missing', async () => {
  const f = fake(['wander'])
  const chop = actionBehavior('chop_tree', {}, 40)
  const c = controller(f, [chop, manual('wander', { v: 10 })])
  const scores = c.scoreAll({ agent: f.agent, bot: f.bot, bb: c.bb, log: f.agent.log, now: f.clock.t, current: null })
  assert.deepEqual(scores.map(s => s.score), [0, 10])

  const f2 = fake(['chop_tree'])
  const c2 = controller(f2, [actionBehavior('chop_tree', ({ now }) => ({ at: now }), 40)])
  await c2.tick(); await c2.settled()
  assert.equal(f2.calls[0]?.name, 'chop_tree')
  assert.deepEqual(f2.calls[0]?.params, { at: f2.clock.t })
})

test('duplicate behaviour names are rejected', () => {
  const f = fake()
  assert.throws(() => controller(f, [manual('x', { v: 1 }), manual('x', { v: 2 })]), /duplicate/)
})
