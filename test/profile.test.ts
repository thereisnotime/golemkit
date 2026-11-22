import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseProfile, mergeOptions, loadProfile } from '../src/core/profile.ts'
import { parseFleetFile } from '../src/core/fleetFile.ts'

test('profile maps to instance options; llm goes to settings.llm', () => {
  const p = parseProfile(`
variant: companion
username: Pax
owners: [Robin]
canDig: true
persona: test persona
server: { host: example.net }
llm: { provider: codex, listen: all, budget: { turnsPerHour: 5 } }
settings: { home: [1, 2, 3] }
`, 'pax')
  assert.equal(p.profile.variant, 'companion')
  assert.equal(p.server.host, 'example.net')
  assert.deepEqual(p.options.owners, ['Robin'])
  assert.equal(p.options.canDig, true)
  assert.equal(p.options.persona, 'test persona')
  assert.deepEqual((p.options.settings as any).home, [1, 2, 3])
  assert.equal((p.options.settings as any).llm.provider, 'codex')
  assert.equal((p.options.settings as any).llm.listen, 'all')
})

test('invalid profile is rejected with a useful error', () => {
  assert.throws(() => parseProfile('username: x\n'), /variant/)
  assert.throws(() => parseProfile('variant: x\nllm: { listen: sometimes }\n'), /listen/)
})

test('mergeOptions: later wins, settings and settings.llm merge one level', () => {
  const m = mergeOptions(
    { username: 'A', settings: { home: 1, llm: { provider: 'codex', model: 'm1' } } },
    { username: 'B', settings: { llm: { model: 'm2' } } },
    { owners: ['x'] }
  )
  assert.equal(m.username, 'B')
  assert.deepEqual(m.owners, ['x'])
  assert.deepEqual(m.settings, { home: 1, llm: { provider: 'codex', model: 'm2' } })
})

test('repo profiles parse (pax, example)', () => {
  assert.equal(loadProfile('pax')?.profile.variant, 'companion')
  assert.equal(loadProfile('example')?.profile.variant, 'buddy')
})

test('fleet entries can reference profiles', () => {
  const plan = parseFleetFile('bots:\n  - profile: pax\n  - variant: buddy\n    username: B\n')
  assert.equal(plan.agents[0]!.profile, 'pax')
  assert.equal(plan.agents[1]!.variant, 'buddy')
  assert.throws(() => parseFleetFile('bots:\n  - username: nobody\n'), /profile or a variant/)
})
