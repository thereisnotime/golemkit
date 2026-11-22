import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { defineAction, ok, fail, sleep, type ActionResult, type ActOptions, type ActionDef } from '../src/core/index.ts'
import { FakeAgent, fakeActions } from '../src/llm/testing.ts'
import { LlmRuntime } from '../src/llm/runtime.ts'
import { GoalStore, continuationDecision, resolveGoalOptions, idleDelay, failureSignature, type Goal } from '../src/llm/goals.ts'
import { buildUserMessage } from '../src/llm/prompt.ts'
import type { LlmProvider, TurnInput, TurnResult } from '../src/llm/types.ts'
import { Storage } from '../src/core/index.ts'

const dirs: string[] = []
function tmp (): string {
  const d = mkdtempSync(join(tmpdir(), 'golemkit-goals-'))
  dirs.push(d)
  return d
}
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

class ScriptedProvider implements LlmProvider {
  readonly name = 'scripted'
  readonly needsMcp = false
  readonly billing = 'api' as const
  readonly model = 'claude-sonnet-5-5'
  inputs: TurnInput[] = []
  script: (turn: TurnInput, n: number) => Promise<TurnResult>
  constructor (script: (turn: TurnInput, n: number) => Promise<TurnResult>) { this.script = script }
  async check () { return null }
  async run (turn: TurnInput) {
    this.inputs.push(turn)
    return this.script(turn, this.inputs.length)
  }
}

/** FakeAgent that reports action ends to the runtime, like the llm brain wires agent.on('actionEnd'). */
class EventAgent extends FakeAgent {
  onEnd: ((info: any, r: ActionResult) => void) | null = null
  async act (name: string, params: unknown = {}, opts: ActOptions = {}): Promise<ActionResult> {
    const r = await super.act(name, params, opts)
    if (!/^(unknown action|bad parameters|busy)/.test(r.message)) {
      this.onEnd?.({ name, params, caller: opts.caller ?? { kind: 'system', name: 'system' }, priority: opts.priority ?? 0, player: opts.player }, r)
    }
    return r
  }
}

const extraActions = (): ActionDef<any>[] => [
  ...fakeActions(),
  defineAction({
    name: 'work',
    description: 'A long job (stands in for build / gather_materials).',
    params: z.object({ ms: z.number().default(80) }),
    longRunning: true,
    run: async ({ signal }, p) => { await sleep(p.ms, signal); return ok('built a hut at 1 2 3') }
  }),
  defineAction({
    name: 'chop_fail',
    description: 'Always fails the same way.',
    params: z.object({}),
    run: async () => fail('no natural tree within 32 blocks')
  })
]

function setup (provider: LlmProvider, opts: { dataDir?: string, goals?: Record<string, number>, limits?: Record<string, number> } = {}) {
  const agent = new EventAgent({ dataDir: opts.dataDir ?? tmp(), actions: extraActions() })
  const rt = new LlmRuntime(agent, {
    provider,
    triggers: { playerCooldownMs: 0 },
    tools: { startGraceMs: 20, actionTimeoutMs: 1000 },
    goals: { continueDelayMs: 5, idleBaseMs: 60_000, ...opts.goals },
    limits: opts.limits
  })
  agent.onEnd = (info, r) => rt.onActionEnd(info, r)
  return { agent, rt }
}

async function waitFor (cond: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms
  while (!cond()) {
    if (Date.now() > until) throw new Error('timed out waiting')
    await sleep(10)
  }
}

const settle = async (rt: LlmRuntime, ms = 150) => { await sleep(ms); await rt.idle() }

// ------------------------------------------------------------------ store

