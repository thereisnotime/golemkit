// Where the materials for a build or a repair come from, planned: a small ordered list of
// sources (settings.materials.sources) the gatherer works through until nothing is short. Pure
// and unit tested (test/material-source-plan.test.ts); materialSources.ts reads the facts from
// the bot and runs the steps.
//
// Why: once a base keeps the ground under it whole (baseSafety.keepOutDepth) and the land around
// it is a frozen lake, there is no stone to dig near home. Pax's repairs asked "gather" for 9
// cobblestone, the strip mine turned four times at water and gave up, and the floor stayed open,
// while its chests held hundreds of cobblestone and its own staircase mine was a walk away. The
// sources below say where else to look, in order, and why each one was or wasn't used.
import type { MaterialSource } from '../core/materialSources.ts'

/** What the planner knows; the caller reads it from the bot, its chests and its memory. */
export interface SourceFacts {
  carried: Record<string, number>
  /** Its own chests' contents (container memory); null when it knows of none. */
  stored: Record<string, number> | null
  /** Own chests it never looked into (they may hold it). */
  unknownChests?: number
  /** Per wanted key, the patterns another block must match to stand in for it (every one of them). */
  accepts?: Record<string, readonly RegExp[]>
  /** How many of a wanted key (or generic name: planks, door...) an inventory holds. */
  count: (key: string, inv: Record<string, number>) => number
  /** Items it can make (crafted or smelted, from wood or stone). */
  craftable: (key: string) => boolean
  /** Items dug from the ground (stone, dirt, sand...). */
  raw: (key: string) => boolean
  /** Items its own mine and the far stone dig give (cobblestone). */
  stone: (key: string) => boolean
  canDig: boolean
  /** Why its own mine can't be used now (mine settings off, not ready, no stone pickaxe); null = it can. */
  mine: string | null
  /** Why stone further out can't be used now; null = it can. */
  far: string | null
  /** Recent sources that gave nothing, by `${source}:${key}`. */
  failed?: Record<string, { at: number, why: string }>
  now: number
  retryMs: number
}

export interface SourceStep {
  source: MaterialSource
  /** What it should get there: exact item names for chests and substitutes, wanted keys otherwise. */
  items: Record<string, number>
  why: string
}
export interface SourceSkip { source: MaterialSource, why: string }

export interface SourcePlan {
  steps: SourceStep[]
  skipped: SourceSkip[]
  /** Short after the chests and substitutes, before anything is crafted or dug. */
  toMake: Record<string, number>
  /** Still short with every planned step counted as giving what it was asked for. */
  short: Record<string, number>
}

const fmt = (m: Record<string, number>) => Object.entries(m).map(([k, v]) => `${v} ${k}`).join(', ')
const sum = (m: Record<string, number>) => Object.values(m).reduce((a, b) => a + b, 0)

/** Whether `item` stands in for `key` (another block every pattern accepts). Pure. */
export function substitutes (key: string, item: string, f: Pick<SourceFacts, 'accepts' | 'count'>): boolean {
  const pats = f.accepts?.[key]
  if (!pats?.length) return false
  if (f.count(key, { [item]: 1 }) > 0) return false
  return pats.every(p => p.test(item))
}

/** Of each wanted key, how many are still short given what it carries (substitutes it carries count when that source is on). Pure. */
export function shortOf (wants: Record<string, number>, f: Pick<SourceFacts, 'carried' | 'accepts' | 'count'>, useSubs: boolean): Record<string, number> {
  const out: Record<string, number> = {}
  // a carried substitute is counted once, for the first key that takes it
  const used: Record<string, number> = {}
  for (const [k, n] of Object.entries(wants)) {
    let have = f.count(k, f.carried)
    if (useSubs) {
      for (const [item, c] of Object.entries(f.carried)) {
        if (have >= n) break
        if (!substitutes(k, item, f)) continue
        const t = Math.min(c - (used[item] ?? 0), n - have)
        if (t > 0) { have += t; used[item] = (used[item] ?? 0) + t }
      }
    }
    if (have < n) out[k] = n - have
  }
  return out
}

