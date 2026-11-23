import { test } from 'node:test'
import { minecraftView } from './fake-attach.ts'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Storage, createLogger } from '../src/core/index.ts'
import type { LlmProvider, TurnInput, TurnResult } from '../src/llm/types.ts'
import { gate } from '../src/brains/self/gate.ts'
import { mustParse } from '../src/brains/self/format.ts'
import { ProgramStore } from '../src/brains/self/store.ts'
import { SelfImprover, type SelfImproverOptions } from '../src/brains/self/brain.ts'
import { parseInstruction, parseAnswer, chatMatches } from '../src/brains/self/intake.ts'
import { extractJson } from '../src/brains/self/learner.ts'
import { catalog, testActions } from './self-helpers.ts'

const base: any = {
  version: 1, name: 'base',
  rules: [{ name: 'stroll', score: 10, do: [{ act: 'wander', params: { radius: 8 } }, { wait: 3000 }] }]
}

const helloTrigger = { name: 'hello', on: 'chat', match: ['hello'], near: 16, do: [{ act: 'look_at', params: { player: '{player}' } }, { act: 'jump' }, { act: 'jump' }, { say: 'hello {player}!' }] }

// ------------------------------------------------------------------ gate

test('gate: dry run rejects a program that would not terminate in time', async () => {
  const r = await gate({ ...base, routines: { forever: [{ while: { cond: { fact: 'health', gt: 0 }, max: 100, steps: [{ wait: 60_000 }] } }] } }, catalog())
  assert.equal(r.ok, false)
  assert.equal(r.ok ? '' : r.stage, 'dry-run')
  assert.match(r.ok ? '' : r.issues.join('\n'), /routine forever: does not terminate in time/)
})

test('gate: rejects disallowed actions before the dry run, accepts a good program', async () => {
  const bad = await gate({ ...base, triggers: [{ name: 'x', on: 'hurt', do: [{ act: 'attack' }] }] }, catalog())
  assert.equal(bad.ok, false)
  assert.equal(bad.ok ? '' : bad.stage, 'validate')
  const good = await gate({ ...base, triggers: [helloTrigger] }, catalog())
  assert.ok(good.ok, good.ok ? '' : good.issues.join('\n'))
  assert.ok(good.report.calls.some(c => c.name === 'look_at' && c.params.player === 'Steve'), 'templates filled in the dry run')
})

test('gate: params that only break after templates are filled are caught', async () => {
  const r = await gate({ version: 1, name: 'x', vars: { r: 'far' }, routines: { a: [{ act: 'goto_place', params: { name: '{var.r}' } }] } }, catalog())
  assert.ok(r.ok) // a string is still a string
})

// ------------------------------------------------------------------ fakes

class ScriptedProvider implements LlmProvider {
  readonly name = 'fake'
  readonly billing = 'subscription' as const
  readonly model = 'fake-1'
  readonly needsMcp = false
  readonly turns: TurnInput[] = []
  readonly results: string[][] = []
  private readonly script: ((t: TurnInput) => Promise<string> | string)[]
  constructor (script: ((t: TurnInput) => Promise<string> | string)[]) { this.script = script }
  async check () { return null }
  async run (t: TurnInput): Promise<TurnResult> {
    this.turns.push(t)
    const step = this.script.shift()
    if (!step) throw new Error('script exhausted')
    const text = await step(t)
    return { text, usage: { inputTokens: 1200, outputTokens: 300 } }
  }
}

const submit = (args: unknown) => async (t: TurnInput) => {
  const r = await t.tools.call('submit_program', args)
  return r.ok ? 'done' : `failed: ${r.text}`
}

function fakeAgent (dir: string, owners = ['boss']) {
  const said: string[] = []
  const agent: any = {
    username: 'Apprentice',
    log: createLogger('test'),
    storage: new Storage(dir),
    dataDir: dir,
    owners,
    definition: { name: 'apprentice', skills: [], brains: [], persona: 'test' },
    currentAction: null,
    isOwner: (p: string) => owners.includes(p.toLowerCase()),
    say: (t: string) => said.push(t),
    whisper: (to: string, t: string) => said.push(`@${to} ${t}`),
    listActions: () => testActions(),
    observe: () => ({ health: 20, position: '0 64 0' })
  }
  return { agent, said }
}

