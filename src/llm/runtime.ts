// Per-bot LLM runtime: trigger queue, one-turn-at-a-time lock, budgets, memory, tools and
// the optional MCP bridge. The llm brain (src/brains/llm.ts) wires agent events into it;
// tests drive it directly with a fake agent and a fake provider.
import type { Agent, ActionInfo, ActionResult, ChatMessage, Logger } from '../core/index.ts'
import { Budget, type BudgetOptions } from './budget.ts'
import { startMcpHttp, type McpHttpBridge } from './mcp.ts'
import { Memory, type MemoryOptions } from './memory.ts'
import { backoffMs, isTransientLlmError } from '../core/retry.ts'
import { buildSystemPrompt, buildUserMessage, chatTrigger, type ChatTriggerOptions, type PromptContext, type Trigger } from './prompt.ts'
import { PRIORITY } from '../core/index.ts'
import type { ProxyMetrics } from './proxyMetrics.ts'
import { BotTools, LLM_CALLER, inSessionAndDanger, type BotToolsOptions, type ToolAgent } from './tools.ts'
import type { LlmProvider, ToolCallRecord, TurnResult } from './types.ts'
import { PriceTable, type Price } from './pricing.ts'
import { UsageTracker, fmtTurn, fmtCost, fmtSummary, turnUsage, type TurnUsage, type UsageSnapshot } from './usage.ts'
import { GoalStore, registerGoalTools, continuationDecision, idleDelay, failureSignature, type GoalOptions } from './goals.ts'
import type { GoalTriggerReason } from './prompt.ts'

export type RuntimeAgent = ToolAgent & Pick<Agent, 'isOwner' | 'storage' | 'definition'>

export interface TriggerOptions extends ChatTriggerOptions {
  /** Only react to players allowed by agent.isOwner (owners list / MC_OWNERS; empty = everyone). Default true. */
  ownersOnly?: boolean
  /** Autonomous turn every N ms while nothing else is going on (0 = off). Default 0. */
  tickMs?: number
  /** With tickMs: only tick while the bot has no current action. Default true. */
  tickWhenIdleOnly?: boolean
  events?: {
    /** Getting hurt (debounced). Default false: reflexes already handle fights. */
    hurt?: boolean
    death?: boolean
    playerJoined?: boolean
  }
  /** Minimum gap between chat turns for the same player; faster messages are merged into the next turn. Default 2500 ms. */
  playerCooldownMs?: number
  /**
   * After a chat turn with a player, their follow-up messages within this window count as
   * addressed to the bot even without its name ("where are you" after "hi pax"). 0 disables.
   * Default 90000 ms.
   */
  conversationMs?: number
  /** Start a short turn to report the outcome when a long-running action the LLM started ends. Default true. */
  reportLongActions?: boolean
  /** listen 'all': collect overheard lines this long before one turn. Default 4000 ms. */
  ambientBatchMs?: number
  /** listen 'all': at least this long between turns for overheard chat. Default 30000 ms. */
  ambientMinGapMs?: number
}

export interface LimitOptions extends BudgetOptions {
  /** Model round trips per trigger. Default 8. */
  maxTurns?: number
  /** Tool calls per trigger. Default 12. */
  maxToolCalls?: number
  /** Chat messages the model may send per trigger. Default 3. */
  maxChatMessages?: number
  /** Wall-clock limit per trigger. Default 120 s. */
  turnTimeoutMs?: number
  /** Pending triggers kept while a turn runs. Default 3. */
  queueSize?: number
}

export interface RuntimeOptions {
  provider: LlmProvider
  /** Scraped after each turn; the counters that changed go into the turn's usage (journal). */
  proxyMetrics?: ProxyMetrics
  persona?: string
  /** Retries for transient provider errors (timeouts, 429, 5xx, network). Default 2 attempts. */
  retry?: { attempts: number, backoffMs: [number, number] }
  /** Stay in character (see SystemPromptInput.immersive). Default false: factual reports. */
  immersive?: boolean
  rules?: string
  triggers?: TriggerOptions
  limits?: LimitOptions
  memory?: MemoryOptions
  tools?: BotToolsOptions
  /** MCP bridge: started automatically for CLI providers; `expose: true` starts it anyway (to drive the bot from your own agent CLI). */
  mcp?: { port?: number, expose?: boolean, token?: string }
  /** If the model didn't chat but returned text, reply with it on chat triggers. Default true. */
  replyWithFinalText?: boolean
  /** Price overrides, USD per million tokens: { model: [input, output, cacheRead?, cacheWrite?] }. */
  prices?: Record<string, Price>
  /** Called after every turn with the turn's usage and the bot's totals (the brain emits `llmUsage` on the agent). */
  onUsage?: (snapshot: UsageSnapshot) => void
  /** Context pack sections for the system prompt (src/context). Called per turn, so hot reloads apply. */
  context?: () => PromptContext | undefined
  /** Called when turns can run again after a pause (budget or provider quota). */
  onResume?: () => void
  /** Called once when turns pause because a budget ran out (hooks: llmBudgetExhausted). */
  onPause?: (reason: string) => void
  /** Persistent goals and continuation (goals.ts). Profile: llm.goals. */
  goals?: GoalOptions
}

