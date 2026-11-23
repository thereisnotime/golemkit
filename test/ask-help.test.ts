import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HelpDesk, normalizeReason, resolveHelpOptions, helpMessage, type HelpSource } from '../src/brains/npc/help.ts'
import { NpcController } from '../src/brains/npc/controller.ts'
import type { Behavior } from '../src/brains/npc/index.ts'
import { stockHelp, withStockHelp } from '../src/adapters/minecraft-java/behaviors/help.ts'
import { keepToolsUpgraded } from '../src/adapters/minecraft-java/behaviors/tools.ts'
import { parseProfile } from '../src/core/profile.ts'
import { fmtEvent } from '../src/core/journal/format.ts'
import { resolveTypes } from '../src/skills/journal.ts'
import { createLogger, fail, ok } from '../src/core/index.ts'
import { minecraftView } from './fake-attach.ts'

const MIN = 60_000

interface FakeAgent {
  settings: Record<string, unknown>
  owners: string[]
  online: string[]
  whispers: { to: string, msg: string }[]
  said: string[]
  journal: { type: string, data: Record<string, any> }[]
  events: { ev: string, ask: any }[]
  store: Map<string, unknown>
  agent: any
}

function fakeAgent (askHelp: unknown = true, online = ['Robin']): FakeAgent {
  const f: FakeAgent = {
    settings: { askHelp },
    owners: ['robin'],
    online,
    whispers: [],
    said: [],
    journal: [],
    events: [],
    store: new Map(),
    agent: null
  }
  f.agent = {
    get settings () { return f.settings },
    owners: f.owners,
    log: createLogger('test'),
    whisper: (to: string, msg: string) => f.whispers.push({ to, msg }),
    say: (msg: string) => f.said.push(msg),
    journal: { record: (type: string, data: Record<string, any>) => { f.journal.push({ type, data }); return true } },
    emit: (ev: string, ask: any) => { f.events.push({ ev, ask }) },
    storage: { get: (k: string, fb?: unknown) => f.store.has(k) ? f.store.get(k) : fb, set: (k: string, v: unknown) => f.store.set(k, v) },
    adapter: { players: () => [...f.online, 'Pax'], self: () => ({ username: 'Pax' }) }
  }
  return f
}

const tools: HelpSource = { name: 'keep_tools_upgraded', goal: 'upgrade my tools', help: () => 'a few logs or planks in my chest' }

test('normalizeReason groups failures that differ only in numbers and details', () => {
  assert.equal(normalizeReason('no natural tree within 32 blocks'), normalizeReason('no natural tree within 64 blocks'))
  assert.equal(normalizeReason('stuck at 12 64 -5'), 'stuck at #')
  assert.equal(normalizeReason('could not make sticks for a stone pickaxe (have 0 logs, 1 planks)'), 'could not make sticks for a stone pickaxe')
  assert.equal(normalizeReason('no natural tree I may cut within 120 blocks (near spawn); looking again in 5 min'), 'no natural tree i may cut within # blocks')
  assert.notEqual(normalizeReason('No path to the goal'), normalizeReason('no chest nearby'))
  assert.equal(normalizeReason(''), 'failed')
})

test('asks once after N failures spread over M minutes, whispering the online owner', () => {
  const f = fakeAgent({ failures: 3, minutes: 10 })
  const d = new HelpDesk(f.agent)
  let t = 1_000_000
  assert.equal(d.failure(tools, 'could not make sticks (have 0 logs)', t), null)
  assert.equal(d.failure(tools, 'could not make sticks (have 1 planks)', t += 2 * MIN), null)
  assert.equal(d.failure(tools, 'could not make sticks', t += 2 * MIN), null, '3 failures but only 4 minutes')
  const ask = d.failure(tools, 'could not make sticks', t += 8 * MIN)
  assert.ok(ask)
  assert.deepEqual(f.whispers.map(w => w.to), ['Robin'])
  assert.match(f.whispers[0]!.msg, /^Stuck trying to upgrade my tools: could not make sticks \(4 tries over 12 min\)\. A few logs or planks in my chest would help\.$/)
  assert.equal(f.journal[0]?.type, 'help')
  assert.equal(f.journal[0]?.data.status, 'asked')
  assert.equal(f.events[0]?.ev, 'askHelp')
  // more of the same, or another reason of the same behaviour while it is open: quiet
  assert.equal(d.failure(tools, 'could not make sticks', t += 5 * MIN), null)
  assert.equal(d.failure(tools, 'no crafting table', t += 5 * MIN), null)
  assert.equal(f.whispers.length, 1)
  // an hour later the same reason may be asked again
  assert.ok(d.failure(tools, 'could not make sticks', t += 60 * MIN))
  assert.equal(f.whispers.length, 2)
})

test('disabled: tracks but never asks; enabled by an options map', () => {
  const f = fakeAgent(false)
  const d = new HelpDesk(f.agent)
  for (let i = 0; i < 10; i++) d.failure(tools, 'x', i * 5 * MIN)
  assert.equal(f.whispers.length, 0)
  assert.equal(d.open()[0]?.count, 10)
  assert.equal(resolveHelpOptions({ askHelp: { failures: 5 } }).enabled, true)
  assert.equal(resolveHelpOptions({}).enabled, false)
  assert.equal(resolveHelpOptions({ askHelp: { enabled: false } }).enabled, false)
})

