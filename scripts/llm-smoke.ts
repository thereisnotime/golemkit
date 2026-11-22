// Runs one LLM turn against a fake agent (fake actions, no Minecraft server) and prints
// the tool calls, chat and usage. Each run costs one provider turn, so keep it rare.
//   node --env-file-if-exists=.env scripts/llm-smoke.ts codex
//   node scripts/llm-smoke.ts claude-subscription "Buddy, follow me please"
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProvider } from '../src/llm/providers/index.ts'
import { LlmRuntime } from '../src/llm/runtime.ts'
import { FakeAgent } from '../src/llm/testing.ts'

const name = process.argv[2] || process.env.MC_LLM_PROVIDER || 'claude-subscription'
const message = process.argv[3] || 'please come over here, and tell me when you are on the way'
const dir = mkdtempSync(join(tmpdir(), 'golemkit-smoke-'))
const agent = new FakeAgent({ dataDir: dir, username: 'Buddy', persona: 'A cheerful helper. Very short answers.' })
const provider = createProvider(name)
const rt = new LlmRuntime(agent, {
  provider,
  limits: { maxTurns: 4, maxToolCalls: 4, turnTimeoutMs: Number(process.env.MC_LLM_TIMEOUT_MS || 180_000) }
})

let code = 0
try {
  const why = await provider.check()
  if (why) throw new Error(`${name} unavailable: ${why}`)
  await rt.start()
  console.log(`provider ${name}${rt.bridge ? `, MCP bridge ${rt.bridge.url}` : ''}`)
  console.log(`send> (whisper) <Steve> ${message}`)
  const started = Date.now()
  const report = await rt.runTurn({ kind: 'chat', from: 'Steve', message, whisper: true })
  console.log(`\n${((Date.now() - started) / 1000).toFixed(1)}s`)
  for (const c of report.calls) console.log(`tool> ${c.name} ${JSON.stringify(c.args)} -> ${c.ok ? 'ok' : 'FAIL'}: ${c.result.slice(0, 120)}`)
  for (const a of agent.calls) console.log(`act>  ${a.name} ${JSON.stringify(a.params)} priority=${a.priority} player=${a.player ?? '-'}`)
  for (const s of agent.said) console.log(`chat> ${s.to ? `(to ${s.to}) ` : ''}${s.msg}`)
  if (report.result) console.log(`final> ${report.result.text || '(none)'}\nusage> ${JSON.stringify(report.result.usage ?? {})} ${report.result.detail ?? ''}`)
  if (report.error || report.skipped) { console.log(`error> ${report.error ?? report.skipped}`); code = 1 }
} catch (e) {
  console.error(String((e as Error).message))
  code = 1
} finally {
  agent.stopActions()
  await rt.stop()
  rmSync(dir, { recursive: true, force: true })
}
process.exit(code)
