// The needs layer: settings, planNeeds, pickChore, site health and the controller with a layer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { minecraftView } from './fake-attach.ts'
import { NpcController } from '../src/brains/npc/controller.ts'
import { NeedsLayer, planNeeds, searchDue, cutShort, endedBy, pickChore, inHours, windowOk, type Behavior, type NeedsProvider, type NeedInput } from '../src/brains/npc/index.ts'
import { needsSettings, idleSettings, sitesSettings, noteSiteCheck, recheckDue, SiteBook, ok, createLogger, type ActionResult, type SiteRecord } from '../src/core/index.ts'
import { parseProfile } from '../src/core/profile.ts'
import { findToggle, parseToggleValue } from '../src/core/toggles.ts'

// ------------------------------------------------------------------ settings

test('needs settings: defaults, per-need overrides, booleans and off', () => {
  const d = needsSettings(undefined)
  assert.equal(d.enabled, true)
  assert.deepEqual(d.search, { enabled: true, radius: 160, minutes: 6, cooldownMinutes: 30, retryMinutes: 5, perDay: 6, holdScore: 30, startBelow: 30, resumes: 3, atNight: false })
  assert.deepEqual(d.need('gear'), { enabled: null, threshold: 0.5, boost: 15, search: true, radius: 160, minutes: 6 })
  const s = needsSettings({ boost: 20, search: { radius: 96 }, gear: { threshold: 0.3, minutes: 3 }, rest: false })
  assert.equal(s.need('gear').threshold, 0.3)
  assert.equal(s.need('gear').radius, 96)
  assert.equal(s.need('gear').minutes, 3)
  assert.equal(s.need('gear').boost, 20)
  assert.equal(s.need('rest').enabled, false)
  assert.equal(needsSettings(false).enabled, false)
})

test('idle settings: a mode string, chores as booleans or options, bad values fall back', () => {
  assert.equal(idleSettings(undefined).mode, 'idle')
  assert.equal(idleSettings('active').mode, 'active')
  const s = idleSettings({ mode: 'explore', radius: 30, chores: { scout_nearby: false, light_dark_spots: { hours: [8, 16], radius: 12 } } })
  assert.equal(s.mode, 'explore')
  assert.equal(s.chore('scout_nearby').enabled, false)
  assert.deepEqual(s.chore('light_dark_spots').hours, [8, 16])
  assert.equal(s.chore('light_dark_spots').radius, 12)
  assert.equal(s.chore('stroll').enabled, null)
  assert.equal(idleSettings({ mode: 'party' }).mode, 'idle')
  assert.equal(sitesSettings(undefined).failures, 3)
  assert.equal(sitesSettings(false).enabled, false)
})

test('profile keys needs, idle and sites land in settings; the toggles parse', () => {
  const p = parseProfile('variant: buddy\nneeds: { gear: { threshold: 0.4 } }\nidle: active\nsites: { failures: 2 }\n')
  assert.deepEqual(p.options.settings!.needs, { gear: { threshold: 0.4 } })
  assert.deepEqual(p.options.settings!.idle, { mode: 'active' })
  assert.deepEqual(p.options.settings!.sites, { failures: 2 })
  assert.throws(() => parseProfile('variant: buddy\nidle: { mode: party }\n'))
  const t = findToggle('idle.chores.scout_nearby')!
  assert.deepEqual(parseToggleValue(t, 'off'), { ok: true, value: false })
  assert.deepEqual(parseToggleValue(findToggle('idle.mode')!, 'explore'), { ok: true, value: 'explore' })
  assert.equal(parseToggleValue(findToggle('needs.gear.threshold')!, '2').ok, false)
})

// ------------------------------------------------------------------ planNeeds

const need = (name: string, urgency: number, servedBy: string[], extra: Partial<NeedInput> = {}): NeedInput =>
  ({ name, urgency, active: true, threshold: 0.5, boost: 15, servedBy, canSearch: false, ...extra })

