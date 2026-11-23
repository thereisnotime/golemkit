// hooks.yaml: deterministic event -> action rules, run without the LLM by the hooks brain
// (src/brains/hooks.ts). A hook only references catalog actions and chat/memory steps; no
// code from the file is ever executed. Templates are plain {name} substitutions.
//
//   hooks:
//     - id: eat-when-low
//       on: lowHealth            # spawn | death | playerJoined | playerLeft | chat | hurt |
//       below: 8                 #   lowHealth | actionFailed | timer | llmBudgetExhausted
//       when: { hasFood: true }  # conditions, all must hold
//       cooldown: 30s
//       do:
//         - act: eat
//         - say: backing off     # or whisper: { to: owners, text: ... } / remember: ...
import YAML from 'yaml'
import { z } from 'zod'
import type { ActionResult, Logger } from '../core/index.ts'
import { PRIORITY } from '../core/index.ts'

/** Hooks act above the LLM (30) and NPC loops, below player commands (50) and reflexes (60): PRIORITY.hook. */
export const HOOK_PRIORITY = PRIORITY.hook

export const HOOK_EVENTS = ['spawn', 'death', 'playerJoined', 'playerLeft', 'chat', 'hurt', 'lowHealth', 'actionFailed', 'timer', 'llmBudgetExhausted'] as const
export type HookEventType = typeof HOOK_EVENTS[number]

const Duration = z.union([z.number().nonnegative(), z.string().regex(/^\s*\d+(\.\d+)?\s*(ms|s|m|h)?\s*$/)])
const Cmp = z.union([z.number(), z.string().regex(/^\s*(<=|>=|<|>|==|!=)?\s*-?\d+(\.\d+)?\s*$/)])
const OneOrMany = z.union([z.string(), z.array(z.string())])

const StepSchema = z.union([
  z.object({
    act: z.string().min(1),
    params: z.record(z.string(), z.unknown()).optional(),
    priority: z.union([z.number(), z.enum(['npc', 'llm', 'player'])]).optional()
  }).strict(),
  z.object({ say: z.string().min(1) }).strict(),
  z.object({ whisper: z.object({ to: z.string().min(1).default('player'), text: z.string().min(1) }) }).strict(),
  z.object({ remember: z.union([z.string().min(1), z.object({ text: z.string().min(1), about: z.string().optional() })]) }).strict()
])
export type HookStep = z.infer<typeof StepSchema>

const WhenSchema = z.object({
  health: Cmp.optional(),
  food: Cmp.optional(),
  hasItem: OneOrMany.optional(),
  hasFood: z.boolean().optional(),
  idle: z.boolean().optional(),
  isDay: z.boolean().optional(),
  player: OneOrMany.optional(),
  isOwner: z.boolean().optional(),
  ownerOnline: z.boolean().optional()
}).strict()
export type HookWhen = z.infer<typeof WhenSchema>

export const HookSchema = z.object({
  id: z.string().optional(),
  on: z.enum(HOOK_EVENTS),
  enabled: z.boolean().default(true),
  // event filters
  match: z.string().optional().describe('chat: regex on the message (case-insensitive); actionFailed: regex on the error'),
  whisper: z.boolean().optional().describe('chat: only whispers (true) or only public chat (false)'),
  action: OneOrMany.optional().describe('actionFailed: action name(s)'),
  below: z.number().optional().describe('lowHealth: threshold, default 8'),
  every: Duration.optional().describe('timer: interval, at least 5s'),
  includeOwn: z.boolean().optional().describe('actionFailed: also react to failures of actions hooks started'),
  ownerOnly: z.boolean().default(false).describe('only when the event player is an owner'),
  when: WhenSchema.optional(),
  cooldown: Duration.optional(),
  once: z.union([z.boolean(), z.enum(['session', 'forever'])]).optional(),
  do: z.array(StepSchema).min(1)
}).strict()
export type Hook = z.infer<typeof HookSchema> & { id: string }

export const HooksFileSchema = z.object({ hooks: z.array(HookSchema).default([]) }).strict()

