// Material sources for Minecraft: gets a build's or a repair's shopping list from an ordered list
// of sources (settings.materials.sources: chests, substitutes, craft, nearby, mine, far), one at a
// time until nothing is short, and remembers what each gave and why the others were skipped (for
// status, `projects` and `plan fortress`). The decisions are in materialSourcePlan.ts (pure);
// this file reads the facts from the bot and runs one step at a time. See
// docs/guide/base-projects.md#where-materials-come-from.
import type { Bot } from 'mineflayer'
import type { ActionContext, ActionResult, Agent } from '../core/index.ts'
import { ok, fail, checkAborted, fmtPos, goals, needsSurvival, materialSourcesSettings, baseSafetySettings, type MaterialSource, type MaterialSourcesSettings } from '../core/index.ts'
import { gotoWithin, vec } from './world.ts'
import { inventoryCounts, toolTier, bestToolIn } from './toolkit.ts'
import { gatherMaterials, countWant, MINE_SOURCES, type GatherOptions } from './materials.ts'
import { chestView, chestTotals, takeItemsFromOwnChests, takeWoodFromOwnChests } from './containers.ts'
import { gatherStone } from './progression.ts'
import { mineTrip, stairMineConfig } from './stairMine.ts'
import { stairMineReadiness } from './stairMinePlan.ts'
import { miningSettings } from './minePlan.ts'
import { kitOf } from './mining.ts'
import { settledBase, digKeepOut } from './baseArea.ts'
import { getHome, sameDimension } from './navigation.ts'
import { isCreative } from './creative.ts'
import {
  planSources, shortOf, fmtSourcePlan, fmtSourceRun, noteFailures, farStarts,
  type SourceFacts, type SourcePlan, type SourceRun, type SourceUse
} from './materialSourcePlan.ts'

type Ctx = Pick<ActionContext, 'bot' | 'agent' | 'signal' | 'log'>

const LAST_KEY = 'materials.last'
const FAILS_KEY = 'materials.fails'

export interface SourceGatherOptions extends GatherOptions {
  /** Per wanted key, the patterns a stand-in block must match (the blueprint roles that want it). */
  accepts?: Record<string, readonly RegExp[]>
  /** Time for the whole run; each source gets what is left. Default 10 min. */
  minutes?: number
}

export const settingsOf = (agent: Pick<Agent, 'settings'>): MaterialSourcesSettings => materialSourcesSettings((agent.settings as { materials?: unknown }).materials)

// read when called: materials.ts and this file import each other
const isRaw = (k: string) => k in MINE_SOURCES || k === 'log' || k === 'logs' || /_(log|stem)$/.test(k)
const WOODY = /^(planks|log|door|trapdoor|ladder|chest|crafting_table|fence|fence_gate|stick|slab|stairs)$|_(planks|log|door|trapdoor|fence|fence_gate|slab|stairs|sign)$/

/** Why its own staircase mine can't give stone now, or null. */
function mineProblem (agent: Agent, bot: Bot): string | null {
  const s = stairMineConfig(agent)
  if (!s.enabled) return 'mine settings are off'
  if (!needsSurvival(bot)) return 'not in survival'
  if (bot.game?.dimension && !/overworld/.test(bot.game.dimension)) return 'not in the overworld'
  if (toolTier(bestToolIn(Object.keys(inventoryCounts(bot)), 'pickaxe') ?? '', 'pickaxe') < 2) return 'no stone pickaxe'
  const r = stairMineReadiness(kitOf(bot), bot.health ?? 20, s, miningSettings(agent.settings.mining))
  return r.ready ? null : `not ready to go down: ${r.missing.join(', ')}`
}

/** The box to dig away from: the settled base, else home. */
function homeBox (agent: Agent, bot: Bot): { min: { x: number, z: number }, max: { x: number, z: number } } | null {
  const b = settledBase(agent)
  if (b) return { min: b.area.min, max: b.area.max }
  const h = getHome(agent)
  if (h && sameDimension(bot, h)) return { min: { x: Math.floor(h.x), z: Math.floor(h.z) }, max: { x: Math.floor(h.x), z: Math.floor(h.z) } }
  return null
}