test('planNeeds boosts behaviours serving an urgent need, never into the urgent band', () => {
  const p = planNeeds([need('food', 0.6, ['farm_setup', 'keep_fed'])], [{ name: 'farm_setup', score: 28 }, { name: 'keep_fed', score: 0 }, { name: 'wander', score: 10 }])
  assert.equal(p.scores.find(s => s.name === 'farm_setup')!.score, 37)
  assert.equal(p.scores.find(s => s.name === 'keep_fed')!.score, 0, 'a behaviour at 0 stays at 0')
  assert.deepEqual(Object.keys(p.boosted), ['farm_setup'])
  assert.equal(p.quiet, false)
  const high = planNeeds([need('safety', 1, ['stay_safe'])], [{ name: 'stay_safe', score: 75 }])
  assert.equal(high.scores[0]!.score, 79)
  const below = planNeeds([need('food', 0.4, ['farm_setup'])], [{ name: 'farm_setup', score: 28 }])
  assert.equal(below.scores[0]!.score, 28, 'below the threshold: no boost')
  assert.deepEqual(below.top, { name: 'food', urgency: 0.4 })
})

test('planNeeds searches only when quiet, for an urgent need nothing serves', () => {
  const gear = need('gear', 0.6, ['keep_tools_upgraded'], { canSearch: true })
  assert.equal(planNeeds([gear], [{ name: 'keep_tools_upgraded', score: 0 }, { name: 'wander', score: 10 }]).search, 'gear')
  assert.equal(planNeeds([gear], [{ name: 'keep_tools_upgraded', score: 28 }]).search, null, 'its behaviour can still do something')
  assert.equal(planNeeds([gear], [{ name: 'keep_tools_upgraded', score: 0 }, { name: 'chop_wood_loop', score: 30 }]).search, null, 'not quiet')
  assert.equal(planNeeds([{ ...gear, canSearch: false }], []).search, null)
  assert.equal(planNeeds([{ ...gear, active: false }], []).search, null)
})

test('searchDue: cooldown per need and a daily cap', () => {
  const now = 10 * 86_400_000
  const o = { cooldownMinutes: 30, perDay: 2 }
  assert.equal(searchDue([], 'gear', now, o), true)
  assert.equal(searchDue([{ need: 'gear', at: now - 10 * 60_000 }], 'gear', now, o), false)
  assert.equal(searchDue([{ need: 'food', at: now - 10 * 60_000 }], 'gear', now, o), true)
  assert.equal(searchDue([{ need: 'gear', at: now - 5 * 3_600_000 }, { need: 'gear', at: now - 3_600_000 }], 'gear', now, o), false)
  assert.equal(searchDue([{ need: 'gear', at: now - 3_600_000 }], 'gear', now, { cooldownMinutes: 30, perDay: 0 }), false)
})

test('searchDue: a search cut short only waits retryMinutes and does not use up the day', () => {
  const now = 10 * 86_400_000
  const o = { cooldownMinutes: 30, perDay: 6, retryMinutes: 5 }
  // Pax: six gear searches taken over after 3 to 17 s, then a whole day of nothing but the idle scout
  const cut = [6, 5, 4, 3, 2, 1].map(h => ({ need: 'gear', at: now - h * 3_600_000, cut: true, message: 'replaced' }))
  assert.equal(searchDue(cut, 'gear', now, o), true)
  assert.equal(searchDue([...cut, { need: 'gear', at: now - 2 * 60_000, cut: true, message: 'replaced' }], 'gear', now, o), false, 'retry gap')
  assert.equal(searchDue([...cut, { need: 'gear', at: now - 6 * 60_000, cut: true, message: 'replaced' }], 'gear', now, o), true)
  // a 'started' left behind by a restart is cut short once it is old
  assert.equal(searchDue([{ need: 'gear', at: now - 2 * 3_600_000, message: 'started' }], 'gear', now, o), true)
  assert.equal(searchDue([{ need: 'gear', at: now - 10 * 60_000, message: 'started' }], 'gear', now, o), false)
  // real searches still count
  const real = [6, 5, 4, 3, 2, 1].map(h => ({ need: 'gear', at: now - h * 3_600_000, message: 'nothing found' }))
  assert.equal(searchDue(real, 'gear', now, o), false)
})

