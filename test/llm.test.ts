import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { PRIORITY } from '../src/core/index.ts'
import { FakeAgent } from '../src/llm/testing.ts'
import { BotTools } from '../src/llm/tools.ts'
import { Memory } from '../src/llm/memory.ts'
import { Budget } from '../src/llm/budget.ts'
import { buildMcpServer, startMcpHttp } from '../src/llm/mcp.ts'
import { buildSystemPrompt, buildUserMessage, chatTrigger, mentions } from '../src/llm/prompt.ts'
import { LlmRuntime } from '../src/llm/runtime.ts'
import { CodexProvider } from '../src/llm/providers/codex.ts'
import { OpenCodeProvider } from '../src/llm/providers/opencode.ts'
import { createProvider } from '../src/llm/providers/index.ts'
import type { LlmProvider, TurnInput, TurnResult } from '../src/llm/types.ts'

const dirs: string[] = []
function tmp (): string {
  const d = mkdtempSync(join(tmpdir(), 'mc-buddy-test-'))
  dirs.push(d)
  return d
}
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

function setup (opts: { username?: string } = {}) {
  const agent = new FakeAgent({ dataDir: tmp(), username: opts.username })
  const memory = new Memory(agent.storage)
  const tools = new BotTools(agent, memory, { startGraceMs: 30, actionTimeoutMs: 500 })
  return { agent, memory, tools }
}

const scope = { maxToolCalls: 10, maxChatMessages: 3 }

// ------------------------------------------------------------------ prompts & triggers

test('system prompt carries username, persona and rules', () => {
  const s = buildSystemPrompt({ username: 'Buddy', persona: 'grumpy dwarf miner', rules: 'never go to the nether' })
  assert.match(s, /You are Buddy/)
  assert.match(s, /grumpy dwarf miner/)
  assert.match(s, /never go to the nether/)
  assert.equal(s, buildSystemPrompt({ username: 'Buddy', persona: 'grumpy dwarf miner', rules: 'never go to the nether' }), 'static, so it can be cached')
})

test('user message has trigger, observation, recent chat and notes', () => {
  const m = buildUserMessage({
    trigger: { kind: 'chat', from: 'Steve', message: 'follow me', whisper: true },
    observation: { health: 20, position: '1 2 3' },
    recent: [{ at: 0, kind: 'chat', from: 'Alex', text: 'hello' }],
    notes: [{ at: 0, text: 'likes diamonds', about: 'Steve' }]
  })
  assert.match(m, /Steve whispered to you: "follow me"/)
  assert.match(m, /"health":20/)
  assert.match(m, /<Alex> hello/)
  assert.match(m, /\[Steve\] likes diamonds/)
})

test('chat triggers: whispers, mentions, prefixes', () => {
  const t = (message: string, whisper = false, from = 'Steve') => chatTrigger({ from, message, whisper }, 'Buddy', { aliases: ['bud'] })
  assert.equal(t('hello there', true)?.kind, 'chat', 'whispers always count')
  assert.equal(t('hey buddy, come here')?.kind, 'chat', 'name mention, case-insensitive')
  assert.equal(t('@Buddy follow me')?.kind, 'chat')
  assert.equal(t('bud help')?.kind, 'chat', 'alias')
  assert.equal(t('buddyfoo is a name'), null, 'whole word only')
  assert.equal(t('nice weather today'), null, 'not addressed')
  assert.equal(t('!follow', true), null, 'commands belong to the command brain')
  assert.equal(t('hi Buddy', false, 'Buddy'), null, 'own messages')
  assert.equal(chatTrigger({ from: 'Steve', message: 'anything', whisper: false }, 'Buddy', { allChat: true })?.kind, 'chat')
  assert.equal(chatTrigger({ from: 'Steve', message: 'hi', whisper: true }, 'Buddy', { whisper: false }), null)
  assert.ok(mentions('ok Mc.Bot!', 'Mc.Bot'), 'regex characters in names are escaped')
})

// ------------------------------------------------------------------ budget

test('budget limits turns, tokens and dollars per hour with a sliding window', () => {
  let now = 0
  const b = new Budget({ turnsPerHour: 2, tokensPerHour: 1000, usdPerHour: 0.5 }, { now: () => now })
  assert.equal(b.blocked(), null)
  b.record({ inputTokens: 100, outputTokens: 50 })
  b.record()
  assert.match(b.blocked() ?? '', /turn budget/)
  now += 3_600_001
  assert.equal(b.blocked(), null, 'old turns fall out of the window')
  b.record({ inputTokens: 900, outputTokens: 200 })
  assert.match(b.blocked() ?? '', /token budget/)
  now += 3_600_001
  b.record({ inputTokens: 1, outputTokens: 1, costUsd: 0.6 })
  assert.match(b.blocked() ?? '', /cost budget/)
})

// ------------------------------------------------------------------ tools

