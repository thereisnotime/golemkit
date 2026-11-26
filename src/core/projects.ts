// Base projects: a queue of long-term improvements to the bot's base (a stone floor, walls,
// towers, storage...) that it works through by itself when nothing else needs doing. Game-
// agnostic: the game adapter says which projects exist, how much of each is left and does the
// work; this file holds the settings (profile key `projects:`, live toggles projects.*), the
// owner's decisions (approve, veto, skip, reorder, pause) and the pure queue logic: which project
// is next, which ones wait for an owner's ok, when to ask and what an unanswered ask turns into.
// See docs/guide/base-projects.md.
import { z } from 'zod'

/** auto: build the queue, asking only for big projects; ask: propose every project and wait for an ok; off: plan only. */
export const PROJECT_POLICIES = ['auto', 'ask', 'off'] as const
export type ProjectPolicy = typeof PROJECT_POLICIES[number]
/** What an ask nobody answered turns into after askTimeoutMinutes: keep waiting (ask again later), go ahead, or skip it. */
export const TIMEOUT_POLICIES = ['wait', 'build', 'skip'] as const
export type TimeoutPolicy = typeof TIMEOUT_POLICIES[number]

const name = z.string().regex(/^[a-z0-9_]+$/, 'lowercase letters, digits and _')

export const ProjectsSettingsSchema = z.object({
  enabled: z.boolean().optional().describe('work on base projects when nothing else needs doing (default on when the bot has the projects skill)'),
  policy: z.enum(PROJECT_POLICIES).optional().describe('auto: build the queue, asking first for projects bigger than askAbove | ask: propose every project and wait for an owner\'s ok | off: only plan (default auto)'),
  askAbove: z.number().int().min(0).max(100_000).optional().describe('auto policy: projects with more blocks than this to place are proposed first (default 150; 0 = ask for every building project)'),
  askTimeoutMinutes: z.number().min(1).max(10_080).optional().describe('how long to wait for an answer to a proposal (default 30)'),
  onTimeout: z.enum(TIMEOUT_POLICIES).optional().describe('no answer in time: wait (ask again after reaskHours) | build | skip (default wait)'),
  reaskHours: z.number().min(0.1).max(720).optional().describe('ask again about an unanswered proposal after this many hours (default 6)'),
  paused: z.boolean().optional().describe('stop working on projects for now (owners: "pax pause building"); planning still works'),
  sessionMinutes: z.number().min(1).max(60).optional().describe('one work session (gather and build) lasts at most this long, then other chores get a turn (default 10)'),
  gatherMinutes: z.number().min(1).max(30).optional().describe('time a session may spend gathering materials (default 6)'),
  carry: z.number().int().min(16).max(1024).optional().describe('blocks to gather for one session at most (default 192: the rest waits for the next session)'),
  minHealth: z.number().min(1).max(20).optional().describe('work only with at least this much health (default 14)'),
  minFood: z.number().min(0).max(20).optional().describe('work only with at least this much food (default 12)'),
  night: z.boolean().optional().describe('also work at night on projects inside finished, lit walls (default on)'),
  template: z.string().optional().describe('blueprint of the base whose stages are projects (default fortress); its meta.stages says the stages'),
  base: z.object({
    x: z.number(), y: z.number(), z: z.number(),
    facing: z.enum(['north', 'east', 'south', 'west']).optional().describe('the gate side')
  }).strict().optional().describe('where the base is: the origin of the template (layer 0, centre); default found from what it built, then near home'),
  order: z.array(name).optional().describe('preferred order of projects (the rest follow in the default order)'),
  skip: z.array(name).optional().describe('projects never to do')
}).strict()

export interface ProjectsSettings {
  enabled: boolean
  policy: ProjectPolicy
  askAbove: number
  askTimeoutMinutes: number
  onTimeout: TimeoutPolicy
  reaskHours: number
  paused: boolean
  sessionMinutes: number
  gatherMinutes: number
  carry: number
  minHealth: number
  minFood: number
  night: boolean
  template: string
  base: { x: number, y: number, z: number, facing?: 'north' | 'east' | 'south' | 'west' } | null
  order: string[]
  skip: string[]
}

