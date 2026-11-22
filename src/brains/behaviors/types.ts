// Types for armable behaviours: a definition is a named, documented, option-validated
// factory for an NPC-brain Behavior. The behaviours brain keeps a set of them armed and
// runs the armed ones through the NPC controller. See docs/guide/behaviors.md.
import type { z } from 'zod'
import { PRIORITY, type Agent, type Capability } from '../../core/index.ts'
import type { Behavior, NpcHook } from '../npc/index.ts'

/** Priority levels a behaviour can run at (mapped to PRIORITY.idle / npc / behavior). */
export type BehaviorLevel = 'idle' | 'npc' | 'behavior'

export const LEVELS: Record<BehaviorLevel, number> = {
  idle: PRIORITY.idle,
  npc: PRIORITY.npc,
  behavior: PRIORITY.behavior
}

export type BehaviorCategory = 'survival' | 'safety' | 'social' | 'combat' | 'work' | 'routine' | 'idle'

export interface BehaviorEnv {
  agent: Agent
}

/** What `create` returns: a Behavior without name/priority (the runtime fills those in). */
export type BehaviorBody = Omit<Behavior, 'name' | 'priority'>

export interface BehaviorDefinition<S extends z.ZodObject = z.ZodObject> {
  /** Unique snake_case name, used in actions, profiles and chat. */
  name: string
  category: BehaviorCategory
  /** What it does and when to arm it. Shown in behavior_list, to players and to LLMs. */
  description: string
  /** Options with defaults and .describe() texts. Unknown keys are rejected. */
  options: S
  /** Actions it cannot work without; it is skipped (with a warning) when any is missing. */
  requires?: string[]
  /** Actions it uses when present (documentation only). */
  uses?: string[]
  /**
   * What the game must support (see Capability in core/adapter.ts). On an adapter without one
   * the behaviour doesn't exist for that agent: it can't be armed, listed or configured.
   */
  capabilities?: Capability[]
  /** Terrain capabilities: dig = agent.canDig, place = settings.canPlace !== false. */
  needs?: { dig?: boolean, place?: boolean }
  /** Default priority level. Default 'npc'. Every behaviour also takes a `priority` option. */
  priority?: BehaviorLevel
  /**
   * Fills in context-dependent options when armed from an action, e.g. guard_area's centre
   * defaults to where the bot stands. Gets the validated options, returns options.
   */
  prepare? (options: z.infer<S>, ctx: { agent: Agent, player?: string }): z.infer<S>
  /** Builds the scored behaviour for these options. */
  create? (options: z.infer<S>, env: BehaviorEnv): BehaviorBody
  /** A per-tick hook instead of (or besides) a behaviour, e.g. greetings in chat. */
  hook? (options: z.infer<S>, env: BehaviorEnv): NpcHook
}

/** Identity helper that keeps the options type flowing into create/prepare. */
export function defineBehavior<S extends z.ZodObject> (def: BehaviorDefinition<S>): BehaviorDefinition<S> {
  return def
}
