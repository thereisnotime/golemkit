// Base projects for Minecraft: the long-term improvements a bot makes to its base by itself
// (docs/guide/base-projects.md). The queue logic and the owner's decisions are game-agnostic
// (src/core/projects.ts); this file finds the base (fitting the base blueprint to what is built),
// surveys each project (the blueprint's stages, lighting, a storage row, a workshop, a reserved
// farm plot), works one in bounded sessions (chests first, then gather, then build only what is
// still missing, leaving other people's blocks alone) and offers the chat actions: projects,
// project (approve, veto, skip, next, pause...), plan_base (the dry run) and work_on_base.
// The NPC needs layer runs work_on_base as the active idle chore base_project
// (src/adapters/minecraft-java/needs/projects.ts).
import type { Bot } from 'mineflayer'
import type { ActionContext, ActionResult, Agent } from '../core/index.ts'
import {
  defineSkill, defineAction, z, ok, fail, checkAborted, fmtPos, needsSurvival, sleep, goals,
  projectsSettings, normalizeState, projectQueue, nextStep, applyOp, noteSession, restingReason, stuckReason, fmtQueue, goalMentions,
  PROJECT_OPS, type ProjectInfo, type ProjectState, type ProjectsSettings, type QueueEntry, type NextStep, type ProjectOp
} from '../core/index.ts'
import { GoalStore, type Goal } from '../llm/goals.ts'
import { vec, gotoWithin, isPlaceFace } from './world.ts'
import { inventoryCounts } from './toolkit.ts'
import { rotate, placeCells, bounds, resolveRoles, solidCells, isReplaceableName, isNaturalBlock, FACINGS, type Blueprint, type Facing, type Pos, type WorldCell, type ResolvedRole } from './blueprint.ts'
import {
  blueprintStages, stageCells, surveyStage, fitAnchor, interiorOf, fitRow, fitSquare, billOfMaterials, fmtBom, chestTakes, sessionWants,
  projectWords, projectNamed, safeToWork, EXTRA_PROJECTS, type Stage, type Interior, type Column, type Fit, type AnchorCandidate, type ProjectDef
} from './basePlan.ts'
import { buildStructure, ownBlocks, getPlacements, planSite } from './construction.ts'
import { gatherMaterials, wantsForRoles, countWant } from './materials.ts'
import { chestView, chestTotals, takeItemsFromOwnChests, takeWoodFromOwnChests } from './containers.ts'
import { loadLibrary } from './blueprint-library.ts'
import { libraryDirs } from './blueprint-library.ts'
import { getHome, getPlaces, setPlace } from './navigation.ts'
import { lightUp, ownTorches } from './lighting.ts'
import { tellOwners } from './pvp-actions.ts'
import { checkBase, secureBase, type BaseCheck } from './baseSafety.ts'

const STATE_KEY = 'projects.state'
const SPOTS_KEY = 'projects.spots'

interface Spots {
  anchor?: { origin: Pos, facing: Facing, source: string }
  storage?: Fit
  workshop?: Fit
  farm_plot?: { x0: number, z0: number, size: number, y: number }
  /** Last lighting check: dark spots left. */
  light?: { at: number, dark: number }
  /** Projects of a paused goal it finished and noted on the goal. */
  noted?: string[]
}

/** Default working order: what keeps the base safe and usable first, the big looks last. */
export const DEFAULT_ORDER = ['walls', 'integrity', 'farm_plot', 'floor', 'lighting', 'storage', 'workshop', 'walkway', 'towers']

export const settingsOf = (agent: Pick<Agent, 'settings'>): ProjectsSettings => projectsSettings((agent.settings as { projects?: unknown }).projects)
export const loadState = (agent: Pick<Agent, 'storage'>): ProjectState => normalizeState(agent.storage.get(STATE_KEY))
const saveState = (agent: Pick<Agent, 'storage'>, s: ProjectState) => agent.storage.set(STATE_KEY, s)
const spotsOf = (agent: Pick<Agent, 'storage'>): Spots => agent.storage.get<Spots>(SPOTS_KEY, {}) ?? {}
const saveSpots = (agent: Pick<Agent, 'storage'>, s: Spots) => agent.storage.set(SPOTS_KEY, s)

const key = (p: { x: number, y: number, z: number }) => `${p.x},${p.y},${p.z}`

function blueprintNamed (agent: Agent, name: string): Blueprint | null {
  return loadLibrary(libraryDirs(agent)).blueprints.get(name) ?? null
}

function blockName (bot: Bot, p: Pos): string | undefined {
  const b = bot.blockAt(vec(bot, p.x, p.y, p.z))
  return b ? b.name : undefined
}

// ------------------------------------------------------------------ the LLM goal

const BUILDING_GOAL = /\b(build|fortress|fort|wall|walls|tower|towers|floor|walkway|house|base|upgrade|storage|chests?|workshop)\b/i
/** An LLM goal untouched this long is nobody's work any more. */
const GOAL_STALE_MS = 30 * 60_000

/** The active LLM goal, if there is one (agent storage; no LLM brain needed to read it). */
export function activeGoal (agent: Pick<Agent, 'storage'>): Goal | null {
  try { return new GoalStore(agent.storage as never).active } catch { return null }
}

/**
 * Whether an LLM goal about building is being worked on now: then the projects stay out of its
 * way. A paused goal (waiting for an owner, a guardrail) or one nobody touched for 30 min isn't. Pure.
 */
export function goalHolds (goal: Pick<Goal, 'text' | 'paused' | 'updatedAt'> | null, now: number): boolean {
  if (!goal || !BUILDING_GOAL.test(goal.text)) return false
  if (goal.paused) return false
  return now - goal.updatedAt < GOAL_STALE_MS
}

// ------------------------------------------------------------------ the base

export interface Base {
  bp: Blueprint
  origin: Pos
  facing: Facing
  source: string
  /** No walls found: a new base at a spot picked near home (not remembered until work starts). */
  fresh: boolean
  cells: WorldCell[]
  roles: Record<string, ResolvedRole>
  stages: Stage[]
  box: { min: Pos, max: Pos }
  interior: Interior | null
}

function baseFrom (agent: Agent, bot: Bot, bp: Blueprint, origin: Pos, facing: Facing, source: string, fresh: boolean): Base {
  const turned = rotate(bp, facing)
  const cells = placeCells(turned, origin)
  const stages = blueprintStages(bp)
  const floor = stages.find(s => s.name === 'floor')?.roles ?? ['floor']
  return {
    bp: turned, origin, facing, source, fresh, cells, stages,
    roles: resolveRoles(turned, inventoryCounts(bot)),
    box: bounds(turned, origin),
    interior: interiorOf(cells, floor)
  }
}