test('searchDue: a search cut because the body was taken may start again at once, a few times per cooldown', () => {
  const now = 10 * 86_400_000
  const o = { cooldownMinutes: 30, perDay: 6, retryMinutes: 5, resumes: 3 }
  const yielded = (minAgo: number) => ({ need: 'gear', at: now - minAgo * 60_000, cut: true, resume: true, message: 'cut short' })
  assert.equal(searchDue([yielded(1)], 'gear', now, o), true, 'the eat reflex ended it a minute ago: back to it')
  assert.equal(searchDue([yielded(9), yielded(6), yielded(1)], 'gear', now, o), true)
  assert.equal(searchDue([yielded(12), yielded(9), yielded(6), yielded(1)], 'gear', now, o), false, 'the fourth in a cooldown waits retryMinutes')
  assert.equal(searchDue([yielded(1)], 'gear', now, { ...o, resumes: 0 }), false, 'resumes 0: the old retry gap')
  // taken over by other work: the retry gap as before
  assert.equal(searchDue([{ need: 'gear', at: now - 60_000, cut: true, message: 'cut short' }], 'gear', now, o), false)
})

test('endedBy: the behaviour that replaced a search, or the caller that took the body', () => {
  const ac = new AbortController()
  ac.abort('replaced by pickup_items (pickup_items 41 > need:gear 30)')
  assert.deepEqual(endedBy(new Error('aborted'), ac.signal), { by: 'pickup_items', why: 'pickup_items 41 > need:gear 30' })
  const y = Object.assign(new Error('body taken'), { name: 'NpcYield', holder: 'reflex:reflexes', action: 'eat' })
  assert.deepEqual(endedBy(y), { by: 'reflex:reflexes (eat)', why: 'the body was taken', resume: true })
  const ac2 = new AbortController()
  ac2.abort('yield to player:Robin (follow)')
  assert.deepEqual(endedBy(new Error('x'), ac2.signal), { by: 'player:Robin (follow)', why: 'the body was taken', resume: true })
  assert.equal(endedBy(new Error('boom')), null)
})

test('cutShort: taken over or thrown in the first minute', () => {
  assert.equal(cutShort(null, 3000), true)
  assert.equal(cutShort({ ok: false, message: 'replaced' }, 3600), true)
  assert.equal(cutShort({ ok: false, message: 'preempted by reflex' }, 17_000), true)
  assert.equal(cutShort({ ok: false, message: 'nothing in sight within 160 blocks' }, 3000), false)
  assert.equal(cutShort({ ok: false, message: 'replaced' }, 5 * 60_000), false)
  assert.equal(cutShort(null, 5 * 60_000), false)
  assert.equal(cutShort({ ok: false, message: 'not ready for a trip: health 7/20', data: { retry: true } }, 6000), true, 'could not start')
})

// ------------------------------------------------------------------ pickChore

const chores = [
  { name: 'look_around', mode: 'passive' as const, when: 'any' as const, cooldownMinutes: 0 },
  { name: 'stroll', mode: 'idle' as const, when: 'day' as const, cooldownMinutes: 2 },
  { name: 'tidy', mode: 'active' as const, when: 'day' as const, cooldownMinutes: 10 },
  { name: 'wood', mode: 'active' as const, when: 'day' as const, cooldownMinutes: 10 },
  { name: 'explore', mode: 'explore' as const, when: 'day' as const, cooldownMinutes: 20 }
]
const base = { isNight: false, hour: 12, now: 1_000_000, last: {}, setting: (n: string) => idleSettings({}).chore(n), applicable: () => true }

test('pickChore: the mode decides which chores are in, higher modes first', () => {
  assert.equal(pickChore(chores, { ...base, mode: 'off' }), null)
  assert.equal(pickChore(chores, { ...base, mode: 'passive' })?.name, 'look_around')
  assert.equal(pickChore(chores, { ...base, mode: 'idle' })?.name, 'stroll')
  assert.equal(pickChore(chores, { ...base, mode: 'active' })?.name, 'tidy')
  assert.equal(pickChore(chores, { ...base, mode: 'explore' })?.name, 'explore')
})

