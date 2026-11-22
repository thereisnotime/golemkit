import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Journal, resolveJournalConfig, parseDeathMessage, parseAdvancement, RateLimiter, InventoryTracker, DamageAggregator,
  BlockAggregator, countsDiff, buildDayRollup, filterEvents, parseRange, dayKey, dayStart, maskChat, reasonText,
  summarizeRollup, summaryInput, fmtEvent, type JournalEvent
} from '../src/core/journal/index.ts'
import { parseProfile } from '../src/core/profile.ts'
import { journal as journalSkill, fmtDeath, resolveTypes, recentEventsObservation } from '../src/skills/journal.ts'
import { standardSkills } from '../src/skills/index.ts'
import type { LlmProvider, TurnInput, TurnResult } from '../src/llm/types.ts'

const dirs: string[] = []
function tmp (): string {
  const d = mkdtempSync(join(tmpdir(), 'golemkit-journal-'))
  dirs.push(d)
  return d
}
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

// 2026-11-20 local time
const T = (h: number, m = 0, s = 0, day = 20) => new Date(2026, 10, day, h, m, s).getTime()

// ------------------------------------------------------------------ death messages

test('death messages: vanilla variants give victim, cause and killer', () => {
  const cases: [string, string, string | undefined, string | undefined][] = [
    ['Pax was slain by Zombie Villager', 'slain', 'Zombie Villager', undefined],
    ['Pax was slain by Steve using [Diamond Sword]', 'slain', 'Steve', 'Diamond Sword'],
    ['Pax was shot by Skeleton', 'shot', 'Skeleton', undefined],
    ['Pax was blown up by Creeper', 'explosion', 'Creeper', undefined],
    ['Pax blew up', 'explosion', undefined, undefined],
    ['Pax fell from a high place', 'fall', undefined, undefined],
    ['Pax hit the ground too hard whilst trying to escape Zombie', 'fall', 'Zombie', undefined],
    ['Pax fell off a ladder', 'fall', undefined, undefined],
    ['Pax hit the ground too hard while trying to escape Skeleton', 'fall', 'Skeleton', undefined],
    ['Pax was burned to a crisp while fighting Blaze', 'fire', 'Blaze', undefined],
    ['Pax was doomed to fall by Enderman', 'fall', 'Enderman', undefined],
    ['Pax drowned', 'drowning', undefined, undefined],
    ['Pax drowned whilst trying to escape Drowned', 'drowning', 'Drowned', undefined],
    ['Pax tried to swim in lava', 'lava', undefined, undefined],
    ['Pax tried to swim in lava to escape Blaze', 'lava', 'Blaze', undefined],
    ['Pax went up in flames', 'fire', undefined, undefined],
    ['Pax burned to death', 'fire', undefined, undefined],
    ['Pax walked into fire whilst fighting Husk', 'fire', 'Husk', undefined],
    ['Pax suffocated in a wall', 'suffocation', undefined, undefined],
    ['Pax starved to death', 'starvation', undefined, undefined],
    ['Pax fell out of the world', 'void', undefined, undefined],
    ['Pax was killed by magic', 'magic', undefined, undefined],
    ['Pax was killed by Witch using magic', 'magic', 'Witch', undefined],
    ['Pax was pricked to death', 'cactus', undefined, undefined],
    ['Pax withered away', 'wither', undefined, undefined],
    ['Pax was struck by lightning', 'lightning', undefined, undefined],
    ['Pax froze to death', 'freeze', undefined, undefined],
    ['Pax experienced kinetic energy', 'kinetic', undefined, undefined],
    ['Pax was squashed by a falling anvil', 'falling_block', undefined, undefined],
    ['Pax was killed by [Intentional Game Design]', 'bed_explosion', undefined, undefined],
    ['Pax was stung to death', 'sting', undefined, undefined],
    ['Pax was impaled by Drowned', 'trident', 'Drowned', undefined],
    ['Pax was fireballed by Ghast', 'fireball', 'Ghast', undefined],
    ['Pax discovered the floor was lava', 'hot_floor', undefined, undefined],
    ['Pax was obliterated by a sonically-charged shriek', 'sonic_boom', undefined, undefined],
    ['Pax died', 'generic', undefined, undefined]
  ]
  for (const [msg, cause, killer, weapon] of cases) {
    const d = parseDeathMessage(msg)
    assert.ok(d, msg)
    assert.equal(d.victim, 'Pax', msg)
    assert.equal(d.cause, cause, msg)
    assert.equal(d.killer, killer, msg)
    assert.equal(d.weapon, weapon, msg)
    assert.equal(d.message, msg)
  }
})