export interface TurnReport {
  trigger: Trigger
  result?: TurnResult
  usage?: TurnUsage
  error?: string
  calls: ToolCallRecord[]
  skipped?: string
}

export class LlmRuntime {
  readonly agent: RuntimeAgent
  readonly provider: LlmProvider
  readonly memory: Memory
  readonly tools: BotTools
  readonly budget: Budget
  readonly usage: UsageTracker
  readonly prices: PriceTable
  /** The active goal (persistent) and its continuation guardrails. */
  readonly goals: GoalStore
  /** Why turns are paused (budget exhausted), or null. */
  paused: string | null = null
  private pauseAnnounced = false
  /** Provider quota used up until this time (ms); no turns before it. */
  private quotaUntil = 0
  bridge: McpHttpBridge | null = null
  /** Set when provider.check() failed; turns are skipped. */
  unavailable: string | null = null
  readonly reports: TurnReport[] = []
  // Logger `<username>/llm`; tune it with MC_LOG_LEVEL rules on the llm component.
  readonly log: Logger

  private readonly opts: RuntimeOptions
  private limits: Required<Omit<LimitOptions, keyof BudgetOptions>>
  private readonly queue: Trigger[] = []
  private busy = false
  private current: AbortController | null = null
  private idleWaiters: (() => void)[] = []
  private lastPlayerTurn = new Map<string, number>()
  private lastNotice = 0
  private stopped = false
  lastTurnAt = 0

  constructor (agent: RuntimeAgent, opts: RuntimeOptions) {
    this.agent = agent
    this.opts = opts
    this.provider = opts.provider
    this.log = agent.log.child('llm')
    this.memory = new Memory(agent.storage, opts.memory)
    this.tools = new BotTools(agent, this.memory, { log: this.log.child('tools'), allowOutsideTurn: !!opts.mcp?.expose, ...opts.tools })
    this.usage = new UsageTracker(agent.username, agent.storage)
    this.prices = new PriceTable(opts.prices)
    this.budget = new Budget(opts.limits, { today: () => this.usage.today })
    this.goals = new GoalStore(agent.storage, opts.goals)
    // Unknown while disconnected: assume online so nothing auto-resumes.
    this.goals.isOnline = name => {
      const a = agent as { inSession?: boolean, adapter?: { players? (): string[] } }
      const ps = a.inSession ? a.adapter?.players?.() : undefined
      return !ps || ps.includes(name)
    }
    registerGoalTools(this.tools, this.goals, what => this.log.info(`goal ${what}`, { goal: this.goals.active?.text }))
    const l = opts.limits ?? {}
    this.limits = {
      maxTurns: l.maxTurns ?? 8,
      maxToolCalls: l.maxToolCalls ?? 12,
      maxChatMessages: l.maxChatMessages ?? 3,
      turnTimeoutMs: l.turnTimeoutMs ?? 120_000,
      queueSize: l.queueSize ?? 3
    }
  }

  /** In-game setting changes (config_set): update triggers, style and limits live. */
  applySettings (s: Record<string, any>): void {
    const keys = ['listen', 'aliases', 'conversationMs', 'ownersOnly', 'tickMs', 'mention', 'whisper', 'ambientBatchMs', 'ambientMinGapMs', 'playerCooldownMs']
    const triggers: Record<string, unknown> = { ...(this.opts.triggers ?? {}) }
    for (const k of keys) if (s[k] !== undefined) triggers[k] = s[k]
    ;(this.opts as any).triggers = triggers
    if (typeof s.immersive === 'boolean') (this.opts as any).immersive = s.immersive
    const b = s.budget ?? {}
    this.budget.configure(b)
    const lim = this.limits as Record<string, number>
    for (const k of ['maxTurns', 'maxToolCalls', 'maxChatMessages', 'turnTimeoutMs']) if (typeof b[k] === 'number') lim[k] = b[k]
    this.goals.configure(s.goals ?? {})
    this.log.info('settings applied live', { listen: triggers.listen, immersive: this.opts.immersive })
  }

  get systemPrompt (): string {
    return buildSystemPrompt({
      username: this.agent.username,
      persona: this.opts.persona ?? this.agent.definition.persona,
      immersive: this.opts.immersive,
      rules: this.opts.rules,
      context: this.opts.context?.(),
      goals: true
    })
  }

