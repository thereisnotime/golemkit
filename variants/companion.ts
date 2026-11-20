// LLM companion: talk to it by name or whisper, and a language model decides what to say
// and which actions to take. !commands and reflexes keep working and outrank the model,
// so `!stop` always stops it.
//
//   MC_LLM_PROVIDER=codex just run companion
//   just run pax                      (profiles/pax.yaml: this variant + Sonnet + subscription token)
//
// Providers: claude-subscription (default) | codex | anthropic | opencode | openai.
// A profile's `llm:` block (provider, model, login, listen, budget...) overrides these
// defaults. See docs/guide/llm-brain.md and docs/guide/profiles.md.
import { defineVariant } from '../src/core/index.ts'
import { standardSkills, extendedSkills, navigation } from '../src/skills/index.ts'
import { commandBrain, reflexes, llmBrain } from '../src/brains/index.ts'

const num = (v: string | undefined, d: number) => (v && !Number.isNaN(Number(v)) ? Number(v) : d)

export default defineVariant({
  name: 'companion',
  description: 'LLM companion: chats naturally and acts on requests',
  username: 'Pip',
  persona: process.env.MC_LLM_PERSONA ||
    'Pip, a cheerful and slightly cheeky adventuring companion. Speaks casually and briefly, likes ' +
    'exploring and helping friends, gets nervous at night, never boasts. Helps with what players ask, ' +
    'follows or guards people when asked, and admits it when something is beyond its abilities.',
  skills: [...standardSkills(), navigation(), ...extendedSkills()],
  brains: [
    commandBrain({ verbose: false, whisperNeedsPrefix: true }),
    reflexes(),
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
      mcp: {
        port: num(process.env.MC_LLM_MCP_PORT, 0),
        expose: process.env.MC_LLM_MCP_EXPOSE === 'true'
      }
    })
  ]
})
