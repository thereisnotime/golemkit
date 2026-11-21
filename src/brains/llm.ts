// LLM brain: lets a language model drive the bot. Players talk to it (mention its name or
// whisper), optionally it acts on its own on a timer or on events, and it acts through the
// same actions as everything else, at PRIORITY.llm (above NPC loops, below player commands
// and reflexes). Providers: Claude subscription, Codex, Anthropic API, OpenCode,
// OpenAI-compatible endpoints. See docs/llm-brain.md.
//
//   brains: [commandBrain(), reflexes(), llmBrain({ provider: 'claude-subscription' })]
import type { Agent } from '../core/index.ts'
import { defineBrain, defineAction, noParams, ok, fail } from '../core/index.ts'
import type { Price } from '../llm/pricing.ts'
import { sumBuckets, fmtTotals, type UsageBucket } from '../llm/usage.ts'
import { createProvider } from '../llm/providers/index.ts'
import { ProxyMetrics } from '../llm/proxyMetrics.ts'
import { CAVEMAN_URL } from '../llm/providers/proc.ts'
import { LlmRuntime, type LimitOptions, type RuntimeOptions, type TriggerOptions } from '../llm/runtime.ts'
import type { LlmProvider } from '../llm/types.ts'
import type { MemoryOptions } from '../llm/memory.ts'
import type { BotToolsOptions } from '../llm/tools.ts'
import { contextFor, disposeContext, emitLlmBudgetExhausted } from '../context/handle.ts'
import { skillTools } from '../context/skills.ts'
import type { GoalOptions } from '../llm/goals.ts'

export interface LlmBrainOptions {
  /** A provider instance, or a name: claude-subscription | codex | anthropic | opencode | openai. Default MC_LLM_PROVIDER or claude-subscription. */
  provider?: LlmProvider | string
  /** Stay in character and don't break the fourth wall (reports stay truthful). Default false. Profile: llm.immersive. */
  immersive?: boolean
  /** Options for a provider given by name (model, effort, ...). */
  providerOptions?: Record<string, unknown>
  model?: string
  /** Overrides definition.persona. */
  persona?: string
  /** Extra system-prompt rules. */
  rules?: string
  triggers?: TriggerOptions
  /** Shorthand for triggers.tickMs. */
  tickMs?: number
  /** Turn limits and the hourly budget. */
  budget?: LimitOptions
  memory?: MemoryOptions
  tools?: BotToolsOptions
  mcp?: RuntimeOptions['mcp']
  replyWithFinalText?: boolean
  /** Price overrides for cost estimates, USD per million tokens. */
  prices?: Record<string, Price>
  /** Persistent goals and continuation limits (maxTurns, timeoutMin, ...). Profile: llm.goals. */
  goals?: GoalOptions
}

// Every agent with an llm brain, for llmRuntime() and the llm_usage action.
const allRuntimes = new Map<Agent, LlmRuntime>()

/** The LLM runtime of an agent (usage counters, memory, budget), or undefined if it has no llm brain. */
export function llmRuntime (agent: Agent): LlmRuntime | undefined {
  return allRuntimes.get(agent)
}

/** Usage summed over the LLM bots in an agent's fleet (all servers). */
export function llmFleetUsage (agent: Agent): { bots: number, session: UsageBucket, today: UsageBucket, allTime: UsageBucket } {
  let agents: Agent[] = [agent]
  try { agents = agent.fleet.agents } catch {}
  const rts = agents.map(a => allRuntimes.get(a)).filter((r): r is LlmRuntime => !!r)
  return {
    bots: rts.length,
    session: sumBuckets(rts.map(r => r.usage.session)),
    today: sumBuckets(rts.map(r => r.usage.today)),
    allTime: sumBuckets(rts.map(r => r.usage.allTime))
  }
}

/** `!goal`: the LLM brain's active goal and plan. */
export const goalStatusAction = defineAction({
  name: 'goal',
  description: 'Show the LLM brain\'s active goal and plan.',
  params: noParams,
  exclusive: false,
  aliases: ['goal_status'],
  run: ({ agent }) => {
    const rt = allRuntimes.get(agent)
    if (!rt) return fail('no LLM brain on this bot')
    return ok(rt.goals.fmtPrompt()?.replace(/\n/g, ' | ') ?? 'no active goal')
  }
})