/** Share of the walls stage (or the whole blueprint) already standing at an origin, 0..1. */
function wallScore (bot: Bot, bp: Blueprint, origin: Pos, facing: Facing): number {
  const turned = rotate(bp, facing)
  const stages = blueprintStages(bp)
  const walls = stages.find(s => s.name === 'walls') ?? stages[0]!
  const cells = solidCells(stageCells(placeCells(turned, origin), walls, stages)).filter(c => turned.roles[c.role]?.kind === 'block' || turned.roles[c.role]?.kind === undefined)
  if (!cells.length) return 0
  const roles = resolveRoles(turned, {})
  let hit = 0
  let seen = 0
  for (const c of cells) {
    const n = blockName(bot, c)
    if (n === undefined) continue
    seen++
    const r = roles[c.role]
    if (r && (n === r.item || r.accept.test(n))) hit++
  }
  return seen < cells.length / 2 ? 0 : hit / cells.length
}

/**
 * Where the base is: settings.projects.base, the one it remembered, else the base blueprint
 * fitted to what stands at a build in progress, a finished placement, the place named like the
 * template (or "fortress", "base") or home; else a new spot near home.
 */
export function findBase (agent: Agent, bot: Bot, s = settingsOf(agent)): Base | string {
  const bp = blueprintNamed(agent, s.template)
  if (!bp) return `no blueprint "${s.template}" for the base (settings projects.template)`
  if (s.base) return baseFrom(agent, bot, bp, { x: Math.floor(s.base.x), y: Math.floor(s.base.y), z: Math.floor(s.base.z) }, s.base.facing ?? bp.facing, 'settings', false)
  const spots = spotsOf(agent)
  if (spots.anchor) return baseFrom(agent, bot, bp, spots.anchor.origin, spots.anchor.facing, spots.anchor.source, false)
  const cands: AnchorCandidate[] = []
  const active = agent.storage.get<{ template: string, origin: Pos, facing: Facing } | undefined>('build.active')
  if (active?.template === bp.name) cands.push({ origin: active.origin, facing: active.facing, source: 'the build in progress' })
  for (const p of getPlacements(agent).filter(p => p.template === bp.name).reverse()) cands.push({ origin: p.origin, facing: p.facing, source: 'a finished build' })
  const places = getPlaces(agent)
  for (const n of [bp.name, 'fortress', 'base']) {
    const pl = places[n]
    if (pl) for (const f of FACINGS) cands.push({ origin: { x: Math.floor(pl.x), y: Math.floor(pl.y), z: Math.floor(pl.z) }, facing: f, source: `the place ${n}` })
  }
  const home = getHome(agent)
  if (home) for (const f of FACINGS) cands.push({ origin: { x: Math.floor(home.x), y: Math.floor(home.y), z: Math.floor(home.z) }, facing: f, source: 'home' })
  const fit = fitAnchor(cands, (o, f) => wallScore(bot, bp, o, f))
  if (fit) return baseFrom(agent, bot, bp, fit.origin, fit.facing, `${fit.source} (${Math.round(fit.score * 100)}% of the walls stand)`, false)
  // nothing built yet: a new base near home
  if (!home) return 'no home set and no base found: set a home first (or settings projects.base)'
  const me = bot.entity?.position
  if (!me || Math.hypot(me.x - home.x, me.z - home.z) > 32) return 'no base found yet; a spot for a new one is picked once I am home'
  const site = planSite({ bot, agent }, bp.name)
  if (typeof site === 'string') return `no base found, and no spot for a new ${bp.name} near home: ${site}`
  // kept from now on, so what is proposed is where it gets built (the spot build picks moves with the bot)
  saveSpots(agent, { ...spots, anchor: { origin: site.origin, facing: site.facing, source: 'a new spot near home' } })
  return baseFrom(agent, bot, bp, site.origin, site.facing, 'a new spot near home', true)
}

// ------------------------------------------------------------------ survey

export interface Surveyed {
  info: ProjectInfo
  def: { kind: 'stage', stage: Stage } | { kind: ProjectDef['kind'], def: ProjectDef }
  /** Stage and row projects: the cells to build (the build diffs them against the world itself). */
  cells?: WorldCell[]
  /** Of those, the ones not right yet. */
  todo?: WorldCell[]
  /** Where a row or plot goes (computed now, kept when the work starts). */
  fit?: Fit | { x0: number, z0: number, size: number, y: number }
  roles?: Record<string, ResolvedRole>
  bp?: Blueprint
  origin?: Pos
  facing?: Facing
  note?: string
  /** secure: the base safety check. */
  safety?: BaseCheck
}

export interface BaseSurvey { base: Base, projects: Surveyed[], goal: Goal | null }

function chestSlots (bot: Bot, contents: Record<string, number>): number {
  const items = (bot.registry as { itemsByName?: Record<string, { stackSize?: number }> }).itemsByName ?? {}
  return Object.entries(contents).reduce((n, [k, v]) => n + Math.ceil(v / (items[k]?.stackSize ?? 64)), 0)
}

const inBox = (p: { x: number, z: number }, box: Base['box'], pad = 0) => p.x >= box.min.x - pad && p.x <= box.max.x + pad && p.z >= box.min.z - pad && p.z <= box.max.z + pad

