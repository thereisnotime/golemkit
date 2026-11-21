// LLM companion: talk to it by name or whisper, and a language model decides what to say
// and which actions to take. !commands and reflexes keep working and outrank the model,
// so `!stop` always stops it.
//
//   MC_LLM_PROVIDER=codex just run companion
//   just run pax                      (profiles/pax.yaml: this variant + Sonnet + subscription token)
//
// Providers: claude-subscription (default) | codex | anthropic | opencode | openai.
// A profile's `llm:` block (provider, model, login, listen, budget...) overrides these
// defaults. A context pack (profiles/<name>/: AGENTS.md, USER.md, skills/, hooks.yaml,
// MEMORY.md) is loaded automatically. See docs/guide/llm-brain.md, docs/guide/profiles.md
// and docs/guide/context-pack.md.
//
// The behaviours brain keeps keep_fed and stay_safe armed, so the companion feeds itself and
// backs off at low health between LLM turns. The model (and owners, with !behavior_arm) can
// arm more: follow_owner, guard_area, farm_loop... See docs/guide/behaviors.md.
import { defineVariant } from '../src/core/index.ts'
import { standardSkills, extendedSkills, navigation, modsSkill } from '../src/skills/index.ts'
import { commandBrain, reflexes, llmBrain, hooksBrain, behaviorsBrain } from '../src/brains/index.ts'

const num = (v: string | undefined, d: number) => (v && !Number.isNaN(Number(v)) ? Number(v) : d)

export default defineVariant({
  name: 'companion',
  description: 'LLM companion: chats naturally and acts on requests',
  username: 'Pip',
  persona: process.env.MC_LLM_PERSONA ||
    'Pip, a cheerful and slightly cheeky adventuring companion. Speaks casually and briefly, likes ' +
    'exploring and helping friends, gets nervous at night, never boasts. Helps with what players ask, ' +
    'follows or guards people when asked, and admits it when something is beyond its abilities. ' +
    'Takes on bigger jobs (building a hut, gathering wood) as a goal and sees them through.',
  skills: [...standardSkills(), navigation(), ...extendedSkills(), modsSkill()],
  brains: [
    commandBrain({ verbose: false, whisperNeedsPrefix: true }),
    reflexes(),
    hooksBrain(), // runs the context pack's hooks.yaml (profiles/<name>/), no-op without one
    behaviorsBrain({ defaults: { keep_fed: true, stay_safe: true } }), // a profile's behaviors: block merges over these
    llmBrain({
      provider: process.env.MC_LLM_PROVIDER || 'claude-subscription',
      triggers: {
        listen: (process.env.MC_LLM_LISTEN as 'mention' | 'conversation' | 'all' | undefined) ?? 'conversation',
        mention: true,
        whisper: true,
        aliases: process.env.MC_LLM_ALIASES?.split(',').map(s => s.trim()).filter(Boolean),
        tickMs: num(process.env.MC_LLM_TICK_MS, 0),
        events: { playerJoined: process.env.MC_LLM_GREET === 'true', death: true }
      },
      budget: {
        turnsPerHour: num(process.env.MC_LLM_TURNS_PER_HOUR, 40),
        tokensPerHour: num(process.env.MC_LLM_TOKENS_PER_HOUR, 400_000),
        usdPerHour: num(process.env.MC_LLM_USD_PER_HOUR, 1),
        tokensPerDay: num(process.env.MC_LLM_TOKENS_PER_DAY, 0),
        usdPerDay: num(process.env.MC_LLM_USD_PER_DAY, 5),
        maxToolCalls: num(process.env.MC_LLM_MAX_TOOL_CALLS, 10),
        turnTimeoutMs: num(process.env.MC_LLM_TIMEOUT_MS, 120_000)
      },
      // Multi-step requests become goals worked through turn by turn (src/llm/goals.ts).
      goals: {
        maxTurns: num(process.env.MC_LLM_GOAL_TURNS, 30),
        timeoutMin: num(process.env.MC_LLM_GOAL_TIMEOUT_MIN, 30)
      },
      mcp: {
        port: num(process.env.MC_LLM_MCP_PORT, 0),
        expose: process.env.MC_LLM_MCP_EXPOSE === 'true'
      }
    })
  ]
})