test('death messages: ordinary system messages are not deaths; victim filter works', () => {
  for (const msg of ['Steve joined the game', 'Pax has made the advancement [Stone Age]', 'Pax: hello', 'Server restarting in 5 minutes']) {
    assert.equal(parseDeathMessage(msg), null, msg)
  }
  assert.equal(parseDeathMessage('Steve was slain by Zombie', 'Pax'), null)
  assert.equal(parseDeathMessage('Pax was slain by Zombie', 'Pax')?.killer, 'Zombie')
  assert.equal(parseDeathMessage('§cPax was slain by Zombie')?.victim, 'Pax')
  assert.deepEqual(parseAdvancement('Pax has made the advancement [Stone Age]'), { player: 'Pax', advancement: 'Stone Age' })
  assert.equal(parseAdvancement('Pax joined the game'), null)
})

// ------------------------------------------------------------------ aggregation

test('inventory tracker: debounced net diffs, slot moves net to nothing', () => {
  const t = new InventoryTracker(2000, 15_000)
  t.reset({ oak_log: 4, bread: 2 })
  t.change({ oak_log: 5, bread: 2 }, 1000)
  t.change({ oak_log: 6, bread: 2 }, 1500)
  assert.equal(t.poll(2500), null, 'still settling')
  assert.deepEqual(t.poll(3600), { gained: { oak_log: 2 }, lost: {} })
  assert.equal(t.poll(10_000), null, 'nothing new')
  // moving items between slots: counts unchanged
  t.change({ oak_log: 6, bread: 2 }, 11_000)
  assert.equal(t.poll(14_000), null)
  // crafting: logs -> planks
  t.change({ oak_log: 5, bread: 2 }, 20_000)
  t.change({ oak_log: 5, oak_planks: 4, bread: 2 }, 20_200)
  assert.deepEqual(t.poll(23_000), { gained: { oak_planks: 4 }, lost: { oak_log: 1 } })
  // constant change still reports after maxMs
  for (let i = 0; i < 20; i++) t.change({ oak_log: 5 + i, oak_planks: 4, bread: 2 }, 30_000 + i * 1000)
  assert.ok(t.poll(30_000 + 19 * 1000)?.gained.oak_log)
  assert.deepEqual(countsDiff({ a: 1 }, { b: 2 }), { gained: { b: 2 }, lost: { a: 1 } })
})

test('damage and blocks aggregate per window', () => {
  const d = new DamageAggregator(10_000)
  d.hit('Zombie', 3, 17, 0)
  d.hit('Zombie', 2.5, 14, 2000)
  d.hit('environment', 4, 10, 3000)
  assert.deepEqual(d.poll(5000), [])
  const out = d.poll(10_000)
  assert.equal(out.length, 1)
  assert.deepEqual({ ...out[0] }, { source: 'Zombie', amount: 5.5, hits: 2, healthAfter: 14, firstAt: 0 })
  assert.equal(d.poll(0, true)[0].source, 'environment')

  const b = new BlockAggregator(30_000)
  b.add('broken', 'oak_log', { x: 1, y: 64, z: 2 }, 'overworld', 0)
  b.add('broken', 'oak_log', { x: 5, y: 65, z: 3 }, 'overworld', 100)
  b.add('broken', 'stone', { x: 40, y: 60, z: 3 }, 'overworld', 200)
  const areas = b.poll(30_200)
  assert.equal(areas.length, 2)
  assert.deepEqual(areas[0].blocks, { oak_log: 2 })
  assert.equal(areas[0].area, '8 8')
})

test('rate caps: per type per minute, drops are counted and reported once', () => {
  const r = new RateLimiter({ default: 3, chat_in: 2 })
  const m0 = 60_000 * 1000
  assert.deepEqual([1, 2, 3].map(() => r.allow('chat_in', m0)), [true, true, false])
  assert.ok(r.allow('kill', m0 + 1))
  assert.deepEqual(r.takeDropped(m0 + 10), [], 'minute not over yet')
  assert.ok(r.allow('chat_in', m0 + 60_000), 'new minute')
  assert.deepEqual(r.takeDropped(m0 + 60_001), [['chat_in', 1]])
  assert.deepEqual(r.takeDropped(m0 + 120_001), [])
})

