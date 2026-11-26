// The needs layer of the NPC controller: standing drives (stay safe, stay fed, gear up, keep the
// base supplied, rest) the controller satisfies with the behaviours it already has. The game
// adapter supplies a NeedsProvider: each need's urgency, the behaviours that serve it, a bounded
// search for when nothing in sight can meet it, the idle chores, and site checks.
//
// Per tick (NpcController): regular behaviours are scored as before, then planNeeds() boosts the
// ones serving an urgent need, and when nothing scores above the idle band, the layer offers one
// fallback: the search of the most urgent need nothing can serve (need:<name>), else the idle
// mode's chore (idle:<chore>). Both are ordinary Behaviors, so back-off, failure cool-down, the
// help desk and the action lock apply to them unchanged. See docs/guide/needs-and-idle.md.
import type { Agent, ActionResult, Logger } from '../../core/index.ts'
import { needsSettings, idleSettings, sitesSettings, type IdleMode, type NeedsSettings, type IdleSettings, type SitesSettings } from '../../core/needs.ts'
import { siteBook, siteText, checkDue, recheckDue, type SiteRef, type SiteVerdict, type SiteRecord } from '../../core/sites.ts'
import { explainChores, choreSummary, MODE_RANK, effective, type ChoreSpec } from './idle.ts'
import type { Behavior, BehaviorContext, NpcContext } from './types.ts'
import type { Scored } from './select.ts'

/** Scores of the layer's own behaviours. The idle band (wander, idle_look...) is 5-15. */
export const IDLE_BAND = 15
export const SEARCH_SCORE = 18
/** A running search that says it is committed keeps this score: above work (chop_wood_loop 30-38, keep_tools_upgraded 28), below danger. */
export const COMMITTED_SCORE = 45
export const CHORE_SCORES: Record<Exclude<IdleMode, 'off'>, number> = { passive: 5, idle: 12, active: 16, explore: 16 }

export interface NeedSearch {
  /** What it looks for, for status and logs ("iron ore"). */
  what: string
  /** Actions it can't work without. */
  requires?: string[]
  /** Whether a search could help right now (a pickaxe to mine what it finds, say). Default true. */
  ready? (ctx: NpcContext): boolean
  /** Whether it may run at night now although needs.search.atNight is off (a lit mine near home, say). Default false. */
  night? (ctx: NpcContext): boolean
  /**
   * While running: whether it is in a part it shouldn't be pulled out of by ordinary work (down a
   * mine, say). It then keeps COMMITTED_SCORE even when other behaviours score; danger still wins.
   */
  committed? (ctx: NpcContext): boolean
  run (ctx: BehaviorContext, o: { radius: number, minutes: number, atNight: boolean }): Promise<ActionResult>
}

export interface NeedDef {
  name: string
  /** Behaviours that serve it, by name: boosted while it is urgent. */
  servedBy: string[]
  /** 0 met .. 1 as bad as it gets. */
  urgency (ctx: NpcContext): number
  /** What meeting it means, in a few words ("iron tools and armour"). */
  goal?: string
  search?: NeedSearch
}

export interface ChoreDef extends ChoreSpec {
  /** What it does, for docs and status. */
  description: string
  requires?: string[]
  /**
   * Whether it would do something useful now. `radius` is the chore's (settings or default).
   * A run that turns out to have nothing to do returns `{ ok: true, data: { nothingDone: true } }`:
   * the chore then waits its quietMinutes instead of its cooldown.
   */
  applicable (ctx: NpcContext, o: { radius: number }): boolean
  run (ctx: BehaviorContext, o: { radius: number, minutes: number }): Promise<ActionResult | string | void | boolean>
  /** Why it has nothing to do now, for the status ("35 seeds, enough"); optional. */
  whyIdle? (ctx: NpcContext, o: { radius: number }): string | null
  goal?: string
}

