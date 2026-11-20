// The NPC decision loop for one session: refresh the blackboard, run hooks, back off while
// somebody else owns the body, score behaviours, and start/keep/switch the winner.
import type { Bot } from 'mineflayer'
import {
  PRIORITY, ActionAbortedError, checkAborted, sleep,
  type Agent, type ActionResult, type Caller, type Logger
} from '../../core/index.ts'
import { getHome, setHome } from '../../skills/navigation.ts'
import { Blackboard, type BlackboardOptions } from './blackboard.ts'
import { decide, failureCooldown, type Scored, type SelectOptions } from './select.ts'
import { NpcYield, type Behavior, type BehaviorContext, type NpcContext, type NpcHook } from './types.ts'

/** Internal no-op action the brain runs to cut its own in-flight action short. */
export const INTERRUPT_ACTION = 'npc_interrupt'

export interface NpcOptions extends SelectOptions, BlackboardOptions {
  /** Caller name for act() and the log tag. Default 'npc'. */
  name?: string
  behaviors: Behavior[]
  hooks?: NpcHook[]
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
}

const DEFAULT_BACKOFF: Record<Caller['kind'], number> = { player: 20000, brain: 20000, reflex: 3000, system: 10000 }
/** Abort reasons that mean somebody else stopped or replaced our action. */
const FOREIGN_STOP = new Set(['preempted', 'replaced', 'stopped', 'died'])

interface Stats {
  runs: number
  failures: number
  cooldownUntil: number
  last?: string
}

interface RunningEntry {
  behavior: Behavior
  controller: AbortController
  startedAt: number
  score: number
  done: Promise<void>
}

export class NpcController {
  readonly bb: Blackboard
  readonly name: string
  private readonly agent: Agent
  private readonly bot: Bot
  private readonly opts: NpcOptions
  private readonly log: Logger
  private readonly now: () => number
  private readonly priority: number
  private readonly caller: Caller
  private readonly backoff: Record<Caller['kind'], number>
  private readonly stats = new Map<string, Stats>()
  private running: RunningEntry | null = null
  private pausedUntil = 0
  private yieldedTo: string | null = null
  private lastScores: Scored[] = []
  private ticking = false
  private stopped = false