/** Surveys every project at the base. */
export function surveyBase (agent: Agent, bot: Bot, s = settingsOf(agent)): BaseSurvey | string {
  const base = findBase(agent, bot, s)
  if (typeof base === 'string') return base
  const spots = spotsOf(agent)
  const goal = activeGoal(agent)
  const requested = goal && !goalHolds(goal, Date.now()) ? goalMentions(goal.text, projectWords(base.stages)) : []
  const by = goal?.owner ?? 'an owner'
  const own = ownBlocks(agent)
  const torches = new Set(ownTorches(agent).map(key))
  const isOwn = (p: Pos) => own.has(p) || torches.has(key(p))
  const planned = new Set(base.cells.map(key))
  const at = (p: Pos) => blockName(bot, p)
  const plot = spots.farm_plot
  const inPlot = (p: { x: number, z: number }) => !!plot && p.x >= plot.x0 && p.x < plot.x0 + plot.size && p.z >= plot.z0 && p.z < plot.z0 + plot.size
  const out: Surveyed[] = []

  // the blueprint's stages
  // an attachment (a ladder, a wall torch) needs its block: there now, or a planned one that can still go in
  const solidPlanned = new Set(solidCells(base.cells).map(key))
  const support = {
    solidAt: (p: Pos) => isPlaceFace(bot.blockAt(vec(bot, p.x, p.y, p.z))),
    willBuild: (p: Pos) => { if (!solidPlanned.has(key(p))) return false; const n = at(p); return n === undefined || isReplaceableName(n) || isNaturalBlock(n) || isOwn(p) }
  }
  for (const st of base.stages) {
    const cells = stageCells(base.cells, st, base.stages)
    const sv = surveyStage(cells, at, base.roles, { canDig: agent.canDig, own: isOwn, skipCovered: st.skipCovered, planned: p => planned.has(key(p)), exclude: st.name === 'floor' ? inPlot : undefined, support })
    const skipped = new Set([...sv.covered, ...sv.blocked, ...sv.unsupported.map(u => u.cell)].map(key))
    const left = sv.todo.length + sv.unknown.length
    const u0 = sv.unsupported[0]
    const notes = [sv.blocked.length ? `${sv.blocked.length} spots hold blocks I didn't place, left alone` : '', sv.covered.length ? `${sv.covered.length} under other builds, left alone` : '',
      u0 ? `${sv.unsupported.length} can't go in, left alone: ${base.roles[u0.cell.role]?.item ?? u0.cell.role} at ${fmtPos(u0.cell)} hangs on ${fmtPos(u0.support)}, which holds ${at(u0.support) ?? 'nothing loaded'} and isn't mine to change` : '',
      sv.unknown.length ? `${sv.unknown.length} not loaded` : ''].filter(Boolean)
    const after = [...st.after]
    if (st.name === 'floor' && !plot) after.push('farm_plot')
    out.push({
      info: { name: st.name, title: st.title, left, total: sv.total, after, ...(requested.includes(st.name) ? { requestedBy: by } : {}) },
      def: { kind: 'stage', stage: st },
      cells: cells.filter(c => !skipped.has(key(c)) && !(st.name === 'floor' && inPlot(c))),
      todo: [...sv.todo, ...sv.unknown],
      roles: base.roles, bp: base.bp, origin: base.origin, facing: base.facing,
      note: notes.join('; ')
    })
  }
  const stageDone = (n: string) => { const p = out.find(x => x.info.name === n); return !p || p.info.left === 0 }
  const interior = base.interior
  const door = base.cells.filter(c => base.roles[c.role]?.kind === 'door').map(c => ({ x: c.x, z: c.z }))
  const y0 = interior?.y ?? base.origin.y
  const fitted: Column[] = [...(spots.storage?.cells ?? []), ...(spots.workshop?.cells ?? [])]
  const reservedCols = (c: Column) => inPlot(c) || fitted.some(q => q.x === c.x && q.z === c.z)
  const freeCol = (c: Column) => {
    if (reservedCols(c)) return false
    const floor = at({ x: c.x, y: y0, z: c.z })
    if (floor === undefined || floor === 'water' || floor === 'lava') return false
    for (const dy of [1, 2]) { const n = at({ x: c.x, y: y0 + dy, z: c.z }); if (n === undefined || !isReplaceableName(n)) return false }
    return true
  }
  const indoors = stageDone('walls') && !!spots.light && spots.light.dark === 0
  const lib = loadLibrary(libraryDirs(agent)).blueprints

  for (const def of EXTRA_PROJECTS) {
    const after = (def.after ?? []).filter(a => out.some(p => p.info.name === a) || base.stages.some(st => st.name === a))
    const info = (left: number, total: number, extra: Partial<ProjectInfo> = {}): ProjectInfo => ({ name: def.name, title: def.title, left, total, after, ...(requested.includes(def.name) ? { requestedBy: by } : {}), ...extra })
    if (def.kind === 'plot') {
      if (!agent.getAction('start_farm')) continue
      if (plot) { out.push({ info: info(0, 1, { small: true }), def: { kind: 'plot', def }, fit: plot, note: `${plot.size}x${plot.size} at ${plot.x0} ${plot.z0}` }); continue }
      if (!interior) { out.push({ info: info(1, 1, { small: true, blocked: 'no inside to the base' }), def: { kind: 'plot', def } }); continue }
      const floorDone = out.find(p => p.info.name === 'floor')
      if (floorDone && floorDone.info.left === 0 && floorDone.info.total > 0) { out.push({ info: info(0, 1, { small: true }), def: { kind: 'plot', def }, note: 'the floor is stone already: no plot' }); continue }
      const sq = fitSquare(interior, freeCol, { max: 5, min: 3, margin: 1, avoid: door })
      out.push({ info: info(sq ? 1 : 1, 1, { small: true, ...(sq ? {} : { blocked: 'no free 3x3 inside the walls' }) }), def: { kind: 'plot', def }, ...(sq ? { fit: { ...sq, y: y0 } } : {}) })
      continue
    }
    if (def.kind === 'secure') {
      // base safety (baseSafety.ts): only once the base is settled; off with settings baseSafety.enabled
      const c = base.fresh ? null : checkBase(agent, bot)
      if (!c || typeof c === 'string') continue
      const left = c.steps.length
      const blocked = !left && c.unfixed.length ? `nothing I can do: ${c.unfixed[0]!.slice(0, 160)}` : undefined
      out.push({ info: info(left + (blocked ? 1 : 0), Math.max(1, left), { small: true, ...(blocked ? { blocked } : {}) }), def: { kind: 'secure', def }, safety: c, note: c.lines.length ? c.lines.slice(0, 4).join('; ') : 'nothing open to mobs under or by the base' })
      continue
    }
    if (def.kind === 'light') {
      const l = spots.light
      const fresh = l && Date.now() - l.at < 24 * 3_600_000
      const left = fresh ? l.dark : Math.max(1, l?.dark ?? 1)
      out.push({ info: info(left, Math.max(left, l?.dark ?? 0, 1), { small: true, indoors: stageDone('walls') }), def: { kind: 'light', def }, note: l ? `last check ${Math.round((Date.now() - l.at) / 60_000)} min ago: ${l.dark} dark spots` : 'not checked yet' })
      continue
    }
    // rows against a wall: storage, workshop
    const rb = def.blueprint ? lib.get(def.blueprint) : undefined
    if (!rb) continue
    const spot = def.name === 'storage' ? spots.storage : spots.workshop
    const surveyRow = (fit: Fit): Surveyed => {
      const turned = rotate(rb, fit.facing)
      const origin = { x: fit.x, y: y0 + 1, z: fit.z }
      const cells = placeCells(turned, origin)
      const roles = resolveRoles(turned, inventoryCounts(bot))
      const sv = surveyStage(cells, at, roles, { canDig: agent.canDig, own: isOwn })
      return { info: info(sv.todo.length + sv.unknown.length, sv.total, { indoors }), def: { kind: 'row', def }, cells, todo: [...sv.todo, ...sv.unknown], fit, roles, bp: turned, origin, facing: fit.facing, note: `at ${fmtPos(origin)} facing ${fit.facing}` }
    }
    if (spot) { out.push(surveyRow(spot)); continue }
    // is it needed? storage: no chest at the base or the ones there are nearly full; workshop: no table or no furnace inside
    let needed = true
    let why = ''
    if (def.name === 'storage') {
      const chests = chestView(agent, bot, 64).filter(c => inBox(c, base.box, 2))
      const known = chests.filter(c => c.contents)
      const full = known.filter(c => chestSlots(bot, c.contents!) >= 24)
      needed = !chests.length || (known.length > 0 && full.length === known.length)
      why = !chests.length ? 'no chest at the base' : `${full.length} of ${known.length} chests at the base are full`
    } else {
      let table = false
      let furnace = false
      for (let x = base.box.min.x; x <= base.box.max.x; x++) {
        for (let z = base.box.min.z; z <= base.box.max.z; z++) {
          for (let y = y0; y <= y0 + 3; y++) {
            const n = at({ x, y, z })
            if (n === 'crafting_table') table = true
            if (n === 'furnace' || n === 'smoker' || n === 'blast_furnace') furnace = true
          }
        }
      }
      needed = !(table && furnace)
      why = needed ? `no ${!table ? 'crafting table' : 'furnace'} inside` : 'has a crafting table and a furnace'
    }
    if (!needed) { out.push({ info: info(0, 0), def: { kind: 'row', def }, note: why }); continue }
    const fit = interior ? fitRow(interior, rb.width, freeCol, { avoid: door, keepClear: 2 }) : null
    if (!fit) { out.push({ info: info(rb.cells.length, rb.cells.length, { blocked: `no free wall ${rb.width} long inside for it` }), def: { kind: 'row', def }, note: why }); continue }
    fitted.push(...fit.cells)
    const r = surveyRow(fit)
    r.note = `${why}; ${r.note}`
    out.push(r)
  }
  // working order: settings.order and the owner's order on top of DEFAULT_ORDER
  out.sort((a, b) => rankOf(a.info.name) - rankOf(b.info.name))
  return { base, projects: out, goal }
}

