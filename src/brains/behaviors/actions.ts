// behavior_* actions: list, status, arm, disarm, configure, reset. Non-exclusive, so they
// work while the bot is busy. Every non-internal action is also an LLM tool and a !command,
// which is how chat, LLM brains, hooks.yaml and self-improver programs arm behaviours.
import { z } from 'zod'
import { defineAction, ok, fail, type Agent, type ActionContext, type ActionResult } from '../../core/index.ts'
import type { BehaviorRuntime } from './runtime.ts'
import type { BehaviorRegistry, Options } from './registry.ts'

const runtimes = new WeakMap<Agent, BehaviorRuntime>()

export function attachRuntime (agent: Agent, rt: BehaviorRuntime): void {
  runtimes.set(agent, rt)
}

export function runtimeFor (agent: Agent): BehaviorRuntime | undefined {
  return runtimes.get(agent)
}

/** Only owners change behaviours: chat callers and players an LLM/hook acts for must be owners. */
export function changeDenied (ctx: Pick<ActionContext, 'agent' | 'caller' | 'player'>): string | null {
  if (ctx.caller.kind === 'player' && !ctx.agent.isOwner(ctx.caller.name)) return 'only my owners can change my behaviours'
  if (ctx.player && !ctx.agent.isOwner(ctx.player)) return `only my owners can change my behaviours (asked for ${ctx.player})`
  return null
}

export function callerLabel (ctx: Pick<ActionContext, 'caller' | 'player'>): string {
  const base = `${ctx.caller.kind}:${ctx.caller.name}`
  return ctx.player && ctx.caller.kind !== 'player' ? `${base} for ${ctx.player}` : base
}

interface JsonProp { type?: string | string[], description?: string, default?: unknown, enum?: unknown[], items?: { enum?: unknown[], type?: string } }

/** "radius=12 (how far...)" lines for one behaviour's options. */
export function describeOptions (registry: BehaviorRegistry, name: string, withHelp = true): string[] {
  const schema = z.toJSONSchema(registry.schema(name), { io: 'input' }) as { properties?: Record<string, JsonProp> }
  return Object.entries(schema.properties ?? {}).filter(([k]) => k !== 'priority').map(([k, p]) => {
    const d = p.default !== undefined ? JSON.stringify(p.default) : p.enum ? p.enum.join('|') : '-'
    return withHelp && p.description ? `${k}=${d} (${p.description})` : `${k}=${d}`
  })
}

/** Short "key=value" summary of options that differ from the defaults. */
export function fmtOptions (registry: BehaviorRegistry, name: string, options: Options): string {
  const d = registry.validate(name, {})
  const defaults = d.ok ? d.options : {}
  const parts = Object.entries(options)
    .filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(defaults[k]))
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
  return parts.join(' ')
}

function need (agent: Agent): BehaviorRuntime | ActionResult {
  return runtimes.get(agent) ?? fail('this bot has no behaviours brain')
}

const nameParam = z.string().min(1).describe('behaviour name from behavior_list, e.g. keep_fed')
const optionsParam = z.union([z.record(z.string(), z.unknown()), z.string()]).optional()
  .describe('options as an object, e.g. {"below": 10}; in chat as key=value pairs, e.g. below=10 animals=cow,pig')

export const behaviorList = defineAction({
  name: 'behavior_list',
  description: 'List the behaviours this bot can arm: armed behaviours keep running on their own between your turns ' +
    '(keep_fed finds and eats food, stay_safe backs off at low health, follow_owner, guard_area, farm_loop...). ' +
    'Pass a name for its options and defaults.',
  params: z.object({ name: z.string().optional().describe('one behaviour to explain in detail') }),
  exclusive: false,
  run ({ agent, caller }, { name }) {
    const rt = need(agent)
    if (!('registry' in rt)) return rt
    const reg = rt.registry
    const summary = reg.list().map(d => ({ name: d.name, category: d.category, armed: rt.store.isArmed(d.name) }))
    if (!name && caller.kind === 'player') {
      // chat is short: names by category, details on request
      const cats = [...new Set(summary.map(d => d.category))]
      const text = cats.map(c => `${c}: ${summary.filter(d => d.category === c).map(d => d.name + (d.armed ? '*' : '')).join(', ')}`).join('; ')
      return ok(`behaviours (* = armed) ${text}. behavior_list <name> for details`, summary)
    }
    if (name) {
      const def = reg.get(name)
      if (!def) return fail(reg.unknown(name))
      const opts = describeOptions(reg, name)
      return ok(`${name} [${def.category}, ${rt.store.isArmed(name) ? 'armed' : 'not armed'}]: ${def.description} Options: ${opts.join('; ') || 'none'}`,
        { name, category: def.category, armed: rt.store.isArmed(name), options: opts })
    }
    const lines = reg.list().map(d => `${d.name}${rt.store.isArmed(d.name) ? '*' : ''}: ${d.description.split(/(?<=\.)\s/)[0]} [${describeOptions(reg, d.name, false).join(' ') || 'no options'}]`)
    return ok(`behaviours (* = armed): ${lines.join(' | ')}`, summary)
  }
})

