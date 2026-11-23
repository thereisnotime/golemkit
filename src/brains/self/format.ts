// The self-improver's program format: a small declarative behaviour language. A program is
// plain JSON data (rules, routines, triggers, variables), parsed and validated here, and
// executed by interpreter.ts. Nothing in it is ever evaluated as code: steps can only call
// registered actions (checked against the live catalog, params against the action's zod
// schema), chat through the rate-limited agent queue, wait, branch and loop with hard caps.
//
// Like the scene format, steps and conditions are objects with exactly one kind key
// ({ say: "hi" }, { all: [...] }), parsed recursively so errors carry a path such as
// `routines.patrol[2].if.then[0].act`.
import { z } from 'zod'
import type { ActionDef } from '../../core/index.ts'

export const FORMAT_VERSION = 1

/** Hard caps. A program can't raise them; the gate rejects anything beyond. */
export const LIMITS = {
  rules: 24,
  routines: 32,
  triggers: 24,
  vars: 32,
  /** Steps in one routine or inline step list, nested steps included. */
  stepsPerList: 120,
  /** Steps across the whole program. */
  stepsTotal: 600,
  /** Nesting depth of if/repeat/while. */
  depth: 6,
  repeatTimes: 20,
  whileMax: 100,
  waitMs: 60_000,
  /** Call depth through `run`. Cycles are rejected outright. */
  callDepth: 4,
  textChars: 200,
  intervalMinMs: 10_000,
  /** Steps executed per routine run before it is cut off. */
  execSteps: 2000,
  /** Wall-clock (or simulated) time per routine run before it is cut off. */
  execMs: 5 * 60_000
} as const

// ------------------------------------------------------------------ types

export type Scalar = number | string | boolean

export type Cond =
  | { all: Cond[] }
  | { any: Cond[] }
  | { not: Cond }
  | { fact: string, eq?: Scalar, ne?: Scalar, lt?: number, lte?: number, gt?: number, gte?: number }
  | { chance: number }
  | { time: TimeWindow }
  | { playerNear: number }
  | { hostileNear: number }
  | { has: { item: string, count?: number } }
  | { elapsed: { timer: string, ms: number } }

export type TimeWindow = TimeName | [number, number]

export type Step =
  | { act: string, params?: Record<string, unknown> }
  | { say: string | string[] }
  | { whisper: string | string[], to?: string }
  | { wait: number }
  | { if: Cond, then: Step[], else?: Step[] }
  | { repeat: { times: number, steps: Step[] } }
  | { while: { cond: Cond, max: number, steps: Step[] } }
  | { set: string, value?: Scalar, add?: number }
  | { goto_place: string, range?: number }
  | { run: string }
  | { timer: string }
  | { fail: string }

export interface Rule {
  name: string
  description?: string
  /** Utility score 1..100 while `when` holds (NPC brain bands: idle 5-15, social 15-25, chores 25-45, routine 40-70, needs 50-90). */
  score: number
  when?: Cond
  /** A routine name or inline steps. */
  do: string | Step[]
  cooldownMs?: number
  failureCooldownMs?: number
}

export type TriggerOn = 'interval' | 'time' | 'chat' | 'hurt' | 'death' | 'playerJoined' | 'spawn'

export interface Trigger {
  name: string
  on: TriggerOn
  description?: string
  /** interval: period in ms. */
  everyMs?: number
  /** time: fires once each time the day enters this window. */
  at?: TimeWindow
  /** chat: case-insensitive words/phrases; any one matching fires the trigger. */
  match?: string[]
  /** chat: only when the speaker is within this many blocks. */
  near?: number
  /** chat: only messages from owners. Default false. */
  ownersOnly?: boolean
  /** Extra condition checked when it fires. */
  when?: Cond
  do: string | Step[]
  /** Minimum gap between firings (per player for chat/playerJoined). Default 30 s for chat, 0 otherwise. */
  cooldownMs?: number
  /** Score the trigger competes with in the NPC brain. Default 60. */
  priority?: number
}

export interface Program {
  version: typeof FORMAT_VERSION
  name: string
  description?: string
  vars: Record<string, Scalar>
  rules: Rule[]
  routines: Record<string, Step[]>
  triggers: Trigger[]
}

