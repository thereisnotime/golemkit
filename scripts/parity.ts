// Offline parity checks for the game-adapter split (openspec/changes/game-adapters/tasks.md):
// tsc, the unit tests (golden snapshots and the packet replay are among them), the intents
// bench against its saved baseline, and the scope-check counts. Prints one summary line each.
//   node scripts/parity.ts [--save-intents]     --save-intents rewrites the intents baseline
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

const BASELINE = 'openspec/changes/game-adapters/bench/intents-baseline.json'
const rows: [string, string][] = []
let failed = false

const tsc = spawnSync('npx', ['tsc', '-p', '.'], { encoding: 'utf8' })
const tscErrors = (tsc.stdout.match(/error TS/g) ?? []).length
rows.push(['tsc', tsc.status === 0 ? 'clean' : `${tscErrors} errors`])
if (tsc.status !== 0) failed = true

const t = spawnSync('node', ['--test', 'test/'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const num = (k: string) => Number(new RegExp(`ℹ ${k} (\\d+)`).exec(t.stdout)?.[1] ?? NaN)
rows.push(['unit tests', `${num('tests')} tests, ${num('pass')} pass, ${num('fail')} fail, ${num('skipped')} skipped`])
const names = (re: RegExp) => new Set((t.stdout.match(re) ?? []).map(l => l.replace(/ \([\d.]+ms\)$/, ''))).size
const golden = names(/^✔ golden: .*$/gm)
const goldenFail = names(/^✖ golden: .*$/gm)
rows.push(['golden snapshots', `${golden} identical, ${goldenFail} differ`])
const replay = /^✔ replay: /m.test(t.stdout) ? 'identical' : /^✖ replay: /m.test(t.stdout) ? 'DIFFERS' : 'not run'
rows.push(['packet replay', replay])
if (t.status !== 0 || goldenFail || replay !== 'identical') failed = true

// intents bench: everything except timings must match the baseline
const out = join(mkdtempSync(join(tmpdir(), 'parity-')), 'intents.json')
execFileSync('node', ['scripts/intents-bench.ts', '--json', out, '--quiet'], { stdio: ['ignore', 'ignore', 'ignore'] })
const strip = (j: any) => j.results.map((r: any) => ({ config: r.config, set: r.set, n: r.n, accuracy: r.accuracy, macroF1: r.macroF1, falseTriggerCount: r.falseTriggerCount, misses: r.misses, slotAccuracy: r.slotAccuracy, slotCases: r.slotCases, errors: r.errors }))
const now = strip(JSON.parse(readFileSync(out, 'utf8')))
if (process.argv.includes('--save-intents')) writeFileSync(BASELINE, JSON.stringify({ results: now }, null, 2) + '\n')
const base = JSON.parse(readFileSync(BASELINE, 'utf8')).results
const same = isDeepStrictEqual(now, base)
rows.push(['intents bench', `${same ? 'identical' : 'DIFFERS'} (${now.map((r: any) => `${r.config}/${r.set} ${r.accuracy}`).join(', ')})`])
if (!same) failed = true

const scope = execFileSync('node', ['scripts/scope-check.ts'], { encoding: 'utf8' })
const outside = /outside .*\((\d+)\)/.exec(scope)?.[1]
rows.push(['scope-check', `${outside} files import Minecraft packages outside the expected places`])

for (const [k, v] of rows) console.log(`${k.padEnd(18)} ${v}`)
process.exit(failed ? 1 : 0)