  /** Checks the provider and starts the MCP bridge if needed. */
  async start (): Promise<void> {
    void this.opts.proxyMetrics?.delta() // baseline for per-turn proxy metrics
    // A quota pause survives reconnects and restarts (no failing test turn, no repeated whisper).
    try { const q = this.agent.storage.get<number | undefined>('llm.quotaUntil'); if (q && q > Date.now()) this.quotaUntil = q } catch {}
    if (this.quotaUntil > Date.now()) this.scheduleQuotaResume(true)
    this.unavailable = await this.provider.check().catch(e => (e as Error).message)
    if (this.unavailable) this.log.warn(`provider ${this.provider.name} unavailable: ${this.unavailable}`, { provider: this.provider.name })
    if (this.provider.needsMcp || this.opts.mcp?.expose) {
      const port = this.opts.mcp?.port ?? 0
      this.bridge = await startMcpHttp(this.tools, { port, token: this.opts.mcp?.token, name: `golemkit-${this.agent.username}` })
      // The token is a local secret; print it only when the user asked to expose the bridge.
      if (this.opts.mcp?.expose) this.log.info(`MCP bridge on ${this.bridge.url} (Authorization: Bearer ${this.bridge.token})`, { url: this.bridge.url })
      else this.log.debug('MCP bridge started', { url: this.bridge.url })
    }
    this.log.info(`LLM brain ready: ${this.provider.name}${this.unavailable ? ' (unavailable)' : ''}`, { provider: this.provider.name, model: this.provider.model, billing: this.provider.billing })
    const goal = this.goals.active
    if (goal) this.log.info(`active goal: ${goal.text}`, { steps: goal.steps.length, paused: goal.paused })
    this.goalTimer = setInterval(() => this.goalIdleCheck(), 5000)
    this.goalTimer.unref()
  }

  async stop (): Promise<void> {
    this.stopped = true
    if (this.goalTimer) clearInterval(this.goalTimer)
    if (this.goalWake) clearTimeout(this.goalWake)
    this.queue.length = 0
    this.current?.abort()
    await this.bridge?.close()
    this.bridge = null
    this.usage.dispose()
  }

  /** Usage of this bot: last turn, since start, today, all time. */
  snapshot (): UsageSnapshot {
    return this.usage.snapshot(this.provider.name, this.provider.billing)
  }

  /** Compact usage block for agent.observe(). */
  observeField (): Record<string, unknown> {
    const t = this.usage.today
    return {
      provider: this.provider.name,
      billing: this.provider.billing,
      paused: this.paused,
      today: { turns: t.turns, tokens: t.inputTokens + t.outputTokens, cost: fmtCost(t, this.provider.billing) },
      lastTurn: this.usage.last ? fmtTurn(this.usage.last) : null,
      goal: this.goals.observeField()
    }
  }

  /**
   * Why a turn could not run right now (provider unavailable, budget used up, provider quota),
   * or null when the LLM can think. Read synchronously by the intents brain to decide whether
   * it answers a chat line itself.
   */
  blockedReason (): string | null {
    if (this.stopped) return 'LLM brain stopped'
    if (this.unavailable) return `provider unavailable: ${this.unavailable}`
    const b = this.budget.blocked()
    if (b) return b
    if (this.quotaUntil > Date.now()) return `provider quota used up until ${new Date(this.quotaUntil).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`
    return null
  }

  // ---------------------------------------------------------------- inputs

  /** Players online besides us and `except`. */
  private othersOnline (except: string): number {
    try {
      const map = (this.agent as any).bot?.players
      if (!map) return 1 // unknown: don't assume we're alone
      return Object.keys(map).filter(p => p !== this.agent.username && p !== except).length
    } catch { return 1 }
  }

  onChat (msg: ChatMessage): void {
    this.memory.push({ kind: msg.whisper ? 'whisper' : 'chat', from: msg.from, text: msg.message })
    // Another brain (intents) already handles this message: keep it in memory for context only.
    if (msg.claimedBy) return
    this.route(msg)
  }

  /**
   * A line another brain claimed and then gave back (the intents brain when none of its slower
   * layers understood it): handled as if it had just arrived unclaimed. It's already in memory.
   */
  handoff (msg: ChatMessage): void {
    if (this.stopped) return
    this.route(msg)
  }

  private route (msg: ChatMessage): void {
    const t = this.opts.triggers ?? {}
    if ((t.ownersOnly ?? true) && !this.agent.isOwner(msg.from)) return
    const now = Date.now()
    const last = this.lastPlayerTurn.get(msg.from) ?? 0
    const listen = t.listen ?? (t.allChat ? 'all' : 'conversation')
    let trigger = chatTrigger(msg, this.agent.username, { commandPrefix: process.env.MC_PREFIX ?? '!', ...t, listen })
    // Follow-ups in an ongoing conversation don't need the bot's name.
    const prefix = process.env.MC_PREFIX ?? '!'
    const conversationMs = listen === 'mention' ? 0 : (t.conversationMs ?? 90_000)
    // Alone with an owner (nobody else on the server but bots we can't tell apart): whatever they say
    // in public chat is for us, as long as we listen beyond direct mentions.
    const aloneWithOwner = listen !== 'mention' && this.agent.isOwner(msg.from) && this.othersOnline(msg.from) === 0
    const inConversation = (aloneWithOwner || (last > 0 && now - last < conversationMs)) && !msg.message.trim().startsWith(prefix)
    if (inConversation && (!trigger || trigger.kind === 'chat' && trigger.addressed === false)) {
      trigger = { kind: 'chat', from: msg.from, message: msg.message.trim(), whisper: msg.whisper }
    }
    if (!trigger) return
    if (trigger.kind === 'chat' && trigger.addressed === false) return this.overheard(msg.from, trigger.message)
    // The owner spoke: renew the goal's autonomous limits and lift a pause (they may have answered).
    const goal = this.goals.active
    if (goal && (goal.owner ? goal.owner === msg.from : this.agent.isOwner(msg.from))) this.goals.touchOwner()
    const pending = this.queue.find((q): q is Extract<Trigger, { kind: 'chat' }> => q.kind === 'chat' && q.from === msg.from)
    if (pending) {
      // Coalesce: one pending turn per player, with everything they said since.
      pending.message = `${pending.message} / ${msg.message}`.slice(-600)
      return
    }
    const gap = now - last
    const cooldown = t.playerCooldownMs ?? 2500
    this.lastPlayerTurn.set(msg.from, now)
    if (gap < cooldown) {
      // Too fast: start the turn once the cooldown has passed (it merges anything said meanwhile).
      const delayed = trigger
      setTimeout(() => this.enqueue(delayed), cooldown - gap).unref()
      return
    }
    this.enqueue(trigger)
  }

