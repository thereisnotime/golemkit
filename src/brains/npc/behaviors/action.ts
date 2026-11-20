// Turn any action into a behaviour with a scoring function. Use this for actions that may
// or may not exist in a bot (chop_tree, harvest, deposit...): the behaviour scores 0 when
// the action isn't registered, so bots degrade gracefully.
import type { Behavior, NpcContext } from '../types.ts'

export interface ActionBehaviorOptions {
  /** Behaviour name; defaults to the action name. */
  name?: string
  cooldownMs?: number
  failureCooldownMs?: number
  maxFailureCooldownMs?: number
  /** Other actions that must exist too. */
  requires?: string[]
}

export function actionBehavior (
  action: string,
  params: Record<string, unknown> | ((ctx: NpcContext) => Record<string, unknown>),
  score: number | ((ctx: NpcContext) => number),
  opts: ActionBehaviorOptions = {}
): Behavior {
  return {
    name: opts.name ?? action,
    requires: [action, ...(opts.requires ?? [])],
    cooldownMs: opts.cooldownMs,
    failureCooldownMs: opts.failureCooldownMs,
    maxFailureCooldownMs: opts.maxFailureCooldownMs,
    score: (ctx) => typeof score === 'number' ? score : score(ctx),
    run: (ctx) => ctx.act(action, typeof params === 'function' ? params(ctx) : params)
  }
}