// ------------------------------------------------------------------ facts

export const TIME_WINDOWS = {
  day: [23460, 12541],
  night: [12542, 23459],
  dawn: [22500, 1000],
  morning: [0, 6000],
  noon: [5500, 6500],
  afternoon: [6000, 12000],
  dusk: [11500, 13500]
} as const
export type TimeName = keyof typeof TIME_WINDOWS
const TIME_NAMES = Object.keys(TIME_WINDOWS) as [TimeName, ...TimeName[]]

/** Facts a condition can read. `<x>` parts are free names. */
export const FACTS: Record<string, string> = {
  health: 'health points 0..20',
  food: 'food points 0..20',
  timeOfDay: 'game time 0..23999 (0 sunrise, 6000 noon, 12000 sunset, 18000 midnight)',
  isNight: 'true at night (beds work) or in a thunderstorm',
  isDay: 'not isNight',
  sleeping: 'true while in bed',
  busy: 'true while anyone (player, LLM, reflex) holds the body',
  homeDistance: 'blocks to home, -1 when unknown',
  playersNearby: 'players within 16 blocks',
  hostilesNearby: 'hostile mobs within 16 blocks',
  'nearestPlayer.name': 'name of the nearest player within 16 blocks, "" if none',
  'nearestPlayer.distance': 'blocks to that player, -1 if none',
  'nearestHostile.name': 'nearest hostile mob name, "" if none',
  'nearestHostile.distance': 'blocks to it, -1 if none',
  'need.<name>': 'NPC blackboard need 0..1 (hunger, health, danger, inventoryFull, tiredness)',
  'inventory.<item>': 'how many of that item the bot carries',
  'place.<name>': 'blocks to a remembered place, -1 when unknown',
  'var.<name>': 'a program variable',
  'timer.<name>': 'ms since `timer` step last reset it, -1 if never'
}