  private ambient: string[] = []
  private ambientTimer: NodeJS.Timeout | null = null
  private lastAmbientTurn = 0

  /** listen 'all': batch overheard lines and start at most one turn per ambientMinGapMs. */
  private overheard (from: string, text: string): void {
    const t = this.opts.triggers ?? {}
    this.ambient.push(`<${from}> ${text}`)
    if (this.ambient.length > 20) this.ambient.shift()
    if (this.ambientTimer) return
    const wait = Math.max(t.ambientBatchMs ?? 4000, this.lastAmbientTurn + (t.ambientMinGapMs ?? 30_000) - Date.now())
    this.ambientTimer = setTimeout(() => {
      this.ambientTimer = null
      if (!this.ambient.length || this.stopped) return
      const lines = this.ambient.splice(0).join(' | ')
      this.lastAmbientTurn = Date.now()
      this.enqueue({ kind: 'chat', from: from, message: lines.slice(-800), whisper: false, addressed: false })
    }, wait)
    this.ambientTimer.unref()
  }

  onActionEnd (info: ActionInfo, result: ActionResult): void {
    if (info.caller.kind === 'reflex' && result.ok) return // eating and fending off mobs is routine
    const mine = info.caller.kind === 'brain' && info.caller.name === LLM_CALLER.name
    const who = mine ? 'you' : `${info.caller.kind} ${info.caller.name}`
    const line = `${info.name} (by ${who}) ${result.ok ? 'ok' : 'failed'}: ${result.message}`.slice(0, 200)
    this.memory.push({ kind: 'action', text: line })
    // A long-running action we started ran to its end (arrived, got stuck...): report the real
    // outcome. Not when it was preempted/replaced/stopped (that's someone else's doing).
    const def = this.agent.actionCatalog().find(a => a.name === info.name)
    const interrupted = /^(preempted|replaced|stopped|session ended|died|cancelled)/.test(result.message)
    this.lastActionEndAt = Date.now()
    const goal = this.goals.active
    if (goal) {
      // An owner's !stop ends the goal too (the model stopping its own action doesn't).
      if (info.name === 'stop' && info.caller.kind === 'player') {
        this.goals.abandon(`stopped by ${info.caller.name}`)
        this.log.info('goal dropped: owner said stop', { by: info.caller.name })
        return
      }
      if (mine && !result.ok && !interrupted) {
        const n = this.goals.recordFailure(failureSignature(info.name, result.message))
        if (n > 1) this.log.debug('repeated failure during goal', { action: info.name, times: n })
      }
      // Continue with the next step once this one is over (also covers long-running actions).
      if (mine && !interrupted) this.scheduleGoal('actionDone', line, this.goals.opts.continueDelayMs)
      return
    }
    if (mine && def?.longRunning && !interrupted && (this.opts.triggers?.reportLongActions ?? true)) {
      this.enqueue({ kind: 'event', event: 'actionDone', detail: line, ...(info.player ? { player: info.player } : {}) })
    }
  }

  // ---------------------------------------------------------------- goals

  private goalTimer: NodeJS.Timeout | null = null
  private goalWake: NodeJS.Timeout | null = null
  private goalWakeAt = 0
  private lastActionEndAt = 0

  /** The bot (re)connected: carry on with an active goal after a moment. */
  onSession (): void {
    if (this.goals.active) this.scheduleGoal('resume', 'reconnected', 8000)
  }

  /** Asks for a continuation turn in `delayMs` (an earlier request wins). */
  scheduleGoal (reason: GoalTriggerReason, detail?: string, delayMs = 0): void {
    if (this.stopped || !this.goals.active) return
    const at = Date.now() + delayMs
    if (this.goalWake && this.goalWakeAt <= at) return
    if (this.goalWake) clearTimeout(this.goalWake)
    this.goalWakeAt = at
    this.goalWake = setTimeout(() => {
      this.goalWake = null
      this.tryContinue(reason, detail)
    }, delayMs)
    this.goalWake.unref()
  }