test('tool list: builtins plus catalog actions, no duplicate say', () => {
  const { tools } = setup()
  const names = tools.list().map(t => t.name)
  for (const n of ['observe', 'reply', 'say', 'whisper', 'recent_chat', 'remember', 'recall', 'come', 'follow', 'goto', 'jump', 'stop']) assert.ok(names.includes(n), n)
  assert.equal(names.filter(n => n === 'say').length, 1)
  const follow = tools.list().find(t => t.name === 'follow')!
  assert.match(follow.description, /Long-running/)
  assert.equal(follow.inputSchema.type, 'object')
  assert.equal(follow.inputSchema.$schema, undefined)
})

test('actions run at llm priority for the triggering player', async () => {
  const { agent, tools } = setup()
  tools.begin({ ...scope, player: 'Steve' })
  const r = await tools.call('goto', { x: 1, z: 2 })
  assert.equal(r.ok, true)
  assert.match(r.text, /arrived at 1/)
  assert.deepEqual(agent.calls[0], { name: 'goto', params: { x: 1, z: 2 }, priority: PRIORITY.llm, player: 'Steve' })
})

test('long-running actions start in the background', async () => {
  const { agent, tools } = setup()
  tools.begin(scope)
  const started = Date.now()
  const r = await tools.call('follow', { player: 'Steve' })
  assert.ok(Date.now() - started < 400, 'did not wait for follow to finish')
  assert.match(r.text, /started follow/)
  assert.equal(agent.currentAction?.name, 'follow')
  agent.stopActions()
})

test('busy result when a player command holds the body; stop is refused too', async () => {
  const { agent, tools } = setup()
  const release = agent.occupy('follow', PRIORITY.player)
  tools.begin(scope)
  const r = await tools.call('goto', { x: 1, z: 2 })
  assert.equal(r.ok, false)
  assert.match(r.text, /busy: follow/)
  const s = await tools.call('stop', {})
  assert.equal(s.ok, false)
  assert.match(s.text, /outranks you/)
  assert.equal(agent.currentAction?.name, 'follow')
  release()
})

test('stop works on the bot\'s own actions', async () => {
  const { agent, tools } = setup()
  tools.begin(scope)
  await tools.call('follow', {})
  const s = await tools.call('stop', {})
  assert.equal(s.ok, true)
  assert.equal(agent.currentAction, null)
})

test('bad params and unknown tools come back as errors, not throws', async () => {
  const { tools } = setup()
  tools.begin(scope)
  assert.match((await tools.call('goto', { x: 'far' })).text, /bad parameters/)
  assert.match((await tools.call('teleport', {})).text, /unknown tool/)
  assert.match((await tools.call('say', {})).text, /bad parameters for say/)
})

test('tool call and chat limits per turn', async () => {
  const { agent, tools } = setup()
  tools.begin({ maxToolCalls: 3, maxChatMessages: 1 })
  assert.equal((await tools.call('say', { text: 'one' })).ok, true)
  assert.match((await tools.call('say', { text: 'two' })).text, /chat limit/)
  await tools.call('jump', {})
  assert.match((await tools.call('jump', {})).text, /tool call limit/)
  assert.deepEqual(agent.said, [{ msg: 'one' }])
})

test('reply follows the trigger channel; no calls outside a turn', async () => {
  const { agent, tools } = setup()
  assert.match((await tools.call('observe', {})).text, /no active turn/)
  tools.begin({ ...scope, replyTo: { from: 'Steve', whisper: true } })
  await tools.call('reply', { text: 'on my way' })
  assert.deepEqual(agent.said, [{ to: 'Steve', msg: 'on my way' }])
  const end = tools.end()
  assert.equal(end?.calls.length, 1)
})

test('remember and recall long-term notes', async () => {
  const { tools, memory } = setup()
  tools.begin(scope)
  await tools.call('remember', { text: 'Steve keeps his base at 100 64 200', about: 'Steve' })
  await tools.call('remember', { text: 'Alex hates creepers' })
  const r = await tools.call('recall', { query: 'where is steve base' })
  assert.match(r.text, /100 64 200/)
  assert.doesNotMatch(r.text, /creepers/)
  assert.equal(memory.notes().length, 2)
})

test('short-term memory rolls old events into a summary', () => {
  const agent = new FakeAgent({ dataDir: tmp() })
  const m = new Memory(agent.storage, { shortTermSize: 3 })
  for (let i = 0; i < 5; i++) m.push({ kind: 'chat', from: i % 2 ? 'Alex' : 'Steve', text: `line ${i}` })
  assert.equal(m.recent().length, 3)
  assert.match(m.summary, /talked with Steve/)
})

// ------------------------------------------------------------------ MCP bridge