const FACT_RE = /^(health|food|timeOfDay|isNight|isDay|sleeping|busy|homeDistance|playersNearby|hostilesNearby|nearestPlayer\.(name|distance)|nearestHostile\.(name|distance)|(need|inventory|place|var|timer)\.[A-Za-z0-9_:#.-]{1,48})$/

const IDENT = /^[a-z][a-z0-9_]{0,39}$/i

// ------------------------------------------------------------------ action policy

/** What a program may call. Built from the bot's live action registry. */
export interface ActionCatalog {
  get (name: string): ActionDef | undefined
  /** Null when allowed, otherwise why not. */
  denied (name: string): string | null
  /** Allowed actions, for the spec shown to the LLM. */
  allowed (): ActionDef[]
}

/**
 * Actions a program may never call by default: fighting (a target id could be a player),
 * breaking/placing blocks, dropping items, stopping other callers, and anything that
 * changes the program itself. Internal actions (npc_interrupt and the like) are refused by
 * their `internal` flag. Long-running actions are refused too (they never end on
 * their own, so a routine would hang).
 */
export const DEFAULT_DENY = [
  'attack', 'guard', 'defend', 'chop_tree', 'till', 'place_block', 'drop', 'stop', 'say',
  'craft', 'smelt', 'deposit', 'withdraw', 'llm_usage', 'npc_status', 'hunt', 'pillar'
]

export interface CatalogPolicy {
  /** If set, only these actions (minus deny) are allowed. */
  allow?: string[]
  /** Replaces DEFAULT_DENY. Actions starting with `program_` are always denied. */
  deny?: string[]
}

export function makeCatalog (defs: ActionDef<any>[], policy: CatalogPolicy = {}): ActionCatalog {
  const byName = new Map<string, ActionDef>()
  for (const d of defs) {
    byName.set(d.name, d)
    for (const a of d.aliases ?? []) if (!byName.has(a)) byName.set(a, d)
  }
  const deny = new Set(policy.deny ?? DEFAULT_DENY)
  const allow = policy.allow ? new Set(policy.allow) : null
  const denied = (name: string): string | null => {
    const d = byName.get(name)
    if (!d) return `unknown action "${name}"`
    if (d.name.startsWith('program_')) return `"${d.name}" changes the program and can't be called from it`
    if (d.internal) return `"${d.name}" is internal`
    if (deny.has(d.name)) return `"${d.name}" is not allowed for programs`
    if (allow && !allow.has(d.name)) return `"${d.name}" is not in this bot's allowed list`
    if (d.longRunning) return `"${d.name}" is long-running and would never finish; use bounded actions`
    return null
  }
  return {
    get: (name) => byName.get(name),
    denied,
    allowed: () => [...new Set(byName.values())].filter(d => !denied(d.name))
  }
}

// ------------------------------------------------------------------ schemas

const text = z.string().min(1).max(LIMITS.textChars)
const texts = z.union([text, z.array(text).min(1).max(10)])
const ident = z.string().regex(IDENT, 'letters, digits and _ only, starting with a letter, max 40')
const scalar = z.union([z.number(), z.string().max(LIMITS.textChars), z.boolean()])
const timeWindow = z.union([z.enum(TIME_NAMES), z.tuple([z.number().int().min(0).max(23999), z.number().int().min(0).max(23999)])])
const radius = z.number().positive().max(64)
const routineRef = z.union([ident, z.array(z.unknown())])

export const CONDITION_KINDS = ['all', 'any', 'not', 'fact', 'chance', 'time', 'playerNear', 'hostileNear', 'has', 'elapsed'] as const
type CondKind = typeof CONDITION_KINDS[number]

export const condSchemas: Record<CondKind, z.ZodObject> = {
  all: z.strictObject({ all: z.array(z.unknown()).min(1).max(12) }),
  any: z.strictObject({ any: z.array(z.unknown()).min(1).max(12) }),
  not: z.strictObject({ not: z.unknown() }),
  fact: z.strictObject({
    fact: z.string().regex(FACT_RE, 'unknown fact (see the fact list)'),
    eq: scalar.optional(),
    ne: scalar.optional(),
    lt: z.number().optional(),
    lte: z.number().optional(),
    gt: z.number().optional(),
    gte: z.number().optional()
  }).refine(c => ['eq', 'ne', 'lt', 'lte', 'gt', 'gte'].some(k => k in c), 'needs a comparison: eq, ne, lt, lte, gt or gte'),
  chance: z.strictObject({ chance: z.number().min(0).max(1) }),
  time: z.strictObject({ time: timeWindow }),
  playerNear: z.strictObject({ playerNear: radius }),
  hostileNear: z.strictObject({ hostileNear: radius }),
  has: z.strictObject({ has: z.strictObject({ item: z.string().min(1).max(64), count: z.number().int().positive().optional() }) }),
  elapsed: z.strictObject({ elapsed: z.strictObject({ timer: ident, ms: z.number().int().nonnegative() }) })
} as any

export const STEP_KINDS = ['act', 'say', 'whisper', 'wait', 'if', 'repeat', 'while', 'set', 'goto_place', 'run', 'timer', 'fail'] as const
type StepKind = typeof STEP_KINDS[number]

export const stepSchemas: Record<StepKind, z.ZodObject> = {
  act: z.strictObject({ act: z.string().min(1), params: z.record(z.string(), z.unknown()).optional() }),
  say: z.strictObject({ say: texts }),
  whisper: z.strictObject({ whisper: texts, to: z.string().min(1).max(40).optional() }),
  wait: z.strictObject({ wait: z.number().int().min(0).max(LIMITS.waitMs) }),
  if: z.strictObject({ if: z.unknown(), then: z.array(z.unknown()), else: z.array(z.unknown()).optional() }),
  repeat: z.strictObject({ repeat: z.strictObject({ times: z.number().int().min(1).max(LIMITS.repeatTimes), steps: z.array(z.unknown()).min(1) }) }),
  while: z.strictObject({
    while: z.strictObject({
      cond: z.unknown(),
      max: z.number({ error: 'while needs "max": a hard iteration cap' }).int().min(1).max(LIMITS.whileMax),
      steps: z.array(z.unknown()).min(1)
    })
  }),
  set: z.strictObject({ set: ident, value: scalar.optional(), add: z.number().optional() })
    .refine(s => ('value' in s) !== ('add' in s), 'set needs exactly one of value or add'),
  goto_place: z.strictObject({ goto_place: z.string().min(1).max(40), range: z.number().positive().max(16).optional() }),
  run: z.strictObject({ run: ident }),
  timer: z.strictObject({ timer: ident }),
  fail: z.strictObject({ fail: text })
} as any

const RuleSchema = z.strictObject({
  name: ident,
  description: z.string().max(LIMITS.textChars).optional(),
  score: z.number().min(1).max(100),
  when: z.unknown().optional(),
  do: routineRef,
  cooldownMs: z.number().int().nonnegative().max(24 * 3_600_000).optional(),
  failureCooldownMs: z.number().int().min(1000).max(3_600_000).optional()
})

export const TRIGGER_ON = ['interval', 'time', 'chat', 'hurt', 'death', 'playerJoined', 'spawn'] as const

const TriggerSchema = z.strictObject({
  name: ident,
  on: z.enum(TRIGGER_ON),
  description: z.string().max(LIMITS.textChars).optional(),
  everyMs: z.number().int().min(LIMITS.intervalMinMs).max(24 * 3_600_000).optional(),
  at: timeWindow.optional(),
  match: z.array(z.string().min(1).max(40)).min(1).max(12).optional(),
  near: radius.optional(),
  ownersOnly: z.boolean().optional(),
  when: z.unknown().optional(),
  do: routineRef,
  cooldownMs: z.number().int().nonnegative().max(24 * 3_600_000).optional(),
  priority: z.number().min(1).max(100).optional()
}).superRefine((t, ctx) => {
  if (t.on === 'interval' && t.everyMs === undefined) ctx.addIssue({ code: 'custom', path: ['everyMs'], message: 'interval triggers need everyMs' })
  if (t.on === 'time' && t.at === undefined) ctx.addIssue({ code: 'custom', path: ['at'], message: 'time triggers need at' })
  if (t.on === 'chat' && !t.match) ctx.addIssue({ code: 'custom', path: ['match'], message: 'chat triggers need match' })
})

export const ProgramSchema = z.strictObject({
  version: z.literal(FORMAT_VERSION),
  name: z.string().min(1).max(60),
  description: z.string().max(400).optional(),
  vars: z.record(ident, scalar).default({}),
  rules: z.array(RuleSchema).max(LIMITS.rules).default([]),
  routines: z.record(ident, z.array(z.unknown()).min(1)).default({}),
  triggers: z.array(TriggerSchema).max(LIMITS.triggers).default([])
})

/** What callers hand in (before defaults). */
export type ProgramInput = z.input<typeof ProgramSchema>

// ------------------------------------------------------------------ parsing

export class ProgramError extends Error {
  readonly issues: string[]
  constructor (issues: string[]) {
    super(`invalid program: ${issues.slice(0, 5).join('; ')}${issues.length > 5 ? ` (+${issues.length - 5} more)` : ''}`)
    this.name = 'ProgramError'
    this.issues = issues
  }
}

function zodIssues (err: z.ZodError, prefix: string): string[] {
  return err.issues.map(i => {
    const p = i.path.map(k => typeof k === 'number' ? `[${k}]` : `.${String(k)}`).join('')
    return `${prefix}${p}: ${i.message}`.replace(/^\./, '')
  })
}

interface ParseCtx {
  issues: string[]
  catalog: ActionCatalog
}

function oneKind<K extends string> (raw: unknown, kinds: readonly K[], what: string, path: string, issues: string[]): K | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    issues.push(`${path}: a ${what} must be an object with one of: ${kinds.join(', ')}`)
    return undefined
  }
  const found = kinds.filter(k => k in raw)
  if (found.length !== 1) {
    issues.push(`${path}: ${found.length ? `has several ${what} kinds (${found.join(', ')})` : `no ${what} kind (one of ${kinds.join(', ')})`}`)
    return undefined
  }
  return found[0]
}