test('pickChore: least recently run, cooldowns, applicability, settings and windows', () => {
  const now = base.now
  assert.equal(pickChore(chores, { ...base, mode: 'active', last: { tidy: now - 20 * 60_000, wood: now - 30 * 60_000 } })?.name, 'wood')
  assert.equal(pickChore(chores, { ...base, mode: 'active', last: { tidy: now - 60_000, wood: now - 60_000 } })?.name, 'stroll', 'both cooling down')
  assert.equal(pickChore(chores, { ...base, mode: 'active', applicable: (n) => n !== 'tidy' })?.name, 'wood')
  const off = idleSettings({ chores: { tidy: false, wood: { hours: [14, 18] } } })
  assert.equal(pickChore(chores, { ...base, mode: 'active', setting: (n) => off.chore(n) })?.name, 'stroll')
  assert.equal(pickChore(chores, { ...base, mode: 'active', isNight: true })?.name, 'look_around', 'day chores wait for the day')
  assert.equal(inHours(23, [22, 4]), true)
  assert.equal(inHours(12, [22, 4]), false)
  assert.equal(windowOk('night', null, false, 12), false)
})

// ------------------------------------------------------------------ site health

test('noteSiteCheck: hard faults at once, soft ones after N in a row, ok clears', () => {
  const ref = { kind: 'farm', id: 'farm:1', pos: { x: 561, y: 62, z: -20 } }
  const o = { failures: 3 }
  const flooded = noteSiteCheck(undefined, ref, { ok: false, fault: 'flooded', reason: '60 of 80 cells are ice' }, 1000, o)
  assert.equal(flooded.change, 'bad')
  assert.equal(flooded.record.status, 'bad')
  let r: SiteRecord | undefined
  for (let i = 0; i < 2; i++) {
    const n = noteSiteCheck(r, ref, { ok: false, fault: 'unreachable', reason: 'no path' }, 1000 + i, o)
    assert.equal(n.change, null)
    r = n.record
  }
  const third = noteSiteCheck(r, ref, { ok: false, fault: 'unreachable', reason: 'no path' }, 2000, o)
  assert.equal(third.change, 'bad')
  const okAgain = noteSiteCheck(third.record, ref, { ok: true }, 3000, o)
  assert.equal(okAgain.change, 'recovered')
  assert.equal(okAgain.record.strikes, 0)
  assert.equal(okAgain.record.reason, undefined)
  const reset = noteSiteCheck(noteSiteCheck(undefined, ref, { ok: false, fault: 'no_work', reason: 'x' }, 0, o).record, ref, { ok: true }, 1, o)
  assert.equal(reset.record.strikes, 0)
  assert.equal(reset.change, null)
})

test('recheckDue waits recheckHours after it went bad or was last re-checked', () => {
  const rec: SiteRecord = { kind: 'farm', id: 'farm:1', status: 'bad', strikes: 1, checkedAt: 0, badAt: 0 }
  assert.equal(recheckDue(rec, 5 * 3_600_000, { recheckHours: 6 }), false)
  assert.equal(recheckDue(rec, 7 * 3_600_000, { recheckHours: 6 }), true)
  assert.equal(recheckDue({ ...rec, recheckedAt: 6.5 * 3_600_000 }, 7 * 3_600_000, { recheckHours: 6 }), false)
  assert.equal(recheckDue({ ...rec, status: 'ok' }, 99 * 3_600_000, { recheckHours: 6 }), false)
})

// ------------------------------------------------------------------ the controller with a layer

