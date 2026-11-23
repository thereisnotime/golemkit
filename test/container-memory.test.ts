// Container memory (settings.inventoryMemory): the pure parts in src/skills/containerPlan.ts and
// the wiring in containers.ts against a hand-made bot (open, block changes, chunk loads, restarts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  memorySettings, MEMORY_DEFAULTS, freshness, fmtAge, diffContents, fmtDiff, chestPartner, chestHalves,
  ContainerBook, observeContents, checkDue, pantryLow, whereIs, fmtWhere, itemMatches, chooseGrumble, changeKind,
  prune, MAX_UNKNOWN, GRUMBLES, scopeKey, type ContainerEntry, type KV
} from '../src/skills/containerPlan.ts'
import { opened, blockChanged, chunkLoaded, containerGone, knownContainers, whereStored, OWN_CHESTS_KEY } from '../src/skills/containers.ts'
import { lowReportDue, LOW_EVERY_MS } from '../src/adapters/minecraft-java/behaviors/storage.ts'
import { unknownProfileKeys } from '../src/core/profile.ts'
import { findToggle } from '../src/core/toggles.ts'
import { parseIntent } from '../src/brains/intents/parse.ts'
import { fmtEvent } from '../src/core/journal/format.ts'
import { Vec3 } from 'vec3'

const H = 3_600_000
const entry = (e: Partial<ContainerEntry> = {}): ContainerEntry => ({ block: 'chest', contents: { bread: 12 }, at: 0, verifiedAt: 0, ...e })

test('settings: off by default, overrides, junk falls back', () => {
  assert.deepEqual(memorySettings(undefined), MEMORY_DEFAULTS)
  assert.equal(MEMORY_DEFAULTS.enabled, false)
  assert.equal(MEMORY_DEFAULTS.grumble, false)
  assert.equal(memorySettings(true).enabled, true)
  const s = memorySettings({ enabled: true, maxAgeHours: 0, refreshMinutes: 'x', grumbleTo: 'shout', lowFood: -2, grumble: true })
  assert.equal(s.maxAgeHours, 24)
  assert.equal(s.refreshMinutes, 60)
  assert.equal(s.grumbleTo, 'owners')
  assert.equal(s.lowFood, 8)
  assert.equal(s.grumble, true)
  assert.equal(memorySettings({ grumbleTo: 'say' }).grumbleTo, 'say')
})

test('settings: unknown keys warn, live toggles exist', () => {
  assert.deepEqual(unknownProfileKeys({ variant: 'companion', settings: { inventoryMemory: { enabled: true, maxAge: 3 } } }), ['settings.inventoryMemory.maxAge'])
  for (const k of ['enabled', 'maxAgeHours', 'refreshMinutes', 'indexOwn', 'grumble', 'grumbleTo', 'lowFood', 'radius', 'grumbleHours']) assert.ok(findToggle(`inventoryMemory.${k}`), k)
})

test('freshness: fact, hint (old or in doubt), unknown', () => {
  assert.equal(freshness(entry({ at: 0 }), 2 * H, 24 * H), 'fresh')
  assert.equal(freshness(entry({ at: 0 }), 25 * H, 24 * H), 'hint')
  assert.equal(freshness(entry({ at: 0, doubt: true }), 1, 24 * H), 'hint')
  assert.equal(freshness(entry({ contents: null }), 1, 24 * H), 'unknown')
  assert.equal(fmtAge(20_000), 'just now')
  assert.equal(fmtAge(5 * 60_000), '5 min ago')
  assert.equal(fmtAge(2 * H), '2 h ago')
  assert.equal(fmtAge(72 * H), '3 days ago')
})

