// Turns a program into NPC brain behaviours, so it runs inside the existing NpcController and
// inherits its scoring, hysteresis, failure cooldowns and back-off (a player, LLM or reflex
// holding the body makes ctx.act throw NpcYield and the whole brain waits).
//
//   rules    -> one Behavior each: score while `when` holds, run = the routine
//   triggers -> fired triggers go into a TriggerQueue; one extra Behavior ("triggers")
//               scores the best pending priority and runs the queued routine
import { fail, PRIORITY, distance, type Agent, type GameAdapter, type SeenEntity } from '../../core/index.ts'
import { getPlaces } from '../../skills/navigation.ts'
import type { NpcWorldView } from '../npc/blackboard.ts'
import type { Behavior, BehaviorContext, NpcContext, Blackboard } from '../npc/index.ts'
import { NpcYield } from '../npc/index.ts'
import type { Program, Scalar, Trigger } from './format.ts'
import { CapExceeded, ChatLimiter, ProgramMemory, RoutineFailed, evalCond, runRoutine, stepsOf, type Host, type RunEnv, type World } from './interpreter.ts'

export const TRIGGER_BEHAVIOR = 'triggers'

interface Pending { trigger: Trigger, player?: string, at: number }

/** Fired triggers waiting for the body. Entries expire so a stale greeting isn't run minutes later. */
export class TriggerQueue {
  private items: Pending[] = []
  private readonly maxAgeMs: number
  private readonly max: number

  constructor (opts: { maxAgeMs?: number, max?: number } = {}) {
    this.maxAgeMs = opts.maxAgeMs ?? 30_000
    this.max = opts.max ?? 5
  }

  push (p: Pending): void {
    if (this.items.some(i => i.trigger.name === p.trigger.name && i.player === p.player)) return
    this.items.push(p)
    if (this.items.length > this.max) this.items.shift()
  }

  private prune (now: number): void {
    this.items = this.items.filter(i => now - i.at <= this.maxAgeMs)
  }

  /** Best pending priority, 0 when empty. */
  peek (now: number): number {
    this.prune(now)
    return Math.max(0, ...this.items.map(i => i.trigger.priority ?? 60))
  }

  take (now: number): Pending | undefined {
    this.prune(now)
    if (!this.items.length) return undefined
    let best = 0
    this.items.forEach((it, i) => { if ((it.trigger.priority ?? 60) > (this.items[best]!.trigger.priority ?? 60)) best = i })
    return this.items.splice(best, 1)[0]
  }

  get size (): number { return this.items.length }
  clear (): void { this.items = [] }
}

export type Outcome = 'ok' | 'fail' | 'yield' | 'aborted'

export interface CompileDeps {
  program: Program
  memory: ProgramMemory
  chat: ChatLimiter
  queue: TriggerQueue
  /** Builds the fact view for a tick or a run. */
  world (ctx: NpcContext): World
  /** Rule/trigger outcomes for experience counters. */
  onOutcome? (kind: 'rule' | 'trigger', name: string, outcome: Outcome, detail: string): void
  random? (): number
  now? (): number
}

function host (ctx: BehaviorContext, deps: CompileDeps): Host {
  return {
    act: (name, params) => ctx.act(name, params),
    say: (t) => ctx.agent.say(t),
    whisper: (to, t) => ctx.agent.whisper(to, t),
    wait: (ms) => ctx.wait(ms),
    now: deps.now ?? Date.now,
    random: deps.random ?? Math.random,
    signal: ctx.signal
  }
}

async function execute (kind: 'rule' | 'trigger', name: string, steps: Program['routines'][string], ctx: BehaviorContext, deps: CompileDeps, player?: string) {
  const env: RunEnv = {
    program: deps.program,
    world: deps.world(ctx),
    memory: deps.memory,
    host: host(ctx, deps),
    chat: deps.chat,
    player: player ?? ctx.bb.facts.nearestPlayer?.name,
    bot: ctx.agent.username
  }
  try {
    const r = await runRoutine(steps, env)
    deps.onOutcome?.(kind, name, 'ok', r)
    return r
  } catch (e) {
    if (e instanceof RoutineFailed || e instanceof CapExceeded) {
      deps.onOutcome?.(kind, name, 'fail', e.message)
      return fail(e.message)
    }
    deps.onOutcome?.(kind, name, e instanceof NpcYield ? 'yield' : 'aborted', (e as Error).message)
    throw e
  }
}