function fake (actions: string[]) {
  const store = new Map<string, unknown>([['home', { x: 0, y: 64, z: 0 }]])
  const calls: { name: string, params: unknown }[] = []
  const whispers: [string, string][] = []
  const clock = { t: 10 * 86_400_000 }
  const settings: Record<string, unknown> = {}
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0, distanceTo: () => 0 } },
    food: 20,
    health: 20,
    time: { timeOfDay: 1000 },
    entities: {},
    players: {},
    game: { dimension: 'overworld' },
    inventory: { items: () => [], inventoryStart: 9, inventoryEnd: 45 }
  }
  const agent: any = {
    log: createLogger('test'),
    username: 'Bot',
    owners: ['Robin'],
    settings,
    storage: { get: (k: string, fb?: unknown) => store.has(k) ? store.get(k) : fb, set: (k: string, v: unknown) => store.set(k, v), delete: (k: string) => store.delete(k) },
    currentAction: null,
    getAction: (n: string) => [...actions, 'npc_interrupt'].includes(n) ? { name: n } : undefined,
    whisper: (to: string, text: string) => { whispers.push([to, text]) },
    act (name: string, params: unknown): Promise<ActionResult> { calls.push({ name, params }); return Promise.resolve(ok('done')) }
  }
  agent.adapter = minecraftView(bot)
  agent.adapter.players = () => ['Robin', 'Bot']
  return { agent, bot, calls, clock, settings, store, whispers }
}

const flush = () => new Promise(r => setImmediate(r))

function provider (o: { urgency: { v: number }, cells?: { v: 'ok' | 'flooded' } }): NeedsProvider {
  return {
    needs: [{
      name: 'gear',
      servedBy: ['tools'],
      urgency: () => o.urgency.v,
      search: { what: 'iron', requires: ['find_target'], run: async (ctx) => ctx.act('find_target', { target: 'iron' }) }
    }],
    chores: [
      { name: 'stroll', mode: 'idle', when: 'any', cooldownMinutes: 2, description: 'walk', requires: ['wander'], applicable: () => true, run: (ctx) => ctx.act('wander', {}) },
      { name: 'tidy', mode: 'active', when: 'any', cooldownMinutes: 10, description: 'tidy', requires: ['deposit'], applicable: () => true, run: (ctx) => ctx.act('deposit', {}) }
    ],
    sites: [{
      kind: 'farm',
      list: () => [{ kind: 'farm', id: 'farm:1', pos: { x: 5, y: 63, z: 5 }, label: 'my farm farm:1' }],
      check: () => o.cells?.v === 'flooded' ? { ok: false, fault: 'flooded', reason: 'all ice' } : { ok: true },
      onBad: (_ctx, _rec, replace) => replace ? 'dropped it' : undefined
    }]
  }
}

function setup (score: { v: number }, urgency: { v: number }, extra: { cells?: { v: 'ok' | 'flooded' } } = {}) {
  const f = fake(['wander', 'deposit', 'find_target'])
  const tools: Behavior = { name: 'tools', score: () => score.v, run: async () => 'ok' }
  const layer = new NeedsLayer(f.agent, provider({ urgency, ...extra }), { now: () => f.clock.t })
  const c = new NpcController(f.agent, f.bot as any, { behaviors: [tools], needs: layer, now: () => f.clock.t, autoHome: false })
  return { f, c, layer }
}

test('controller: an urgent need with nothing in sight runs its search, then it waits out the cooldown', async () => {
  const { f, c, layer } = setup({ v: 0 }, { v: 0.7 })
  f.settings.needs = { gear: { enabled: true } }
  await c.tick()
  await flush(); await flush()
  assert.deepEqual(f.calls.map(x => x.name), ['find_target'])
  const snap = c.snapshot()
  assert.equal(snap.need, 'gear')
  assert.equal(snap.needUrgency, 0.7)
  assert.ok(snap.lastProgressAt)
  assert.equal(layer.searchHistory().at(-1)?.ok, true)
  // ten minutes later: still on its cooldown, so the idle chore runs instead
  f.clock.t += 10 * 60_000
  await c.tick()
  await flush(); await flush()
  assert.equal(f.calls.at(-1)?.name, 'wander')
  c.stop()
})

