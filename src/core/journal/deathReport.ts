// Why the bot died, as facts: the server's death message when there is one, who hurt it in the
// last seconds, what it was doing, its health before the killing hit. The adapter feeds a
// DeathCauseTracker per session and emits `deathCause` once the cause is known (the server
// message arrives a moment before or after the death event); hooks ({cause}) and the LLM brain's
// death event use it instead of guessing. Game-agnostic and pure (test/death-report.test.ts).
import type { GameAdapter } from '../adapter.ts'
import type { DeathInfo } from './deathMessages.ts'

export interface DeathReport {
  /** Short cause for chat: "slain by Zombie", "fell from a high place", "drowned", "lava", "unknown cause". */
  cause: string
  /** Category from the death message (slain, shot, explosion, fall, lava, drowning, starvation...) or the last damage source. */
  kind: string
  killer?: string
  weapon?: string
  /** The server's death message as sent. */
  message?: string
  /** Damage sources in the last seconds before death, newest first, without repeats (mob names, fall, lava, starvation...). */
  recentDamage: string[]
  /** Hostiles close by at death. */
  nearby: string[]
  /** Action that held the body ("defend", "upgrade_tools"). */
  action?: string
  healthBefore?: number
  position?: { x: number, y: number, z: number }
  /** One line with all of the above, for the LLM and logs. */
  summary: string
}

export interface DeathContext {
  action?: string
  healthBefore?: number
  nearby?: string[]
  position?: { x: number, y: number, z: number }
}

/** "Pax was slain by Zombie" -> "slain by Zombie"; "Pax drowned" -> "drowned". */
export function causeFromMessage (message: string, victim?: string): string {
  let rest = message.trim()
  if (victim && rest.startsWith(victim + ' ')) rest = rest.slice(victim.length + 1)
  else rest = rest.replace(/^\S+ /, '')
  return rest.replace(/^was /, '')
}

const KIND_TEXT: Record<string, string> = {
  fall: 'fell', lava: 'burned in lava', fire: 'burned', drowning: 'drowned', starvation: 'starved',
  suffocation: 'suffocated in a wall', void: 'fell out of the world', explosion: 'blown up', freeze: 'froze'
}

/** Builds the report from what is known. Pure. */
export function buildDeathReport (info: DeathInfo | null, recent: string[], ctx: DeathContext): DeathReport {
  const kind = info?.cause ?? recent[0] ?? 'unknown'
  let cause: string
  if (info) cause = causeFromMessage(info.message, info.victim)
  else if (recent[0]) cause = KIND_TEXT[recent[0]] ?? `killed by ${recent[0]} (no death message, last hit)`
  else cause = 'unknown cause'
  const r: Omit<DeathReport, 'summary'> = {
    cause, kind,
    ...(info?.killer ? { killer: info.killer } : {}),
    ...(info?.weapon ? { weapon: info.weapon } : {}),
    ...(info?.message ? { message: info.message } : {}),
    recentDamage: recent,
    nearby: ctx.nearby ?? [],
    ...(ctx.action ? { action: ctx.action } : {}),
    ...(ctx.healthBefore !== undefined ? { healthBefore: Math.round(ctx.healthBefore * 10) / 10 } : {}),
    ...(ctx.position ? { position: ctx.position } : {})
  }
  return { ...r, summary: describeDeath(r) }
}

/** One line of facts: cause, the server message, recent damage, nearby hostiles, action, health, place. */
export function describeDeath (r: Omit<DeathReport, 'summary'>): string {
  const parts = [r.message ? `${r.cause} (server: "${r.message}")` : r.cause]
  if (r.recentDamage.length) parts.push(`hurt by ${r.recentDamage.join(', ')} in the last seconds`)
  if (r.nearby.length) parts.push(`hostiles close by: ${r.nearby.join(', ')}`)
  if (r.action) parts.push(`was doing ${r.action}`)
  if (r.healthBefore !== undefined) parts.push(`health ${r.healthBefore} before the last hit`)
  if (r.position) parts.push(`at ${Math.floor(r.position.x)} ${Math.floor(r.position.y)} ${Math.floor(r.position.z)}`)
  return parts.join('; ')
}

