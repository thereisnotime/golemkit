// Per-bot LLM runtime: trigger queue, one-turn-at-a-time lock, budgets, memory, tools and
// the optional MCP bridge. The llm brain (src/brains/llm.ts) wires agent events into it;
// tests drive it directly with a fake agent and a fake provider.
import type { Agent, ActionInfo, ActionResult, ChatMessage, Logger } from '../core/index.ts'
import { Budget, type BudgetOptions } from './budget.ts'
import { startMcpHttp, type McpHttpBridge } from './mcp.ts'
import { Memory, type MemoryOptions } from './memory.ts'
import { buildSystemPrompt, buildUserMessage, chatTrigger, type ChatTriggerOptions, type Trigger } from './prompt.ts'
import { BotTools, LLM_CALLER, type BotToolsOptions, type ToolAgent } from './tools.ts'
import type { LlmProvider, ToolCallRecord, TurnResult } from './types.ts'
import { PriceTable, type Price } from './pricing.ts'
import { UsageTracker, fmtTurn, fmtCost, fmtSummary, turnUsage, type TurnUsage, type UsageSnapshot } from './usage.ts'

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
  /** Ignore chat turns from the same player more often than this. Default 2500 ms. */
  playerCooldownMs?: number
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
  persona?: string
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
  /** Why turns are paused (budget exhausted), or null. */
  paused: string | null = null
  private pauseAnnounced = false
  bridge: McpHttpBridge | null = null
  /** Set when provider.check() failed; turns are skipped. */
  unavailable: string | null = null
  readonly reports: TurnReport[] = []
  // Logger `<username>/llm`; tune it with MC_LOG_LEVEL rules on the llm component.
  readonly log: Logger

  private readonly opts: RuntimeOptions
  private readonly limits: Required<Omit<LimitOptions, keyof BudgetOptions>>
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
    const l = opts.limits ?? {}
    this.limits = {
      maxTurns: l.maxTurns ?? 8,
      maxToolCalls: l.maxToolCalls ?? 12,
      maxChatMessages: l.maxChatMessages ?? 3,
      turnTimeoutMs: l.turnTimeoutMs ?? 120_000,
      queueSize: l.queueSize ?? 3
    }
  }

  get systemPrompt (): string {
    return buildSystemPrompt({
      username: this.agent.username,
      persona: this.opts.persona ?? this.agent.definition.persona,
      rules: this.opts.rules
    })
  }

  /** Checks the provider and starts the MCP bridge if needed. */
  async start (): Promise<void> {
    this.unavailable = await this.provider.check().catch(e => (e as Error).message)
    if (this.unavailable) this.log.warn(`provider ${this.provider.name} unavailable: ${this.unavailable}`, { provider: this.provider.name })
    if (this.provider.needsMcp || this.opts.mcp?.expose) {
      const port = this.opts.mcp?.port ?? 0
      this.bridge = await startMcpHttp(this.tools, { port, token: this.opts.mcp?.token, name: `mc-buddy-${this.agent.username}` })
      // The token is a local secret; print it only when the user asked to expose the bridge.
      if (this.opts.mcp?.expose) this.log.info(`MCP bridge on ${this.bridge.url} (Authorization: Bearer ${this.bridge.token})`, { url: this.bridge.url })
      else this.log.debug('MCP bridge started', { url: this.bridge.url })
    }
    this.log.info(`LLM brain ready: ${this.provider.name}${this.unavailable ? ' (unavailable)' : ''}`, { provider: this.provider.name, model: this.provider.model, billing: this.provider.billing })
  }

  async stop (): Promise<void> {
    this.stopped = true
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
      lastTurn: this.usage.last ? fmtTurn(this.usage.last) : null
    }
  }

  // ---------------------------------------------------------------- inputs

  onChat (msg: ChatMessage): void {
    this.memory.push({ kind: msg.whisper ? 'whisper' : 'chat', from: msg.from, text: msg.message })
    const t = this.opts.triggers ?? {}
    if ((t.ownersOnly ?? true) && !this.agent.isOwner(msg.from)) return
    const trigger = chatTrigger(msg, this.agent.username, { commandPrefix: process.env.MC_PREFIX ?? '!', ...t })
    if (!trigger) return
    const now = Date.now()
    const last = this.lastPlayerTurn.get(msg.from) ?? 0
    const pending = this.queue.find((q): q is Extract<Trigger, { kind: 'chat' }> => q.kind === 'chat' && q.from === msg.from)
    if (pending) {
      // Coalesce: one pending turn per player, with everything they said since.
      pending.message = `${pending.message} / ${msg.message}`.slice(-600)
      return
    }
    if (now - last < (t.playerCooldownMs ?? 2500)) return
    this.lastPlayerTurn.set(msg.from, now)
    this.enqueue(trigger)
  }

  onActionEnd (info: ActionInfo, result: ActionResult): void {
    if (info.caller.kind === 'reflex' && result.ok) return // eating and fending off mobs is routine
    const who = info.caller.kind === 'brain' && info.caller.name === LLM_CALLER.name ? 'you' : `${info.caller.kind} ${info.caller.name}`
    this.memory.push({ kind: 'action', text: `${info.name} (by ${who}) ${result.ok ? 'ok' : 'failed'}: ${result.message}`.slice(0, 200) })
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
    try {
      const report = await this.runTurn(next)
      this.reports.push(report)
      if (this.reports.length > 20) this.reports.shift()
    } finally {
      this.busy = false
      void this.pump()
    }
  }

  // ---------------------------------------------------------------- turn

  async runTurn (trigger: Trigger): Promise<TurnReport> {
    const chat = trigger.kind === 'chat' ? trigger : null
    if (this.unavailable) return { trigger, calls: [], skipped: this.unavailable }
    const blocked = this.budget.blocked()
    if (blocked) {
      // Pause: log once, tell the first person who talks to the bot once, then stay quiet until it lifts.
      if (!this.paused) this.log.warn(`paused: ${blocked}`, { reason: blocked })
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
      this.paused = null
      this.pauseAnnounced = false
    }

    const query = chat ? chat.message : trigger.kind === 'event' ? trigger.detail : ''
    const notes = [...new Set([...this.memory.recall(query, 5), ...this.memory.recall(undefined, 3)])]
    const spent = this.budget.hour()
    const userMessage = buildUserMessage({
      trigger,
      observation: this.agent.observe(),
      recent: this.memory.recent(20),
      summary: this.memory.summary,
      notes,
      budgetNote: this.budget.turnsPerHour > 0 && spent.turns > this.budget.turnsPerHour * 0.8 ? 'Running low on thinking budget this hour: be brief, few tool calls.' : undefined
    })
    const player = chat?.from ?? (trigger.kind === 'event' ? trigger.player : undefined)
    this.tools.begin({
      player,
      replyTo: chat ? { from: chat.from, whisper: chat.whisper } : undefined,
      maxToolCalls: this.limits.maxToolCalls,
      maxChatMessages: this.limits.maxChatMessages
    })
    const controller = new AbortController()
    this.current = controller
    const started = Date.now()
    const system = this.systemPrompt
    this.log.trace('prompt', { system, user: userMessage })
    let result: TurnResult | undefined
    let error: string | undefined
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
    } catch (e) {
      error = (e as Error).message
      this.log.warn(`turn failed: ${error}`, { provider: this.provider.name })
      if (chat) this.notice(chat, 'sorry, my head is foggy right now. try again in a bit, or use !commands')
    } finally {
      this.current = null
      this.lastTurnAt = Date.now()
    }
    const scope = this.tools.end()
    const calls = scope?.calls ?? []
    const usage = this.account({ result, ok: !error, calls, system, userMessage, durationMs: Date.now() - started })
    if (result && chat && (this.opts.replyWithFinalText ?? true) && scope && scope.chatCount === 0 && result.text) {
      const text = result.text.replace(/\s+/g, ' ').trim().slice(0, 400)
      if (chat.whisper) this.agent.whisper(chat.from, text)
      else this.agent.say(text)
      this.memory.push({ kind: 'self', text })
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
  private account (a: { result?: TurnResult, ok: boolean, calls: ToolCallRecord[], system: string, userMessage: string, durationMs: number }): TurnUsage {
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

function describe (t: Trigger): string {
  if (t.kind === 'chat') return `${t.whisper ? 'whisper' : 'chat'} from ${t.from}`
  if (t.kind === 'tick') return `tick: ${t.reason}`
  return `event: ${t.event}`
}
