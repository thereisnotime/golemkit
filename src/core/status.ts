// "Is it working, and if not, why": the status snapshot every bot keeps (src/core/statusTracker.ts
// fills it) and the pure parts: when a bot counts as stuck, what the stuck alert and the chat line
// say, and how the CLI prints a status file. Game-agnostic: positions, health and food come from
// agent.adapter.self(), decisions from the NPC controllers' snapshot().
//
//   status: { file: true, intervalMs: 5000, alert: true, stuckAlertMs: 600000 }   # profile key
//
// See docs/guide/status.md.

/** settings.status, resolved. */
export interface StatusOptions {
  /** Write <dataDir>/status.json every intervalMs, for `node src/cli.ts status`. Default true. */
  file: boolean
  /** How often the status is sampled (progress, stuck check) and the file rewritten. Default 5000. */
  intervalMs: number
  /** Whisper the online owners when the bot is stuck. Default true. */
  alert: boolean
  /** No progress for this long while it wants to do something counts as stuck. Default 10 min. */
  stuckAlertMs: number
  /** Repeat alerts back off (stuckAlertMs, then doubling) up to this gap. Default 2 h. */
  alertMaxMs: number
}

export const STATUS_DEFAULTS: StatusOptions = {
  file: true,
  intervalMs: 5000,
  alert: true,
  stuckAlertMs: 600_000,
  alertMaxMs: 7_200_000
}

const num = (v: unknown, fb: number, min: number, max: number): number => {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fb
}

/** settings.status: true/false or an options map; bad values fall back to the defaults. */
export function resolveStatusOptions (settings: Record<string, unknown> | undefined): StatusOptions {
  const raw = settings?.status
  if (raw === false) return { ...STATUS_DEFAULTS, file: false, alert: false }
  if (!raw || typeof raw !== 'object') return { ...STATUS_DEFAULTS }
  const r = raw as Record<string, unknown>
  return {
    file: r.file !== false,
    intervalMs: Math.round(num(r.intervalMs, STATUS_DEFAULTS.intervalMs, 1000, 600_000)),
    alert: r.alert !== false,
    stuckAlertMs: Math.round(num(r.stuckAlertMs, STATUS_DEFAULTS.stuckAlertMs, 60_000, 86_400_000)),
    alertMaxMs: Math.round(num(r.alertMaxMs, STATUS_DEFAULTS.alertMaxMs, 60_000, 7 * 86_400_000))
  }
}

/**
 * What a decision loop (an NPC controller) reports about itself: NpcController.snapshot().
 * Times are epoch ms. The optional fields at the end are filled by loops that know them (needs and
 * goals); the status shows them when present.
 */
export interface DeciderSnapshot {
  /** The loop's caller name (npc, behaviors, self). */
  name: string
  /** Running behaviour, its start, the score that picked it and its priority. */
  behavior: string | null
  startedAt: number | null
  score: number | null
  priority: number | null
  /** Someone else holding the body ("kind:name@priority"), or null. */
  holder: string | null
  /** Backing off after another caller took the body. */
  paused: { until: number, by: string | null } | null
  /** While set, nothing runs (a scene the bot acts in). */
  suspended: string | null
  /** Nothing running since then (set on the first idle tick), or null while something runs. */
  idleSince: number | null
  /** The last tick's scores, highest first. */
  scores: { name: string, score: number }[]
  /** Behaviours on a cooldown: when it ends and failures in a row (0 = a normal cooldown after a run). */
  cooling: { name: string, until: number, failures: number }[]
  lastFailure: { behavior: string, message: string, at: number } | null
  lastSuccess: { behavior: string, message: string, at: number } | null
  /** The current need (hunger, shelter, ...), goal and why it picked what it runs, when the loop has them. */
  need?: string | null
  goal?: string | null
  reason?: string | null
  /** The loop's own idea of the last progress (items gained, distance toward a goal). */
  lastProgressAt?: number | null
  /** The last running behaviour something else took over: by another behaviour or a caller that took the body. */
  lastTakeover?: { from: string, by: string, why: string, at: number, ranMs: number } | null
  /** The newest need search (a running one says 'started'): how it ended and what took over. */
  lastSearch?: { need: string, at: number, ms: number | null, ok: boolean, message: string, cut: boolean, by: string | null, why: string | null } | null
}

export type StatusState = 'offline' | 'working' | 'busy' | 'idle' | 'stuck'

export interface DoingView {
  action: string
  /** "kind:name" */
  caller: string
  priority: number
  since: number | null
  longRunning: boolean
}