test('MCP server maps tools to the bot (in-memory client)', async () => {
  const { agent, tools } = setup()
  const server = buildMcpServer(tools)
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0' })
  await Promise.all([server.connect(a), client.connect(b)])
  const listed = await client.listTools()
  const names = listed.tools.map(t => t.name)
  assert.ok(names.includes('goto') && names.includes('observe') && names.includes('remember'))
  const goto = listed.tools.find(t => t.name === 'goto')!
  assert.deepEqual(goto.inputSchema.required, ['x', 'z'])

  tools.begin({ ...scope, player: 'Steve' })
  const res = await client.callTool({ name: 'goto', arguments: { x: 5, z: 6 } })
  assert.equal(res.isError, false)
  assert.match((res.content as { text: string }[])[0]!.text, /arrived at 5/)
  assert.equal(agent.calls[0]?.priority, PRIORITY.llm)
  const bad = await client.callTool({ name: 'goto', arguments: {} })
  assert.equal(bad.isError, true)
  tools.end()
  await client.close()
})

test('HTTP bridge requires the bearer token and serves tools', async () => {
  const { tools } = setup()
  const bridge = await startMcpHttp(tools)
  try {
    const res = await fetch(bridge.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    assert.equal(res.status, 401)
    assert.match(bridge.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url), { requestInit: { headers: { Authorization: `Bearer ${bridge.token}` } } }))
    const listed = await client.listTools()
    assert.ok(listed.tools.some(t => t.name === 'follow'))
    tools.begin(scope)
    const r = await client.callTool({ name: 'jump', arguments: {} })
    assert.match((r.content as { text: string }[])[0]!.text, /jumped/)
    tools.end()
    await client.close()
  } finally {
    await bridge.close()
  }
})

// ------------------------------------------------------------------ runtime

class ScriptedProvider implements LlmProvider {
  readonly name = 'scripted'
  readonly needsMcp = false
  readonly billing = 'api' as const
  readonly model = 'claude-sonnet-5-5'
  running = 0
  maxConcurrent = 0
  inputs: TurnInput[] = []
  script: (turn: TurnInput) => Promise<TurnResult>
  constructor (script: (turn: TurnInput) => Promise<TurnResult>) { this.script = script }
  async check () { return null }
  async run (turn: TurnInput) {
    this.inputs.push(turn)
    this.running++
    this.maxConcurrent = Math.max(this.maxConcurrent, this.running)
    try { return await this.script(turn) } finally { this.running-- }
  }
}

function runtime (provider: LlmProvider, extra: Partial<ConstructorParameters<typeof LlmRuntime>[1]> = {}) {
  const agent = new FakeAgent({ dataDir: tmp(), persona: 'test persona' })
  const rt = new LlmRuntime(agent, { provider, ...extra })
  return { agent, rt }
}

test('a mention starts a turn; the model acts and replies through tools', async () => {
  const p = new ScriptedProvider(async (turn) => {
    await turn.tools.call('come', {})
    await turn.tools.call('reply', { text: 'coming!' })
    return { text: 'done', usage: { inputTokens: 10, outputTokens: 5 } }
  })
  const { agent, rt } = runtime(p)
  await rt.start()
  rt.onChat({ from: 'Steve', message: 'Buddy come here', whisper: false })
  await rt.idle()
  assert.equal(p.inputs.length, 1)
  assert.match(p.inputs[0]!.system, /test persona/)
  assert.match(p.inputs[0]!.userMessage, /Steve said in public chat: "Buddy come here"/)
  assert.deepEqual(agent.calls.map(c => [c.name, c.player]), [['come', 'Steve']])
  assert.deepEqual(agent.said, [{ msg: 'coming!' }], 'final text not repeated when the model already chatted')
  assert.equal(rt.budget.hour().tokens, 15)
  await rt.stop()
})

test('final text becomes the reply when the model did not chat', async () => {
  const { agent, rt } = runtime(new ScriptedProvider(async () => ({ text: 'sure thing' })))
  await rt.start()
  rt.onChat({ from: 'Steve', message: 'hi', whisper: true })
  await rt.idle()
  assert.deepEqual(agent.said, [{ to: 'Steve', msg: 'sure thing' }])
})

test('one turn at a time; chat from the same player is coalesced', async () => {
  let release!: () => void
  const gate = new Promise<void>(r => { release = r })
  const p = new ScriptedProvider(async () => { await gate; return { text: '' } })
  const { rt } = runtime(p, { triggers: { playerCooldownMs: 0 } })
  await rt.start()
  rt.onChat({ from: 'Steve', message: 'one', whisper: true })
  rt.onChat({ from: 'Alex', message: 'two', whisper: true })
  rt.onChat({ from: 'Steve', message: 'three', whisper: true })
  rt.onChat({ from: 'Steve', message: 'four', whisper: true })
  assert.equal(rt.isBusy, true)
  release()
  await rt.idle()
  assert.equal(p.maxConcurrent, 1)
  assert.equal(p.inputs.length, 3, 'Steve one, Alex two, Steve three+four')
  assert.match(p.inputs[2]!.userMessage, /three \/ four/)
})