export const PROJECTS_DEFAULTS: Omit<ProjectsSettings, 'base' | 'order' | 'skip'> = {
  enabled: true, policy: 'auto', askAbove: 150, askTimeoutMinutes: 30, onTimeout: 'wait', reaskHours: 6, paused: false,
  sessionMinutes: 10, gatherMinutes: 6, carry: 192, minHealth: 14, minFood: 12, night: true, template: 'fortress'
}

const obj = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
const num = (v: unknown, d: number, min = -Infinity, max = Infinity): number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : d
const bool = (v: unknown, d: boolean): boolean => typeof v === 'boolean' ? v : d
const names = (v: unknown): string[] => Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []

/** settings.projects with defaults; wrong types fall back to the default (the profile schema reports them). `false` = off. */
export function projectsSettings (raw: unknown): ProjectsSettings {
  const o = raw === false ? { enabled: false } : obj(raw)
  const d = PROJECTS_DEFAULTS
  const b = obj(o.base)
  const base = typeof b.x === 'number' && typeof b.y === 'number' && typeof b.z === 'number'
    ? { x: b.x, y: b.y, z: b.z, ...(['north', 'east', 'south', 'west'].includes(b.facing as string) ? { facing: b.facing as 'north' } : {}) }
    : null
  return {
    enabled: bool(o.enabled, d.enabled),
    policy: (PROJECT_POLICIES as readonly string[]).includes(o.policy as string) ? o.policy as ProjectPolicy : d.policy,
    askAbove: num(o.askAbove, d.askAbove, 0, 100_000),
    askTimeoutMinutes: num(o.askTimeoutMinutes, d.askTimeoutMinutes, 1, 10_080),
    onTimeout: (TIMEOUT_POLICIES as readonly string[]).includes(o.onTimeout as string) ? o.onTimeout as TimeoutPolicy : d.onTimeout,
    reaskHours: num(o.reaskHours, d.reaskHours, 0.1, 720),
    paused: bool(o.paused, d.paused),
    sessionMinutes: num(o.sessionMinutes, d.sessionMinutes, 1, 60),
    gatherMinutes: num(o.gatherMinutes, d.gatherMinutes, 1, 30),
    carry: num(o.carry, d.carry, 16, 1024),
    minHealth: num(o.minHealth, d.minHealth, 1, 20),
    minFood: num(o.minFood, d.minFood, 0, 20),
    night: bool(o.night, d.night),
    template: typeof o.template === 'string' && o.template ? o.template : d.template,
    base,
    order: names(o.order),
    skip: names(o.skip)
  }
}

// ------------------------------------------------------------------ projects and owner decisions

/** One project as the adapter surveyed it just now. */
export interface ProjectInfo {
  name: string
  /** A few words ("stone floor"). */
  title: string
  /** Units of work left (blocks to place, spots to light); 0 = done. */
  left: number
  total: number
  /** Nothing it may do about what is left (every spot is someone else's block, no room): why. */
  blocked?: string
  /** Projects to finish first. */
  after?: string[]
  /** Inside finished, lit walls: fine at night. */
  indoors?: boolean
  /** Asked for already (an owner's goal, say): who. Counts as an ok. */
  requestedBy?: string
  /** Never needs an ok, whatever its size (bookkeeping such as reserving a plot). */
  small?: boolean
}

export type Decision = 'approved' | 'vetoed' | 'skipped'

export interface ProjectProgress {
  sessions: number
  lastAt: number
  /** What the last session said. */
  last: string
  /** Sessions in a row that got nothing done. */
  fails: number
  /** When it was found done. */
  doneAt?: number
}