/** The snapshot in status.json and behind the chat line. Times are epoch ms. */
export interface BotStatus {
  version: 1
  bot: string
  profile: string | null
  pid: number
  updatedAt: number
  startedAt: number
  intervalMs: number
  connected: boolean
  /** working: something runs or progress is recent; busy: a long-running order (follow, guard);
   * idle: nothing wants to run; stuck: it wants to but has made no progress for stuckAlertMs. */
  state: StatusState
  /** One line, what chat gets. */
  summary: string
  /** What it is trying (action or behaviour), or null. */
  trying: string | null
  /** Why that, or why nothing runs. */
  why: string
  /** For stuck: what stops it (the last failure, a holder, a back-off). */
  blocker: string | null
  doing: DoingView | null
  deciders: DeciderSnapshot[]
  need: string | null
  goal: string | null
  progress: { at: number | null, what: string | null, quietMs: number }
  lastFailure: { what: string, message: string, at: number } | null
  self: { position: { x: number, y: number, z: number } | null, dimension: string | null, health: number | null, food: number | null } | null
  alert: { count: number, lastAt: number | null, nextAt: number | null }
  stuckAlertMs: number
  lastDisconnect: string | null
  /** Resident set size of the process, MB. */
  rssMb: number | null
}

export interface AssessInput {
  now: number
  connected: boolean
  /** Last progress (action ok, items gained, moved), or null. */
  progressAt: number | null
  /** Session start: no progress is counted before it. */
  baselineAt: number
  stuckAlertMs: number
  doing: DoingView | null
  deciders: DeciderSnapshot[]
  lastFailure: { what: string, message: string, at: number } | null
}

export interface Assessment {
  state: StatusState
  quietMs: number
  trying: string | null
  why: string
  blocker: string | null
  need: string | null
  goal: string | null
}

/** "45s", "12m", "3h 5m". */
export function fmtDuration (ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 90) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 90) return `${m}m`
  const h = Math.floor(m / 60)
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
}

/** Why a decision loop runs nothing right now, or null when something runs. */
export function idleReason (d: DeciderSnapshot, now: number): string | null {
  if (d.behavior) return null
  if (d.suspended) return `suspended: ${d.suspended}`
  if (d.holder) return `body held by ${d.holder}`
  if (d.paused && d.paused.until > now) return `backing off ${fmtDuration(d.paused.until - now)} for ${d.paused.by ?? 'someone'}`
  if (d.reason) return d.reason
  const failing = d.cooling.filter(c => c.failures > 0 && c.until > now)
  if (failing.length) {
    const f = failing[0]!
    const msg = d.lastFailure?.behavior === f.name ? `: ${d.lastFailure.message}` : ''
    return `${failing.map(c => `${c.name} cooling ${fmtDuration(c.until - now)}`).join(', ')} after failing${msg}`
  }
  const wanted = d.scores.filter(s => s.score > 0)
  if (wanted.length) return `waiting to start ${wanted[0]!.name} (${Math.round(wanted[0]!.score)})`
  const cooling = d.cooling.filter(c => c.until > now)
  if (cooling.length) return `nothing to do; ${cooling.map(c => `${c.name} again in ${fmtDuration(c.until - now)}`).join(', ')}`
  return 'nothing wants to run (every behaviour scored 0)'
}

