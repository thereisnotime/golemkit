// Persistent goals for the LLM brain. A goal is what an owner asked for that takes more than
// one turn ("make an axe, chop trees and build us a house"): a text, an optional ordered plan
// and notes, kept in agent.storage so it survives restarts and reconnects. The runtime shows
// the active goal at the top of every prompt and starts follow-up turns (continuation) while
// a goal is active and nothing else is going on. Guardrails here decide when to stop:
// autonomous-turn and time limits (renewed whenever the owner talks), repeated identical
// failures, the budget, and the owner's !stop / !goal_cancel.
import { z } from 'zod'
import type { Storage } from '../core/index.ts'
import type { BotTools, TurnScope } from './tools.ts'

export interface GoalStep { text: string, done: boolean, note?: string }

export interface Goal {
  id: string
  text: string
  /** Who asked (turn player); continuation turns act for them. */
  owner?: string
  /** Owner talked by whisper: progress goes back by whisper. */
  whisper?: boolean
  steps: GoalStep[]
  notes: string[]
  createdAt: number
  updatedAt: number
  /** Continuation turns since the owner last talked. */
  autoTurns: number
  totalTurns: number
  /** Continuation stops after this (renewed when the owner talks). */
  deadlineAt: number
  /** Why continuation is paused (waiting for the owner, stuck, limit); cleared when the owner talks. */
  paused?: string
  /** Identical failure signatures since the owner last talked. */
  failures: Record<string, number>
  /** Continuation turns in a row without progress (drives the idle backoff). */
  stalls: number
}

export interface FinishedGoal { text: string, status: 'done' | 'abandoned' | 'replaced', result: string, at: number }

export interface GoalOptions {
  /** Continue goals on their own. Default true. */
  enabled?: boolean
  /** Continuation turns allowed without hearing from the owner. Default 40. */
  maxTurns?: number
  /** Minutes a goal may run on its own without hearing from the owner. Default 45. */
  timeoutMin?: number
  /** Stop and ask after the same failure this many times. Default 3. */
  maxSameFailures?: number
  /** Gap before the next turn after an action finished or a turn made progress. Default 1500 ms. */
  continueDelayMs?: number
  /** Idle re-check while a goal is active but nothing happens: first gap, doubled per stalled turn. Default 20 s. */
  idleBaseMs?: number
  /** Longest idle gap. Default 5 min. */
  idleMaxMs?: number
  /** Share of the hourly turn/token budget kept for chat: continuation waits once the rest is used. Default 0.15. */
  budgetReserve?: number
}

export type ResolvedGoalOptions = Required<GoalOptions>

export function resolveGoalOptions (o: GoalOptions = {}): ResolvedGoalOptions {
  return {
    enabled: o.enabled ?? true,
    maxTurns: o.maxTurns ?? 40,
    timeoutMin: o.timeoutMin ?? 45,
    maxSameFailures: o.maxSameFailures ?? 3,
    continueDelayMs: o.continueDelayMs ?? 1500,
    idleBaseMs: o.idleBaseMs ?? 20_000,
    idleMaxMs: o.idleMaxMs ?? 300_000,
    budgetReserve: o.budgetReserve ?? 0.15
  }
}

const GOAL_KEY = 'llm.goal'
const HISTORY_KEY = 'llm.goals.history'

export class GoalStore {
  private readonly storage: Storage
  readonly opts: ResolvedGoalOptions
  private readonly now: () => number

  constructor (storage: Storage, opts: GoalOptions = {}, now: () => number = Date.now) {
    this.storage = storage
    this.opts = resolveGoalOptions(opts)
    this.now = now
  }

  get active (): Goal | null {
    return this.storage.get<Goal | null>(GOAL_KEY, null)
  }

  history (): FinishedGoal[] {
    return this.storage.get<FinishedGoal[]>(HISTORY_KEY, [])
  }

  private save (g: Goal): Goal {
    g.updatedAt = this.now()
    this.storage.set(GOAL_KEY, g)
    return g
  }