/** What owners said and what happened, in agent storage (projects.state). */
export interface ProjectState {
  decisions: Record<string, { decision: Decision, by: string, at: number }>
  /** Owner's order: these first, in this order ("build towers next" puts towers at the front). */
  order: string[]
  /** When the owners were last asked about each project. */
  asked: Record<string, number>
  progress: Record<string, ProjectProgress>
  /** Paused by an owner (chat), on top of settings.projects.paused. */
  paused: { by: string, at: number } | null
}

export const emptyProjectState = (): ProjectState => ({ decisions: {}, order: [], asked: {}, progress: {}, paused: null })

/** Fills in missing fields of a stored state (older or hand-edited files). */
export function normalizeState (raw: unknown): ProjectState {
  const o = obj(raw)
  return {
    decisions: obj(o.decisions) as ProjectState['decisions'],
    order: names(o.order),
    asked: obj(o.asked) as ProjectState['asked'],
    progress: obj(o.progress) as ProjectState['progress'],
    paused: o.paused && typeof o.paused === 'object' ? o.paused as ProjectState['paused'] : null
  }
}

export type QueueStatus = 'done' | 'vetoed' | 'skipped' | 'blocked' | 'waiting' | 'needs_ok' | 'asked' | 'ready' | 'planned'

export interface QueueEntry {
  info: ProjectInfo
  status: QueueStatus
  /** Why it has this status, for chat. */
  why: string
  /** Needs an ok under the current policy (before decisions). */
  big: boolean
}

/** Projects in working order: the owner's order, then settings.order, then the adapter's order. Pure. */
export function orderProjects (infos: readonly ProjectInfo[], state: ProjectState, s: Pick<ProjectsSettings, 'order'>): ProjectInfo[] {
  const rank = (n: string) => {
    const a = state.order.indexOf(n)
    if (a >= 0) return a
    const b = s.order.indexOf(n)
    if (b >= 0) return 1000 + b
    return 2000 + infos.findIndex(i => i.name === n)
  }
  return [...infos].sort((a, b) => rank(a.name) - rank(b.name))
}