const rankOf = (n: string) => { const i = DEFAULT_ORDER.indexOf(n); return i < 0 ? DEFAULT_ORDER.length : i }

export interface BasePlan { survey: BaseSurvey, queue: QueueEntry[], step: NextStep, state: ProjectState, settings: ProjectsSettings, holds: boolean }

/** The survey, the queue and the next step. */
export function planBase (agent: Agent, bot: Bot, now = Date.now()): BasePlan | string {
  const settings = settingsOf(agent)
  const survey = surveyBase(agent, bot, settings)
  if (typeof survey === 'string') return survey
  const state = loadState(agent)
  // a project that failed a few sessions in a row rests a while
  const infos = survey.projects.map(p => {
    const rest = restingReason(state.progress[p.info.name], now)
    const stuck = p.info.left > 0 ? stuckReason(state.progress[p.info.name]) : null
    const info = stuck ? { ...p.info, stuck } : p.info
    return rest && p.info.left > 0 ? { ...info, blocked: rest } : info
  })
  const queue = projectQueue(infos, state, settings, now)
  const holds = goalHolds(survey.goal, now)
  const online = agent.inSession ? agent.adapter.players?.() ?? [] : []
  const ownerOnline = online.some(p => p !== agent.username && agent.isOwner(p) && agent.owners.length > 0)
  const t = agent.inSession ? agent.adapter.time?.() : null
  const night = !!t && t.timeOfDay > 12_542 && t.timeOfDay < 23_460
  const step: NextStep = holds
    ? { kind: 'none', why: `an LLM goal is on the building: ${survey.goal!.text.slice(0, 80)}` }
    : nextStep(queue, state, settings, { now, ownerOnline, night })
  const sec = survey.projects.find(x => x.def.kind === 'secure')?.safety
  lastPlans.set(agent, {
    at: now,
    next: step.kind === 'none' ? step.why : `${step.kind === 'ask' ? 'ask about' : 'work on'} ${step.entry.info.name}`,
    stuck: Object.fromEntries(queue.filter(e => e.info.stuck && e.status !== 'done').map(e => [e.info.name, e.info.stuck!.slice(0, 160)])),
    waiting: queue.filter(e => e.status === 'needs_ok' || e.status === 'asked' || e.status === 'blocked').map(e => `${e.info.name}: ${e.status.replace('_', ' ')} (${e.why.slice(0, 100)})`),
    ...(sec ? { safety: sec.lines.length ? sec.lines.slice(0, 3) : ['ok'] } : {})
  })
  return { survey, queue, step, state, settings, holds }
}

/** The last plan's short form for the status view (planBase runs every 20 s or so while idle). */
const lastPlans = new WeakMap<object, { at: number, next: string, stuck: Record<string, string>, waiting: string[], safety?: string[] }>()

// ------------------------------------------------------------------ materials, plan text

/** What its chests near home hold (container memory). */
function storedTotals (agent: Agent, bot: Bot): Record<string, number> {
  try { return chestTotals(chestView(agent, bot)).has } catch { return {} }
}

function bomOf (agent: Agent, bot: Bot, p: Surveyed): ReturnType<typeof billOfMaterials> {
  if (!p.todo || !p.roles) return []
  return billOfMaterials(p.todo, p.roles, inventoryCounts(bot), storedTotals(agent, bot))
}

export function planLines (agent: Agent, bot: Bot, p: BasePlan, detail: boolean): string[] {
  const b = p.survey.base
  const paused = p.state.paused ? `, paused by ${p.state.paused.by}` : p.settings.paused ? ', paused' : ''
  const lines = [`${b.fresh ? 'new ' : ''}${b.bp.name} at ${fmtPos(b.origin)}, gate ${b.facing} (${b.source}); policy ${p.settings.policy}${p.settings.policy === 'auto' ? `, ok needed above ${p.settings.askAbove} blocks` : ''}${paused}`]
  lines.push(...fmtQueue(p.queue))
  if (detail) {
    for (const s of p.survey.projects) {
      const bom = s.info.left > 0 ? fmtBom(bomOf(agent, bot, s)) : ''
      const text = [s.note, bom].filter(Boolean).join('; ')
      if (text) lines.push(`  ${s.info.name}: ${text}`)
    }
  }
  if (p.holds) lines.push(`an LLM goal about building is active, the projects wait: ${p.survey.goal!.text.slice(0, 100)}`)
  else if (p.survey.goal && p.survey.projects.some(x => x.info.requestedBy)) lines.push(`from the paused goal "${p.survey.goal.text.slice(0, 80)}": ${p.survey.projects.filter(x => x.info.requestedBy).map(x => x.info.name).join(', ')} count as asked for by ${p.survey.goal.owner ?? 'an owner'}`)
  lines.push(`next: ${p.step.kind === 'none' ? p.step.why : `${p.step.kind === 'ask' ? 'ask about' : 'work on'} ${p.step.entry.info.name}`}`)
  return lines
}

