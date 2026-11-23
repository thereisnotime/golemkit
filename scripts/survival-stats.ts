// Pure helpers for scripts/survival-bench.ts: tool tiers, gathered items, stuck loops, distance,
// food and health over time, the profile clean-up for a test bot, start-spot checks, and the
// summary / compare tables over data/survival-bench/results.jsonl. No server, no mineflayer;
// tested in test/survival-bench.test.ts.

// ---- tools ----

export const TIER_NAMES = ['none', 'wood', 'stone', 'iron', 'diamond', 'netherite'] as const
const TIER_OF: Record<string, number> = { wooden: 1, golden: 1, stone: 2, iron: 3, diamond: 4, netherite: 5 }

/** Best tool tier among item names (pickaxe, axe, sword, shovel, hoe): 0 none .. 5 netherite. */
export function toolTier (items: string[]): number {
  let best = 0
  for (const n of items) {
    const m = /^(wooden|golden|stone|iron|diamond|netherite)_(pickaxe|axe|sword|shovel|hoe)$/.exec(n.replace(/^minecraft:/, ''))
    if (m) best = Math.max(best, TIER_OF[m[1]!]!)
  }
  return best
}

export const tierName = (t: number): string => TIER_NAMES[t] ?? String(t)

// ---- items ----

const FOOD = new Set([
  'apple', 'golden_apple', 'enchanted_golden_apple', 'bread', 'cookie', 'cake', 'pumpkin_pie', 'melon_slice', 'sweet_berries', 'glow_berries',
  'carrot', 'golden_carrot', 'potato', 'baked_potato', 'beetroot', 'beetroot_soup', 'mushroom_stew', 'rabbit_stew', 'suspicious_stew',
  'beef', 'cooked_beef', 'porkchop', 'cooked_porkchop', 'chicken', 'cooked_chicken', 'mutton', 'cooked_mutton', 'rabbit', 'cooked_rabbit',
  'cod', 'cooked_cod', 'salmon', 'cooked_salmon', 'tropical_fish', 'dried_kelp', 'honey_bottle', 'chorus_fruit'
])
export const isFoodName = (n: string): boolean => FOOD.has(n.replace(/^minecraft:/, ''))

export interface Gathered { logs: number, cobble: number, food: number, other: number }

/** Sums item_gained maps into logs (any *_log / *_stem / *_wood), cobble (cobblestone, cobbled deepslate), food, other. */
export function gathered (gains: Record<string, number>[], isFood: (n: string) => boolean = isFoodName): Gathered {
  const g: Gathered = { logs: 0, cobble: 0, food: 0, other: 0 }
  for (const m of gains) {
    for (const [raw, c] of Object.entries(m)) {
      const n = raw.replace(/^minecraft:/, '')
      if (/(_log|_stem|_wood|_hyphae)$/.test(n) && !n.startsWith('stripped_')) g.logs += c
      else if (n === 'cobblestone' || n === 'cobbled_deepslate') g.cobble += c
      else if (isFood(n)) g.food += c
      else g.other += c
    }
  }
  return g
}

// ---- failures ----

/** A failure message with numbers and coordinates folded, so "no tree within 32" and "... 64" are one loop. */
export function failureKey (action: string, message: string): string {
  return `${action}: ${message.toLowerCase().replace(/-?\d+(\.\d+)?/g, '#').replace(/\s+/g, ' ').trim().slice(0, 80)}`
}

/** Failure keys seen more than `n` times, most frequent first. */
export function stuckLoops (failures: { action: string, message: string }[], n: number): { key: string, count: number }[] {
  const counts = new Map<string, number>()
  for (const f of failures) { const k = failureKey(f.action, f.message); counts.set(k, (counts.get(k) ?? 0) + 1) }
  return [...counts].filter(([, c]) => c > n).sort((a, b) => b[1] - a[1]).map(([key, count]) => ({ key, count }))
}

// ---- movement ----

export interface PosSample { x: number, z: number, life: number }

/** Horizontal path length over samples; steps longer than maxStep (teleports) and across deaths are skipped. */
export function pathLength (samples: PosSample[], maxStep = 30): number {
  let d = 0
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!
    const b = samples[i]!
    if (a.life !== b.life) continue
    const s = Math.hypot(b.x - a.x, b.z - a.z)
    if (s <= maxStep) d += s
  }
  return d
}

// ---- food and health ----

export interface VitalSample { t: number, food: number, health: number, alive: boolean }