  private finish (status: FinishedGoal['status'], result: string): Goal | null {
    const g = this.active
    if (!g) return null
    this.storage.set(HISTORY_KEY, [...this.history(), { text: g.text, status, result: result.slice(0, 200), at: this.now() }].slice(-10))
    this.storage.delete(GOAL_KEY)
    // Write at once: a finished goal must not come back after a crash.
    try { this.storage.flush() } catch {}
    return g
  }

  set (text: string, steps: string[] = [], owner?: string, whisper?: boolean): { goal: Goal, replaced?: Goal } {
    const prev = this.active
    if (prev) this.finish('replaced', `replaced by: ${text}`)
    const now = this.now()
    const goal: Goal = {
      id: now.toString(36),
      text: text.trim().slice(0, 300),
      ...(owner ? { owner } : {}),
      ...(whisper ? { whisper } : {}),
      steps: steps.map(s => ({ text: s.trim().slice(0, 160), done: false })).filter(s => s.text).slice(0, 15),
      notes: [],
      createdAt: now,
      updatedAt: now,
      autoTurns: 0,
      totalTurns: 0,
      deadlineAt: now + this.opts.timeoutMin * 60_000,
      failures: {},
      stalls: 0
    }
    this.save(goal)
    try { this.storage.flush() } catch {}
    return { goal, ...(prev ? { replaced: prev } : {}) }
  }

  /** Plan edits. Step numbers are 1-based as shown in the prompt. Returns what changed. */
  update (u: { done?: number[], add?: string[], insertAt?: number, reorder?: number[], note?: string, wait?: boolean, resume?: boolean }): string {
    const g = this.active
    if (!g) return 'no active goal'
    const changes: string[] = []
    for (const n of u.done ?? []) {
      const s = g.steps[n - 1]
      if (s && !s.done) { s.done = true; changes.push(`step ${n} done`) }
    }
    if (u.reorder?.length) {
      const order = u.reorder.map(n => g.steps[n - 1]).filter((s): s is GoalStep => !!s)
      const rest = g.steps.filter(s => !order.includes(s))
      g.steps = [...order, ...rest]
      changes.push('plan reordered')
    }
    if (u.add?.length) {
      const add = u.add.map(t => ({ text: t.trim().slice(0, 160), done: false })).filter(s => s.text)
      const at = u.insertAt ? Math.max(0, Math.min(g.steps.length, u.insertAt - 1)) : g.steps.length
      g.steps.splice(at, 0, ...add)
      g.steps = g.steps.slice(0, 20)
      changes.push(`added ${add.length} step${add.length === 1 ? '' : 's'}`)
    }
    if (u.note) { g.notes = [...g.notes, u.note.trim().slice(0, 200)].slice(-8); changes.push('noted') }
    if (u.wait) { g.paused = 'waiting for the owner'; changes.push('waiting for the owner, continuation paused') }
    if (u.resume && g.paused) { delete g.paused; changes.push('resumed') }
    g.stalls = 0
    this.save(g)
    return changes.length ? changes.join(', ') : 'nothing changed'
  }

  complete (result: string): Goal | null { return this.finish('done', result) }
  abandon (reason: string): Goal | null { return this.finish('abandoned', reason) }

  /** The owner talked: renew the autonomous-turn and time limits, clear pauses and failure counts. */
  touchOwner (): void {
    const g = this.active
    if (!g) return
    g.autoTurns = 0
    g.deadlineAt = this.now() + this.opts.timeoutMin * 60_000
    g.failures = {}
    g.stalls = 0
    delete g.paused
    this.save(g)
  }

  /** After a continuation turn: counts it and tracks stalls. */
  recordTurn (progress: boolean): void {
    const g = this.active
    if (!g) return
    g.autoTurns++
    g.totalTurns++
    g.stalls = progress ? 0 : g.stalls + 1
    this.save(g)
  }

  /** Counts a failure of an action the brain started. Returns how many times this one happened. */
  recordFailure (sig: string): number {
    const g = this.active
    if (!g) return 0
    g.failures[sig] = (g.failures[sig] ?? 0) + 1
    this.save(g)
    return g.failures[sig]
  }