export function parseCond (raw: unknown, path: string, issues: string[]): Cond | undefined {
  const kind = oneKind(raw, CONDITION_KINDS, 'condition', path, issues)
  if (!kind) return undefined
  const r = condSchemas[kind].safeParse(raw)
  if (!r.success) { issues.push(...zodIssues(r.error, path)); return undefined }
  const d = r.data as any
  if (kind === 'all' || kind === 'any') {
    const list = (d[kind] as unknown[]).map((c, i) => parseCond(c, `${path}.${kind}[${i}]`, issues))
    return list.every(Boolean) ? { [kind]: list } as Cond : undefined
  }
  if (kind === 'not') {
    const inner = parseCond(d.not, `${path}.not`, issues)
    return inner ? { not: inner } : undefined
  }
  return d as Cond
}

function parseSteps (raw: unknown[], path: string, ctx: ParseCtx): Step[] {
  const out: Step[] = []
  raw.forEach((s, i) => {
    const step = parseStep(s, `${path}[${i}]`, ctx)
    if (step) out.push(step)
  })
  return out
}

const TEMPLATE = /\{(player|bot|var\.[A-Za-z0-9_]+)\}/g

function parseStep (raw: unknown, path: string, ctx: ParseCtx): Step | undefined {
  const kind = oneKind(raw, STEP_KINDS, 'step', path, ctx.issues)
  if (!kind) return undefined
  const r = stepSchemas[kind].safeParse(raw)
  if (!r.success) { ctx.issues.push(...zodIssues(r.error, path)); return undefined }
  const d = r.data as any
  switch (kind) {
    case 'act': {
      const why = ctx.catalog.denied(d.act)
      if (why) { ctx.issues.push(`${path}.act: ${why}`); return undefined }
      const def = ctx.catalog.get(d.act)!
      d.act = def.name
      // Templates ({player}) stay strings here; they validate wherever the action takes a string.
      const known = Object.keys(def.params.shape ?? {})
      const extra = Object.keys(d.params ?? {}).filter(k => !known.includes(k))
      if (extra.length) { ctx.issues.push(`${path}.params: ${def.name} has no parameter ${extra.join(', ')} (it takes: ${known.join(', ') || 'nothing'})`); return undefined }
      const p = def.params.safeParse(d.params ?? {})
      if (!p.success) { ctx.issues.push(...zodIssues(p.error, `${path}.params`)); return undefined }
      return d
    }
    case 'if': {
      const cond = parseCond(d.if, `${path}.if`, ctx.issues)
      const then = parseSteps(d.then, `${path}.then`, ctx)
      const els = d.else ? parseSteps(d.else, `${path}.else`, ctx) : undefined
      return cond ? { if: cond, then, ...(els ? { else: els } : {}) } : undefined
    }
    case 'repeat':
      return { repeat: { times: d.repeat.times, steps: parseSteps(d.repeat.steps, `${path}.repeat.steps`, ctx) } }
    case 'while': {
      const cond = parseCond(d.while.cond, `${path}.while.cond`, ctx.issues)
      const steps = parseSteps(d.while.steps, `${path}.while.steps`, ctx)
      return cond ? { while: { cond, max: d.while.max, steps } } : undefined
    }
    case 'goto_place': {
      const why = ctx.catalog.denied('goto_place')
      if (why) { ctx.issues.push(`${path}.goto_place: ${why}`); return undefined }
      return d
    }
    default:
      return d as Step
  }
}