/** Min/mean food, seconds at food 0, min health, over the samples where the bot was alive. Each sample counts until the next. */
export function vitals (samples: VitalSample[], endT?: number): { foodMin: number | null, foodMean: number | null, foodZeroS: number, healthMin: number | null } {
  let foodMin: number | null = null
  let healthMin: number | null = null
  let weighted = 0
  let total = 0
  let zero = 0
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!
    if (!s.alive) continue
    const next = samples[i + 1]?.t ?? endT ?? s.t
    const dt = Math.max(0, next - s.t)
    foodMin = foodMin === null ? s.food : Math.min(foodMin, s.food)
    healthMin = healthMin === null ? s.health : Math.min(healthMin, s.health)
    weighted += s.food * dt
    total += dt
    if (s.food === 0) zero += dt
  }
  return { foodMin, foodMean: total ? Math.round(weighted / total * 10) / 10 : foodMin, foodZeroS: Math.round(zero), healthMin }
}

/** Seconds alive between start and end, given death and respawn times (ms). */
export function aliveSeconds (start: number, end: number, deaths: number[], respawns: number[]): number {
  let dead = 0
  for (const d of deaths) {
    const r = respawns.find(x => x >= d) ?? end
    dead += Math.max(0, Math.min(r, end) - d)
  }
  return Math.round((end - start - dead) / 1000)
}

// ---- start spot ----

export const KEEP_AWAY: [string, number, number][] = [['spawn', 545, 45], ['fortress', 560, -43], ['village', -2770, 1090]]
/** Other scripts' test areas: a new start or scenario should be 300+ from these too (a scenario's own spot is one of them). */
export const TEST_AREAS: [string, number, number][] = [['guard-bench arena', 1250, 445], ['test area 1250 800', 1250, 800], ['test area 1600 445', 1600, 445], ['ice scenario', 1600, 800]]

/** Named starts. `forest` (the default) measures the early game: wood, tools, food, bed. `ice` is the old default (no tree within ~137). */
export const SCENARIOS: Record<string, { start: [number, number], about: string }> = {
  forest: { start: [1818, 1318], about: 'forest biome (oak and birch), about 67 natural trees within 32, grass, water a few blocks away, chickens, pigs and sheep in sight' },
  ice: { start: [1600, 800], about: 'ice and packed ice, no natural tree within ~137 blocks (the default before forest-baseline-2026-11-23)' }
}

/** What the start looks like, measured by the director before each run. */
export interface Terrain { biome: string | null, trees: number, grass: number, waterAt: number | null, animals: Record<string, number> }

/**
 * Natural trees among log positions: logs touching (26 neighbours) are one tree, and a group counts
 * only when one of its logs has natural leaves next to it (`leafy`), so log piles and wooden houses don't.
 */
export function countTrees (logs: { x: number, y: number, z: number, leafy: boolean }[]): number {
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`
  const at = new Map(logs.map((l, i) => [key(l.x, l.y, l.z), i]))
  const seen = new Set<number>()
  let trees = 0
  for (let i = 0; i < logs.length; i++) {
    if (seen.has(i)) continue
    let leafy = false
    const queue = [i]
    seen.add(i)
    while (queue.length) {
      const l = logs[queue.pop()!]!
      if (l.leafy) leafy = true
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const j = at.get(key(l.x + dx, l.y + dy, l.z + dz))
        if (j !== undefined && !seen.has(j)) { seen.add(j); queue.push(j) }
      }
    }
    if (leafy) trees++
  }
  return trees
}

/** "forest, 14 trees within 32, grass 310, water 18 away, animals: cow 3, sheep 2" */
export function terrainNote (t: Terrain, radius = 32): string {
  const animals = Object.entries(t.animals).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} ${c}`).join(', ')
  return [`${t.biome ?? 'unknown biome'}`, `${t.trees} trees within ${radius}`, `grass ${t.grass}`,
    t.waterAt === null ? 'no water seen' : `water ${t.waterAt} away`, animals ? `animals: ${animals}` : 'no animals seen'].join(', ')
}

/** Places closer than `min` blocks to x z, with their distance. */
export function tooClose (x: number, z: number, places: [string, number, number][], min = 300): { name: string, distance: number }[] {
  return places.map(([name, px, pz]) => ({ name, distance: Math.round(Math.hypot(x - px, z - pz)) })).filter(p => p.distance < min)
}