test('controller: a gear search taken over in its first seconds keeps its full radius and runs again after the retry gap', async () => {
  const f = fake(['wander', 'deposit', 'find_target'])
  const score = { v: 0 }
  const tools: Behavior = { name: 'tools', score: () => 0, run: async () => 'ok' }
  const chores: Behavior = { name: 'farm', score: () => score.v, run: async (ctx) => { await ctx.act('deposit', {}); return 'ok' } }
  let release: (() => void) | null = null
  const radii: number[] = []
  const prov = provider({ urgency: { v: 0.7 } })
  prov.needs[0]!.search!.run = async (ctx, o) => {
    radii.push(o.radius)
    await new Promise<void>(res => { release = res; ctx.signal.addEventListener('abort', () => res()) })
    ctx.signal.throwIfAborted()
    return ok('found')
  }
  const layer = new NeedsLayer(f.agent, prov, { now: () => f.clock.t })
  const c = new NpcController(f.agent, f.bot as any, { behaviors: [tools, chores], needs: layer, now: () => f.clock.t, autoHome: false })
  f.settings.needs = { gear: { enabled: true } }
  await c.tick(); await flush()
  assert.deepEqual(radii, [160])
  // farm work takes over 4 s in
  f.clock.t += 4000
  score.v = 40
  await c.tick(); await flush(); await flush()
  const last = layer.searchHistory().at(-1)
  assert.equal(last?.cut, true, JSON.stringify(last))
  score.v = 0
  await c.tick(); await flush()
  assert.equal(radii.length, 1, 'waits the retry gap')
  f.clock.t += 6 * 60_000
  await c.tick(); await flush()
  assert.deepEqual(radii, [160, 160])
  ;(release as (() => void) | null)?.()
  c.stop()
})

test('controller: a running search holds against passing work (holdScore), says what took over, and the status shows it', async () => {
  const f = fake(['wander', 'deposit', 'find_target'])
  const score = { v: 0 }
  const tools: Behavior = { name: 'tools', score: () => 0, run: async () => 'ok' }
  const drops: Behavior = { name: 'pickup_items', score: () => score.v, run: async () => 'ok' }
  const prov = provider({ urgency: { v: 0.7 } })
  let aborted = false
  prov.needs[0]!.search!.run = async (ctx) => {
    await new Promise<void>(res => { ctx.signal.addEventListener('abort', () => { aborted = true; res() }) })
    ctx.signal.throwIfAborted()
    return ok('done')
  }
  const layer = new NeedsLayer(f.agent, prov, { now: () => f.clock.t })
  const c = new NpcController(f.agent, f.bot as any, { behaviors: [tools, drops], needs: layer, now: () => f.clock.t, autoHome: false })
  f.settings.needs = { gear: { enabled: true } }
  await c.tick(); await flush()
  assert.equal(c.snapshot().behavior, 'need:gear')
  // drops to pick up (22), a farm chore (30): below 30 + the switch margin, the search keeps going
  for (const v of [22, 30, 39]) {
    score.v = v
    f.clock.t += 5000
    await c.tick(); await flush()
    assert.equal(c.snapshot().behavior, 'need:gear', `work at ${v} does not end it`)
  }
  assert.equal(aborted, false)
  score.v = 45
  f.clock.t += 5000
  await c.tick(); await flush(); await flush()
  assert.equal(aborted, true, 'work at 45 does')
  const last = layer.searchHistory().at(-1)!
  assert.equal(last.cut, true)
  assert.equal(last.by, 'pickup_items')
  assert.match(last.why ?? '', /pickup_items 45 > need:gear 30/)
  const snap = c.snapshot()
  assert.equal(snap.lastTakeover?.from, 'need:gear')
  assert.equal(snap.lastTakeover?.by, 'pickup_items')
  assert.equal(snap.lastSearch?.by, 'pickup_items')
  c.stop()
})

