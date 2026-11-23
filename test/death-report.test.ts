// Death causes as facts: the tracker (server message before or after the death, damage log,
// timeout), the report text, and onDeathReport on a fake adapter.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { DeathCauseTracker, buildDeathReport, causeFromMessage, onDeathReport, parseDeathMessage, type DeathReport } from '../src/core/index.ts'

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

test('causeFromMessage: the server line without the name', () => {
  assert.equal(causeFromMessage('Pax was slain by Zombie', 'Pax'), 'slain by Zombie')
  assert.equal(causeFromMessage('Pax drowned', 'Pax'), 'drowned')
  assert.equal(causeFromMessage('Pax tried to swim in lava'), 'tried to swim in lava')
  assert.equal(causeFromMessage('Pax was blown up by Creeper', 'Pax'), 'blown up by Creeper')
})

test('buildDeathReport: the live Pax death (zombie kill, creeper fight) reads as facts', () => {
  const r = buildDeathReport(parseDeathMessage('Pax was slain by Zombie', 'Pax'), ['zombie', 'creeper'], {
    action: 'defend', healthBefore: 0.7, nearby: ['creeper', 'zombie'], position: { x: 592.4, y: 10, z: -59.6 }
  })
  assert.equal(r.cause, 'slain by Zombie')
  assert.equal(r.kind, 'slain')
  assert.equal(r.killer, 'Zombie')
  assert.equal(r.summary, 'slain by Zombie (server: "Pax was slain by Zombie"); hurt by zombie, creeper in the last seconds; hostiles close by: creeper, zombie; was doing defend; health 0.7 before the last hit; at 592 10 -60')
})

test('buildDeathReport: no server message falls back on the damage log, then unknown', () => {
  assert.equal(buildDeathReport(null, ['lava'], {}).cause, 'burned in lava')
  assert.equal(buildDeathReport(null, ['fall'], {}).cause, 'fell')
  assert.match(buildDeathReport(null, ['skeleton'], {}).cause, /killed by skeleton/)
  const u = buildDeathReport(null, [], {})
  assert.deepEqual([u.cause, u.kind], ['unknown cause', 'unknown'])
})

test('DeathCauseTracker: message after the death, message before it, or none', async () => {
  const msg = parseDeathMessage('Pax was slain by Zombie', 'Pax')!
  // after
  let t = new DeathCauseTracker({ waitMs: 200 })
  const got: DeathReport[] = []
  t.hurt('creeper'); t.hurt('zombie'); t.hurt('zombie'); t.hurt('unknown')
  t.died({ action: 'defend' }, r => got.push(r))
  assert.equal(got.length, 0, 'waits for the message')
  t.serverDeath(msg)
  assert.equal(got.length, 1)
  assert.deepEqual(got[0]!.recentDamage, ['zombie', 'creeper'], 'newest first, no repeats, no unknown')
  assert.equal(got[0]!.cause, 'slain by Zombie')
  // before (async, so death listeners run first)
  t = new DeathCauseTracker({ waitMs: 200 })
  const early: DeathReport[] = []
  t.serverDeath(msg)
  t.died({}, r => early.push(r))
  assert.equal(early.length, 0)
  await wait(10)
  assert.equal(early[0]?.killer, 'Zombie')
  // none: after waitMs with the last damage source
  t = new DeathCauseTracker({ waitMs: 30 })
  const none: DeathReport[] = []
  t.hurt('fall')
  t.died({}, r => none.push(r))
  await wait(60)
  assert.equal(none.length, 1)
  assert.equal(none[0]!.cause, 'fell')
  // one report per death
  t.serverDeath(msg)
  assert.equal(none.length, 1)
  t.dispose()
})

test('onDeathReport: uses the adapter report, or reports an unknown cause when none comes', async () => {
  const game = new EventEmitter() as EventEmitter & { self: () => unknown }
  game.self = () => ({ position: { x: 1, y: 2, z: 3 } })
  const seen: [DeathReport, unknown][] = []
  const off = onDeathReport(game as any, (r, p) => seen.push([r, p]), 40)
  game.emit('death')
  game.emit('deathCause', buildDeathReport(parseDeathMessage('Pax drowned', 'Pax'), [], {}))
  assert.equal(seen.length, 1)
  assert.equal(seen[0]![0].cause, 'drowned')
  assert.deepEqual(seen[0]![1], { x: 1, y: 2, z: 3 }, 'where it died, not where it respawned')
  await wait(60)
  assert.equal(seen.length, 1, 'no second report from the timer')
  game.emit('death')
  await wait(60)
  assert.equal(seen.length, 2)
  assert.equal(seen[1]![0].cause, 'unknown cause')
  off()
  assert.equal(game.listenerCount('death'), 0)
})