  pause (reason: string): void {
    const g = this.active
    if (!g) return
    g.paused = reason
    this.save(g)
  }

  /** Block for the prompt (near the top). */
  fmtPrompt (): string | undefined {
    const g = this.active
    if (!g) return undefined
    const lines = [`Goal${g.owner ? ` (for ${g.owner})` : ''}: ${g.text}`]
    if (g.steps.length) {
      const next = g.steps.findIndex(s => !s.done)
      g.steps.forEach((s, i) => lines.push(`${i + 1}. [${s.done ? 'x' : ' '}] ${s.text}${i === next ? '   <- next' : ''}`))
    } else {
      lines.push('(no plan yet: add steps with update_goal if it takes several)')
    }
    if (g.notes.length) lines.push(`Notes: ${g.notes.join(' | ')}`)
    const mins = Math.round((this.now() - g.createdAt) / 60_000)
    lines.push(`Started ${mins} min ago, ${g.autoTurns}/${this.opts.maxTurns} turns on your own since ${g.owner ?? 'the owner'} last spoke.${g.paused ? ` Paused: ${g.paused}.` : ''}`)
    return lines.join('\n')
  }

  /** Compact form for agent.observe(). */
  observeField (): Record<string, unknown> | null {
    const g = this.active
    if (!g) return null
    const done = g.steps.filter(s => s.done).length
    const next = g.steps.find(s => !s.done)
    return { text: g.text, steps: `${done}/${g.steps.length}`, ...(next ? { next: next.text } : {}), ...(g.paused ? { paused: g.paused } : {}) }
  }
}

// ------------------------------------------------------------------ continuation decision

export interface ContinuationState {
  now: number
  /** A turn is running or triggers are queued. */
  busy: boolean
  /** Something holds the bot's body (an action the brain started, a player command, a reflex). */
  acting: boolean
  connected: boolean
  /** Budget.blocked() reason, or null. */
  budgetBlocked: string | null
  /** Hourly use so far vs the limits (0 = unlimited). */
  hour: { turns: number, tokens: number }
  limits: { turnsPerHour: number, tokensPerHour: number }
}

export type ContinuationDecision =
  | { go: true }
  | { go: false, wait: string }
  | { go: false, stop: string }

/** Whether to start a continuation turn now. `stop` means a guardrail tripped: pause and tell the owner. Pure. */
export function continuationDecision (goal: Goal | null, opts: ResolvedGoalOptions, s: ContinuationState): ContinuationDecision {
  if (!goal) return { go: false, wait: 'no goal' }
  if (!opts.enabled) return { go: false, wait: 'continuation disabled' }
  if (goal.paused) return { go: false, wait: goal.paused }
  if (s.busy) return { go: false, wait: 'thinking' }
  if (!s.connected) return { go: false, wait: 'not connected' }
  if (s.acting) return { go: false, wait: 'an action is running' }
  if (s.budgetBlocked) return { go: false, wait: s.budgetBlocked }
  const tight = (used: number, limit: number) => limit > 0 && used >= limit * (1 - opts.budgetReserve)
  if (tight(s.hour.turns, s.limits.turnsPerHour) || tight(s.hour.tokens, s.limits.tokensPerHour)) return { go: false, wait: 'saving the rest of the hourly budget for chat' }
  if (goal.autoTurns >= opts.maxTurns) return { go: false, stop: `worked ${goal.autoTurns} turns on my own without hearing from you` }
  if (s.now >= goal.deadlineAt) return { go: false, stop: `ran for ${opts.timeoutMin} min on my own without hearing from you` }
  const worst = Object.entries(goal.failures).sort((a, b) => b[1] - a[1])[0]
  if (worst && worst[1] >= opts.maxSameFailures) return { go: false, stop: `the same thing failed ${worst[1]} times: ${worst[0]}` }
  return { go: true }
}

/** Gap before the next idle check: doubles with every stalled turn. */
export function idleDelay (stalls: number, opts: ResolvedGoalOptions): number {
  return Math.min(opts.idleMaxMs, opts.idleBaseMs * 2 ** Math.min(stalls, 10))
}

