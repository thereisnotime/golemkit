import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveStatusOptions, STATUS_DEFAULTS, assess, idleReason, alertDue, alertText, chatLine, formatStatus, fmtDuration,
  type DeciderSnapshot, type AssessInput, type BotStatus
} from '../src/core/status.ts'
import { StatusTracker } from '../src/core/statusTracker.ts'
import { NpcController } from '../src/brains/npc/controller.ts'
import type { Behavior } from '../src/brains/npc/index.ts'
import { parseProfile } from '../src/core/profile.ts'
import { findToggle } from '../src/core/toggles.ts'
import { createLogger, fail, ok, type ActionInfo, type ActionResult } from '../src/core/index.ts'
import { minecraftView } from './fake-attach.ts'

const MIN = 60_000
const NOW = 10_000_000

function decider (over: Partial<DeciderSnapshot> = {}): DeciderSnapshot {
  return {
    name: 'npc', behavior: null, startedAt: null, score: null, priority: null, holder: null, paused: null,
    suspended: null, idleSince: NOW - 5 * MIN, scores: [], cooling: [], lastFailure: null, lastSuccess: null, ...over
  }
}

function input (over: Partial<AssessInput> = {}): AssessInput {
  return { now: NOW, connected: true, progressAt: NOW - MIN, baselineAt: 0, stuckAlertMs: 10 * MIN, doing: null, deciders: [], lastFailure: null, ...over }
}

// ------------------------------------------------------------------ options

test('status options: defaults, false, maps and clamping', () => {
  assert.deepEqual(resolveStatusOptions({}), STATUS_DEFAULTS)
  assert.deepEqual(resolveStatusOptions({ status: true }), STATUS_DEFAULTS)
  const off = resolveStatusOptions({ status: false })
  assert.equal(off.file, false)
  assert.equal(off.alert, false)
  const o = resolveStatusOptions({ status: { alert: false, stuckAlertMs: 5, intervalMs: '2000' } })
  assert.equal(o.alert, false)
  assert.equal(o.file, true)
  assert.equal(o.stuckAlertMs, 60_000) // clamped to the minimum
  assert.equal(o.intervalMs, 2000)
})

test('profile status key lands in settings.status; toggles exist; unknown keys warn', () => {
  assert.deepEqual(parseProfile('variant: buddy\nstatus: { alert: false, stuckAlertMs: 300000 }\n').options.settings?.status, { alert: false, stuckAlertMs: 300000 })
  assert.deepEqual(parseProfile('variant: buddy\nstatus: false\n').options.settings?.status, { file: false, alert: false })
  assert.throws(() => parseProfile('variant: buddy\nstatus: { stuckAlert: 5 }\n'))
  for (const k of ['status.file', 'status.alert', 'status.intervalMs', 'status.stuckAlertMs', 'status.alertMaxMs']) assert.ok(findToggle(k), k)
})

// ------------------------------------------------------------------ pure assessment

test('idleReason names the cause: suspended, holder, back-off, failures, waiting, nothing', () => {
  assert.equal(idleReason(decider({ behavior: 'x' }), NOW), null)
  assert.match(idleReason(decider({ suspended: 'acting in scene a' }), NOW)!, /suspended: acting in scene a/)
  assert.match(idleReason(decider({ holder: 'player:Robin@50' }), NOW)!, /body held by player:Robin@50/)
  assert.match(idleReason(decider({ paused: { until: NOW + 20_000, by: 'brain:llm' } }), NOW)!, /backing off 20s for brain:llm/)
  const failing = decider({ cooling: [{ name: 'chop', until: NOW + 40_000, failures: 3 }], lastFailure: { behavior: 'chop', message: 'no natural tree within 32 blocks', at: NOW - 1000 } })
  assert.equal(idleReason(failing, NOW), 'chop cooling 40s after failing: no natural tree within 32 blocks')
  assert.match(idleReason(decider({ scores: [{ name: 'wander', score: 12 }] }), NOW)!, /waiting to start wander/)
  assert.match(idleReason(decider({ cooling: [{ name: 'wander', until: NOW + 30_000, failures: 0 }] }), NOW)!, /nothing to do; wander again in 30s/)
  assert.match(idleReason(decider(), NOW)!, /nothing wants to run/)
  assert.equal(idleReason(decider({ reason: 'night, waiting in bed' }), NOW), 'night, waiting in bed')
})

