import { test } from 'node:test'
import { minecraftView } from './fake-attach.ts'
import assert from 'node:assert/strict'
import { PRIORITY, ok, fail, createLogger, type ActionInfo, type ActionResult } from '../src/core/index.ts'
import { NpcController } from '../src/brains/npc/controller.ts'
import { mustParse, type Program, type Step } from '../src/brains/self/format.ts'
import { runRoutine, evalCond, inWindow, ProgramMemory, ChatLimiter, CapExceeded, RoutineFailed, type Host, type RunEnv } from '../src/brains/self/interpreter.ts'
import { compile, TriggerQueue, TRIGGER_BEHAVIOR } from '../src/brains/self/compile.ts'
import { SimWorld, DEFAULT_SCENARIOS } from '../src/brains/self/gate.ts'
import { catalog } from './self-helpers.ts'

function env (steps: Record<string, Step[]> = {}, facts: Record<string, any> = {}, opts: { act?: (n: string, p: any) => ActionResult } = {}) {
  let clock = 0
  const calls: { name: string, params: any }[] = []
  const said: string[] = []
  const host: Host = {
    act: async (name, params) => { calls.push({ name, params }); clock += 100; return opts.act?.(name, params) ?? ok('ok') },
    say: (t) => said.push(t),
    whisper: (to, t) => said.push(`@${to} ${t}`),
    wait: async (ms) => { clock += ms },
    now: () => clock,
    random: () => 0.5
  }
  const program = { version: 1, name: 't', vars: { n: 0 }, rules: [], triggers: [], routines: steps } as Program
  const e: RunEnv = {
    program,
    world: new SimWorld({ ...DEFAULT_SCENARIOS[0]!.facts, ...facts }),
    memory: new ProgramMemory(program.vars),
    host,
    chat: new ChatLimiter({ gapMs: 0, perMinute: 100 }),
    player: 'Steve',
    bot: 'Apprentice'
  }
  return { e, calls, said, clock: () => clock }
}

test('conditions: facts, windows, combinators, vars, timers', () => {
  const { e } = env({}, { health: 8, timeOfDay: 23800, 'nearestPlayer.distance': 5 })
  assert.equal(evalCond({ fact: 'health', lt: 10 }, e), true)
  assert.equal(evalCond({ fact: 'health', gte: 10 }, e), false)
  assert.equal(evalCond({ time: 'day' }, e), true, 'day wraps past midnight')
  assert.equal(evalCond({ time: 'night' }, e), false)
  assert.equal(evalCond({ all: [{ playerNear: 6 }, { not: { playerNear: 4 } }] }, e), true)
  assert.equal(evalCond({ any: [{ fact: 'isNight', eq: true }, { has: { item: 'bread' } }] }, e), false)
  assert.equal(evalCond({ fact: 'var.n', eq: 0 }, e), true)
  assert.equal(evalCond({ elapsed: { timer: 't', ms: 1000 } }, e), true, 'a timer never set counts as elapsed')
  e.memory.timers.set('t', 0)
  assert.equal(evalCond({ elapsed: { timer: 't', ms: 1000 } }, e), false)
  assert.equal(inWindow(100, [23000, 500]), true)
  assert.equal(inWindow(1000, [23000, 500]), false)
})

test('routines: act, if/else, repeat, while with max, set, templates, run', async () => {
  const { e, calls, said } = env({
    helper: [{ act: 'jump' }],
    main: [
      { if: { fact: 'health', lt: 5 }, then: [{ say: 'ouch' }], else: [{ say: 'fine, {player}' }] },
      { repeat: { times: 3, steps: [{ set: 'n', add: 1 }] } },
      { while: { cond: { fact: 'var.n', lt: 100 }, max: 4, steps: [{ set: 'n', add: 1 }] } },
      { act: 'look_at', params: { player: '{player}' } },
      { run: 'helper' },
      { say: 'n is {var.n}' }
    ]
  })
  await runRoutine(e.program.routines.main!, e)
  assert.deepEqual(said, ['fine, Steve', 'n is 7'])
  assert.deepEqual(calls.map(c => c.name), ['look_at', 'jump'])
  assert.deepEqual(calls[0]!.params, { player: 'Steve' })
})

test('step cap: a program that runs too many steps is cut off', async () => {
  const { e } = env()
  const deep: Step[] = [{ repeat: { times: 20, steps: [{ repeat: { times: 20, steps: [{ repeat: { times: 20, steps: [{ set: 'n', add: 1 }] } }] } }] } }]
  await assert.rejects(runRoutine(deep, e), CapExceeded)
})

test('time cap: a routine that would run for hours is cut off', async () => {
  const { e } = env()
  await assert.rejects(runRoutine([{ while: { cond: { chance: 1 }, max: 100, steps: [{ wait: 60_000 }] } }], e), /longer than/)
})

test('a failed action or a fail step ends the routine', async () => {
  const { e, calls } = env({}, {}, { act: (n) => n === 'goto_place' ? fail('don\'t know a') : ok('') })
  await assert.rejects(runRoutine([{ goto_place: 'a' }, { act: 'jump' }], e), RoutineFailed)
  assert.deepEqual(calls.map(c => c.name), ['goto_place'])
  await assert.rejects(runRoutine([{ fail: 'nope' }], e), /nope/)
})