/** Does this project need an owner's ok under the policy? Pure. */
export function needsOk (info: ProjectInfo, s: Pick<ProjectsSettings, 'policy' | 'askAbove'>): boolean {
  if (info.small) return false
  if (s.policy === 'ask') return true
  return info.left > s.askAbove
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

/**
 * Each project's status now. Pure. Done, vetoed, skipped (settings.skip, an owner, or an
 * unanswered ask with onTimeout skip) and blocked come first; then a project waits for the
 * ones it comes after; a big one (needsOk) without an ok is needs_ok, or asked while the
 * answer is due; an unanswered ask past askTimeoutMinutes goes ahead with onTimeout build.
 * With policy off everything open is only planned.
 */
export function projectQueue (infos: readonly ProjectInfo[], state: ProjectState, s: ProjectsSettings, now: number): QueueEntry[] {
  const ordered = orderProjects(infos, state, s)
  const out: QueueEntry[] = []
  // a predecessor holds a project back while it still has work it may do
  const open = (n: string) => {
    const i = infos.find(x => x.name === n)
    const d = state.decisions[n]?.decision
    return !!i && i.left > 0 && !i.blocked && !s.skip.includes(n) && d !== 'vetoed' && d !== 'skipped'
  }
  for (const info of ordered) {
    const big = needsOk(info, s)
    const d = state.decisions[info.name]
    const entry = (status: QueueStatus, why: string): QueueEntry => ({ info, status, why, big })
    if (info.left <= 0) { out.push(entry('done', 'done')); continue }
    if (s.skip.includes(info.name)) { out.push(entry('skipped', 'skipped in the settings')); continue }
    if (d?.decision === 'vetoed') { out.push(entry('vetoed', `vetoed by ${d.by}`)); continue }
    if (d?.decision === 'skipped') { out.push(entry('skipped', `skipped by ${d.by}`)); continue }
    if (info.blocked) { out.push(entry('blocked', info.blocked)); continue }
    const before = (info.after ?? []).filter(open)
    if (before.length) { out.push(entry('waiting', `after ${before.join(', ')}`)); continue }
    if (s.policy === 'off') { out.push(entry('planned', 'policy off: planning only')); continue }
    const ok = d?.decision === 'approved' ? `ok from ${d.by}` : info.requestedBy ? `asked for by ${info.requestedBy}` : null
    if (!big || ok) { out.push(entry('ready', ok ?? `small (${plural(info.left, 'block')})`)); continue }
    const asked = state.asked[info.name]
    if (asked !== undefined) {
      const waited = now - asked
      if (waited < s.askTimeoutMinutes * 60_000) { out.push(entry('asked', `asked ${Math.max(1, Math.round(waited / 60_000))} min ago, waiting for an ok`)); continue }
      if (s.onTimeout === 'build') { out.push(entry('ready', `no answer in ${s.askTimeoutMinutes} min: going ahead`)); continue }
      if (s.onTimeout === 'skip') { out.push(entry('skipped', `no answer in ${s.askTimeoutMinutes} min: skipped`)); continue }
    }
    out.push(entry('needs_ok', `${plural(info.left, 'block')}: needs an owner's ok`))
  }
  return out
}

export interface StepContext {
  now: number
  /** An owner is online to ask. */
  ownerOnline: boolean
  /** Night (or dark) in the game. */
  night: boolean
}

export type NextStep =
  | { kind: 'work', entry: QueueEntry }
  | { kind: 'ask', entry: QueueEntry }
  | { kind: 'none', why: string }

/**
 * What to do now. Pure. Nothing while paused or off. An ask that is due (an owner online, not
 * asked yet or asked longer than reaskHours ago with onTimeout wait) goes first, it takes a
 * moment; then the first ready project, at night only one indoors (settings.night).
 */
export function nextStep (queue: readonly QueueEntry[], state: ProjectState, s: ProjectsSettings, c: StepContext): NextStep {
  if (!s.enabled) return { kind: 'none', why: 'base projects are off' }
  if (s.paused) return { kind: 'none', why: 'paused in the settings' }
  if (state.paused) return { kind: 'none', why: `paused by ${state.paused.by}` }
  if (s.policy === 'off') return { kind: 'none', why: 'policy off: planning only' }
  if (c.ownerOnline) {
    const ask = queue.find(e => e.status === 'needs_ok' && (state.asked[e.info.name] === undefined || c.now - state.asked[e.info.name]! >= s.reaskHours * 3_600_000))
    if (ask) return { kind: 'ask', entry: ask }
  }
  const ready = queue.filter(e => e.status === 'ready')
  const work = ready.find(e => !c.night || (s.night && e.info.indoors))
  if (work) return { kind: 'work', entry: work }
  if (ready.length) return { kind: 'none', why: `night: ${ready[0]!.info.name} waits for the day` }
  const open = queue.filter(e => e.status === 'needs_ok' || e.status === 'asked')
  if (open.length) return { kind: 'none', why: `${open.map(e => e.info.name).join(', ')} wait${open.length === 1 ? 's' : ''} for an owner's ok` }
  const waiting = queue.find(e => e.status === 'waiting')
  if (waiting) return { kind: 'none', why: `${waiting.info.name} waits (${waiting.why})` }
  return { kind: 'none', why: 'nothing left to build' }
}

export const PROJECT_OPS = ['approve', 'veto', 'skip', 'unskip', 'next', 'pause', 'resume', 'reset'] as const
export type ProjectOp = typeof PROJECT_OPS[number]

/**
 * An owner's command on the queue. Pure: returns the new state and what to say. approve (ok to
 * build), veto (never), skip (not now, unskip undoes it), next (to the front of the order, and
 * an ok), pause / resume (all of them), reset (forget the decisions about one, or all).
 */
export function applyOp (state: ProjectState, op: ProjectOp, project: string | undefined, by: string, now: number, known: readonly string[]): { state: ProjectState, message: string, ok: boolean } {
  const s: ProjectState = { decisions: { ...state.decisions }, order: [...state.order], asked: { ...state.asked }, progress: { ...state.progress }, paused: state.paused }
  if (op === 'pause') { s.paused = { by, at: now }; return { state: s, message: 'paused the base projects', ok: true } }
  if (op === 'resume') { s.paused = null; return { state: s, message: 'back on the base projects', ok: true } }
  if (op === 'reset' && !project) { return { state: { ...emptyProjectState(), progress: s.progress }, message: 'forgot every decision about the base projects', ok: true } }
  if (!project) return { state, message: `which project? (${known.join(', ')})`, ok: false }
  if (!known.includes(project)) return { state, message: `no project ${project}; there are ${known.join(', ')}`, ok: false }
  switch (op) {
    case 'approve':
      s.decisions[project] = { decision: 'approved', by, at: now }
      return { state: s, message: `ok, ${project} is on`, ok: true }
    case 'veto':
      s.decisions[project] = { decision: 'vetoed', by, at: now }
      s.order = s.order.filter(n => n !== project)
      return { state: s, message: `won't build ${project}`, ok: true }
    case 'skip':
      s.decisions[project] = { decision: 'skipped', by, at: now }
      s.order = s.order.filter(n => n !== project)
      return { state: s, message: `skipping ${project}`, ok: true }
    case 'unskip':
    case 'reset':
      delete s.decisions[project]
      delete s.asked[project]
      return { state: s, message: op === 'unskip' ? `${project} is back in the queue` : `forgot what was said about ${project}`, ok: true }
    case 'next':
      s.order = [project, ...s.order.filter(n => n !== project)]
      s.decisions[project] = { decision: 'approved', by, at: now }
      return { state: s, message: `${project} next`, ok: true }
  }
  return { state, message: `unknown op ${op}`, ok: false }
}

/** Records how a work session went. Pure. */
export function noteSession (state: ProjectState, project: string, o: { now: number, message: string, progressed: boolean, done: boolean }): ProjectState {
  const prev = state.progress[project] ?? { sessions: 0, lastAt: 0, last: '', fails: 0 }
  const next: ProjectProgress = { sessions: prev.sessions + 1, lastAt: o.now, last: o.message.slice(0, 200), fails: o.progressed ? 0 : prev.fails + 1 }
  if (o.done) next.doneAt = o.now
  return { ...state, progress: { ...state.progress, [project]: next } }
}

/** Sessions in a row without progress before a project is put aside for a while. */
export const MAX_FAILS = 3
/** How long a project that keeps failing is put aside. */
export const FAIL_BACKOFF_MS = 2 * 3_600_000

/** A project that failed MAX_FAILS sessions in a row rests for FAIL_BACKOFF_MS (then one more try). Pure. */
export function restingReason (p: ProjectProgress | undefined, now: number): string | null {
  if (!p || p.fails < MAX_FAILS) return null
  const left = FAIL_BACKOFF_MS - (now - p.lastAt)
  return left > 0 ? `${p.fails} sessions without progress (${p.last.slice(0, 80)}); trying again in ${Math.ceil(left / 60_000)} min` : null
}

/** One line per project for chat, in working order. Pure. */
export function fmtQueue (queue: readonly QueueEntry[]): string[] {
  return queue.map((e, i) => {
    const left = e.status === 'done' ? '' : e.info.total ? ` ${e.info.total - e.info.left}/${e.info.total}` : ''
    return `${i + 1}. ${e.info.name} (${e.info.title})${left}: ${e.status.replace('_', ' ')}${e.why && e.why !== e.status ? `, ${e.why}` : ''}`
  })
}

/**
 * Which projects a goal text asks for (an owner's LLM goal "upgrade the fortress: stone floor,
 * corner towers, walkway and gate torches"). `words` maps a project to the words that name it.
 * Pure.
 */
export function goalMentions (text: string, words: Record<string, readonly string[]>): string[] {
  const t = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `
  return Object.entries(words).filter(([, ws]) => ws.some(w => t.includes(` ${w} `))).map(([n]) => n)
}