/** `!goal_cancel`: drop the active goal (stops follow-up turns; the current action keeps going unless you also !stop). */
export const goalCancelAction = defineAction({
  name: 'goal_cancel',
  description: 'Drop the LLM brain\'s active goal so it stops working on it.',
  params: noParams,
  exclusive: false,
  run: ({ agent, caller }) => {
    const rt = allRuntimes.get(agent)
    if (!rt) return fail('no LLM brain on this bot')
    const g = rt.goals.abandon(`cancelled by ${caller.name}`)
    if (!g) return ok('no active goal')
    agent.cancelActions(info => info.caller.kind === 'brain' && info.caller.name === 'llm', 'cancelled')
    return ok(`dropped the goal: ${g.text}`)
  }
})

/** `!llm_usage`: one-line token/cost summary. Registered on agents that run an llm brain. */
export const llmUsageAction = defineAction({
  name: 'llm_usage',
  description: 'Show the LLM brain\'s token usage and cost: today, since start, all time.',
  params: noParams,
  exclusive: false,
  aliases: ['tokens'],
  run: ({ agent }) => {
    const rt = allRuntimes.get(agent)
    if (!rt) return fail('no LLM brain on this bot')
    const fleet = llmFleetUsage(agent)
    const fleetLine = fleet.bots > 1 ? `; fleet (${fleet.bots} bots) today ${fmtTotals(fleet.today, rt.provider.billing)}` : ''
    return ok(rt.summary() + fleetLine)
  }
})

