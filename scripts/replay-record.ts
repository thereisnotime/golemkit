// Records a short real session for the packet replay test (test/replay.test.ts):
//   node --env-file=.env scripts/replay-record.ts [--seconds 30] [--out test/fixtures/replay/session.json.gz]
// REPLAY_ACCOUNT (default GuardTester, a test account that logs out far from spawn) joins with the
// replay variant (standard skills + navigation, no brains, so it does nothing on its own) and stays
// put; DIRECTOR (default ClaudeTest) says a line in public chat and whispers to it, so chat is in
// the recording. The last connection that reached the play state is saved, with the NeoForge
// channel and registry caches it started from. Afterwards run the replay test with
// UPDATE_GOLDEN=1 once to write the event trace (test/fixtures/golden/replay-events.json).
import { readFileSync } from 'node:fs'
import { Agent, defineVariant, serverFromEnv, fmtPos } from '../src/core/index.ts'
import { installRecorder, saveRecording, type Recording } from '../test/replay-harness.ts'
import { replayVariant } from '../test/replay-variant.ts'

const argv = process.argv.slice(2)
const opt = (name: string, def: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : def }
const SECONDS = Number(opt('seconds', '30'))
const OUT = opt('out', 'test/fixtures/replay/session.json.gz')
const ACCOUNT = process.env.REPLAY_ACCOUNT || 'GuardTester'
const DIRECTOR = process.env.DIRECTOR || 'ClaudeTest'
const server = serverFromEnv()
const pause = (ms: number) => new Promise(r => setTimeout(r, ms))
const readJson = (f: string) => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return null } }
const caches = () => ({
  channels: readJson(`data/channels-${server.host}-${server.port}.json`),
  registries: readJson(`data/registries-${server.host}-${server.port}.json`)
})

async function main (): Promise<void> {
  if (server.auth !== 'offline') throw new Error('recording needs an offline-mode server (no encryption)')
  const dir = new Agent(defineVariant({ name: 'director', skills: [], brains: [] }), server, { username: DIRECTOR, dataDir: 'data/replay/director' })
  await new Promise<void>(resolve => { dir.once('session', () => setTimeout(resolve, 3000)); void dir.start() })

  const atConnect: ReturnType<typeof caches>[] = []
  const rec = installRecorder(() => atConnect.push(caches()))
  const agent = new Agent(replayVariant(), server, { username: ACCOUNT, dataDir: 'data/replay/agent' })
  agent.on('session', () => console.log(`${ACCOUNT} spawned at ${fmtPos(agent.bot.entity.position)}`))
  await new Promise<void>(resolve => { agent.once('session', () => resolve()); void agent.start() })
  const started = Date.now()
  await pause(5000)
  await dir.command(`/say replay check, public line`)
  await pause(3000)
  await dir.command(`/msg ${ACCOUNT} replay check, whisper`)
  while (Date.now() - started < SECONDS * 1000) await pause(500)
  await agent.stop()
  await pause(500)
  rec.stop()
  await dir.stop()

  const sessions = rec.sessions()
  const idx = sessions.map((s, i) => ({ s, i })).filter(({ s }) => s.some(c => c.state === 'play')).at(-1)?.i
  if (idx === undefined) throw new Error('no session reached the play state')
  const out: Recording = {
    host: server.host, port: server.port, username: ACCOUNT, srv: rec.srv(),
    channels: atConnect[idx]!.channels, registries: atConnect[idx]!.registries,
    recordedAt: new Date().toISOString(), chunks: sessions[idx]!
  }
  saveRecording(OUT, out)
  const bytes = (d: 'in' | 'out') => out.chunks.filter(c => c.dir === d).reduce((n, c) => n + Buffer.from(c.data, 'base64').length, 0)
  console.log(`saved ${OUT}: ${out.chunks.length} chunks, ${bytes('in')} bytes in, ${bytes('out')} bytes out (connection ${idx + 1} of ${sessions.length})`)
}

setTimeout(() => { console.error('timeout'); process.exit(2) }, 5 * 60_000).unref()
main().then(() => process.exit(0), e => { console.error(e); process.exit(1) })
