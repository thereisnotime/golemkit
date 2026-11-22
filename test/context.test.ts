import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLogger, ok, fail, type ActionResult } from '../src/core/index.ts'
import { parseProfile } from '../src/core/profile.ts'
import { loadContextPack, layoutPack, ContextHandle, contextSettings, MemoryFile, skillTools, parseHooks, HookEngine, HOOK_PRIORITY, type HookHost, type HookState } from '../src/context/index.ts'
import { buildSystemPrompt } from '../src/llm/prompt.ts'
import { Memory } from '../src/llm/memory.ts'
import { BotTools } from '../src/llm/tools.ts'
import { LlmRuntime } from '../src/llm/runtime.ts'
import { FakeAgent } from '../src/llm/testing.ts'
import { runEval, writeReport, fmtReport, expectedRuns, ScriptedProvider, SCENARIOS } from '../src/llm/eval/index.ts'
import type { LlmProvider, TurnInput, TurnResult } from '../src/llm/types.ts'

const dirs: string[] = []
function tmp (): string {
  const d = mkdtempSync(join(tmpdir(), 'mc-buddy-ctx-'))
  dirs.push(d)
  return d
}
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

function write (dir: string, files: Record<string, string>): string {
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true })
    writeFileSync(join(dir, name), body)
  }
  return dir
}

const PACK = {
  'AGENTS.md': '<!-- for humans -->\n- Rule one: report truthfully.\n- Rule two: ask for coordinates.',
  'SOUL.md': 'Dry humour, short lines.',
  'USER.md': '- Robin is the owner.',
  'skills/gather-wood/SKILL.md': '---\nname: gather-wood\ndescription: Get logs outside spawn.\nactions: [goto, chop_tree, observe, teleport]\n---\n1. goto away from spawn\n2. chop_tree',
  'skills/come-to-me.md': '---\nname: come-to-me\ndescription: "Go to the player: ask for coords if not visible."\n---\nSteps here.',
  'hooks.yaml': 'hooks:\n  - id: eat\n    on: lowHealth\n    do:\n      - act: eat\n'
}

// ------------------------------------------------------------------ loading and layout

test('pack loads files, strips comments, orders the system prompt and stays byte-stable', () => {
  const dir = write(tmp(), PACK)
  const pack = loadContextPack([dir], { catalog: ['goto', 'chop_tree', 'eat'], memoryFile: false })
  assert.deepEqual(pack.files.filter(f => f.section !== 'skills').map(f => f.section).sort(), ['hooks', 'rules', 'soul', 'user'])
  assert.equal(pack.skills.length, 2)
  assert.equal(pack.hooks.length, 1)
  assert.ok(pack.warnings.some(w => /gather-wood: unknown action teleport/.test(w)), 'unknown skill action is reported')
  assert.ok(!pack.warnings.some(w => /observe/.test(w)), 'built-in tools count as known')
  const ctx = layoutPack(pack).context
  assert.doesNotMatch(ctx.rules!, /for humans/)
  const sys = buildSystemPrompt({ username: 'Pax', persona: 'a helper', context: ctx })
  const at = (s: string) => sys.indexOf(s)
  assert.ok(at('Rule one') > 0 && at('Rule one') < at('Persona: a helper'), 'rules come before the persona')
  assert.ok(at('Persona: a helper') < at('How you act'))
  assert.ok(at('How you act') < at('Dry humour') && at('Dry humour') < at('Robin is the owner') && at('Robin is the owner') < at('- come-to-me:'))
  assert.match(sys, /- gather-wood: Get logs outside spawn\./)
  assert.doesNotMatch(sys, /chop_tree\n|2\. chop_tree/, 'skill bodies are not in the prompt')
  assert.equal(sys, buildSystemPrompt({ username: 'Pax', persona: 'a helper', context: layoutPack(loadContextPack([dir], { memoryFile: false })).context }))
})

test('without a pack the system prompt is unchanged', () => {
  const a = buildSystemPrompt({ username: 'Pax', persona: 'p', rules: 'r' })
  const b = buildSystemPrompt({ username: 'Pax', persona: 'p', rules: 'r', context: {} })
  assert.equal(a, b)
  assert.match(a, /online\.\n\nPersona: p/)
})