/** Takes from a store for what is short: items picked by `fits`, largest piles first. Mutates `short`. */
function takeFrom (store: Record<string, number>, short: Record<string, number>, fits: (key: string, item: string) => boolean): Record<string, number> {
  const out: Record<string, number> = {}
  for (const k of Object.keys(short)) {
    for (const [item, n] of Object.entries(store).sort((a, b) => b[1] - a[1])) {
      if ((short[k] ?? 0) <= 0) break
      if (!fits(k, item)) continue
      const t = Math.min(n - (out[item] ?? 0), short[k]!)
      if (t <= 0) continue
      out[item] = (out[item] ?? 0) + t
      short[k]! -= t
    }
    if ((short[k] ?? 0) <= 0) delete short[k]
  }
  return out
}

/**
 * The sources to use for what is still short, in the order of `sources`, and why the others are
 * skipped. Chests and substitutes are counted from what it knows its chests hold; craft, nearby,
 * mine and far are planned as giving what they are asked for, so a later source is listed as a
 * skip ("only if ... falls short") until an earlier one has been tried (`tried`) and gave less. Pure.
 */
export function planSources (wants: Record<string, number>, f: SourceFacts, sources: readonly MaterialSource[], tried: ReadonlySet<MaterialSource> = new Set()): SourcePlan {
  const useSubs = sources.includes('substitutes')
  const short = shortOf(wants, f, useSubs)
  const steps: SourceStep[] = []
  const skipped: SourceSkip[] = []
  const skip = (source: MaterialSource, why: string) => { skipped.push({ source, why }) }
  const recent = (source: MaterialSource, key: string): string | null => {
    const r = f.failed?.[`${source}:${key}`]
    if (!r || f.retryMs <= 0 || f.now - r.at >= f.retryMs) return null
    return `gave no ${key} ${Math.max(1, Math.round((f.now - r.at) / 60_000))} min ago: ${r.why}`.slice(0, 160)
  }
  // keys an uncertain source (craft, dig, mine) was planned for: later sources only if it falls short
  const plannedBy: Record<string, MaterialSource> = {}
  let toMake: Record<string, number> | null = null
  for (const source of sources) {
    if (tried.has(source)) continue
    if (!Object.keys(short).length) { skip(source, 'nothing short'); continue }
    if (source === 'chests' || source === 'substitutes') {
      if (!f.stored) { skip(source, 'no chests I know of'); continue }
      const items = source === 'chests'
        ? takeFrom(f.stored, short, (k, item) => f.count(k, { [item]: 1 }) > 0)
        : takeFrom(f.stored, short, (k, item) => substitutes(k, item, f))
      if (sum(items)) steps.push({ source, items, why: source === 'chests' ? `my chests hold ${fmt(items)}` : `my chests hold ${fmt(items)}, which the blueprint takes instead` })
      else if (source === 'chests' && (f.unknownChests ?? 0) > 0 && !recent(source, Object.keys(short)[0]!)) steps.push({ source, items: { ...short }, why: `${f.unknownChests} of my chests I never looked into` })
      else skip(source, source === 'chests' ? 'none of it in my chests' : f.accepts && Object.keys(short).some(k => f.accepts![k]?.length) ? 'nothing in my chests the blueprint takes instead' : 'the blueprint allows nothing else')
      continue
    }
    toMake ??= { ...short }
    const open = Object.entries(short).filter(([k]) => !plannedBy[k])
    // what an earlier source was planned for and this one could give too
    const laterWhy = (fits: (k: string) => boolean) => {
      const later = Object.keys(short).filter(k => plannedBy[k] && fits(k))
      return later.length ? `only if ${[...new Set(later.map(k => plannedBy[k]!))].join(', ')} falls short (${later.join(', ')})` : ''
    }
    let fits: (k: string) => boolean = () => false
    const pick = (fits: (k: string) => boolean): { items: Record<string, number>, failed: string[] } => {
      const items: Record<string, number> = {}
      const failed: string[] = []
      for (const [k, n] of open) {
        if (!fits(k)) continue
        const why = recent(source, k)
        if (why) { failed.push(why); continue }
        items[k] = n
      }
      return { items, failed }
    }
    let r: { items: Record<string, number>, failed: string[] }
    let none = ''
    if (source === 'craft') {
      fits = f.craftable
      r = pick(f.craftable)
      none = 'nothing short that I can make'
    } else if (source === 'nearby') {
      if (!f.canDig) { skip(source, 'digging is off for me'); continue }
      fits = f.raw
      r = pick(f.raw)
      none = 'nothing short that is dug'
    } else {
      // mine, far: stone only
      const why = !f.canDig ? 'digging is off for me' : source === 'mine' ? f.mine : f.far
      if (why) { skip(source, why); continue }
      fits = f.stone
      r = pick(f.stone)
      none = `nothing short that ${source === 'mine' ? 'my mine' : 'digging further out'} gives`
    }
    if (sum(r.items)) {
      for (const k of Object.keys(r.items)) plannedBy[k] = source
      steps.push({ source, items: r.items, why: source === 'craft' ? `I can make ${fmt(r.items)}` : `${fmt(r.items)} ${source === 'nearby' ? 'close by' : source === 'mine' ? 'from my staircase mine' : `dug past the base's keep-out`}` })
    } else skip(source, r.failed[0] ?? (laterWhy(fits) || none))
  }
  // what nothing planned covers
  const left: Record<string, number> = {}
  for (const [k, n] of Object.entries(short)) if (!plannedBy[k]) left[k] = n
  return { steps, skipped, toMake: toMake ?? { ...short }, short: left }
}

/** One line: the sources it uses and why the others are skipped. Pure. */
export function fmtSourcePlan (p: Pick<SourcePlan, 'steps' | 'skipped' | 'short'>): string {
  const use = p.steps.map(s => `${s.source} (${s.why})`).join(', then ')
  const skip = p.skipped.filter(s => s.why !== 'nothing short').map(s => `${s.source}: ${s.why}`).join('; ')
  const short = Object.keys(p.short).length ? `; no source left for ${fmt(p.short)}` : ''
  return `${use ? `using ${use}` : 'no source to use'}${skip ? `; skipped ${skip}` : ''}${short}`
}

// ------------------------------------------------------------------ a run

export interface SourceUse { source: MaterialSource, got: Record<string, number>, note?: string }

/** What one gather run did: the sources it used (and what each gave), the ones it skipped and why, what is still short. */
export interface SourceRun {
  at: number
  wants: Record<string, number>
  used: SourceUse[]
  skipped: SourceSkip[]
  short: Record<string, number>
}

/** One line for status and the session's result. Pure. */
export function fmtSourceRun (r: Pick<SourceRun, 'used' | 'skipped' | 'short'>): string {
  const used = r.used.map(u => `${u.source} ${sum(u.got) ? `gave ${fmt(u.got)}` : `gave nothing${u.note ? ` (${u.note.slice(0, 100)})` : ''}`}`).join(', ')
  const skip = r.skipped.filter(s => s.why !== 'nothing short').map(s => `${s.source} (${s.why})`).join(', ')
  const short = Object.keys(r.short).length ? `; still short ${fmt(r.short)}` : ''
  return `materials: ${used || 'no source used'}${skip ? `; skipped ${skip}` : ''}${short}`
}

/** Remembers which sources gave nothing of which keys; drops entries older than retryMs. Pure. */
export function noteFailures (failed: Record<string, { at: number, why: string }>, use: SourceUse, asked: Record<string, number>, now: number, retryMs: number): Record<string, { at: number, why: string }> {
  const out: Record<string, { at: number, why: string }> = {}
  for (const [k, v] of Object.entries(failed)) if (now - v.at < Math.max(retryMs, 1)) out[k] = v
  for (const k of Object.keys(asked)) {
    const id = `${use.source}:${k}`
    if ((use.got[k] ?? 0) > 0) delete out[id]
    else out[id] = { at: now, why: (use.note ?? 'nothing').slice(0, 160) }
  }
  return out
}

// ------------------------------------------------------------------ further out

export interface Box2 { min: { x: number, z: number }, max: { x: number, z: number } }

/**
 * Spots to start digging for stone further out: `distance` blocks past the box grown by
 * `margin` (the keep-out), on each side and each corner, the ones nearest `from` first. Pure.
 */
export function farStarts (box: Box2, margin: number, distance: number, from: { x: number, z: number }): { x: number, z: number }[] {
  const d = margin + distance
  const x0 = box.min.x - d
  const x1 = box.max.x + d
  const z0 = box.min.z - d
  const z1 = box.max.z + d
  const cx = Math.floor((box.min.x + box.max.x) / 2)
  const cz = Math.floor((box.min.z + box.max.z) / 2)
  const spots = [
    { x: cx, z: z0 }, { x: x1, z: cz }, { x: cx, z: z1 }, { x: x0, z: cz },
    { x: x0, z: z0 }, { x: x1, z: z0 }, { x: x1, z: z1 }, { x: x0, z: z1 }
  ]
  return spots.sort((a, b) => Math.hypot(a.x - from.x, a.z - from.z) - Math.hypot(b.x - from.x, b.z - from.z))
}