function mulberry32 (a: number): () => number {
  return () => {
    a |= 0; a = a + 0x6D2B79F5 | 0
    let t = Math.imul(a ^ a >>> 15, 1 | a)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

/** Start of repeat `rep` (0-based): the given spot for rep 0 or spread 0, else a seeded point `spread` blocks away. */
export function startFor (x: number, z: number, rep: number, seed: number, spread: number): { x: number, z: number } {
  if (rep === 0 || spread <= 0) return { x, z }
  const rnd = mulberry32(seed * 1000 + rep)
  const a = rnd() * Math.PI * 2
  return { x: Math.round(x + Math.cos(a) * spread), z: Math.round(z + Math.sin(a) * spread) }
}

// ---- the test bot's profile ----

/**
 * A profile's settings made safe for a test bot far from home (the script sets its owner to a
 * test account, so help whispers never reach the real owner): follow_owner and bodyguard are off, the
 * behaviours NPC mode arms on the real bot (chop_wood_loop, deposit_when_full) are on, no trips to
 * configured farms, chests or the village (foodPlaces, settings.storage), no public chat from
 * keep_spawn_bed asking players to sleep or from idle_antics, no context pack (it would share the
 * real bot's MEMORY.md and hooks), and no LLM settings unless `llm` is kept.
 */
export function testSettings (settings: Record<string, unknown>, keepLlm = false): Record<string, unknown> {
  const s: Record<string, unknown> = { ...settings }
  delete s.storage
  delete s.home
  delete s.intents
  s.context = false
  if (!keepLlm) delete s.llm
  const b: Record<string, unknown> = { ...(s.behaviors as Record<string, unknown> | undefined) }
  const opts = (name: string): Record<string, unknown> | null => {
    const v = b[name]
    if (v === undefined || v === null || v === false) return null
    return v === true ? {} : { ...(v as Record<string, unknown>) }
  }
  b.follow_owner = false
  b.bodyguard = false
  // NPC mode arms these on the real bot while its owner is away (src/brains/behaviors/brain.ts);
  // the bench keeps a test owner online, so arm them here or the bot never gets wood
  const npc = (s.npcMode as { arm?: Record<string, Record<string, unknown>> } | false | undefined)
  if (npc !== false) {
    for (const [name, o] of Object.entries(npc?.arm ?? { chop_wood_loop: {}, deposit_when_full: {} })) {
      b[name] = { ...(opts(name) ?? {}), ...o, enabled: true }
    }
  }
  const kf = opts('keep_fed')
  if (kf) { delete kf.foodPlaces; b.keep_fed = kf }
  const bed = opts('keep_spawn_bed')
  if (bed) b.keep_spawn_bed = { ...bed, ask: false }
  const fun = opts('idle_antics')
  if (fun) b.idle_antics = { ...fun, chat: 0 }
  s.behaviors = b
  return s
}

// ---- results ----

export interface RunResult {
  tag: string
  repeat: number
  [k: string]: unknown
}

/** Numeric metrics in the summary and compare tables: [key, label, higher is better]. */
export const METRICS: [string, string, boolean | null][] = [
  ['deaths', 'deaths', false],
  ['aliveMin', 'alive min', true],
  ['firstDeathMin', '1st death min', true],
  ['foodMin', 'food min', true],
  ['foodMean', 'food mean', true],
  ['foodZeroS', 'food 0 (s)', false],
  ['healthMin', 'health min', true],
  ['toolTierMax', 'tool tier', true],
  ['logs', 'logs', true],
  ['cobble', 'cobble', true],
  ['food', 'food items', true],
  ['spawnSet', 'spawn set', true],
  ['failures', 'failures', false],
  ['stuckLoopCount', 'stuck loops', false],
  ['distance', 'distance', null],
  ['helpAsks', 'help asks', false],
  ['whispers', 'whispers', null],
  ['disconnects', 'disconnects', false]
]

/** A metric from a result row (flattened: gathered.logs, booleans as 0/1, firstDeathMin = run length when it never died). */
export function metric (r: Record<string, any>, key: string): number | null {
  let v: unknown
  if (key === 'logs' || key === 'cobble' || key === 'food') v = r.gathered?.[key]
  else if (key === 'stuckLoopCount') v = Array.isArray(r.stuckLoops) ? r.stuckLoops.length : null
  else if (key === 'aliveMin') v = typeof r.aliveS === 'number' ? r.aliveS / 60 : null
  else if (key === 'firstDeathMin') v = typeof r.firstDeathS === 'number' ? r.firstDeathS / 60 : typeof r.realMinutes === 'number' ? r.realMinutes : null
  else v = r[key]
  if (typeof v === 'boolean') return v ? 1 : 0
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

export interface Stat { n: number, mean: number | null, sd: number | null, min: number | null, max: number | null }

export function stat (xs: number[]): Stat {
  if (!xs.length) return { n: 0, mean: null, sd: null, min: null, max: null }
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length
  const sd = xs.length > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1)) : null
  return { n: xs.length, mean, sd, min: Math.min(...xs), max: Math.max(...xs) }
}

const fmt = (v: number | null, d = 1): string => v === null ? '-' : Number.isInteger(v) ? String(v) : v.toFixed(d)

export interface CompareRow { metric: string, a: Stat, b: Stat, delta: number | null, verdict: string }

/**
 * Before/after per metric. The verdict says "better"/"worse" only when the difference is bigger
 * than the noise: more than the larger of the two standard deviations, or with a single run on a
 * side, more than 25% of the larger mean (and at least 1). Otherwise "~" (within noise).
 */
export function compare (rows: RunResult[], tagA: string, tagB: string): CompareRow[] {
  const A = rows.filter(r => r.tag === tagA)
  const B = rows.filter(r => r.tag === tagB)
  return METRICS.map(([key, label, higherBetter]) => {
    const a = stat(A.map(r => metric(r, key)).filter((x): x is number => x !== null))
    const b = stat(B.map(r => metric(r, key)).filter((x): x is number => x !== null))
    const delta = a.mean !== null && b.mean !== null ? b.mean - a.mean : null
    let verdict = '-'
    if (delta !== null) {
      const noise = a.sd !== null || b.sd !== null
        ? Math.max(a.sd ?? 0, b.sd ?? 0)
        : Math.max(1, 0.25 * Math.max(Math.abs(a.mean!), Math.abs(b.mean!)))
      if (Math.abs(delta) <= noise || delta === 0) verdict = '~'
      else if (higherBetter === null) verdict = delta > 0 ? 'more' : 'less'
      else verdict = (delta > 0) === higherBetter ? 'better' : 'worse'
    }
    return { metric: label, a, b, delta, verdict }
  })
}

const pad = (cells: string[], widths: number[]) => cells.map((c, i) => i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!)).join('  ')

