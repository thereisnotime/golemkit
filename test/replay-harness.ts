// Packet record and replay for the client stack (minecraft-protocol, the NeoForge handshake, the
// tolerant parser, mineflayer and the agent's session setup), without a server.
//
// Recording (scripts/replay-record.ts) wraps the TCP socket of a real session in offline mode:
// every chunk the server sent and every chunk the client wrote, in order, with the client's
// protocol state at the time. No encryption in offline mode, so the bytes are the packets.
// Replay hands the client a fake socket that plays the server's chunks back. Until the client is
// in the play state it waits for the client to have written as many bytes as it had in the
// recording before each server chunk, so the handshake runs in the same order as it did live.
// The test then compares what the client wrote before play (handshake) byte for byte, and the
// agent's events against a golden trace.
import { createRequire } from 'node:module'
import { Duplex } from 'node:stream'
import { gunzipSync, gzipSync } from 'node:zlib'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const require = createRequire(import.meta.url)
const net = require('node:net')
const dns = require('node:dns')
const mc = require('minecraft-protocol')

export interface RecordedChunk {
  dir: 'in' | 'out'
  /** client protocol state when the chunk went through */
  state: string
  /** ms since the socket opened */
  t: number
  data: string // base64
}

export interface Recording {
  host: string
  port: number
  username: string
  /** what dns.resolveSrv answered (the handshake carries the host it connected to) */
  srv: { error: string } | { addresses: { name: string, port: number }[] }
  /** data/channels-*.json and data/registries-*.json at the start of the session */
  channels: unknown
  registries: unknown
  recordedAt: string
  chunks: RecordedChunk[]
}

const PRE_PLAY = new Set(['handshaking', 'login', 'configuration'])

export function saveRecording (file: string, rec: Recording): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, gzipSync(JSON.stringify(rec)))
}

export function loadRecording (file: string): Recording {
  return JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')) as Recording
}

/** Bytes the client wrote before it reached the play state. */
export function handshakeBytes (chunks: { dir: string, state: string, data: string }[]): Buffer {
  return Buffer.concat(chunks.filter(c => c.dir === 'out' && PRE_PLAY.has(c.state)).map(c => Buffer.from(c.data, 'base64')))
}

/** Remembers which client owns which socket, to read the protocol state at write time. */
function trackClients (): { stateOf: (socket: unknown) => string, restore: () => void } {
  const owner = new WeakMap<object, { state: string }>()
  const orig = mc.Client.prototype.setSocket
  mc.Client.prototype.setSocket = function (this: { state: string }, socket: object) {
    owner.set(socket, this)
    return orig.call(this, socket)
  }
  return {
    stateOf: (socket) => owner.get(socket as object)?.state ?? 'handshaking',
    restore: () => { mc.Client.prototype.setSocket = orig }
  }
}

/**
 * Records every connection the process opens. `sessions()` returns one chunk list per
 * connection (a NeoForge session that was rejected and retried has several).
 */
export function installRecorder (onConnect?: (index: number) => void): { sessions: () => RecordedChunk[][], srv: () => Recording['srv'], stop: () => void } {
  const clients = trackClients()
  const all: RecordedChunk[][] = []
  let srv: Recording['srv'] = { error: 'not called' }
  const origConnect = net.connect
  const origSrv = dns.resolveSrv
  dns.resolveSrv = (name: string, cb: (err: Error | null, addr?: { name: string, port: number }[]) => void) => {
    origSrv.call(dns, name, (err: Error | null, addr?: { name: string, port: number, priority: number, weight: number }[]) => {
      srv = err ? { error: (err as NodeJS.ErrnoException).code ?? err.message } : { addresses: (addr ?? []).map(a => ({ name: a.name, port: a.port })) }
      cb(err, addr)
    })
  }
  net.connect = (...args: unknown[]) => {
    onConnect?.(all.length)
    const socket = origConnect.apply(net, args)
    const chunks: RecordedChunk[] = []
    all.push(chunks)
    const t0 = Date.now()
    socket.prependListener('data', (d: Buffer) => chunks.push({ dir: 'in', state: clients.stateOf(socket), t: Date.now() - t0, data: d.toString('base64') }))
    const write = socket.write
    socket.write = function (d: Buffer, ...rest: unknown[]) {
      chunks.push({ dir: 'out', state: clients.stateOf(socket), t: Date.now() - t0, data: Buffer.from(d).toString('base64') })
      return write.call(this, d, ...rest)
    }
    return socket
  }
  return {
    sessions: () => all,
    srv: () => srv,
    stop: () => { net.connect = origConnect; dns.resolveSrv = origSrv; clients.restore() }
  }
}