function parseDo (raw: unknown, path: string, ctx: ParseCtx): string | Step[] {
  return typeof raw === 'string' ? raw : parseSteps(raw as unknown[], path, ctx)
}

/** Walks every step list of a program (routines, rule/trigger inline lists). */
export function* stepLists (p: Program): Generator<[string, Step[]]> {
  for (const [name, steps] of Object.entries(p.routines)) yield [`routines.${name}`, steps]
  for (const [i, r] of p.rules.entries()) if (Array.isArray(r.do)) yield [`rules[${i}].do`, r.do]
  for (const [i, t] of p.triggers.entries()) if (Array.isArray(t.do)) yield [`triggers[${i}].do`, t.do]
}

/** Children of a step, for walking. */
export function childLists (s: Step): Step[][] {
  if ('if' in s) return s.else ? [s.then, s.else] : [s.then]
  if ('repeat' in s) return [s.repeat.steps]
  if ('while' in s) return [s.while.steps]
  return []
}

function countSteps (steps: Step[]): number {
  return steps.reduce((n, s) => n + 1 + childLists(s).reduce((m, l) => m + countSteps(l), 0), 0)
}

function depthOf (steps: Step[]): number {
  return steps.reduce((d, s) => Math.max(d, ...childLists(s).map(l => 1 + depthOf(l)), 0), 0)
}

