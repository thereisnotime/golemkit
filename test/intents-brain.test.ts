import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeAgent, fakeActions } from '../src/llm/testing.ts'
import { LlmRuntime } from '../src/llm/runtime.ts'
import { TypedEmitter } from '../src/core/events.ts'
import { defineAction, ok, z, type ActionDef, type AgentEvents, type ChatMessage } from '../src/core/index.ts'
import { intentsBrain, type IntentsBrainOptions } from '../src/brains/intents/index.ts'
import type { LlmProvider, TurnInput, TurnResult } from '../src/llm/types.ts'

class Provider implements LlmProvider {
  readonly name = 'scripted'
  readonly needsMcp = false
  readonly billing = 'api' as const
  readonly model = 'test'
  inputs: TurnInput[] = []
  unavailable: string | null = null
  async check () { return this.unavailable }
  async run (turn: TurnInput): Promise<TurnResult> {
    this.inputs.push(turn)
    await turn.tools.call('reply', { text: 'llm here' })
    return { text: '', usage: { inputTokens: 1, outputTokens: 1 } }
  }
}

/** FakeAgent plus what the intents brain uses: events, settings, getAction, reply, a bot with players. */
class IntentAgent extends FakeAgent {
  readonly events = new TypedEmitter<AgentEvents>()
  settings: Record<string, unknown> = {}
  readonly defs: Map<string, ActionDef<any>>
  players: Record<string, unknown> = { Pax: {}, Tester: { entity: { position: { x: 10, y: 64, z: 10 } } } }
  constructor (actions: ActionDef<any>[]) {
    super({ username: 'Pax', dataDir: mkdtempSync(join(tmpdir(), 'intents-')), actions })
    this.defs = new Map(actions.map(a => [a.name, a]))
    this.owners = ['tester']
  }

  on<K extends keyof AgentEvents & string> (ev: K, fn: AgentEvents[K]) { return this.events.on(ev, fn) }
  prependListener<K extends keyof AgentEvents & string> (ev: K, fn: AgentEvents[K]) { return this.events.prependListener(ev, fn) }
  chat (from: string, message: string, whisper = false): ChatMessage {
    const msg = { from, message, whisper }
    this.events.emit('chat', msg)
    return msg
  }

  getAction (name: string) { return this.defs.get(name) }
  reply (to: ChatMessage, msg: string) { this.said.push({ ...(to.whisper ? { to: to.from } : {}), msg }) }
  cancelActions () { return 0 }
  get bot () {
    return { players: this.players, entity: { position: { x: 0, y: 64, z: 0 } }, inventory: { items: () => [{ name: 'bread', count: 3 }] }, registry: {} } as any
  }

  /** The same world through the adapter view the brain reads. */
  readonly inSession = true
  get adapter () {
    const players = this.players as Record<string, { entity?: { position: { x: number, y: number, z: number } } }>
    return {
      players: () => Object.keys(players),
      playerPosition: (name: string) => players[name]?.entity?.position ?? null,
      self: () => ({ username: 'Pax', position: { x: 0, y: 64, z: 0 }, health: 20, food: 20, heldItem: null, game: {} }),
      inventory: () => ({ items: [{ name: 'bread', label: 'bread', count: 3, food: false }], slots: 36 })
    } as any
  }
}

const actions = () => [
  ...fakeActions(),
  defineAction({ name: 'chop_tree', description: 'chop', params: z.object({}), run: () => ok('chopped an oak tree, 5 logs') }),
  defineAction({ name: 'drop', description: 'drop', params: z.object({ item: z.string(), count: z.number().optional() }), exclusive: false, run: () => ok('dropped') })
]

const settle = (ms = 80) => new Promise(r => setTimeout(r, ms))

/** An agent with the LLM runtime wired first (like a variant listing llmBrain before intents) and the intents brain after. */
async function setup (opts: IntentsBrainOptions & { llm?: boolean, unavailable?: string } = {}) {
  const agent = new IntentAgent(actions())
  const provider = new Provider()
  provider.unavailable = opts.unavailable ?? null
  let rt: LlmRuntime | undefined
  if (opts.llm !== false) {
    rt = new LlmRuntime(agent, { provider })
    await rt.start()
    agent.on('chat', m => rt!.onChat(m))
  }
  const brain = intentsBrain({ ackAfterMs: 20, llmBlocked: () => rt ? rt.blockedReason() : undefined, llmHandoff: (_a, m) => { rt?.handoff(m); return !!rt }, ...opts })
  brain.start!(agent as any)
  const done = async () => { agent.stopActions(); await rt?.stop() }
  return { agent, provider, rt, done }
}