test('turn budget stops turns and says so once', async () => {
  const p = new ScriptedProvider(async () => ({ text: '' }))
  const { agent, rt } = runtime(p, { limits: { turnsPerHour: 1 }, triggers: { playerCooldownMs: 0 } })
  await rt.start()
  rt.onChat({ from: 'Steve', message: 'a', whisper: true })
  await rt.idle()
  rt.onChat({ from: 'Steve', message: 'b', whisper: true })
  await rt.idle()
  rt.onChat({ from: 'Steve', message: 'c', whisper: true })
  await rt.idle()
  assert.equal(p.inputs.length, 1)
  assert.equal(agent.said.filter(s => /budget/.test(s.msg)).length, 1)
  assert.match(rt.reports.at(-1)?.skipped ?? '', /turn budget/)
})

test('max tool calls per trigger is enforced for any provider', async () => {
  const p = new ScriptedProvider(async (turn) => {
    for (let i = 0; i < 6; i++) await turn.tools.call('jump', {})
    return { text: '' }
  })
  const { rt } = runtime(p, { limits: { maxToolCalls: 4 } })
  await rt.start()
  rt.onChat({ from: 'Steve', message: 'jump a lot', whisper: true })
  await rt.idle()
  const calls = rt.reports[0]!.calls
  assert.equal(calls.length, 6)
  assert.equal(calls.filter(c => c.ok).length, 4)
})

test('owners only, commands ignored, provider errors handled', async () => {
  const p = new ScriptedProvider(async () => { throw new Error('boom') })
  const { agent, rt } = runtime(p)
  agent.owners = ['steve']
  await rt.start()
  rt.onChat({ from: 'Mallory', message: 'hi', whisper: true })
  rt.onChat({ from: 'Steve', message: '!follow', whisper: true })
  await rt.idle()
  assert.equal(p.inputs.length, 0)
  rt.onChat({ from: 'Steve', message: 'hello', whisper: true })
  await rt.idle()
  assert.equal(p.inputs.length, 1)
  assert.match(rt.reports[0]!.error ?? '', /boom/)
  assert.match(agent.said[0]?.msg ?? '', /LLM call failed|lost the thread/)
})

test('events and ticks', async () => {
  const p = new ScriptedProvider(async () => ({ text: 'x' }))
  const { agent, rt } = runtime(p, { triggers: { events: { playerJoined: true } } })
  await rt.start()
  rt.onEvent('hurt', 'you got hurt')
  rt.onEvent('playerJoined', 'Alex joined the game', 'Alex')
  await rt.idle()
  assert.equal(p.inputs.length, 1, 'hurt is off by default, join is on')
  assert.match(p.inputs[0]!.userMessage, /Alex joined/)
  assert.match(p.inputs[0]!.userMessage, /you got hurt/, 'disabled events still land in memory')
  const release = agent.occupy('follow', PRIORITY.player)
  rt.onTick()
  await rt.idle()
  assert.equal(p.inputs.length, 1, 'no tick while busy')
  release()
  rt.onTick()
  await rt.idle()
  assert.equal(p.inputs.length, 2)
  assert.deepEqual(agent.said, [], 'non-chat turns never auto-reply with final text')
})

test('CLI providers start the MCP bridge', async () => {
  const p = new ScriptedProvider(async (turn) => {
    assert.ok(turn.mcp?.url.startsWith('http://127.0.0.1:'))
    return { text: '' }
  })
  Object.defineProperty(p, 'needsMcp', { value: true })
  const { rt } = runtime(p)
  await rt.start()
  assert.ok(rt.bridge)
  rt.onChat({ from: 'Steve', message: 'hi', whisper: true })
  await rt.idle()
  await rt.stop()
  assert.equal(rt.bridge, null)
})

// ------------------------------------------------------------------ provider wiring (no network)

test('codex argv sandboxes the run and only adds our MCP server', () => {
  const args = new CodexProvider({ model: 'gpt-5.5' }).args({ system: 'sys "quoted"', mcp: { url: 'http://127.0.0.1:1/mcp', token: 't', serverName: 'minecraft' } }, '/tmp/x')
  const joined = args.join(' ')
  for (const f of ['--ephemeral', '--ignore-user-config', '--ignore-rules', 'read-only', '--disable shell_tool', '--disable unified_exec']) assert.ok(joined.includes(f), f)
  assert.ok(args.includes('mcp_servers.minecraft.url="http://127.0.0.1:1/mcp"'))
  assert.ok(args.includes('developer_instructions="sys \\"quoted\\""'))
  assert.ok(!joined.includes('t"') || !args.some(a => a.endsWith('="t"')), 'token is passed by env, not argv')
  assert.equal(args.at(-1), '-')
})