/** Is it working, idle, busy or stuck, and why. Pure. */
export function assess (i: AssessInput): Assessment {
  const need = i.deciders.find(d => d.need)?.need ?? null
  const goal = i.deciders.find(d => d.goal)?.goal ?? null
  const quietMs = Math.max(0, i.now - Math.max(i.progressAt ?? 0, i.baselineAt))
  if (!i.connected) return { state: 'offline', quietMs, trying: null, why: 'not connected', blocker: null, need, goal }

  const running = i.deciders.find(d => d.behavior)
  const failingBehaviour = i.deciders.flatMap(d => d.cooling.filter(c => c.failures > 0 && c.until > i.now).map(c => c.name))[0] ?? null
  // a behaviour running one of its actions: "chop_wood_loop: chop_tree"
  const own = running && i.doing?.caller === `brain:${running.name}`
  const trying = own
    ? `${running.behavior}: ${i.doing!.action}`
    : i.doing ? `${i.doing.action} (${i.doing.caller})` : running?.behavior ?? goal ?? need ?? failingBehaviour
  let why: string
  if (running) {
    why = running.reason ?? `${running.behavior} scored ${Math.round(running.score ?? 0)}${running.name !== 'npc' ? ` on ${running.name}` : ''}`
  } else if (i.doing) {
    why = `${i.doing.caller} asked for it`
  } else if (i.deciders.length) {
    why = i.deciders.map(d => idleReason(d, i.now)).filter(Boolean).join('; ') || 'nothing to do'
  } else {
    why = 'waiting for orders (no decision loop)'
  }

  // a failure since the last progress is what stops it
  const freshFailure = i.lastFailure && i.lastFailure.at >= Math.max(i.progressAt ?? 0, i.baselineAt) ? i.lastFailure : null
  const wants = !!i.doing || !!running || !!failingBehaviour || !!need || !!goal || !!freshFailure
  let state: StatusState
  if (i.doing?.longRunning) state = 'busy'
  else if (quietMs < i.stuckAlertMs) state = i.doing || running ? 'working' : 'idle'
  else state = wants ? 'stuck' : 'idle'

  let blocker: string | null = null
  if (state === 'stuck') {
    const held = i.deciders.find(d => d.holder || d.suspended || (d.paused && d.paused.until > i.now))
    const idle = running ? null : i.deciders.map(d => idleReason(d, i.now)).find(r => r && !/^nothing/.test(r))
    blocker = freshFailure
      ? `${freshFailure.what}: ${freshFailure.message}`
      : held ? idleReason({ ...held, behavior: null }, i.now) : idle ?? `no progress for ${fmtDuration(quietMs)}`
  }
  return { state, quietMs, trying, why, blocker, need, goal }
}

export interface AlertState {
  /** Alerts sent since it last made progress. */
  count: number
  lastAt: number | null
}

/**
 * Whether to send the stuck alert now: once when it becomes stuck, then again after
 * stuckAlertMs, 2x, 4x ... up to alertMaxMs while it stays stuck. Progress (any state but
 * stuck and busy-with-an-order) resets the back-off. Pure.
 */
export function alertDue (state: AlertState, a: Pick<Assessment, 'state'>, o: Pick<StatusOptions, 'alert' | 'stuckAlertMs' | 'alertMaxMs'>, now: number): { send: boolean, reset: boolean, nextAt: number | null } {
  if (a.state !== 'stuck') return { send: false, reset: a.state !== 'offline', nextAt: null }
  if (!o.alert) return { send: false, reset: false, nextAt: null }
  if (!state.count || state.lastAt === null) return { send: true, reset: false, nextAt: now }
  const gap = Math.min(o.alertMaxMs, o.stuckAlertMs * 2 ** (state.count - 1))
  const nextAt = state.lastAt + gap
  return { send: now >= nextAt, reset: false, nextAt }
}

const clip = (s: string, n: number): string => s.length > n ? s.slice(0, n - 1) + '…' : s