test('journal writes JSONL per day, respects caps, types and redaction', () => {
  const dir = tmp()
  process.env.JOURNALTEST_SECRET_TOKEN = 'supersecretvalue123'
  // the log's redaction list is computed at load time, so reconfigure it
  return import('../src/core/log.ts').then(({ configureLogging }) => {
    configureLogging({})
    let now = T(10)
    const j = new Journal({ dir, settings: { journal: { caps: { chat_in: 2 }, exclude: ['player_seen'] } }, now: () => now })
    assert.ok(j.record('chat_in', { from: 'Steve', message: 'hi' }, { pos: { x: 1.7, y: 64.2, z: -3.5 }, dim: 'overworld' }))
    assert.ok(j.record('chat_in', { from: 'Steve', message: 'token supersecretvalue123' }))
    assert.equal(j.record('chat_in', { from: 'Steve', message: 'third' }), false, 'capped')
    assert.equal(j.record('player_seen', { player: 'Steve' }), false, 'excluded')
    now = T(10, 1, 1)
    j.flush()
    const lines = readFileSync(join(dir, '2026-11-20.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    assert.equal(lines.length, 3)
    assert.deepEqual(lines[0].pos, { x: 1, y: 64, z: -4 })
    assert.equal(lines[1].data.message, 'token ***')
    assert.deepEqual(lines[2], { ts: T(10, 1, 1), type: 'journal_dropped', data: { type: 'chat_in', count: 1 } })
    delete process.env.JOURNALTEST_SECRET_TOKEN

    const off = new Journal({ dir: tmp(), settings: { journal: false } })
    assert.equal(off.record('death', {}), false)
    const only = new Journal({ dir: tmp(), settings: { journal: { types: ['death'] } } })
    assert.equal(only.record('chat_in', {}), false)
    assert.ok(only.record('death', {}))
  })
})

test('config: settings, env and the profile journal block', () => {
  const c = resolveJournalConfig({ journal: { retentionDays: 3, actions: { includeStatus: true, skip: ['follow'] }, summarize: { provider: 'anthropic', model: 'm' } } }, {})
  assert.equal(c.retentionDays, 3)
  assert.ok(c.actions.includeStatus)
  assert.ok(c.actions.skip.has('follow'))
  assert.deepEqual(c.summarize, { provider: 'anthropic', options: { model: 'm' }, maxChars: 600 })
  assert.equal(resolveJournalConfig({}, {}).summarize, null, 'summary off by default')
  assert.equal(resolveJournalConfig({}, { MC_JOURNAL: 'false' }).enabled, false)
  assert.equal(resolveJournalConfig({ journal: { summarize: true }, llm: { provider: 'codex', model: 'x' } }, {}).summarize?.provider, 'codex')
  const p = parseProfile('variant: buddy\njournal:\n  retentionDays: 7\n  exclude: [player_seen]\n')
  assert.deepEqual(p.options.settings?.journal, { retentionDays: 7, exclude: ['player_seen'] })
  assert.equal(parseProfile('variant: buddy\njournal: false\n').options.settings?.journal, false)
  assert.throws(() => parseProfile('variant: buddy\njournal:\n  retentionDayz: 7\n'))
})

test('chat masking and kick reasons', () => {
  assert.equal(maskChat('/login hunter2'), '/login ***')
  assert.equal(maskChat('/register a a'), '/register ***')
  assert.equal(maskChat('hello /login x'), 'hello /login x')
  assert.equal(reasonText('{"text":"","extra":[{"text":"Server closed"}]}'), 'Server closed')
  assert.equal(reasonText({ translate: 'multiplayer.disconnect.kicked' }), 'multiplayer.disconnect.kicked')
  assert.equal(reasonText('socketClosed'), 'socketClosed')
})

// ------------------------------------------------------------------ rollups

function fixture (): JournalEvent[] {
  const ow = 'minecraft:overworld'
  return [
    { ts: T(9, 0), type: 'connect', pos: { x: 0, y: 64, z: 0 }, dim: ow, data: { server: 'x:25565' } },
    { ts: T(9, 5), type: 'action', pos: { x: 0, y: 64, z: 0 }, dim: ow, data: { name: 'chop_tree', caller: 'player:Robin', ok: true, message: 'chopped 5 oak_log', ms: 9000 } },
    { ts: T(9, 6), type: 'item_gained', pos: { x: 10, y: 64, z: 5 }, dim: ow, data: { items: { oak_log: 5 }, action: 'chop_tree' } },
    { ts: T(9, 7), type: 'block_broken', pos: { x: 10, y: 64, z: 5 }, dim: ow, data: { blocks: { oak_log: 5 }, count: 5, area: '8 8' } },
    { ts: T(9, 10), type: 'action', data: { name: 'goto', caller: 'brain:llm', ok: false, message: 'stuck at 50 64 50', ms: 60000 } },
    { ts: T(9, 11), type: 'action', data: { name: 'goto', caller: 'brain:llm', ok: false, message: 'stuck at 50 64 50', ms: 60000 } },
    { ts: T(9, 12), type: 'chat_in', data: { from: 'Robin', message: 'pax get wood' } },
    { ts: T(9, 13), type: 'chat_out', data: { message: 'on it' } },
    { ts: T(10, 2), type: 'damage', pos: { x: 100, y: 64, z: 100 }, dim: ow, data: { source: 'Zombie', amount: 6, hits: 2, healthAfter: 4 } },
    { ts: T(10, 3), type: 'death', pos: { x: 101, y: 64, z: 99 }, dim: ow, data: { cause: 'slain', killer: 'Zombie', message: 'Pax was slain by Zombie', healthBefore: 4, action: 'goto', lost: { oak_log: 5, bread: 2 }, lostCount: 7 } },
    { ts: T(10, 3, 30), type: 'respawn', pos: { x: 0, y: 64, z: 0 }, dim: ow, data: { keptInventory: false } },
    { ts: T(10, 20), type: 'item_lost', data: { items: { bread: 1 } } },
    { ts: T(10, 30), type: 'player_seen', pos: { x: 3, y: 64, z: 3 }, dim: ow, data: { player: 'Steve' } },
    { ts: T(10, 31), type: 'kill', data: { entity: 'Zombie' } },
    { ts: T(10, 40), type: 'llm_turn', data: { provider: 'anthropic', inputTokens: 1000, outputTokens: 50, ok: true } },
    { ts: T(10, 41), type: 'place_visited', pos: { x: 120, y: 70, z: 110 }, dim: ow, data: { place: 'mine' } },
    { ts: T(11, 0), type: 'disconnect', data: { reason: 'socketClosed' } }
  ]
}

test('rollup aggregation is deterministic and complete', () => {
  const evs = fixture()
  const now = T(12, 0, 0, 21)
  const a = buildDayRollup(evs, '2026-11-20', { now, bot: 'Pax' })
  const b = buildDayRollup([...evs].reverse(), '2026-11-20', { now, bot: 'Pax' })
  assert.deepEqual(a, b, 'input order does not matter')
  assert.equal(a.final, true)
  const t = a.totals
  assert.equal(t.events, 17)
  assert.equal(t.counts.action, 3)
  assert.equal(t.onlineMs, 2 * 3_600_000)
  assert.deepEqual(t.deaths, [{ ts: T(10, 3), pos: { x: 101, y: 64, z: 99 }, dim: 'minecraft:overworld', cause: 'slain', killer: 'Zombie', message: 'Pax was slain by Zombie', lost: { oak_log: 5, bread: 2 }, action: 'goto' }])
  assert.deepEqual(t.items, { gained: { oak_log: 5 }, lost: { bread: 1 }, net: { bread: -1, oak_log: 5 } })
  assert.deepEqual(t.actions, {
    total: 3, ok: 1, failed: 2,
    byName: { chop_tree: { ok: 1, failed: 0 }, goto: { ok: 0, failed: 2 } },
    topFailures: [{ action: 'goto', message: 'stuck at 50 64 50', count: 2 }]
  })
  assert.deepEqual(t.players, ['Robin', 'Steve'])
  assert.deepEqual(t.kills, { Zombie: 1 })
  assert.deepEqual(t.damage, { taken: 6, bySource: { Zombie: 6 } })
  assert.deepEqual(t.llm, { turns: 1, inputTokens: 1000, outputTokens: 50 })
  assert.deepEqual(t.chat, { in: 1, out: 1, whispers: 0 })
  // places: the tree spot, and the death + "mine" cluster (within 48 blocks)
  assert.deepEqual(t.places.map(p => [p.x, p.z, p.count, p.name]), [[111, 105, 2, 'mine'], [10, 5, 1, undefined]])
  assert.deepEqual(Object.keys(a.hours), ['09:00', '10:00', '11:00'])
  assert.equal(a.hours['09:00'].onlineMs, 3_600_000)
  assert.equal(a.hours['10:00'].onlineMs, 3_600_000)
  assert.equal(a.hours['10:00'].deaths.length, 1)
  assert.equal(a.hours['11:00'].onlineMs, 0)
  // today: an open session counts up to now
  const today = buildDayRollup(evs.slice(0, 5), '2026-11-20', { now: T(9, 30) })
  assert.equal(today.final, false)
  assert.equal(today.totals.onlineMs, 30 * 60_000)
})

test('journal rollups, retention and summaries with a fake provider', async () => {
  const dir = tmp()
  let now = T(12, 0, 0, 21)
  const j = new Journal({ dir, settings: { journal: { retentionDays: 0 } }, now: () => now, bot: 'Pax' })
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '2026-11-20.jsonl'), fixture().map(e => JSON.stringify(e)).join('\n') + '\n')
  writeFileSync(join(dir, '2026-11-21.jsonl'), JSON.stringify({ ts: T(11, 0, 0, 21), type: 'connect', data: {} }) + '\n')

  // retention never deletes a raw file without a final rollup
  assert.deepEqual(j.applyRetention().raw, [])
  assert.ok(existsSync(join(dir, '2026-11-20.jsonl')))

  const calls: TurnInput[] = []
  const fake: LlmProvider = {
    name: 'fake', billing: 'local', model: 'fake-1', needsMcp: false,
    check: async () => null,
    run: async (turn: TurnInput): Promise<TurnResult> => { calls.push(turn); return { text: '  Pax chopped oak,\n died to a zombie at 101 64 99. ' } }
  }
  j.setSummaryProvider(fake)
  j.maintain()
  // raw for the 20th rolled up and then deleted (retention 0 days), today's kept
  assert.ok(!existsSync(join(dir, '2026-11-20.jsonl')))
  assert.ok(existsSync(join(dir, '2026-11-21.jsonl')))
  const r = j.readRollup('2026-11-20')
  assert.ok(r?.final)
  await new Promise(res => setTimeout(res, 20))
  const r2 = j.readRollup('2026-11-20')!
  assert.equal(r2.summary, 'Pax chopped oak, died to a zombie at 101 64 99.')
  assert.equal(r2.summaryBy, 'fake/fake-1')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].maxTurns, 1)
  assert.deepEqual(calls[0].tools.list(), [])
  assert.ok(!calls[0].userMessage.includes('pax get wood'), 'no chat text goes to the model')
  assert.ok(calls[0].userMessage.includes('"onlineMinutes":120'))

  // deaths survive in the rollup after the raw file is gone
  const d = j.lastDeath()
  assert.equal(d?.killer, 'Zombie')
  assert.deepEqual(d?.lost, { oak_log: 5, bread: 2 })
  assert.equal(d?.itemsMayRemain, false)
  const fromRollup = j.query({ since: 'yesterday' })
  assert.deepEqual(fromRollup.map(e => e.type), ['rollup', 'death'])
  assert.ok(fromRollup.every(e => e.fromRollup))
  assert.match(j.summary('yesterday')!.text, /^yesterday: online 2h; 1 death/)
  assert.match(j.summary('yesterday')!.text, /Summary: Pax chopped oak/)

  // old rollups go too
  now = T(12, 0, 0, 21) + 400 * 86_400_000
  assert.deepEqual(j.applyRetention().rollups, ['2026-11-20'])

  // summarizeRollup on its own trims to maxChars
  const long: LlmProvider = { ...fake, run: async () => ({ text: 'x'.repeat(50) }) }
  const s = await summarizeRollup(buildDayRollup(fixture(), '2026-11-20', { now: T(1, 0, 0, 21) }), long, { maxChars: 10 })
  assert.equal(s.length, 10)
  assert.ok(summaryInput(buildDayRollup(fixture(), '2026-11-20', { now: T(1, 0, 0, 21) })).includes('"cause":"Pax was slain by Zombie"'))
})

