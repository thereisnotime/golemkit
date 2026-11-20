// A Fleet is every agent running in this process, possibly across several servers. It gives
// bots a way to coordinate: a message bus (direct or broadcast, scoped to a server) and a
// shared blackboard per server. Scene/choreography brains are built on this.
import type { Agent } from './agent.ts'
import { TypedEmitter } from './events.ts'
import { createLogger } from './log.ts'

export interface FleetMessage {
  /** Sender username. */
  from: string
  /** Recipient username; omit to broadcast to everyone on the same server. */
  to?: string
  topic: string
  data?: unknown
  /** Server name the sender is on; messages never cross servers. */
  server: string
}

export type FleetEvents = {
  message: (msg: FleetMessage) => void
  /** An agent spawned (new session). */
  agentReady: (agent: Agent) => void
  agentLost: (agent: Agent, reason: string) => void
}

/** Shared key/value state, one per server. In-memory; persist via agent.storage if needed. */
export class Blackboard {
  private data = new Map<string, unknown>()
  private watchers = new Map<string, Set<(v: unknown) => void>>()

  get<T = unknown> (key: string): T | undefined {
    return this.data.get(key) as T | undefined
  }

  set (key: string, value: unknown): void {
    this.data.set(key, value)
    for (const w of this.watchers.get(key) ?? []) w(value)
  }

  delete (key: string): void {
    this.data.delete(key)
  }

  /** Calls fn whenever key changes. Returns an unsubscribe function. */
  watch (key: string, fn: (v: unknown) => void): () => void {
    let set = this.watchers.get(key)
    if (!set) this.watchers.set(key, set = new Set())
    set.add(fn)
    return () => { set!.delete(fn) }
  }

  entries (): [string, unknown][] {
    return [...this.data.entries()]
  }
}

export class Fleet extends TypedEmitter<FleetEvents> {
  readonly log = createLogger('fleet')
  private readonly members: { agent: Agent, server: string }[] = []
  private readonly boards = new Map<string, Blackboard>()

  add (agent: Agent, server = 'default'): void {
    if (this.get(agent.username, server)) throw new Error(`duplicate bot ${agent.username} on ${server}`)
    this.members.push({ agent, server })
    agent.attachFleet(this, server)
    agent.on('session', () => this.emit('agentReady', agent))
    agent.on('sessionEnd', (reason) => this.emit('agentLost', agent, reason))
  }

  get agents (): Agent[] {
    return this.members.map(m => m.agent)
  }

  get servers (): string[] {
    return [...new Set(this.members.map(m => m.server))]
  }

  get (username: string, server?: string): Agent | undefined {
    return this.members.find(m => m.agent.username === username && (!server || m.server === server))?.agent
  }

  onServer (server: string): Agent[] {
    return this.members.filter(m => m.server === server).map(m => m.agent)
  }

  /** Other agents on the same server as `agent`. */
  peers (agent: Agent): Agent[] {
    return this.onServer(agent.serverName).filter(a => a !== agent)
  }

  board (server: string): Blackboard {
    let b = this.boards.get(server)
    if (!b) this.boards.set(server, b = new Blackboard())
    return b
  }

  /** Delivers a message to its recipient (or everyone on the sender's server). */
  send (msg: FleetMessage): void {
    this.log.debug(`${msg.server}: ${msg.from} -> ${msg.to ?? '*'} ${msg.topic}`)
    this.emit('message', msg)
  }

  /** Subscribes an agent to messages addressed to it (or broadcast on its server, from others). */
  subscribe (agent: Agent, fn: (msg: FleetMessage) => void): () => void {
    return this.on('message', (msg) => {
      if (msg.server !== agent.serverName || msg.from === agent.username) return
      if (msg.to && msg.to !== agent.username) return
      fn(msg)
    })
  }

  /** Resolves with the first matching message, or rejects on timeout/abort. */
  waitFor (agent: Agent, match: (msg: FleetMessage) => boolean, timeoutMs = 60_000, signal?: AbortSignal): Promise<FleetMessage> {
    return new Promise((resolve, reject) => {
      const done = (fn: () => void) => { clearTimeout(t); off(); signal?.removeEventListener('abort', onAbort); fn() }
      const off = this.subscribe(agent, (msg) => { if (match(msg)) done(() => resolve(msg)) })
      const t = setTimeout(() => done(() => reject(new Error('timeout waiting for fleet message'))), timeoutMs)
      const onAbort = () => done(() => reject(new Error('aborted')))
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /**
   * Starts every agent. Logins are staggered per server (servers start in parallel) to stay
   * under connection throttles.
   */
  start (staggerMs: number | ((server: string) => number) = 5000): void {
    for (const server of this.servers) {
      const gap = typeof staggerMs === 'function' ? staggerMs(server) : staggerMs
      this.onServer(server).forEach((a, i) => setTimeout(() => { void a.start() }, i * gap))
    }
  }

  async stop (): Promise<void> {
    await Promise.allSettled(this.agents.map(a => a.stop()))
  }
}