test('assess: offline, working, idle, busy', () => {
  assert.equal(assess(input({ connected: false })).state, 'offline')
  const run = decider({ behavior: 'chop', score: 40, startedAt: NOW - MIN, priority: 20 })
  const w = assess(input({ deciders: [run] }))
  assert.equal(w.state, 'working')
  assert.equal(w.trying, 'chop')
  assert.equal(w.why, 'chop scored 40')
  // nothing wanted, long quiet: idle, not stuck
  const i = assess(input({ progressAt: NOW - 60 * MIN, deciders: [decider()] }))
  assert.equal(i.state, 'idle')
  assert.match(i.why, /nothing wants to run/)
  // no decision loop at all: waiting for orders
  assert.match(assess(input({ progressAt: null })).why, /waiting for orders/)
  // a long-running order (follow) is busy, never stuck
  const doing = { action: 'follow', caller: 'player:Robin', priority: 50, since: NOW - 30 * MIN, longRunning: true }
  assert.equal(assess(input({ progressAt: NOW - 30 * MIN, doing })).state, 'busy')
})

test('assess: stuck when it wants something and nothing happened for stuckAlertMs', () => {
  const failing = decider({
    cooling: [{ name: 'chop', until: NOW + 60_000, failures: 4 }],
    lastFailure: { behavior: 'chop', message: 'no natural tree within 32 blocks', at: NOW - 30_000 }
  })
  const lastFailure = { what: 'chop', message: 'no natural tree within 32 blocks', at: NOW - 30_000 }
  const a = assess(input({ progressAt: NOW - 15 * MIN, deciders: [failing], lastFailure }))
  assert.equal(a.state, 'stuck')
  assert.equal(a.trying, 'chop')
  assert.equal(a.blocker, 'chop: no natural tree within 32 blocks')
  assert.equal(a.quietMs, 15 * MIN)
  // same picture, but progress 5 minutes ago: not yet
  assert.equal(assess(input({ progressAt: NOW - 5 * MIN, deciders: [failing], lastFailure })).state, 'idle')
  // the session started 2 minutes ago: the time offline doesn't count
  assert.equal(assess(input({ progressAt: NOW - 60 * MIN, baselineAt: NOW - 2 * MIN, deciders: [failing], lastFailure })).state, 'idle')
  // running but going nowhere, held by a reflex
  const held = decider({ holder: 'reflex:defend@60' })
  const h = assess(input({ progressAt: NOW - 20 * MIN, deciders: [held], doing: { action: 'defend', caller: 'reflex:reflexes', priority: 60, since: NOW - 20 * MIN, longRunning: false } }))
  assert.equal(h.state, 'stuck')
  assert.match(h.blocker!, /body held by reflex:defend@60/)
  // need and goal come through and make it want something
  const g = assess(input({ progressAt: NOW - 20 * MIN, deciders: [decider({ need: 'food', goal: 'farm wheat' })] }))
  assert.equal(g.state, 'stuck')
  assert.equal(g.need, 'food')
  assert.equal(g.goal, 'farm wheat')
  assert.equal(g.trying, 'farm wheat')
})