function calls (steps: Step[], out = new Set<string>()): Set<string> {
  for (const s of steps) {
    if ('run' in s) out.add(s.run)
    for (const l of childLists(s)) calls(l, out)
  }
  return out
}

function textsIn (steps: Step[], out: string[] = []): string[] {
  for (const s of steps) {
    if ('say' in s) out.push(...[s.say].flat())
    if ('whisper' in s) out.push(...[s.whisper].flat())
    for (const l of childLists(s)) textsIn(l, out)
  }
  return out
}

/** Static checks over a parsed program: references, sizes, recursion, templates. */
function checkStatic (p: Program, issues: string[]): void {
  if (Object.keys(p.routines).length > LIMITS.routines) issues.push(`routines: at most ${LIMITS.routines}`)
  if (Object.keys(p.vars).length > LIMITS.vars) issues.push(`vars: at most ${LIMITS.vars}`)
  const names = new Set<string>()
  for (const [i, r] of p.rules.entries()) {
    if (names.has(r.name)) issues.push(`rules[${i}].name: duplicate rule "${r.name}"`)
    names.add(r.name)
    if (typeof r.do === 'string' && !p.routines[r.do]) issues.push(`rules[${i}].do: no routine "${r.do}"`)
  }
  const tnames = new Set<string>()
  for (const [i, t] of p.triggers.entries()) {
    if (tnames.has(t.name)) issues.push(`triggers[${i}].name: duplicate trigger "${t.name}"`)
    tnames.add(t.name)
    if (typeof t.do === 'string' && !p.routines[t.do]) issues.push(`triggers[${i}].do: no routine "${t.do}"`)
  }
  let total = 0
  for (const [path, steps] of stepLists(p)) {
    const n = countSteps(steps)
    total += n
    if (n > LIMITS.stepsPerList) issues.push(`${path}: ${n} steps, at most ${LIMITS.stepsPerList}`)
    if (depthOf(steps) > LIMITS.depth) issues.push(`${path}: nested deeper than ${LIMITS.depth}`)
    for (const c of calls(steps)) if (!p.routines[c]) issues.push(`${path}: runs unknown routine "${c}"`)
    for (const t of textsIn(steps)) {
      for (const m of t.matchAll(/\{([^}]*)\}/g)) {
        if (!new RegExp(`^${TEMPLATE.source}$`).test(m[0])) issues.push(`${path}: unknown placeholder ${m[0]} (use {player}, {bot} or {var.<name>})`)
      }
    }
  }
  if (total > LIMITS.stepsTotal) issues.push(`program: ${total} steps, at most ${LIMITS.stepsTotal}`)
  // `run` graph: no cycles, bounded depth.
  const graph = new Map(Object.entries(p.routines).map(([n, s]) => [n, [...calls(s)].filter(c => p.routines[c])]))
  const depth = (n: string, stack: string[]): number => {
    if (stack.includes(n)) { issues.push(`routines.${n}: recursion (${[...stack, n].join(' -> ')})`); return 0 }
    return 1 + Math.max(0, ...(graph.get(n) ?? []).map(c => depth(c, [...stack, n])))
  }
  for (const n of graph.keys()) {
    const d = depth(n, [])
    if (d > LIMITS.callDepth) issues.push(`routines.${n}: calls nest ${d} deep, at most ${LIMITS.callDepth}`)
  }
}

export type ParseResult = { ok: true, program: Program } | { ok: false, issues: string[] }