export interface SiteProbe {
  kind: string
  /** The sites of this kind the bot depends on now. */
  list (ctx: NpcContext): SiteRef[]
  /** Checks one (also bad ones that dropped off the list). null = can't tell from here (not loaded). */
  check (ctx: NpcContext, site: SiteRef): SiteVerdict | null
  /** It just went bad: replace it if `replace`; returns what was done, for the record and the owners. */
  onBad? (ctx: NpcContext, rec: SiteRecord, replace: boolean): string | void
  /** It is fine again. */
  onRecovered? (ctx: NpcContext, rec: SiteRecord): string | void
}

export interface NeedsProvider {
  needs: NeedDef[]
  chores: ChoreDef[]
  sites?: SiteProbe[]
  /** The game clock in hours (0..24) for chore windows; null when unknown. */
  clock? (ctx: NpcContext): number | null
  /** A behaviour failure that says something about a site ("couldn't get to farm:1"). */
  siteFromFailure? (behavior: string, message: string, ctx: NpcContext): { ref: SiteRef, verdict: SiteVerdict } | null
}

// ------------------------------------------------------------------ pure planning

export interface NeedInput {
  name: string
  urgency: number
  active: boolean
  threshold: number
  boost: number
  servedBy: readonly string[]
  /** A search exists, is allowed, due and ready. */
  canSearch: boolean
}

export interface NeedsPlan {
  /** Scores after the boosts (same order as the input). */
  scores: Scored[]
  /** What was boosted, by how much and for which need. */
  boosted: Record<string, { need: string, by: number }>
  /** The most urgent active need (any urgency above 0). */
  top: { name: string, urgency: number } | null
  /** Active needs at or above their threshold, most urgent first. */
  urgent: string[]
  /** No regular score above the idle band: a fallback may run. */
  quiet: boolean
  /** The need to go looking for, when quiet. */
  search: string | null
}

export interface PlanOptions {
  idleBand?: number
  /** Boosts never push a score to this or above (danger keeps the top band). Default 80. */
  urgentScore?: number
}

/**
 * Boosts and fallback choice. Pure. A behaviour serving an urgent need that scores above 0 gets
 * boost * urgency more (the largest boost when several needs share it), capped just below
 * urgentScore. Quiet means nothing scores above the idle band after the boosts. The search goes
 * to the most urgent need whose serving behaviours all score 0 and that may search now.
 */
export function planNeeds (needs: readonly NeedInput[], scores: readonly Scored[], o: PlanOptions = {}): NeedsPlan {
  const band = o.idleBand ?? IDLE_BAND
  const cap = (o.urgentScore ?? 80) - 1
  const active = needs.filter(n => n.active && n.urgency > 0).sort((a, b) => b.urgency - a.urgency)
  const urgent = active.filter(n => n.urgency >= n.threshold)
  const boosted: NeedsPlan['boosted'] = {}
  for (const n of urgent) {
    const by = n.boost * Math.min(1, n.urgency)
    for (const b of n.servedBy) if (by > (boosted[b]?.by ?? 0)) boosted[b] = { need: n.name, by }
  }
  const out = scores.map(s => {
    const b = boosted[s.name]
    if (!b || !(s.score > 0) || s.score >= cap) return s
    return { name: s.name, score: Math.min(cap, s.score + b.by) }
  })
  for (const k of Object.keys(boosted)) if (!(scores.find(s => s.name === k)?.score! > 0)) delete boosted[k]
  const quiet = !out.some(s => s.score > band)
  const score = (name: string) => scores.find(s => s.name === name)?.score ?? 0
  const search = quiet ? urgent.find(n => n.canSearch && n.servedBy.every(b => !(score(b) > 0)))?.name ?? null : null
  return { scores: out, boosted, top: active[0] ? { name: active[0].name, urgency: active[0].urgency } : null, urgent: urgent.map(n => n.name), quiet, search }
}

/** One search as the layer remembers it (storage `needs.searches`). */
export interface SearchRecord {
  need: string
  /** When it started. */
  at: number
  ok: boolean
  message: string
  /** How long it ran. */
  ms?: number
  /** Cut short before it got going (taken over, aborted): not a real try, see searchDue. */
  cut?: boolean
}