/** What the planner needs, read from the bot, its chests and its memory. */
export function sourceFacts (agent: Agent, bot: Bot, accepts?: Record<string, readonly RegExp[]>, now = Date.now()): SourceFacts {
  const s = settingsOf(agent)
  let stored: Record<string, number> | null = null
  let unknownChests = 0
  try {
    const view = chestView(agent, bot)
    if (view.length) { const t = chestTotals(view); stored = t.has; unknownChests = t.unknown }
  } catch {}
  return {
    carried: inventoryCounts(bot),
    stored,
    unknownChests,
    ...(accepts ? { accepts } : {}),
    count: countWant,
    craftable: k => !isRaw(k),
    raw: isRaw,
    stone: k => k === 'cobblestone',
    canDig: agent.canDig,
    mine: mineProblem(agent, bot),
    far: homeBox(agent, bot) ? null : 'no base or home to dig away from',
    failed: agent.storage.get<Record<string, { at: number, why: string }>>(FAILS_KEY, {}),
    now,
    retryMs: s.retryMinutes * 60_000
  }
}

/** The plan as it stands now, without doing anything (for `plan fortress` and the queue). */
export function previewSources (agent: Agent, bot: Bot, wants: Record<string, number>, accepts?: Record<string, readonly RegExp[]>): SourcePlan {
  return planSources(wants, sourceFacts(agent, bot, accepts), settingsOf(agent).sources)
}

export { fmtSourcePlan, fmtSourceRun }

/** The last gather run, when it is recent. */
export function lastSourceRun (agent: Pick<Agent, 'storage'>, maxAgeMs = 60 * 60_000, now = Date.now()): SourceRun | null {
  const r = agent.storage.get<SourceRun | null>(LAST_KEY, null)
  return r && now - r.at <= maxAgeMs ? r : null
}

/** Runs `fn` with a signal that also aborts after `ms`; running out of time is a plain failure. */
async function budgeted (ctx: Ctx, ms: number, fn: (c: Ctx) => Promise<ActionResult>): Promise<ActionResult> {
  const ctl = new AbortController()
  const onAbort = () => ctl.abort()
  ctx.signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => ctl.abort(), ms)
  try {
    return await fn({ ...ctx, signal: ctl.signal })
  } catch (e) {
    checkAborted(ctx.signal)
    if (ctl.signal.aborted) return fail(`out of time after ${Math.round(ms / 1000)}s`)
    return fail((e as Error).message)
  } finally {
    clearTimeout(timer)
    ctx.signal.removeEventListener('abort', onAbort)
    ;(ctx.bot as Bot).pathfinder?.setGoal(null)
  }
}

const WET = /water|lava|ice|bubble_column|kelp|seagrass/
const OPEN = /^(air|cave_air|void_air|short_grass|tall_grass|snow|fern|large_fern|dead_bush)$/

/** The top block of a column near `y`, or undefined when it isn't loaded. */
function surfaceAt (bot: Bot, x: number, z: number, y: number): { name: string, y: number } | undefined {
  for (let yy = y + 24; yy >= y - 24; yy--) {
    const b = bot.blockAt(vec(bot, x, yy, z))
    if (!b) return undefined
    if (!OPEN.test(b.name)) return { name: b.name, y: yy }
  }
  return undefined
}

