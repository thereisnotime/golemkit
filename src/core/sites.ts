// Site health: the places a bot depends on (a farm, its bed, a chest, a mine, home) are checked
// when it uses them. Flooded, gone or unsafe marks a site bad at once; unreachable or "no work"
// after a few checks in a row. Bad sites are persisted with the reason and time, the adapter
// replaces them or the owners are told, and they are looked at again now and then because
// players fix things. Game-agnostic: the adapter supplies the checks (src/brains/npc/needs.ts).
import { sitesSettings, type SitesSettings } from './needs.ts'
import type { Agent } from './agent.ts'

/** What a check found wrong. hard: bad at once; soft: bad after `failures` in a row. */
export type SiteFault = 'flooded' | 'gone' | 'unsafe' | 'unreachable' | 'no_work'
export const HARD_FAULTS: readonly SiteFault[] = ['flooded', 'gone', 'unsafe']

export interface SitePos { x: number, y: number, z: number, dim?: string }

/** A site as the adapter lists it. `id` is unique per kind ("farm:1", "559,69,-47"). */
export interface SiteRef {
  kind: string
  id: string
  pos?: SitePos
  /** Words for chat ("my farm farm:1"). Default "<kind> <id>". */
  label?: string
  /** What the adapter needs to re-check or rebuild it later (a farm's size, say). */
  data?: Record<string, unknown>
}

/** A check's answer. */
export type SiteVerdict = { ok: true, note?: string } | { ok: false, fault: SiteFault, reason: string }

export interface SiteRecord extends SiteRef {
  status: 'ok' | 'bad'
  /** Soft faults in a row. */
  strikes: number
  checkedAt: number
  /** When it went bad, and why. */
  badAt?: number
  fault?: SiteFault
  reason?: string
  /** Last re-check of a bad site. */
  recheckedAt?: number
  /** What the adapter did about it ("started farm:2", "told the owners"). */
  handled?: string
}

export type SiteChange = 'bad' | 'recovered' | null

/**
 * The next record after one check. Pure. A hard fault marks the site bad at once, a soft one
 * after `failures` in a row; an ok check clears the strikes and brings a bad site back.
 */
export function noteSiteCheck (prev: SiteRecord | undefined, ref: SiteRef, v: SiteVerdict, now: number, o: Pick<SitesSettings, 'failures'>): { record: SiteRecord, change: SiteChange } {
  const base: SiteRecord = prev ? { ...prev, ...ref, data: ref.data ?? prev.data } : { ...ref, status: 'ok', strikes: 0, checkedAt: now }
  base.checkedAt = now
  if (v.ok) {
    const was = base.status
    const rec: SiteRecord = { ...base, status: 'ok', strikes: 0 }
    delete rec.badAt; delete rec.fault; delete rec.reason; delete rec.recheckedAt; delete rec.handled
    return { record: rec, change: was === 'bad' ? 'recovered' : null }
  }
  if (base.status === 'bad') return { record: { ...base, recheckedAt: now, fault: v.fault, reason: v.reason }, change: null }
  const strikes = base.strikes + 1
  const hard = HARD_FAULTS.includes(v.fault)
  if (hard || strikes >= Math.max(1, o.failures)) {
    return { record: { ...base, status: 'bad', strikes, badAt: now, fault: v.fault, reason: v.reason }, change: 'bad' }
  }
  return { record: { ...base, strikes, fault: v.fault, reason: v.reason }, change: null }
}

/** A bad site is worth another look once `recheckHours` passed since it went bad or was last re-checked. */
export function recheckDue (r: SiteRecord, now: number, o: Pick<SitesSettings, 'recheckHours'>): boolean {
  if (r.status !== 'bad') return false
  const since = Math.max(r.badAt ?? 0, r.recheckedAt ?? 0)
  return now - since >= o.recheckHours * 3_600_000
}

/** A check of a healthy site is due once `checkMinutes` passed since the last one. */
export function checkDue (r: SiteRecord | undefined, now: number, o: Pick<SitesSettings, 'checkMinutes'>): boolean {
  return !r || now - r.checkedAt >= o.checkMinutes * 60_000
}

