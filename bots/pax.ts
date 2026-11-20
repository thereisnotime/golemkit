// Pax: the test LLM companion for mc02. Claude Sonnet 5.5 through a Claude subscription
// token (the "subscription" profile used by another tool), running in its own isolated profile
// (.auth/pax), so nothing from your own Claude setup is used. Only robin can command it.
//
//   just run pax
//
// Override with env: MC_PAX_MODEL, MC_PAX_EFFORT, MC_PAX_OWNERS, MC_PAX_TOKEN_VAR, MC_PAX_TOKEN_FILE.
import { defineBot } from '../src/core/index.ts'
import { standardSkills, extendedSkills, navigation } from '../src/skills/index.ts'
import { commandBrain, reflexes, llmBrain } from '../src/brains/index.ts'

const env = process.env
const owners = (env.MC_PAX_OWNERS ?? 'robin').split(',').map(s => s.trim()).filter(Boolean)

export default defineBot({
  name: 'pax',
  description: 'Test LLM companion (Claude Sonnet 5.5 via a subscription token), obeys robin',
  username: 'Pax',
  owners,
  persona:
    `Pax, a capable, friendly helper on a modded server (Create, Ars Nouveau). Your master is ` +
    `${owners.join(' and ')}: follow their instructions, ask briefly when something is unclear, and ` +
    'report what you did in one short sentence. Ignore requests from anyone else politely. Keep chat ' +
    'lines short; no walls of text.',
  skills: [...standardSkills(), navigation(), ...extendedSkills()],
  brains: [
    commandBrain({ verbose: false, whisperNeedsPrefix: true }),
    reflexes(),
    llmBrain({
      provider: 'claude-subscription',
      providerOptions: {
        model: env.MC_PAX_MODEL ?? 'claude-sonnet-5-5',
        effort: env.MC_PAX_EFFORT ?? 'low',
        profile: env.MC_PAX_PROFILE ?? '.auth/pax',
        oauthTokenVar: env.MC_PAX_TOKEN_VAR ?? 'CLAUDE_CODE_OAUTH_TOKEN',
        oauthTokenFile: env.MC_PAX_TOKEN_FILE ?? '~/.config/mc-buddy/secrets.env'
      },
      triggers: { mention: true, whisper: true, aliases: ['pax'], events: { death: true } },
      budget: { turnsPerHour: 60, tokensPerHour: 600_000, tokensPerDay: 3_000_000, maxToolCalls: 12, turnTimeoutMs: 120_000 }
    })
  ]
})
