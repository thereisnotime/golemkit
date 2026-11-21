import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findToggle, parseToggleValue, expandPaths, deepMerge } from '../src/core/toggles.ts'
import { Agent, defineVariant } from '../src/core/index.ts'

test('toggle lookup and value parsing', () => {
  assert.ok(findToggle('llm.listen'))
  assert.ok(findToggle('retry.actions.goto'), 'wildcard key')
  assert.equal(findToggle('owners'), undefined, 'not everything is toggleable')
  assert.deepEqual(parseToggleValue(findToggle('canDig')!, 'off'), { ok: true, value: false })
  assert.deepEqual(parseToggleValue(findToggle('reflexes.retreatBelow')!, '6'), { ok: true, value: 6 })
  assert.deepEqual(parseToggleValue(findToggle('llm.aliases')!, 'pax, p'), { ok: true, value: ['pax', 'p'] })
  assert.equal(parseToggleValue(findToggle('llm.listen')!, 'sometimes').ok, false)
  assert.equal(parseToggleValue(findToggle('reflexes.retreatBelow')!, '99').ok, false)
})

test('overrides merge over the profile, persist and reset', () => {
  const dir = join(tmpdir(), `mcb-toggle-${process.pid}`)
  const def = defineVariant({ name: 't', skills: [], brains: [] })
  const server = { host: 'h', port: 1, auth: 'offline' as const, version: '1.21.1' }
  const a = new Agent(def, server, { username: 'T', dataDir: dir, canDig: false, settings: { reflexes: { retreatBelow: 8, eatBelow: 15 }, llm: { listen: 'mention' } } })
  const seen: string[] = []
  a.on('settingsChanged', k => seen.push(k))
  assert.equal(a.setToggle('reflexes.retreatBelow', '0').ok, true)
  assert.equal(a.setToggle('canDig', 'true').ok, true)
  assert.equal(a.setToggle('retry.actions.goto', '3').ok, true)
  assert.deepEqual((a.settings as any).reflexes, { retreatBelow: 0, eatBelow: 15 })
  assert.equal(a.canDig, true)
  assert.equal(a.retry.actions.goto, 3)
  a.storage.flush()
  const b = new Agent(def, server, { username: 'T', dataDir: dir, canDig: false, settings: { reflexes: { retreatBelow: 8 } } })
  assert.equal((b.settings as any).reflexes.retreatBelow, 0, 'survives a restart')
  assert.equal(b.resetToggle('reflexes'), 1)
  assert.equal((b.settings as any).reflexes.retreatBelow, 8)
  assert.equal(b.resetToggle(), 2)
  assert.equal(b.canDig, false)
  assert.deepEqual(seen, ['reflexes.retreatBelow', 'canDig', 'retry.actions.goto'])
})

test('expand and deep merge', () => {
  assert.deepEqual(expandPaths({ 'a.b': 1, 'a.c': 2, d: 3 }), { a: { b: 1, c: 2 }, d: 3 })
  assert.deepEqual(deepMerge({ a: { b: 1, c: 2 }, l: [1] }, { a: { b: 9 }, l: [2] }), { a: { b: 9, c: 2 }, l: [2] })
})