export function siteLabel (r: SiteRef): string {
  return r.label ?? `${r.kind} ${r.id}`
}

/** One line for chat and the journal. */
export function siteText (r: SiteRecord, change: Exclude<SiteChange, null>): string {
  const at = r.pos ? ` at ${Math.round(r.pos.x)} ${Math.round(r.pos.y)} ${Math.round(r.pos.z)}` : ''
  if (change === 'recovered') return `${siteLabel(r)}${at} looks fine again`
  return `${siteLabel(r)}${at} is no good: ${r.reason ?? r.fault}${r.handled ? `; ${r.handled}` : ''}`
}

const KEY = 'sites'
const key = (kind: string, id: string) => `${kind}|${id}`

type SiteAgent = Pick<Agent, 'storage' | 'settings'> & Partial<Pick<Agent, 'journal' | 'whisper' | 'owners' | 'username' | 'adapter' | 'log' | 'inSession' | 'isOwner'>>

/** Site records of one agent, in agent.storage under `sites`. */
export class SiteBook {
  private readonly agent: SiteAgent
  constructor (agent: SiteAgent) { this.agent = agent }

  settings (): SitesSettings { return sitesSettings((this.agent.settings as { sites?: unknown }).sites) }

  all (): SiteRecord[] {
    return Object.values(this.agent.storage.get<Record<string, SiteRecord>>(KEY, {}))
  }

  get (kind: string, id: string): SiteRecord | undefined {
    return this.agent.storage.get<Record<string, SiteRecord>>(KEY, {})[key(kind, id)]
  }

  bad (kind?: string): SiteRecord[] {
    return this.all().filter(r => r.status === 'bad' && (!kind || r.kind === kind))
  }

  isBad (kind: string, id: string): boolean {
    return this.get(kind, id)?.status === 'bad'
  }

  save (r: SiteRecord): void {
    const all = { ...this.agent.storage.get<Record<string, SiteRecord>>(KEY, {}) }
    all[key(r.kind, r.id)] = r
    this.agent.storage.set(KEY, all)
  }

  forget (kind: string, id: string): void {
    const all = { ...this.agent.storage.get<Record<string, SiteRecord>>(KEY, {}) }
    delete all[key(kind, id)]
    this.agent.storage.set(KEY, all)
  }

  /** Records one check; on a change it is journalled. Returns the record and the change. */
  report (ref: SiteRef, v: SiteVerdict, now = Date.now()): { record: SiteRecord, change: SiteChange } {
    const out = noteSiteCheck(this.get(ref.kind, ref.id), ref, v, now, this.settings())
    this.save(out.record)
    if (out.change) {
      const r = out.record
      try {
        this.agent.journal?.record('site', { kind: r.kind, id: r.id, status: r.status, ...(r.fault ? { fault: r.fault } : {}), ...(r.reason ? { reason: r.reason } : {}) },
          r.pos ? { pos: r.pos, ...(r.pos.dim ? { dim: r.pos.dim } : {}) } : {})
      } catch {}
      this.agent.log?.info(`site ${r.kind} ${r.id}: ${out.change === 'bad' ? `bad (${r.fault}: ${r.reason})` : 'ok again'}`)
    }
    return out
  }

  /** Whispers the owners online (never public chat), when settings.sites.tell is on. */
  tell (text: string): void {
    if (!this.settings().tell) return
    const a = this.agent
    if (a.inSession === false || !a.whisper) return
    const online = a.adapter?.players?.() ?? []
    const owners = (a.owners ?? []).map(o => o.toLowerCase())
    for (const p of online) if (owners.includes(p.toLowerCase()) && p !== a.username) a.whisper(p, text)
  }
}

const books = new WeakMap<object, SiteBook>()
/** The agent's site book (one per agent). */
export function siteBook (agent: SiteAgent): SiteBook {
  let b = books.get(agent)
  if (!b) { b = new SiteBook(agent); books.set(agent, b) }
  return b
}