// ------------------------------------------------------------------ queries

test('query filters: types, time, near, player, text, limit', () => {
  const evs = fixture()
  assert.deepEqual(filterEvents(evs, { types: ['death', 'kill'] }).map(e => e.type), ['death', 'kill'])
  assert.equal(filterEvents(evs, { since: T(10, 0), until: T(10, 30) }).length, 5)
  assert.deepEqual(filterEvents(evs, { near: { x: 100, z: 100, r: 5 } }).map(e => e.type), ['damage', 'death'])
  assert.deepEqual(filterEvents(evs, { near: { x: 100, y: 200, z: 100, r: 5 } }), [])
  assert.deepEqual(filterEvents(evs, { player: 'ROBIN' }).map(e => e.type), ['action', 'chat_in'])
  assert.deepEqual(filterEvents(evs, { player: 'steve' }).map(e => e.type), ['player_seen'])
  assert.deepEqual(filterEvents(evs, { text: 'STUCK' }).length, 2)
  const last2 = filterEvents(evs, { limit: 2 })
  assert.deepEqual(last2.map(e => e.type), ['place_visited', 'disconnect'])
  assert.equal(filterEvents(evs, { limit: 0 }).length, evs.length)
})

test('time ranges', () => {
  const now = T(15, 30)
  assert.deepEqual(parseRange('1h', now), { since: now - 3_600_000, until: now, label: 'last 1h' })
  assert.equal(parseRange('today', now)?.since, T(0))
  const y = parseRange('yesterday', now)!
  assert.equal(y.since, T(0, 0, 0, 19))
  assert.equal(y.until, T(0) - 1)
  assert.equal(parseRange('2026-11-18', now)?.since, T(0, 0, 0, 18))
  const hours = parseRange('10-12', now)!
  assert.equal(hours.since, T(10))
  assert.equal(hours.until, T(12))
  assert.equal(parseRange('banana', now), null)
  assert.equal(dayKey(T(23, 59)), '2026-11-20')
  assert.equal(dayStart('2026-11-20'), T(0))
})

