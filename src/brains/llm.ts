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
import { LlmRuntime, type LimitOptions, type RuntimeOptions, type TriggerOptions } from '../llm/runtime.ts'
import type { LlmProvider } from '../llm/types.ts'
import type { MemoryOptions } from '../llm/memory.ts'
import type { BotToolsOptions } from '../llm/tools.ts'

export interface LlmBrainOptions {
  /** A provider instance, or a name: claude-subscription | codex | anthropic | opencode | openai. Default MC_LLM_PROVIDER or claude-subscription. */
  provider?: LlmProvider | string
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

  const makeProvider = (): LlmProvider => {
    const p = opts.provider ?? process.env.MC_LLM_PROVIDER ?? 'claude-subscription'
    if (typeof p !== 'string') return p
    return createProvider(p, { ...(opts.model ? { model: opts.model } : {}), ...opts.providerOptions })
  }

  return defineBrain({
    name: 'llm',
    async start (agent) {
      const rt = new LlmRuntime(agent, {
        provider: makeProvider(),
        persona: opts.persona,
        rules: opts.rules,
        triggers: { ...opts.triggers, ...(opts.tickMs !== undefined ? { tickMs: opts.tickMs } : {}) },
        limits: opts.budget,
        memory: opts.memory,
        tools: opts.tools,
        mcp: opts.mcp,
        replyWithFinalText: opts.replyWithFinalText,
        prices: opts.prices,
        onUsage: snapshot => agent.emit('llmUsage', snapshot)
      })
      runtimes.set(agent, rt)
      allRuntimes.set(agent, rt)
      if (!agent.getAction(llmUsageAction.name)) agent.registerAction(llmUsageAction)
      await rt.start()
      agent.on('chat', msg => rt.onChat(msg))
      agent.on('actionEnd', (info, result) => rt.onActionEnd(info, result))
    },

    session (agent, bot) {
      const rt = runtimes.get(agent)
      if (!rt) return
      const spawnedAt = Date.now()
      let lastHurt = 0

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
    }
  })
}

/** The runtime behind an agent's llm brain, for scripts and debugging. */
export type { LlmRuntime }