test('nobody online: no ask yet, the next failure tries again', () => {
  const f = fakeAgent({ failures: 2, minutes: 1 }, [])
  const d = new HelpDesk(f.agent)
  d.failure(tools, 'x', 0)
  assert.equal(d.failure(tools, 'x', 2 * MIN), null)
  assert.equal(f.said.length + f.whispers.length, 0)
  f.online.push('Robin')
  assert.ok(d.failure(tools, 'x', 4 * MIN))
  assert.equal(f.whispers.length, 1)
})

test('tell: say goes to public chat', () => {
  const f = fakeAgent({ failures: 1, minutes: 0, tell: 'say' })
  new HelpDesk(f.agent).failure(tools, 'x', 0)
  assert.equal(f.said.length, 1)
  assert.equal(f.whispers.length, 0)
})

test('hourly cap over all behaviours', () => {
  const f = fakeAgent({ failures: 1, minutes: 0, maxPerHour: 2 })
  const d = new HelpDesk(f.agent)
  assert.ok(d.failure({ name: 'a' }, 'x', 0))
  assert.ok(d.failure({ name: 'b' }, 'x', MIN))
  assert.equal(d.failure({ name: 'c' }, 'x', 2 * MIN), null)
  assert.ok(d.failure({ name: 'c' }, 'x', 61 * MIN), 'the first ask left the hour')
})

test('a help hook returning null keeps it quiet (the behaviour reports itself)', () => {
  const f = fakeAgent({ failures: 1, minutes: 0 })
  const d = new HelpDesk(f.agent)
  assert.equal(d.failure({ name: 'keep_fed', help: () => null }, 'x', 0), null)
  assert.equal(f.whispers.length, 0)
})

test('explicit asks (keep_fed) share the limits, go out when askHelp is off and fall back to chat', () => {
  const f = fakeAgent(false, [])
  const d = new HelpDesk(f.agent)
  const req = { behavior: 'keep_fed', reason: 'no food', text: "I'm starving", fallbackSay: true }
  assert.ok(d.ask(req, 0))
  assert.deepEqual(f.said, ["I'm starving"])
  assert.equal(d.ask(req, 30 * MIN), null, 'once an hour')
  assert.ok(d.ask(req, 61 * MIN))

  // with askHelp on, the generic escalation for keep_fed stays quiet after its own report
  const g = fakeAgent({ failures: 1, minutes: 0 })
  const d2 = new HelpDesk(g.agent)
  d2.ask({ behavior: 'keep_fed', reason: 'no food', text: 'starving' }, 0)
  assert.equal(d2.failure({ name: 'keep_fed' }, 'nothing left to try', MIN), null)
  assert.equal(g.whispers.length, 1)
})

test('success marks the ask sorted; thanks only when configured', () => {
  const f = fakeAgent({ failures: 1, minutes: 0 })
  const d = new HelpDesk(f.agent)
  d.failure(tools, 'x', 0)
  const sorted = d.success('keep_tools_upgraded', 5 * MIN)
  assert.ok(sorted?.sortedAt)
  assert.equal(f.whispers.length, 1, 'no thanks by default')
  assert.equal(f.journal.at(-1)?.data.status, 'sorted')
  assert.equal(d.success('keep_tools_upgraded', 6 * MIN), null, 'only once')
  assert.equal(d.observeView(10 * MIN)[0]?.sorted, true)
  assert.equal(d.observeView(70 * MIN).length, 0, 'gone from observe after an hour')

  const g = fakeAgent({ failures: 1, minutes: 0, thanks: true })
  const d2 = new HelpDesk(g.agent)
  d2.failure(tools, 'x', 0)
  d2.success('keep_tools_upgraded', MIN)
  assert.match(g.whispers[1]!.msg, /sorted: upgrade my tools works again, thanks/)
  assert.equal(g.events.at(-1)?.ev, 'helpSorted')
})

test('quiet hours hold the ask until after', () => {
  const f = fakeAgent({ failures: 1, minutes: 0, quietHours: [23, 7] })
  const d = new HelpDesk(f.agent)
  const night = new Date(2026, 10, 23, 2, 0).getTime()
  assert.equal(d.failure(tools, 'x', night), null)
  assert.ok(d.failure(tools, 'x', new Date(2026, 10, 23, 8, 0).getTime()))
})

test('sent asks survive a restart (storage)', () => {
  const f = fakeAgent({ failures: 1, minutes: 0 })
  new HelpDesk(f.agent).failure(tools, 'x', 0)
  const again = new HelpDesk(f.agent)
  assert.equal(again.failure(tools, 'x', MIN), null)
  assert.equal(f.whispers.length, 1)
})

test('llm: false emits nothing', () => {
  const f = fakeAgent({ failures: 1, minutes: 0, llm: false })
  new HelpDesk(f.agent).failure(tools, 'x', 0)
  assert.equal(f.events.length, 0)
  assert.equal(f.whispers.length, 1)
})

