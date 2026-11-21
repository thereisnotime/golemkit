// A/B eval of a context pack: same provider, model, tasks and settings, with and without the
// pack (or one file of it). Dry mode uses a scripted fake provider (free, deterministic).
// Real providers cost quota: the script prints how many runs it will make and needs --yes.
//
//   node scripts/llm-eval.ts --dry                              # pax pack vs no pack, scripted
//   node scripts/llm-eval.ts --dry --without AGENTS.md          # full pack vs pack minus AGENTS.md
//   node scripts/llm-eval.ts --profile pax --login .auth/eval -n 1 --scenarios come-not-visible,get-wood --yes
//   node scripts/llm-eval.ts --arm a=profiles/pax --arm b=none --dry
import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { loadProfile, PROFILES_DIR } from '../src/core/profile.ts'
import { configureLogging } from '../src/core/index.ts'
import { contextSettings } from '../src/context/handle.ts'
import { createProvider } from '../src/llm/providers/index.ts'
import { runEval, expectedRuns, fmtReport, writeReport, type Arm } from '../src/llm/eval/harness.ts'
import { SCENARIOS } from '../src/llm/eval/scenarios.ts'
import { ScriptedProvider } from '../src/llm/eval/scripted.ts'
import type { LlmProvider } from '../src/llm/types.ts'

const { values } = parseArgs({
  options: {
    dry: { type: 'boolean', default: false },
    yes: { type: 'boolean', default: false },
    profile: { type: 'string', default: 'pax' },
    provider: { type: 'string' },
    model: { type: 'string' },
    effort: { type: 'string' },
    login: { type: 'string' },
    n: { type: 'string', short: 'n' },
    scenarios: { type: 'string' },
    without: { type: 'string', multiple: true },
    arm: { type: 'string', multiple: true },
    out: { type: 'string', default: 'data/evals' },
    label: { type: 'string', default: 'context' },
    verbose: { type: 'boolean', short: 'v', default: false },
    help: { type: 'boolean', short: 'h', default: false }
  }
})

if (values.help) {
  console.log(`usage: node scripts/llm-eval.ts [--dry] [--profile pax] [-n N] [--scenarios a,b] [--without FILE]... [--arm name=dir|none|dir:-FILE,-FILE]...
         [--provider P --model M --effort E --login DIR] [--yes] [--out data/evals]
scenarios: ${SCENARIOS.map(s => s.id).join(', ')}`)
  process.exit(0)
}

configureLogging({ level: process.env.MC_LOG_LEVEL ?? (values.verbose ? 'info' : 'warn') })

const profile = loadProfile(values.profile!, resolve(PROFILES_DIR))
if (!profile) throw new Error(`no profile ${values.profile}`)
const packDirs = contextSettings(profile.options.settings ?? {})?.dirs ?? []

function parseArm (spec: string): Arm {
  const [name, rest = ''] = spec.includes('=') ? spec.split(/=(.*)/s) as [string, string] : [spec, spec]
  if (rest === 'none' || rest === '') return { name, contextDirs: [] }
  const [dir, ex] = rest.split(':') as [string, string | undefined]
  const dirs = dir === 'pack' ? packDirs : [resolve(dir)]
  const exclude = ex ? ex.split(',').map(s => s.replace(/^-/, '')).filter(Boolean) : undefined
  return { name, contextDirs: dirs, ...(exclude ? { exclude } : {}) }
}

let arms: Arm[]
if (values.arm?.length) arms = values.arm.map(parseArm)
else if (values.without?.length) arms = [{ name: 'full-pack', contextDirs: packDirs }, { name: `without-${values.without.join('+')}`, contextDirs: packDirs, exclude: values.without }]
else arms = [{ name: 'with-pack', contextDirs: packDirs }, { name: 'no-pack', contextDirs: [] }]
if (arms.some(a => a.contextDirs.length === 0) && !packDirs.length && !values.arm?.length) console.warn(`warning: profile ${profile.name} has no context pack; both arms are the same`)

const ids = values.scenarios?.split(',').map(s => s.trim()).filter(Boolean)
const scenarios = ids ? SCENARIOS.filter(s => ids.includes(s.id)) : SCENARIOS
if (ids && scenarios.length !== ids.length) throw new Error(`unknown scenario in ${ids.join(',')}; have ${SCENARIOS.map(s => s.id).join(', ')}`)
const n = Number(values.n ?? (values.dry ? 3 : 1))

const llm = (profile.options.settings?.llm ?? {}) as Record<string, unknown>
let provider: LlmProvider
if (values.dry) {
  provider = new ScriptedProvider()
} else {
  const name = values.provider ?? (llm.provider as string | undefined) ?? 'claude-subscription'
  const keys = ['model', 'effort', 'login', 'oauthTokenVar', 'oauthTokenFile', 'mode', 'transport', 'baseUrl', 'proxy']
  const fromProfile = Object.fromEntries(keys.filter(k => llm[k] !== undefined).map(k => [k, llm[k]]))
  provider = createProvider(name, {
    ...fromProfile,
    ...(values.model ? { model: values.model } : {}),
    ...(values.effort ? { effort: values.effort } : {}),
    ...(values.login ? { login: values.login } : {})
  })
}

const total = expectedRuns({ scenarios, arms, n })
console.log(`eval: ${scenarios.length} scenarios x ${arms.length} arms x N=${n} = ${total} provider runs (${provider.name}${provider.model ? ` ${provider.model}` : ''}, billing ${provider.billing})`)
for (const a of arms) console.log(`  arm ${a.name}: ${a.contextDirs.join(', ') || 'no pack'}${a.exclude ? ` without ${a.exclude.join(', ')}` : ''}`)
if (!values.dry) {
  console.log('  each run is one model turn (several round trips inside it count against the same quota)')
  if (!values.yes) {
    console.log('real provider: this spends quota. Re-run with --yes to start (or use --dry).')
    process.exit(2)
  }
  const why = await provider.check()
  if (why) { console.error(`${provider.name} unavailable: ${why}`); process.exit(1) }
}

// Same per-turn limits as the live bot (profile llm.budget), so the eval sees what Pax would do.
const budget = (llm.budget ?? {}) as Record<string, number>
const limits = { maxTurns: budget.maxTurns ?? 8, maxToolCalls: budget.maxToolCalls ?? 12, maxChatMessages: budget.maxChatMessages ?? 3, turnTimeoutMs: budget.turnTimeoutMs ?? 120_000 }
console.log(`  limits per turn: ${limits.maxTurns} model round trips, ${limits.maxToolCalls} tool calls, ${limits.maxChatMessages} chat messages`)

const report = await runEval({
  limits,
  scenarios,
  arms,
  n,
  provider,
  username: profile.options.username ?? 'Pax',
  owners: profile.options.owners,
  persona: profile.options.persona,
  onRun: r => console.log(`  ${r.ok ? 'PASS' : 'FAIL'} ${r.arm.padEnd(16)} ${r.scenario.padEnd(18)} #${r.rep + 1}  ${r.toolCalls} tools  ${(r.ms / 1000).toFixed(1)}s  ${r.inputTokens}/${r.outputTokens} tok  ${r.calls.join(' ')}${r.ok ? '' : `  <- ${r.failed.join('; ')}`}`)
})
console.log('\n' + fmtReport(report))
const paths = writeReport(report, values.out, values.dry ? `${values.label}-dry` : values.label)
console.log(`report: ${paths.md}\n        ${paths.json}`)