test('owners only: a stranger saying the same thing gets nothing', async () => {
  const { agent, done } = await setup({ llm: false })
  agent.chat('Stranger', 'pax follow me')
  await settle()
  assert.equal(agent.calls.length, 0)
  assert.equal(agent.said.length, 0)
  agent.chat('Tester', 'pax follow me')
  await settle()
  assert.deepEqual(agent.calls.map(c => [c.name, (c.params as any).player, c.priority, c.player]), [['follow', 'Tester', 50, 'Tester']])
  assert.deepEqual(agent.said.map(s => s.msg), ['following you'])
  await done()
})

test('not addressed (others online, no name): ignored', async () => {
  const { agent, done } = await setup({ llm: false })
  agent.players = { ...agent.players, Steve: {} }
  const msg = agent.chat('Tester', 'follow me')
  await settle()
  assert.equal(msg.claimedBy, undefined)
  assert.equal(agent.calls.length, 0)
  // alone with the owner, no name needed
  delete agent.players.Steve
  agent.chat('Tester', 'come here')
  await settle()
  assert.deepEqual(agent.calls.map(c => c.name), ['come'])
  await done()
})

test('fallback mode with the LLM up: the LLM answers, intents stay out', async () => {
  const { agent, provider, rt, done } = await setup({ mode: 'fallback' })
  const msg = agent.chat('Tester', 'pax follow me')
  await rt!.idle()
  await settle()
  assert.equal(msg.claimedBy, undefined)
  assert.equal(provider.inputs.length, 1)
  assert.deepEqual(agent.said.map(s => s.msg), ['llm here'])
  assert.equal(agent.calls.filter(c => c.name === 'follow').length, 0)
  await done()
})

test('fallback mode with the LLM unavailable: intents act, the LLM never sees it', async () => {
  const { agent, provider, rt, done } = await setup({ mode: 'fallback', unavailable: 'no claude binary' })
  const msg = agent.chat('Tester', 'pax chop some wood')
  await rt!.idle()
  await settle()
  assert.equal(msg.claimedBy, 'intents')
  assert.equal(provider.inputs.length, 0)
  assert.deepEqual(agent.calls.map(c => c.name), ['chop_tree'])
  assert.deepEqual(agent.said.map(s => s.msg), ['chopped an oak tree, 5 logs'], 'no "thinking break" notice from the LLM')
  await done()
})