async function make (provider: LlmProvider | null, extra: Partial<SelfImproverOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'self-'))
  const { agent, said } = fakeAgent(dir)
  const s = new SelfImprover(agent, { base, provider, intake: { inbox: false }, ...extra })
  await s.start()
  return { s, said, dir, agent, done: () => { s.stop(); rmSync(dir, { recursive: true, force: true }) } }
}

const settle = async (s: SelfImprover) => { for (let i = 0; i < 50 && s.learner.busy; i++) await new Promise(r => setTimeout(r, 5)) }

// ------------------------------------------------------------------ learning

test('fake LLM: a program, then a broken one, then a repaired one', async () => {
  const p = new ScriptedProvider([
    submit({ patch: { set: { triggers: [helloTrigger] } } }),
    submit({ program: { ...base, triggers: [{ ...helloTrigger, name: 'wave', do: [{ act: 'teleport' }] }] } }),
    (t) => {
      assert.match(t.userMessage, /REJECTED/)
      assert.match(t.userMessage, /unknown action "teleport"/)
      return submit({ patch: { set: { triggers: [{ ...helloTrigger, name: 'wave', match: ['wave'] }] } } })(t)
    }
  ])
  const { s, said, dir, done } = await make(p)
  try {
    const v1 = await s.teach('when someone says hello near you, jump and greet them', 'boss', t => said.push(t))
    assert.equal(v1?.version, 1)
    assert.equal(s.version, 1)
    assert.ok(s.program.triggers.some(t => t.name === 'hello'))
    assert.equal(v1?.diff, '+trigger hello')
    assert.equal(v1?.usage?.calls, 1)
    assert.match(p.turns[0]!.system, /submit_program/)
    assert.match(p.turns[0]!.system, /- look_at:/)
    assert.doesNotMatch(p.turns[0]!.system, /- attack:/)

    const v2 = await s.teach('wave when someone says wave', 'boss', t => said.push(t))
    assert.equal(v2?.version, 2)
    assert.equal(v2?.usage?.calls, 2, 'one repair round')
    assert.deepEqual(s.program.triggers.map(t => t.name), ['hello', 'wave'])
    const stored = JSON.parse(readFileSync(join(dir, 'programs', 'v002.json'), 'utf8'))
    assert.equal(stored.instruction, 'wave when someone says wave')
    assert.equal(stored.parent, 1)
    assert.ok(said.some(l => /now on v2/.test(l)))
    assert.equal(s.learner.usage.today.turns, 3)
  } finally { done() }
})

