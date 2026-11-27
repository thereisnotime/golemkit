// Pax stood still under nine phantoms and took about ten hits: it had not been in a bed for days and
// only fought back after each hit, when the phantom was already climbing away.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { phantomStep, phantomSettings, PHANTOM_DEFAULTS } from '../src/skills/phantomPlan.ts'

const base = { night: true, sleeping: false, phantoms: 0, nearestPhantom: null, sinceRestMs: 60_000, bedDist: 4, groundHostile: false, sinceBedFailMs: null, current: null }
const s = PHANTOM_DEFAULTS

test('phantoms about and a bed in reach: in and out of bed', () => {
  const r = phantomStep(s, { ...base, phantoms: 3, nearestPhantom: 20, sinceRestMs: null })
  assert.equal(r.do, 'sleep'); assert.equal((r as { stay: boolean }).stay, false)
})

test('a recent bed already reset the timer: fight the close ones instead', () => {
  assert.equal(phantomStep(s, { ...base, phantoms: 3, nearestPhantom: 10, sinceRestMs: 60_000 }).do, 'engage')
  assert.equal(phantomStep(s, { ...base, phantoms: 3, nearestPhantom: 30, sinceRestMs: 60_000 }).do, 'none')
})

test('no phantoms yet but long without a bed: to bed and stay', () => {
  const r = phantomStep(s, { ...base, sinceRestMs: 31 * 60_000 })
  assert.equal(r.do, 'sleep'); assert.equal((r as { stay: boolean }).stay, true)
  assert.equal(phantomStep(s, { ...base, sinceRestMs: 10 * 60_000 }).do, 'none')
})

test('no bed: a ground mob close, no bed in range, a recent refusal, by day', () => {
  const p = { ...base, phantoms: 2, nearestPhantom: 12, sinceRestMs: null }
  assert.equal(phantomStep(s, { ...p, groundHostile: true }).do, 'engage')
  assert.equal(phantomStep(s, { ...p, bedDist: 40 }).do, 'engage')
  assert.equal(phantomStep(s, { ...p, sinceBedFailMs: 10_000 }).do, 'engage')
  assert.equal(phantomStep(s, { ...p, night: false }).do, 'none')
})

test('in bed with a phantom close: get up; busy fighting: leave it alone', () => {
  assert.equal(phantomStep(s, { ...base, sleeping: true, phantoms: 1, nearestPhantom: 8 }).do, 'wake')
  assert.equal(phantomStep(s, { ...base, phantoms: 2, nearestPhantom: 8, sinceRestMs: null, current: 'defend' }).do, 'none')
})

test('settings: off, per-key fallbacks, engageRange 0 only fights back', () => {
  assert.equal(phantomSettings(false).enabled, false)
  assert.equal(phantomSettings({ bedRange: 'x', insomniaMinutes: 10 }).bedRange, 16)
  assert.equal(phantomSettings({ insomniaMinutes: 10 }).insomniaMinutes, 10)
  assert.equal(phantomStep(phantomSettings({ engageRange: 0, sleep: false }), { ...base, phantoms: 2, nearestPhantom: 5 }).do, 'none')
})