test('goal store: plan edits, prompt block, history', () => {
  let now = 1_000_000
  const g = new GoalStore(new Storage(tmp()), { maxTurns: 5 }, () => now)
  g.set('build a house', ['gather wood', 'build hut'], 'Steve', true)
  assert.match(g.fmtPrompt()!, /Goal \(for Steve\): build a house\n1\. \[ \] gather wood   <- next\n2\. \[ \] build hut/)
  assert.equal(g.update({ done: [1], note: 'site at 10 64 5' }), 'step 1 done, noted')
  g.update({ add: ['light it up'], insertAt: 2 })
  assert.deepEqual(g.active!.steps.map(s => s.text), ['gather wood', 'light it up', 'build hut'])
  g.update({ reorder: [3, 2] })
  assert.deepEqual(g.active!.steps.map(s => s.text), ['build hut', 'light it up', 'gather wood'])
  assert.deepEqual(g.observeField(), { text: 'build a house', steps: '1/3', next: 'build hut' })
  now += 60_000
  g.set('dig a well')
  assert.equal(g.history().at(-1)!.status, 'replaced')
  assert.equal(g.complete('dug it')!.text, 'dig a well')
  assert.equal(g.active, null)
  assert.deepEqual(g.history().map(h => h.status), ['replaced', 'done'])
})

test('continuation decision: guardrails and waits', () => {
  const opts = resolveGoalOptions({ maxTurns: 3, timeoutMin: 10, maxSameFailures: 2 })
  const goal: Goal = { id: 'x', text: 't', steps: [], notes: [], createdAt: 0, updatedAt: 0, autoTurns: 0, totalTurns: 0, deadlineAt: 600_000, failures: {}, stalls: 0 }
  const s = { now: 1000, busy: false, acting: false, connected: true, budgetBlocked: null, hour: { turns: 0, tokens: 0 }, limits: { turnsPerHour: 60, tokensPerHour: 0 } }
  assert.deepEqual(continuationDecision(goal, opts, s), { go: true })
  assert.deepEqual(continuationDecision(null, opts, s), { go: false, wait: 'no goal' })
  assert.equal((continuationDecision(goal, opts, { ...s, acting: true }) as any).wait, 'an action is running')
  assert.equal((continuationDecision(goal, opts, { ...s, busy: true }) as any).wait, 'thinking')
  assert.match((continuationDecision(goal, opts, { ...s, hour: { turns: 55, tokens: 0 } }) as any).wait, /budget/, 'keeps a reserve for chat')
  assert.match((continuationDecision(goal, opts, { ...s, budgetBlocked: 'turn budget used' }) as any).wait, /turn budget/)
  assert.match((continuationDecision({ ...goal, autoTurns: 3 }, opts, s) as any).stop, /3 turns/)
  assert.match((continuationDecision(goal, opts, { ...s, now: 700_000 }) as any).stop, /10 min/)
  assert.match((continuationDecision({ ...goal, failures: { 'chop: x': 2 } }, opts, s) as any).stop, /failed 2 times: chop: x/)
  assert.match((continuationDecision({ ...goal, paused: 'waiting for the owner' }, opts, s) as any).wait, /owner/)
  assert.equal(idleDelay(0, opts), 20_000)
  assert.equal(idleDelay(2, opts), 80_000)
  assert.equal(idleDelay(20, opts), 300_000)
  assert.equal(failureSignature('goto', 'stuck at 12 70 -3, 40 blocks left'), failureSignature('goto', 'stuck at 99 64 8, 7 blocks left'))
})

test('the active goal is near the top of the prompt', () => {
  const m = buildUserMessage({ trigger: { kind: 'goal', reason: 'actionDone', detail: 'build ok' }, observation: {}, recent: [], notes: [], goal: 'Goal: build a house\n1. [ ] build hut' })
  assert.ok(m.indexOf('## Your active goal') < m.indexOf('## You right now'))
  assert.match(m, /Keep working on your active goal \(an action just ended\)/)
  assert.match(m, /Last: build ok/)
})

// ------------------------------------------------------------------ runtime

test('a goal is worked through: set, long action, follow-up turn after it ends, complete', async () => {
  const p = new ScriptedProvider(async (turn, n) => {
    if (n === 1) {
      await turn.tools.call('set_goal', { goal: 'build us a house', steps: ['build hut'] })
      await turn.tools.call('work', {})
      await turn.tools.call('reply', { text: 'on it' })
    } else if (n === 2) {
      assert.match(turn.userMessage, /an action just ended/)
      assert.match(turn.userMessage, /work \(by you\) ok: built a hut/)
      assert.match(turn.userMessage, /1\. \[ \] build hut/)
      await turn.tools.call('update_goal', { done: [1] })
      await turn.tools.call('complete_goal', { result: 'built a hut at 1 2 3' })
      await turn.tools.call('reply', { text: 'done, hut at 1 2 3' })
    }
    return { text: '' }
  })
  const { agent, rt } = setup(p)
  await rt.start()
  rt.onChat({ from: 'Steve', message: 'Buddy build us a house', whisper: true })
  await waitFor(() => p.inputs.length >= 2 && !rt.isBusy && !rt.goals.active)
  await settle(rt)
  assert.equal(p.inputs.length, 2, 'no extra turns once the goal is done')
  assert.match(p.inputs[0]!.system, /set_goal/)
  assert.deepEqual(agent.said, [{ to: 'Steve', msg: 'on it' }, { to: 'Steve', msg: 'done, hut at 1 2 3' }], 'progress goes back the way the owner talked')
  assert.equal(rt.goals.history().at(-1)!.status, 'done')
  await rt.stop()
})