test('helpMessage without a hint asks openly', () => {
  assert.equal(helpMessage({ goal: 'get home', reason: 'No path to the goal', tried: '3 tries over 12 min' }), 'Stuck trying to get home: No path to the goal (3 tries over 12 min). Any idea?')
})

// ------------------------------------------------------------------ controller

test('the controller escalates a behaviour that keeps failing and marks it sorted on success', async () => {
  const f = fakeAgent({ failures: 3, minutes: 10 })
  const clock = { t: 1_000_000 }
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0, distanceTo: () => 0 } }, food: 20, health: 20, time: { timeOfDay: 1000 },
    entities: {}, players: {}, game: { dimension: 'overworld' }, inventory: { items: () => [], inventoryStart: 9, inventoryEnd: 45 }
  }
  const a = f.agent
  Object.assign(a, { currentAction: null, getAction: () => undefined, act: async () => ok('') })
  a.adapter = minecraftView(bot)
  a.adapter.players = () => ['Robin']
  let result = fail('no natural tree within 32 blocks')
  const chop: Behavior = { name: 'chop_wood_loop', goal: 'keep a stock of wood', score: () => 30, run: async () => result, failureCooldownMs: 1000, maxFailureCooldownMs: 1000, help: () => 'a few logs in my chest' }
  const c = new NpcController(a, bot as any, { behaviors: [chop], now: () => clock.t, autoHome: false })
  for (let i = 0; i < 6; i++) {
    await c.tick(); await c.settled()
    clock.t += 4 * MIN
    result = fail(`no natural tree within ${32 * (i + 2)} blocks`)
  }
  assert.equal(f.whispers.length, 1)
  assert.match(f.whispers[0]!.msg, /keep a stock of wood: no natural tree within \d+ blocks .*A few logs in my chest would help/)
  assert.match(c.summary(), /asked for help: chop_wood_loop/)
  result = ok('chopped')
  await c.tick(); await c.settled()
  assert.equal(f.journal.at(-1)?.data.status, 'sorted')
  c.stop()
})

// ------------------------------------------------------------------ stock hints, profile, journal

test('stock help texts for the usual failures', () => {
  const f = (reason: string) => ({ reason, key: normalizeReason(reason), messages: [reason] })
  assert.equal(stockHelp('keep_tools_upgraded', f('could not make sticks for a stone pickaxe (have nothing)')), 'a few logs or planks in my chest')
  assert.match(stockHelp('chop_wood_loop', f('no natural tree within 32 blocks'))!, /logs/)
  assert.match(stockHelp('stay_safe', f('No path to the goal'))!, /path or door into my home/)
  assert.match(stockHelp('anything', f('No path to the goal'))!, /clear path/)
  assert.equal(stockHelp('anything', f('weird')), undefined)
  const [def] = withStockHelp([keepToolsUpgraded])
  assert.equal(def!.goal, 'upgrade my tools')
  assert.ok(def!.help)
})

test('profile askHelp lands in settings.askHelp', () => {
  const on = parseProfile('variant: buddy\naskHelp: true\n')
  assert.deepEqual((on.options.settings as any).askHelp, { enabled: true })
  const opts = parseProfile('variant: buddy\naskHelp: { failures: 4, minutes: 20, tell: say, quietHours: [23, 7] }\n')
  const o = resolveHelpOptions(opts.options.settings as any)
  assert.equal(o.enabled, true)
  assert.equal(o.failures, 4)
  assert.equal(o.tell, 'say')
  assert.deepEqual(o.quietHours, [23, 7])
  assert.throws(() => parseProfile('variant: buddy\naskHelp: { tell: everyone }\n'))
})

test('journal: help events format and recall by type', () => {
  const e = { ts: Date.now(), type: 'help', data: { status: 'asked', behavior: 'chop_wood_loop', reason: 'no natural tree within 32 blocks', help: 'a few logs', to: ['Robin'] } }
  assert.match(fmtEvent(e), /asked Robin for help with chop_wood_loop: no natural tree within 32 blocks; needs a few logs/)
  assert.match(fmtEvent({ ...e, data: { status: 'sorted', behavior: 'chop_wood_loop', minutes: 12 } }), /chop_wood_loop works again/)
  assert.deepEqual(resolveTypes('stuck'), ['help'])
})

test('helpMessage: a long reason is cut so the ask stays one chat line', async () => {
  const { helpMessage, HELP_MAX_CHARS } = await import('../src/brains/npc/help.ts')
  const m = helpMessage({
    goal: 'keep a stock of wood',
    reason: 'no natural tree I may cut within 250 blocks (not ready for a trip (looking for trees): no food to take along); looking again in 1 min',
    tried: '5 tries over 20 min',
    help: 'a few logs in my chest, or a forest I may cut (remember_place)'
  })
  assert.ok(m.length <= HELP_MAX_CHARS, `${m.length} chars: ${m}`)
  assert.match(m, /\(remember_place\) would help\.$/)
})