  /** Starts a continuation turn if the guardrails allow it; pauses the goal and tells the owner when one trips. */
  tryContinue (reason: GoalTriggerReason, detail?: string): boolean {
    const goal = this.goals.active
    if (!goal || this.stopped) return false
    const d = continuationDecision(goal, this.goals.opts, {
      now: Date.now(),
      busy: this.busy || this.queue.length > 0,
      acting: this.bodyBusyForGoal(),
      connected: (this.agent as { connected?: boolean }).connected !== false,
      budgetBlocked: this.budget.blocked(),
      hour: this.budget.hour(),
      limits: { turnsPerHour: this.budget.turnsPerHour, tokensPerHour: this.budget.tokensPerHour }
    })
    if (d.go) {
      this.enqueue({ kind: 'goal', reason, ...(detail ? { detail } : {}), ...(goal.owner ? { player: goal.owner } : {}) })
      return true
    }
    if ('stop' in d && d.stop.startsWith('the same thing failed')) {
      // Repeated identical failure: put that action on hold for 10 min and carry on with other steps,
      // instead of stopping the whole goal (the owner may be away for hours).
      const g = this.goals.active!
      const [sig] = Object.entries(g.failures).sort((a, b) => b[1] - a[1])[0] ?? []
      if (sig) {
        const action = sig.split(':')[0]!
        this.tools.blocked.set(action, { until: Date.now() + 10 * 60_000, why: sig.slice(action.length + 1).trim().slice(0, 80) })
        delete g.failures[sig]
        this.goals.update({ note: `${action} on hold 10 min (failed the same way 3 times): do other steps meanwhile` })
        this.log.info(`goal: ${action} on hold for 10 min after repeated failures`, { goal: g.text })
        this.enqueue({ kind: 'goal', reason, ...(detail ? { detail } : {}), ...(g.owner ? { player: g.owner } : {}) })
        return true
      }
    }
    if ('stop' in d) {
      this.goals.pause(d.stop)
      this.log.info(`goal paused: ${d.stop}`, { goal: goal.text })
      this.enqueue({ kind: 'goal', reason: 'stop', detail: d.stop, ...(goal.owner ? { player: goal.owner } : {}) })
    } else {
      this.log.trace(`goal waits: ${d.wait}`)
    }
    return false
  }

  /**
   * Is the body busy in a way that should hold the goal back? Our own action, a player's command or a
   * reflex: yes. A behaviour (hunting, scouting, going home...) only while in danger (low health or
   * food, night, hostiles close): otherwise
   * an owner's goal outranks behaviours (see BotTools: goal turns for an owner run above them), and
   * waiting for the bot to be fully idle meant the goal never got a turn.
   */
  private bodyBusyForGoal (): boolean {
    const cur = this.agent.currentAction
    if (!cur) return false
    if (cur.caller.kind !== 'brain' || cur.caller.name === LLM_CALLER.name) return true
    if (cur.priority > PRIORITY.behavior) return true
    return inSessionAndDanger(this.agent)
  }