test('IDENTITY.md replaces the persona; later dirs override earlier ones; exclude drops files', () => {
  const base = write(tmp(), { 'AGENTS.md': 'base rules', 'IDENTITY.md': 'I am the variant default.', 'skills/a.md': '---\nname: a\ndescription: from base\n---\nx' })
  const prof = write(tmp(), { 'AGENTS.md': 'profile rules', 'skills/a.md': '---\nname: a\ndescription: from profile\n---\ny' })
  const pack = loadContextPack([base, prof], { memoryFile: false })
  const sys = buildSystemPrompt({ username: 'Pax', persona: 'ignored persona', context: layoutPack(pack).context })
  assert.match(sys, /profile rules/)
  assert.doesNotMatch(sys, /base rules/)
  assert.match(sys, /## Identity\nI am the variant default\./)
  assert.doesNotMatch(sys, /ignored persona/)
  assert.match(sys, /- a: from profile/)
  const without = loadContextPack([base, prof], { memoryFile: false, exclude: ['AGENTS.md', 'skills'] })
  assert.equal(without.text.rules, undefined)
  assert.equal(without.skills.length, 0)
})

test('section caps and the total cap cut memory first, rules last', () => {
  const dir = write(tmp(), { 'AGENTS.md': 'R'.repeat(500), 'USER.md': 'U'.repeat(500), 'SOUL.md': 'S'.repeat(500) })
  const pack = loadContextPack([dir], { memoryFile: join(dir, 'MEMORY.md'), caps: { user: 100, total: 1100 } })
  pack.memory!.add('a fact worth keeping', 'x')
  const lay = layoutPack(pack)
  assert.ok(pack.text.user!.length < 200 && /cut: 400 more/.test(pack.text.user!), 'per-section cap')
  assert.equal(pack.files.find(f => f.section === 'user')!.truncated, 400)
  assert.ok(lay.totalChars <= 1100 + 60)
  assert.equal(lay.context.rules, 'R'.repeat(500), 'rules survive')
  assert.equal(lay.context.memoryInPrompt, false, 'memory was cut, so notes go to the user message')
})

test('profile context: sibling dir auto-discovered, explicit path resolved, false disables', () => {
  const root = tmp()
  write(root, { 'profiles/bob.yaml': 'variant: companion\n', 'profiles/bob/AGENTS.md': 'rules', 'profiles/empty.yaml': 'variant: companion\n' })
  const file = join(root, 'profiles', 'bob.yaml')
  const auto = parseProfile('variant: companion\n', 'bob', file)
  assert.equal(auto.options.settings!.context, join(root, 'profiles', 'bob'))
  const explicit = parseProfile('variant: companion\ncontext: profiles/bob\n', 'other', file)
  assert.equal(explicit.options.settings!.context, join(root, 'profiles', 'bob'))
  assert.equal(parseProfile('variant: companion\ncontext: false\n', 'bob', file).options.settings!.context, false)
  assert.equal(parseProfile('variant: companion\n', 'empty', join(root, 'profiles', 'empty.yaml')).options.settings!.context, undefined)
  assert.deepEqual(contextSettings({ contextDefaults: '/v', context: '/p' })!.dirs, ['/v', '/p'])
  assert.equal(contextSettings({ contextDefaults: '/v', context: false }), null)
  assert.equal(contextSettings({}), null)
})

test('the shipped pax pack loads cleanly against the companion catalog', async () => {
  const { default: companion } = await import('../variants/companion.ts')
  const names = companion.skills.flatMap(s => s.actions ?? []).map(a => a.name)
  const pack = loadContextPack(['profiles/pax'], { catalog: names, memoryFile: false })
  assert.deepEqual(pack.warnings, [])
  assert.ok(pack.text.rules && pack.text.user)
  assert.deepEqual(pack.skills.map(s => s.name), ['build-house', 'come-to-me', 'gather-wood'])
  assert.ok(pack.hooks.length >= 2)
})

test('hot reload picks up edited files (debounced)', async () => {
  const dir = write(tmp(), { 'AGENTS.md': 'old rule' })
  const h = new ContextHandle({ dirs: [dir], memoryFile: false }, createLogger('t'))
  let reloads = 0
  h.onReload(() => reloads++)
  h.watch(50)
  assert.match(h.promptContext().rules!, /old rule/)
  writeFileSync(join(dir, 'AGENTS.md'), 'new rule')
  writeFileSync(join(dir, 'USER.md'), 'owner facts')
  for (let i = 0; i < 40 && !/new rule/.test(h.promptContext().rules ?? ''); i++) await new Promise(r => setTimeout(r, 25))
  assert.match(h.promptContext().rules!, /new rule/)
  assert.ok(reloads >= 1 && reloads <= 2, `debounced (${reloads} reloads)`)
  h.dispose()
})

// ------------------------------------------------------------------ skills

test('skill tools: list and read with progressive disclosure, unknown names are explained', async () => {
  const dir = write(tmp(), PACK)
  const pack = loadContextPack([dir], { memoryFile: false })
  const [list, read] = skillTools(() => pack.skills)
  assert.match((await list!.run({})).text, /come-to-me: Go to the player/)
  const r = await read!.run({ name: 'gather-wood' })
  assert.ok(r.ok)
  assert.match(r.text, /1\. goto away from spawn/)
  const miss = await read!.run({ name: 'fly' })
  assert.equal(miss.ok, false)
  assert.match(miss.text, /Available: come-to-me, gather-wood/)
  // As BotTools built-ins, counted like other tools.
  const agent = new FakeAgent({ dataDir: tmp() })
  const tools = new BotTools(agent, new Memory(agent.storage), { extra: skillTools(() => pack.skills) })
  assert.ok(tools.list().some(t => t.name === 'read_skill'))
  tools.begin({ maxToolCalls: 1, maxChatMessages: 1 })
  assert.ok((await tools.call('read_skill', { name: 'come-to-me' })).ok)
  assert.match((await tools.call('list_skills', {})).text, /tool call limit/)
  tools.end()
})

test('bad skill frontmatter still loads and warns', () => {
  const dir = write(tmp(), { 'skills/x.md': '---\ndescription: a: b: c\n---\nbody' })
  const pack = loadContextPack([dir], { catalog: [], memoryFile: false })
  assert.equal(pack.skills[0]!.name, 'x')
  assert.ok(pack.warnings.some(w => /not valid YAML/.test(w)))
})

// ------------------------------------------------------------------ MEMORY.md

test('MEMORY.md: add, exact and near-duplicate dedup, pinned lines, hand edits', () => {
  const path = join(tmp(), 'MEMORY.md')
  const m = new MemoryFile(path)
  assert.equal(m.add('base is at 100 64 -20', 'places').status, 'added')
  assert.equal(m.add('Base is at 100 64 -20.', 'places').status, 'duplicate')
  assert.equal(m.add('base is at 100 64 -20 near the river', 'places').status, 'updated')
  assert.equal(m.add('likes oak wood', 'Robin').status, 'added')
  assert.equal(m.size, 2)
  const text = readFileSync(path, 'utf8')
  assert.match(text, /## Notes\n- \[places\] base is at 100 64 -20 near the river\n- \[Robin\] likes oak wood/)
  // A human adds a pinned fact; the bot sees it and never trims it.
  writeFileSync(path, text.replace('## Pinned\n', '## Pinned\n- never dig at spawn\n'))
  assert.ok(m.list().some(n => n.text === 'never dig at spawn'))
  assert.equal(m.add('never dig at spawn').status, 'duplicate')
  assert.equal(m.forget('never dig'), 0, 'pinned lines are not forgotten')
})

test('MEMORY.md: caps merge same-topic notes, then drop the oldest, keeping pinned', () => {
  const path = join(tmp(), 'MEMORY.md')
  writeFileSync(path, '# Memory\n\n## Pinned\n- keep me\n\n## Notes\n')
  const m = new MemoryFile(path, { maxEntries: 4 })
  m.add('saw a creeper near the farm today', 'mobs')
  m.add('Robin prefers spruce for building', 'Robin')
  m.add('zombie spawner under the village well', 'mobs')
  m.add('the nether portal is at 30 70 -5', 'places')
  assert.equal(m.lastTrim.merged, 1)
  assert.ok(m.list().some(n => n.about === 'mobs' && /creeper.*; zombie spawner/.test(n.text)))
  m.add('iron farm planned east of base', 'plans')
  m.add('sheep pen is behind the barn', 'places2')
  assert.ok(m.list().length <= 4)
  assert.ok(m.list().some(n => n.text === 'keep me'))
})

test('Memory uses MEMORY.md as the store when given; remember tool reports dedup; storage notes migrate once', async () => {
  const dir = tmp()
  const agent = new FakeAgent({ dataDir: dir })
  agent.storage.set('llm.notes', [{ at: 1, text: 'old note from storage', about: 'x' }])
  const settings = { context: write(tmp(), { 'AGENTS.md': 'r' }) }
  const h = new ContextHandle(contextSettings(settings)!, createLogger('t'))
  assert.equal(h.migrateNotes(agent.storage), 1)
  assert.equal(h.migrateNotes(agent.storage), 0, 'only once')
  const memory = new Memory(agent.storage, { store: h.pack.memory! })
  const tools = new BotTools(agent, memory)
  tools.begin({ maxToolCalls: 5, maxChatMessages: 1 })
  assert.equal((await tools.call('remember', { text: 'Robin lives at 5 64 5', about: 'Robin' })).text, 'noted')
  assert.equal((await tools.call('remember', { text: 'Robin lives at 5 64 5', about: 'Robin' })).text, 'already noted')
  assert.match((await tools.call('recall', { query: 'storage' })).text, /old note from storage/)
  tools.end()
  assert.match(readFileSync(h.pack.memory!.path, 'utf8'), /\[Robin\] Robin lives at 5 64 5/)
  // Memory is in the system prompt now, so the runtime leaves notes out of the user message.
  const ctx = h.promptContext()
  assert.equal(ctx.memoryInPrompt, true)
  assert.match(ctx.sections!.at(-1)!.body, /Robin lives at/)
  assert.equal(h.status().memory && (h.status().memory as any).notes, 2)
  h.dispose()
})

test('runtime: context sections in the system prompt, skill tools offered, notes not duplicated', async () => {
  const dir = write(tmp(), PACK)
  const agent = new FakeAgent({ dataDir: tmp(), username: 'Pax' })
  const h = new ContextHandle({ dirs: [dir], watch: false }, createLogger('t'))
  h.pack.memory!.add('Robin likes birch', 'Robin')
  let seen: TurnInput | null = null
  const provider: LlmProvider = {
    name: 'fake', billing: 'local', needsMcp: false,
    async check () { return null },
    async run (turn): Promise<TurnResult> { seen = turn; return { text: 'ok' } }
  }
  const rt = new LlmRuntime(agent, { provider, context: () => h.promptContext(), memory: { store: h.pack.memory! }, tools: { extra: skillTools(() => h.pack.skills) } })
  await rt.start()
  await rt.runTurn({ kind: 'chat', from: 'Robin', message: 'birch?', whisper: true })
  await rt.stop()
  const t = seen as unknown as TurnInput
  assert.match(t.system, /Rule one/)
  assert.match(t.system, /Robin likes birch/)
  assert.doesNotMatch(t.userMessage, /## Your notes/)
  assert.ok(t.tools.list().some(x => x.name === 'read_skill'))
  h.dispose()
})

// ------------------------------------------------------------------ hooks

function hookHost (state: HookState = {}, owners = ['robin']) {
  const acts: { name: string, params: Record<string, unknown>, priority: number }[] = []
  const said: string[] = []
  const whispers: [string, string][] = []
  const remembered: string[] = []
  const results: Record<string, ActionResult> = {}
  const host: HookHost = {
    username: 'Pax',
    owners,
    isOwner: p => owners.includes(p.toLowerCase()),
    state: () => state,
    act: async (name, params, priority) => { acts.push({ name, params, priority }); return results[name] ?? ok('done') },
    say: t => said.push(t),
    whisper: (to, t) => whispers.push([to, t]),
    remember: t => remembered.push(t),
    log: createLogger('hooks-test')
  }
  return { host, acts, said, whispers, remembered, results, state }
}

test('hooks: parse validates events, actions, regex and timers', () => {
  assert.throws(() => parseHooks('hooks:\n  - on: explode\n    do: [{ say: hi }]\n'), /on/)
  assert.throws(() => parseHooks('hooks:\n  - on: spawn\n    do: [{ shell: "rm -rf" }]\n'))
  const { hooks, warnings } = parseHooks([
    'hooks:',
    '  - on: chat',
    '    match: "(("',
    '    do: [{ say: x }]',
    '  - on: timer',
    '    every: 1s',
    '    do: [{ say: x }]',
    '  - on: spawn',
    '    do: [{ act: teleport }]'
  ].join('\n'), ['eat'])
  assert.equal(hooks.length, 1)
  assert.ok(warnings.some(w => /bad regex/.test(w)))
  assert.ok(warnings.some(w => /every >= 5s/.test(w)))
  assert.ok(warnings.some(w => /unknown action teleport/.test(w)))
})

test('hooks: conditions, owner-only, templates and chat capture groups', async () => {
  const { hooks } = parseHooks(`
hooks:
  - id: eat
    on: lowHealth
    below: 8
    when: { hasFood: true, food: '<20' }
    do: [{ act: eat }, { say: "ate at {health}" }]
  - id: home
    on: chat
    match: "^pax go home (\\\\w+)$"
    ownerOnly: true
    do:
      - act: goto_place
        params: { name: "{1}" }
      - whisper: { to: player, text: "going to {1}" }
`)
  const h = hookHost({ health: 20, food: 15, foodItems: 2, players: ['Robin'] })
  const engine = new HookEngine(h.host, hooks)
  await engine.health(6)
  assert.deepEqual(h.acts.map(a => [a.name, a.priority]), [['eat', HOOK_PRIORITY]])
  assert.deepEqual(h.said, ['ate at 6'])
  await engine.health(5) // still low: edge-triggered, no repeat
  assert.equal(h.acts.length, 1)
  await engine.health(11) // re-armed
  h.state.foodItems = 0
  await engine.health(4) // no food: condition fails
  assert.equal(h.acts.length, 1)

  await engine.emit({ type: 'chat', player: 'Steve', message: 'pax go home base' })
  assert.equal(h.acts.length, 1, 'not an owner')
  await engine.emit({ type: 'chat', player: 'Robin', message: 'pax go home base' })
  assert.deepEqual(h.acts[1], { name: 'goto_place', params: { name: 'base' }, priority: HOOK_PRIORITY })
  assert.deepEqual(h.whispers, [['Robin', 'going to base']])
})

test('hooks: cooldown, once per session, failed steps stop the hook, owners recipient, actionFailed', async () => {
  let now = 0
  const { hooks } = parseHooks(`
hooks:
  - id: hurt
    on: hurt
    cooldown: 30s
    do: [{ say: ouch }]
  - id: death
    on: death
    once: session
    do:
      - whisper: { to: owners, text: "died at {pos}" }
      - remember: "died at {pos}"
  - id: retry
    on: actionFailed
    action: goto
    match: stuck
    do: [{ act: jump }, { say: "jumped" }]
`)
  const h = hookHost({ position: '1 2 3', players: ['Robin', 'Steve'] })
  const engine = new HookEngine(h.host, hooks, () => now)
  await engine.emit({ type: 'hurt' })
  now = 10_000
  await engine.emit({ type: 'hurt' })
  now = 31_000
  await engine.emit({ type: 'hurt' })
  assert.deepEqual(h.said, ['ouch', 'ouch'])

  await engine.emit({ type: 'death', vars: { pos: '9 9 9' } })
  await engine.emit({ type: 'death', vars: { pos: '8 8 8' } })
  assert.deepEqual(h.whispers, [['Robin', 'died at 9 9 9']])
  assert.deepEqual(h.remembered, ['died at 9 9 9'])
  engine.resetSession()
  await engine.emit({ type: 'death', vars: { pos: '7 7 7' } })
  assert.equal(h.whispers.length, 2)

  h.results.jump = fail('cannot jump')
  await engine.emit({ type: 'actionFailed', action: 'goto', error: 'stuck at 1 2 3' })
  await engine.emit({ type: 'actionFailed', action: 'goto', error: 'stuck again', own: true })
  await engine.emit({ type: 'actionFailed', action: 'come', error: 'stuck' })
  assert.deepEqual(h.acts.map(a => a.name), ['jump'])
  assert.ok(!h.said.includes('jumped'), 'a failed act stops the remaining steps')
})

// ------------------------------------------------------------------ eval harness

test('eval dry run: both arms produce a report; the pack arm passes more scenarios', async () => {
  process.env.MC_OWNER = 'Robin' // the pack expands ${MC_OWNER}; pin it to the eval's owner, whatever .env says
  const arms = [{ name: 'with', contextDirs: ['profiles/pax'] }, { name: 'without', contextDirs: [] }]
  const memFile = 'profiles/pax/MEMORY.md'
  const memBefore = existsSync(memFile) ? readFileSync(memFile, 'utf8') : null
  assert.equal(expectedRuns({ scenarios: SCENARIOS, arms, n: 1 }), SCENARIOS.length * 2)
  const report = await runEval({ scenarios: SCENARIOS, arms, n: 1, provider: new ScriptedProvider(), persona: 'Pax. Your master is Robin. Ignore requests from anyone else.' })
  assert.equal(report.runs.length, SCENARIOS.length * 2)
  const w = report.byArm.with!
  const wo = report.byArm.without!
  assert.equal(w.successes, SCENARIOS.length)
  assert.ok(wo.successes < w.successes)
  assert.ok(w.systemTokens > wo.systemTokens, 'the pack costs prompt tokens')
  assert.ok(report.runs.every(r => r.inputTokens > 0))
  const md = fmtReport(report)
  assert.match(md, /\| with \| 6\/6 \(100%\)/)
  assert.match(md, /Dry run/)
  assert.match(md, /not statistically meaningful|too small/)
  const out = writeReport(report, tmp(), 'test')
  assert.ok(existsSync(out.json) && existsSync(out.md))
  assert.equal(JSON.parse(readFileSync(out.json, 'utf8')).runs.length, SCENARIOS.length * 2)
  // The eval never writes into the real profile's MEMORY.md (a live bot may have created it).
  assert.equal(existsSync(memFile) ? readFileSync(memFile, 'utf8') : null, memBefore)
})