test('journal query helpers over raw files: lastDeath, deaths, whereWas, summary of an hour range', () => {
  const dir = tmp()
  let now = T(10, 5)
  const j = new Journal({ dir, now: () => now })
  for (const e of fixture().filter(e => e.ts <= now)) j.record(e.type, e.data, { pos: e.pos, dim: e.dim, ts: e.ts })
  // unflushed events are visible too
  const d = j.lastDeath()!
  assert.equal(d.message, 'Pax was slain by Zombie')
  assert.equal(d.keptInventory, false)
  assert.equal(d.itemsMayRemain, true, '2 minutes ago')
  assert.equal(d.lostCount, 7)
  j.flush()
  now = T(10, 9)
  assert.equal(j.lastDeath()!.itemsMayRemain, false, 'over 5 minutes')
  assert.equal(j.deaths('today').length, 1)
  assert.deepEqual(j.whereWas(T(9, 8))?.pos, { x: 10, y: 64, z: 5 })
  const s = j.summary('9-10')!
  assert.match(s.text, /3 actions, 2 failed \(most: goto "stuck at 50 64 50" x2\)/)
  assert.equal(j.summary('nonsense'), null)
})

// ------------------------------------------------------------------ actions

function fakeCtx (j: Journal, settings: Record<string, unknown> = {}) {
  const agent = { journal: j, settings, username: 'Pax', serverName: 'default', get fleet (): never { throw new Error('no fleet') } }
  return { agent, bot: {}, signal: new AbortController().signal, caller: { kind: 'player', name: 'Robin' }, log: {} } as any
}

