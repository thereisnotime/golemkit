// Base projects, game-agnostic part: settings, the queue, the next step, owner commands, goal words.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  projectsSettings, projectQueue, nextStep, applyOp, noteSession, restingReason, emptyProjectState, normalizeState, goalMentions, fmtQueue, needsOk,
  MAX_FAILS, FAIL_BACKOFF_MS, type ProjectInfo
} from '../src/core/index.ts'
import { parseProfile } from '../src/core/profile.ts'
import { findToggle, parseToggleValue } from '../src/core/toggles.ts'
import { parseIntent } from '../src/brains/intents/parse.ts'

const NOW = 1_000_000_000

const infos = (): ProjectInfo[] => [
  { name: 'walls', title: 'walls', left: 0, total: 200 },
  { name: 'floor', title: 'stone floor', left: 170, total: 170, after: ['walls'] },
  { name: 'lighting', title: 'torches', left: 3, total: 3, after: ['walls', 'floor'], small: true },
  { name: 'walkway', title: 'walkway', left: 52, total: 52, after: ['walls'] },
  { name: 'towers', title: 'towers', left: 220, total: 220 }
]

test('projects settings: defaults, overrides, false and bad values', () => {
  const d = projectsSettings(undefined)
  assert.equal(d.policy, 'auto')
  assert.equal(d.askAbove, 150)
  assert.equal(d.onTimeout, 'wait')
  assert.equal(d.template, 'fortress')
  assert.equal(d.base, null)
  assert.equal(projectsSettings(false).enabled, false)
  const s = projectsSettings({ policy: 'ask', askAbove: 'x', base: { x: 1, y: 2, z: 3, facing: 'north' }, skip: ['towers', 4] })
  assert.equal(s.policy, 'ask')
  assert.equal(s.askAbove, 150)
  assert.deepEqual(s.base, { x: 1, y: 2, z: 3, facing: 'north' })
  assert.deepEqual(s.skip, ['towers'])
  assert.equal(projectsSettings({ policy: 'maybe' }).policy, 'auto')
})

test('projects settings: profile key and live toggles', () => {
  const p = parseProfile('variant: buddy\nprojects: { policy: ask, askAbove: 80 }\n')
  assert.deepEqual((p.options.settings as Record<string, unknown>).projects, { policy: 'ask', askAbove: 80 })
  const off = parseProfile('variant: buddy\nprojects: false\n')
  assert.deepEqual((off.options.settings as Record<string, unknown>).projects, { enabled: false })
  const t = findToggle('projects.policy')!
  assert.deepEqual(parseToggleValue(t, 'off'), { ok: true, value: 'off' })
  assert.ok(findToggle('projects.paused'))
})

test('queue: done, small ones ready, big ones need an ok, after waits', () => {
  const q = projectQueue(infos(), emptyProjectState(), projectsSettings({}), NOW)
  const st = Object.fromEntries(q.map(e => [e.info.name, e.status]))
  assert.deepEqual(st, { walls: 'done', floor: 'needs_ok', lighting: 'waiting', walkway: 'ready', towers: 'needs_ok' })
  assert.match(q.find(e => e.info.name === 'lighting')!.why, /after floor/)
})

test('queue: approval, request from a goal, veto, skip, settings order and skip', () => {
  let state = emptyProjectState()
  state = applyOp(state, 'approve', 'floor', 'robin', NOW, infos().map(i => i.name)).state
  const list = infos().map(i => i.name === 'towers' ? { ...i, requestedBy: 'pe4ka' } : i)
  const q = projectQueue(list, state, projectsSettings({ order: ['towers'], skip: ['walkway'] }), NOW)
  assert.deepEqual(q.map(e => e.info.name), ['towers', 'walls', 'floor', 'lighting', 'walkway'])
  assert.equal(q[0]!.status, 'ready')
  assert.match(q[0]!.why, /pe4ka/)
  assert.equal(q.find(e => e.info.name === 'floor')!.status, 'ready')
  assert.equal(q.find(e => e.info.name === 'walkway')!.status, 'skipped')
  const v = applyOp(state, 'veto', 'floor', 'robin', NOW, infos().map(i => i.name)).state
  assert.equal(projectQueue(infos(), v, projectsSettings({}), NOW).find(e => e.info.name === 'floor')!.status, 'vetoed')
})