export function parseDuration (d: number | string | undefined, fallback = 0): number {
  if (d === undefined) return fallback
  if (typeof d === 'number') return d
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/.exec(d)
  if (!m) return fallback
  const n = Number(m[1])
  return Math.round(n * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] as 'ms' ?? 'ms'] ?? 1))
}

/** Parses hooks.yaml text. Invalid files throw with a readable message; bad regexes become warnings. */
export function parseHooks (text: string, catalog?: string[]): { hooks: Hook[], warnings: string[] } {
  const raw = YAML.parse(text) ?? {}
  const parsed = HooksFileSchema.safeParse(raw)
  if (!parsed.success) throw new Error(z.prettifyError(parsed.error).replace(/\n/g, '; '))
  const warnings: string[] = []
  const known = catalog ? new Set(catalog) : null
  const hooks: Hook[] = []
  parsed.data.hooks.forEach((h, i) => {
    const id = h.id ?? `${h.on}#${i + 1}`
    if (h.match) {
      try { new RegExp(h.match, 'i') } catch (e) { warnings.push(`hook ${id}: bad regex (${(e as Error).message}), disabled`); return }
    }
    if (h.on === 'timer' && parseDuration(h.every) < 5000) { warnings.push(`hook ${id}: timer needs every >= 5s, disabled`); return }
    if (known) {
      for (const s of h.do) if ('act' in s && !known.has(s.act)) warnings.push(`hook ${id}: unknown action ${s.act}`)
      for (const a of [h.action ?? []].flat()) if (!known.has(a)) warnings.push(`hook ${id}: actionFailed filter names unknown action ${a}`)
    }
    hooks.push({ ...h, id })
  })
  return { hooks, warnings }
}

// ------------------------------------------------------------------ engine

export interface HookState {
  health?: number
  food?: number
  inventory?: Record<string, number>
  /** Number of edible items carried. */
  foodItems?: number
  position?: string
  isDay?: boolean
  idle?: boolean
  players?: string[]
}

export interface HookEvent {
  type: HookEventType
  player?: string
  message?: string
  whisper?: boolean
  health?: number
  action?: string
  error?: string
  reason?: string
  /** timer: which hook's timer fired. */
  hookId?: string
  /** actionFailed: the failed action was started by the hooks brain. */
  own?: boolean
  /** Event-time values for templates (e.g. death position), override state. */
  vars?: Record<string, string | number>
}

/** What the engine needs from the bot. The hooks brain adapts an Agent; tests pass a fake. */
export interface HookHost {
  username: string
  owners: string[]
  isOwner (player: string): boolean
  state (): HookState
  act (name: string, params: Record<string, unknown>, priority: number, player?: string): Promise<ActionResult>
  say (text: string): void
  whisper (to: string, text: string): void
  remember (text: string, about?: string): void
  log: Logger
}

export interface HookFiring {
  hook: string
  event: HookEventType
  steps: { step: string, ok: boolean, message?: string }[]
}

export class HookEngine {
  private hooks: Hook[] = []
  private readonly host: HookHost
  private readonly now: () => number
  private lastFired = new Map<string, number>()
  private firedSession = new Set<string>()
  private firedForever = new Set<string>()
  private healthArmed = new Map<string, boolean>()
  readonly history: HookFiring[] = []

  constructor (host: HookHost, hooks: Hook[] = [], now: () => number = Date.now) {
    this.host = host
    this.now = now
    this.setHooks(hooks)
  }

  setHooks (hooks: Hook[]): void {
    this.hooks = hooks.filter(h => h.enabled)
  }

  get list (): Hook[] {
    return this.hooks
  }

  /** New session (respawn after reconnect): `once: session` hooks may fire again. */
  resetSession (): void {
    this.firedSession.clear()
    this.healthArmed.clear()
  }

  /** Feeds an event; runs every matching hook in file order. */
  async emit (ev: HookEvent): Promise<HookFiring[]> {
    const out: HookFiring[] = []
    for (const h of this.hooks) {
      if (!this.matches(h, ev)) continue
      const f = await this.fire(h, ev)
      out.push(f)
    }
    return out
  }