/** A search taken over within this long is cut short, not a real try. */
export const CUT_SHORT_MS = 60_000
/** A 'started' record this old belongs to a run that never finished (a restart): cut short. */
const STALE_START_MS = 45 * 60_000
const ABORTED = /^(replaced|preempted|aborted|interrupted|cancelled|suspended)\b/i

/** Whether a finished run was cut short: it threw or was taken over, in its first minute. */
export function cutShort (r: { ok: boolean, message: string } | null, ms: number): boolean {
  if (ms >= CUT_SHORT_MS) return false
  return !r || (!r.ok && ABORTED.test(r.message))
}

/**
 * Whether a need may search now. Pure. Real searches count: one in the last cooldownMinutes
 * blocks, perDay of them in the last day stop it for the day. A search cut short (taken over by
 * other work in its first minute, or a run a restart left at 'started') only blocks for
 * retryMinutes and doesn't count. Pax lost its whole day of gear searches that way: six searches
 * taken over by farm and bed work after 3 to 17 s, then only the 48-block idle scout ran.
 */
export function searchDue (history: readonly { need: string, at: number, cut?: boolean, message?: string }[], need: string, now: number, o: { cooldownMinutes: number, perDay: number, retryMinutes?: number }): boolean {
  const mine = history.filter(h => h.need === need)
  const isCut = (h: typeof mine[number]) => !!h.cut || (h.message === 'started' && now - h.at > STALE_START_MS)
  const real = mine.filter(h => !isCut(h))
  const lastReal = real.reduce((m, h) => Math.max(m, h.at), 0)
  if (lastReal && now - lastReal < o.cooldownMinutes * 60_000) return false
  const lastCut = mine.filter(isCut).reduce((m, h) => Math.max(m, h.at), 0)
  if (lastCut && now - lastCut < (o.retryMinutes ?? 5) * 60_000) return false
  return real.filter(h => now - h.at < 86_400_000).length < o.perDay
}

// ------------------------------------------------------------------ the layer

const SEARCHES_KEY = 'needs.searches'
const CHORES_KEY = 'needs.choresRun'
const QUIET_KEY = 'needs.choresQuiet'
const SITE_TICK_MS = 15_000

type LayerAgent = Pick<Agent, 'storage' | 'settings' | 'getAction'> & Partial<Agent>

export interface LayerView {
  need: { name: string, urgency: number } | null
  urgent: string[]
  boosted: Record<string, { need: string, by: number }>
  idleMode: IdleMode
  /** The fallback it picked this tick, if any. */
  fallback: { behavior: string, reason: string } | null
  /** Quiet and no chore picked: why each chore was passed over ("tidy_storage not needed, ..."). */
  idleWhy: string | null
}

export class NeedsLayer {
  readonly provider: NeedsProvider
  private readonly agent: LayerAgent
  private readonly log: Logger | undefined
  private readonly now: () => number
  private list: Behavior[] | null = null
  private fallback: { behavior: string, reason: string, score: number } | null = null
  private view: LayerView = { need: null, urgent: [], boosted: {}, idleMode: 'idle', fallback: null, idleWhy: null }
  private siteTickAt = 0

  constructor (agent: LayerAgent, provider: NeedsProvider, opts: { log?: Logger, now?: () => number } = {}) {
    this.agent = agent
    this.provider = provider
    this.log = opts.log
    this.now = opts.now ?? Date.now
  }

  needsSettings (): NeedsSettings { return needsSettings((this.agent.settings as { needs?: unknown }).needs) }
  idleSettings (): IdleSettings { return idleSettings((this.agent.settings as { idle?: unknown }).idle) }
  sitesSettings (): SitesSettings { return sitesSettings((this.agent.settings as { sites?: unknown }).sites) }