// ------------------------------------------------------------------ asking and working

/** Proposes a project to the owners online and notes when. */
export function askOwners (agent: Agent, bot: Bot, p: BasePlan, entry: QueueEntry): string {
  const sv = p.survey.projects.find(x => x.info.name === entry.info.name)
  const missing = sv ? bomOf(agent, bot, sv).filter(r => r.missing && !r.optional).map(r => `${r.missing} ${r.item}`) : []
  const me = agent.username.toLowerCase()
  const text = `base project: ${entry.info.title} at the ${p.survey.base.bp.name}, ${entry.info.left} blocks${missing.length ? ` (I still need ${missing.join(', ')})` : ''}. Say "${me} approve ${entry.info.name}" to build it or "${me} skip ${entry.info.name}"`
  if (agent.owners.length) tellOwners(agent, text)
  const state = loadState(agent)
  state.asked[entry.info.name] = Date.now()
  saveState(agent, state)
  return text
}

const WOODY = /^(planks|log|door|trapdoor|ladder|chest|crafting_table|fence|fence_gate|stick)$|_(planks|log|door|fence)$/

type Ctx = Pick<ActionContext, 'bot' | 'agent' | 'signal' | 'log' | 'player'>

/** Runs `fn` with a signal that also aborts after `ms`. Running out of time is not an error. */
async function withTime<T> (ctx: Ctx, ms: number, fn: (c: Ctx) => Promise<T>): Promise<{ value?: T, timedOut: boolean }> {
  const ctl = new AbortController()
  const onAbort = () => ctl.abort()
  ctx.signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => ctl.abort(), ms)
  try {
    return { value: await fn({ ...ctx, signal: ctl.signal }), timedOut: false }
  } catch (e) {
    checkAborted(ctx.signal)
    if (ctl.signal.aborted) return { timedOut: true }
    throw e
  } finally {
    clearTimeout(timer)
    ctx.signal.removeEventListener('abort', onAbort)
    ;(ctx.bot as Bot).pathfinder?.setGoal(null)
  }
}

/** Takes from its chests, then gathers (bounded), what this session's part of the project needs. */
async function supply (ctx: Ctx, sv: Surveyed, s: ProjectsSettings, notes: string[]): Promise<void> {
  const { bot, agent } = ctx as { bot: Bot, agent: Agent }
  if (!sv.todo?.length || !sv.roles || !needsSurvival(bot)) return
  const stored = storedTotals(agent, bot)
  const bom = billOfMaterials(sv.todo, sv.roles, inventoryCounts(bot), stored)
  const takes = chestTakes(bom, sv.roles, stored, s.carry)
  if (Object.keys(takes).length) {
    const t = await takeItemsFromOwnChests({ bot, agent, signal: ctx.signal }, takes, 64).catch(e => { checkAborted(ctx.signal); return { took: {}, units: 0, notes: [(e as Error).message] } })
    if (t.units) notes.push(`took ${Object.entries(t.took).map(([k, v]) => `${v} ${k}`).join(', ')} from my chests`)
  }
  const wants = wantsForRoles(sv.todo, sv.roles)
  const req = sessionWants(wants.required, s.carry)
  const short = () => Object.entries(req).filter(([k, n]) => countWant(k, inventoryCounts(bot)) < n)
  if (!short().length) return
  if (short().some(([k]) => WOODY.test(k)) && countWant('log', inventoryCounts(bot)) < 4) {
    const w = await takeWoodFromOwnChests({ bot, agent, signal: ctx.signal }, 32).catch(e => { checkAborted(ctx.signal); return { took: {}, units: 0, notes: [(e as Error).message] } })
    if (w.units) notes.push(`took ${Object.entries(w.took).map(([k, v]) => `${v} ${k}`).join(', ')} for wood`)
  }
  if (!short().length || !agent.canDig) return
  const g = await withTime(ctx, s.gatherMinutes * 60_000, c => gatherMaterials(c, req, { optional: sessionWants(wants.optional, 32), fallbacks: wants.fallbacks }))
  notes.push(g.timedOut ? `gathered for ${s.gatherMinutes} min` : `gathered: ${g.value?.message.slice(0, 160)}`)
}

/** The gate: the door's lower half, the spot in front of it outside and the first spot inside. */
export function gateOf (base: Pick<Base, 'cells' | 'roles' | 'interior'>): { door: Pos, outside: Pos, inside: Pos } | null {
  if (!base.interior) return null
  const inside = new Set(base.interior.cols.map(c => `${c.x},${c.z}`))
  const door = base.cells.filter(c => base.roles[c.role]?.kind === 'door' && !c.passive).sort((a, b) => a.y - b.y)[0]
  if (!door) return null
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    if (inside.has(`${door.x + dx},${door.z + dz}`) && !inside.has(`${door.x - dx},${door.z - dz}`)) {
      return { door: { x: door.x, y: door.y, z: door.z }, outside: { x: door.x - dx, y: door.y, z: door.z - dz }, inside: { x: door.x + dx, y: door.y, z: door.z + dz } }
    }
  }
  return null
}

/**
 * Walks in through the gate when the bot is outside a walled base: the pathfinder can't use a
 * door (it would dig through a wall instead), so: to the column in front of the gate, open the
 * door, step (and hop) through, shut it behind. False when it couldn't (no door, not reached).
 */