test('alertDue: once, then doubling back-off up to the cap, reset on progress', () => {
  const o = { alert: true, stuckAlertMs: 10 * MIN, alertMaxMs: 30 * MIN }
  const stuck = { state: 'stuck' as const }
  assert.equal(alertDue({ count: 0, lastAt: null }, stuck, o, NOW).send, true)
  assert.equal(alertDue({ count: 1, lastAt: NOW }, stuck, o, NOW + 9 * MIN).send, false)
  assert.equal(alertDue({ count: 1, lastAt: NOW }, stuck, o, NOW + 10 * MIN).send, true)
  assert.equal(alertDue({ count: 2, lastAt: NOW }, stuck, o, NOW + 19 * MIN).send, false)
  assert.equal(alertDue({ count: 2, lastAt: NOW }, stuck, o, NOW + 20 * MIN).send, true)
  // 40 min would be next, capped to 30
  assert.equal(alertDue({ count: 3, lastAt: NOW }, stuck, o, NOW + 30 * MIN).send, true)
  assert.equal(alertDue({ count: 1, lastAt: NOW }, { state: 'working' }, o, NOW).reset, true)
  assert.equal(alertDue({ count: 1, lastAt: NOW }, { state: 'offline' }, o, NOW).reset, false)
  assert.equal(alertDue({ count: 0, lastAt: null }, stuck, { ...o, alert: false }, NOW).send, false)
})

function status (over: Partial<BotStatus> = {}): BotStatus {
  const s: Omit<BotStatus, 'summary'> = {
    version: 1, bot: 'Pax', profile: 'pax', pid: 1, updatedAt: NOW, startedAt: NOW - 60 * MIN, intervalMs: 5000, connected: true,
    state: 'stuck', trying: 'chop', why: 'chop cooling 40s after failing', blocker: 'chop: no natural tree within 32 blocks',
    doing: null, deciders: [decider({ cooling: [{ name: 'chop', until: NOW + 40_000, failures: 3 }] })], need: null, goal: null,
    progress: { at: NOW - 12 * MIN, what: 'goto ok', quietMs: 12 * MIN },
    lastFailure: { what: 'chop', message: 'no natural tree within 32 blocks', at: NOW - 30_000 },
    self: { position: { x: 1.5, y: 64, z: -3 }, dimension: 'minecraft:overworld', health: 18, food: 15 },
    alert: { count: 0, lastAt: null, nextAt: null }, stuckAlertMs: 10 * MIN, lastDisconnect: null, rssMb: 210, ...over
  }
  return { ...s, summary: chatLine(s), ...over }
}