  /** need:<name> for every need with a search, idle:<chore> for every chore. Built once. */
  behaviors (): Behavior[] {
    if (this.list) return this.list
    const out: Behavior[] = []
    for (const n of this.provider.needs) {
      const s = n.search
      if (!s) continue
      const name = `need:${n.name}`
      out.push({
        name,
        goal: n.goal ?? `meet my ${n.name} need`,
        ...(s.requires ? { requires: s.requires } : {}),
        failureCooldownMs: 60_000,
        maxFailureCooldownMs: 30 * 60_000,
        score: () => this.fallback?.behavior === name ? this.fallback.score : 0,
        run: async (ctx) => {
          const st = this.needsSettings()
          const ns = st.need(n.name)
          // recorded when it starts (a running search blocks the next), finished whatever happens:
          // taken over in its first minute it is cut short and doesn't use up the day's searches
          const at = this.now()
          this.recordSearch({ need: n.name, at, ok: false, message: 'started' })
          let r: ActionResult | null = null
          try {
            r = await s.run(ctx, { radius: ns.radius, minutes: ns.minutes, atNight: st.search.atNight })
            return r
          } finally {
            const ms = this.now() - at
            const cut = cutShort(r, ms)
            this.recordSearch({ need: n.name, at, ok: !!r?.ok, message: r?.message ?? 'cut short', ms, ...(cut ? { cut } : {}) }, true)
          }
        }
      })
    }
    for (const c of this.provider.chores) {
      const name = `idle:${c.name}`
      out.push({
        name,
        goal: c.goal ?? c.description,
        ...(c.requires ? { requires: c.requires } : {}),
        failureCooldownMs: 30_000,
        maxFailureCooldownMs: 30 * 60_000,
        score: () => this.fallback?.behavior === name ? this.fallback.score : 0,
        run: async (ctx) => {
          const o = this.choreOptions(c)
          try {
            const r = await c.run(ctx, o)
            if (r && typeof r === 'object' && r.ok && (r.data as { nothingDone?: boolean } | undefined)?.nothingDone) this.markQuiet(c)
            return r
          } finally {
            this.markChore(c.name)
          }
        }
      })
    }
    this.list = out
    return out
  }

  private choreOptions (c: ChoreDef): { radius: number, minutes: number } {
    const s = this.idleSettings()
    const own = s.chore(c.name).radius
    return { radius: own ?? (c.mode === 'explore' ? s.exploreRadius : s.radius), minutes: s.exploreMinutes }
  }

  private searches (): SearchRecord[] { return this.agent.storage.get<SearchRecord[]>(SEARCHES_KEY, []) }
  private recordSearch (r: SearchRecord, replaceStart = false): void {
    let list = this.searches()
    if (replaceStart) {
      const i = list.findLastIndex(x => x.need === r.need && x.message === 'started')
      if (i >= 0) list = list.filter((_, j) => j !== i)
    }
    this.agent.storage.set(SEARCHES_KEY, [...list, r].slice(-50))
  }

  /** Last searches, newest last (status, tests). */
  searchHistory (): SearchRecord[] { return this.searches() }

  private choresRun (): Record<string, number> { return this.agent.storage.get<Record<string, number>>(CHORES_KEY, {}) }
  private choresQuiet (): Record<string, number> { return this.agent.storage.get<Record<string, number>>(QUIET_KEY, {}) }
  private markQuiet (c: ChoreDef): void {
    const e = effective(c, this.idleSettings().chore(c.name))
    this.agent.storage.set(QUIET_KEY, { ...this.choresQuiet(), [c.name]: this.now() + e.quietMs })
  }
  private markChore (name: string): void { this.agent.storage.set(CHORES_KEY, { ...this.choresRun(), [name]: this.now() }) }

  /** Whether a need is active: on explicitly, or automatic with a serving behaviour in the set. */
  private isActive (n: NeedDef, st: NeedsSettings, present: ReadonlySet<string>): boolean {
    if (!st.enabled) return false
    const e = st.need(n.name).enabled
    if (e !== null) return e
    return n.servedBy.some(b => present.has(b))
  }