export const behaviorStatus = defineAction({
  name: 'behavior_status',
  description: 'Show which behaviours are armed, their options, what is running now, last outcomes and cooldowns.',
  params: z.object({}),
  exclusive: false,
  run ({ agent }) {
    const rt = need(agent)
    if (!('registry' in rt)) return rt
    const s = rt.status() as { armed: { name: string, options: Options, skipped?: string, cooldown?: number, last?: string | null }[], running: string | null, runningFor: number, paused: { seconds: number, by: string | null } | null }
    if (!s.armed.length) return ok('no behaviours armed (see behavior_list)', s)
    const armed = s.armed.map(a => {
      const o = fmtOptions(rt.registry, a.name, a.options)
      const extra = [o, a.skipped ? `skipped: ${a.skipped}` : '', a.cooldown ? `cooldown ${a.cooldown}s` : '', a.last ? `last ${a.last}` : ''].filter(Boolean).join(', ')
      return extra ? `${a.name} (${extra})` : a.name
    })
    const run = s.running ? `running ${s.running} ${s.runningFor}s` : 'running nothing'
    const paused = s.paused ? `, backing off ${s.paused.seconds}s for ${s.paused.by ?? '?'}` : ''
    const asked = (s as { askedForHelp?: { behavior: string, reason: string, minutesAgo: number, sorted: boolean }[] }).askedForHelp ?? []
    const help = asked.length ? ` | asked for help: ${asked.map(a => `${a.behavior} (${a.reason}, ${a.minutesAgo}m ago${a.sorted ? ', sorted' : ''})`).join('; ')}` : ''
    return ok(`armed: ${armed.join('; ')} | ${run}${paused}${help}`, s)
  }
})

function armLike (kind: 'arm' | 'configure') {
  return async (ctx: ActionContext, p: { name: string, options?: unknown }): Promise<ActionResult> => {
    const rt = need(ctx.agent)
    if (!('registry' in rt)) return rt
    const denied = changeDenied(ctx)
    if (denied) return fail(denied)
    const name = p.name.trim().toLowerCase()
    const def = rt.registry.get(name)
    if (!def) return fail(rt.registry.unknown(name))
    const coerced = rt.registry.coerce(name, p.options)
    if (typeof coerced === 'string') return fail(coerced)
    let options: Options = coerced
    if (def.prepare && kind === 'arm') {
      const v = rt.registry.validate(name, { ...rt.store.options(name), ...options })
      if (!v.ok) return fail(v.error)
      const prepared = def.prepare(v.options as any, { agent: ctx.agent, player: ctx.player }) as Options
      // keep only what prepare added or changed, so later configs still apply to the rest
      for (const [k, val] of Object.entries(prepared)) if (JSON.stringify(val) !== JSON.stringify(v.options[k])) options = { ...options, [k]: val }
    }
    const by = callerLabel(ctx)
    const r = kind === 'arm' ? rt.store.arm(name, options, by) : rt.store.configure(name, options, by)
    if (!r.ok) return fail(r.message)
    const why = rt.build().skipped[name]
    rt.log.info(`${r.message}`, { behavior: name, by, options: fmtOptions(rt.registry, name, r.options) || undefined })
    const opts = fmtOptions(rt.registry, name, r.options)
    const msg = `${r.message}${opts ? ` (${opts})` : ''}`
    return why ? fail(`${msg}, but it can't run: ${why}`) : ok(msg, { name, options: r.options })
  }
}

export const behaviorArm = defineAction({
  name: 'behavior_arm',
  description: 'Arm a behaviour so it keeps running on its own, without further turns, until disarmed (it survives restarts). ' +
    'Arm keep_fed so you look after your own food, stay_safe to back off at low health, follow_owner or guard_owner ' +
    'to stay with your owner, guard_area to defend a spot, farm_loop / chop_wood_loop for ongoing chores. ' +
    'Prefer this over doing an ongoing job turn by turn.',
  params: z.object({ name: nameParam, options: optionsParam }),
  exclusive: false,
  run: armLike('arm')
})

export const behaviorConfigure = defineAction({
  name: 'behavior_configure',
  description: 'Change the options of a behaviour (armed or not) without arming or disarming it, e.g. keep_fed below=10.',
  params: z.object({ name: nameParam, options: optionsParam }),
  exclusive: false,
  run: armLike('configure')
})

export const behaviorDisarm = defineAction({
  name: 'behavior_disarm',
  description: 'Switch an armed behaviour off (stops it now if it is running). It stays off across restarts.',
  params: z.object({ name: nameParam }),
  exclusive: false,
  run (ctx, { name }) {
    const rt = need(ctx.agent)
    if (!('registry' in rt)) return rt
    const denied = changeDenied(ctx)
    if (denied) return fail(denied)
    const r = rt.store.disarm(name.trim().toLowerCase(), callerLabel(ctx))
    if (!r.ok) return fail(r.message)
    rt.log.info(r.message, { behavior: name, by: callerLabel(ctx) })
    return ok(r.message)
  }
})

export const behaviorReset = defineAction({
  name: 'behavior_reset',
  description: 'Forget runtime arm/disarm/configure changes and go back to the profile\'s behaviours (one, or all without a name).',
  params: z.object({ name: z.string().optional().describe('behaviour to reset; default all') }),
  exclusive: false,
  run (ctx, { name }) {
    const rt = need(ctx.agent)
    if (!('registry' in rt)) return rt
    const denied = changeDenied(ctx)
    if (denied) return fail(denied)
    const r = rt.store.reset(name?.trim().toLowerCase())
    return r.ok ? ok(r.message) : fail(r.message)
  }
})

export const behaviorActions = [behaviorList, behaviorStatus, behaviorArm, behaviorDisarm, behaviorConfigure, behaviorReset]