function table (header: string[], body: string[][]): string {
  const widths = header.map((h, i) => Math.max(h.length, ...body.map(r => (r[i] ?? '').length)))
  return [pad(header, widths), widths.map(w => '-'.repeat(w)).join('  '), ...body.map(r => pad(r, widths))].join('\n')
}

const meanSd = (s: Stat) => s.mean === null ? '-' : s.sd === null ? fmt(s.mean) : `${fmt(s.mean)}±${fmt(s.sd)}`

export function compareTable (rows: RunResult[], tagA: string, tagB: string): string {
  const c = compare(rows, tagA, tagB)
  const na = rows.filter(r => r.tag === tagA).length
  const nb = rows.filter(r => r.tag === tagB).length
  return table(['metric', `${tagA} (${na})`, `${tagB} (${nb})`, 'delta', ''],
    c.map(r => [r.metric, meanSd(r.a), meanSd(r.b), r.delta === null ? '-' : (r.delta > 0 ? '+' : '') + fmt(r.delta), r.verdict]))
}

/** One column per run plus the mean±sd when there is more than one. */
export function summaryTable (rows: RunResult[]): string {
  const cols = rows.map(r => `${r.tag}#${r.repeat}`)
  const body = METRICS.map(([key, label]) => {
    const xs = rows.map(r => metric(r, key))
    const s = stat(xs.filter((x): x is number => x !== null))
    return [label, ...xs.map(x => fmt(x)), ...(rows.length > 1 ? [meanSd(s)] : [])]
  })
  const causes = rows.map(r => Array.isArray(r.deathCauses) ? (r.deathCauses as { cause?: string }[]).map(d => d.cause ?? '?').join('; ') : '')
  const lines = [table(['metric', ...cols, ...(rows.length > 1 ? ['mean±sd'] : [])], body)]
  rows.forEach((r, i) => { if (causes[i]) lines.push(`${cols[i]} deaths: ${causes[i]}`) })
  rows.forEach((r, i) => {
    const loops = Array.isArray(r.stuckLoops) ? r.stuckLoops as { key: string, count: number }[] : []
    if (loops.length) lines.push(`${cols[i]} stuck: ${loops.slice(0, 5).map(l => `${l.key} x${l.count}`).join(' | ')}`)
  })
  return lines.join('\n')
}

export function parseResults (text: string): RunResult[] {
  const out: RunResult[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { const r = JSON.parse(line); if (r && typeof r.tag === 'string') out.push(r) } catch {}
  }
  return out
}