  /**
   * Boosts the regular scores and picks this tick's fallback. `running` is the behaviour running
   * now (a running chore or search keeps its slot while things stay quiet).
   */
  plan (ctx: NpcContext, regular: Scored[], running: string | null, o: PlanOptions = {}): Scored[] {
    const st = this.needsSettings()
    const present = new Set(regular.map(s => s.name))
    const now = this.now()
    const history = this.searches()
    const inputs: NeedInput[] = this.provider.needs.map(n => {
      const active = this.isActive(n, st, present)
      let urgency = 0
      if (active) { try { urgency = Math.max(0, Math.min(1, Number(n.urgency(ctx)) || 0)) } catch (e) { this.log?.debug(`need ${n.name}: ${(e as Error).message}`) } }
      const ns = st.need(n.name)
      let canSearch = false
      const nightOk = (): boolean => { try { return !!n.search?.night?.(ctx) } catch { return false } }
      if (active && n.search && ns.search && urgency >= ns.threshold && (st.search.atNight || !ctx.bb.facts.isNight || nightOk()) &&
          searchDue(history, n.name, now, st.search) && (n.search.requires ?? []).every(a => this.agent.getAction(a))) {
        try { canSearch = n.search.ready?.(ctx) ?? true } catch { canSearch = false }
      }
      return { name: n.name, urgency, active, threshold: ns.threshold, boost: ns.boost, servedBy: n.servedBy, canSearch }
    })
    const p = planNeeds(inputs, regular, o)
    const idle = this.idleSettings()
    this.fallback = null
    let idleWhy: string | null = null
    const runningNeed = running?.startsWith('need:') ? this.provider.needs.find(n => `need:${n.name}` === running) : undefined
    let committed = false
    try { committed = !!runningNeed?.search?.committed?.(ctx) } catch {}
    if (committed && running && !p.scores.some(x => x.score >= COMMITTED_SCORE)) {
      this.fallback = { behavior: running, reason: `finishing ${running} (committed: ${runningNeed!.search!.what})`, score: COMMITTED_SCORE }
    } else if (p.quiet) {
      if (running && (running.startsWith('need:') || running.startsWith('idle:'))) {
        // finish what it started
        const chore = running.startsWith('idle:') ? this.provider.chores.find(c => `idle:${c.name}` === running) : null
        if (running.startsWith('need:') || (chore && MODE_RANK[idle.mode] >= MODE_RANK[chore.mode])) {
          this.fallback = { behavior: running, reason: this.view.fallback?.behavior === running ? this.view.fallback.reason : `finishing ${running}`, score: running.startsWith('need:') ? SEARCH_SCORE : CHORE_SCORES[chore!.mode] }
        }
      } else if (p.search) {
        const n = this.provider.needs.find(x => x.name === p.search)!
        this.fallback = { behavior: `need:${n.name}`, reason: `${n.name} need ${round(inputs.find(i => i.name === n.name)!.urgency)}, nothing in sight can meet it: looking for ${n.search!.what}`, score: SEARCH_SCORE }
      } else {
        const chores = this.provider.chores.filter(c => (c.requires ?? []).every(a => this.agent.getAction(a)))
        let hour: number | null = null
        try { hour = this.provider.clock?.(ctx) ?? null } catch {}
        const { pick, why } = explainChores(chores, {
          mode: idle.mode,
          isNight: ctx.bb.facts.isNight,
          hour,
          now,
          last: this.choresRun(),
          quietUntil: this.choresQuiet(),
          setting: (name) => idle.chore(name),
          applicable: (name) => { const c = chores.find(x => x.name === name)!; return c.applicable(ctx, this.choreOptions(c)) },
          whyNot: (name) => { const c = chores.find(x => x.name === name)!; return c.whyIdle?.(ctx, this.choreOptions(c)) ?? null }
        })
        if (!pick) idleWhy = MODE_RANK[idle.mode] > 0 ? choreSummary(why) || 'no chores' : null
        if (pick) {
          const c = chores.find(x => x.name === pick.name)!
          this.fallback = { behavior: `idle:${c.name}`, reason: pick.reason, score: CHORE_SCORES[c.mode] }
        }
      }
    }
    this.view = {
      need: p.top ? { name: p.top.name, urgency: round(p.top.urgency) } : null,
      urgent: p.urgent,
      boosted: p.boosted,
      idleMode: idle.mode,
      fallback: this.fallback ? { behavior: this.fallback.behavior, reason: this.fallback.reason } : null,
      idleWhy
    }
    return p.scores
  }