export const llmBrain = (opts: LlmBrainOptions = {}) => {
  // Brains can be shared by several agents (fleet `count`), so state is per agent.
  const runtimes = new Map<Agent, LlmRuntime>()

  /**
   * A profile (or fleet entry) can tune the brain through `settings.llm`:
   *   provider, model, effort, login, oauthTokenVar, oauthTokenFile   -> provider
   *   listen, aliases, conversationMs, ownersOnly, tickMs              -> triggers
   *   budget: { turnsPerHour, tokensPerHour, ... }                     -> limits
   * Profile values win over the variant's code defaults.
   */
  const fromSettings = (agent: Agent) => (agent.settings.llm ?? {}) as Record<string, any>

  const makeProvider = (agent: Agent): LlmProvider => {
    const s = fromSettings(agent)
    const p = s.provider ?? opts.provider ?? process.env.MC_LLM_PROVIDER ?? 'claude-subscription'
    if (typeof p !== 'string') return p
    const providerKeys = ['model', 'effort', 'login', 'profile', 'oauthTokenVar', 'oauthTokenFile', 'mode', 'transport', 'baseUrl', 'reasoningEffort', 'proxy']
    const fromProfile = Object.fromEntries(providerKeys.filter(k => s[k] !== undefined).map(k => [k, s[k]]))
    return createProvider(p, { ...(opts.model ? { model: opts.model } : {}), ...opts.providerOptions, ...fromProfile })
  }

  return defineBrain({
    name: 'llm',
    async start (agent) {
      const s = fromSettings(agent)
      const triggerKeys = ['listen', 'aliases', 'conversationMs', 'ownersOnly', 'tickMs', 'mention', 'whisper', 'ambientBatchMs', 'ambientMinGapMs', 'playerCooldownMs']
      const triggersFromProfile = Object.fromEntries(triggerKeys.filter(k => s[k] !== undefined).map(k => [k, s[k]]))
      // Context pack (profile `context:` / profiles/<name>/): prompt sections, MEMORY.md as the
      // note store, list_skills/read_skill when it has skills. See docs/guide/context-pack.md.
      const ctx = contextFor(agent)
      const extra = ctx && ctx.pack.skills.length ? skillTools(() => ctx.pack.skills) : []
      const rt = new LlmRuntime(agent, {
        provider: makeProvider(agent),
        persona: opts.persona,
        immersive: s.immersive ?? opts.immersive ?? false,
        retry: agent.retry.llm,
        rules: opts.rules,
        triggers: { ...opts.triggers, ...(opts.tickMs !== undefined ? { tickMs: opts.tickMs } : {}), ...triggersFromProfile },
        limits: { ...opts.budget, ...(s.budget ?? {}) },
        memory: { ...opts.memory, ...(ctx?.pack.memory ? { store: ctx.pack.memory } : {}) },
        tools: { exclude: ['llm_usage', 'context_status'], ...opts.tools, extra: [...extra, ...(opts.tools?.extra ?? [])] },
        mcp: opts.mcp,
        replyWithFinalText: opts.replyWithFinalText,
        prices: opts.prices,
        goals: { ...opts.goals, ...(s.goals ?? {}) },
        onUsage: snapshot => agent.emit('llmUsage', snapshot),
        // Per-turn proxy metrics in the journal (caveman or a gateway with /metrics).
        ...(() => {
          const px = (s.proxy ?? process.env.MC_LLM_PROXY) as string | undefined
          if (!px || px === 'none' || px === 'off' || s.proxyMetrics === false) return {}
          try { return { proxyMetrics: ProxyMetrics.forBase(px === 'caveman' ? CAVEMAN_URL : px) } } catch { return {} }
        })(),
        ...(ctx ? { context: () => ctx.promptContext() } : {}),
        onPause: reason => { emitLlmBudgetExhausted(agent, reason); (agent.emit as (ev: string, ...a: unknown[]) => void)('llmPaused', reason) },
        onResume: () => (agent.emit as (ev: string, ...a: unknown[]) => void)('llmResumed')
      })
      runtimes.set(agent, rt)
      allRuntimes.set(agent, rt)
      for (const a of [llmUsageAction, goalStatusAction, goalCancelAction]) if (!agent.getAction(a.name)) agent.registerAction(a)
      await rt.start()
      agent.on('chat', msg => rt.onChat(msg))
      agent.on('settingsChanged', () => rt.applySettings(fromSettings(agent)))
      agent.on('actionEnd', (info, result) => rt.onActionEnd(info, result))
    },

    session (agent, bot) {
      const rt = runtimes.get(agent)
      if (!rt) return
      const spawnedAt = Date.now()
      let lastHurt = 0
      rt.onSession()

      const onHurt = (entity: any) => {
        if (entity !== bot.entity || Date.now() - lastHurt < 60_000) return
        lastHurt = Date.now()
        rt.onEvent('hurt', `you got hurt, health now ${Math.round(bot.health)}/20`)
      }
      const onDeath = () => rt.onEvent('death', 'you died and respawned')
      const onJoin = (p: { username: string }) => {
        // The player list is replayed on spawn; only count real joins.
        if (p.username === bot.username || Date.now() - spawnedAt < 10_000) return
        rt.onEvent('playerJoined', `${p.username} joined the game`, p.username)
      }
      const onLeave = (p: { username: string }) => {
        if (p.username !== bot.username) rt.onEvent('playerLeft', `${p.username} left the game`, p.username)
      }
      bot.on('entityHurt', onHurt)
      bot.on('death', onDeath)
      bot.on('playerJoined', onJoin)
      bot.on('playerLeft', onLeave)

      const tickMs = opts.tickMs ?? opts.triggers?.tickMs ?? 0
      const timer = tickMs > 0
        ? setInterval(() => { if (Date.now() - rt.lastTurnAt >= tickMs) rt.onTick(`${Math.round(tickMs / 60_000)} min check-in`) }, Math.min(tickMs, 15_000))
        : null

      return () => {
        bot.off('entityHurt', onHurt)
        bot.off('death', onDeath)
        bot.off('playerJoined', onJoin)
        bot.off('playerLeft', onLeave)
        if (timer) clearInterval(timer)
      }
    },

    observe (agent) {
      const rt = runtimes.get(agent)
      return rt ? { llm: rt.observeField() } : {}
    },

    async stop (agent) {
      await runtimes.get(agent)?.stop()
      runtimes.delete(agent)
      allRuntimes.delete(agent)
      disposeContext(agent)
    }
  })
}

/** The runtime behind an agent's llm brain, for scripts and debugging. */
export type { LlmRuntime }