/** Stone dug further out: a dry spot farDistance past the base (and its keep-out), nearest first, at most farTries spots. */
async function farStone (ctx: Ctx, n: number, s: MaterialSourcesSettings): Promise<ActionResult> {
  const bot = ctx.bot as Bot
  const agent = ctx.agent as Agent
  const box = homeBox(agent, bot)
  if (!box) return fail('no base or home to dig away from')
  const margin = baseSafetySettings((agent.settings as { baseSafety?: unknown }).baseSafety).margin
  const me = bot.entity.position
  const start = inventoryCounts(bot).cobblestone ?? 0
  const got = () => (inventoryCounts(bot).cobblestone ?? 0) - start
  const notes: string[] = []
  let tries = 0
  for (const spot of farStarts(box, margin, s.farDistance, me)) {
    if (tries >= s.farTries || got() >= n) break
    checkAborted(ctx.signal)
    const top = surfaceAt(bot, spot.x, spot.z, Math.floor(me.y))
    if (!top) { notes.push(`${spot.x} ${spot.z} not loaded`); continue }
    const p = { x: spot.x, y: top.y, z: spot.z }
    if (WET.test(top.name)) { notes.push(`${top.name} at ${fmtPos(p)}`); continue }
    if (agent.protectedAreas.isProtected(p)) { notes.push(`${fmtPos(p)} is protected`); continue }
    if (digKeepOut(agent, p)) { notes.push(`${fmtPos(p)} is ${digKeepOut(agent, p)}`); continue }
    tries++
    ctx.log.debug('materials: digging for stone further out', { at: fmtPos(p) })
    try {
      await gotoWithin(bot, new goals.GoalNear(p.x, p.y + 1, p.z, 2), ctx.signal, 60_000)
    } catch (e) {
      checkAborted(ctx.signal)
      notes.push(`couldn't get to ${fmtPos(p)}`)
      continue
    }
    const r = await gatherStone(ctx, n - got())
    if (got() <= 0) notes.push(`at ${fmtPos(p)}: ${r.message.slice(0, 120)}`)
  }
  if (got() > 0) return ok(`dug ${got()} cobblestone further out`)
  return fail(notes.slice(0, 3).join('; ') || 'no spot further out to dig')
}

/** Runs one planned step; returns a note about how it went. */
async function runStep (ctx: Ctx, source: MaterialSource, items: Record<string, number>, opts: SourceGatherOptions, s: MaterialSourcesSettings, leftMs: number): Promise<string> {
  const bot = ctx.bot as Bot
  const agent = ctx.agent as Agent
  const take = async () => {
    const t = await takeItemsFromOwnChests({ bot, agent, signal: ctx.signal }, items, 64).catch(e => { checkAborted(ctx.signal); return { took: {}, units: 0, notes: [(e as Error).message] } })
    return t.units ? `took ${Object.entries(t.took).map(([k, v]) => `${v} ${k}`).join(', ')}` : (t.notes[0] ?? 'my chests did not have it after all')
  }
  if (source === 'chests' || source === 'substitutes') return take()
  if (source === 'craft') {
    // wood for wooden things comes out of its chests before any tree is felled
    if (Object.keys(items).some(k => WOODY.test(k)) && countWant('log', inventoryCounts(bot)) < 4) {
      await takeWoodFromOwnChests({ bot, agent, signal: ctx.signal }, 32).catch(e => { checkAborted(ctx.signal) })
    }
    const r = await budgeted(ctx, leftMs, c => gatherMaterials(c, items, { ...opts, optional: opts.optional ?? {} }))
    return r.message
  }
  if (source === 'nearby') {
    const r = await budgeted(ctx, leftMs, c => gatherMaterials(c, items, { ...(opts.radius ? { radius: opts.radius } : {}) }))
    return r.message
  }
  const n = items.cobblestone ?? 0
  if (source === 'mine') {
    const minutes = Math.max(1, Math.min(s.mineMinutes, Math.floor(leftMs / 60_000)))
    // the trip watches its own clock and climbs back up: no outer time limit that would leave it down there
    const r = await mineTrip(ctx, { collect: 'cobblestone', want: n, maxMinutes: minutes }).catch(e => { checkAborted(ctx.signal); return fail((e as Error).message) })
    return r.message
  }
  const r = await budgeted(ctx, leftMs, c => farStone(c, n, s))
  return r.message
}

