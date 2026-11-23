// Executes program steps. The interpreter only knows a few step kinds; every effect on the
// world goes through Host.act (the NPC brain's ctx.act, so agent.act at PRIORITY.npc) or
// Host.say/whisper (agent chat queue behind a per-program rate limiter). Each routine run has
// a step budget and a time budget; running out of either ends the run with CapExceeded.
import { fillTemplate, LIMITS, type TriggerEvent, TIME_WINDOWS, type Cond, type Program, type Scalar, type Step, type TimeWindow } from './format.ts'
import type { ActionResult } from '../../core/index.ts'

/** Read access to the world: observation, blackboard, places, program memory. */
export interface World {
  /** A fact by name (see FACTS). Unknown → undefined. */
  fact (name: string): Scalar | undefined
  /** Distance to a named player, undefined when not visible. */
  playerDistance? (name: string): number | undefined
}

/** Program variables and timers; outlive a single routine run. */
export class ProgramMemory {
  readonly vars = new Map<string, Scalar>()
  readonly timers = new Map<string, number>()

  constructor (initial: Record<string, Scalar> = {}) {
    for (const [k, v] of Object.entries(initial)) this.vars.set(k, v)
  }

  get (name: string): Scalar | undefined { return this.vars.get(name) }
  set (name: string, v: Scalar): void { this.vars.set(name, v) }
}

/** What the interpreter acts through. */
export interface Host {
  act (name: string, params: Record<string, unknown>): Promise<ActionResult>
  say (text: string): void
  whisper (to: string, text: string): void
  wait (ms: number): Promise<void>
  now (): number
  random (): number
  signal?: AbortSignal
}

export class CapExceeded extends Error {
  constructor (msg: string) {
    super(msg)
    this.name = 'CapExceeded'
  }
}

/** A `fail` step or a failed action ends the routine with this. */
export class RoutineFailed extends Error {
  constructor (msg: string) {
    super(msg)
    this.name = 'RoutineFailed'
  }
}

/** Per-program chat limiter: at least gapMs between lines and at most perMinute lines a minute. */
export class ChatLimiter {
  private sent: number[] = []
  dropped = 0
  private readonly gapMs: number
  private readonly perMinute: number

  constructor (opts: { gapMs?: number, perMinute?: number } = {}) {
    this.gapMs = opts.gapMs ?? 2500
    this.perMinute = opts.perMinute ?? 6
  }

  allow (now: number): boolean {
    this.sent = this.sent.filter(t => now - t < 60_000)
    const last = this.sent[this.sent.length - 1]
    if ((last !== undefined && now - last < this.gapMs) || this.sent.length >= this.perMinute) {
      this.dropped++
      return false
    }
    this.sent.push(now)
    return true
  }
}

export interface RunEnv {
  program: Program
  world: World
  memory: ProgramMemory
  host: Host
  chat: ChatLimiter
  /** Player this run is about (chat speaker, joined player, nearest player). */
  player?: string
  bot: string
  /** What fired the trigger ({cause}, {deathDetail} for a death). */
  event?: TriggerEvent
  /** Called with every action result (for experience counters). */
  onAction? (name: string, result: ActionResult): void
}

export function inWindow (t: number, w: TimeWindow): boolean {
  const [from, to] = typeof w === 'string' ? TIME_WINDOWS[w] : w
  return from <= to ? t >= from && t <= to : t >= from || t <= to
}

export function evalCond (c: Cond, env: Pick<RunEnv, 'world' | 'memory' | 'host'>): boolean {
  if ('all' in c) return c.all.every(x => evalCond(x, env))
  if ('any' in c) return c.any.some(x => evalCond(x, env))
  if ('not' in c) return !evalCond(c.not, env)
  if ('chance' in c) return env.host.random() < c.chance
  if ('time' in c) return inWindow(Number(env.world.fact('timeOfDay') ?? 0), c.time)
  if ('playerNear' in c) {
    const d = Number(env.world.fact('nearestPlayer.distance') ?? -1)
    return d >= 0 && d <= c.playerNear
  }
  if ('hostileNear' in c) {
    const d = Number(env.world.fact('nearestHostile.distance') ?? -1)
    return d >= 0 && d <= c.hostileNear
  }
  if ('has' in c) return Number(env.world.fact(`inventory.${c.has.item}`) ?? 0) >= (c.has.count ?? 1)
  if ('elapsed' in c) {
    const at = env.memory.timers.get(c.elapsed.timer)
    return at === undefined || env.host.now() - at >= c.elapsed.ms
  }
  const v = factValue(c.fact, env)
  if (c.eq !== undefined && v !== c.eq) return false
  if (c.ne !== undefined && v === c.ne) return false
  const n = typeof v === 'number' ? v : Number(v)
  if (c.lt !== undefined && !(n < c.lt)) return false
  if (c.lte !== undefined && !(n <= c.lte)) return false
  if (c.gt !== undefined && !(n > c.gt)) return false
  if (c.gte !== undefined && !(n >= c.gte)) return false
  return true
}