/** Parses and validates a program against the bot's action catalog. Never throws. */
export function parseProgram (raw: unknown, catalog: ActionCatalog): ParseResult {
  const top = ProgramSchema.safeParse(raw)
  if (!top.success) return { ok: false, issues: zodIssues(top.error, '') }
  const d = top.data
  const ctx: ParseCtx = { issues: [], catalog }
  const routines: Record<string, Step[]> = {}
  for (const [name, steps] of Object.entries(d.routines)) routines[name] = parseSteps(steps, `routines.${name}`, ctx)
  const cond = (c: unknown, path: string) => c === undefined ? undefined : parseCond(c, path, ctx.issues)
  const rules: Rule[] = d.rules.map((r, i) => ({ ...r, when: cond(r.when, `rules[${i}].when`), do: parseDo(r.do, `rules[${i}].do`, ctx) }))
  const triggers: Trigger[] = d.triggers.map((t, i) => ({ ...t, when: cond(t.when, `triggers[${i}].when`), do: parseDo(t.do, `triggers[${i}].do`, ctx) }))
  for (const x of [...rules, ...triggers]) if (x.when === undefined) delete x.when
  const program: Program = { version: FORMAT_VERSION, name: d.name, ...(d.description ? { description: d.description } : {}), vars: d.vars, rules, routines, triggers }
  if (!ctx.issues.length) checkStatic(program, ctx.issues)
  return ctx.issues.length ? { ok: false, issues: ctx.issues } : { ok: true, program }
}

/** parseProgram that throws a ProgramError (for base programs in bot definitions). */
export function mustParse (raw: unknown, catalog: ActionCatalog): Program {
  const r = parseProgram(raw, catalog)
  if (!r.ok) throw new ProgramError(r.issues)
  return r.program
}

/** Fills template placeholders in a string. Unknown values become "". */
export function fillTemplate (s: string, vars: { player?: string, bot?: string, get (name: string): Scalar | undefined }): string {
  return s.replace(TEMPLATE, (_m, key: string) => {
    if (key === 'player') return vars.player ?? ''
    if (key === 'bot') return vars.bot ?? ''
    return String(vars.get(key.slice(4)) ?? '')
  })
}

// ------------------------------------------------------------------ patches

export interface ProgramPatch {
  set?: { name?: string, description?: string, vars?: Record<string, Scalar>, rules?: unknown[], routines?: Record<string, unknown[]>, triggers?: unknown[] }
  remove?: { rules?: string[], routines?: string[], triggers?: string[], vars?: string[] }
}

export const PatchSchema = z.strictObject({
  set: z.strictObject({
    name: z.string().optional(),
    description: z.string().optional(),
    vars: z.record(z.string(), scalar).optional(),
    rules: z.array(z.unknown()).optional(),
    routines: z.record(z.string(), z.array(z.unknown())).optional(),
    triggers: z.array(z.unknown()).optional()
  }).optional(),
  remove: z.strictObject({
    rules: z.array(z.string()).optional(),
    routines: z.array(z.string()).optional(),
    triggers: z.array(z.string()).optional(),
    vars: z.array(z.string()).optional()
  }).optional()
})

/**
 * Applies a patch to a program, giving raw input for parseProgram. Rules and triggers are
 * upserted by name, routines and vars merged by key, then removals applied.
 */
export function applyPatch (base: Program, patch: ProgramPatch): ProgramInput {
  const out: any = structuredClone(base)
  const s = patch.set ?? {}
  if (s.name) out.name = s.name
  if (s.description !== undefined) out.description = s.description
  Object.assign(out.vars, s.vars ?? {})
  Object.assign(out.routines, s.routines ?? {})
  const upsert = (list: any[], items: unknown[] = []) => {
    for (const it of items) {
      const name = (it as any)?.name
      const i = list.findIndex(x => x.name === name)
      if (i >= 0) list[i] = it
      else list.push(it)
    }
  }
  upsert(out.rules, s.rules)
  upsert(out.triggers, s.triggers)
  const r = patch.remove ?? {}
  out.rules = out.rules.filter((x: Rule) => !r.rules?.includes(x.name))
  out.triggers = out.triggers.filter((x: Trigger) => !r.triggers?.includes(x.name))
  for (const n of r.routines ?? []) delete out.routines[n]
  for (const n of r.vars ?? []) delete out.vars[n]
  return out
}

// ------------------------------------------------------------------ diff