async function enterBase (ctx: Ctx, base: Base): Promise<boolean> {
  const bot = ctx.bot as Bot
  const gate = gateOf(base)
  if (!gate || !base.interior) return false
  const inside = new Set(base.interior.cols.map(c => `${c.x},${c.z}`))
  const here = () => { const p = bot.entity.position; return inside.has(`${Math.floor(p.x)},${Math.floor(p.z)}`) }
  if (here()) return true
  await gotoWithin(bot, new goals.GoalXZ(gate.outside.x, gate.outside.z), ctx.signal, 45_000).catch(() => { checkAborted(ctx.signal) })
  const p0 = bot.entity.position
  if (Math.hypot(p0.x - (gate.outside.x + 0.5), p0.z - (gate.outside.z + 0.5)) > 1.5) return false
  const door = bot.blockAt(vec(bot, gate.door.x, gate.door.y, gate.door.z))
  if (!door || !/_door$/.test(door.name)) return false
  const isOpen = () => (bot.blockAt(vec(bot, gate.door.x, gate.door.y, gate.door.z))?.getProperties() as { open?: boolean } | undefined)?.open === true
  if (!isOpen()) { await bot.activateBlock(door).catch(() => {}); await sleep(300, ctx.signal) }
  await bot.lookAt(vec(bot, gate.inside.x + 0.5, gate.inside.y + 1.6, gate.inside.z + 0.5), true)
  // the floor inside can be a block above the ground outside: jump while walking in
  bot.setControlState('forward', true)
  bot.setControlState('jump', true)
  try {
    for (let i = 0; i < 30 && !here(); i++) await sleep(100, ctx.signal)
    bot.setControlState('jump', false)
    await sleep(250, ctx.signal)
  } finally {
    bot.setControlState('forward', false)
    bot.setControlState('jump', false)
  }
  const shut = bot.blockAt(vec(bot, gate.door.x, gate.door.y, gate.door.z))
  if (shut && isOpen()) await bot.activateBlock(shut).catch(() => {})
  return here()
}

/** One work session on a project: at most sessionMinutes. */
export async function workOn (ctx: Ctx, p: BasePlan, entry: QueueEntry, minutes: number): Promise<ActionResult> {
  const { agent } = ctx
  const bot = ctx.bot as Bot
  const s = p.settings
  const sv = p.survey.projects.find(x => x.info.name === entry.info.name)!
  const base = p.survey.base
  const spots = spotsOf(agent)
  // the base is settled once work starts on it
  if (!s.base && !spots.anchor) { spots.anchor = { origin: base.origin, facing: base.facing, source: base.source }; saveSpots(agent, spots) }
  const notes: string[] = []
  const before = entry.info.left
  let result: ActionResult
  const kind = sv.def.kind
  if (kind === 'plot') {
    const f = sv.fit as Spots['farm_plot']
    if (!f) return fail('no spot for a farm plot')
    spots.farm_plot = f
    saveSpots(agent, spots)
    const c = { x: f.x0 + Math.floor(f.size / 2), y: f.y + 1, z: f.z0 + Math.floor(f.size / 2) }
    setPlace(agent, 'farm_plot', { ...c, ...(bot.game?.dimension ? { dimension: String(bot.game.dimension).replace('minecraft:', '') } : {}) })
    result = ok(`kept a ${f.size}x${f.size} plot inside the walls free for a farm (place farm_plot, ${fmtPos(c)}); the floor goes around it`)
  } else if (kind === 'secure') {
    result = sv.safety ? await secureBase(ctx, sv.safety, minutes) : fail('no base safety check')
  } else if (kind === 'light') {
    await enterBase(ctx, base)
    const y = (base.interior?.y ?? base.origin.y) + 1
    const radius = Math.ceil(Math.max(base.bp.width, base.bp.depth) / 2) + 1
    const params = lightUp.params.parse({ x: base.origin.x, y, z: base.origin.z, radius: Math.min(48, radius), y_range: 4, max_torches: 16 })
    const t = await withTime(ctx, minutes * 60_000, c => Promise.resolve(lightUp.run({ ...c, caller: { kind: 'brain', name: 'projects' } } as ActionContext, params)))
    const r = t.value ? (typeof t.value === 'string' ? ok(t.value) : (t.value ?? ok('done'))) : ok('ran out of time lighting')
    const d = (r.data ?? {}) as { left?: number, dark?: number, placed?: unknown[] }
    const dark = typeof d.left === 'number' ? d.left : (typeof d.dark === 'number' ? d.dark : before)
    spots.light = { at: Date.now(), dark: /nothing to light/.test(r.message) ? 0 : dark }
    saveSpots(agent, spots)
    result = r
  } else {
    await supply(ctx, sv, s, notes)
    checkAborted(ctx.signal)
    // the floor and the rows are inside: in through the gate (the walls and towers are reached from either side)
    const indoorWork = kind === 'row' || ('stage' in sv.def && sv.def.stage.name === 'floor')
    if (indoorWork && !(await enterBase(ctx, base))) notes.push('could not get in through the gate')
    if (kind === 'row') {
      const fit = sv.fit as Fit
      if (sv.def.kind === 'row' && sv.def.def.name === 'storage') spots.storage = fit
      else spots.workshop = fit
      saveSpots(agent, spots)
    }
    const keys = new Set((sv.cells ?? []).map(key))
    const only = kind === 'stage' ? (c: WorldCell) => keys.has(key(c)) || (!!c.passive && keys.has(key({ x: c.x, y: c.y - 1, z: c.z }))) : undefined
    const template = kind === 'stage' ? s.template : (sv.def as { def: ProjectDef }).def.blueprint!
    const origin = sv.origin ?? base.origin
    const t = await withTime(ctx, minutes * 60_000, c => buildStructure(c, { template, x: origin.x, y: origin.y, z: origin.z, facing: sv.facing ?? base.facing, gather: false, path: false, autonomous: true, ...(only ? { only } : {}) }))
    result = t.value ?? ok(`session over after ${minutes} min`)
  }
  // how far it got
  const after = planBase(agent, bot)
  const now = typeof after === 'string' ? null : after.survey.projects.find(x => x.info.name === entry.info.name)?.info ?? null
  const left = now?.left ?? before
  const done = left === 0
  const progressed = left < before || done
  const msg = `${entry.info.name}: ${notes.length ? `${notes.join('; ')}; ` : ''}${result.message}`.slice(0, 400)
  saveState(agent, noteSession(loadState(agent), entry.info.name, { now: Date.now(), message: msg, progressed, done }))
  if (done) {
    tellOwnersIf(agent, `base project done: ${entry.info.name} (${entry.info.title}) at the ${base.bp.name}`)
    noteGoal(agent, entry.info.name, entry.info.title)
  }
  const tail = done ? ' (done)' : ` (${left} left)`
  return progressed || result.ok ? ok(`${msg}${tail}`, { project: entry.info.name, left, done }) : fail(`${msg}${tail}`, { project: entry.info.name, left, done })
}

function tellOwnersIf (agent: Agent, text: string): void {
  if (agent.owners.length) tellOwners(agent, text)
}