  private quotaTimer: NodeJS.Timeout | null = null
  /** While a provider quota is used up: announce the pause (NPC mode) and resume at the reset time. */
  private scheduleQuotaResume (announce: boolean): void {
    if (announce) {
      const when = new Date(this.quotaUntil).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })
      // Only the NPC-mode signal here: the owner was already told when the quota ran out.
      try { (this.agent as unknown as { emit: (ev: string, ...a: unknown[]) => void }).emit('llmPaused', `provider quota used up until ${when}`) } catch {}
    }
    if (this.quotaTimer) clearTimeout(this.quotaTimer)
    this.quotaTimer = setTimeout(() => {
      this.quotaTimer = null
      this.quotaUntil = 0
      try { this.agent.storage.delete('llm.quotaUntil') } catch {}
      this.paused = null
      this.pauseAnnounced = false
      this.log.info('provider quota reset time reached; LLM back on')
      try { this.opts.onResume?.() } catch (e) { this.log.warn(`onResume: ${(e as Error).message}`) }
      if (this.goals.active) this.scheduleGoal('resume', undefined, 5000)
    }, Math.max(1000, this.quotaUntil - Date.now() + 30_000))
    this.quotaTimer.unref?.()
  }

  /** Every few seconds: if a goal is active and nothing has happened for a while, nudge it (backoff grows with stalled turns). */
  private goalIdleCheck (): void {
    if (this.goals.resumeIfOwnerSilent()) this.log.info('owner silent; going on with the goal by myself')
    const goal = this.goals.active
    if (!goal || goal.paused || this.goalWake || this.busy || this.queue.length || this.bodyBusyForGoal()) return
    const quietFor = Date.now() - Math.max(this.lastTurnAt, this.lastActionEndAt)
    if (quietFor >= idleDelay(goal.stalls, this.goals.opts)) this.tryContinue('idle')
  }

  /** After each turn: count continuation turns, then line up the next one. */
  private afterTurn (report: TurnReport, startedAt: number): void {
    const goal = this.goals.active
    if (!goal) return
    if (report.trigger.kind === 'goal' && report.trigger.reason !== 'stop') {
      const acted = report.calls.some(c => c.ok && !NON_PROGRESS_TOOLS.has(c.name))
      const touched = goal.updatedAt >= startedAt && report.calls.some(c => c.ok && c.name === 'update_goal')
      this.goals.recordTurn(acted || touched)
    }
    if (report.skipped || report.error) return
    const g = this.goals.active
    if (!g || g.paused) return
    // Something still running (a long action we started, a player command): its actionEnd continues.
    if (this.bodyBusyForGoal()) return
    const progress = g.stalls === 0
    this.scheduleGoal('continue', undefined, progress ? this.goals.opts.continueDelayMs : idleDelay(g.stalls, this.goals.opts))
  }

  /** Something happened in the world. Recorded in memory; starts a turn if that event is enabled. */
  onEvent (event: 'hurt' | 'death' | 'playerJoined' | 'playerLeft', detail: string, player?: string): void {
    this.memory.push({ kind: 'event', text: detail })
    const enabled = (this.opts.triggers?.events as Record<string, boolean | undefined> | undefined)?.[event]
    if (enabled) this.enqueue({ kind: 'event', event, detail, player })
  }

  /** Autonomous tick (called by the brain's timer). */
  onTick (reason = 'idle'): void {
    if (this.busy || this.queue.length) return
    const t = this.opts.triggers ?? {}
    if ((t.tickWhenIdleOnly ?? true) && this.agent.currentAction) return
    this.enqueue({ kind: 'tick', reason })
  }

  // ---------------------------------------------------------------- queue

  enqueue (trigger: Trigger): void {
    if (this.stopped) return
    if (this.queue.length >= this.limits.queueSize) {
      // Drop the oldest non-chat trigger first; chat from people matters more than ticks.
      const i = this.queue.findIndex(q => q.kind !== 'chat')
      if (i >= 0) this.queue.splice(i, 1)
      else if (trigger.kind === 'chat') this.queue.shift()
      else return
    }
    if (trigger.kind === 'chat') {
      const firstOther = this.queue.findIndex(q => q.kind !== 'chat')
      if (firstOther >= 0) this.queue.splice(firstOther, 0, trigger)
      else this.queue.push(trigger)
    } else {
      this.queue.push(trigger)
    }
    void this.pump()
  }

  /** Resolves when no turn is running and nothing is queued. */
  idle (): Promise<void> {
    if (!this.busy && !this.queue.length) return Promise.resolve()
    return new Promise(resolve => this.idleWaiters.push(resolve))
  }

  get isBusy (): boolean {
    return this.busy
  }

  private async pump (): Promise<void> {
    if (this.busy) return
    const next = this.queue.shift()
    if (!next) {
      for (const w of this.idleWaiters.splice(0)) w()
      return
    }
    this.busy = true
    const startedAt = Date.now()
    try {
      const report = await this.runTurn(next)
      this.reports.push(report)
      if (this.reports.length > 20) this.reports.shift()
      this.busy = false
      try { this.afterTurn(report, startedAt) } catch (e) { this.log.warn(`goal follow-up: ${(e as Error).message}`) }
    } finally {
      this.busy = false
      void this.pump()
    }
  }

  // ---------------------------------------------------------------- turn

  async runTurn (trigger: Trigger): Promise<TurnReport> {
    const chat = trigger.kind === 'chat' ? trigger : null
    if (this.unavailable) return { trigger, calls: [], skipped: this.unavailable }
    const blocked = this.budget.blocked() ?? (this.quotaUntil > Date.now() ? `provider quota used up until ${new Date(this.quotaUntil).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : null)
    if (blocked) {
      // Pause: log once, tell the first person who talks to the bot once, then stay quiet until it lifts.
      if (!this.paused) {
        this.log.warn(`paused: ${blocked}`, { reason: blocked })
        try { this.opts.onPause?.(blocked) } catch (e) { this.log.warn(`onPause: ${(e as Error).message}`) }
      }
      this.paused = blocked
      if (chat && !this.pauseAnnounced) {
        this.pauseAnnounced = true
        const text = `I'm taking a thinking break (${blocked}). !commands still work`
        if (chat.whisper) this.agent.whisper(chat.from, text)
        else this.agent.say(text)
      }
      return { trigger, calls: [], skipped: blocked }
    }
    if (this.paused) {
      this.log.info('resumed, budget available again')
      try { this.opts.onResume?.() } catch (e) { this.log.warn(`onResume: ${(e as Error).message}`) }
      this.paused = null
      this.pauseAnnounced = false
    }

    const goalText = this.goals.active?.text
    const query = chat ? chat.message : trigger.kind === 'event' ? trigger.detail : trigger.kind === 'goal' ? (goalText ?? '') : ''
    const system = this.systemPrompt
    // With a context pack, MEMORY.md is in the system prompt; only add notes if it was cut short there.
    const memoryInPrompt = !!this.opts.context?.()?.memoryInPrompt
    const notes = memoryInPrompt ? [] : [...new Set([...this.memory.recall(query, 5), ...this.memory.recall(undefined, 3)])]
    const spent = this.budget.hour()
    const userMessage = buildUserMessage({
      trigger,
      observation: this.agent.observe(),
      recent: this.memory.recent(20),
      summary: this.memory.summary,
      notes,
      goal: this.goals.fmtPrompt(),
      history: this.goals.fmtHistory(),
      budgetNote: this.budget.turnsPerHour > 0 && spent.turns > this.budget.turnsPerHour * 0.8 ? 'Running low on thinking budget this hour: be brief, few tool calls.' : undefined
    })
    const player = chat?.from ?? (trigger.kind === 'event' || trigger.kind === 'goal' ? trigger.player : undefined)
    const goalNow = this.goals.active
    const replyTo = chat
      ? { from: chat.from, whisper: chat.whisper }
      : trigger.kind === 'goal' && goalNow?.owner ? { from: goalNow.owner, whisper: !!goalNow.whisper } : undefined
    this.tools.begin({
      player,
      ...(chat ? { speaker: chat.from } : {}),
      replyTo,
      maxToolCalls: this.limits.maxToolCalls,
      maxChatMessages: this.limits.maxChatMessages
    })
    const controller = new AbortController()
    this.current = controller
    const started = Date.now()
    this.log.trace('prompt', { system, user: userMessage })
    let result: TurnResult | undefined
    let error: string | undefined
    try {
      const retry = this.opts.retry ?? { attempts: 2, backoffMs: [2000, 20_000] as [number, number] }
      for (let attempt = 0; ; attempt++) {
        try {
          result = await this.provider.run({
            system,
            userMessage,
            tools: this.tools,
            mcp: this.bridge ? { url: this.bridge.url, token: this.bridge.token, serverName: 'minecraft' } : undefined,
            maxTurns: this.limits.maxTurns,
            timeoutMs: this.limits.turnTimeoutMs,
            signal: controller.signal
          })
          break
        } catch (e) {
          // Retry transient provider errors, but only if nothing happened in the world yet
          // (re-running a turn that already acted would repeat its actions).
          const msg = (e as Error).message
          const acted = (this.tools.active?.calls.length ?? 0) > 0
          if (attempt >= retry.attempts || acted || controller.signal.aborted || !isTransientLlmError(msg)) throw e
          const wait = backoffMs(attempt, retry.backoffMs)
          this.log.info(`provider error, retrying in ${Math.round(wait / 1000)}s`, { attempt: attempt + 1, of: retry.attempts, error: msg.slice(0, 160) })
          await new Promise(r => setTimeout(r, wait))
        }
      }
    } catch (e) {
      error = (e as Error).message
      const acted = (this.tools.active?.calls.length ?? 0) > 0
      if (/max_turns|max turns|maximum number of turns/i.test(error) && acted) {
        // The model ran out of steps for this turn after doing real work: not a failure the
        // player needs to hear about. Goals continue on their own; otherwise the work stands.
        this.log.info('turn hit its step limit after acting', { provider: this.provider.name, calls: this.tools.active?.calls.length })
        error = undefined
      } else if (quotaUntil(error) !== null) {
        // Subscription or API quota used up ("weekly limit", "usage limit ... resets 12pm"): every
        // further turn would fail the same way, so pause until the reset (or an hour if unknown).
        const until = quotaUntil(error)!
        this.quotaUntil = until
        try { this.agent.storage.set('llm.quotaUntil', until) } catch {}
        this.scheduleQuotaResume(false)
        const when = new Date(until).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })
        this.log.warn(`provider quota used up; LLM paused until ${when}`, { provider: this.provider.name, error: error.slice(0, 160) })
        try { this.opts.onPause?.(`provider quota: ${error.slice(0, 120)}`) } catch {}
        if (chat) this.notice(chat, `my LLM quota is used up until ${when}; my reflexes, behaviours and !commands still work`)
      } else {
        this.log.warn(`turn failed: ${error}`, { provider: this.provider.name })
        if (chat) this.notice(chat, acted ? "I got partway and lost the thread; say 'continue' or check !goal" : 'my LLM call failed just now, try again in a bit (or use !commands)')
      }
    } finally {
      this.current = null
      this.lastTurnAt = Date.now()
    }
    const scope = this.tools.end()
    const calls = scope?.calls ?? []
    const proxy = this.opts.proxyMetrics ? await this.opts.proxyMetrics.delta().catch(() => undefined) : undefined
    const usage = this.account({ result, ok: !error, calls, system, userMessage, durationMs: Date.now() - started, trigger: describe(trigger), proxy })
    if (result && chat && chat.addressed !== false && (this.opts.replyWithFinalText ?? true) && scope && scope.chatCount === 0 && result.text) {
      const text = result.text.replace(/\s+/g, ' ').trim().slice(0, 400)
      if (chat.whisper) this.agent.whisper(chat.from, text)
      else this.agent.say(text)
      this.memory.push({ kind: 'self', text })
    }
    // A goal finished in a turn where the model didn't chat: the owner still hears the result.
    if (result && goalNow && !this.goals.active && scope && scope.chatCount === 0 && replyTo) {
      const last = this.goals.history().at(-1)
      const text = (result.text.trim() || (last ? `${last.status === 'done' ? 'done' : 'stopped'}: ${last.result}` : '')).replace(/\s+/g, ' ').slice(0, 400)
      if (text) {
        if (replyTo.whisper) this.agent.whisper(replyTo.from, text)
        else this.agent.say(text)
        this.memory.push({ kind: 'self', text })
      }
    }
    if (result) this.log.trace('response', { text: result.text, detail: result.detail })
    this.log.info(`llm turn: ${fmtTurn(usage)}`, {
      in: usage.inputTokens,
      out: usage.outputTokens,
      cached: usage.cacheReadTokens,
      cacheWrite: usage.cacheWriteTokens,
      tools: usage.toolCalls,
      ms: usage.durationMs,
      usd: usage.costUsd,
      cliUsd: usage.reportedCostUsd,
      estimated: usage.estimated || undefined,
      provider: usage.provider,
      model: usage.model,
      billing: usage.billing,
      trigger: describe(trigger),
      calls: calls.map(c => `${c.name}${c.ok ? '' : '!'}`).join(' ') || undefined,
      detail: result?.detail,
      ok: !error
    })
    return { trigger, result, usage, error, calls }
  }

  /** Turns provider usage (or an estimate) into a TurnUsage, records it in the counters and budget, and notifies. */
  private account (a: { result?: TurnResult, ok: boolean, calls: ToolCallRecord[], system: string, userMessage: string, durationMs: number, trigger?: string, proxy?: Record<string, number> }): TurnUsage {
    const usage = turnUsage({
      provider: this.provider.name,
      model: this.provider.model,
      billing: this.provider.billing,
      reported: a.result?.usage,
      // Estimation input: what went in (prompt + tool results) and out (text + tool arguments).
      inText: a.system + a.userMessage + a.calls.map(c => c.result).join(''),
      outText: (a.result?.text ?? '') + a.calls.map(c => c.name + JSON.stringify(c.args)).join(''),
      toolCalls: a.calls.length,
      durationMs: a.durationMs,
      ok: a.ok,
      price: (u, model) => this.prices.cost(u, model)
    })
    // A failed turn that reported nothing still counts as a turn, but not with made-up tokens.
    if (!a.ok && usage.estimated) { usage.inputTokens = 0; usage.outputTokens = 0 }
    if (a.trigger) usage.trigger = a.trigger.slice(0, 80)
    if (a.proxy && Object.keys(a.proxy).length) usage.proxy = a.proxy
    this.usage.record(usage)
    this.budget.record(usage)
    try { this.opts.onUsage?.(this.snapshot()) } catch (e) { this.log.warn(`onUsage: ${(e as Error).message}`) }
    return usage
  }

  /** One line for !llm_usage. */
  summary (): string {
    return fmtSummary(this.snapshot()) + (this.paused ? `; paused: ${this.paused}` : '')
  }

  /** Rate-limited out-of-band message (budget exhausted, provider errors): at most one per 5 minutes. */
  private notice (chat: Extract<Trigger, { kind: 'chat' }>, text: string): void {
    if (Date.now() - this.lastNotice < 300_000) return
    this.lastNotice = Date.now()
    if (chat.whisper) this.agent.whisper(chat.from, text)
    else this.agent.say(text)
  }
}

