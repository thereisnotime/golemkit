// Actions are the unit of everything a bot can do. Skills define them; brains (chat
// commands, NPC loops, LLMs) call them by name through Agent.act(). Parameters are zod
// schemas, so the same definition gives runtime validation, TypeScript types, chat-command
// parsing and the JSON schema an LLM sees as a tool.
import { z } from 'zod'
import type { Bot } from 'mineflayer'
import type { Agent } from './agent.ts'
import type { Logger } from './log.ts'

/** Who asked for an action. Player callers carry the player's name. */
export type Caller =
  | { kind: 'player', name: string }
  | { kind: 'brain', name: string }
  | { kind: 'reflex', name: string }
  | { kind: 'system', name: string }

/**
 * Priorities decide who gets the bot's body. A higher-priority exclusive action preempts a
 * lower one; the preempted action is resumed afterwards if it is resumable.
 */
export const PRIORITY = {
  idle: 10,
  npc: 20,
  /** Scene choreography (src/brains/scene): above NPC routines, below LLM/player/reflex. */
  scene: 25,
  llm: 30,
  player: 50,
  reflex: 60,
  system: 100
} as const

export interface ActionResult {
  ok: boolean
  message: string
  data?: unknown
}

export interface ActionContext {
  agent: Agent
  bot: Bot
  /** Aborted when the action is preempted, stopped, or the session ends. Long-running actions must honour it. */
  signal: AbortSignal
  caller: Caller
  log: Logger
  /** Name of the player behind the call, if any (players, or brains acting for a player). */
  player?: string
}

export interface ActionDef<S extends z.ZodObject = z.ZodObject> {
  name: string
  description: string
  params: S
  /**
   * Exclusive actions need the body (movement, combat, digging) and take the action lock.
   * Non-exclusive ones (status queries, chat) run alongside. Default: true.
   */
  exclusive?: boolean
  /** Runs until stopped (follow, guard). Resumed after a higher-priority action preempts it. Default: false. */
  longRunning?: boolean
  /** Extra names for chat commands. */
  aliases?: string[]
  /** Hide from LLM tool lists. */
  internal?: boolean
  run (ctx: ActionContext, params: z.infer<S>): Promise<ActionResult | string | void> | ActionResult | string | void
}

export function defineAction<S extends z.ZodObject> (def: ActionDef<S>): ActionDef<S> {
  return def
}

/** Shorthand for an action without parameters. */
export const noParams = z.object({})

export function normalizeResult (r: ActionResult | string | void): ActionResult {
  if (r === undefined) return { ok: true, message: 'done' }
  if (typeof r === 'string') return { ok: true, message: r }
  return r
}

export const ok = (message: string, data?: unknown): ActionResult => ({ ok: true, message, data })
export const fail = (message: string, data?: unknown): ActionResult => ({ ok: false, message, data })

export class ActionAbortedError extends Error {
  constructor (reason = 'aborted') {
    super(reason)
    this.name = 'ActionAbortedError'
  }
}

/** Throws if the signal is aborted. Call between steps of long actions. */
export function checkAborted (signal: AbortSignal): void {
  if (signal.aborted) throw new ActionAbortedError(String(signal.reason ?? 'aborted'))
}

/** Sleeps, rejecting early if the signal aborts. */
export function sleep (ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ActionAbortedError())
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = () => { clearTimeout(t); reject(new ActionAbortedError()) }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
