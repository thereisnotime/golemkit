// Types shared by the NPC brain and its behaviours.
import type { Agent, ActionResult, Logger, GameClient } from '../../core/index.ts'
import type { Blackboard } from './blackboard.ts'
import type { Failure, HelpText } from './help.ts'

/** What every scoring function sees. Cheap to build, rebuilt each tick. */
export interface NpcContext {
  agent: Agent
  /** The game client (Minecraft Java: the Mineflayer bot), for game-specific behaviours. */
  bot: GameClient
  bb: Blackboard
  log: Logger
  /** Milliseconds, from the brain's clock (injectable for tests). */
  now: number
  /** Name of the behaviour currently running, so a score can commit to finishing it. */
  current: string | null
}

/** What a running behaviour gets on top of NpcContext. */
export interface BehaviorContext extends NpcContext {
  /** Aborted when the brain switches away, yields the body, or the session ends. */
  signal: AbortSignal
  /**
   * Runs an action as the NPC brain (caller brain:npc, PRIORITY.npc). If somebody with a
   * higher priority holds or takes the body, it throws NpcYield so the brain backs off;
   * if this behaviour was interrupted it throws ActionAbortedError. Otherwise it returns
   * the action's result, ok or not.
   */
  act (name: string, params?: Record<string, unknown>): Promise<ActionResult>
  /** Signal-aware pause. */
  wait (ms: number): Promise<void>
}

export interface Behavior {
  /** Unique within a brain; shown in npc_status and logs. */
  name: string
  /**
   * How much the NPC wants to do this right now, roughly 0..100. 0 (or less) means not
   * applicable. Suggested bands: idle 5-15, social 15-25, chores 25-45, routine 40-70,
   * needs 50-90, danger 70-100.
   */
  score (ctx: NpcContext): number
  /** Does the work. Resolve when done; honour ctx.signal. A falsy/ok result counts as success. */
  run (ctx: BehaviorContext): Promise<ActionResult | string | void | boolean>
  /** Actions this behaviour needs; it scores 0 when any is missing from the bot. */
  requires?: string[]
  /** Pause after a successful run before it can be picked again. Default 0. */
  cooldownMs?: number
  /** First back-off after a failed run; doubles per consecutive failure. Default 5000. */
  failureCooldownMs?: number
  /** Ceiling for the failure back-off. Default 120000. */
  maxFailureCooldownMs?: number
  /**
   * A short summary of what the last failure depended on (e.g. the wood held). While the
   * failure back-off runs, a different value ends it early (at least 10 s after the failure), so
   * the behaviour retries as soon as the cause is gone instead of waiting out the back-off.
   */
  retryKey? (ctx: NpcContext): string
  /**
   * Priority this behaviour acts at, overriding the brain's (PRIORITY.npc by default). A
   * behaviour above whoever holds the body keeps running instead of backing off, e.g. an
   * armed keep_fed at PRIORITY.behavior (35) still runs while an LLM (30) holds the body.
   */
  priority?: number
  /** What it is trying to do, in a few words ("upgrade my tools"), for help requests. Default: the name. */
  goal?: string
  /**
   * When it keeps failing the same way and asks its owners for help (settings.askHelp), what
   * would help: "a few logs or planks in my chest". Return null when the behaviour reports this
   * itself (keep_fed's starving report), undefined for no hint. See docs/guide/behaviors.md#asking-for-help.
   */
  help? (ctx: NpcContext | undefined, failure: Failure): HelpText | null | undefined
}

/** Runs every tick before scoring: updates custom needs, or does cheap side effects (chat). */
export type NpcHook = (ctx: NpcContext) => void

/** Thrown by BehaviorContext.act when another caller owns the body. */
export class NpcYield extends Error {
  readonly holder: string
  /** Priority of the holder, when known. */
  readonly priority: number | undefined
  constructor (holder: string, priority?: number) {
    super(`body taken by ${holder}`)
    this.name = 'NpcYield'
    this.holder = holder
    this.priority = priority
  }
}