test('diff: taken, added, formatted', () => {
  const d = diffContents({ bread: 18, apple: 2 }, { bread: 6, apple: 2, carrot: 3 })
  assert.deepEqual(d, { gone: { bread: 12 }, added: { carrot: 3 } })
  assert.equal(fmtDiff(d), '12 bread gone, 3 carrot added')
  assert.equal(fmtDiff(diffContents({}, {})), 'no change')
  const o = observeContents(entry({ at: 5 }), 'chest', { bread: 12 }, 10)
  assert.equal(o.diff, null, 'same contents: no diff')
  assert.equal(o.entry.at, 10)
  assert.equal(observeContents(null, 'chest', { bread: 1 }, 10).diff, null, 'first look: nothing to compare')
  assert.equal(observeContents(entry(), 'barrel', {}, 10).diff, null, 'another block: no diff')
})

test('double chests: partner from the block state, keyed by the lower half', () => {
  const p = { x: 10, y: 64, z: 10 }
  assert.deepEqual(chestPartner(p, 'north', 'left'), { x: 11, y: 64, z: 10 })
  assert.deepEqual(chestPartner(p, 'north', 'right'), { x: 9, y: 64, z: 10 })
  assert.deepEqual(chestPartner(p, 'east', 'left'), { x: 10, y: 64, z: 11 })
  assert.deepEqual(chestPartner(p, 'south', 'left'), { x: 9, y: 64, z: 10 })
  assert.deepEqual(chestPartner(p, 'west', 'right'), { x: 10, y: 64, z: 11 })
  assert.equal(chestPartner(p, 'north', 'single'), null)
  const a = chestHalves(p, { x: 11, y: 64, z: 10 })
  const b = chestHalves({ x: 11, y: 64, z: 10 }, p)
  assert.deepEqual(a, b)
  assert.deepEqual(a.key, p)
})

class FakeKV implements KV {
  data: Record<string, unknown> = {}
  get<T> (k: string, fb: T): T { return (k in this.data ? this.data[k] : fb) as T }
  set (k: string, v: unknown): void { this.data[k] = JSON.parse(JSON.stringify(v)) }
}

test('book: either half finds the entry, put replaces both halves, scopes apart', () => {
  const kv = new FakeKV()
  const b = new ContainerBook(kv)
  const s = scopeKey('mc:25565', 'minecraft:overworld')
  b.put(s, { x: 1, y: 64, z: 1 }, entry({ alt: '2 64 1' }))
  assert.ok(b.get(s, { x: 2, y: 64, z: 1 }))
  assert.equal(b.get(scopeKey('mc:25565', 'minecraft:the_nether'), { x: 1, y: 64, z: 1 }), null)
  // a new look keyed by the other half drops the old entry
  b.put(s, { x: 2, y: 64, z: 1 }, entry({ contents: { apple: 1 } }))
  assert.equal(b.list(s).length, 1)
  // survives a restart: a new book over the same storage
  const again = new ContainerBook(kv)
  assert.deepEqual(again.get(s, { x: 2, y: 64, z: 1 })?.entry.contents, { apple: 1 })
  assert.ok(again.drop(s, { x: 2, y: 64, z: 1 }))
  assert.equal(again.list(s).length, 0)
})

test('book: prune keeps the bounded number of unknown entries', () => {
  const s: Record<string, ContainerEntry> = {}
  for (let i = 0; i < MAX_UNKNOWN + 10; i++) s[`${i} 64 0`] = entry({ contents: null, verifiedAt: i })
  s['0 0 0'] = entry({ at: 1 })
  const p = prune(s)
  assert.equal(Object.values(p).filter(e => !e.contents).length, MAX_UNKNOWN)
  assert.ok(p['0 0 0'])
  assert.ok(!p['0 64 0'], 'the least recently seen go first')
})