  /** lowHealth is edge-triggered: call on every health update; it fires once per drop below the threshold. */
  async health (health: number): Promise<HookFiring[]> {
    const due: Hook[] = []
    for (const h of this.hooks) {
      if (h.on !== 'lowHealth') continue
      const below = h.below ?? 8
      const armed = this.healthArmed.get(h.id) ?? true
      if (armed && health < below) { this.healthArmed.set(h.id, false); due.push(h) } else if (!armed && health >= below + 2) this.healthArmed.set(h.id, true)
    }
    const out: HookFiring[] = []
    for (const h of due) {
      const ev: HookEvent = { type: 'lowHealth', health }
      if (this.passes(h, ev)) out.push(await this.fire(h, ev))
    }
    return out
  }

  private matches (h: Hook, ev: HookEvent): boolean {
    if (h.on !== ev.type || h.on === 'lowHealth') return false
    switch (ev.type) {
      case 'chat':
        if (h.whisper !== undefined && h.whisper !== !!ev.whisper) return false
        if (h.match && !new RegExp(h.match, 'i').test(ev.message ?? '')) return false
        break
      case 'actionFailed':
        if (ev.own && !h.includeOwn) return false
        if (h.action && ![h.action].flat().includes(ev.action ?? '')) return false
        if (h.match && !new RegExp(h.match, 'i').test(ev.error ?? '')) return false
        break
      case 'timer':
        if (ev.hookId !== h.id) return false
        break
    }
    return this.passes(h, ev)
  }

  /** Owner flag, conditions, cooldown and once. */
  private passes (h: Hook, ev: HookEvent): boolean {
    if (h.ownerOnly && (!ev.player || !this.host.isOwner(ev.player))) return false
    const once = h.once === true ? 'session' : h.once || undefined
    if (once === 'session' && this.firedSession.has(h.id)) return false
    if (once === 'forever' && this.firedForever.has(h.id)) return false
    const cd = parseDuration(h.cooldown)
    if (cd > 0 && this.now() - (this.lastFired.get(h.id) ?? -Infinity) < cd) return false
    if (h.when && !this.conditions(h.when, ev)) return false
    return true
  }

  conditions (w: HookWhen, ev: HookEvent): boolean {
    const s = this.host.state()
    if (w.health !== undefined && !compare(ev.health ?? s.health, w.health)) return false
    if (w.food !== undefined && !compare(s.food, w.food)) return false
    if (w.hasItem !== undefined) {
      const inv = s.inventory ?? {}
      if (![w.hasItem].flat().some(i => (inv[i] ?? 0) > 0)) return false
    }
    if (w.hasFood !== undefined && ((s.foodItems ?? 0) > 0) !== w.hasFood) return false
    if (w.idle !== undefined && !!s.idle !== w.idle) return false
    if (w.isDay !== undefined && !!s.isDay !== w.isDay) return false
    if (w.player !== undefined && ![w.player].flat().map(p => p.toLowerCase()).includes((ev.player ?? '').toLowerCase())) return false
    if (w.isOwner !== undefined && (!!ev.player && this.host.isOwner(ev.player)) !== w.isOwner) return false
    if (w.ownerOnline !== undefined) {
      const online = (s.players ?? []).some(p => this.host.owners.includes(p.toLowerCase()))
      if (online !== w.ownerOnline) return false
    }
    return true
  }