test('queue: policies ask and off, askAbove', () => {
  const ask = projectQueue(infos(), emptyProjectState(), projectsSettings({ policy: 'ask' }), NOW)
  assert.equal(ask.find(e => e.info.name === 'walkway')!.status, 'needs_ok')
  // small projects (bookkeeping) never need an ok
  assert.equal(needsOk({ name: 'x', title: 'x', left: 1000, total: 1000, small: true }, projectsSettings({ policy: 'ask' })), false)
  const off = projectQueue(infos(), emptyProjectState(), projectsSettings({ policy: 'off' }), NOW)
  assert.equal(off.find(e => e.info.name === 'walkway')!.status, 'planned')
  const big = projectQueue(infos(), emptyProjectState(), projectsSettings({ askAbove: 500 }), NOW)
  assert.equal(big.find(e => e.info.name === 'towers')!.status, 'ready')
})

test('queue: an unanswered ask waits, then wait / build / skip', () => {
  const state = { ...emptyProjectState(), asked: { towers: NOW - 10 * 60_000 } }
  const s = (onTimeout: string) => projectsSettings({ onTimeout, askTimeoutMinutes: 30 })
  assert.equal(projectQueue(infos(), state, s('build'), NOW).find(e => e.info.name === 'towers')!.status, 'asked')
  const late = { ...state, asked: { towers: NOW - 40 * 60_000 } }
  assert.equal(projectQueue(infos(), late, s('build'), NOW).find(e => e.info.name === 'towers')!.status, 'ready')
  assert.equal(projectQueue(infos(), late, s('skip'), NOW).find(e => e.info.name === 'towers')!.status, 'skipped')
  assert.equal(projectQueue(infos(), late, s('wait'), NOW).find(e => e.info.name === 'towers')!.status, 'needs_ok')
})

test('next step: ask first when an owner is online, then work; night and pause', () => {
  const s = projectsSettings({})
  const state = emptyProjectState()
  const q = projectQueue(infos(), state, s, NOW)
  const a = nextStep(q, state, s, { now: NOW, ownerOnline: true, night: false })
  assert.equal(a.kind, 'ask')
  assert.equal(a.kind === 'ask' && a.entry.info.name, 'floor')
  const w = nextStep(q, state, s, { now: NOW, ownerOnline: false, night: false })
  assert.equal(w.kind === 'work' && w.entry.info.name, 'walkway')
  // asked recently: not again until reaskHours
  const asked = { ...state, asked: { floor: NOW - 60_000, towers: NOW - 60_000 } }
  const q2 = projectQueue(infos(), asked, s, NOW)
  assert.equal(nextStep(q2, asked, s, { now: NOW, ownerOnline: true, night: false }).kind, 'work')
  const n = nextStep(q, state, s, { now: NOW, ownerOnline: false, night: true })
  assert.equal(n.kind, 'none')
  const indoors = projectQueue(infos().map(i => i.name === 'walkway' ? { ...i, indoors: true } : i), state, s, NOW)
  assert.equal(nextStep(indoors, state, s, { now: NOW, ownerOnline: false, night: true }).kind, 'work')
  const paused = applyOp(state, 'pause', undefined, 'robin', NOW, []).state
  const p = nextStep(q, paused, s, { now: NOW, ownerOnline: true, night: false })
  assert.equal(p.kind, 'none')
  assert.match(p.kind === 'none' ? p.why : '', /robin/)
  assert.equal(nextStep(q, state, projectsSettings({ paused: true }), { now: NOW, ownerOnline: true, night: false }).kind, 'none')
})

test('owner ops: next puts it first with an ok, skip and unskip, unknown names, reset', () => {
  const known = infos().map(i => i.name)
  let r = applyOp(emptyProjectState(), 'next', 'towers', 'robin', NOW, known)
  assert.ok(r.ok)
  assert.deepEqual(r.state.order, ['towers'])
  assert.equal(r.state.decisions.towers!.decision, 'approved')
  r = applyOp(r.state, 'skip', 'towers', 'robin', NOW, known)
  assert.deepEqual(r.state.order, [])
  assert.equal(r.state.decisions.towers!.decision, 'skipped')
  r = applyOp(r.state, 'unskip', 'towers', 'robin', NOW, known)
  assert.equal(r.state.decisions.towers, undefined)
  assert.equal(applyOp(r.state, 'approve', 'moat', 'robin', NOW, known).ok, false)
  assert.equal(applyOp(r.state, 'approve', undefined, 'robin', NOW, known).ok, false)
  const all = applyOp({ ...r.state, decisions: { floor: { decision: 'vetoed', by: 'x', at: 1 } } }, 'reset', undefined, 'robin', NOW, known)
  assert.deepEqual(all.state.decisions, {})
})