export interface TrackerOptions {
  /** How long to wait for the server's death message after the death event (ms). Default 3000. */
  waitMs?: number
  /** Damage this recent counts (ms). Default 15000. */
  windowMs?: number
  now?: () => number
}

/**
 * Collects damage sources and the server's death message; on a death, emits one report as soon
 * as the message is there (it may come first) or after waitMs without it.
 */
export class DeathCauseTracker {
  private readonly waitMs: number
  private readonly windowMs: number
  private readonly now: () => number
  private hits: { source: string, at: number }[] = []
  private message: { info: DeathInfo, at: number } | null = null
  private pending: { ctx: DeathContext, at: number, emit: (r: DeathReport) => void, timer: ReturnType<typeof setTimeout> } | null = null

  constructor (o: TrackerOptions = {}) {
    this.waitMs = o.waitMs ?? 3000
    this.windowMs = o.windowMs ?? 15_000
    this.now = o.now ?? Date.now
  }

  /** The bot took damage from `source` (mob name, player, fall, lava, starvation, unknown). */
  hurt (source: string): void {
    const t = this.now()
    this.hits.push({ source, at: t })
    this.hits = this.hits.filter(h => t - h.at <= this.windowMs).slice(-20)
  }

  /** The server announced the bot's own death. */
  serverDeath (info: DeathInfo): void {
    if (this.pending) { this.finish(info); return }
    this.message = { info, at: this.now() }
  }

  /** The bot died; `emit` gets the report once. */
  died (ctx: DeathContext, emit: (r: DeathReport) => void): void {
    if (this.pending) return
    const at = this.now()
    const early = this.message && at - this.message.at <= this.waitMs ? this.message.info : null
    this.message = null
    this.pending = { ctx, at, emit, timer: setTimeout(() => this.finish(null), this.waitMs) }
    ;(this.pending.timer as { unref?: () => void }).unref?.()
    // async even when the message came first: listeners of the death event run before the report
    if (early) setTimeout(() => this.finish(early), 0)
  }

  /** Damage sources before `at`, newest first, without repeats. */
  recent (at = this.now()): string[] {
    const out: string[] = []
    for (const h of [...this.hits].reverse()) {
      if (at - h.at > this.windowMs || h.at > at + 50) continue
      if (h.source !== 'unknown' && !out.includes(h.source)) out.push(h.source)
    }
    return out
  }

  private finish (info: DeathInfo | null): void {
    const p = this.pending
    if (!p) return
    clearTimeout(p.timer)
    this.pending = null
    const report = buildDeathReport(info, this.recent(p.at), p.ctx)
    this.hits = []
    p.emit(report)
  }

  dispose (): void {
    if (this.pending) clearTimeout(this.pending.timer)
    this.pending = null
  }
}

/**
 * Calls fn once per death with the report: from the adapter's `deathCause` event, or (an
 * adapter that doesn't send one) a report with an unknown cause after waitMs. `pos` is where the
 * bot was at the death event (it has respawned by the time fn runs). Returns the unsubscribe.
 */
export function onDeathReport (game: Pick<GameAdapter, 'on' | 'off' | 'self'>, fn: (r: DeathReport, pos: { x: number, y: number, z: number } | null) => void, waitMs = 4000): () => void {
  let pending: { pos: { x: number, y: number, z: number } | null, timer: ReturnType<typeof setTimeout> } | null = null
  const fire = (r: DeathReport) => {
    const pos = pending?.pos ?? r.position ?? null
    if (pending) clearTimeout(pending.timer)
    pending = null
    fn(r, pos)
  }
  const onDeath = () => {
    if (pending) return
    let pos: { x: number, y: number, z: number } | null = null
    try { const p = game.self()?.position; pos = p ? { x: p.x, y: p.y, z: p.z } : null } catch {}
    const timer = setTimeout(() => fire(buildDeathReport(null, [], pos ? { position: pos } : {})), waitMs)
    ;(timer as { unref?: () => void }).unref?.()
    pending = { pos, timer }
  }
  const onCause = (r: DeathReport) => fire(r)
  game.on('death', onDeath)
  game.on('deathCause', onCause)
  return () => {
    game.off('death', onDeath)
    game.off('deathCause', onCause)
    if (pending) clearTimeout(pending.timer)
    pending = null
  }
}
