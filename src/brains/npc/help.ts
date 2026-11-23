// "Stuck, ask for help": a behaviour that keeps failing for the same reason tells its owners
// once, instead of backing off and looping for hours. Game-agnostic: it only talks through
// agent.whisper/say, records a `help` journal event and emits `askHelp` for the LLM brain.
//
//   askHelp: { enabled: true, failures: 3, minutes: 10 }   # profile key, lands in settings.askHelp
//
// One HelpDesk per agent (helpDesk(agent)), shared by every NPC controller on it and by
// behaviours that ask on their own (keep_fed's starving report), so they share the rate limits.
// See docs/guide/behaviors.md#asking-for-help.
import type { Agent } from '../../core/index.ts'
import type { NpcContext } from './types.ts'

export interface HelpOptions {
  /** Escalate repeated failures at all. Default false (profiles turn it on). */
  enabled: boolean
  /** Failures of the same kind before asking. Default 3. */
  failures: number
  /** ...spread over at least this many minutes. Default 10. */
  minutes: number
  /** A failure kind with no new failure for this long starts over. Default 120. */
  forgetMinutes: number
  /** At most one message per reason (behaviour + normalized failure) this often. Default 60. */
  perReasonMinutes: number
  /** At most this many help messages per hour in total. Default 3. */
  maxPerHour: number
  /** owners: whisper the owners who are online; say: public chat. Default owners. */
  tell: 'owners' | 'say'
  /** Let an LLM brain know (an event in its memory; a turn only with llm triggers.events.stuck). Default true. */
  llm: boolean
  /** Say "sorted, thanks" once when a behaviour it asked about succeeds again. Default false. */
  thanks: boolean
  /** Local hours [from, to) with no messages (e.g. [23, 7]); asks wait until after. Default none. */
  quietHours: [number, number] | null
  /** How long an ask shows in observe and npc_status. Default 60. */
  observeMinutes: number
}

export const HELP_DEFAULTS: HelpOptions = {
  enabled: false,
  failures: 3,
  minutes: 10,
  forgetMinutes: 120,
  perReasonMinutes: 60,
  maxPerHour: 3,
  tell: 'owners',
  llm: true,
  thanks: false,
  quietHours: null,
  observeMinutes: 60
}

const num = (v: unknown, fb: number, min: number, max: number): number => {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fb
}

/**
 * settings.askHelp: true/false or an options map. Only `true` or `enabled: true` turns it on: a map
 * without it (`!config_set askHelp.failures 5` on a bot that never asked) tunes it but stays off.
 * Unknown or bad values fall back to defaults.
 */
export function resolveHelpOptions (settings: Record<string, unknown> | undefined): HelpOptions {
  const raw = settings?.askHelp
  if (raw === undefined || raw === null || raw === false) return { ...HELP_DEFAULTS }
  if (raw === true) return { ...HELP_DEFAULTS, enabled: true }
  if (typeof raw !== 'object') return { ...HELP_DEFAULTS }
  const r = raw as Record<string, unknown>
  const quiet = Array.isArray(r.quietHours) && r.quietHours.length === 2 && r.quietHours.every(h => typeof h === 'number')
    ? [num(r.quietHours[0], 0, 0, 24), num(r.quietHours[1], 0, 0, 24)] as [number, number]
    : null
  return {
    enabled: r.enabled === true,
    failures: Math.round(num(r.failures, HELP_DEFAULTS.failures, 1, 100)),
    minutes: num(r.minutes, HELP_DEFAULTS.minutes, 0, 1440),
    forgetMinutes: num(r.forgetMinutes, HELP_DEFAULTS.forgetMinutes, 1, 10_080),
    perReasonMinutes: num(r.perReasonMinutes, HELP_DEFAULTS.perReasonMinutes, 1, 10_080),
    maxPerHour: Math.round(num(r.maxPerHour, HELP_DEFAULTS.maxPerHour, 0, 60)),
    tell: r.tell === 'say' ? 'say' : 'owners',
    llm: r.llm !== false,
    thanks: r.thanks === true,
    quietHours: quiet,
    observeMinutes: num(r.observeMinutes, HELP_DEFAULTS.observeMinutes, 1, 1440)
  }
}