test('journal actions: compact, useful text', async () => {
  const dir = tmp()
  const now = Date.now()
  const j = new Journal({ dir })
  const ow = 'minecraft:overworld'
  j.record('chat_in', { from: 'Robin', message: 'pax where did you die' }, { ts: now - 120_000 })
  j.record('death', { cause: 'slain', killer: 'Zombie Villager', message: 'Pax was slain by Zombie Villager', lost: { iron_pickaxe: 1, oak_log: 12 }, lostCount: 13, action: 'chop_tree' }, { pos: { x: 120, y: 64, z: -30 }, dim: ow, ts: now - 60_000 })
  j.record('respawn', { keptInventory: false }, { pos: { x: 0, y: 64, z: 0 }, dim: ow, ts: now - 55_000 })
  const skill = journalSkill()
  const act = (name: string) => skill.actions!.find(a => a.name === name)!
  assert.ok(skill.actions!.every(a => a.description.length > 20))
  assert.equal(act('goto_death').exclusive, undefined, 'goto_death takes the body')
  assert.ok(act('goto_death').longRunning)
  for (const n of ['recall_events', 'last_death', 'history']) assert.equal(act(n).exclusive, false)

  const ld = await act('last_death').run(fakeCtx(j), {}) as { ok: boolean, message: string }
  assert.ok(ld.ok)
  assert.match(ld.message, /^died 1m ago at 120 64 -30: Pax was slain by Zombie Villager, while doing chop_tree\. Lost 12x oak_log, 1x iron_pickaxe\. Died 60s ago, the drops may still be there for about 240s \(goto_death\)$/)

  const params = act('recall_events').params.parse({ type: 'deaths,chat', since: '1h' })
  const re = await act('recall_events').run(fakeCtx(j), params) as { ok: boolean, message: string, data: unknown[] }
  assert.ok(re.ok)
  assert.match(re.message, /<Robin> pax where did you die; \d\d:\d\d died at 120 64 -30: Pax was slain by Zombie Villager \(lost 13 items\)$/)
  assert.equal(re.data.length, 2)
  const none = await act('recall_events').run(fakeCtx(j), act('recall_events').params.parse({ type: 'kill' })) as { message: string }
  assert.equal(none.message, 'nothing recorded last 24h for kill')
  const bad = await act('recall_events').run(fakeCtx(j), act('recall_events').params.parse({ since: 'whenever' })) as { ok: boolean }
  assert.equal(bad.ok, false)
  const near = await act('recall_events').run(fakeCtx(j), act('recall_events').params.parse({ near: '120 -30' })) as { data: unknown[] }
  assert.equal(near.data.length, 1)

  const h = await act('history').run(fakeCtx(j), act('history').params.parse({})) as { ok: boolean, message: string }
  assert.ok(h.ok)
  assert.match(h.message, /^today: .*1 death \(last 1m ago at 120 64 -30: Pax was slain by Zombie Villager\)/)

  const empty = new Journal({ dir: tmp() })
  assert.equal((await act('last_death').run(fakeCtx(empty), {}) as { message: string }).message, 'no death recorded')

  assert.deepEqual(resolveTypes('deaths, chat'), ['death', 'chat_in', 'chat_out', 'whisper'])
  assert.ok(fmtEvent({ ts: now, type: 'kill', data: { entity: 'Zombie' } }, now).endsWith('killed Zombie'))
  assert.match(fmtDeath({ ts: now - 600_000, lost: {}, lostCount: 0, itemsMayRemain: false, keptInventory: true, cause: 'fall' }, now), /Kept the inventory/)
})

test('observe line only with a context pack and journal.observe on', () => {
  const j = new Journal({ dir: tmp() })
  j.record('death', { cause: 'fall', message: 'Pax fell from a high place', lost: {}, lostCount: 0 }, { pos: { x: 1, y: 2, z: 3 }, ts: Date.now() - 600_000 })
  assert.deepEqual(recentEventsObservation({ journal: j, settings: {} }), {})
  const o = recentEventsObservation({ journal: j, settings: { context: ['/tmp/x'] } })
  assert.match(String(o.recentEvents), /^died 10m ago at 1 2 3: Pax fell from a high place$/)
  const off = new Journal({ dir: tmp(), settings: { journal: { observe: false } } })
  assert.deepEqual(recentEventsObservation({ journal: off, settings: { context: ['/tmp/x'] } }), {})
})

test('standard skills include the journal skill', () => {
  assert.ok(standardSkills().some(s => s.name === 'journal'))
})
