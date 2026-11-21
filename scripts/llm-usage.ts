// LLM usage report from a bot's journal: turns and tokens by trigger, model and hour, plus the
// proxy (caveman) counters summed over the period.
//   node scripts/llm-usage.ts Pax [2026-11-21] [--days 3]
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const bot = args.find(a => !a.startsWith('--') && !/^\d{4}-\d\d-\d\d$/.test(a)) ?? 'Pax'
const day = args.find(a => /^\d{4}-\d\d-\d\d$/.test(a))
const days = Number(args[args.indexOf('--days') + 1]) || 1
const dir = join('data', 'bots', bot, 'journal')
if (!existsSync(dir)) { console.error(`no journal at ${dir}`); process.exit(1) }

const files = readdirSync(dir).filter(f => /^\d{4}-\d\d-\d\d\.jsonl$/.test(f)).sort()
const pick = day ? files.filter(f => f.slice(0, 10) <= day).slice(-days) : files.slice(-days)

interface Row { n: number, input: number, cached: number, cacheWrite: number, output: number, ms: number, cost: number }
const empty = (): Row => ({ n: 0, input: 0, cached: 0, cacheWrite: 0, output: 0, ms: 0, cost: 0 })
const total = empty()
const by: Record<string, Record<string, Row>> = { trigger: {}, model: {}, hour: {} }
const proxy: Record<string, number> = {}

for (const f of pick) {
  for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
    if (!line.includes('"llm_turn"')) continue
    let e: any
    try { e = JSON.parse(line) } catch { continue }
    if (e.type !== 'llm_turn') continue
    const d = e.data ?? {}
    const keys = {
      trigger: String(d.trigger ?? '(not recorded)').replace(/ from \S+/, ' from X').replace(/: .*/, m => m.slice(0, 24)),
      model: String(d.model ?? d.provider ?? '?'),
      hour: new Date(e.ts).toISOString().slice(0, 13).replace('T', ' ') + 'h'
    }
    for (const r of [total, ...Object.entries(keys).map(([k, v]) => (by[k]![v] ??= empty()))]) {
      r.n++; r.input += d.inputTokens ?? 0; r.cached += d.cacheReadTokens ?? 0; r.cacheWrite += d.cacheWriteTokens ?? 0
      r.output += d.outputTokens ?? 0; r.ms += d.ms ?? 0; r.cost += d.costUsd ?? d.reportedCostUsd ?? 0
    }
    for (const [k, v] of Object.entries(d.proxy ?? {})) proxy[k] = (proxy[k] ?? 0) + (v as number)
  }
}

const k = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n)
const row = (name: string, r: Row) => `${name.padEnd(34)} ${String(r.n).padStart(5)} ${k(r.input).padStart(8)} ${k(r.cached).padStart(8)} ${k(r.output).padStart(7)} ${k(Math.round(r.input / Math.max(1, r.n))).padStart(8)} ${('$' + r.cost.toFixed(2)).padStart(8)}`
const head = `${''.padEnd(34)} ${'turns'.padStart(5)} ${'input'.padStart(8)} ${'cached'.padStart(8)} ${'output'.padStart(7)} ${'in/turn'.padStart(8)} ${'cost*'.padStart(8)}`

console.log(`${bot}: ${pick.join(', ') || 'no journal days'}`)
console.log(head)
console.log(row('TOTAL', total))
for (const [title, groups] of Object.entries(by)) {
  console.log(`\nby ${title}`)
  for (const [name, r] of Object.entries(groups).sort((a, b) => title === 'hour' ? a[0].localeCompare(b[0]) : b[1].input - a[1].input)) console.log(row(name, r))
}
if (Object.keys(proxy).length) {
  console.log('\nproxy counters (sum of per-turn changes)')
  for (const [name, v] of Object.entries(proxy).sort((a, b) => b[1] - a[1])) console.log(`  ${name}: ${v}`)
} else {
  console.log('\nproxy counters: none recorded (no proxy configured, or it exported nothing that changed)')
}
console.log('\n* cost: API spend, or the CLI\'s list-price estimate for subscription turns (not money spent)')