test('sessions: failures in a row rest the project, progress clears them', () => {
  let s = emptyProjectState()
  for (let i = 0; i < MAX_FAILS; i++) s = noteSession(s, 'floor', { now: NOW, message: 'no cobblestone', progressed: false, done: false })
  assert.match(restingReason(s.progress.floor, NOW + 60_000) ?? '', /trying again/)
  assert.equal(restingReason(s.progress.floor, NOW + FAIL_BACKOFF_MS + 1), null)
  s = noteSession(s, 'floor', { now: NOW, message: 'placed 40', progressed: true, done: true })
  assert.equal(s.progress.floor!.fails, 0)
  assert.equal(s.progress.floor!.doneAt, NOW)
  assert.deepEqual(normalizeState({ order: ['a', 3] }).order, ['a'])
})

test('goal words and the queue text', () => {
  const words = { floor: ['floor', 'stone floor'], towers: ['towers', 'corner towers'], walkway: ['walkway'], walls: ['walls', 'gate torches'], storage: ['chests'] }
  const got = goalMentions('Upgrade our fortress to fortress v2: stone floor, corner towers, walkway and gate torches (pe4ka asked to fix the floor)', words)
  assert.deepEqual(got.sort(), ['floor', 'towers', 'walkway', 'walls'])
  const lines = fmtQueue(projectQueue(infos(), emptyProjectState(), projectsSettings({}), NOW))
  assert.match(lines[1]!, /^2\. floor \(stone floor\) 0\/170: needs ok/)
})

test('intents: base project commands', () => {
  const p = (t: string) => parseIntent(t, { speaker: 'robin' })
  assert.deepEqual(p('projects')?.args, { op: 'list' })
  assert.deepEqual(p('plan fortress')?.args, { op: 'plan' })
  assert.deepEqual(p('build towers next')?.args, { op: 'next', name: 'towers' })
  assert.deepEqual(p('skip walkway')?.args, { op: 'skip', name: 'walkway' })
  assert.deepEqual(p('do not build the towers')?.args, { op: 'veto', name: 'towers' })
  assert.deepEqual(p('approve floor')?.args, { op: 'approve', name: 'floor' })
  assert.deepEqual(p('pause building')?.args, { op: 'pause' })
  assert.deepEqual(p('resume building')?.args, { op: 'resume' })
  // the stock build commands are unchanged
  assert.equal(p('build a tower')?.intent, 'build')
  assert.equal(p('stop chopping')?.intent, 'behavior_off')
})

test('needs layer: a sticky chore keeps the body against a passing behaviour, a plain one does not', async () => {
  const { NeedsLayer } = await import('../src/brains/npc/index.ts')
  const mem = new Map<string, unknown>()
  const agent = { storage: { get: (k: string, d?: unknown) => mem.has(k) ? mem.get(k) : d, set: (k: string, v: unknown) => { mem.set(k, v) } }, settings: { idle: { mode: 'active' } }, getAction: () => ({}) }
  const chore = (name: string, sticky: boolean) => ({ name, mode: 'active' as const, when: 'any' as const, cooldownMinutes: 1, description: name, applicable: () => true, run: async () => 'ok', sticky })
  const layer = new NeedsLayer(agent as never, { needs: [], chores: [chore('base_project', true), chore('tidy', false)] })
  const ctx = { bb: { facts: { isNight: false }, needs: { danger: 0 } }, now: NOW } as never
  const regular = [{ name: 'collect_drops', score: 22 }]
  const sticky = layer.plan(ctx, regular, 'idle:base_project')
  assert.equal(layer.lastView().fallback?.behavior, 'idle:base_project')
  assert.equal(sticky.length, 1)
  layer.plan(ctx, regular, 'idle:tidy')
  assert.equal(layer.lastView().fallback, null)
})