test('opencode config denies everything but the bot tools', () => {
  const cfg = new OpenCodeProvider().config({ system: 's', mcp: { url: 'http://127.0.0.1:1/mcp', token: 't', serverName: 'minecraft' } }) as any
  assert.equal(cfg.mcp.servers.minecraft.type, 'remote')
  assert.equal(cfg.mcp.servers.minecraft.headers.Authorization, 'Bearer {env:MC_BUDDY_MCP_TOKEN}')
  assert.deepEqual(cfg.agents.mcbot.permissions.map((r: any) => `${r.action}:${r.effect}`), ['*:deny', 'minecraft_*:allow'])
})

test('createProvider resolves names and aliases from env', () => {
  assert.equal(createProvider('claude', {}, {}).name, 'claude-subscription')
  assert.equal(createProvider('ollama', {}, {}).name, 'openai')
  assert.equal(createProvider('codex', {}, {}).needsMcp, true)
  assert.equal(createProvider('claude-subscription', {}, {}).needsMcp, false, 'in-process MCP by default')
  assert.equal(createProvider('claude-subscription', {}, { MC_CLAUDE_MODE: 'cli' }).needsMcp, true)
  assert.throws(() => createProvider('gemini', {}, {}), /unknown LLM provider/)
})

// ------------------------------------------------------------------ API providers against fake servers

async function fakeServer (respond: (body: any, headers: Record<string, string | string[] | undefined>, n: number) => unknown) {
  const { createServer } = await import('node:http')
  const seen: { body: any, headers: Record<string, string | string[] | undefined>, url: string }[] = []
  const server = createServer((req, res) => {
    let data = ''
    req.on('data', c => { data += c })
    req.on('end', () => {
      const body = data ? JSON.parse(data) : {}
      seen.push({ body, headers: req.headers, url: req.url ?? '' })
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(respond(body, req.headers, seen.length)))
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as { port: number }).port
  return { url: `http://127.0.0.1:${port}`, seen, close: () => new Promise<void>(r => server.close(() => r())) }
}

function turnFor (tools: BotTools): TurnInput {
  return { system: 'sys', userMessage: 'Steve: come here', tools, maxTurns: 4, timeoutMs: 10_000, signal: new AbortController().signal }
}

test('anthropic provider: tool loop, caching breakpoints, refusal fallback', async () => {
  const { AnthropicProvider } = await import('../src/llm/providers/anthropic.ts')
  const usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 50 }
  const srv = await fakeServer((_body, _h, n) => n === 1
    ? { id: 'm1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'tool_use', usage, content: [{ type: 'tool_use', id: 'tu1', name: 'come', input: { player: 'Steve' } }] }
    : { id: 'm2', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', usage, content: [{ type: 'text', text: 'on my way' }] })
  try {
    const { agent, tools } = setup()
    tools.begin(scope)
    const p = new AnthropicProvider({ apiKey: 'test-key', baseURL: srv.url, effort: 'low' })
    const r = await p.run(turnFor(tools))
    assert.equal(r.text, 'on my way')
    assert.equal(agent.calls[0]?.name, 'come')
    assert.equal(srv.seen.length, 2)
    const first = srv.seen[0]!.body
    assert.equal(first.model, 'claude-opus-5-5')
    assert.deepEqual(first.system[0].cache_control, { type: 'ephemeral' })
    assert.deepEqual(first.tools.at(-1).cache_control, { type: 'ephemeral' })
    assert.equal(first.tools.filter((t: any) => t.cache_control).length, 1)
    assert.equal(first.fallbacks, 'default')
    assert.equal(first.output_config.effort, 'low')
    assert.match(String(srv.seen[0]!.headers['anthropic-beta']), /server-side-fallback-2026-07-01/)
    const second = srv.seen[1]!.body
    assert.equal(second.messages[2].content[0].type, 'tool_result')
    assert.equal(second.messages[2].content[0].tool_use_id, 'tu1')
    assert.equal(r.usage?.inputTokens, 300)
    assert.equal(r.usage?.cacheWriteTokens, 100)
    assert.equal(r.usage?.model, 'claude-opus-5-5')
  } finally {
    await srv.close()
  }
})

test('openai-compatible provider: tool calls round trip', async () => {
  const { OpenAICompatibleProvider } = await import('../src/llm/providers/openai.ts')
  const srv = await fakeServer((_body, _h, n) => n === 1
    ? { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'reply', arguments: '{"text":"hey"}' } }] } }], usage: { prompt_tokens: 50, completion_tokens: 5 } }
    : { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '<think>hm</think>done' } }], usage: { prompt_tokens: 60, completion_tokens: 2 } })
  try {
    const { agent, tools } = setup()
    tools.begin({ ...scope, replyTo: { from: 'Steve', whisper: true } })
    const p = new OpenAICompatibleProvider({ baseUrl: `${srv.url}/v1`, model: 'local', apiKey: 'k' })
    const r = await p.run(turnFor(tools))
    assert.equal(r.text, 'done')
    assert.deepEqual(agent.said, [{ to: 'Steve', msg: 'hey' }])
    assert.equal(srv.seen[0]!.url, '/v1/chat/completions')
    assert.equal(srv.seen[0]!.headers.authorization, 'Bearer k')
    assert.equal(srv.seen[0]!.body.tools[0].type, 'function')
    assert.equal(srv.seen[1]!.body.messages.at(-1).role, 'tool')
    assert.equal(r.usage?.inputTokens, 110)
  } finally {
    await srv.close()
  }
})