test('short actions continue too: one step per turn until done', async () => {
  const p = new ScriptedProvider(async (turn, n) => {
    if (n === 1) await turn.tools.call('set_goal', { goal: 'walk around', steps: ['go a', 'go b', 'go c'] })
    if (n >= 1 && n <= 3) {
      await turn.tools.call('goto', { x: n, z: n })
      await turn.tools.call('update_goal', { done: [n] })
    }
    if (n === 4) await turn.tools.call('complete_goal', { result: 'walked a, b, c' })
    return { text: '' }
  })
  const { agent, rt } = setup(p)
  await rt.start()
  rt.onChat({ from: 'Steve', message: 'walk around', whisper: true })
  await waitFor(() => !rt.goals.active)
  await settle(rt)
  assert.equal(p.inputs.length, 4)
  assert.deepEqual(agent.calls.filter(c => c.name === 'goto').map(c => c.player), ['Steve', 'Steve', 'Steve'], 'continuation acts for the owner')
  assert.deepEqual(p.inputs.slice(1).map(i => /## What happened\n(.*)/.exec(i.userMessage)![1]!.slice(0, 40)), Array(3).fill('Keep working on your active goal (an act'), 'each finished action starts the next turn')
  await rt.stop()
})

test('a goal survives a restart and is picked up again', async () => {
  const dir = tmp()
  const p1 = new ScriptedProvider(async (turn) => {
    await turn.tools.call('set_goal', { goal: 'build us a house', steps: ['gather wood', 'build hut'] })
    await turn.tools.call('update_goal', { wait_for_owner: false, done: [1] })
    return { text: '' }
  })
  const a = setup(p1, { dataDir: dir, goals: { continueDelayMs: 60_000 } })
  await a.rt.start()
  a.rt.onChat({ from: 'Steve', message: 'build us a house', whisper: true })
  await a.rt.idle()
  await a.rt.stop()
  a.agent.storage.flush()

  const p2 = new ScriptedProvider(async (turn) => {
    await turn.tools.call('complete_goal', { result: 'built it' })
    return { text: '' }
  })
  const b = setup(p2, { dataDir: dir })
  await b.rt.start()
  assert.equal(b.rt.goals.active?.text, 'build us a house', 'loaded from storage')
  assert.equal(b.rt.goals.active?.owner, 'Steve')
  b.rt.scheduleGoal('resume', 'reconnected', 0)
  await waitFor(() => p2.inputs.length === 1 && !b.rt.isBusy)
  assert.match(p2.inputs[0]!.userMessage, /You reconnected or restarted/)
  assert.match(p2.inputs[0]!.userMessage, /1\. \[x\] gather wood\n2\. \[ \] build hut   <- next/)
  assert.equal(b.rt.goals.active, null)
  await b.rt.stop()
})

test('guardrail: autonomous turn limit pauses the goal and asks the owner once', async () => {
  const p = new ScriptedProvider(async (turn, n) => {
    if (n === 1) await turn.tools.call('set_goal', { goal: 'jump forever' })
    if (/Stop working on your goal/.test(turn.userMessage)) await turn.tools.call('reply', { text: 'I did 3 rounds, keep going?' })
    else await turn.tools.call('jump', {})
    return { text: '' }
  })
  const { agent, rt } = setup(p, { goals: { maxTurns: 3 } })
  await rt.start()
  rt.onChat({ from: 'Steve', message: 'jump', whisper: true })
  await waitFor(() => !!rt.goals.active?.paused && !rt.isBusy)
  await settle(rt, 200)
  assert.equal(p.inputs.length, 5, '1 chat turn + 3 continuation turns + 1 stop report')
  assert.match(rt.goals.active!.paused!, /3 turns on my own/)
  assert.deepEqual(agent.said.at(-1), { to: 'Steve', msg: 'I did 3 rounds, keep going?' })

  // the owner answers: limits renew and work goes on
  rt.onChat({ from: 'Steve', message: 'yes go on', whisper: true })
  await waitFor(() => p.inputs.length >= 7)
  assert.equal(rt.goals.active!.paused === undefined || /turns/.test(rt.goals.active!.paused!), true)
  rt.goals.abandon('test over')
  await settle(rt)
  await rt.stop()
})

test('guardrail: the same failure three times puts that action on hold, the goal goes on', async () => {
  const results: string[] = []
  const p = new ScriptedProvider(async (turn, n) => {
    if (n === 1) await turn.tools.call('set_goal', { goal: 'get wood' })
    if (results.some(r => /on hold/.test(r))) return { text: '' } // a real model would do another step now
    results.push((await turn.tools.call('chop_fail', {})).text)
    return { text: '' }
  })
  const { agent, rt } = setup(p)
  await rt.start()
  rt.onChat({ from: 'Steve', message: 'get wood', whisper: true })
  await waitFor(() => results.some(r => /on hold/.test(r)))
  await settle(rt, 200)
  assert.equal(agent.calls.filter(c => c.name === 'chop_fail').length, 3, 'the 4th call is refused without running')
  assert.match(results.at(-1)!, /chop_fail is on hold for \d+ more min/)
  assert.equal(rt.goals.active!.paused, undefined, 'the goal keeps going')
  assert.match(rt.goals.active!.notes.join(' '), /chop_fail on hold 10 min/)
  await rt.stop()
})

test('owner !stop ends the goal; budget pauses continuation', async () => {
  const p = new ScriptedProvider(async (turn, n) => {
    if (n === 1) await turn.tools.call('set_goal', { goal: 'build' })
    return { text: '' }
  })
  const { rt } = setup(p, { goals: { continueDelayMs: 60_000 } })
  await rt.start()
  rt.onChat({ from: 'Steve', message: 'build', whisper: true })
  await rt.idle()
  assert.ok(rt.goals.active)
  rt.onActionEnd({ name: 'stop', params: {}, caller: { kind: 'brain', name: 'llm' }, priority: 30 }, { ok: true, message: 'stopped' })
  assert.ok(rt.goals.active, 'the model stopping its own action keeps the goal')
  rt.onActionEnd({ name: 'stop', params: {}, caller: { kind: 'player', name: 'Steve' }, priority: 50 }, { ok: true, message: 'stopped' })
  assert.equal(rt.goals.active, null)
  assert.match(rt.goals.history().at(-1)!.result, /stopped by Steve/)
  await rt.stop()

  const p2 = new ScriptedProvider(async (turn) => { await turn.tools.call('set_goal', { goal: 'build' }); return { text: '' } })
  const b = setup(p2, { limits: { turnsPerHour: 1 } })
  await b.rt.start()
  b.rt.onChat({ from: 'Steve', message: 'build', whisper: true })
  await b.rt.idle()
  assert.equal(b.rt.tryContinue('idle'), false, 'no continuation with the hourly budget used up')
  await settle(b.rt)
  assert.equal(p2.inputs.length, 1)
  await b.rt.stop()
})

test('when a goal turn completes the goal without chatting, the owner still hears the result', async () => {
  const p = new ScriptedProvider(async (turn, n) => {
    if (n === 1) { await turn.tools.call('set_goal', { goal: 'build' }); await turn.tools.call('work', {}) }
    if (n === 2) await turn.tools.call('complete_goal', { result: 'built a hut at 1 2 3' })
    return { text: '' }
  })
  const { agent, rt } = setup(p)
  await rt.start()
  rt.onChat({ from: 'Steve', message: 'build', whisper: true })
  await waitFor(() => !rt.goals.active && !rt.isBusy)
  assert.deepEqual(agent.said, [{ to: 'Steve', msg: 'done: built a hut at 1 2 3' }])
  await rt.stop()
})
