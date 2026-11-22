// Capability gating (game-adapters phase 3): an agent only offers the actions and behaviours its
// adapter supports, and that carries through to LLM tools and "help".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent, defineVariant, KNOWN_CAPABILITIES, type Capability, type GameAdapter, type ChatMessage } from '../src/core/index.ts'
import { standardSkills, extendedSkills, navigation, modsSkill } from '../src/skills/index.ts'
import { commandBrain, defaultBehaviorRegistry } from '../src/brains/index.ts'
import { BotTools } from '../src/llm/tools.ts'
import { Memory } from '../src/llm/memory.ts'

const SERVER = { host: 'caps.invalid', port: 25565, auth: 'offline' as const, version: '1.21.1' }
const tmp = mkdtempSync(join(tmpdir(), 'golemkit-caps-'))
let n = 0

/** A game with chat and movement but no digging (nothing connects). */
function gameWithout (...missing: Capability[]): () => GameAdapter {
  return () => ({
    game: 'test-game',
    capabilities: new Set<Capability>(KNOWN_CAPABILITIES.filter(c => !missing.includes(c))),
    attach () {},
    async connect () {},
    async disconnect () {},
    endSession () {},
    connected: false,
    client: null,
    self: () => null,
    observe: () => null,
    chat: async () => {},
    command: async () => {},
    on () {},
    off () {}
  })
}

const variant = () => defineVariant({ name: 'caps', skills: [...standardSkills(), navigation(), ...extendedSkills(), modsSkill()], brains: [commandBrain()] })
const agentOn = (adapter?: () => GameAdapter) => new Agent(variant(), SERVER, { username: 'Caps', owners: ['Owner'], dataDir: join(tmp, `a${n++}`), ...(adapter ? { adapter } : {}) })

async function help (agent: Agent): Promise<string> {
  const said: string[] = []
  ;(agent as any).reply = (_to: ChatMessage, text: string) => { said.push(text) }
  await agent.definition.brains[0]!.start?.(agent)
  agent.emit('chat', { from: 'Owner', message: '!help', whisper: false })
  await new Promise(r => setImmediate(r))
  return said[0] ?? ''
}

const DIG_ACTIONS = ['chop_tree', 'break_block', 'collect', 'gather_materials', 'harvest', 'bunker', 'climb_out', 'build_road']

test('capabilities: the Minecraft adapter supports everything the skills ask for', () => {
  const a = agentOn()
  assert.deepEqual(a.unsupported, [])
  for (const name of DIG_ACTIONS) assert.ok(a.getAction(name), `${name} registered`)
})

test('capabilities: a game without dig gets no dig actions, as commands, LLM tools or in help', async () => {
  const a = agentOn(gameWithout('dig'))
  for (const name of DIG_ACTIONS) {
    assert.equal(a.getAction(name), undefined, `${name} left out`)
    assert.ok(a.unsupported.some(u => u.name === name && u.missing.includes('dig')))
  }
  assert.ok(a.getAction('follow') && a.getAction('place_block') && a.getAction('craft'), 'the rest is there')
  const catalog = a.actionCatalog().map(c => c.name)
  for (const name of DIG_ACTIONS) assert.ok(!catalog.includes(name))
  const tools = new BotTools(a, new Memory(a.storage)).list().map(t => t.name)
  for (const name of DIG_ACTIONS) assert.ok(!tools.includes(name), `${name} not an LLM tool`)
  assert.ok(tools.includes('follow'))
  const line = await help(a)
  assert.match(line, /!follow\b/)
  for (const name of DIG_ACTIONS) assert.ok(!line.includes(`!${name} `) && !line.endsWith(`!${name}`), `${name} not in help`)
})

test('capabilities: a game without mods or chat loses exactly those actions', () => {
  const a = agentOn(gameWithout('mods', 'chat'))
  assert.equal(a.getAction('mods'), undefined)
  assert.equal(a.getAction('creative_get'), undefined)
  assert.equal(a.getAction('say'), undefined)
  assert.ok(a.getAction('pos'), 'status queries need nothing')
  assert.ok(a.getAction('config_set'), 'config is game-agnostic')
})

test('capabilities: behaviours a game cannot do are not in its registry', () => {
  const lib = defaultBehaviorRegistry()
  assert.equal(lib.forCapabilities(new Set(KNOWN_CAPABILITIES)), lib, 'everything supported: the same registry')
  const noDig = lib.forCapabilities(new Set(KNOWN_CAPABILITIES.filter(c => c !== 'dig')))
  for (const name of ['chop_wood_loop', 'farm_loop', 'farm_setup']) assert.equal(noDig.has(name), false, name)
  for (const name of ['follow_owner', 'keep_fed', 'stay_safe', 'greet_players']) assert.equal(noDig.has(name), true, name)
  const noMove = lib.forCapabilities(new Set<Capability>(['chat', 'look']))
  assert.deepEqual(noMove.names().sort(), ['greet_players', 'idle_antics', 'idle_look'])
})