  /** What the last plan said (for status and snapshot). */
  lastView (): LayerView { return this.view }

  /** Why `name` would run, when the layer had a say in it. */
  reasonFor (name: string): string | null {
    if (this.view.fallback?.behavior === name) return this.view.fallback.reason
    const b = this.view.boosted[name]
    return b ? `boosted +${Math.round(b.by)} for the ${b.need} need` : null
  }

  /** A run ended: failures may say something about a site. */
  outcome (name: string, outcome: 'ok' | 'fail' | 'aborted' | 'yield', detail: string, ctx: NpcContext): void {
    if (outcome !== 'fail' || !this.provider.siteFromFailure) return
    if (!this.sitesSettings().enabled) return
    try {
      const hit = this.provider.siteFromFailure(name, detail, ctx)
      if (hit) this.report(ctx, hit.ref, hit.verdict)
    } catch (e) { this.log?.debug(`sites: ${(e as Error).message}`) }
  }

  /** Site checks, at most every 15 s; each site at most every sites.checkMinutes, bad ones every recheckHours. */
  tick (ctx: NpcContext): void {
    const now = this.now()
    if (now - this.siteTickAt < SITE_TICK_MS) return
    this.siteTickAt = now
    const s = this.sitesSettings()
    if (!s.enabled || !this.provider.sites?.length) return
    const book = siteBook(this.agent as Agent)
    for (const probe of this.provider.sites) {
      let refs: SiteRef[] = []
      try { refs = probe.list(ctx) } catch (e) { this.log?.debug(`sites ${probe.kind}: ${(e as Error).message}`) }
      const seen = new Set(refs.map(r => r.id))
      // bad ones that dropped off the list (a removed farm) are still re-checked
      for (const r of book.bad(probe.kind)) if (!seen.has(r.id)) refs.push(r)
      for (const ref of refs) {
        const rec = book.get(ref.kind, ref.id)
        const due = rec?.status === 'bad' ? recheckDue(rec, now, s) : checkDue(rec, now, s)
        if (!due) continue
        let v: SiteVerdict | null = null
        try { v = probe.check(ctx, rec ? { ...rec, ...ref, data: ref.data ?? rec.data } : ref) } catch (e) { this.log?.debug(`site check ${ref.kind} ${ref.id}: ${(e as Error).message}`) }
        if (!v) continue
        this.report(ctx, ref, v, probe)
      }
    }
  }

  /** Records a check and handles a change (replace, tell the owners). */
  report (ctx: NpcContext, ref: SiteRef, v: SiteVerdict, probe = this.provider.sites?.find(p => p.kind === ref.kind)): SiteRecord {
    const book = siteBook(this.agent as Agent)
    const s = this.sitesSettings()
    const { record, change } = book.report(ref, v, this.now())
    if (!change) return record
    let handled: string | void = undefined
    try {
      handled = change === 'bad' ? probe?.onBad?.(ctx, record, s.replace) : probe?.onRecovered?.(ctx, record)
    } catch (e) { this.log?.warn(`site ${ref.kind} ${ref.id}: ${(e as Error).message}`) }
    if (handled) { record.handled = handled; book.save(record) }
    book.tell(siteText(record, change))
    return record
  }
}

function round (n: number): number { return Math.round(n * 100) / 100 }