/** Signature for "the same failure": action name plus the message with numbers blanked. */
export function failureSignature (action: string, message: string): string {
  return `${action}: ${message.replace(/-?\d+(\.\d+)?/g, '#').replace(/\s+/g, ' ').trim().slice(0, 100)}`
}

// ------------------------------------------------------------------ tools

/** Adds set_goal / update_goal / complete_goal / abandon_goal / goal_status to the bot's tools. */
export function registerGoalTools (tools: BotTools, store: GoalStore, onChange?: (what: 'set' | 'update' | 'complete' | 'abandon') => void): void {
  const fmt = () => store.fmtPrompt() ?? 'no active goal'
  tools.define('set_goal',
    'Start a goal for a request that takes more than one turn (build, gather, multi-step jobs). One goal at a time; a new one replaces the old. ' +
    'Give a short ordered plan of high-level steps (e.g. "gather_materials template=hut", "build hut"). The goal is shown to you every turn and you get ' +
    'follow-up turns to keep working on it until you call complete_goal or abandon_goal.',
    z.object({
      goal: z.string().min(3).max(300).describe('what was asked, in a few words'),
      steps: z.array(z.string().min(1).max(160)).max(15).optional().describe('ordered plan, 2-6 high-level steps')
    }),
    ({ goal, steps }, scope: TurnScope) => {
      const r = store.set(goal, steps, scope.player, scope.replyTo?.whisper)
      onChange?.('set')
      return { ok: true, text: `${r.replaced ? `replaced the previous goal (${r.replaced.text}). ` : ''}goal set.\n${fmt()}` }
    })
  tools.define('update_goal',
    'Update the active goal: mark steps done (only after the tool result confirmed it), add or reorder steps, keep a note, or wait_for_owner=true after asking the owner something (pauses follow-up turns until they answer).',
    z.object({
      done: z.array(z.number().int().min(1)).optional().describe('step numbers that are finished'),
      add: z.array(z.string().min(1).max(160)).max(8).optional().describe('new steps'),
      insert_at: z.number().int().min(1).optional().describe('step number to insert the new steps at (default: the end)'),
      reorder: z.array(z.number().int().min(1)).optional().describe('step numbers in their new order (the rest keep theirs, after)'),
      note: z.string().max(200).optional().describe('a fact worth keeping for this goal (where the site is, what failed)'),
      wait_for_owner: z.boolean().optional().describe('you asked the owner something and need the answer before going on')
    }),
    (a) => {
      if (!store.active) return { ok: false, text: 'no active goal; use set_goal' }
      const r = store.update({ done: a.done, add: a.add, insertAt: a.insert_at, reorder: a.reorder, note: a.note, wait: a.wait_for_owner })
      onChange?.('update')
      return { ok: true, text: `${r}.\n${fmt()}` }
    })
  tools.define('complete_goal',
    'Finish the active goal once the tool results show it is really done. Then tell the owner the real result in one short line.',
    z.object({ result: z.string().min(1).max(200).describe('what was achieved, truthfully (e.g. "built a hut at 600 70 40")') }),
    ({ result }) => {
      const g = store.complete(result)
      if (!g) return { ok: false, text: 'no active goal' }
      onChange?.('complete')
      return { ok: true, text: `goal done: ${g.text}` }
    })
  tools.define('abandon_goal',
    'Drop the active goal: the owner cancelled it, it is impossible, or you are stuck and they should decide. Tell them why.',
    z.object({ reason: z.string().min(1).max(200) }),
    ({ reason }) => {
      const g = store.abandon(reason)
      if (!g) return { ok: false, text: 'no active goal' }
      onChange?.('abandon')
      return { ok: true, text: `goal dropped: ${g.text}` }
    })
  tools.define('goal_status', 'The active goal, its plan and progress, plus the last finished goals.', z.object({}), () => {
    const h = store.history().slice(-3).map(f => `${f.status}: ${f.text} (${f.result})`)
    return { ok: true, text: `${fmt()}${h.length ? `\nEarlier: ${h.join(' | ')}` : ''}` }
  })
}
