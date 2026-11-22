// Apprentice: the self-improving NPC. It runs a small declarative program (wander near home
// by day, sleep at night, greet people now and then) with no LLM in the loop. When an owner
// says "Apprentice, learn: ..." (or whispers "learn: ...", or uses !teach), it asks Claude
// once to rewrite that program, checks the result (validation + dry run) and from then on
// runs the new version on its own. See docs/guide/self-improver.md.
//
//   just run apprentice             (profiles/apprentice.yaml: owners, Sonnet + subscription token)
//
// A profile's `llm:` block (provider, model, effort, login, oauthTokenVar, oauthTokenFile,
// budget) overrides the defaults below; `provider: none` runs it without learning. Without
// owners nobody can teach it from chat.
import { defineVariant, envOr } from '../src/core/index.ts'
import { status, movement, combat, survival, inventorySkill, navigation } from '../src/skills/index.ts'
import { commandBrain, reflexes } from '../src/brains/index.ts'
import { fleeOrFight } from '../src/brains/npc/index.ts'
import { selfImprover, type ProgramInput } from '../src/brains/self/index.ts'

/** Version 0: what the apprentice does before anyone teaches it anything. */
export const baseProgram: ProgramInput = {
  version: 1,
  name: 'apprentice basics',
  description: 'Wander near home by day, go home and sleep at night, greet people now and then.',
  vars: {},
  routines: {
    stroll: [{ act: 'wander', params: { radius: 10 } }, { wait: 4000 }],
    bedtime: [
      { if: { fact: 'homeDistance', gt: 6 }, then: [{ act: 'go_home', params: {} }] },
      { act: 'sleep', params: {} },
      { while: { cond: { fact: 'sleeping', eq: true }, max: 60, steps: [{ wait: 5000 }] } }
    ]
  },
  rules: [
    { name: 'bedtime', score: 70, when: { fact: 'isNight', eq: true }, do: 'bedtime', failureCooldownMs: 60_000 },
    { name: 'stroll', score: 10, when: { time: 'day' }, do: 'stroll' },
    { name: 'night_stroll', score: 5, when: { fact: 'isNight', eq: true }, do: [{ act: 'wander', params: { radius: 4 } }, { wait: 8000 }] }
  ],
  triggers: [
    {
      name: 'greet_joiner',
      on: 'playerJoined',
      do: [{ wait: 2000 }, { say: ['welcome back, {player}!', 'hi {player}', 'oh hey {player}'] }],
      cooldownMs: 30 * 60_000,
      priority: 30
    }
  ]
}

export default defineVariant({
  name: 'apprentice',
  description: 'Self-improving NPC: runs its own program, rewrites it with one LLM call when an owner teaches it something',
  username: 'Apprentice',
  persona: 'Apprentice, an eager young helper who lives near its home, likes people and learns new habits from its master.',
  skills: [status(), movement(), combat(), survival(), inventorySkill(), navigation()],
  brains: [
    commandBrain({ verbose: false, whisperNeedsPrefix: true }),
    reflexes(),
    selfImprover({
      base: baseProgram,
      provider: 'claude-subscription',
      providerOptions: {
        model: 'claude-sonnet-5-5',
        effort: 'low',
        login: '.auth/apprentice',
        oauthTokenVar: envOr('MC_OAUTH_TOKEN_VAR', 'CLAUDE_CODE_OAUTH_TOKEN'),
        oauthTokenFile: envOr('MC_OAUTH_TOKEN_FILE', '~/.config/golemkit/secrets.env')
      },
      budget: { turnsPerHour: 10, tokensPerHour: 300_000, tokensPerDay: 1_000_000, callsPerInstruction: 3 },
      npc: { extraBehaviors: [fleeOrFight()] }
    })
  ]
})