test('first mode: simple requests by intents, everything else by the LLM, exactly one each', async () => {
  const { agent, provider, rt, done } = await setup({ mode: 'first' })
  const a = agent.chat('Tester', 'pax stop')
  const b = agent.chat('Tester', 'pax tell me a joke about creepers')
  await rt!.idle()
  await settle()
  assert.equal(a.claimedBy, 'intents')
  assert.equal(b.claimedBy, undefined)
  assert.equal(provider.inputs.length, 1)
  assert.match(provider.inputs[0]!.userMessage, /joke about creepers/)
  assert.doesNotMatch(provider.inputs[0]!.userMessage, /said in public chat: "pax stop/)
  assert.deepEqual(agent.said.map(s => s.msg).sort(), ['llm here', 'stopped'])
  await done()
})

test('mode is live: settings.intents.mode off hands everything back to the LLM', async () => {
  const { agent, provider, rt, done } = await setup({ mode: 'first' })
  agent.settings = { intents: { mode: 'off' } }
  const msg = agent.chat('Tester', 'pax come here')
  await rt!.idle()
  await settle()
  assert.equal(msg.claimedBy, undefined)
  assert.equal(provider.inputs.length, 1)
  assert.equal(agent.calls.filter(c => c.name === 'come').length, 0)
  await done()
})

test('no LLM: unclear requests get a short hint; chatter without the name gets nothing', async () => {
  const { agent, done } = await setup({ llm: false })
  agent.players = { ...agent.players, Steve: {} }
  agent.chat('Tester', 'pax juggle three pumpkins')
  agent.chat('Tester', 'nice weather today')
  await settle()
  assert.equal(agent.said.length, 1)
  assert.match(agent.said[0]!.msg, /didn't get that.*pax help/i)
  await done()
})

test('status, help and missing actions are answered truthfully without an LLM', async () => {
  const { agent, done } = await setup({ llm: false })
  agent.chat('Tester', 'pax what are you doing?')
  agent.chat('Tester', 'pax find diamonds')
  agent.chat('Tester', 'pax guard me')
  await settle()
  const said = agent.said.map(s => s.msg)
  assert.match(said[0]!, /^idle; at 10 64 -20; hp 20\/20 food 18\/20/)
  assert.equal(said[1], "find_target isn't available here yet")
  assert.match(said[2]!, /can't guard/)
  agent.said.length = 0
  agent.chat('Tester', 'pax help', true)
  await settle()
  assert.ok(agent.said.length >= 2 && agent.said.every(s => s.to === 'Tester'), 'help goes back as a whisper')
  await done()
})

test('give me your bread: drops it from the inventory', async () => {
  const { agent, done } = await setup({ llm: false })
  agent.chat('Tester', 'pax give me your bread')
  await settle()
  assert.deepEqual(agent.calls.map(c => [c.name, (c.params as any).item ?? (c.params as any).player]), [['come', 'Tester'], ['drop', 'bread']])
  assert.equal(agent.said.at(-1)!.msg, 'here: all my bread')
  await done()
})

test('! commands are left to the command brain', async () => {
  const { agent, done } = await setup({ llm: false })
  const msg = agent.chat('Tester', '!follow')
  await settle()
  assert.equal(msg.claimedBy, undefined)
  assert.equal(agent.calls.length, 0)
  await done()
})

// ------------------------------------------------------------------ layer pipeline in the brain

/** Bag-of-words vectors (deterministic, no model download), optionally slow. */
const bowEmbedder = (delayMs = 0) => ({
  async embed (texts: string[]) {
    if (delayMs) await new Promise(r => setTimeout(r, delayMs))
    return texts.map(t => {
      const v = new Float32Array(128)
      for (const w of t.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) { let h = 0; for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0; v[h % 128]! += 1 }
      const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1
      return v.map(x => x / n)
    })
  }
})

const layered = (delayMs = 0): IntentsBrainOptions => ({
  mode: 'first',
  layers: [{ use: 'patterns' }, { use: 'embeddings', threshold: 0.9, margin: 0, k: 1 }, { use: 'cloud_llm' }],
  deps: { embedder: bowEmbedder(delayMs) }
})
const examples = { come: ['scurry over to my spot'] }

test('layers: a line the patterns miss is caught by embeddings, claimed once, the LLM never runs', async () => {
  const { agent, provider, rt, done } = await setup(layered())
  agent.settings = { intents: { examples } }
  const msg = agent.chat('Tester', 'pax scurry over to my spot')
  assert.equal(msg.claimedBy, 'intents', 'claimed synchronously, before the slower layer answers')
  await settle()
  await rt!.idle()
  assert.deepEqual(agent.calls.map(c => c.name), ['come'])
  assert.equal(provider.inputs.length, 0)
  await done()
})

test('layers: nothing understood -> handed back to the LLM exactly once', async () => {
  const { agent, provider, rt, done } = await setup(layered(20))
  agent.settings = { intents: { examples } }
  const msg = agent.chat('Tester', 'pax tell me a joke about creepers')
  assert.equal(msg.claimedBy, 'intents')
  await settle(400) // the slow fake embedder indexes the examples first (8 batches)
  await rt!.idle()
  assert.equal(provider.inputs.length, 1)
  assert.match(provider.inputs[0]!.userMessage, /joke about creepers/)
  assert.deepEqual(agent.said.map(s => s.msg), ['llm here'])
  assert.equal(agent.calls.length, 0)
  await done()
})

test('layers: cloud_llm switched off (toggle) keeps unclear lines away from the LLM', async () => {
  const { agent, provider, rt, done } = await setup(layered())
  agent.settings = { intents: { examples, layers: { cloud_llm: { enabled: false } } } }
  agent.chat('Tester', 'pax tell me a joke about creepers')
  agent.chat('Tester', 'pax come here')
  await settle()
  await rt!.idle()
  assert.equal(provider.inputs.length, 0)
  assert.deepEqual(agent.calls.map(c => c.name), ['come'])
  await done()
})

test('layers: a slow guess never overtakes a newer command', async () => {
  const { agent, rt, done } = await setup(layered(30))
  agent.settings = { intents: { examples } }
  agent.chat('Tester', 'pax scurry over to my spot')
  agent.chat('Tester', 'pax stop')
  await settle(500)
  await rt!.idle()
  assert.deepEqual(agent.calls.map(c => c.name), ['stop'])
  await done()
})

test('layers: an unavailable embeddings layer falls back to patterns + LLM as before', async () => {
  const { agent, provider, rt, done } = await setup({ ...layered(), deps: { embedder: async () => { throw new Error('no onnxruntime') } } })
  agent.chat('Tester', 'pax tell me a joke')     // first line: the layer tries to load, fails, hands back
  await settle()
  await rt!.idle()
  const b = agent.chat('Tester', 'pax another joke please')
  assert.equal(b.claimedBy, undefined, 'decided synchronously once the layer is known to be unavailable')
  await settle()
  await rt!.idle()
  assert.equal(provider.inputs.length >= 1, true)
  await done()
})