/** Behaviours for the NPC controller. */
export function compile (deps: CompileDeps): Behavior[] {
  const p = deps.program
  const scoreHost = (ctx: NpcContext) => ({ now: () => ctx.now, random: deps.random ?? Math.random }) as Host
  const behaviors: Behavior[] = p.rules.map(rule => ({
    name: rule.name,
    cooldownMs: rule.cooldownMs,
    failureCooldownMs: rule.failureCooldownMs ?? 10_000,
    score: (ctx) => {
      if (ctx.current === rule.name) return rule.score // a running rule finishes its routine
      if (!rule.when) return rule.score
      return evalCond(rule.when, { world: deps.world(ctx), memory: deps.memory, host: scoreHost(ctx) }) ? rule.score : 0
    },
    run: (ctx) => execute('rule', rule.name, stepsOf(p, rule.do), ctx, deps)
  }))
  if (p.triggers.length) {
    let running = 0
    behaviors.push({
      name: TRIGGER_BEHAVIOR,
      score: (ctx) => ctx.current === TRIGGER_BEHAVIOR ? running : deps.queue.peek(ctx.now),
      async run (ctx) {
        const item = deps.queue.take(Date.now())
        if (!item) return 'nothing queued'
        running = item.trigger.priority ?? 60
        return execute('trigger', item.trigger.name, stepsOf(p, item.trigger.do), ctx, deps, item.player)
      }
    })
  }
  return behaviors
}

/** Live fact view over the blackboard, the game (the agent's adapter) and the agent's stored places. */
export function liveWorld (agent: Agent, view: NpcWorldView & Pick<GameAdapter, 'playerPosition'>, bb: Blackboard, memory: ProgramMemory): World {
  const f = bb.facts
  const self = view.self()
  const pos = self?.position
  const count = (pred: (e: SeenEntity) => boolean) => pos
    ? (view.entities?.() ?? []).filter(e => pred(e) && e.distance <= 16).length
    : 0
  return {
    fact (name): Scalar | undefined {
      switch (name) {
        case 'health': return typeof self?.health === 'number' ? Math.round(self.health) : 20
        case 'food': return typeof self?.food === 'number' ? self.food : 20
        case 'timeOfDay': return f.timeOfDay
        case 'isNight': return f.isNight
        case 'isDay': return !f.isNight
        case 'sleeping': return f.sleeping
        case 'busy': return (agent.currentAction?.priority ?? 0) > PRIORITY.npc
        case 'homeDistance': return f.homeDistance === null ? -1 : Math.round(f.homeDistance)
        case 'playersNearby': return count(e => e.type === 'player' && e.username !== self?.username)
        case 'hostilesNearby': return count(e => e.type === 'hostile')
        case 'nearestPlayer.name': return f.nearestPlayer?.name ?? ''
        case 'nearestPlayer.distance': return f.nearestPlayer ? Math.round(f.nearestPlayer.distance) : -1
        case 'nearestHostile.name': return f.nearestHostile?.name ?? ''
        case 'nearestHostile.distance': return f.nearestHostile ? Math.round(f.nearestHostile.distance) : -1
      }
      const [ns, ...rest] = name.split('.')
      const key = rest.join('.')
      if (ns === 'need') return bb.need(key)
      if (ns === 'var') return memory.get(key)
      if (ns === 'inventory') {
        try { return (view.inventory?.().items ?? []).filter(i => i.label === key).reduce((n, i) => n + i.count, 0) } catch { return 0 }
      }
      if (ns === 'place') {
        const pl = getPlaces(agent)[key.toLowerCase()]
        if (!pl || !pos || (pl.dimension && pl.dimension !== self?.game.dimension)) return -1
        return Math.round(Math.hypot(pos.x - pl.x, pos.y - pl.y, pos.z - pl.z))
      }
      return undefined
    },
    playerDistance (name) {
      const p = view.playerPosition?.(name)
      return p && pos ? distance(pos, p) : undefined
    }
  }
}
