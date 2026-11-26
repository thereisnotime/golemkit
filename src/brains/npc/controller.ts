// The NPC decision loop for one session: refresh the blackboard, run hooks, back off while
// somebody else owns the body, score behaviours, and start/keep/switch the winner.
import {
  PRIORITY, ActionAbortedError, checkAborted, sleep,
  type Agent, type ActionResult, type Caller, type Logger, type GameClient, type DeciderSnapshot
} from '../../core/index.ts'
import { getHome, setHome } from '../../skills/navigation.ts'
import { Blackboard, type BlackboardOptions } from './blackboard.ts'
import { decide, failureCooldown, flipCooldown, isFlip, type Scored, type SelectOptions } from './select.ts'
import { helpDesk, type HelpDesk } from './help.ts'
import { NpcYield, type Behavior, type BehaviorContext, type NpcContext, type NpcHook } from './types.ts'
import type { NeedsLayer } from './needs.ts'

/** Internal no-op action the brain runs to cut its own in-flight action short. */
export const INTERRUPT_ACTION = 'npc_interrupt'

export interface NpcOptions extends SelectOptions, BlackboardOptions {
  /** Caller name for act() and the log tag. Default 'npc'. */
  name?: string
  /** The behaviours, or a function returning the current set (re-read every tick, for armable sets). */
  behaviors: Behavior[] | (() => Behavior[])
  hooks?: NpcHook[] | (() => NpcHook[])
  /** Tick interval. Default 1500 ms. */
  tickMs?: number
  /** Default PRIORITY.npc. */
  priority?: number
  /**
   * How long to stay out of the way after another caller held the body, by caller kind.
   * Defaults: player 20 s, brain (e.g. llm) 20 s, reflex 3 s, system 10 s.
   */
  backoffMs?: Partial<Record<Caller['kind'], number>>
  /** Set home to the spawn position when the bot has none. Default true. */
  autoHome?: boolean
  /** Clock, for tests. */
  now?: () => number
  /** Where repeated failures are escalated (settings.askHelp). Default: the agent's shared desk. */
  help?: HelpDesk
  /**
   * Read every tick: while it returns a reason, no behaviour runs (the running one is stopped),
   * whatever its priority. The behaviours brain uses it to stay out of a scene the bot acts in.
   */
  suspended?: () => string | null
  /**
   * The needs layer (src/brains/npc/needs.ts): boosts behaviours serving an urgent need and,
   * when nothing scores above the idle band, runs a need's search or the idle mode's chore.
   */
  needs?: NeedsLayer | null
}

/**
 * The status snapshot (DeciderSnapshot, src/core/status.ts) with what the needs layer knows:
 * need/goal/reason/lastProgressAt filled in, plus the need's urgency, the urgent needs, the idle
 * mode and the idle chore running.
 */
export interface NpcSnapshot extends DeciderSnapshot {
  need: string | null
  goal: string | null
  reason: string | null
  lastProgressAt: number | null
  /** Urgency (0..1) of `need`. */
  needUrgency: number | null
  /** Needs at or above their threshold. */
  urgent: string[]
  idleMode: string | null
  /** The idle chore running, if any. */
  chore: string | null
}

const DEFAULT_BACKOFF: Record<Caller['kind'], number> = { player: 20000, brain: 20000, reflex: 3000, system: 10000 }
/** Abort reasons that mean somebody else stopped or replaced our action. */
const FOREIGN_STOP = new Set(['preempted', 'replaced', 'stopped', 'died'])

interface Stats {
  runs: number
  failures: number
  cooldownUntil: number
  /** Runs in a row that dropped out ("no longer applies") within flipRunMs of starting. */
  flips: number
  /** Until then it may only start with an urgent score (flip back-off). */
  flipUntil: number
  last?: string
  lastAt?: number
  /** Behavior.retryKey when the last run failed. */
  failKey?: string
}

/** A failure back-off is cut short by a changed retryKey only this long after the failure. */
const RETRY_MIN_MS = 10_000

/** Public view of one behaviour's run history (for status actions). */
export interface BehaviorStats {
  runs: number
  failures: number
  /** Seconds until it may run again, 0 when ready. */
  cooldown: number
  /** "ok: ...", "fail: ...", "aborted: ...", "yield: ..." of the last run. */
  last: string | null
  lastAt: number | null
}