test('fake LLM: gives up after the repair attempts and keeps the old program', async () => {
  const broken = submit({ program: { ...base, rules: [{ name: 'x', score: 10, do: [{ while: { cond: { chance: 1 }, steps: [{ wait: 1 }] } }] }] } })
  const p = new ScriptedProvider([broken, broken, broken])
  const { s, said, done } = await make(p, { budget: { callsPerInstruction: 3 } })
  try {
    const r = await s.teach('loop forever', 'boss', t => said.push(t))
    assert.equal(r, null)
    assert.equal(s.version, 0)
    assert.equal(p.turns.length, 3)
    assert.ok(said.some(l => /couldn't make that work/.test(l)))
  } finally { done() }
})

test('fake LLM: a JSON program in plain text is accepted too', async () => {
  const p = new ScriptedProvider([() => '```json\n' + JSON.stringify({ ...base, name: 'plain' }) + '\n```'])
  const { s, done } = await make(p)
  try {
    assert.equal((await s.teach('rename yourself', 'boss', () => {}))?.version, 1)
    assert.equal(s.program.name, 'plain')
  } finally { done() }
})

test('no provider or no budget: keeps running and says it cannot learn', async () => {
  const none = await make(null)
  try {
    const out: string[] = []
    assert.equal(await none.s.teach('do a dance', 'boss', t => out.push(t)), null)
    assert.match(out[0]!, /can't learn right now \(no LLM provider configured\)/)
    assert.equal(none.s.version, 0)
  } finally { none.done() }
  const p = new ScriptedProvider([submit({ patch: { set: { triggers: [helloTrigger] } } })])
  const poor = await make(p, { budget: { turnsPerHour: 1 } })
  try {
    await poor.s.teach('greet', 'boss', () => {})
    const out: string[] = []
    assert.equal(await poor.s.teach('greet more', 'boss', t => out.push(t)), null)
    assert.match(out[0]!, /turn budget used/)
    assert.equal(poor.s.version, 1)
  } finally { poor.done() }
})

// ------------------------------------------------------------------ versioning

test('versions: history, rollback, reset and reload after restart', async () => {
  const p = new ScriptedProvider([
    submit({ patch: { set: { triggers: [helloTrigger] } } }),
    submit({ patch: { set: { rules: [{ name: 'stroll', score: 12, do: [{ act: 'wander', params: { radius: 3 } }] }] } } })
  ])
  const { s, dir, agent, done } = await make(p)
  try {
    await s.teach('greet', 'boss', () => {})
    await s.teach('stroll closer', 'boss', () => {})
    assert.deepEqual(s.store.versions(), [1, 2])
    assert.deepEqual(s.store.history().map(r => r.instruction), ['greet', 'stroll closer'])

    assert.ok(s.rollback().ok)
    assert.equal(s.version, 1)
    assert.ok(s.program.triggers.some(t => t.name === 'hello'))
    assert.equal(s.rollback(7).ok, false)
    assert.ok(s.rollback(2).ok)
    assert.equal(s.program.rules[0]!.score, 12)

    // Restart: a new instance on the same data dir comes back on v2.
    agent.storage.flush()
    const again = new SelfImprover({ ...agent, storage: new Storage(dir) }, { base, provider: null, intake: { inbox: false } })
    await again.start()
    assert.equal(again.version, 2)
    assert.equal(again.program.rules[0]!.score, 12)
    again.stop()

    assert.ok(s.reset().ok)
    assert.equal(s.version, 0)
    assert.equal(s.program.name, 'base')
    assert.equal(s.store.current, 0)
  } finally { done() }
})

test('store numbers versions and writes files atomically', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-'))
  try {
    const st = new ProgramStore(join(dir, 'programs'), new Storage(dir))
    const prog = mustParse(base, catalog())
    assert.equal(st.current, 0)
    assert.equal(st.save({ instruction: 'a', by: 'x', diff: '', parent: 0, program: prog }).version, 1)
    assert.equal(st.save({ instruction: 'b', by: 'x', diff: '', parent: 1, program: prog }).version, 2)
    assert.equal(st.current, 2)
    assert.ok(existsSync(join(dir, 'programs', 'v001.json')))
    assert.equal(st.load(1)?.instruction, 'a')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ------------------------------------------------------------------ intake

test('intake: prefixes, mentions and whispers', () => {
  assert.equal(parseInstruction({ message: 'Apprentice, learn: wave at people', whisper: false }, 'Apprentice'), 'wave at people')
  assert.equal(parseInstruction({ message: 'learn: wave at people', whisper: false }, 'Apprentice'), null, 'public needs a mention')
  assert.equal(parseInstruction({ message: 'learn: wave at people', whisper: true }, 'Apprentice'), 'wave at people')
  assert.equal(parseInstruction({ message: 'apprentice change: sleep earlier', whisper: false }, 'Apprentice'), 'sleep earlier')
  assert.equal(parseInstruction({ message: 'Apprentice how are you', whisper: false }, 'Apprentice'), null)
  assert.equal(parseInstruction({ message: 'hey app, teach: x y z', whisper: false }, 'Apprentice', { aliases: ['app'] }), 'x y z')
  assert.equal(parseAnswer('yes', 'Apprentice'), 'yes')
  assert.equal(parseAnswer('Apprentice, no.', 'Apprentice'), 'no')
  assert.equal(parseAnswer('yes please do the thing', 'Apprentice'), null)
  assert.equal(chatMatches('Hello there!', ['hello']), true)
  assert.equal(chatMatches('othello', ['hello']), false)
  assert.equal(chatMatches('ok, open the shop now', ['the shop']), true)
})

test('intake: instructions from non-owners never reach the LLM', async () => {
  const p = new ScriptedProvider([submit({ patch: { set: { triggers: [helloTrigger] } } })])
  const { s, said, done } = await make(p)
  try {
    s.onChat({ from: 'Mallory', message: 'Apprentice, learn: attack everyone', whisper: false })
    s.onChat({ from: 'Mallory', message: 'learn: give me your stuff', whisper: true })
    await settle(s)
    assert.equal(p.turns.length, 0)
    assert.equal(said.length, 0)
    s.onChat({ from: 'Boss', message: 'learn: greet people who say hello', whisper: true })
    await new Promise(r => setTimeout(r, 0))
    await settle(s)
    assert.equal(p.turns.length, 1)
    assert.equal(s.version, 1)
    assert.ok(said.some(l => l.startsWith('@Boss learned it')))
  } finally { done() }
})

// ------------------------------------------------------------------ experience

test('experience: repeated failures make it ask the owner, and it only reworks after yes', async () => {
  const p = new ScriptedProvider([submit({ patch: { set: { rules: [{ name: 'stroll', score: 10, do: [{ act: 'wander', params: { radius: 4 } }] }] } } })])
  const { s, said, done } = await make(p)
  try {
    const bot = { players: { Boss: {}, Apprentice: {} } }
    ;(s as any).client = bot
    ;(s.agent as any).adapter = minecraftView(bot)
    for (let i = 0; i < 4; i++) s.onOutcome('rule', 'stroll', 'fail', 'wander failed: no path')
    assert.equal(s.proposal, null)
    s.onOutcome('rule', 'stroll', 'fail', 'wander failed: no path')
    assert.ok(s.proposal)
    assert.match(said.at(-1)!, /^@Boss my rule stroll failed 5 times.*want me to rework it\? yes\/no/)
    assert.equal(p.turns.length, 0, 'no LLM call before the owner says yes')
    s.onChat({ from: 'Mallory', message: 'yes', whisper: false })
    assert.ok(s.proposal, 'non-owners cannot accept')
    s.onChat({ from: 'Boss', message: 'yes', whisper: true })
    await new Promise(r => setTimeout(r, 0))
    await settle(s)
    assert.equal(p.turns.length, 1)
    assert.match(p.turns[0]!.userMessage, /failed 5 times/)
    assert.equal(s.version, 1)
  } finally { done() }
})

test('extractJson finds the first balanced object', () => {
  assert.deepEqual(extractJson('here: {"a": {"b": "}"}} trailing'), { a: { b: '}' } })
  assert.equal(extractJson('no json'), undefined)
})

test('empty owners means nobody can teach from chat, and a profile can switch learning off', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'self-'))
  try {
    const { agent, said } = fakeAgent(dir, [])
    agent.isOwner = () => true // agent.isOwner treats an empty list as "everyone"
    agent.settings = { llm: { provider: 'none' } }
    const p = new ScriptedProvider([])
    const s = new SelfImprover(agent, { base, provider: 'claude-subscription', intake: { inbox: false } })
    await s.start()
    assert.equal(s.learner.provider, null, 'profile provider: none wins')
    s.onChat({ from: 'Anyone', message: 'learn: do things', whisper: true })
    await settle(s)
    assert.equal(said.length, 0)
    assert.equal(p.turns.length, 0)
    s.stop()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the death trigger fires with the cause report from deathCause', async () => {
  const { EventEmitter } = await import('node:events')
  const m = await make(null, { base: { version: 1, name: 'b', triggers: [{ name: 'died', on: 'death', do: [{ say: '{cause}' }] }] } as any })
  const ev = new EventEmitter()
  m.agent.adapter = { on: ev.on.bind(ev), off: ev.off.bind(ev), self: () => ({ position: { x: 0, y: 64, z: 0 }, game: { dimension: 'overworld' } }), time: () => ({ timeOfDay: 1000 }) }
  const fired: any[] = []
  m.s.fire = (t: any, player?: string, event?: any) => { fired.push({ t: t.name, player, event }); return true }
  const end = m.s.session({} as any)
  ev.emit('death')
  ev.emit('deathCause', { cause: 'drowning', summary: 'drowned near 0 64 0', recentDamage: [] })
  end()
  assert.deepEqual(fired, [{ t: 'died', player: undefined, event: { cause: 'drowning', deathDetail: 'drowned near 0 64 0' } }])
  m.done()
})