test('check due: never seen, old or in doubt; nearest first', () => {
  const now = 10 * H
  const lookup = (p: { x: number }) => p.x === 1 ? entry({ at: now - 5 * 60_000 }) : p.x === 2 ? entry({ at: now - 2 * H }) : p.x === 3 ? entry({ at: now, doubt: true }) : null
  const due = checkDue([{ x: 1, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, { x: 3, y: 0, z: 0 }, { x: 40, y: 0, z: 0 }], lookup as any, now, H, { x: 0, y: 0, z: 0 })
  assert.deepEqual(due.map(p => p.x), [2, 3, 40])
})

test('pantry low', () => {
  const food = (n: string) => ['bread', 'apple'].includes(n)
  assert.deepEqual(pantryLow([{ bread: 6, cobblestone: 64 }], food, 8), { items: 6, text: 'pantry low: 6 bread left' })
  assert.equal(pantryLow([{ bread: 6 }, { apple: 4 }], food, 8), null)
  assert.equal(pantryLow([{ cobblestone: 3 }], food, 8)?.text, 'pantry low: no food left')
  assert.equal(pantryLow([{ bread: 1 }], food, 0), null, '0 = never')
  assert.equal(pantryLow([], food, 8), null, 'nothing seen: nothing to say')
})

test('where is: exact names first, fresh before old, then more', () => {
  const now = 30 * H
  const entries = [
    { pos: { x: 559, y: 69, z: -47 }, entry: entry({ contents: { iron_ingot: 12, bread: 3 }, at: now - 2 * H }) },
    { pos: { x: 1, y: 2, z: 3 }, entry: entry({ contents: { iron_ingot: 40 }, at: now - 28 * H }) },
    { pos: { x: 4, y: 5, z: 6 }, entry: entry({ contents: { raw_iron: 5 }, at: now }) }
  ]
  assert.equal(itemMatches('iron', 'raw_iron'), 1)
  assert.equal(itemMatches('iron_ingot', 'iron_ingot'), 2)
  assert.equal(itemMatches('iron ingots', 'iron_ingot'), 2)
  assert.equal(itemMatches('gold', 'iron_ingot'), 0)
  const hits = whereIs(entries, 'iron_ingot', now, 24 * H)
  assert.deepEqual(hits.map(h => h.count), [12, 40])
  assert.equal(fmtWhere(hits), '12 iron_ingot in the chest at 559 69 -47, seen 2 h ago; 40 iron_ingot in the chest at 1 2 3, seen 28 h ago (may have changed)')
  assert.equal(whereIs(entries, 'iron', now, 24 * H).length, 3, 'a word matches every kind')
  assert.equal(whereIs(entries, 'diamond', now, 24 * H).length, 0)
})

test('grumble: only when on, once per container per window, not the same line twice', () => {
  const o = { enabled: true, everyMs: 3 * H, now: 10 * H, rand: () => 0 }
  assert.equal(chooseGrumble('taken', { item: 'bread', what: '12 bread' }, { ...o, enabled: false }), null)
  assert.equal(chooseGrumble('taken', { item: 'bread', what: '12 bread' }, { ...o, lastAt: 9 * H }), null)
  const first = chooseGrumble('taken', { item: 'bread', what: '12 bread' }, o)
  assert.equal(first, 'who took my bread?!')
  assert.notEqual(chooseGrumble('taken', { item: 'bread', what: '12 bread' }, { ...o, lastAt: 6 * H, lastLine: first! }), first)
  assert.equal(chooseGrumble('gone', {}, o), GRUMBLES.gone[0])
  for (const lines of Object.values(GRUMBLES)) for (const l of lines) assert.ok(l.length < 60 && !/damn|hell|stupid|idiot/i.test(l), l)
  assert.deepEqual(changeKind({ bread: 12 }, {}, diffContents({ bread: 12 }, {})), { kind: 'emptied', item: 'bread', what: '12 bread' })
  assert.equal(changeKind({ bread: 12 }, { bread: 6 }, diffContents({ bread: 12 }, { bread: 6 }))?.kind, 'taken')
  assert.equal(changeKind({}, { bread: 6 }, diffContents({}, { bread: 6 })), null, 'added only: nothing to grumble about')
})

test('pantry-low report: every 6 h, sooner only when it ran out', () => {
  assert.equal(lowReportDue(undefined, 6, 0), true)
  assert.equal(lowReportDue({ at: 0, items: 6 }, 5, H), false)
  assert.equal(lowReportDue({ at: 0, items: 6 }, 0, H), true)
  assert.equal(lowReportDue({ at: 0, items: 6 }, 6, LOW_EVERY_MS), true)
})

test('intents: "where\'s my iron" asks the memory', () => {
  const r = parseIntent("where's my iron", { speaker: 'Tester' })
  assert.equal(r?.intent, 'find')
  assert.deepEqual(r?.args, { target: 'iron', stored: true })
  assert.equal(parseIntent('where is the village', { speaker: 'Tester' })?.args.stored, undefined)
})

test('journal: the new events read well', () => {
  assert.equal(fmtEvent({ ts: Date.now(), type: 'container_changed', data: { text: 'pantry at 1 2 3: 12 bread gone since 2 h ago' } }).replace(/^\S+ /, ''), 'pantry at 1 2 3: 12 bread gone since 2 h ago')
  assert.match(fmtEvent({ ts: Date.now(), type: 'container_gone', data: { label: 'chest at 1 2 3' }, pos: { x: 1, y: 2, z: 3 } }), /chest at 1 2 3 gone at 1 2 3/)
})

// ------------------------------------------------------------------ wiring with a hand-made bot

interface FakeBlock { name: string, position: { x: number, y: number, z: number }, getProperties (): Record<string, unknown> }

function world () {
  const blocks = new Map<string, FakeBlock>()
  const set = (x: number, y: number, z: number, name: string, props: Record<string, unknown> = {}) =>
    blocks.set(`${x} ${y} ${z}`, { name, position: { x, y, z }, getProperties: () => props })
  const bot = {
    game: { dimension: 'minecraft:overworld' },
    entity: { position: new Vec3(0, 64, 0) },
    registry: { blocksByName: { chest: { id: 1, name: 'chest' }, barrel: { id: 2, name: 'barrel' } }, foodsByName: { bread: {} } },
    blockAt: (v: { x: number, y: number, z: number }) => blocks.get(`${v.x} ${v.y} ${v.z}`) ?? null,
    findBlocks: (o: { point: { x: number, y: number, z: number } }) => [...blocks.values()].filter(b => /chest|barrel/.test(b.name)).map(b => b.position)
      .sort((a, b) => Math.hypot(a.x - o.point.x, a.z - o.point.z) - Math.hypot(b.x - o.point.x, b.z - o.point.z))
  }
  return { bot: bot as any, set, blocks }
}

function agentWith (kv: FakeKV, settings: Record<string, unknown>) {
  const events: { type: string, data: any }[] = []
  const said: string[] = []
  const agent = {
    server: { host: 'mc', port: 25565 },
    settings,
    storage: kv,
    owners: ['robin'],
    adapter: { players: () => ['Robin', 'Steve'] },
    journal: { record: (type: string, data: any) => { events.push({ type, data }); return true } },
    log: { info: () => {}, debug: () => {} },
    say: (t: string) => said.push(`say: ${t}`),
    whisper: (to: string, t: string) => said.push(`${to}: ${t}`),
    protectedAreas: { isProtected: () => false }
  }
  return { agent: agent as any, events, said }
}

const items = (c: Record<string, number>) => Object.entries(c).map(([name, count]) => ({ name, count, type: 0 }))
const ON = { inventoryMemory: { enabled: true, grumble: true }, storage: { chests: [[5, 64, 5]] } }

test('wiring: a raid on the pantry is journalled, grumbled about once, and survives a restart', () => {
  const kv = new FakeKV()
  const w = world()
  w.set(5, 64, 5, 'chest')
  const a = agentWith(kv, ON)
  const block = w.bot.blockAt({ x: 5, y: 64, z: 5 })
  opened(a.agent, w.bot, block, items({ bread: 18 }) as any, 0)
  assert.equal(a.events.length, 0, 'first look: nothing to report')
  // restart: a new agent object over the same storage still knows the pantry
  const b = agentWith(kv, ON)
  ;(b.agent as any).bot = w.bot
  const known = knownContainers(b.agent, { now: 2 * H })
  assert.equal(known.length, 1)
  assert.equal(known[0]!.freshness, 'fresh')
  assert.equal(known[0]!.ageMs, 2 * H)
  assert.equal(whereStored(b.agent, 'bread', 2 * H)[0]?.count, 18)
  opened(b.agent, w.bot, block, items({ bread: 6 }) as any, 2 * H)
  const ev = b.events.find(e => e.type === 'container_changed')
  assert.ok(ev)
  assert.equal(ev.data.text, 'pantry at 5 64 5: 12 bread gone since 2 h ago')
  assert.equal(b.said.length, 1)
  assert.match(b.said[0]!, /^Robin: /, 'owners only, by whisper')
  opened(b.agent, w.bot, block, items({}) as any, 2 * H + 60_000)
  assert.equal(b.said.length, 1, 'rate limited per container')
})

test('wiring: off = no persistence, no reports', () => {
  const kv = new FakeKV()
  const w = world()
  w.set(5, 64, 5, 'chest')
  const a = agentWith(kv, { storage: { chests: [[5, 64, 5]] } })
  const block = w.bot.blockAt({ x: 5, y: 64, z: 5 })
  opened(a.agent, w.bot, block, items({ bread: 18 }) as any, 0)
  opened(a.agent, w.bot, block, items({ bread: 1 }) as any, 1)
  assert.equal(a.events.length, 0)
  assert.equal(a.said.length, 0)
  assert.deepEqual(kv.data, {}, 'nothing in storage')
  ;(a.agent as any).bot = w.bot
  assert.equal(knownContainers(a.agent)[0]?.contents.bread, 1, 'still remembered in memory')
})

test('wiring: a chest broken in view is dropped and journalled; one moved next door is noted, not opened', () => {
  const kv = new FakeKV()
  const w = world()
  w.set(5, 64, 5, 'chest')
  const a = agentWith(kv, ON)
  ;(a.agent as any).bot = w.bot
  kv.set(OWN_CHESTS_KEY, [{ x: 5, y: 64, z: 5 }])
  opened(a.agent, w.bot, w.bot.blockAt({ x: 5, y: 64, z: 5 }), items({ bread: 4 }) as any, 0)
  // moved: the old spot is air, a chest stands two blocks over
  // the new chest shows up first (placed in view), then the old one goes
  w.set(7, 64, 5, 'chest')
  blockChanged(a.agent, w.bot, { name: 'air' } as any, w.bot.blockAt({ x: 7, y: 64, z: 5 }), H)
  w.set(5, 64, 5, 'air')
  blockChanged(a.agent, w.bot, null, w.bot.blockAt({ x: 5, y: 64, z: 5 }), H)
  const gone = a.events.find(e => e.type === 'container_gone')
  assert.ok(gone)
  assert.deepEqual(gone.data.held, { bread: 4 })
  assert.deepEqual(gone.data.movedTo, { x: 7, y: 64, z: 5 })
  assert.equal(knownContainers(a.agent).length, 0, 'the moved chest has unknown contents')
  assert.equal(knownContainers(a.agent, { includeUnknown: true })[0]?.freshness, 'unknown')
  assert.deepEqual(kv.get(OWN_CHESTS_KEY, []), [], 'no longer its own')
  assert.match(a.said[0]!, /^Robin: .*(moved|wandered)/)
})

test('wiring: a chunk load finds a remembered barrel gone; a double chest losing a half keeps the other', () => {
  const kv = new FakeKV()
  const w = world()
  w.set(40, 64, 40, 'barrel')
  w.set(1, 64, 1, 'chest', { facing: 'north', type: 'left' })
  w.set(2, 64, 1, 'chest', { facing: 'north', type: 'right' })
  const a = agentWith(kv, { inventoryMemory: { enabled: true } })
  ;(a.agent as any).bot = w.bot
  opened(a.agent, w.bot, w.bot.blockAt({ x: 40, y: 64, z: 40 }), items({ coal: 3 }) as any, 0)
  opened(a.agent, w.bot, w.bot.blockAt({ x: 2, y: 64, z: 1 }), items({ bread: 9 }) as any, 0)
  assert.equal(knownContainers(a.agent).length, 2, 'the double chest is one entry')
  assert.ok(knownContainers(a.agent).some(c => c.x === 1 && c.alt?.x === 2))
  w.set(40, 64, 40, 'stone')
  chunkLoaded(a.agent, w.bot, 2, 2, H)
  assert.equal(a.events.filter(e => e.type === 'container_gone').length, 1)
  w.set(1, 64, 1, 'air')
  w.set(2, 64, 1, 'chest', { facing: 'north', type: 'single' })
  containerGone(a.agent, w.bot, { x: 1, y: 64, z: 1 }, 'air', 'in view', H)
  const left = knownContainers(a.agent)
  assert.equal(left.length, 1)
  assert.equal(left[0]!.x, 2)
  assert.equal(left[0]!.freshness, 'hint', 'contents in doubt until it looks again')
  assert.ok(a.events.some(e => e.type === 'container_changed' && /half/.test(e.data.note)))
})

test('wiring: a container placed in view is remembered without contents', () => {
  const kv = new FakeKV()
  const w = world()
  const a = agentWith(kv, { inventoryMemory: { enabled: true } })
  ;(a.agent as any).bot = w.bot
  w.set(9, 64, 9, 'barrel')
  blockChanged(a.agent, w.bot, { name: 'air' } as any, w.bot.blockAt({ x: 9, y: 64, z: 9 }), 0)
  const k = knownContainers(a.agent, { includeUnknown: true })
  assert.equal(k.length, 1)
  assert.equal(k[0]!.freshness, 'unknown')
})

test('pantry: own and configured chests near home, the same set for the low report and the trip (plus walking range)', async () => {
  const { pantryChests, pantryReport } = await import('../src/skills/containers.ts')
  const { tripPantry } = await import('../src/skills/trip.ts')
  const kv = new FakeKV()
  const w = world()
  for (const [x, z] of [[5, 5], [10, 10], [300, 0]] as const) w.set(x, 64, z, 'chest')
  const a = agentWith(kv, ON)                      // configured: 5 64 5
  ;(a.agent as any).bot = w.bot
  kv.set('home', { x: 0, y: 64, z: 0 })
  kv.set(OWN_CHESTS_KEY, [{ x: 10, y: 64, z: 10 }, { x: 300, y: 64, z: 0 }, { x: 5, y: 64, z: 5 }])
  assert.deepEqual(pantryChests(a.agent, w.bot), [{ x: 10, y: 64, z: 10 }, { x: 5, y: 64, z: 5 }], 'own + configured within 48 of home, once each')
  opened(a.agent, w.bot, w.bot.blockAt({ x: 5, y: 64, z: 5 }), items({ bread: 2 }) as any, Date.now())
  opened(a.agent, w.bot, w.bot.blockAt({ x: 10, y: 64, z: 10 }), items({ bread: 3 }) as any, Date.now())
  opened(a.agent, w.bot, w.bot.blockAt({ x: 300, y: 64, z: 0 }), items({ bread: 30 }) as any, Date.now())
  assert.equal(pantryReport(a.agent, w.bot, 48)?.text, 'pantry low: 5 bread left', 'both near chests count, the far one does not')
  assert.deepEqual(tripPantry(w.bot, a.agent), pantryChests(a.agent, w.bot), 'at home: the whole pantry')
  w.bot.entity.position = new Vec3(200, 64, 0)
  assert.deepEqual(tripPantry(w.bot, a.agent), [], 'out of walking range; the outpost chest 100 blocks away is no pantry')
})