export interface ReplayHandle {
  /** resolves when every recorded server chunk has been fed */
  done: Promise<void>
  /** what the client wrote, with the state at write time */
  written: () => { dir: 'out', state: string, data: string }[]
  /** server chunks fed so far, and chunks where the client was slower than in the recording */
  stats: () => { fed: number, total: number, waitedOut: number }
  /** ends the fake socket (as if the server closed it) */
  end: () => void
  restore: () => void
}

/**
 * Makes the next net.connect return a socket that replays `rec`. Call before the agent starts.
 * `waitMs` caps how long to wait for the client's bytes before feeding the next chunk anyway.
 */
export function installReplay (rec: Recording, opts: { waitMs?: number } = {}): ReplayHandle {
  const clients = trackClients()
  const waitMs = opts.waitMs ?? 3000
  const origConnect = net.connect
  const origSrv = dns.resolveSrv
  dns.resolveSrv = (_name: string, cb: (err: Error | null, addr?: { name: string, port: number, priority: number, weight: number }[]) => void) => {
    const s = rec.srv
    setImmediate(() => 'error' in s
      ? cb(Object.assign(new Error(s.error), { code: s.error }))
      : cb(null, s.addresses.map(a => ({ ...a, priority: 0, weight: 0 }))))
  }
  const written: { dir: 'out', state: string, data: string }[] = []
  let outBytes = 0
  let fed = 0
  let waitedOut = 0
  const ins = rec.chunks.filter(c => c.dir === 'in')
  let resolveDone!: () => void
  const done = new Promise<void>(r => { resolveDone = r })
  let socket: Duplex | null = null

  net.connect = () => {
    net.connect = origConnect // one connection only
    const s = new Duplex({
      read () {},
      write (chunk: Buffer, _enc, cb) {
        written.push({ dir: 'out', state: clients.stateOf(s), data: Buffer.from(chunk).toString('base64') })
        outBytes += chunk.length
        cb()
      },
      final (cb) { cb(); setImmediate(() => s.destroy()) } // the client ended: close like a socket would
    })
    ;(s as unknown as { setNoDelay: () => void }).setNoDelay = () => {}
    ;(s as unknown as { setTimeout: () => void }).setTimeout = () => {}
    socket = s
    setImmediate(() => { s.emit('connect'); void feed() })
    return s
  }

  async function feed (): Promise<void> {
    let expectedOut = 0
    let i = 0
    for (const c of rec.chunks) {
      if (c.dir === 'out') { expectedOut += Buffer.from(c.data, 'base64').length; continue }
      if (PRE_PLAY.has(c.state)) {
        const until = Date.now() + waitMs
        while (outBytes < expectedOut && Date.now() < until) await new Promise(r => setTimeout(r, 2))
        if (outBytes < expectedOut) waitedOut++
      }
      if (!socket || socket.destroyed) break
      socket.push(Buffer.from(c.data, 'base64'))
      fed = ++i
      await new Promise(r => setImmediate(r))
    }
    // let the last packets go through the pipeline
    await new Promise(r => setTimeout(r, 200))
    resolveDone()
  }

  return {
    done,
    written: () => written,
    stats: () => ({ fed, total: ins.length, waitedOut }),
    end: () => { if (socket && !socket.destroyed) { socket.push(null); socket.destroy() } },
    restore: () => { net.connect = origConnect; dns.resolveSrv = origSrv; clients.restore() }
  }
}