/**
 * The failure message without numbers, coordinates, bracketed details, later clauses and quoting, so "no natural tree within 32
 * blocks" and "... within 64 blocks" are the same kind of failure.
 */
export function normalizeReason (message: string): string {
  return String(message ?? '')
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ') // details in brackets: "(have 2 planks)"
    .split(/;|\s\u2014\s|\s-\s/)[0]!                // the first clause: "...; looking again in 5 min"
    .replace(/["'`]/g, '')
    .replace(/-?\d+(?:\.\d+)?/g, '#')
    .replace(/#(?:[\s,/x]+#)+/g, '#')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.:;,!-]+|[\s.:;,!-]+$/g, '')
    .slice(0, 80) || 'failed'
}

/** One kind of repeated failure, as the behaviour's help hook sees it. */
export interface Failure {
  behavior: string
  /** Normalized reason (normalizeReason). */
  key: string
  /** The last failure message as it came. */
  reason: string
  /** Up to 3 distinct recent messages, oldest first. */
  messages: string[]
  count: number
  firstAt: number
  lastAt: number
}

/** What a behaviour's help hook may return: the "what would help" text, or more. */
export type HelpText = string | {
  /** What would help, e.g. "a few logs or planks in my chest". */
  help?: string
  /** What it was trying to do, e.g. "upgrade my tools". */
  goal?: string
  /** What it already tried. Default: "N tries over M min". */
  tried?: string
}

/** An escalation, as recorded and shown. */
export interface HelpAsk {
  behavior: string
  key: string
  reason: string
  goal: string
  tried: string
  help: string | null
  text: string
  failures: number
  at: number
  /** Who was told: player names, 'chat' for public chat, [] when nobody could be told. */
  to: string[]
  /** Set once the behaviour succeeded again. */
  sortedAt?: number
}

/** What the desk needs of an agent (an Agent fits; tests pass a fake). */
export type HelpAgent = Partial<Pick<Agent, 'whisper' | 'say' | 'owners' | 'settings' | 'storage' | 'journal' | 'log' | 'adapter'>> & {
  emit?: (ev: any, ...a: any[]) => unknown
}

/** A behaviour as the desk sees it. */
export interface HelpSource {
  name: string
  goal?: string
  help? (ctx: NpcContext | undefined, failure: Failure): HelpText | null | undefined
}

interface Track { key: string, reason: string, messages: string[], count: number, firstAt: number, lastAt: number }

const SENT_KEY = 'askHelp.sent'
const HOUR = 3_600_000

export class HelpDesk {
  private readonly agent: HelpAgent
  /** Open failure kinds per behaviour. */
  private readonly tracks = new Map<string, Map<string, Track>>()
  /** Asks (and explicit reports) of the last while, newest last. */
  private asks: HelpAsk[] = []

  constructor (agent: HelpAgent) {
    this.agent = agent
    // remember what was sent before a restart, so a reconnect loop doesn't whisper again
    try {
      const saved = agent.storage?.get<HelpAsk[] | undefined>(SENT_KEY)
      if (Array.isArray(saved)) this.asks = saved.filter(a => a && typeof a.at === 'number')
    } catch {}
  }

  options (): HelpOptions {
    return resolveHelpOptions(this.agent.settings as Record<string, unknown> | undefined)
  }

  /**
   * A behaviour run failed. Tracks it by normalized reason; once `failures` of the same kind span
   * `minutes`, asks for help (rate limits permitting) and returns the ask.
   */
  failure (source: HelpSource, message: string, now: number, ctx?: NpcContext): HelpAsk | null {
    const o = this.options()
    const key = normalizeReason(message)
    let byKey = this.tracks.get(source.name)
    if (!byKey) { byKey = new Map(); this.tracks.set(source.name, byKey) }
    let t = byKey.get(key)
    if (t && now - t.lastAt > o.forgetMinutes * 60_000) t = undefined
    if (!t) { t = { key, reason: message, messages: [], count: 0, firstAt: now, lastAt: now }; byKey.set(key, t) }
    t.count++
    t.lastAt = now
    t.reason = message
    if (!t.messages.includes(message)) t.messages = [...t.messages, message].slice(-3)
    if (!o.enabled) return null
    if (t.count < o.failures || now - t.firstAt < o.minutes * 60_000) return null
    if (this.recentlyAsked(source.name, key, now, o)) return null
    const failure: Failure = { behavior: source.name, key, reason: message, messages: [...t.messages], count: t.count, firstAt: t.firstAt, lastAt: t.lastAt }
    let hint: HelpText | null | undefined
    try { hint = source.help?.(ctx, failure) } catch (e) { this.agent.log?.debug(`help ${source.name}: ${(e as Error).message}`) }
    if (hint === null) return null // the behaviour reports this itself (keep_fed)
    const h = typeof hint === 'string' ? { help: hint } : hint ?? {}
    const goal = h.goal ?? source.goal ?? source.name.replace(/_/g, ' ')
    const tried = h.tried ?? `${t.count} tries over ${Math.max(1, Math.round((now - t.firstAt) / 60_000))} min`
    const help = h.help ?? null
    const text = helpMessage({ goal, reason: message, tried, help })
    return this.send({ behavior: source.name, key, reason: message, goal, tried, help, text, failures: t.count, at: now, to: [] }, now, o, false)
  }

  /**
   * A behaviour asks on its own (keep_fed when starving). Shares the per-reason and hourly limits
   * with the failure escalations, and goes out even when askHelp is off (the behaviour has its own
   * switch). `fallbackSay`: say it in public chat when no owner is online.
   */
  ask (req: { behavior: string, reason: string, text: string, key?: string, goal?: string, help?: string, fallbackSay?: boolean }, now: number): HelpAsk | null {
    const o = this.options()
    const key = req.key ?? normalizeReason(req.reason)
    if (this.recentlyAsked(req.behavior, key, now, o)) return null
    const ask: HelpAsk = { behavior: req.behavior, key, reason: req.reason, goal: req.goal ?? req.behavior.replace(/_/g, ' '), tried: '', help: req.help ?? null, text: req.text, failures: 0, at: now, to: [] }
    return this.send(ask, now, o, true, req.fallbackSay)
  }

  /** A behaviour run succeeded: its failures are over; says thanks once if it had asked (askHelp.thanks). */
  success (name: string, now: number): HelpAsk | null {
    this.tracks.delete(name)
    const o = this.options()
    const open = this.asks.filter(a => a.behavior === name && !a.sortedAt && a.to.length && now - a.at < o.observeMinutes * 60_000)
    if (!open.length) return null
    for (const a of open) a.sortedAt = now
    const last = open.at(-1)!
    this.save()
    this.agent.journal?.record('help', { status: 'sorted', behavior: name, reason: last.reason, goal: last.goal, minutes: Math.round((now - last.at) / 60_000) })
    if (o.thanks && !this.quiet(now, o)) {
      const text = `sorted: ${last.goal} works again, thanks`
      for (const to of last.to) to === 'chat' ? this.agent.say?.(text) : this.agent.whisper?.(to, text)
    }
    if (o.llm) this.emit('helpSorted', { ...last })
    return last
  }

  /** Asks of the last observeMinutes, for observe and npc_status. */
  recent (now: number): HelpAsk[] {
    const o = this.options()
    return this.asks.filter(a => now - a.at < o.observeMinutes * 60_000)
  }

  /** The open failure kinds (for status/debugging). */
  open (): Failure[] {
    const out: Failure[] = []
    for (const [behavior, byKey] of this.tracks) for (const t of byKey.values()) out.push({ behavior, key: t.key, reason: t.reason, messages: t.messages, count: t.count, firstAt: t.firstAt, lastAt: t.lastAt })
    return out
  }

  /** Short view of the recent asks for observe(): "keep_tools_upgraded: could not make sticks (asked 12m ago)". */
  observeView (now: number): { behavior: string, reason: string, help: string | null, minutesAgo: number, sorted: boolean, told: string[] }[] {
    return this.recent(now).map(a => ({ behavior: a.behavior, reason: a.reason, help: a.help, minutesAgo: Math.round((now - a.at) / 60_000), sorted: !!a.sortedAt, told: a.to }))
  }

  private recentlyAsked (behavior: string, key: string, now: number, o: HelpOptions): boolean {
    // per reason, and per behaviour: one ask covers every way the same behaviour is stuck for a while
    return this.asks.some(a => a.to.length && now - a.at < o.perReasonMinutes * 60_000 && a.behavior === behavior && (a.key === key || !a.sortedAt))
  }

  private quiet (now: number, o: HelpOptions): boolean {
    if (!o.quietHours) return false
    const [from, to] = o.quietHours
    const h = new Date(now).getHours()
    return from <= to ? h >= from && h < to : h >= from || h < to
  }

  /** Who to tell: online owners (by their in-game names), or 'chat'. */
  private recipients (o: HelpOptions, fallbackSay: boolean): string[] {
    if (o.tell === 'say') return ['chat']
    const owners = this.agent.owners ?? []
    let online: string[] = []
    try { online = this.agent.adapter?.players?.() ?? [] } catch {}
    const self = this.agent.adapter?.self?.()?.username?.toLowerCase()
    const names = online.filter(n => owners.includes(n.toLowerCase()) && n.toLowerCase() !== self)
    if (names.length) return names
    return fallbackSay ? ['chat'] : []
  }

  private send (ask: HelpAsk, now: number, o: HelpOptions, explicit: boolean, fallbackSay = false): HelpAsk | null {
    if (this.quiet(now, o) && !explicit) return null
    const sentLastHour = this.asks.filter(a => a.to.length && now - a.at < HOUR).length
    if (sentLastHour >= o.maxPerHour && !(explicit && !o.enabled)) {
      this.agent.log?.debug(`askHelp: hourly cap reached, not asking about ${ask.behavior} (${ask.reason})`)
      return null
    }
    const to = this.recipients(o, fallbackSay)
    if (!to.length) {
      // nobody to tell right now: the next failure tries again
      this.agent.log?.debug(`askHelp: no owner online to tell about ${ask.behavior} (${ask.reason})`)
      return null
    }
    for (const name of to) name === 'chat' ? this.agent.say?.(ask.text) : this.agent.whisper?.(name, ask.text)
    ask.to = to
    this.asks = [...this.asks.filter(a => now - a.at < Math.max(HOUR, o.perReasonMinutes * 60_000, o.observeMinutes * 60_000)), ask]
    this.save()
    this.agent.log?.info(`asked for help: ${ask.text}`, { behavior: ask.behavior, to: to.join(',') })
    this.agent.journal?.record('help', {
      status: 'asked', behavior: ask.behavior, reason: ask.reason, goal: ask.goal, ...(ask.help ? { help: ask.help } : {}),
      ...(ask.failures ? { failures: ask.failures } : {}), ...(ask.tried ? { tried: ask.tried } : {}), to, message: ask.text
    })
    if (o.llm) this.emit('askHelp', { ...ask })
    return ask
  }

  private emit (ev: string, ask: HelpAsk): void {
    try { this.agent.emit?.(ev, ask) } catch {}
  }

  private save (): void {
    try { this.agent.storage?.set(SENT_KEY, this.asks) } catch {}
  }
}

/** "Stuck on upgrade my tools: could not make sticks (5 tries over 23 min). A few logs or planks in my chest would help." */
export function helpMessage (p: { goal: string, reason: string, tried?: string, help?: string | null }): string {
  const help = p.help ? ` ${p.help.charAt(0).toUpperCase()}${p.help.slice(1)} would help.` : ' Any idea?'
  const tried = p.tried ? ` (${p.tried})` : ''
  // one chat line: a whisper is split past ~240 characters (with the /msg prefix), and the tail
  // ("... would help.") arrived as a line of its own; the reason gives way, the ask stays whole
  const room = Math.max(40, Math.min(120, HELP_MAX_CHARS - `Stuck trying to ${p.goal}: .`.length - tried.length - help.length))
  const reason = p.reason.length > room ? p.reason.slice(0, room - 1).trimEnd() + '…' : p.reason
  return `Stuck trying to ${p.goal}: ${reason}${tried}.${help}`
}

/** Longest help message, so a whisper ("/msg <name> " + text) stays one chat line. */
export const HELP_MAX_CHARS = 210

const desks = new WeakMap<object, HelpDesk>()

/** The agent's help desk (created on first use). */
export function helpDesk (agent: HelpAgent): HelpDesk {
  let d = desks.get(agent)
  if (!d) { d = new HelpDesk(agent); desks.set(agent, d) }
  return d
}
