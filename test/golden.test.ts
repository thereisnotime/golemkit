// Golden snapshots for the game-adapter split (openspec/changes/game-adapters): observe() on
// fixed fake worlds, every variant's and profile's action catalog and "help" line, the LLM tool
// schemas, and the intent decisions for the seen and held-out phrase sets. They must not change
// unless the change is intended (UPDATE_GOLDEN=1, see golden.ts).
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Agent, defineVariant, type BotDefinition, type ChatMessage } from '../src/core/index.ts'
import { loadProfile } from '../src/core/profile.ts'
import { standardSkills, extendedSkills, navigation, modsSkill } from '../src/skills/index.ts'
import { commandBrain, reflexes, behaviorsBrain, intentsBrain, hooksBrain } from '../src/brains/index.ts'
import { BotTools } from '../src/llm/tools.ts'
import { Memory } from '../src/llm/memory.ts'
import { resolveConfig, buildPipeline } from '../src/brains/intents/config.ts'
import { SEEN_CASES } from './fixtures/intents-seen.ts'
import { HELDOUT_CASES } from './fixtures/intents-heldout.ts'
import { matchGolden } from './golden.ts'
import { fakeBot, WORLDS } from './fake-world.ts'
import { attachFakeBot } from './fake-attach.ts'

const ROOT = resolve(import.meta.dirname, '..')
const SERVER = { host: 'golden.invalid', port: 25565, auth: 'offline' as const, version: '1.21.1' }
const tmp = mkdtempSync(join(tmpdir(), 'golemkit-golden-'))
let n = 0
const agentFor = (def: BotDefinition, opts: Record<string, unknown> = {}) =>
  new Agent(def, SERVER, { username: def.username ?? 'Golem', owners: ['Owner'], dataDir: join(tmp, `a${n++}`), ...opts })

const VARIANTS = ['actor', 'apprentice', 'buddy', 'companion', 'villager']
const PROFILES = ['apprentice', 'example', 'pax']

async function loadVariant (name: string): Promise<BotDefinition> {
  return (await import(pathToFileURL(join(ROOT, 'variants', `${name}.ts`)).href)).default as BotDefinition
}

async function targets (): Promise<{ name: string, agent: Agent }[]> {
  const out: { name: string, agent: Agent }[] = []
  for (const v of VARIANTS) out.push({ name: `variant:${v}`, agent: agentFor(await loadVariant(v)) })
  for (const p of PROFILES) {
    const prof = loadProfile(p, join(ROOT, 'profiles'))!
    out.push({ name: `profile:${p}`, agent: agentFor(await loadVariant(prof.profile.variant), { ...prof.options, dataDir: join(tmp, `a${n++}`), owners: ['Owner'] }) })
  }
  return out
}

/** "!help" as the command brain answers it. */
async function helpLine (agent: Agent): Promise<string | null> {
  const brain = (agent.definition.brains ?? []).find(b => b.name === 'command')
  if (!brain) return null
  const said: string[] = []
  ;(agent as any).reply = (_to: ChatMessage, text: string) => { said.push(text) }
  await brain.start?.(agent)
  agent.emit('chat', { from: 'Owner', message: '!help', whisper: false })
  await new Promise(r => setImmediate(r))
  return said[0] ?? null
}

test('golden: action catalogs and help, per variant and profile', async () => {
  const out: Record<string, unknown> = {}
  for (const { name, agent } of await targets()) {
    out[name] = {
      actions: agent.listActions().map(a => `${a.name}${a.internal ? ' (internal)' : ''}`),
      catalog: agent.actionCatalog(),
      help: await helpLine(agent)
    }
  }
  matchGolden('action-catalogs', out)
})

test('golden: LLM tool schemas', async () => {
  const out: Record<string, unknown> = {}
  for (const { name, agent } of await targets()) {
    if (!(agent.definition.brains ?? []).some(b => b.name === 'llm')) continue
    out[name] = new BotTools(agent, new Memory(agent.storage)).list()
  }
  matchGolden('llm-tools', out)
})

const observeVariant = () => defineVariant({
  name: 'golden',
  username: 'Golem',
  skills: [...standardSkills(), navigation(), ...extendedSkills(), modsSkill()],
  brains: [commandBrain(), reflexes(), behaviorsBrain(), intentsBrain(), hooksBrain()]
})

test('golden: observe() on fixed fake worlds', async () => {
  const out: Record<string, unknown> = {}
  out.disconnected = agentFor(observeVariant()).observe()
  for (const [name, spec] of Object.entries(WORLDS)) {
    const agent = agentFor(observeVariant())
    attachFakeBot(agent, fakeBot(spec))
    out[name] = agent.observe()
    const companion = agentFor(await loadVariant('companion'))
    attachFakeBot(companion, fakeBot(spec))
    out[`${name}:companion`] = companion.observe()
  }
  matchGolden('observe', out)
})

test('golden: intent decisions (patterns) on the seen and held-out sets', async () => {
  const pipe = buildPipeline(resolveConfig({}, [{ use: 'patterns' } as any, { use: 'cloud_llm', enabled: false } as any]))
  const out: Record<string, unknown[]> = {}
  for (const [set, cases] of [['seen', SEEN_CASES], ['heldout', HELDOUT_CASES]] as const) {
    out[set] = []
    for (const [text] of cases) {
      const d = await pipe.decide(text, { speaker: 'Tester' })
      out[set]!.push([text, d.winner?.intent ?? null, d.winner?.args ?? null, d.winner?.layer ?? null])
    }
  }
  matchGolden('intent-decisions', out)
})