/**
 * Gets a shopping list from the sources in settings.materials.sources, in order: each step is
 * planned again from what it carries and what its chests hold after the last one. ok when every
 * required item is there. The run is remembered (lastSourceRun) for status and the queue.
 */
export async function gatherFromSources (ctx: Ctx, wants: Record<string, number>, opts: SourceGatherOptions = {}): Promise<ActionResult> {
  const bot = ctx.bot as Bot
  const agent = ctx.agent as Agent
  if (isCreative(bot)) return gatherMaterials(ctx, wants, opts)
  const s = settingsOf(agent)
  const t0 = Date.now()
  const deadline = t0 + (opts.minutes ?? 10) * 60_000
  const tried = new Set<MaterialSource>()
  const used: SourceUse[] = []
  let plan = planSources(wants, sourceFacts(agent, bot, opts.accepts), s.sources, tried)
  const firstSkips = plan.skipped.filter(k => k.why !== 'nothing short')
  ctx.log.info('materials: sources', { plan: fmtSourcePlan(plan) })
  while (plan.steps.length) {
    checkAborted(ctx.signal)
    const leftMs = deadline - Date.now()
    if (leftMs < 20_000) break
    const step = plan.steps[0]!
    tried.add(step.source)
    const before = inventoryCounts(bot)
    const note = await runStep(ctx, step.source, step.items, opts, s, leftMs)
    const after = inventoryCounts(bot)
    // what it gave, per wanted key (chest and substitute steps name items, the rest name keys)
    const got: Record<string, number> = {}
    for (const k of Object.keys(step.items)) { const d = (after[k] ?? 0) - (before[k] ?? 0) || countWant(k, after) - countWant(k, before); if (d > 0) got[k] = d }
    const use: SourceUse = { source: step.source, got, note }
    used.push(use)
    ctx.log.info('materials: source done', { source: step.source, got: JSON.stringify(got), note: note.slice(0, 160) })
    if (step.source !== 'substitutes') {
      agent.storage.set(FAILS_KEY, noteFailures(agent.storage.get(FAILS_KEY, {}), use, step.items, Date.now(), s.retryMinutes * 60_000))
    }
    plan = planSources(wants, sourceFacts(agent, bot, opts.accepts), s.sources, tried)
  }
  // optional extras (torches, glass) when no craft step ran for the required items
  const optShort = Object.entries(opts.optional ?? {}).filter(([k, n]) => countWant(k, inventoryCounts(bot)) < n)
  if (optShort.length && s.sources.includes('craft') && !tried.has('craft') && deadline - Date.now() > 30_000) {
    const r = await budgeted(ctx, deadline - Date.now(), c => gatherMaterials(c, {}, { ...opts, optional: Object.fromEntries(optShort) }))
    ctx.log.debug('materials: optional extras', { result: r.message.slice(0, 160) })
  }
  // skipped: why the first plan left a source out, unless it was used after all
  const usedSet = new Set(used.map(u => u.source))
  const skipped = [...firstSkips.filter(k => !usedSet.has(k.source)), ...plan.skipped.filter(k => !usedSet.has(k.source) && !firstSkips.some(f => f.source === k.source) && k.why !== 'nothing short')]
  const short = shortOf(wants, sourceFacts(agent, bot, opts.accepts), s.sources.includes('substitutes'))
  if (plan.steps.length && Object.keys(short).length) skipped.push({ source: plan.steps[0]!.source, why: 'out of time' })
  const run: SourceRun = { at: Date.now(), wants, used, skipped, short }
  agent.storage.set(LAST_KEY, run)
  const line = fmtSourceRun(run)
  const secs = Math.round((Date.now() - t0) / 1000)
  const have = Object.entries(wants).map(([k, n]) => `${n - (short[k] ?? 0)}/${n} ${k}`).join(', ')
  return Object.keys(short).length ? fail(`${line}; have ${have} after ${secs}s`, { short, run }) : ok(`${line}; have ${have} in ${secs}s`, { run })
}