test('chat limiter drops lines beyond the rate', () => {
  const l = new ChatLimiter({ gapMs: 1000, perMinute: 2 })
  assert.equal(l.allow(0), true)
  assert.equal(l.allow(500), false)
  assert.equal(l.allow(1500), true)
  assert.equal(l.allow(3000), false, 'per-minute cap')
  assert.equal(l.allow(61_000), true)
  assert.equal(l.dropped, 2)
})

// ------------------------------------------------------------------ inside the NPC controller

function fakeBody () {
  let current: ActionInfo | null = null
  const calls: { name: string, priority: number }[] = []
  const said: string[] = []
  const clock = { t: 100_000 }
  const agent: any = {
    username: 'Apprentice',
    log: createLogger('test'),
    storage: { get: (_k: string, fb?: unknown) => fb, set: () => {} },
    get currentAction () { return current },
    getAction: (n: string) => ({ name: n }),
    say: (t: string) => said.push(t),
    whisper: (to: string, t: string) => said.push(`@${to} ${t}`),
    async act (name: string, _p: unknown, opts: { caller: any, priority: number }): Promise<ActionResult> {
      calls.push({ name, priority: opts.priority })
      if (current && current.priority > opts.priority) return fail(`busy: ${current.name} (${current.caller.kind} ${current.caller.name})`)
      return ok('done')
    }
  }
  const bot: any = {
    entity: { position: { x: 0, y: 64, z: 0, distanceTo: () => 0 } },
    food: 20, health: 20, time: { timeOfDay: 1000 }, entities: {}, players: {}, game: { dimension: 'overworld' },
    inventory: { items: () => [], inventoryStart: 9, inventoryEnd: 45 }
  }
  agent.adapter = minecraftView(bot)
  return { agent, bot, calls, said, clock, hold (info: ActionInfo | null) { current = info } }
}

const flush = () => new Promise(r => setImmediate(r))

function setup (raw: any) {
  const b = fakeBody()
  const program = mustParse(raw, catalog())
  const memory = new ProgramMemory(program.vars)
  const queue = new TriggerQueue()
  const outcomes: string[] = []
  const behaviors = compile({
    program, memory, queue, chat: new ChatLimiter({ gapMs: 0 }),
    world: (ctx) => new SimWorld({ ...DEFAULT_SCENARIOS[0]!.facts, isNight: ctx.bb.facts.isNight }),
    onOutcome: (k, n, o) => outcomes.push(`${k} ${n} ${o}`),
    random: () => 0.5
  })
  const c = new NpcController(b.agent, b.bot, { name: 'self', behaviors, now: () => b.clock.t, autoHome: false })
  return { ...b, c, queue, outcomes, program }
}

test('rules compile to behaviours that act at npc priority', async () => {
  const s = setup({ version: 1, name: 't', rules: [{ name: 'stroll', score: 10, do: [{ act: 'wander', params: { radius: 5 } }] }, { name: 'nap', score: 70, when: { fact: 'isNight', eq: true }, do: [{ act: 'sleep' }] }] })
  await s.c.tick()
  await s.c.settled()
  assert.deepEqual(s.calls.map(c => c.name), ['wander'])
  assert.equal(s.calls[0]!.priority, PRIORITY.npc)
  assert.deepEqual(s.outcomes, ['rule stroll ok'])
  s.c.stop()
})

test('back-off: when a player holds the body the program does not act, and a busy result yields', async () => {
  const s = setup({ version: 1, name: 't', rules: [{ name: 'stroll', score: 10, do: [{ act: 'wander' }] }] })
  s.hold({ name: 'come', params: {}, caller: { kind: 'player', name: 'Steve' }, priority: PRIORITY.player })
  await s.c.tick(); await flush()
  assert.equal(s.calls.length, 0)
  assert.ok(s.c.status().paused)
  // Race: the holder appears only in the act() result.
  const t = setup({ version: 1, name: 't', rules: [{ name: 'stroll', score: 10, do: [{ act: 'wander' }] }] })
  const real = t.agent.act
  t.agent.act = async (...a: any[]) => { t.agent.act = real; return fail('busy: defend (reflex reflexes)') }
  await t.c.tick(); await t.c.settled()
  assert.deepEqual(t.outcomes, ['rule stroll yield'])
  assert.equal((t.c.status().paused as any).by, 'reflex:reflexes')
  s.c.stop(); t.c.stop()
})

test('fired triggers run through the controller with the speaker as {player}', async () => {
  const s = setup({ version: 1, name: 't', rules: [{ name: 'stroll', score: 10, do: [{ act: 'wander' }] }], triggers: [{ name: 'hello', on: 'chat', match: ['hello'], do: [{ act: 'jump' }, { say: 'hi {player}' }] }] })
  s.queue.push({ trigger: s.program.triggers[0]!, player: 'Alex', at: Date.now() })
  await s.c.tick(); await s.c.settled()
  assert.equal(s.c.status().behavior, null)
  assert.deepEqual(s.calls.map(c => c.name), ['jump'])
  assert.deepEqual(s.said, ['hi Alex'])
  assert.deepEqual(s.outcomes, [`trigger hello ok`])
  assert.ok(TRIGGER_BEHAVIOR)
  s.c.stop()
})

test('a failing rule counts as failure and cools down', async () => {
  const s = setup({ version: 1, name: 't', rules: [{ name: 'patrol', score: 30, do: [{ fail: 'no place a' }] }] })
  await s.c.tick(); await s.c.settled()
  assert.deepEqual(s.outcomes, ['rule patrol fail'])
  assert.ok((s.c.status().cooldowns as any).patrol > 0)
  s.c.stop()
})