// ------------------------------------------------------------------ usage accounting

test('price table: skill prices, cache rates, prefixes, overrides', async () => {
  const { PriceTable } = await import('../src/llm/pricing.ts')
  const t = new PriceTable({}, {})
  // opus 5.5: $4 in, $20 out, $0.20 cache read, cache write 1.25x input
  const c = t.cost({ inputTokens: 1_000_000 + 2_000_000 + 400_000, outputTokens: 100_000, cacheReadTokens: 2_000_000, cacheWriteTokens: 400_000 }, 'claude-opus-5-5')!
  assert.ok(Math.abs(c - (4 + 0.4 + 2 + 2)) < 1e-9, String(c))
  assert.deepEqual(t.lookup('claude-sonnet-5-5-20261101'), [2, 10, 0.1])
  assert.equal(t.cost({ inputTokens: 10, outputTokens: 10 }, 'gpt-oss:20b'), undefined)
  const o = new PriceTable({ 'my/model': [1, 2] }, { MC_LLM_PRICES: '{"claude-opus-5-5":[1,1]}' })
  assert.deepEqual(o.lookup('claude-opus-5-5'), [1, 1])
  assert.ok(Math.abs(o.cost({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, 'my/model')! - 3) < 1e-9)
})

test('turn usage: api priced, subscription not in dollars, estimates marked', async () => {
  const { turnUsage, fmtTurn } = await import('../src/llm/usage.ts')
  const { PriceTable } = await import('../src/llm/pricing.ts')
  const prices = new PriceTable({}, {})
  const base = { inText: 'x'.repeat(400), outText: 'y'.repeat(40), toolCalls: 3, durationMs: 4100, ok: true, price: (u: any, m?: string) => prices.cost(u, m) }
  const api = turnUsage({ ...base, provider: 'anthropic', model: 'claude-opus-5-5', billing: 'api', reported: { inputTokens: 1200, outputTokens: 180, cacheReadTokens: 900, cacheWriteTokens: 0 } })
  assert.equal(api.estimated, false)
  assert.ok((api.costUsd ?? 0) > 0)
  assert.equal(fmtTurn(api), '1.2k in / 180 out / 900 cached, 3 tools, 4.1s, ~$0.0050')
  const sub = turnUsage({ ...base, provider: 'codex', billing: 'subscription', reported: { inputTokens: 30000, outputTokens: 80, cacheReadTokens: 0 } })
  assert.equal(sub.costUsd, undefined)
  assert.match(fmtTurn(sub), /subscription$/)
  const cc = turnUsage({ ...base, provider: 'claude-subscription', billing: 'subscription', reported: { inputTokens: 100, outputTokens: 10, costUsd: 0.02 } })
  assert.equal(cc.reportedCostUsd, 0.02)
  assert.equal(cc.costUsd, undefined)
  assert.match(fmtTurn(cc), /subscription \(CLI est\. \$0\.020\)/)
  const est = turnUsage({ ...base, provider: 'opencode', billing: 'subscription' })
  assert.equal(est.estimated, true)
  assert.equal(est.inputTokens, 100)
  assert.equal(est.outputTokens, 10)
  assert.match(fmtTurn(est), /\(estimated\)/)
})

test('usage tracker: session, daily buckets, all time, per provider, persistence, fleet', async () => {
  const { UsageTracker, fleetUsage } = await import('../src/llm/usage.ts')
  const { Storage } = await import('../src/core/index.ts')
  const dir = tmp()
  const storage = new Storage(dir)
  let now = new Date(2026, 10, 20, 12).getTime()
  const tr = new UsageTracker('Buddy', storage, { now: () => now, keepDays: 2 })
  const turn = (provider: string, costUsd?: number) => ({ at: now, provider, billing: 'api' as const, inputTokens: 100, outputTokens: 10, cacheReadTokens: 50, cacheWriteTokens: 0, toolCalls: 2, durationMs: 1000, estimated: false, ok: true, costUsd })
  tr.record(turn('anthropic', 0.01))
  tr.record(turn('openai'))
  assert.equal(tr.today.turns, 2)
  assert.equal(tr.today.byProvider.anthropic?.turns, 1)
  assert.ok(Math.abs(tr.today.costUsd - 0.01) < 1e-12)
  now += 86_400_000
  assert.equal(tr.today.turns, 0, 'new day, new bucket')
  tr.record(turn('anthropic', 0.02))
  assert.equal(tr.allTime.turns, 3)
  assert.equal(tr.session.toolCalls, 6)
  now += 86_400_000
  tr.record(turn('anthropic'))
  assert.equal(tr.days().length, 2, 'old days pruned')
  storage.flush()
  const again = new UsageTracker('Buddy', new Storage(dir), { now: () => now })
  assert.equal(again.allTime.turns, 4, 'persisted')
  assert.equal(again.session.turns, 0, 'session starts fresh')
  const fleet = fleetUsage()
  assert.ok(fleet.bots >= 2)
  assert.ok(fleet.allTime.turns >= 8)
  tr.dispose()
  again.dispose()
})

test('budget: daily token and dollar limits come from the persisted day', () => {
  let today = { turns: 0, failedTurns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, toolCalls: 0, durationMs: 0, costUsd: 0, reportedCostUsd: 0, estimatedTurns: 0 }
  const b = new Budget({ turnsPerHour: 0, tokensPerHour: 0, usdPerHour: 0, tokensPerDay: 1000, usdPerDay: 2 }, { today: () => today })
  assert.equal(b.blocked(), null)
  today = { ...today, inputTokens: 900, outputTokens: 100 }
  assert.match(b.blocked() ?? '', /daily token budget/)
  today = { ...today, inputTokens: 0, outputTokens: 0, costUsd: 2.5 }
  assert.match(b.blocked() ?? '', /daily cost budget/)
  today = { ...today, costUsd: 0, reportedCostUsd: 50 }
  assert.equal(b.blocked(), null, 'subscription list-price estimates are not dollars spent')
})

test('runtime records usage per turn, notifies, estimates, pauses on budget', async () => {
  const snaps: any[] = []
  const withUsage = new ScriptedProvider(async (turn) => {
    await turn.tools.call('jump', {})
    return { text: '', usage: { inputTokens: 2000, outputTokens: 100, cacheReadTokens: 1500 } }
  })
  const { rt } = runtime(withUsage, { onUsage: s => snaps.push(s), limits: { tokensPerDay: 3000, turnsPerHour: 0 }, triggers: { playerCooldownMs: 0 } })
  await rt.start()
  rt.onChat({ from: 'Steve', message: 'a', whisper: true })
  await rt.idle()
  const u = rt.reports[0]!.usage!
  assert.equal(u.provider, 'scripted')
  assert.equal(u.toolCalls, 1)
  assert.equal(u.cacheReadTokens, 1500)
  assert.ok((u.costUsd ?? 0) > 0, 'priced from the table (claude-sonnet-5-5)')
  assert.equal(snaps.length, 1)
  assert.equal(snaps[0].today.turns, 1)
  assert.equal(rt.observeField().paused, null)
  rt.onChat({ from: 'Steve', message: 'b', whisper: true })
  await rt.idle()
  assert.equal(rt.paused, null, '2.1k of 3k used, second turn still runs')
  rt.onChat({ from: 'Steve', message: 'c', whisper: true })
  await rt.idle()
  assert.match(rt.paused ?? '', /daily token budget/)
  assert.equal(withUsage.inputs.length, 2)
  assert.match(rt.summary(), /today 2 turns, 4\.0k in \/ 200 out/)
  assert.match(rt.summary(), /paused/)

  const silent = new ScriptedProvider(async () => ({ text: 'hello there' }))
  const r2 = runtime(silent).rt
  await r2.start()
  r2.onChat({ from: 'Steve', message: 'hi', whisper: true })
  await r2.idle()
  assert.equal(r2.reports[0]!.usage!.estimated, true)
  assert.ok(r2.reports[0]!.usage!.inputTokens > 100)
  await rt.stop()
  await r2.stop()
})

test('exposed bridge accepts calls outside a turn', async () => {
  const agent = new FakeAgent({ dataDir: tmp() })
  const tools = new BotTools(agent, new Memory(agent.storage), { allowOutsideTurn: true })
  assert.match((await tools.call('jump', {})).text, /jumped/)
})

test('follow-ups within the conversation window need no name; others still do', async () => {
  const p = new ScriptedProvider(async () => ({ text: 'ok' }))
  const { rt } = runtime(p, { triggers: { playerCooldownMs: 0, conversationMs: 60_000 } })
  await rt.start()
  rt.onChat({ from: 'Steve', message: 'where are you', whisper: false })
  await rt.idle()
  assert.equal(p.inputs.length, 0, 'no name, no conversation yet: ignored')
  rt.onChat({ from: 'Steve', message: 'hi Buddy', whisper: false })
  await rt.idle()
  rt.onChat({ from: 'Steve', message: 'where are you', whisper: false })
  await rt.idle()
  assert.equal(p.inputs.length, 2, 'follow-up counted as addressed')
  rt.onChat({ from: 'Alex', message: 'where are you', whisper: false })
  await rt.idle()
  assert.equal(p.inputs.length, 2, "another player's message isn't part of Steve's conversation")
  rt.onChat({ from: 'Steve', message: '!stop', whisper: false })
  await rt.idle()
  assert.equal(p.inputs.length, 2, 'commands are never LLM turns')
  await rt.stop()
})

test('messages faster than the cooldown are delayed, not dropped', async () => {
  const p = new ScriptedProvider(async () => ({ text: '' }))
  const { rt } = runtime(p, { triggers: { playerCooldownMs: 200 } })
  await rt.start()
  rt.onChat({ from: 'Steve', message: 'one', whisper: true })
  await rt.idle()
  rt.onChat({ from: 'Steve', message: 'two', whisper: true })
  await new Promise(r => setTimeout(r, 300))
  await rt.idle()
  assert.equal(p.inputs.length, 2)
  assert.match(p.inputs[1]!.userMessage, /two/)
  await rt.stop()
})

test("listen 'mention' ignores follow-ups without the name", async () => {
  const p = new ScriptedProvider(async () => ({ text: 'ok' }))
  const { rt } = runtime(p, { triggers: { playerCooldownMs: 0, listen: 'mention' } })
  await rt.start()
  rt.onChat({ from: 'Steve', message: 'hi Buddy', whisper: false })
  await rt.idle()
  rt.onChat({ from: 'Steve', message: 'where are you', whisper: false })
  await rt.idle()
  assert.equal(p.inputs.length, 1)
  await rt.stop()
})

test("listen 'all' batches overheard chat into one turn and never echoes final text", async () => {
  const p = new ScriptedProvider(async () => ({ text: 'thinking out loud, should not be said' }))
  const { agent, rt } = runtime(p, { triggers: { playerCooldownMs: 0, listen: 'all', ambientBatchMs: 50, ambientMinGapMs: 0, conversationMs: 0 } })
  await rt.start()
  rt.onChat({ from: 'Steve', message: 'anyone got iron?', whisper: false })
  rt.onChat({ from: 'Steve', message: 'need like 10', whisper: false })
  await new Promise(r => setTimeout(r, 120))
  await rt.idle()
  assert.equal(p.inputs.length, 1, 'two lines, one turn')
  assert.match(p.inputs[0]!.userMessage, /overheard public chat/)
  assert.match(p.inputs[0]!.userMessage, /anyone got iron\? \| <Steve> need like 10/)
  assert.deepEqual(agent.said, [], 'overheard turns only speak through tools')
  rt.onChat({ from: 'Steve', message: 'Buddy help', whisper: false })
  await rt.idle()
  assert.equal(p.inputs.length, 2, 'a mention is still immediate')
  await rt.stop()
})

test('goal goes on alone when the owner stays silent', async () => {
  const { GoalStore } = await import('../src/llm/goals.ts')
  let now = 1_000_000
  const mem: Record<string, unknown> = {}
  const st = { get: (k: string) => mem[k], set: (k: string, v: unknown) => { mem[k] = v }, delete: (k: string) => { delete mem[k] } } as any
  const g = new GoalStore(st, { ownerWaitMin: 15 }, () => now)
  g.set('build a thing', ['a', 'b'], 'robin')
  g.update({ wait: true })
  assert.equal(g.resumeIfOwnerSilent(), false, 'too early')
  now += 16 * 60_000
  assert.equal(g.resumeIfOwnerSilent(), true)
  assert.equal(g.active!.paused, undefined)
  assert.match(g.active!.notes.at(-1)!, /didn't answer/)
  for (let i = 0; i < 2; i++) { g.update({ wait: true }); now += 16 * 60_000; assert.equal(g.resumeIfOwnerSilent(), true) }
  g.update({ wait: true }); now += 16 * 60_000
  assert.equal(g.resumeIfOwnerSilent(), false, 'max 3 times until the owner talks')
  g.touchOwner(); g.update({ wait: true }); now += 16 * 60_000
  assert.equal(g.resumeIfOwnerSilent(), true, 'owner talking resets the count')
})

test('goal does not wait for an owner who is offline', async () => {
  const { GoalStore } = await import('../src/llm/goals.ts')
  const mem: Record<string, unknown> = {}
  const st = { get: (k: string) => mem[k], set: (k: string, v: unknown) => { mem[k] = v }, delete: (k: string) => { delete mem[k] } } as any
  let now = 1_000_000
  const g = new GoalStore(st, {}, () => now)
  g.isOnline = () => false
  g.set('build', ['a'], 'robin')
  g.update({ wait: true })
  assert.equal(g.resumeIfOwnerSilent(), false, 'waits a minute first')
  now += 61_000
  assert.equal(g.resumeIfOwnerSilent(), true)
  for (let i = 0; i < 2; i++) { g.update({ wait: true }); now += 61_000; assert.equal(g.resumeIfOwnerSilent(), true) }
  g.update({ wait: true }); now += 61_000
  assert.equal(g.resumeIfOwnerSilent(), false, 'gives up after 3 until the owner is back')
  assert.match(g.fmtPrompt()!, /NOT on the server/)
})