/** Tools that don't move a goal forward on their own (looking and talking). */
const NON_PROGRESS_TOOLS = new Set(['observe', 'reply', 'say', 'whisper', 'recent_chat', 'recall', 'remember', 'goal_status', 'inventory', 'build_plan', 'pos', 'hp'])

function describe (t: Trigger): string {
  if (t.kind === 'chat') return `${t.whisper ? 'whisper' : 'chat'} from ${t.from}`
  if (t.kind === 'tick') return `tick: ${t.reason}`
  if (t.kind === 'goal') return `goal: ${t.reason}`
  return `event: ${t.event}`
}

/**
 * When a provider error means the quota is used up, the time it resets (ms), else null.
 * "You've hit your weekly limit · resets 12pm (Europe/Sofia)", "usage limit reached ... resets at 3:00 PM",
 * "rate_limit_error ... try again in 20 minutes". Unknown reset time: an hour from now.
 */
export function quotaUntil (error: string, now = Date.now()): number | null {
  if (!/(weekly|daily|monthly|usage|session) limit|hit your limit|quota (exceeded|used)|out of (credits|quota)|credit balance is too low/i.test(error)) return null
  const mins = /try again in (\d+) ?min/i.exec(error)
  if (mins) return now + Number(mins[1]) * 60_000
  const at = /resets?(?: at)? (\d{1,2})(?::(\d\d))? ?(am|pm)?/i.exec(error)
  if (at) {
    let h = Number(at[1]) % 12
    if (at[3]?.toLowerCase() === 'pm') h += 12
    if (!at[3] && Number(at[1]) >= 12) h = Number(at[1])
    const d = new Date(now)
    d.setHours(h, Number(at[2] ?? 0), 0, 0) // local time (the CLI reports the user's zone)
    if (d.getTime() <= now) d.setDate(d.getDate() + 1)
    return d.getTime()
  }
  return now + 3_600_000
}