test('controller: holdScore 0 gives the old rule (any work above the idle band ends a search)', async () => {
  const f = fake(['wander', 'deposit', 'find_target'])
  const score = { v: 0 }
  const tools: Behavior = { name: 'tools', score: () => 0, run: async () => 'ok' }
  const drops: Behavior = { name: 'pickup_items', score: () => score.v, run: async () => 'ok' }
  const prov = provider({ urgency: { v: 0.7 } })
  prov.needs[0]!.search!.run = async (ctx) => {
    await new Promise<void>(res => { ctx.signal.addEventListener('abort', () => res()) })
    ctx.signal.throwIfAborted()
    return ok('done')
  }
  const layer = new NeedsLayer(f.agent, prov, { now: () => f.clock.t })
  const c = new NpcController(f.agent, f.bot as any, { behaviors: [tools, drops], needs: layer, now: () => f.clock.t, autoHome: false })
  f.settings.needs = { gear: { enabled: true }, search: { holdScore: 0 } }
  await c.tick(); await flush()
  score.v = 22
  f.clock.t += 5000
  await c.tick(); await flush(); await flush()
  assert.equal(c.snapshot().lastTakeover?.by, 'pickup_items')
  assert.equal(layer.searchHistory().at(-1)?.by, 'pickup_items')
  c.stop()
})

test('controller: a search the eat reflex interrupts starts again after the back-off, not 5 minutes later', async () => {
  const f = fake(['wander', 'deposit', 'find_target'])
  const tools: Behavior = { name: 'tools', score: () => 0, run: async () => 'ok' }
  const prov = provider({ urgency: { v: 0.7 } })
  let runs = 0
  prov.needs[0]!.search!.run = async (ctx) => {
    runs++
    if (runs === 1) {
      // the reflex takes the body while the search walks
      f.agent.currentAction = { name: 'eat', params: {}, caller: { kind: 'reflex', name: 'reflexes' }, priority: 90 }
      return ctx.act('find_target', {})
    }
    return ok('found')
  }
  const layer = new NeedsLayer(f.agent, prov, { now: () => f.clock.t })
  const c = new NpcController(f.agent, f.bot as any, { behaviors: [tools], needs: layer, now: () => f.clock.t, autoHome: false })
  f.settings.needs = { gear: { enabled: true } }
  await c.tick(); await flush(); await flush(); await flush()
  const cut = layer.searchHistory().at(-1)!
  assert.equal(cut.cut, true)
  assert.equal(cut.resume, true)
  assert.equal(cut.by, 'reflex:reflexes (eat)')
  f.agent.currentAction = null
  f.clock.t += 4000 // past the 3 s reflex back-off
  await c.tick(); await flush(); await flush()
  assert.equal(runs, 2, 'back to the search')
  c.stop()
})

test('controller: a committed search (down its mine) keeps the body against ordinary work, not against danger', async () => {
  const f = fake(['wander', 'deposit', 'find_target'])
  const score = { v: 0 }
  const tools: Behavior = { name: 'tools', score: () => 0, run: async () => 'ok' }
  const work: Behavior = { name: 'chop', score: () => score.v, run: async () => 'ok' }
  const prov = provider({ urgency: { v: 0.7 } })
  const state = { committed: false }
  let aborted = false
  prov.needs[0]!.search!.committed = () => state.committed
  prov.needs[0]!.search!.run = async (ctx) => {
    await new Promise<void>(res => { ctx.signal.addEventListener('abort', () => { aborted = true; res() }) })
    ctx.signal.throwIfAborted()
    return ok('done')
  }
  const layer = new NeedsLayer(f.agent, prov, { now: () => f.clock.t })
  const c = new NpcController(f.agent, f.bot as any, { behaviors: [tools, work], needs: layer, now: () => f.clock.t, autoHome: false })
  f.settings.needs = { gear: { enabled: true } }
  await c.tick(); await flush()
  assert.equal(c.snapshot().behavior, 'need:gear')
  state.committed = true
  score.v = 38
  f.clock.t += 2000
  await c.tick(); await flush()
  assert.equal(c.snapshot().behavior, 'need:gear', 'chopping wood does not pull it out of the mine')
  assert.equal(aborted, false)
  score.v = 85
  f.clock.t += 2000
  await c.tick(); await flush(); await flush()
  assert.equal(aborted, true, 'danger does')
  c.stop()
})

