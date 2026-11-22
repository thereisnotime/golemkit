// A/B eval harness: runs each scenario N times per arm (same provider, model, settings and
// tasks; only the context differs) against a fake agent in a scripted world, and reports
// success rate, tool calls, latency, tokens and cost per arm.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLogger } from '../../core/index.ts'
import { loadContextPack, layoutPack } from '../../context/pack.ts'
import { skillTools } from '../../context/skills.ts'
import { LlmRuntime, type LimitOptions } from '../runtime.ts'
import { FakeAgent } from '../testing.ts'
import type { LlmProvider } from '../types.ts'
import { fmtTokens, type Billing } from '../usage.ts'
import { checkLabel, runCheck, OWNER, type RunOutcome, type Scenario } from './scenarios.ts'
import { EvalWorld } from './world.ts'

export interface Arm {
  name: string
  /** Context pack directories (empty = no pack). */
  contextDirs: string[]
  /** Files/sections left out of the pack ("AGENTS.md", "skills", "USER.md", ...). */
  exclude?: string[]
}

export interface EvalOptions {
  scenarios: Scenario[]
  arms: Arm[]
  /** Repetitions per scenario per arm. */
  n: number
  /** One provider for every run, so model and settings are identical across arms. */
  provider: LlmProvider
  username?: string
  owners?: string[]
  persona?: string
  limits?: LimitOptions
  /** Called after each run (progress output). */
  onRun?: (r: RunRecord) => void
}

export interface RunRecord {
  arm: string
  scenario: string
  rep: number
  ok: boolean
  /** Reasons the run failed: turn errors and failed checks. */
  failed: string[]
  /** Checks evaluated on what happened, even if the turn ended in an error (max turns, timeout). */
  checksOk: boolean
  toolCalls: number
  calls: string[]
  chat: string[]
  ms: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  costUsd: number
  reportedCostUsd: number
  systemTokens: number
  estimated: boolean
  error?: string
}

export interface Aggregate {
  runs: number
  successes: number
  successRate: number
  /** Runs whose checks passed, ignoring turn errors. */
  checksPassed: number
  errors: number
  meanToolCalls: number
  meanMs: number
  meanIn: number
  meanOut: number
  meanCached: number
  systemTokens: number
  costUsd: number
  reportedCostUsd: number
}

export interface EvalReport {
  startedAt: string
  provider: string
  model?: string
  billing: Billing
  n: number
  arms: Arm[]
  scenarios: { id: string, title: string, expect: string, checks: string[] }[]
  runs: RunRecord[]
  byArm: Record<string, Aggregate>
  byArmScenario: Record<string, Record<string, Aggregate>>
}

/** Provider runs the eval will make (one per scenario, arm and repetition). */
export function expectedRuns (o: Pick<EvalOptions, 'scenarios' | 'arms' | 'n'>): number {
  return o.scenarios.length * o.arms.length * o.n
}

export async function runEval (opts: EvalOptions): Promise<EvalReport> {
  const startedAt = new Date().toISOString()
  const runs: RunRecord[] = []
  const quiet = createLogger('eval')
  // Interleave arms (A, B, A, B...) so drift in provider latency hits both arms alike.
  for (let rep = 0; rep < opts.n; rep++) {
    for (const sc of opts.scenarios) {
      for (const arm of opts.arms) {
        const r = await runOne(opts, arm, sc, rep, quiet)
        runs.push(r)
        opts.onRun?.(r)
      }
    }
  }
  const byArm: Record<string, Aggregate> = {}
  const byArmScenario: Record<string, Record<string, Aggregate>> = {}
  for (const arm of opts.arms) {
    byArm[arm.name] = aggregate(runs.filter(r => r.arm === arm.name))
    byArmScenario[arm.name] = Object.fromEntries(opts.scenarios.map(s => [s.id, aggregate(runs.filter(r => r.arm === arm.name && r.scenario === s.id))]))
  }
  return {
    startedAt,
    provider: opts.provider.name,
    model: opts.provider.model,
    billing: opts.provider.billing,
    n: opts.n,
    arms: opts.arms,
    scenarios: opts.scenarios.map(s => ({ id: s.id, title: s.title, expect: s.expect, checks: s.checks.map(checkLabel) })),
    runs,
    byArm,
    byArmScenario
  }
}