interface RunningEntry {
  behavior: Behavior
  controller: AbortController
  startedAt: number
  score: number
  priority: number
  done: Promise<void>
}

interface Holder {
  /** "kind:name" */
  label: string
  priority: number
}

/** How long nothing may run before the controller logs why (and how often). */
const IDLE_REPORT_MS = 120_000

export class NpcController {
  readonly bb: Blackboard
  readonly name: string
  private readonly agent: Agent
  /** The game client, handed to behaviours as ctx.bot. */
  private readonly client: GameClient
  private readonly opts: NpcOptions
  private readonly log: Logger
  private readonly now: () => number
  private readonly priority: number
  private readonly caller: Caller
  private readonly backoff: Record<Caller['kind'], number>
  private readonly stats = new Map<string, Stats>()
  readonly help: HelpDesk
  private running: RunningEntry | null = null
  private pausedUntil = 0
  /** Behaviours at or below this priority stay paused until pausedUntil. */
  private pausedLevel = 0
  private yieldedTo: string | null = null
  private lastScores: Scored[] = []
  private ticking = false
  private stopped = false
  private reason: string | null = null
  private lastProgressAt: number | null = null

  constructor (agent: Agent, client: GameClient, opts: NpcOptions) {
    this.agent = agent
    this.client = client
    this.opts = opts
    this.name = opts.name ?? 'npc'
    this.log = agent.log.child(this.name)
    this.now = opts.now ?? Date.now
    this.priority = opts.priority ?? PRIORITY.npc
    this.caller = { kind: 'brain', name: this.name }
    this.backoff = { ...DEFAULT_BACKOFF, ...opts.backoffMs }
    this.bb = new Blackboard(agent, opts)
    this.help = opts.help ?? helpDesk(agent)
    if (Array.isArray(opts.behaviors)) this.checkNames(opts.needs ? [...opts.behaviors, ...opts.needs.behaviors()] : opts.behaviors)
    this.behaviors()
    const self = agent.adapter.self()
    if ((opts.autoHome ?? true) && self && !getHome(agent)) {
      const p = self.position
      setHome(agent, { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), dimension: self.game.dimension as string | undefined })
      this.log.info(`home set to spawn ${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}`)
    }
  }

  private checkNames (list: Behavior[]): void {
    const names = new Set<string>()
    for (const b of list) {
      if (names.has(b.name)) throw new Error(`duplicate NPC behaviour "${b.name}"`)
      names.add(b.name)
    }
  }

  /** The behaviours configured on the brain (without the needs layer's). */
  regularBehaviors (): Behavior[] {
    return typeof this.opts.behaviors === 'function' ? this.opts.behaviors() : this.opts.behaviors
  }

  /** The current behaviour set: the configured ones, then the needs layer's (need:*, idle:*). */
  behaviors (): Behavior[] {
    const regular = this.regularBehaviors()
    const list = this.opts.needs ? [...regular, ...this.opts.needs.behaviors()] : regular
    for (const b of list) if (!this.stats.has(b.name)) this.stats.set(b.name, { runs: 0, failures: 0, cooldownUntil: 0, flips: 0, flipUntil: 0 })
    return list
  }

  private hooks (): NpcHook[] {
    const h = this.opts.hooks
    return (typeof h === 'function' ? h() : h) ?? []
  }

  private prio (b: Behavior): number {
    return b.priority ?? this.priority
  }

  /** Run history of one behaviour, or null if it never was in the set. */
  statsFor (name: string): BehaviorStats | null {
    const st = this.stats.get(name)
    if (!st) return null
    const now = this.now()
    return {
      runs: st.runs,
      failures: st.failures,
      cooldown: st.cooldownUntil > now ? Math.ceil((st.cooldownUntil - now) / 1000) : 0,
      last: st.last ?? null,
      lastAt: st.lastAt ?? null
    }
  }

  /** Stops the running behaviour if it is `name` (or any, without a name), e.g. after disarming it. */
  cancel (name?: string, reason = 'cancelled'): boolean {
    if (!this.running || (name && this.running.behavior.name !== name)) return false
    this.abortRunning(reason, true)
    return true
  }

  /** Name of the running behaviour, if any. */
  get current (): string | null {
    return this.running?.behavior.name ?? null
  }

  /** Resolves when the running behaviour (if any) has settled. For tests and shutdown. */
  async settled (): Promise<void> {
    await this.running?.done
  }

  private context (now: number): NpcContext {
    return { agent: this.agent, bot: this.client, bb: this.bb, log: this.log, now, current: this.current }
  }

  /** Who other than us holds the body, at any priority. */
  private foreign (): Holder | null {
    const cur = this.agent.currentAction
    if (!cur) return null
    if (cur.caller.kind === 'brain' && cur.caller.name === this.name) return null
    return { label: `${cur.caller.kind}:${cur.caller.name}`, priority: cur.priority }
  }

  /** Who other than us holds the body at `priority` or above, as "kind:name". */
  private foreignHolder (priority = this.priority): Holder | null {
    const h = this.foreign()
    return h && h.priority >= priority ? h : null
  }

  /** True while one of our own actions holds the body above `priority`. */
  private ownAbove (priority: number): boolean {
    const cur = this.agent.currentAction
    return !!cur && cur.caller.kind === 'brain' && cur.caller.name === this.name && cur.priority > priority
  }

  /** Whether a behaviour at this priority must stay out of the way right now. */
  private blocked (priority: number, holder: Holder | null, now: number): boolean {
    if (holder && holder.priority >= priority) return true
    return now < this.pausedUntil && this.pausedLevel >= priority
  }

  /** Backs off from `holder` for the configured time; behaviours above its priority keep going. */
  private yieldTo (holder: string, now: number, priority?: number): void {
    const kind = holder.split(':')[0] as Caller['kind']
    const ms = this.backoff[kind] ?? this.backoff.player
    const level = priority ?? this.running?.priority ?? this.priority
    this.pausedLevel = now < this.pausedUntil ? Math.max(this.pausedLevel, level) : level
    this.pausedUntil = Math.max(this.pausedUntil, now + ms)
    if (this.yieldedTo !== holder) {
      this.log.debug(`backing off: body held by ${holder}`)
      this.yieldedTo = holder
    }
    if (this.running && this.running.priority <= level) {
      this.abortRunning('yield', false)
      // a long-running action of ours that was preempted would be resumed by the agent later,
      // without a behaviour behind it; drop it, the behaviour starts it again after the back-off
      this.agent.cancelActions?.(i => i.caller.kind === 'brain' && i.caller.name === this.name && i.priority <= level, 'yield')
    }
  }

  private abortRunning (reason: string, interruptAction: boolean): void {
    const r = this.running
    if (!r) return
    this.running = null
    r.controller.abort(reason)
    // Our action may still hold the body; replace it with a no-op at the same priority.
    if (interruptAction && this.agent.currentAction?.caller.kind === 'brain' &&
        this.agent.currentAction.caller.name === this.name && this.agent.getAction(INTERRUPT_ACTION)) {
      void this.agent.act(INTERRUPT_ACTION, {}, { caller: this.caller, priority: r.priority })
    }
  }

  scoreAll (ctx: NpcContext, isBlocked: (priority: number) => boolean = () => false): Scored[] {
    return this.scoreList(this.behaviors(), ctx, isBlocked)
  }

  private scoreList (list: Behavior[], ctx: NpcContext, isBlocked: (priority: number) => boolean): Scored[] {
    return list.map(b => {
      const st = this.stats.get(b.name)!
      if (ctx.now < st.cooldownUntil && st.failures > 0 && b.retryKey && st.failKey !== undefined && ctx.now - (st.lastAt ?? 0) >= RETRY_MIN_MS) {
        // what made it fail changed (wood arrived for the tools, say): retry now, not in 15 minutes
        let key: string | undefined
        try { key = b.retryKey(ctx) } catch {}
        if (key !== undefined && key !== st.failKey) {
          this.log.debug(`${b.name}: retrying early (${st.failKey} -> ${key})`)
          st.cooldownUntil = 0
          st.failures = Math.max(0, st.failures - 1)
          st.failKey = undefined
        }
      }
      if (ctx.now < st.cooldownUntil) return { name: b.name, score: 0 }
      if (isBlocked(this.prio(b))) return { name: b.name, score: 0 }
      if (b.requires?.some(a => !this.agent.getAction(a))) return { name: b.name, score: 0 }
      let score = 0
      try {
        score = Number(b.score(ctx)) || 0
      } catch (e) {
        this.log.debug(`score ${b.name}: ${(e as Error).message}`)
      }
      // flickering at the edge of its condition: only an urgent score may start it again for now
      if (ctx.now < st.flipUntil && score < (this.opts.flipBypassScore ?? 75) && this.current !== b.name) score = 0
      return { name: b.name, score }
    })
  }

  /** Counts a run that dropped out on its own condition; repeated quick drop-outs get a pause. */
  private noteDropOut (now: number): void {
    const r = this.running
    if (!r) return
    const st = this.stats.get(r.behavior.name)!
    if (!isFlip(now - r.startedAt, this.opts)) { st.flips = 0; return }
    st.flips++
    const cd = flipCooldown(st.flips, this.opts.flipCooldownMs, this.opts.maxFlipCooldownMs)
    if (cd > 0) {
      st.flipUntil = now + cd
      this.log.debug(`${r.behavior.name} keeps flipping on and off (${st.flips}x), holding it back ${Math.round(cd / 1000)}s unless urgent`)
    }
  }

  /** One decision step. Safe to call often; re-entrant calls are ignored. */
  async tick (): Promise<void> {
    if (this.ticking || this.stopped || !this.agent.adapter.self()) return
    this.ticking = true
    try {
      const now = this.now()
      this.bb.update(this.agent.adapter)
      const ctx = this.context(now)
      for (const hook of this.hooks()) {
        try { hook(ctx) } catch (e) { this.log.debug(`hook: ${(e as Error).message}`) }
      }
      const layer = this.opts.needs
      try { layer?.tick(ctx) } catch (e) { this.log.debug(`needs: ${(e as Error).message}`) }

      const list = this.behaviors()
      const lowest = list.reduce((m, b) => Math.min(m, this.prio(b)), this.priority)
      const highest = list.reduce((m, b) => Math.max(m, this.prio(b)), this.priority)
      const holder = this.foreignHolder(lowest)
      const isBlocked = (p: number): boolean => this.blocked(p, holder, now)
      const report = this.idleReportDue(now)
      const suspended = this.opts.suspended?.() ?? null
      if (suspended) {
        if (this.suspendedBy !== suspended) this.log.debug(`suspended: ${suspended}`)
        this.suspendedBy = suspended
        if (this.running) {
          this.abortRunning('suspended', false)
          this.agent.cancelActions?.(i => i.caller.kind === 'brain' && i.caller.name === this.name, 'suspended')
        }
        if (report) this.idleReport(now, holder, [])
        return
      }
      if (this.suspendedBy) { this.log.debug(`resuming after ${this.suspendedBy}`); this.suspendedBy = null }
      if (holder) this.yieldTo(holder.label, now, holder.priority)
      if ((holder && holder.priority >= highest) || (!holder && now < this.pausedUntil && this.pausedLevel >= highest)) {
        // nothing will be scored this tick; the report still shows this tick's scores
        if (report) this.idleReport(now, holder, this.scoreAll(ctx, isBlocked))
        return
      }
      if (!holder && now >= this.pausedUntil && this.yieldedTo) {
        this.log.debug(`resuming after ${this.yieldedTo}`)
        this.yieldedTo = null
      }

      this.behaviors() // stats for every behaviour, the layer's included
      if (layer) {
        const regular = this.scoreList(this.regularBehaviors(), ctx, isBlocked)
        let boosted = regular
        try { boosted = layer.plan(ctx, regular, this.current, this.opts) } catch (e) { this.log.debug(`needs plan: ${(e as Error).message}`) }
        this.lastScores = [...boosted, ...this.scoreList(layer.behaviors(), ctx, isBlocked)]
      } else {
        this.lastScores = this.scoreAll(ctx, isBlocked)
      }
      if (report) this.idleReport(now, holder, this.lastScores)
      const running = this.running ? { name: this.running.behavior.name, startedAt: this.running.startedAt } : null
      const d = decide(this.lastScores, running, now, this.opts)
      switch (d.kind) {
        case 'start':
          this.log.debug(`start ${d.name} (${Math.round(d.score)})`)
          this.reason = layer?.reasonFor(d.name) ?? `${d.name} ${Math.round(d.score)}`
          this.start(d.name, d.score, now)
          break
        case 'switch':
          this.log.debug(`switch ${d.from} -> ${d.name}: ${d.reason}`)
          if (!((this.lastScores.find(s => s.name === d.from)?.score ?? 0) > 0)) this.noteDropOut(now)
          this.abortRunning('switch', true)
          this.reason = layer?.reasonFor(d.name) ?? d.reason
          this.start(d.name, d.score, now)
          break
        case 'stop':
          this.log.debug(`stop ${d.name}: ${d.reason}`)
          this.noteDropOut(now)
          this.abortRunning('stop', true)
          break
      }
    } finally {
      this.ticking = false
    }
  }

  private idleSince = 0
  private idleReportedAt = 0
  private suspendedBy: string | null = null

  /**
   * Nothing running for a while: once every IDLE_REPORT_MS, log what holds the body and the
   * scores, so a bot that stands around says why (a stale holder, every behaviour cooling down).
   * `idleReportDue` decides at the start of a tick; `idleReport` prints with that tick's scores.
   */
  private idleReportDue (now: number): boolean {
    if (this.running) { this.idleSince = 0; return false }
    if (!this.idleSince) { this.idleSince = now; return false }
    if (now - this.idleSince < IDLE_REPORT_MS || now - this.idleReportedAt < IDLE_REPORT_MS) return false
    this.idleReportedAt = now
    return true
  }

  private idleReport (now: number, holder: { label: string, priority: number } | null, scores: Scored[]): void {
    const cooling = [...this.stats.entries()].filter(([, st]) => now < st.cooldownUntil)
      .map(([n, st]) => `${n} ${Math.round((st.cooldownUntil - now) / 1000)}s`)
    const scored = scores.filter(x => x.score > 0).map(x => `${x.name}=${Math.round(x.score)}`)
    this.log.debug(`idle ${Math.round((now - this.idleSince) / 1000)}s`, {
      holder: holder ? `${holder.label}@${holder.priority}` : 'none',
      paused: now < this.pausedUntil ? `${Math.round((this.pausedUntil - now) / 1000)}s` : 'no',
      scores: scored.join(' ') || 'none',
      cooling: cooling.join(', ') || 'none',
      ...(this.opts.needs ? { need: this.opts.needs.lastView().need ? `${this.opts.needs.lastView().need!.name} ${this.opts.needs.lastView().need!.urgency}` : 'none', idleMode: this.opts.needs.lastView().idleMode } : {})
    })
  }

  private start (name: string, score: number, now: number): void {
    const behavior = this.behaviors().find(b => b.name === name)!
    const controller = new AbortController()
    const signal = controller.signal
    const st = this.stats.get(name)!
    const priority = this.prio(behavior)
    st.runs++

    const bctx: BehaviorContext = {
      ...this.context(now),
      signal,
      wait: (ms) => sleep(ms, signal),
      act: async (action, params = {}) => {
        checkAborted(signal)
        const holder = this.foreignHolder(priority)
        if (holder) throw new NpcYield(holder.label, holder.priority)
        // our own interrupt (or the last behaviour's action) may still hold the body at a higher
        // priority for a moment after a switch; wait for it instead of backing off from ourselves
        for (let i = 0; i < 20 && this.ownAbove(priority); i++) await sleep(50, signal)
        const res = await this.agent.act(action, params, { caller: this.caller, priority })
        if (res.ok) this.lastProgressAt = this.now()
        if (signal.aborted) throw new ActionAbortedError(String(signal.reason ?? 'aborted'))
        if (!res.ok) {
          const h = this.foreignHolder(priority)
          if (h) throw new NpcYield(h.label, h.priority)
          if (res.message.startsWith('busy') && !res.message.endsWith(`(brain ${this.name})`)) throw new NpcYield(parseBusy(res.message))
          if (FOREIGN_STOP.has(res.message)) throw new NpcYield('player:unknown')
        }
        return res
      }
    }

    const entry: RunningEntry = { behavior, controller, startedAt: now, score, priority, done: Promise.resolve() }
    entry.done = (async () => {
      let outcome: 'ok' | 'fail' | 'aborted' | 'yield' = 'ok'
      let detail = ''
      await Promise.resolve() // let start() register the entry before anything can settle
      try {
        const r = await behavior.run(bctx)
        if (r === false || (isResult(r) && !r.ok)) {
          outcome = 'fail'
          detail = isResult(r) ? r.message : 'failed'
        } else {
          detail = isResult(r) ? r.message : typeof r === 'string' ? r : 'done'
        }
      } catch (e) {
        if (e instanceof NpcYield) {
          outcome = 'yield'
          detail = e.message
          this.yieldTo(e.holder, this.now(), e.priority ?? priority)
        } else if (signal.aborted || e instanceof ActionAbortedError) {
          outcome = 'aborted'
          detail = String(signal.reason ?? 'aborted')
        } else {
          outcome = 'fail'
          detail = (e as Error).message
          this.log.warn(`behaviour ${name} crashed: ${(e as Error).stack ?? e}`)
        }
      }
      const end = this.now()
      try { this.opts.needs?.outcome(name, outcome, detail, this.context(end)) } catch (e) { this.log.debug(`needs: ${(e as Error).message}`) }
      if (outcome === 'ok') {
        this.lastProgressAt = end
        st.failures = 0
        st.failKey = undefined
        if (!signal.aborted) st.flips = 0 // a run that finished by itself, not one cut short
        st.cooldownUntil = end + (behavior.cooldownMs ?? 0)
        try { this.help.success(name, end) } catch (e) { this.log.debug(`help: ${(e as Error).message}`) }
      } else if (outcome === 'fail') {
        st.failures++
        const cd = failureCooldown(st.failures, behavior.failureCooldownMs ?? 5000, behavior.maxFailureCooldownMs ?? 120000)
        st.cooldownUntil = end + cd
        try { st.failKey = behavior.retryKey?.(this.context(end)) } catch { st.failKey = undefined }
        this.log.debug(`${name} failed (${detail}), cooling down ${Math.round(cd / 1000)}s`)
        // the same failure over and over: tell the owners once (settings.askHelp)
        try { this.help.failure(behavior, detail, end, this.context(end)) } catch (e) { this.log.debug(`help: ${(e as Error).message}`) }
      }
      st.last = `${outcome}: ${detail}`
      st.lastAt = end
      if (this.running === entry) this.running = null
    })()
    this.running = entry
  }

  /** Stops the loop and the running behaviour (session end / brain stop). */
  stop (reason = 'stopped'): void {
    this.stopped = true
    this.abortRunning(reason, false)
  }

  status (): Record<string, unknown> {
    const now = this.now()
    const r = this.running
    const v = this.opts.needs?.lastView()
    return {
      behavior: r?.behavior.name ?? null,
      runningFor: r ? Math.round((now - r.startedAt) / 1000) : 0,
      paused: now < this.pausedUntil ? { seconds: Math.ceil((this.pausedUntil - now) / 1000), by: this.yieldedTo, upTo: this.pausedLevel } : null,
      scores: [...this.lastScores].sort((a, b) => b.score - a.score).slice(0, 6)
        .map(s => ({ name: s.name, score: Math.round(s.score) })),
      cooldowns: Object.fromEntries([...this.stats].filter(([, s]) => s.cooldownUntil > now)
        .map(([n, s]) => [n, Math.ceil((s.cooldownUntil - now) / 1000)])),
      last: Object.fromEntries([...this.stats].filter(([, s]) => s.last).map(([n, s]) => [n, s.last])),
      ...(this.suspendedBy ? { suspended: this.suspendedBy } : {}),
      ...(r && this.reason ? { reason: this.reason } : {}),
      ...(v ? { drives: { top: v.need, urgent: v.urgent, idleMode: v.idleMode, ...(Object.keys(v.boosted).length ? { boosted: Object.fromEntries(Object.entries(v.boosted).map(([k, b]) => [k, `${b.need} +${Math.round(b.by)}`])) } : {}) } } : {}),
      ...(this.help.recent(now).length ? { askedForHelp: this.help.observeView(now) } : {}),
      ...this.bb.toJSON()
    }
  }

  /**
   * Read-only plain object for the bot's status (agent.status, status.json): what runs, who holds
   * the body, the last scores, cooldowns, idle since, last failure and success. Loops that know
   * their need, goal, reason or last progress fill the optional fields of DeciderSnapshot.
   */
  snapshot (): NpcSnapshot {
    const now = this.now()
    const r = this.running
    const h = this.foreign()
    const runs = [...this.stats].filter(([, s]) => s.last && s.lastAt)
    const latest = (kind: string) => runs.filter(([, s]) => s.last!.startsWith(kind + ': '))
      .sort((a, b) => b[1].lastAt! - a[1].lastAt!)[0]
    const fail = latest('fail')
    const ok = latest('ok')
    const v = this.opts.needs?.lastView()
    return {
      name: this.name,
      behavior: r?.behavior.name ?? null,
      startedAt: r?.startedAt ?? null,
      score: r ? Math.round(r.score) : null,
      priority: r?.priority ?? null,
      holder: h ? `${h.label}@${h.priority}` : null,
      paused: now < this.pausedUntil ? { until: this.pausedUntil, by: this.yieldedTo } : null,
      suspended: this.suspendedBy,
      idleSince: r ? null : this.idleSince || null,
      scores: [...this.lastScores].sort((a, b) => b.score - a.score).slice(0, 6).map(s => ({ name: s.name, score: Math.round(s.score) })),
      cooling: [...this.stats].filter(([, s]) => s.cooldownUntil > now).map(([name, s]) => ({ name, until: s.cooldownUntil, failures: s.failures })),
      lastFailure: fail ? { behavior: fail[0], message: fail[1].last!.slice(6), at: fail[1].lastAt! } : null,
      lastSuccess: ok ? { behavior: ok[0], message: ok[1].last!.slice(4), at: ok[1].lastAt! } : null,
      need: v?.need?.name ?? null,
      needUrgency: v?.need?.urgency ?? null,
      urgent: v?.urgent ?? [],
      goal: r ? r.behavior.goal ?? r.behavior.name : null,
      // nothing runs: why no idle chore did either ("idle (active): tidy_storage not needed, ...")
      reason: r ? this.reason : v?.idleWhy ? `idle (${v.idleMode}): ${v.idleWhy}` : null,
      lastProgressAt: this.lastProgressAt,
      idleMode: v?.idleMode ?? null,
      chore: r?.behavior.name.startsWith('idle:') ? r.behavior.name.slice(5) : null
    }
  }

  /** One line for chat. */
  summary (): string {
    const s = this.status()
    const scores = (s.scores as { name: string, score: number }[]).filter(x => x.score > 0)
      .map(x => `${x.name} ${x.score}`).join(', ')
    const needs = Object.entries(s.needs as Record<string, number>).filter(([, v]) => v > 0)
      .map(([k, v]) => `${k} ${v}`).join(', ')
    const paused = s.paused as { seconds: number, by: string | null } | null
    const asked = (s.askedForHelp as { behavior: string, reason: string, minutesAgo: number, sorted: boolean }[] | undefined) ?? []
    return [
      `doing ${s.behavior ?? 'nothing'}${s.behavior ? ` (${s.runningFor}s)` : ''}`,
      paused ? `backing off ${paused.seconds}s for ${paused.by ?? '?'}` : '',
      `scores: ${scores || 'none'}`,
      `needs: ${needs || 'none'}`,
      s.drives ? drivesLine(s.drives as { top: { name: string, urgency: number } | null, urgent: string[], idleMode: string }) : '',
      asked.length ? `asked for help: ${asked.map(a => `${a.behavior} (${a.reason}, ${a.minutesAgo}m ago${a.sorted ? ', sorted' : ''})`).join('; ')}` : '',
      s.isNight ? 'night' : 'day'
    ].filter(Boolean).join(' | ')
  }
}

function drivesLine (d: { top: { name: string, urgency: number } | null, urgent: string[], idleMode: string }): string {
  const top = d.top ? `${d.top.name} ${d.top.urgency}${d.urgent.includes(d.top.name) ? ' (urgent)' : ''}` : 'none'
  return `top need: ${top}, idle mode ${d.idleMode}`
}

function isResult (r: unknown): r is ActionResult {
  return !!r && typeof r === 'object' && 'ok' in r
}

/** "busy: follow (player Steve)" -> "player:Steve" */
function parseBusy (msg: string): string {
  const m = /\((\w+) ([^)]*)\)/.exec(msg)
  return m ? `${m[1]}:${m[2]}` : 'player:unknown'
}
