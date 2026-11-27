// Keeps one bot's status (src/core/status.ts) up to date: progress from agent events and adapter
// samples, the decision loops' snapshots, the stuck alert, and <dataDir>/status.json for the CLI.
// One per agent (agent.status); started and stopped with the agent. Game-agnostic: it reads
// agent.adapter (self, inventory, players) and agent events only.
import { writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { Agent, ActionInfo } from './agent.ts'
import { defineAction, noParams, ok, type ActionResult } from './action.ts'
import {
  resolveStatusOptions, assess, alertDue, alertText, chatLine,
  type BotStatus, type DeciderSnapshot, type DoingView, type StatusOptions, type AlertState
} from './status.ts'

/** Moving this far from where it last made progress counts as progress. */
export const PROGRESS_DISTANCE = 16
/** Failures that only mean someone else took the body, not that the task failed. */
const NOT_A_FAILURE = /^(busy|preempted|replaced|stopped|died|cancelled|yield|suspended|switch|stop|aborted)\b/

export type StatusAgent = Pick<Agent, 'on' | 'off' | 'adapter' | 'currentAction' | 'getAction' | 'owners' | 'whisper' | 'settings' | 'dataDir' | 'username' | 'log' | 'connected'> & Partial<Pick<Agent, 'definition'>>

export type DeciderSource = () => DeciderSnapshot | null

export class StatusTracker {
  private readonly agent: StatusAgent
  private readonly now: () => number
  private readonly sources = new Map<string, DeciderSource>()
  private timer: NodeJS.Timeout | null = null
  private readonly startedAt: number
  private baselineAt: number
  private progressAt: number | null = null
  private progressWhat: string | null = null
  private anchor: { x: number, y: number, z: number, dim: string | null } | null = null
  private lastItems: number | null = null
  private lastFailure: { what: string, message: string, at: number } | null = null
  private actionSince: { key: string, at: number } | null = null
  private alert: AlertState = { count: 0, lastAt: null }
  private nextAlertAt: number | null = null
  private lastDisconnect: string | null = null
  private lastEvent: { what: string, at: number } | null = null
  private readonly subs: [string, (...a: any[]) => void][] = []
  readonly file: string

  constructor (agent: StatusAgent, opts: { now?: () => number } = {}) {
    this.agent = agent
    this.now = opts.now ?? Date.now
    this.startedAt = this.now()
    this.baselineAt = this.startedAt
    this.file = join(agent.dataDir, 'status.json')
  }

  get options (): StatusOptions {
    return resolveStatusOptions(this.agent.settings)
  }

  /** A decision loop (NPC controller) reports through `fn`; returns the unregister function. */
  addSource (name: string, fn: DeciderSource): () => void {
    this.sources.set(name, fn)
    return () => { if (this.sources.get(name) === fn) this.sources.delete(name) }
  }

  /** Something got done (any code may call it: a behaviour that knows it moved toward its goal). */
  noteProgress (what: string): void {
    this.progressAt = this.now()
    this.progressWhat = what
    this.anchor = this.position()
  }

  /** Something worth showing that isn't progress or a failure (the bot left a fight, and where it went). */
  noteEvent (what: string): void {
    this.lastEvent = { what, at: this.now() }
  }

  /** Subscribes to the agent's events and starts the sample timer. */
  start (): void {
    if (this.timer) return
    const on = (event: string, fn: (...a: any[]) => void) => {
      (this.agent.on as (e: string, f: (...a: any[]) => void) => void)(event, fn)
      this.subs.push([event, fn])
    }
    on('actionStart', (info: ActionInfo) => { this.actionSince = { key: actionKey(info), at: this.now() } })
    on('actionEnd', (info: ActionInfo, res: ActionResult) => this.onActionEnd(info, res))
    on('session', () => {
      // a new session is a fresh start: no alert for the time it was offline
      this.baselineAt = this.now()
      this.anchor = this.position()
      this.lastItems = null
    })
    on('sessionEnd', (reason: string) => { this.lastDisconnect = reason })
    const loop = () => {
      try { this.sample() } catch (e) { this.agent.log.debug(`status: ${(e as Error).message}`) }
      this.timer = setTimeout(loop, this.options.intervalMs)
      this.timer.unref?.()
    }
    this.timer = setTimeout(loop, this.options.intervalMs)
    this.timer.unref?.()
  }

  /** Stops the timer and writes a last, offline status. */
  stop (): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    for (const [e, fn] of this.subs) (this.agent.off as (e: string, f: (...a: any[]) => void) => void)(e, fn)
    this.subs.length = 0
    this.lastDisconnect = 'stopped'
    try { if (this.options.file) this.write({ ...this.snapshot(), connected: false, state: 'offline', summary: 'stopped', doing: null, deciders: [] }) } catch {}
  }

  private onActionEnd (info: ActionInfo, res: ActionResult): void {
    const def = this.agent.getAction(info.name)
    if (!def || def.internal || def.exclusive === false) return
    if (res.ok) this.noteProgress(`${info.name} ok`)
    else if (!NOT_A_FAILURE.test(res.message)) this.lastFailure = { what: info.name, message: res.message, at: this.now() }
  }

  private position (): { x: number, y: number, z: number, dim: string | null } | null {
    try {
      const s = this.agent.adapter.self()
      if (!s) return null
      return { x: s.position.x, y: s.position.y, z: s.position.z, dim: typeof s.game.dimension === 'string' ? s.game.dimension : null }
    } catch { return null }
  }

  private deciders (): DeciderSnapshot[] {
    const out: DeciderSnapshot[] = []
    for (const [name, fn] of this.sources) {
      try { const d = fn(); if (d) out.push(d) } catch (e) { this.agent.log.debug(`status source ${name}: ${(e as Error).message}`) }
    }
    return out
  }

  /** One sample: progress from inventory and position, the stuck alert, the file. */
  sample (): BotStatus {
    const now = this.now()
    if (this.agent.connected) {
      let items: number | null = null
      try { items = this.agent.adapter.inventory?.().items.reduce((n, i) => n + i.count, 0) ?? null } catch {}
      if (items !== null) {
        if (this.lastItems !== null && items > this.lastItems) this.noteProgress(`+${items - this.lastItems} items`)
        this.lastItems = items
      }
      const p = this.position()
      if (p && this.anchor && p.dim === this.anchor.dim) {
        if (Math.hypot(p.x - this.anchor.x, p.y - this.anchor.y, p.z - this.anchor.z) >= PROGRESS_DISTANCE) this.noteProgress(`moved ${PROGRESS_DISTANCE}+ blocks`)
      } else if (p) this.anchor = p
    }
    const s = this.snapshot(now)
    const o = this.options
    const due = alertDue(this.alert, s, o, now)
    if (due.reset) this.alert = { count: 0, lastAt: null }
    this.nextAlertAt = due.nextAt
    if (due.send && this.sendAlert(alertText(s))) this.alert = { count: this.alert.count + 1, lastAt: now }
    s.alert = { count: this.alert.count, lastAt: this.alert.lastAt, nextAt: due.send ? null : due.nextAt }
    if (o.file) {
      try { this.write(s) } catch (e) { this.agent.log.debug(`status file: ${(e as Error).message}`) }
    }
    return s
  }

  /** Whispers the online owners; false when nobody was there to tell. */
  private sendAlert (text: string): boolean {
    let online: string[] = []
    try { online = this.agent.adapter.players?.() ?? [] } catch {}
    const self = this.agent.username.toLowerCase()
    const to = online.filter(n => this.agent.owners.includes(n.toLowerCase()) && n.toLowerCase() !== self)
    if (!to.length) return false
    for (const n of to) this.agent.whisper(n, text)
    this.agent.log.info(`stuck alert to ${to.join(', ')}: ${text}`)
    return true
  }

  /** The current status (does not sample progress or alert). */
  snapshot (now = this.now()): BotStatus {
    const o = this.options
    const connected = this.agent.connected
    const cur = connected ? this.agent.currentAction : null
    let doing: DoingView | null = null
    if (cur) {
      const def = this.agent.getAction(cur.name)
      const key = actionKey(cur)
      doing = {
        action: cur.name,
        caller: `${cur.caller.kind}:${cur.caller.name}`,
        priority: cur.priority,
        since: this.actionSince?.key === key ? this.actionSince.at : null,
        longRunning: !!def?.longRunning
      }
    }
    const deciders = connected ? this.deciders() : []
    // the loops know of successes and failures the action events don't (a behaviour's own result)
    let progressAt = this.progressAt
    let progressWhat = this.progressWhat
    let lastFailure = this.lastFailure
    for (const d of deciders) {
      const p = Math.max(d.lastProgressAt ?? 0, d.lastSuccess?.at ?? 0)
      if (p && p > (progressAt ?? 0)) {
        progressAt = p
        progressWhat = d.lastSuccess && d.lastSuccess.at === p ? `${d.lastSuccess.behavior} done` : 'progress'
      }
      if (d.lastFailure && d.lastFailure.at > (lastFailure?.at ?? 0)) lastFailure = { what: d.lastFailure.behavior, message: d.lastFailure.message, at: d.lastFailure.at }
    }
    const a = assess({ now, connected, progressAt, baselineAt: this.baselineAt, stuckAlertMs: o.stuckAlertMs, doing, deciders, lastFailure })
    let self: BotStatus['self'] = null
    try {
      const st = connected ? this.agent.adapter.self() : null
      if (st) {
        self = {
          position: { x: Math.round(st.position.x * 10) / 10, y: Math.round(st.position.y * 10) / 10, z: Math.round(st.position.z * 10) / 10 },
          dimension: typeof st.game.dimension === 'string' ? st.game.dimension : null,
          health: st.health,
          food: st.food
        }
      }
    } catch {}
    const notes: Record<string, string[]> = {}
    for (const sk of this.agent.definition?.skills ?? []) {
      if (!sk.status) continue
      try { const ls = sk.status(this.agent as never); if (ls.length) notes[sk.name] = ls.slice(0, 8) } catch {}
    }
    let rssMb: number | null = null
    try { rssMb = Math.round(process.memoryUsage.rss() / 1048576) } catch {}
    const s: Omit<BotStatus, 'summary'> = {
      version: 1,
      bot: this.agent.username,
      profile: typeof this.agent.settings.profileName === 'string' ? this.agent.settings.profileName : null,
      pid: process.pid,
      updatedAt: now,
      startedAt: this.startedAt,
      intervalMs: o.intervalMs,
      connected,
      state: a.state,
      trying: a.trying,
      why: a.why,
      blocker: a.blocker,
      doing,
      deciders,
      need: a.need,
      goal: a.goal,
      progress: { at: progressAt, what: progressWhat, quietMs: a.quietMs },
      lastFailure,
      self,
      alert: { count: this.alert.count, lastAt: this.alert.lastAt, nextAt: this.nextAlertAt },
      stuckAlertMs: o.stuckAlertMs,
      lastDisconnect: this.lastDisconnect,
      lastEvent: this.lastEvent,
      rssMb,
      ...(Object.keys(notes).length ? { notes } : {})
    }
    return { ...s, summary: chatLine(s, now) }
  }

  /** The chat answer to "status" / "why are you idle". */
  chatLine (): string {
    return this.snapshot().summary
  }

  private write (s: BotStatus): void {
    mkdirSync(this.agent.dataDir, { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n')
    renameSync(tmp, this.file)
  }
}

function actionKey (i: Pick<ActionInfo, 'name' | 'caller' | 'priority'>): string {
  return `${i.name}|${i.caller.kind}:${i.caller.name}|${i.priority}`
}

/** Every agent has it (registered by the Agent unless a skill brings its own `status`). */
export const statusAction = defineAction({
  name: 'status',
  description: 'Say what the bot is doing and why (or why it is idle or stuck), how long since it last made progress, health and food, and the last failure. Answers "status", "what are you doing", "why are you idle".',
  params: noParams,
  exclusive: false,
  aliases: ['why', 'stuck'],
  run ({ agent }) {
    const s = agent.status.snapshot()
    return ok(s.summary, s)
  }
})