async function runOne (opts: EvalOptions, arm: Arm, sc: Scenario, rep: number, _log: unknown): Promise<RunRecord> {
  const dir = mkdtempSync(join(tmpdir(), 'golemkit-eval-'))
  const world = new EvalWorld(sc.world)
  const username = opts.username ?? 'Pax'
  const agent = new FakeAgent({ dataDir: dir, username, actions: world.actions(), persona: opts.persona, observation: () => world.observe(username) })
  agent.owners = (opts.owners ?? [OWNER]).map(o => o.toLowerCase())
  // The pack's MEMORY.md is copied so the eval never writes into the real profile.
  let pack = null
  if (arm.contextDirs.length) {
    const memPath = join(dir, 'MEMORY.md')
    const src = [...arm.contextDirs].reverse().map(d => join(d, 'MEMORY.md')).find(existsSync)
    if (src && !(arm.exclude ?? []).some(x => /^memory(\.md)?$/i.test(x))) copyFileSync(src, memPath)
    pack = loadContextPack(arm.contextDirs, { exclude: arm.exclude, catalog: agent.actionCatalog().map(a => a.name), memoryFile: memPath })
  }
  const promptContext = pack ? layoutPack(pack).context : undefined
  const rt = new LlmRuntime(agent, {
    provider: opts.provider,
    persona: opts.persona,
    limits: { maxTurns: 6, maxToolCalls: 10, turnTimeoutMs: 120_000, turnsPerHour: 0, tokensPerHour: 0, usdPerHour: 0, usdPerDay: 0, ...opts.limits },
    tools: {
      startGraceMs: 300,
      actionTimeoutMs: 5000,
      extra: pack && pack.skills.length ? skillTools(() => pack.skills) : []
    },
    memory: pack?.memory ? { store: pack.memory } : {},
    ...(promptContext ? { context: () => promptContext } : {}),
    triggers: { reportLongActions: false }
  })
  const started = Date.now()
  let rec: RunRecord
  try {
    await rt.start()
    const report = await rt.runTurn({ kind: 'chat', from: sc.trigger.from, message: sc.trigger.message, whisper: sc.trigger.whisper ?? false })
    const outcome: RunOutcome = {
      calls: report.calls,
      chat: agent.said.map(s => s.msg),
      digs: world.digs,
      attacks: world.attacks,
      world: world.state,
      error: report.error ?? report.skipped
    }
    const failedChecks = sc.checks.filter(c => !runCheck(c, outcome)).map(checkLabel)
    const failed = [...(outcome.error ? [`turn error: ${outcome.error}`] : []), ...failedChecks]
    const u = report.usage
    rec = {
      arm: arm.name,
      scenario: sc.id,
      rep,
      ok: failed.length === 0,
      failed,
      checksOk: failedChecks.length === 0,
      toolCalls: report.calls.length,
      calls: report.calls.map(c => `${c.name}${c.ok ? '' : '!'}`),
      chat: outcome.chat,
      ms: u?.durationMs ?? Date.now() - started,
      inputTokens: u?.inputTokens ?? 0,
      outputTokens: u?.outputTokens ?? 0,
      cacheReadTokens: u?.cacheReadTokens ?? 0,
      costUsd: u?.costUsd ?? 0,
      reportedCostUsd: u?.reportedCostUsd ?? 0,
      systemTokens: Math.ceil(rt.systemPrompt.length / 4),
      estimated: !!u?.estimated,
      ...(outcome.error ? { error: outcome.error } : {})
    }
  } catch (e) {
    rec = { arm: arm.name, scenario: sc.id, rep, ok: false, failed: [`harness error: ${(e as Error).message}`], checksOk: false, toolCalls: 0, calls: [], chat: [], ms: Date.now() - started, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, reportedCostUsd: 0, systemTokens: 0, estimated: false, error: (e as Error).message }
  } finally {
    agent.stopActions()
    await rt.stop()
    agent.storage.flush()
    rmSync(dir, { recursive: true, force: true })
  }
  return rec
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)

function aggregate (rs: RunRecord[]): Aggregate {
  const successes = rs.filter(r => r.ok).length
  return {
    runs: rs.length,
    successes,
    successRate: rs.length ? successes / rs.length : 0,
    checksPassed: rs.filter(r => r.checksOk).length,
    errors: rs.filter(r => r.error).length,
    meanToolCalls: mean(rs.map(r => r.toolCalls)),
    meanMs: mean(rs.map(r => r.ms)),
    meanIn: mean(rs.map(r => r.inputTokens)),
    meanOut: mean(rs.map(r => r.outputTokens)),
    meanCached: mean(rs.map(r => r.cacheReadTokens)),
    systemTokens: mean(rs.map(r => r.systemTokens)),
    costUsd: rs.reduce((a, r) => a + r.costUsd, 0),
    reportedCostUsd: rs.reduce((a, r) => a + r.reportedCostUsd, 0)
  }
}

