// Getting off the death screen: the decision per tick and the state from health readings.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { watchRespawn } from '../src/adapters/minecraft-java/respawn.ts'
import { respawnDecision, respawnObserve, respawnSettings, RESPAWN_INITIAL, RESPAWN_DEFAULTS } from '../src/core/index.ts'

const opts = RESPAWN_DEFAULTS

test('respawnDecision: alive or no reading yet does nothing', () => {
  assert.deepEqual(respawnDecision(RESPAWN_INITIAL, 0, opts), { action: 'none' })
  const alive = respawnObserve(RESPAWN_INITIAL, 0.08, 0)
  assert.deepEqual(respawnDecision(alive, 0, opts), { action: 'none' })
})

test('respawnDecision: dead at login asks at once, then every retrySeconds, then reconnects', () => {
  let s = respawnObserve(RESPAWN_INITIAL, 0, 1000)
  assert.equal(s.deadSince, 1000)
  assert.deepEqual(respawnDecision(s, 1000, opts), { action: 'respawn', attempt: 1 })
  s = { ...s, tries: 1, lastTry: 1000 }
  assert.deepEqual(respawnDecision(s, 3000, opts), { action: 'none' })
  assert.deepEqual(respawnDecision(s, 6000, opts), { action: 'respawn', attempt: 2 })
  s = { ...s, tries: 6, lastTry: 30_000 }
  assert.deepEqual(respawnDecision(s, 32_000, opts), { action: 'none' })
  assert.deepEqual(respawnDecision(s, 35_000, opts), { action: 'reconnect' })
})

test('respawnObserve: a later 0 keeps the first death time; health back clears the state', () => {
  let s = respawnObserve(RESPAWN_INITIAL, 0, 1000)
  s = { ...s, tries: 2, lastTry: 4000 }
  s = respawnObserve(s, 0, 5000)
  assert.deepEqual([s.deadSince, s.tries], [1000, 2])
  s = respawnObserve(s, 20, 6000)
  assert.deepEqual(s, { health: 20, deadSince: null, tries: 0, lastTry: null })
})

test('respawnDecision: off does nothing', () => {
  const s = respawnObserve(RESPAWN_INITIAL, 0, 0)
  assert.deepEqual(respawnDecision(s, 0, respawnSettings(false)), { action: 'none' })
})

test('respawnSettings: per-key fallback', () => {
  assert.deepEqual(respawnSettings({ retrySeconds: 'x', maxTries: 3 }), { enabled: true, retrySeconds: 5, maxTries: 3 })
  assert.deepEqual(respawnSettings({ retrySeconds: 0, maxTries: 999 }), { enabled: true, retrySeconds: 1, maxTries: 50 })
})

test('watchRespawn: logs in dead, asks, logs the respawn', () => {
  const client = new EventEmitter() as EventEmitter & { write: (n: string, p: unknown) => void }
  const writes: string[] = []
  client.write = (n: string) => { writes.push(n) }
  const bot = Object.assign(new EventEmitter(), { _client: client, supportFeature: () => true })
  const lines: string[] = []
  const log = { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m) } as never
  let t = 0
  const stop = watchRespawn(bot as never, { log, settings: () => undefined, reconnect: () => {}, tickMs: 60_000, now: () => t })
  client.emit('update_health', { health: 0, food: 0 })
  assert.deepEqual(writes, ['client_command'])
  assert.match(lines[0]!, /dead at login \(health 0\), respawning/)
  t = 6000
  client.emit('update_health', { health: 0, food: 0 })
  assert.equal(writes.length, 2)
  client.emit('update_health', { health: 20, food: 20 })
  assert.match(lines.at(-1)!, /respawned/)
  stop()
})