function factValue (name: string, env: Pick<RunEnv, 'world' | 'memory' | 'host'>): Scalar | undefined {
  if (name.startsWith('var.')) return env.memory.get(name.slice(4))
  if (name.startsWith('timer.')) {
    const at = env.memory.timers.get(name.slice(6))
    return at === undefined ? -1 : env.host.now() - at
  }
  return env.world.fact(name)
}

/** Runs one routine (or inline step list) to the end. Throws CapExceeded / RoutineFailed / whatever host.act throws. */
export async function runRoutine (steps: Step[], env: RunEnv): Promise<string> {
  const budget = { steps: 0, startedAt: env.host.now(), depth: 0 }
  await runSteps(steps, env, budget)
  return 'done'
}

interface Budget { steps: number, startedAt: number, depth: number }

function tick (env: RunEnv, b: Budget): void {
  if (env.host.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'ActionAbortedError' })
  if (++b.steps > LIMITS.execSteps) throw new CapExceeded(`ran more than ${LIMITS.execSteps} steps`)
  if (env.host.now() - b.startedAt > LIMITS.execMs) throw new CapExceeded(`ran longer than ${LIMITS.execMs / 60000} minutes`)
}

function pick (v: string | string[], env: RunEnv): string {
  const list = [v].flat()
  return list[Math.floor(env.host.random() * list.length)] ?? list[0]!
}

function fill (s: string, env: RunEnv): string {
  return fillTemplate(s, { player: env.player, bot: env.bot, event: env.event, get: n => env.memory.get(n) })
}

function fillParams (v: unknown, env: RunEnv): unknown {
  if (typeof v === 'string') return fill(v, env)
  if (Array.isArray(v)) return v.map(x => fillParams(x, env))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillParams(x, env)]))
  return v
}

async function runSteps (steps: Step[], env: RunEnv, b: Budget): Promise<void> {
  for (const s of steps) await runStep(s, env, b)
}

async function act (env: RunEnv, name: string, params: Record<string, unknown>): Promise<void> {
  const r = await env.host.act(name, params)
  env.onAction?.(name, r)
  if (!r.ok) throw new RoutineFailed(`${name} failed: ${r.message}`)
}

async function runStep (s: Step, env: RunEnv, b: Budget): Promise<void> {
  tick(env, b)
  if ('act' in s) return act(env, s.act, fillParams(s.params ?? {}, env) as Record<string, unknown>)
  if ('goto_place' in s) return act(env, 'goto_place', { name: fill(s.goto_place, env), ...(s.range ? { range: s.range } : {}) })
  if ('say' in s) {
    if (env.chat.allow(env.host.now())) env.host.say(fill(pick(s.say, env), env))
    return
  }
  if ('whisper' in s) {
    const to = s.to ? fill(s.to, env) : env.player
    if (to && env.chat.allow(env.host.now())) env.host.whisper(to, fill(pick(s.whisper, env), env))
    return
  }
  if ('wait' in s) return env.host.wait(s.wait)
  if ('if' in s) return runSteps(evalCond(s.if, env) ? s.then : (s.else ?? []), env, b)
  if ('repeat' in s) {
    for (let i = 0; i < s.repeat.times; i++) await runSteps(s.repeat.steps, env, b)
    return
  }
  if ('while' in s) {
    for (let i = 0; i < s.while.max && evalCond(s.while.cond, env); i++) await runSteps(s.while.steps, env, b)
    return
  }
  if ('set' in s) {
    const cur = env.memory.get(s.set)
    env.memory.set(s.set, s.add !== undefined ? (typeof cur === 'number' ? cur : 0) + s.add : s.value!)
    return
  }
  if ('timer' in s) { env.memory.timers.set(s.timer, env.host.now()); return }
  if ('fail' in s) throw new RoutineFailed(fill(s.fail, env))
  if ('run' in s) {
    const target = env.program.routines[s.run]
    if (!target) throw new RoutineFailed(`no routine ${s.run}`)
    if (++b.depth > LIMITS.callDepth) throw new CapExceeded(`routine calls nested deeper than ${LIMITS.callDepth}`)
    try { await runSteps(target, env, b) } finally { b.depth-- }
  }
}

/** Resolves a rule's or trigger's `do` to steps. */
export function stepsOf (program: Program, d: string | Step[]): Step[] {
  return typeof d === 'string' ? program.routines[d] ?? [] : d
}