  constructor (agent: Agent, bot: Bot, opts: NpcOptions) {
    this.agent = agent
    this.bot = bot
    this.opts = opts
    this.name = opts.name ?? 'npc'
    this.log = agent.log.child(this.name)
    this.now = opts.now ?? Date.now
    this.priority = opts.priority ?? PRIORITY.npc
    this.caller = { kind: 'brain', name: this.name }
    this.backoff = { ...DEFAULT_BACKOFF, ...opts.backoffMs }
    this.bb = new Blackboard(agent, opts)
    const names = new Set<string>()
    for (const b of opts.behaviors) {
      if (names.has(b.name)) throw new Error(`duplicate NPC behaviour "${b.name}"`)
      names.add(b.name)
      this.stats.set(b.name, { runs: 0, failures: 0, cooldownUntil: 0 })
    }
    if ((opts.autoHome ?? true) && bot.entity && !getHome(agent)) {
      const p = bot.entity.position
      setHome(agent, { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), dimension: bot.game?.dimension })
      this.log.info(`home set to spawn ${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}`)
    }
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
    return { agent: this.agent, bot: this.bot, bb: this.bb, log: this.log, now, current: this.current }
  }

  /** Who other than us holds the body at our priority or above, as "kind:name". */
  private foreignHolder (): string | null {
    const cur = this.agent.currentAction
    if (!cur) return null
    if (cur.caller.kind === 'brain' && cur.caller.name === this.name) return null
    if (cur.priority < this.priority) return null
    return `${cur.caller.kind}:${cur.caller.name}`
  }

  private yieldTo (holder: string, now: number): void {
    const kind = holder.split(':')[0] as Caller['kind']
    const ms = this.backoff[kind] ?? this.backoff.player
    this.pausedUntil = Math.max(this.pausedUntil, now + ms)
    if (this.yieldedTo !== holder) {
      this.log.debug(`backing off: body held by ${holder}`)
      this.yieldedTo = holder
    }
    if (this.running) this.abortRunning('yield', false)
  }

  private abortRunning (reason: string, interruptAction: boolean): void {
    const r = this.running
    if (!r) return
    this.running = null
    r.controller.abort(reason)
    // Our action may still hold the body; replace it with a no-op at the same priority.
    if (interruptAction && this.agent.currentAction?.caller.kind === 'brain' &&
        this.agent.currentAction.caller.name === this.name && this.agent.getAction(INTERRUPT_ACTION)) {
      void this.agent.act(INTERRUPT_ACTION, {}, { caller: this.caller, priority: this.priority })
    }
  }

  scoreAll (ctx: NpcContext): Scored[] {
    return this.opts.behaviors.map(b => {
      const st = this.stats.get(b.name)!
      if (ctx.now < st.cooldownUntil) return { name: b.name, score: 0 }
      if (b.requires?.some(a => !this.agent.getAction(a))) return { name: b.name, score: 0 }
      let score = 0
      try {
        score = Number(b.score(ctx)) || 0
      } catch (e) {
        this.log.debug(`score ${b.name}: ${(e as Error).message}`)
      }
      return { name: b.name, score }
    })
  }

  /** One decision step. Safe to call often; re-entrant calls are ignored. */
  async tick (): Promise<void> {
    if (this.ticking || this.stopped || !this.bot.entity) return
    this.ticking = true
    try {
      const now = this.now()
      this.bb.update(this.bot)
      const ctx = this.context(now)
      for (const hook of this.opts.hooks ?? []) {
        try { hook(ctx) } catch (e) { this.log.debug(`hook: ${(e as Error).message}`) }
      }

      const holder = this.foreignHolder()
      if (holder) return this.yieldTo(holder, now)
      if (now < this.pausedUntil) return
      if (this.yieldedTo) {
        this.log.debug(`resuming after ${this.yieldedTo}`)
        this.yieldedTo = null
      }

      this.lastScores = this.scoreAll(ctx)
      const running = this.running ? { name: this.running.behavior.name, startedAt: this.running.startedAt } : null
      const d = decide(this.lastScores, running, now, this.opts)
      switch (d.kind) {
        case 'start':
          this.log.debug(`start ${d.name} (${Math.round(d.score)})`)
          this.start(d.name, d.score, now)
          break
        case 'switch':
          this.log.debug(`switch ${d.from} -> ${d.name}: ${d.reason}`)
          this.abortRunning('switch', true)
          this.start(d.name, d.score, now)
          break
        case 'stop':
          this.log.debug(`stop ${d.name}: ${d.reason}`)
          this.abortRunning('stop', true)
          break
      }
    } finally {
      this.ticking = false
    }
  }

  private start (name: string, score: number, now: number): void {
    const behavior = this.opts.behaviors.find(b => b.name === name)!
    const controller = new AbortController()
    const signal = controller.signal
    const st = this.stats.get(name)!
    st.runs++

    const bctx: BehaviorContext = {
      ...this.context(now),
      signal,
      wait: (ms) => sleep(ms, signal),
      act: async (action, params = {}) => {
        checkAborted(signal)
        const holder = this.foreignHolder()
        if (holder) throw new NpcYield(holder)
        const res = await this.agent.act(action, params, { caller: this.caller, priority: this.priority })
        if (signal.aborted) throw new ActionAbortedError(String(signal.reason ?? 'aborted'))
        if (!res.ok) {
          const h = this.foreignHolder()
          if (h) throw new NpcYield(h)
          if (res.message.startsWith('busy')) throw new NpcYield(parseBusy(res.message))
          if (FOREIGN_STOP.has(res.message)) throw new NpcYield('player:unknown')
        }
        return res
      }
    }

    const entry: RunningEntry = { behavior, controller, startedAt: now, score, done: Promise.resolve() }
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
          this.yieldTo(e.holder, this.now())
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
      if (outcome === 'ok') {
        st.failures = 0
        st.cooldownUntil = end + (behavior.cooldownMs ?? 0)
      } else if (outcome === 'fail') {
        st.failures++
        const cd = failureCooldown(st.failures, behavior.failureCooldownMs ?? 5000, behavior.maxFailureCooldownMs ?? 120000)
        st.cooldownUntil = end + cd
        this.log.debug(`${name} failed (${detail}), cooling down ${Math.round(cd / 1000)}s`)
      }
      st.last = `${outcome}: ${detail}`
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
    return {
      behavior: r?.behavior.name ?? null,
      runningFor: r ? Math.round((now - r.startedAt) / 1000) : 0,
      paused: now < this.pausedUntil ? { seconds: Math.ceil((this.pausedUntil - now) / 1000), by: this.yieldedTo } : null,
      scores: [...this.lastScores].sort((a, b) => b.score - a.score).slice(0, 6)
        .map(s => ({ name: s.name, score: Math.round(s.score) })),
      cooldowns: Object.fromEntries([...this.stats].filter(([, s]) => s.cooldownUntil > now)
        .map(([n, s]) => [n, Math.ceil((s.cooldownUntil - now) / 1000)])),
      last: Object.fromEntries([...this.stats].filter(([, s]) => s.last).map(([n, s]) => [n, s.last])),
      ...this.bb.toJSON()
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
    return [
      `doing ${s.behavior ?? 'nothing'}${s.behavior ? ` (${s.runningFor}s)` : ''}`,
      paused ? `backing off ${paused.seconds}s for ${paused.by ?? '?'}` : '',
      `scores: ${scores || 'none'}`,
      `needs: ${needs || 'none'}`,
      s.isNight ? 'night' : 'day'
    ].filter(Boolean).join(' | ')
  }
}

function isResult (r: unknown): r is ActionResult {
  return !!r && typeof r === 'object' && 'ok' in r
}

/** "busy: follow (player Steve)" -> "player:Steve" */
function parseBusy (msg: string): string {
  const m = /\((\w+) ([^)]*)\)/.exec(msg)
  return m ? `${m[1]}:${m[2]}` : 'player:unknown'
}