  private async fire (h: Hook, ev: HookEvent): Promise<HookFiring> {
    this.lastFired.set(h.id, this.now())
    this.firedSession.add(h.id)
    this.firedForever.add(h.id)
    const vars = this.vars(h, ev)
    const firing: HookFiring = { hook: h.id, event: ev.type, steps: [] }
    for (const step of h.do) {
      try {
        if ('act' in step) {
          const params = substituteDeep(step.params ?? {}, vars) as Record<string, unknown>
          const pr = typeof step.priority === 'number' ? step.priority : step.priority ? PRIORITY[step.priority] : HOOK_PRIORITY
          const r = await this.host.act(step.act, params, pr, ev.player)
          firing.steps.push({ step: `act ${step.act}`, ok: r.ok, message: r.message })
          if (!r.ok) break // later steps usually depend on this one ("eat, then say I'm fine")
        } else if ('say' in step) {
          this.host.say(template(step.say, vars))
          firing.steps.push({ step: 'say', ok: true })
        } else if ('whisper' in step) {
          const text = template(step.whisper.text, vars)
          const to = this.recipients(step.whisper.to, ev)
          if (!to.length) { firing.steps.push({ step: 'whisper', ok: false, message: `no recipient for "${step.whisper.to}"` }); continue }
          for (const p of to) this.host.whisper(p, text)
          firing.steps.push({ step: `whisper ${to.join(',')}`, ok: true })
        } else if ('remember' in step) {
          const r = typeof step.remember === 'string' ? { text: step.remember } : step.remember
          this.host.remember(template(r.text, vars), r.about ? template(r.about, vars) : undefined)
          firing.steps.push({ step: 'remember', ok: true })
        }
      } catch (e) {
        firing.steps.push({ step: Object.keys(step)[0]!, ok: false, message: (e as Error).message })
        break
      }
    }
    this.history.push(firing)
    if (this.history.length > 50) this.history.shift()
    this.host.log.info(`hook ${h.id} fired on ${ev.type}`, { hook: h.id, event: ev.type, player: ev.player, steps: firing.steps.map(s => `${s.step}${s.ok ? '' : '!'}`).join(' ') })
    return firing
  }

  /** `owners` = owners who are online (all owners if the online list is unknown); `player` = the event's player. */
  private recipients (to: string, ev: HookEvent): string[] {
    if (to === 'player') return ev.player ? [ev.player] : []
    if (to === 'owner' || to === 'owners') {
      const online = this.host.state().players
      const list = online ? online.filter(p => this.host.owners.includes(p.toLowerCase())) : this.host.owners
      return list
    }
    return [to]
  }

  private vars (h: Hook, ev: HookEvent): Record<string, string | number> {
    const s = this.host.state()
    const v: Record<string, string | number> = {
      bot: this.host.username,
      owner: this.host.owners[0] ?? '',
      player: ev.player ?? '',
      message: ev.message ?? '',
      action: ev.action ?? '',
      error: ev.error ?? '',
      reason: ev.reason ?? '',
      health: ev.health ?? s.health ?? '',
      food: s.food ?? '',
      pos: s.position ?? 'unknown position'
    }
    // chat: regex capture groups as {1}, {2}, ...
    if (ev.type === 'chat' && h.match) {
      const m = new RegExp(h.match, 'i').exec(ev.message ?? '')
      m?.slice(1).forEach((g, i) => { v[String(i + 1)] = g ?? '' })
    }
    return { ...v, ...ev.vars }
  }
}

function compare (value: number | undefined, spec: number | string): boolean {
  if (value === undefined) return false
  if (typeof spec === 'number') return value === spec
  const m = /^\s*(<=|>=|<|>|==|!=)?\s*(-?\d+(?:\.\d+)?)\s*$/.exec(spec)
  if (!m) return false
  const n = Number(m[2])
  switch (m[1] ?? '==') {
    case '<': return value < n
    case '<=': return value <= n
    case '>': return value > n
    case '>=': return value >= n
    case '!=': return value !== n
    default: return value === n
  }
}

export function template (s: string, vars: Record<string, string | number>): string {
  return s.replace(/\{(\w+)\}/g, (all, k: string) => (k in vars ? fmtVar(vars[k]) : all))
}

function substituteDeep (v: unknown, vars: Record<string, string | number>): unknown {
  if (typeof v === 'string') {
    // A param that is exactly one placeholder keeps the variable's type ("{health}" -> 6).
    const only = /^\{(\w+)\}$/.exec(v)
    if (only && only[1]! in vars) return vars[only[1]!]
    return template(v, vars)
  }
  if (Array.isArray(v)) return v.map(x => substituteDeep(x, vars))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substituteDeep(x, vars)]))
  return v
}

/** Numbers in chat templates: whole numbers as-is, anything else rounded ("6.1666" -> "6"). */
function fmtVar (v: unknown): string {
  if (typeof v !== 'number' || Number.isInteger(v)) return String(v)
  return v > 0 && v < 0.5 ? '<1' : String(Math.round(v)) // 0.3 health isn't 0
}