// ------------------------------------------------------------------ output

function costCell (a: Aggregate, billing: Billing): string {
  if (billing === 'api') return `$${a.costUsd.toFixed(4)}`
  if (billing === 'subscription') return a.reportedCostUsd ? `subscription (CLI est. $${a.reportedCostUsd.toFixed(3)})` : 'subscription'
  return 'local'
}

function row (cells: (string | number)[]): string {
  return `| ${cells.join(' | ')} |`
}

/** Markdown tables: per arm, then per scenario and arm, then failures. */
export function fmtReport (r: EvalReport): string {
  const lines: string[] = []
  const small = r.n < 10 ? ` N=${r.n} per scenario per arm is too small to be statistically meaningful; treat differences as anecdotes.` : ''
  lines.push(`# Context pack A/B eval`, '', `${r.startedAt}, provider ${r.provider}${r.model ? ` (${r.model})` : ''}, billing ${r.billing}, ${r.runs.length} runs.${small}`)
  if (r.provider === 'scripted') lines.push('', '**Dry run**: the provider is a scripted policy that follows rules found in the prompt. These numbers check the harness and the checks, not model behaviour.')
  if (r.runs.some(x => x.error && x.inputTokens === 0)) lines.push('', 'Turns that ended in a provider error report no token usage (the provider throws before usage is read), so token means include zeros for them.')
  lines.push('', '## Arms', '')
  for (const a of r.arms) lines.push(`- **${a.name}**: ${a.contextDirs.length ? a.contextDirs.join(', ') : 'no context pack'}${a.exclude?.length ? ` without ${a.exclude.join(', ')}` : ''}`)
  lines.push('', '## Summary', '', row(['arm', 'success', 'checks ok (ignoring turn errors)', 'turn errors', 'mean tool calls', 'mean latency', 'mean tokens in / out / cached', 'system prompt', 'cost']), row(['---', '---', '---', '---', '---', '---', '---', '---', '---']))
  for (const a of r.arms) {
    const g = r.byArm[a.name]!
    lines.push(row([a.name, `${g.successes}/${g.runs} (${Math.round(g.successRate * 100)}%)`, `${g.checksPassed}/${g.runs}`, g.errors, g.meanToolCalls.toFixed(1), `${(g.meanMs / 1000).toFixed(1)}s`, `${fmtTokens(g.meanIn)} / ${fmtTokens(g.meanOut)} / ${fmtTokens(g.meanCached)}`, `~${fmtTokens(g.systemTokens)}`, costCell(g, r.billing)]))
  }
  lines.push('', '## Per scenario', '', row(['scenario', ...r.arms.map(a => `${a.name}: success, tools, latency`)]), row(['---', ...r.arms.map(() => '---')]))
  for (const s of r.scenarios) {
    lines.push(row([s.id, ...r.arms.map(a => {
      const g = r.byArmScenario[a.name]![s.id]!
      return `${g.successes}/${g.runs}, ${g.meanToolCalls.toFixed(1)}, ${(g.meanMs / 1000).toFixed(1)}s`
    })]))
  }
  const fails = r.runs.filter(x => !x.ok)
  if (fails.length) {
    lines.push('', '## Failed runs', '')
    for (const f of fails) lines.push(`- ${f.arm} / ${f.scenario} #${f.rep + 1}: ${f.failed.join('; ')} (calls: ${f.calls.join(' ') || 'none'}; said: ${f.chat.map(c => `"${c}"`).join(' ') || 'nothing'})`)
  }
  lines.push('', '## Scenarios', '')
  for (const s of r.scenarios) lines.push(`- **${s.id}**: ${s.title}. Good: ${s.expect}. Checks: ${s.checks.join('; ')}`)
  return lines.join('\n') + '\n'
}

/** Writes <dir>/<stamp>-<label>.json and .md; returns the paths. */
export function writeReport (r: EvalReport, dir = join('data', 'evals'), label = 'context'): { json: string, md: string } {
  mkdirSync(dir, { recursive: true })
  const stamp = r.startedAt.replace(/[:.]/g, '-').slice(0, 19)
  const base = join(dir, `${stamp}-${label}`)
  writeFileSync(`${base}.json`, JSON.stringify(r, (_k, v) => (v instanceof RegExp ? String(v) : v), 2))
  writeFileSync(`${base}.md`, fmtReport(r))
  return { json: `${base}.json`, md: `${base}.md` }
}