test('controller: a need that is automatic stays off without its behaviour; boosts reach the serving behaviour', async () => {
  const f = fake(['wander', 'find_target'])
  const layer = new NeedsLayer(f.agent, provider({ urgency: { v: 0.9 } }), { now: () => f.clock.t })
  const other: Behavior = { name: 'other', score: () => 0, run: async () => 'ok' }
  const c = new NpcController(f.agent, f.bot as any, { behaviors: [other], needs: layer, now: () => f.clock.t, autoHome: false })
  await c.tick()
  await flush()
  assert.notEqual(f.calls[0]?.name, 'find_target', 'gear is automatic and nothing serving it is in the set')
  c.stop()
  const s = setup({ v: 28 }, { v: 0.6 })
  await s.c.tick()
  assert.equal(s.c.snapshot().behavior, 'tools')
  assert.match(s.c.snapshot().reason ?? '', /boosted \+9 for the gear need/)
  const st = s.c.status() as { scores: { name: string, score: number }[] }
  assert.equal(st.scores.find(x => x.name === 'tools')?.score, 37)
  s.c.stop()
})

test('controller: idle modes off, idle and active', async () => {
  const { f, c } = setup({ v: 0 }, { v: 0 })
  f.settings.idle = { mode: 'off' }
  await c.tick(); await flush()
  assert.equal(f.calls.length, 0)
  f.settings.idle = { mode: 'active' }
  await c.tick(); await flush(); await flush()
  assert.equal(f.calls.at(-1)?.name, 'deposit')
  f.clock.t += 60_000
  await c.tick(); await flush(); await flush()
  assert.equal(f.calls.at(-1)?.name, 'wander', 'tidy is cooling down, the idle chore runs')
  assert.ok(c.behaviors().some(b => b.name === 'idle:tidy'))
  c.stop()
})

test('site health through the layer: a flooded farm is marked bad, replaced and the owner is told; a later re-check brings it back', async () => {
  const cells = { v: 'flooded' as 'ok' | 'flooded' }
  const { f, c } = setup({ v: 0 }, { v: 0 }, { cells })
  f.agent.inSession = true
  await c.tick()
  const book = new SiteBook(f.agent)
  const rec = book.get('farm', 'farm:1')!
  assert.equal(rec.status, 'bad')
  assert.equal(rec.fault, 'flooded')
  assert.equal(rec.handled, 'dropped it')
  assert.equal(f.whispers.length, 1)
  assert.match(f.whispers[0]![1], /my farm farm:1 at 5 63 5 is no good: all ice; dropped it/)
  // fixed by a player; re-checked after recheckHours only
  cells.v = 'ok'
  f.clock.t += 60_000
  await c.tick()
  assert.equal(book.get('farm', 'farm:1')!.status, 'bad')
  f.clock.t += 7 * 3_600_000
  await c.tick()
  assert.equal(book.get('farm', 'farm:1')!.status, 'ok')
  assert.match(f.whispers.at(-1)![1], /looks fine again/)
  c.stop()
})

test('needs.search.startBelow: a search starts while upkeep scores at or below it', () => {
  // Pax never started a gear search for 16 hours: chop_wood_loop (30) kept it from being quiet
  const gear = need('gear', 0.6, ['keep_tools_upgraded'], { canSearch: true })
  const upkeep = [{ name: 'keep_tools_upgraded', score: 0 }, { name: 'chop_wood_loop', score: 30 }]
  assert.equal(planNeeds([gear], upkeep).search, null)
  assert.equal(planNeeds([gear], upkeep, { searchStartBelow: 30 }).search, 'gear')
  assert.equal(planNeeds([gear], [...upkeep, { name: 'deposit_when_full', score: 45 }], { searchStartBelow: 30 }).search, null)
  // a serving behaviour that can still act goes first
  assert.equal(planNeeds([gear], [{ name: 'keep_tools_upgraded', score: 28 }], { searchStartBelow: 30 }).search, null)
})