test('alert text and chat line say what, why and how long, short enough for chat', () => {
  const s = status()
  assert.equal(alertText(s), 'Stuck for 12m: trying chop, can\'t: chop: no natural tree within 32 blocks. Say "status" for more.')
  const line = chatLine(s)
  assert.match(line, /^STUCK 12m, on chop \| can't: chop: no natural tree/)
  assert.match(line, /progress 12m ago \(goto ok\) \| hp 18 food 15$/)
  const long = status({ blocker: 'x'.repeat(500) })
  assert.ok(chatLine(long).length <= 240)
  assert.ok(alertText(long).length <= 240)
  const working = chatLine(status({ state: 'working', blocker: null, why: 'chop scored 40', doing: { action: 'chop_tree', caller: 'brain:npc', priority: 20, since: NOW - 20_000, longRunning: false } }))
  assert.match(working, /^doing chop_tree \(brain:npc, 20s\) \| why: chop scored 40/)
  assert.equal(chatLine(status({ connected: false })), 'not connected')
})

test('formatStatus prints a block, and says NOT RUNNING for a stale file', () => {
  const lines = formatStatus(status(), NOW + 1000)
  assert.match(lines[0]!, /^Pax \(profile pax\): STUCK$/)
  assert.ok(lines.some(l => /blocker\s+chop: no natural tree/.test(l)))
  assert.ok(lines.some(l => /self\s+hp 18 food 15 at 2 64 -3 \(overworld\)/.test(l)))
  assert.ok(lines.some(l => /rss 210 MB/.test(l)))
  assert.match(formatStatus(status(), NOW + 10 * MIN)[0]!, /NOT RUNNING, last update 10m ago/)
  assert.equal(fmtDuration(45_000), '45s')
  assert.equal(fmtDuration(185 * MIN), '3h 5m')
})

test('formatStatus shows the last need search and what took over', () => {
  const d = decider({
    lastSearch: { need: 'gear', at: NOW - 4 * MIN, ms: 12_000, ok: false, message: 'cut short', cut: true, by: 'pickup_items', why: 'pickup_items 41 > need:gear 30' },
    lastTakeover: { from: 'need:gear', by: 'pickup_items', why: 'pickup_items 41 > need:gear 30', at: NOW - 4 * MIN + 12_000, ranMs: 12_000 }
  })
  const lines = formatStatus(status({ deciders: [d] }), NOW + 1000)
  assert.ok(lines.some(l => /search: gear 4m ago, cut short after 12s by pickup_items \(pickup_items 41 > need:gear 30\)/.test(l)), lines.join('\n'))
  assert.ok(lines.some(l => /taken over: need:gear after 12s by pickup_items/.test(l)), lines.join('\n'))
})

// ------------------------------------------------------------------ tracker with a fake agent

function fakeAgent (dir: string) {
  const handlers = new Map<string, ((...a: any[]) => void)[]>()
  const f = {
    pos: { x: 0, y: 64, z: 0 },
    items: 0,
    online: ['Robin'],
    whispers: [] as { to: string, msg: string }[],
    current: null as ActionInfo | null,
    settings: { status: { stuckAlertMs: 600_000 } } as Record<string, unknown>,
    emit (e: string, ...a: any[]) { for (const h of handlers.get(e) ?? []) h(...a) },
    agent: null as any
  }
  f.agent = {
    username: 'Pax',
    dataDir: dir,
    owners: ['robin'],
    log: createLogger('test'),
    connected: true,
    get settings () { return f.settings },
    get currentAction () { return f.current },
    getAction: (n: string) => ({ name: n, exclusive: n !== 'pos', internal: n === 'npc_interrupt', longRunning: n === 'follow' }),
    whisper: (to: string, msg: string) => f.whispers.push({ to, msg }),
    on: (e: string, fn: (...a: any[]) => void) => handlers.set(e, [...(handlers.get(e) ?? []), fn]),
    off: (e: string, fn: (...a: any[]) => void) => handlers.set(e, (handlers.get(e) ?? []).filter(h => h !== fn)),
    adapter: {
      self: () => ({ username: 'Pax', position: { ...f.pos }, health: 20, food: 18, heldItem: null, game: { dimension: 'overworld' } }),
      inventory: () => ({ items: f.items ? [{ name: 'oak_log', label: 'oak_log', count: f.items, food: false }] : [], slots: 36 }),
      players: () => f.online
    }
  }
  return f
}

test('tracker: progress from actions, items and movement; stuck alert once with back-off; status file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'status-'))
  const f = fakeAgent(dir)
  const clock = { t: NOW }
  const tr = new StatusTracker(f.agent, { now: () => clock.t })
  tr.start()
  const failing = decider({ cooling: [{ name: 'chop', until: NOW + 1000 * MIN, failures: 3 }], lastFailure: { behavior: 'chop', message: 'no natural tree within 32 blocks', at: NOW } })
  const off = tr.addSource('npc', () => failing)

  // an action that ended ok is progress; internal and non-exclusive ones are not
  clock.t += 1000
  f.emit('actionEnd', { name: 'goto', caller: { kind: 'brain', name: 'npc' }, priority: 20 }, ok('arrived'))
  assert.equal(tr.snapshot().progress.what, 'goto ok')
  clock.t += 1000
  f.emit('actionEnd', { name: 'pos', caller: { kind: 'player', name: 'Robin' }, priority: 50 }, ok('0 64 0'))
  f.emit('actionEnd', { name: 'npc_interrupt', caller: { kind: 'brain', name: 'npc' }, priority: 20 }, ok(''))
  assert.equal(tr.snapshot().progress.at, NOW + 1000)
  // a busy/preempted result is not a failure; a real one is
  f.emit('actionEnd', { name: 'chop_tree', caller: { kind: 'brain', name: 'npc' }, priority: 20 }, fail('busy: follow (player Robin)'))
  assert.equal(tr.snapshot().lastFailure?.what, 'chop') // from the decider
  f.emit('actionEnd', { name: 'chop_tree', caller: { kind: 'brain', name: 'npc' }, priority: 20 }, fail('no axe') as ActionResult)
  assert.equal(tr.snapshot().lastFailure?.message, 'no axe')

  // items gained and moving 16 blocks count
  tr.sample()
  clock.t += 5000
  f.items = 3
  assert.equal(tr.sample().progress.what, '+3 items')
  clock.t += 5000
  f.pos = { x: 10, y: 64, z: 0 }
  assert.equal(tr.sample().progress.what, '+3 items')
  f.pos = { x: 17, y: 64, z: 0 }
  assert.equal(tr.sample().progress.what, 'moved 16+ blocks')

  // quiet for 10 minutes with a failing behaviour: one whisper to the online owner
  const quietFrom = clock.t
  clock.t = quietFrom + 9 * MIN
  assert.notEqual(tr.sample().state, 'stuck')
  clock.t = quietFrom + 10 * MIN
  const s = tr.sample()
  assert.equal(s.state, 'stuck')
  assert.equal(f.whispers.length, 1)
  assert.equal(f.whispers[0]!.to, 'Robin')
  assert.match(f.whispers[0]!.msg, /^Stuck for 10m: trying chop, can't: chop cooling .+ after failing: no natural tree within 32 blocks/)
  clock.t += 5 * MIN
  tr.sample()
  assert.equal(f.whispers.length, 1) // back-off
  clock.t += 5 * MIN
  tr.sample()
  assert.equal(f.whispers.length, 2)
  // owner offline: nothing sent, count unchanged
  f.online = []
  clock.t += 60 * MIN
  tr.sample()
  assert.equal(f.whispers.length, 2)
  // progress resets the back-off
  f.online = ['Robin']
  f.emit('actionEnd', { name: 'goto', caller: { kind: 'brain', name: 'npc' }, priority: 20 }, ok('arrived'))
  assert.equal(tr.sample().alert.count, 0)
  // alerts off: stuck but quiet
  f.settings = { status: { alert: false } }
  clock.t += 30 * MIN
  assert.equal(tr.sample().state, 'stuck')
  assert.equal(f.whispers.length, 2)

  // the file
  const file = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8')) as BotStatus
  assert.equal(file.bot, 'Pax')
  assert.equal(file.state, 'stuck')
  assert.equal(file.deciders[0]?.name, 'npc')
  off()
  assert.equal(tr.snapshot().deciders.length, 0)
  tr.stop()
  const last = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8')) as BotStatus
  assert.equal(last.state, 'offline')
  assert.equal(last.summary, 'stopped')
})

test('tracker: no file with status.file off; a new session resets the baseline', () => {
  const dir = mkdtempSync(join(tmpdir(), 'status-'))
  const f = fakeAgent(dir)
  f.settings = { status: { file: false } }
  const clock = { t: NOW }
  const tr = new StatusTracker(f.agent, { now: () => clock.t })
  tr.start()
  tr.addSource('npc', () => decider({ goal: 'build a house' }))
  clock.t += 30 * MIN
  assert.equal(tr.sample().state, 'stuck')
  f.emit('session')
  assert.equal(tr.sample().state, 'idle')
  assert.equal(existsSync(join(dir, 'status.json')), false)
  tr.stop()
  assert.equal(existsSync(join(dir, 'status.json')), false)
})

test('tracker: a long-running order is busy, the current action shows caller and time', () => {
  const f = fakeAgent(mkdtempSync(join(tmpdir(), 'status-')))
  f.settings = { status: { file: false } }
  const clock = { t: NOW }
  const tr = new StatusTracker(f.agent, { now: () => clock.t })
  tr.start()
  const info = { name: 'follow', params: { player: 'Robin' }, caller: { kind: 'player' as const, name: 'Robin' }, priority: 50 }
  f.emit('actionStart', info)
  f.current = info
  clock.t += 40 * MIN
  const s = tr.sample()
  assert.equal(s.state, 'busy')
  assert.equal(s.doing?.caller, 'player:Robin')
  assert.equal(s.doing?.since, NOW)
  assert.match(s.summary, /^doing follow \(player:Robin, 40m\)/)
  assert.equal(f.whispers.length, 0)
  tr.stop()
})

// ------------------------------------------------------------------ controller.snapshot()

test('NpcController.snapshot: running behaviour, score, then failure, cooldown and idle', async () => {
  const clock = { t: 100_000 }
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0, distanceTo: () => 0 } }, food: 20, health: 20, time: { timeOfDay: 1000 },
    entities: {}, players: {}, game: { dimension: 'overworld' }, inventory: { items: () => [], inventoryStart: 9, inventoryEnd: 45 }
  }
  let release: ((r: ActionResult) => void) | null = null
  const store = new Map<string, unknown>()
  const agent: any = {
    log: createLogger('test'),
    storage: { get: (k: string, fb?: unknown) => store.has(k) ? store.get(k) : fb, set: (k: string, v: unknown) => store.set(k, v) },
    currentAction: null,
    getAction: (n: string) => ({ name: n }),
    act: () => new Promise<ActionResult>(resolve => { release = resolve })
  }
  agent.adapter = minecraftView(bot)
  const chop: Behavior = { name: 'chop', score: () => 40, failureCooldownMs: 30_000, async run (ctx) { return ctx.act('chop_tree') } }
  const c = new NpcController(agent, bot as any, { behaviors: [chop], now: () => clock.t, autoHome: false })
  await c.tick()
  await new Promise(r => setImmediate(r))
  let s = c.snapshot()
  assert.equal(s.name, 'npc')
  assert.equal(s.behavior, 'chop')
  assert.equal(s.score, 40)
  assert.equal(s.startedAt, 100_000)
  assert.equal(s.idleSince, null)
  clock.t += 1000
  release!(fail('no natural tree within 32 blocks'))
  await c.settled()
  s = c.snapshot()
  assert.equal(s.behavior, null)
  assert.deepEqual(s.lastFailure, { behavior: 'chop', message: 'no natural tree within 32 blocks', at: 101_000 })
  assert.equal(s.cooling[0]?.name, 'chop')
  assert.equal(s.cooling[0]?.failures, 1)
  assert.match(idleReason(s, clock.t)!, /chop cooling 30s after failing: no natural tree/)
  c.stop()
})

test('assess: a behaviour running its own action reads "behaviour: action"', () => {
  const run = decider({ behavior: 'chop_wood_loop', score: 40, startedAt: NOW - MIN, priority: 20 })
  const doing = { action: 'chop_tree', caller: 'brain:npc', priority: 20, since: NOW - 10_000, longRunning: false }
  assert.equal(assess(input({ deciders: [run], doing })).trying, 'chop_wood_loop: chop_tree')
  assert.equal(assess(input({ deciders: [run], doing: { ...doing, caller: 'player:Robin' } })).trying, 'chop_tree (player:Robin)')
})

test('intents: "why are you idle" and friends ask for the status', async () => {
  const { parseIntent } = await import('../src/brains/intents/parse.ts')
  for (const line of ['why are you idle?', 'are you stuck', "what's wrong", 'why are you standing around', 'what are you doing']) {
    assert.equal(parseIntent(line, { speaker: 'Robin' })?.intent, 'status', line)
  }
  assert.notEqual(parseIntent('why did you stop?', { speaker: 'Robin' })?.intent, 'status')
})