/** Short human summary of what changed between two programs ("+rule patrol, ~routine greet"). */
export function diffSummary (a: Program | null, b: Program): string {
  if (!a) return `new program: ${b.rules.length} rules, ${Object.keys(b.routines).length} routines, ${b.triggers.length} triggers`
  const parts: string[] = []
  const cmp = (kind: string, x: Record<string, unknown>, y: Record<string, unknown>) => {
    for (const k of Object.keys(y)) {
      if (!(k in x)) parts.push(`+${kind} ${k}`)
      else if (JSON.stringify(x[k]) !== JSON.stringify(y[k])) parts.push(`~${kind} ${k}`)
    }
    for (const k of Object.keys(x)) if (!(k in y)) parts.push(`-${kind} ${k}`)
  }
  const byName = <T extends { name: string }>(l: T[]) => Object.fromEntries(l.map(x => [x.name, x]))
  cmp('rule', byName(a.rules), byName(b.rules))
  cmp('routine', a.routines, b.routines)
  cmp('trigger', byName(a.triggers), byName(b.triggers))
  cmp('var', a.vars, b.vars)
  return parts.join(', ') || 'no changes'
}

// ------------------------------------------------------------------ spec for the LLM

const schemaText = (s: z.ZodType) => {
  try {
    const j = z.toJSONSchema(s, { io: 'input', unrepresentable: 'any' }) as any
    delete j.$schema
    return JSON.stringify(j)
  } catch {
    return '{}'
  }
}

/**
 * The format reference an LLM gets: generated from the zod schemas above and the bot's
 * allowed actions (with their parameter schemas), so it never drifts from what the parser
 * accepts.
 */
export function formatSpec (catalog: ActionCatalog): string {
  const lines: string[] = []
  lines.push(`PROGRAM FORMAT v${FORMAT_VERSION} (JSON). Top level: ${schemaText(ProgramSchema)}`)
  lines.push('Every step and every condition is an object with exactly ONE kind key. Nested step lists ("then", "steps", rule/trigger "do") and conditions ("when", "cond", "if") use the same shapes.')
  lines.push('STEP KINDS:')
  for (const k of STEP_KINDS) lines.push(`- ${k}: ${schemaText(stepSchemas[k])}`)
  lines.push('CONDITION KINDS:')
  for (const k of CONDITION_KINDS) lines.push(`- ${k}: ${schemaText(condSchemas[k])}`)
  lines.push('FACTS for {"fact": ...}:')
  for (const [k, v] of Object.entries(FACTS)) lines.push(`- ${k}: ${v}`)
  lines.push(`TIME WINDOWS: ${Object.entries(TIME_WINDOWS).map(([k, v]) => `${k}=${v[0]}..${v[1]}`).join(', ')}, or [from, to] in game ticks (wraps past 23999).`)
  lines.push('RULES are utility behaviours: while "when" holds the rule scores "score" and the highest score runs its "do" (a routine name or inline steps). Bands: idle 5-15, social 15-25, chores 25-45, routine 40-70, needs 50-90. A rule ends when its steps end; it is picked again on later ticks (use cooldownMs to space it out).')
  lines.push(`TRIGGERS: on interval (everyMs >= ${LIMITS.intervalMinMs}), time (at: window, once per window), chat (match: words, near: blocks, ownersOnly), hurt, death, playerJoined, spawn. A fired trigger queues its "do" and competes in the brain with "priority" (default 60). {player} is the speaker / joined player / nearest player.`)
  lines.push('TEMPLATES in say/whisper text and string action params: {player}, {bot}, {var.<name>}.')
  lines.push(`LIMITS: ${LIMITS.rules} rules, ${LIMITS.routines} routines, ${LIMITS.triggers} triggers, ${LIMITS.stepsPerList} steps per list, nesting ${LIMITS.depth}, repeat.times <= ${LIMITS.repeatTimes}, while.max <= ${LIMITS.whileMax} (required), wait <= ${LIMITS.waitMs} ms, one routine run must finish within ${LIMITS.execSteps} steps and ${LIMITS.execMs / 60000} minutes, no recursion through "run". Chat is rate limited.`)
  lines.push('ACTIONS usable in {"act": name, "params": {...}} (anything else is rejected):')
  for (const a of catalog.allowed()) {
    const params = schemaText(a.params)
    lines.push(`- ${a.name}: ${a.description}${params !== '{"type":"object","properties":{}}' ? ` params=${params}` : ''}`)
  }
  return lines.join('\n')
}
