// Replays a recorded real session (test/fixtures/replay/session.json.gz, made with
// scripts/replay-record.ts) through the whole client stack, offline. The handshake (everything
// the client wrote before play) must match the recording byte for byte, and the agent's events,
// the packets it parsed and its final observe() must match the golden trace.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { Agent } from '../src/core/index.ts'
import { loadRecording, installReplay, handshakeBytes } from './replay-harness.ts'
import { replayVariant } from './replay-variant.ts'
import { matchGolden } from './golden.ts'

const FIXTURE = join(import.meta.dirname, 'fixtures', 'replay', 'session.json.gz')
const require = createRequire(import.meta.url)
const mc = require('minecraft-protocol')

test('replay: a recorded session gives the same handshake and events', { skip: !existsSync(FIXTURE) && 'no recording' }, async () => {
  const rec = loadRecording(FIXTURE)
  const cwd = process.cwd()
  const dir = mkdtempSync(join(tmpdir(), 'golemkit-replay-'))
  process.chdir(dir)
  mkdirSync('data')
  if (rec.channels) writeFileSync(`data/channels-${rec.host}-${rec.port}.json`, JSON.stringify(rec.channels))
  if (rec.registries) writeFileSync(`data/registries-${rec.host}-${rec.port}.json`, JSON.stringify(rec.registries))

  // every packet the client parsed, by state and name
  const packets: Record<string, number> = {}
  const clients: { closeTimer?: NodeJS.Timeout }[] = []
  const origSetSocket = mc.Client.prototype.setSocket
  mc.Client.prototype.setSocket = function (this: any, socket: unknown) {
    clients.push(this)
    this.on('packet', (_d: unknown, meta: { state: string, name: string }) => { const k = `${meta.state}:${meta.name}`; packets[k] = (packets[k] ?? 0) + 1 })
    return origSetSocket.call(this, socket)
  }
  const replay = installReplay(rec)
  const events: unknown[] = []
  const agent = new Agent(replayVariant(), { host: rec.host, port: rec.port, auth: 'offline', version: '1.21.1' }, {
    username: rec.username, dataDir: join(dir, 'agent'), reconnectDelayMs: 3_600_000, owners: ['Tester']
  })
  agent.on('session', () => {
    const bot = agent.bot as any
    bot.physicsEnabled = false // positions come from the server only, not from how many ticks ran
    events.push({ event: 'session', position: `${Math.floor(bot.entity.position.x)} ${Math.floor(bot.entity.position.y)} ${Math.floor(bot.entity.position.z)}`, dimension: bot.game.dimension, gameMode: bot.game.gameMode })
  })
  agent.on('chat', m => events.push({ event: 'chat', ...m }))
  agent.on('serverMessage', m => events.push({ event: 'serverMessage', text: m }))
  agent.on('gameModeChanged', (mode, prev) => events.push({ event: 'gameModeChanged', mode, prev }))
  agent.on('protectedArea', p => events.push({ event: 'protectedArea', p }))
  try {
    void agent.start()
    await replay.done
    const stats = replay.stats()
    assert.equal(stats.fed, stats.total, 'every recorded server chunk was fed')
    assert.equal(stats.waitedOut, 0, 'the client wrote its handshake replies in time')
    assert.ok(agent.connected, 'the agent reached the play state')

    // handshake: byte for byte what the real server accepted
    const want = handshakeBytes(rec.chunks)
    const got = handshakeBytes(replay.written())
    assert.equal(got.length, want.length, 'handshake length')
    assert.ok(got.equals(want), 'handshake bytes')

    const bot = agent.bot as any
    const observed = agent.observe()
    matchGolden('replay-events', {
      events,
      packets: Object.fromEntries(Object.entries(packets).sort(([a], [b]) => a.localeCompare(b))),
      registry: {
        items: Object.keys(bot.registry.itemsByName).length,
        entities: Object.keys(bot.registry.entitiesByName).length,
        moddedItems: Object.keys(bot.registry.itemsByName).filter(n => n.includes(':')).sort().slice(0, 20)
      },
      observe: observed
    })
  } finally {
    await agent.stop()
    replay.end()
    replay.restore()
    await new Promise(r => setTimeout(r, 50))
    for (const c of clients) clearTimeout(c.closeTimer) // client.end() waits 30 s for a socket that already closed
    mc.Client.prototype.setSocket = origSetSocket
    process.chdir(cwd)
  }
})