/** A paused LLM goal asked for this project: say on the goal that it is done, so the model can wrap up when it is back. */
function noteGoal (agent: Agent, project: string, title: string): void {
  const goal = activeGoal(agent)
  if (!goal) return
  const spots = spotsOf(agent)
  if (spots.noted?.includes(`${goal.id}:${project}`)) return
  try {
    new GoalStore(agent.storage as never).update({ note: `base projects finished ${project} (${title}) on their own; check what is left before building it again` })
    spots.noted = [...(spots.noted ?? []), `${goal.id}:${project}`].slice(-20)
    saveSpots(agent, spots)
  } catch {}
}

// ------------------------------------------------------------------ actions

function ownerCheck (ctx: ActionContext): string | null {
  if (ctx.caller.kind === 'system') return null
  const who = ctx.player ?? (ctx.caller.kind === 'player' ? ctx.caller.name : undefined)
  if (who && ctx.agent.isOwner(who)) return null
  return 'only my owners can change the base projects'
}

const projectsAction = defineAction({
  name: 'projects',
  description: 'List the base projects (fortress walls, stone floor, lighting, storage chests, workshop, walkway, towers, a farm plot) in working order: ' +
    'what is done, ready, waiting for an owner\'s ok, skipped or blocked, the policy and what comes next. Answers "pax projects".',
  params: z.object({}),
  exclusive: false,
  run ({ agent, bot }) {
    if (!(bot as Bot)?.entity) return fail('not in the game')
    const p = planBase(agent, bot as Bot)
    if (typeof p === 'string') return fail(p)
    const lines = planLines(agent, bot as Bot, p, false)
    return ok(lines.join('\n'), { lines, next: p.step })
  }
})

const projectAction = defineAction({
  name: 'project',
  description: 'Owners: decide about a base project. approve (ok to build), veto (never), skip (not now), unskip, next (build it next, implies ok), ' +
    'pause / resume (all base work), reset (forget what was said about one, or all). Names: walls, floor, walkway, towers, lighting, storage, workshop, farm_plot.',
  params: z.object({
    op: z.enum(PROJECT_OPS).describe('approve | veto | skip | unskip | next | pause | resume | reset'),
    name: z.string().optional().describe('the project (not for pause/resume); words like "chests" or "the towers" work')
  }),
  exclusive: false,
  run (ctx, { op, name }) {
    const deny = ownerCheck(ctx)
    if (deny) return fail(deny)
    const bot = ctx.bot as Bot
    const sv = bot?.entity ? surveyBase(ctx.agent, bot) : null
    const stages = sv && typeof sv !== 'string' ? sv.base.stages : blueprintStages(blueprintNamed(ctx.agent, settingsOf(ctx.agent).template) ?? { name: 'base', roles: {}, meta: {} })
    const words = projectWords(stages)
    const known = sv && typeof sv !== 'string' ? sv.projects.map(p => p.info.name) : Object.keys(words)
    const project = name ? projectNamed(name, words) ?? name.toLowerCase() : undefined
    const by = ctx.player ?? (ctx.caller.kind === 'player' ? ctx.caller.name : 'system')
    const r = applyOp(loadState(ctx.agent), op as ProjectOp, project, by, Date.now(), known)
    if (!r.ok) return fail(r.message)
    saveState(ctx.agent, r.state)
    return ok(r.message)
  }
})

const planBaseAction = defineAction({
  name: 'plan_base',
  description: 'Dry run of the base projects: finds the base (fits the fortress blueprint to what is built), surveys every project (blocks done and left, ' +
    'spots left alone because they hold someone else\'s blocks), the materials each still needs against what it carries and what its chests hold, ' +
    'where new things would go, and what it would do next. Builds nothing. Answers "pax plan fortress".',
  params: z.object({ detail: z.boolean().default(true).describe('add the materials and notes per project') }),
  exclusive: false,
  run ({ agent, bot }, { detail }) {
    if (!(bot as Bot)?.entity) return fail('not in the game')
    const p = planBase(agent, bot as Bot)
    if (typeof p === 'string') return fail(p)
    const lines = planLines(agent, bot as Bot, p, detail)
    return ok(lines.join('\n'), { lines, base: { origin: p.survey.base.origin, facing: p.survey.base.facing, source: p.survey.base.source }, queue: p.queue.map(e => ({ name: e.info.name, status: e.status, left: e.info.left, total: e.info.total, why: e.why })), next: p.step })
  }
})

const workOnBase = defineAction({
  name: 'work_on_base',
  description: 'One work session on the base projects (at most `minutes`): the next one in the queue, or the one named. Takes materials from its chests, ' +
    'gathers what is still missing (bounded), then builds only what is not there yet; never digs blocks it did not place itself except natural ones. ' +
    'Resumes where the last session stopped. Big projects need an owner\'s ok first (policy).',
  params: z.object({
    project: z.string().optional().describe('work on this one (it must be ready, or an owner asks); default the next in the queue'),
    minutes: z.number().min(1).max(60).optional().describe('session length (default settings projects.sessionMinutes, 10)')
  }),
  // a reflex (eating, a fight) suspends the session and it picks up again afterwards, instead of ending it
  longRunning: true,
  async run (ctx, { project, minutes }) {
    const bot = ctx.bot as Bot
    if (!bot?.entity) return fail('not in the game')
    const p = planBase(ctx.agent, bot)
    if (typeof p === 'string') return fail(p)
    const mins = minutes ?? p.settings.sessionMinutes
    const owner = !ownerCheck(ctx) && ctx.caller.kind !== 'system'
    let entry: QueueEntry | undefined
    if (project) {
      const name = projectNamed(project, projectWords(p.survey.base.stages)) ?? project
      entry = p.queue.find(e => e.info.name === name)
      if (!entry) return fail(`no project ${project}; there are ${p.queue.map(e => e.info.name).join(', ')}`)
      if (entry.status === 'done') return ok(`${name} is done`)
      if (entry.status === 'blocked') return fail(`${name}: ${entry.why}`)
      if (entry.status !== 'ready' && !owner) return fail(`${name} is ${entry.status.replace('_', ' ')} (${entry.why})`)
    } else {
      if (p.step.kind === 'none') return ok(`nothing to do on the base now: ${p.step.why}`)
      if (p.step.kind === 'ask') return ok(askOwners(ctx.agent, bot, p, p.step.entry))
      entry = p.step.entry
    }
    if (ctx.caller.kind !== 'player') {
      const unsafe = safeToWork({ health: bot.health ?? 20, food: bot.food ?? 20, danger: 0, survival: needsSurvival(bot) }, p.settings)
      if (unsafe) return fail(`not now: ${unsafe}`)
    }
    return workOn(ctx, p, entry, mins)
  }
})