/** The whisper for a stuck bot: what it tries, what stops it, for how long. */
export function alertText (s: Pick<BotStatus, 'trying' | 'blocker' | 'progress' | 'goal' | 'need' | 'why'>): string {
  const aim = s.goal ? ` (goal: ${s.goal})` : s.need ? ` (need: ${s.need})` : ''
  return clip(`Stuck for ${fmtDuration(s.progress.quietMs)}: trying ${s.trying ?? 'something'}${aim}, ${s.blocker ? `can't: ${s.blocker}` : s.why}. Say "status" for more.`, 240)
}

/** The short chat line: state and what, why, last progress, health. */
export function chatLine (s: Omit<BotStatus, 'summary'>, now = s.updatedAt): string {
  if (!s.connected) return 'not connected'
  const doing = s.doing
    ? `doing ${s.doing.action} (${s.doing.caller}${s.doing.since ? `, ${fmtDuration(now - s.doing.since)}` : ''})`
    : s.trying ? `on ${s.trying}` : 'idle'
  const head = s.state === 'stuck' ? `STUCK ${fmtDuration(s.progress.quietMs)}, ${doing}` : doing
  const why = s.state === 'stuck' && s.blocker ? `can't: ${s.blocker}` : `why: ${s.why}`
  const aim = [s.need ? `need ${s.need}` : '', s.goal ? `goal ${s.goal}` : ''].filter(Boolean).join(', ')
  const prog = s.progress.at ? `progress ${fmtDuration(now - s.progress.at)} ago${s.progress.what ? ` (${s.progress.what})` : ''}` : 'no progress yet'
  const hp = s.self && s.self.health !== null ? `hp ${Math.round(s.self.health)}${s.self.food !== null ? ` food ${s.self.food}` : ''}` : ''
  return clip([head, why, aim, prog, hp].filter(Boolean).join(' | '), 240)
}

/** A status file is stale (the bot is not running) after this long without an update. */
export function staleAfter (s: Pick<BotStatus, 'intervalMs'>): number {
  return Math.max(15_000, 3 * s.intervalMs)
}

/** One need search for the status: "gear 4m ago, cut short after 12s by pickup_items (pickup_items 41 > need:gear 30)". */
export function searchLine (ls: NonNullable<DeciderSnapshot['lastSearch']>, now: number): string {
  const when = `${ls.need} ${fmtDuration(now - ls.at)} ago`
  if (ls.message === 'started' && ls.ms === null) return `${when}, running`
  const took = ls.ms !== null ? ` after ${fmtDuration(ls.ms)}` : ''
  const how = ls.ok ? `found it${took}: ${ls.message}` : ls.cut ? `cut short${took}` : `failed${took}: ${ls.message}`
  return `${when}, ${how}${ls.by ? ` by ${ls.by}${ls.why ? ` (${ls.why})` : ''}` : ''}`
}

/** Several lines for the CLI. */
export function formatStatus (s: BotStatus, now: number): string[] {
  const age = now - s.updatedAt
  const pos = s.self?.position ? `${Math.round(s.self.position.x)} ${Math.round(s.self.position.y)} ${Math.round(s.self.position.z)}${s.self.dimension ? ` (${s.self.dimension.replace(/^minecraft:/, '')})` : ''}` : '?'
  const lines = [`${s.bot}${s.profile ? ` (profile ${s.profile})` : ''}: ${age > staleAfter(s) ? `NOT RUNNING, last update ${fmtDuration(age)} ago (state then: ${s.state})` : s.state.toUpperCase()}`]
  if (s.doing) lines.push(`  doing     ${s.doing.action} by ${s.doing.caller} at priority ${s.doing.priority}${s.doing.since ? ` for ${fmtDuration(s.updatedAt - s.doing.since)}` : ''}`)
  for (const d of s.deciders) {
    const what = d.behavior
      ? `${d.behavior} (score ${Math.round(d.score ?? 0)}, priority ${d.priority ?? '?'}${d.startedAt ? `, ${fmtDuration(s.updatedAt - d.startedAt)}` : ''})`
      : `idle${d.idleSince ? ` ${fmtDuration(s.updatedAt - d.idleSince)}` : ''}: ${idleReason(d, s.updatedAt)}`
    lines.push(`  ${d.name.padEnd(9)} ${what}`)
    const top = d.scores.filter(x => x.score > 0).slice(0, 5).map(x => `${x.name} ${Math.round(x.score)}`).join(', ')
    if (top) lines.push(`            scores: ${top}`)
    const ls = d.lastSearch
    if (ls) lines.push(`            search: ${searchLine(ls, s.updatedAt)}`)
    const t = d.lastTakeover
    if (t) lines.push(`            taken over: ${t.from} after ${fmtDuration(t.ranMs)} by ${t.by} (${t.why}), ${fmtDuration(s.updatedAt - t.at)} ago`)
  }
  if (s.trying) lines.push(`  trying    ${s.trying}`)
  lines.push(`  why       ${s.why}`)
  if (s.blocker) lines.push(`  blocker   ${s.blocker}`)
  if (s.need) lines.push(`  need      ${s.need}`)
  if (s.goal) lines.push(`  goal      ${s.goal}`)
  lines.push(`  progress  ${s.progress.at ? `${fmtDuration(s.updatedAt - s.progress.at)} ago${s.progress.what ? ` (${s.progress.what})` : ''}` : 'none yet'}; stuck alert after ${fmtDuration(s.stuckAlertMs)}`)
  if (s.lastFailure) lines.push(`  failed    ${fmtDuration(s.updatedAt - s.lastFailure.at)} ago: ${s.lastFailure.what}: ${s.lastFailure.message}`)
  if (s.self) lines.push(`  self      hp ${s.self.health === null ? '?' : Math.round(s.self.health)} food ${s.self.food ?? '?'} at ${pos}`)
  if (s.alert.count) lines.push(`  alerts    ${s.alert.count} sent, last ${s.alert.lastAt ? fmtDuration(s.updatedAt - s.alert.lastAt) + ' ago' : '?'}`)
  if (!s.connected && s.lastDisconnect) lines.push(`  offline   ${s.lastDisconnect}`)
  lines.push(`  process   pid ${s.pid}${s.rssMb !== null ? `, rss ${s.rssMb} MB` : ''}, up ${fmtDuration(s.updatedAt - s.startedAt)}`)
  return lines
}