/**
 * The base's own blocks (walls, floor, towers, the rows), which the pathfinder only digs through
 * when there is no other way: a bot leaving its outpost dug a wall block on every trip and rebuilt
 * it the next session. Not forbidden outright: mineflayer-pathfinder can't walk through a door, so
 * with the gate shut a closed base would lock the bot in or out (it stood outside for 7 minutes in
 * a live run); the survey puts back what it dug. Only once the base is settled (settings or
 * remembered when work started).
 */
export const BASE_BREAK_COST = 40
function baseBlockKeys (agent: Agent): Set<string> {
  const out = new Set<string>()
  const s = settingsOf(agent)
  const spots = spotsOf(agent)
  const at = s.base ? { origin: { x: Math.floor(s.base.x), y: Math.floor(s.base.y), z: Math.floor(s.base.z) }, facing: s.base.facing } : spots.anchor
  if (!at) return out
  const bp = blueprintNamed(agent, s.template)
  if (!bp) return out
  for (const c of solidCells(placeCells(rotate(bp, at.facing ?? bp.facing), at.origin))) out.add(key(c))
  const lib = loadLibrary(libraryDirs(agent)).blueprints
  for (const [fit, name] of [[spots.storage, 'storage_row'], [spots.workshop, 'workshop_row']] as const) {
    const rb = fit ? lib.get(name) : undefined
    if (!fit || !rb) continue
    const y = at.origin.y + 1
    for (const c of placeCells(rotate(rb, fit.facing), { x: fit.x, y, z: fit.z })) out.add(key(c))
  }
  return out
}

function guardBase (agent: Agent, bot: Bot): () => void {
  let keys = new Set<string>()
  let at = 0
  const cost = (b: { position: Pos }) => {
    const now = Date.now()
    if (now - at > 30_000) { at = now; try { keys = baseBlockKeys(agent) } catch { keys = new Set() } }
    return keys.has(key(b.position)) ? BASE_BREAK_COST : 0
  }
  let attached: { exclusionAreasBreak: unknown[] } | null = null
  const attach = () => {
    const m = bot.pathfinder?.movements as unknown as { exclusionAreasBreak?: unknown[] } | undefined
    if (!m?.exclusionAreasBreak || m === attached) return
    m.exclusionAreasBreak.push(cost)
    attached = m as { exclusionAreasBreak: unknown[] }
  }
  attach()
  bot.once('spawn', attach)
  const timer = setInterval(attach, 10_000)
  timer.unref?.()
  return () => {
    clearInterval(timer)
    bot.removeListener('spawn', attach)
    if (attached) attached.exclusionAreasBreak = attached.exclusionAreasBreak.filter(f => f !== cost)
  }
}

const checkBaseAction = defineAction({
  name: 'check_base',
  description: 'Check the base for ways in for mobs: caves and holes under the floor, tunnels under the walls, a mine entrance next to the walls, dark spots mobs spawn on. ' +
    'Says what it found and how it would fix each (cap, fill, seal, light). Changes nothing. Answers "pax is the base safe".',
  params: z.object({}),
  exclusive: false,
  run ({ agent, bot }) {
    if (!(bot as Bot)?.entity) return fail('not in the game')
    const c = checkBase(agent, bot as Bot)
    if (typeof c === 'string') return fail(c)
    const head = c.steps.length || c.unfixed.length ? `${c.base.template} at ${fmtPos(c.base.origin)}: ${c.steps.length} fix${c.steps.length === 1 ? '' : 'es'} to make` : `${c.base.template} at ${fmtPos(c.base.origin)}: nothing open to mobs under or by it`
    const lines = [head, ...c.lines, ...c.unfixed.map(u => `can't fix: ${u}`)]
    return ok(lines.join('\n'), { lines, steps: c.steps.length, unfixed: c.unfixed })
  }
})

const secureBaseAction = defineAction({
  name: 'secure_base',
  capabilities: ['move', 'place'],
  description: 'Make the base mob-proof now: cap a mine entrance by the walls, seal holes and tunnels into the base, fill small cavities under it, light what stays open (settings baseSafety). ' +
    'One bounded session; the base project "integrity" does the same between chores.',
  params: z.object({ minutes: z.number().min(1).max(30).default(5).describe('session length') }),
  longRunning: true,
  async run (ctx, { minutes }) {
    const bot = ctx.bot as Bot
    if (!bot?.entity) return fail('not in the game')
    const c = checkBase(ctx.agent, bot)
    if (typeof c === 'string') return fail(c)
    return secureBase(ctx, c, minutes)
  }
})

/** Status lines: what the queue does next, what is stuck and why, what waits for an owner, the base's safety. No world reads. */
function projectStatus (agent: Agent): string[] {
  const plan = lastPlans.get(agent)
  if (!plan || Date.now() - plan.at > 10 * 60_000) return []
  return [
    `next: ${plan.next}`.slice(0, 200),
    ...Object.entries(plan.stuck).map(([n, why]) => `stuck: ${n}: ${why}`.slice(0, 200)),
    ...plan.waiting.map(w => `waits: ${w}`.slice(0, 200)),
    ...(plan.safety && plan.safety[0] !== 'ok' ? plan.safety.map(l => `unsafe: ${l}`.slice(0, 200)) : [])
  ]
}

export const baseProjects = () => defineSkill({
  name: 'base_projects',
  capabilities: ['move', 'place'],
  description: 'Long-term base projects: improving and extending the fortress by itself.',
  actions: [projectsAction, projectAction, planBaseAction, workOnBase, checkBaseAction, secureBaseAction],
  setup (agent, bot) { return guardBase(agent, bot as Bot) },
  status: projectStatus,
  observe (agent) {
    const st = loadState(agent)
    const last = Object.entries(st.progress).sort((a, b) => b[1].lastAt - a[1].lastAt)[0]
    const plan = lastPlans.get(agent)
    const extra = plan && Date.now() - plan.at < 10 * 60_000
      ? { next: plan.next, ...(Object.keys(plan.stuck).length ? { stuck: plan.stuck } : {}), ...(plan.waiting.length ? { waiting: plan.waiting } : {}), ...(plan.safety ? { safety: plan.safety } : {}) }
      : {}
    if (!last && !Object.keys(extra).length) return {}
    return { baseProjects: { ...(last ? { last: last[0], at: new Date(last[1].lastAt).toISOString(), result: last[1].last.slice(0, 120) } : {}), paused: !!st.paused, ...extra } }
  }
})
