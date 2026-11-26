// Idle modes: what the bot does when nothing else scores. Pure: the chore choice is unit-tested
// (test/needs.test.ts); the chores themselves come from the game adapter (NeedsProvider.chores).
import type { IdleMode, ChoreSetting } from '../../core/needs.ts'

export const MODE_RANK: Record<IdleMode, number> = { off: 0, passive: 1, idle: 2, active: 3, explore: 4 }

export type ChoreWhen = 'day' | 'night' | 'any'

/** What the picker needs to know about a chore. */
export interface ChoreSpec {
  name: string
  /** The lowest mode it belongs to; higher modes include it. */
  mode: Exclude<IdleMode, 'off'>
  /** Default time of day. */
  when: ChoreWhen
  /** Default pause after it ran, in minutes. */
  cooldownMinutes: number
  /** On unless the settings say otherwise. Default true. */
  enabled?: boolean
  /**
   * Pause after a run that found nothing to do (the chore said so), in minutes. Default three
   * cooldowns, at least 30: a chore that keeps finding nothing (no reachable dark spot, no grass)
   * must not take every slot from the others.
   */
  quietMinutes?: number
}

/** Whether a clock hour (0..24) is inside [from, to]; from > to wraps past midnight. */
export function inHours (hour: number, [from, to]: [number, number]): boolean {
  if (from === to) return true
  return from < to ? hour >= from && hour < to : hour >= from || hour < to
}

/** Whether the chore's window allows it now. */
export function windowOk (when: ChoreWhen, hours: [number, number] | null, isNight: boolean, hour: number | null): boolean {
  if (when === 'day' && isNight) return false
  if (when === 'night' && !isNight) return false
  if (hours && hour !== null && !inHours(hour, hours)) return false
  return true
}

export interface PickInput {
  mode: IdleMode
  isNight: boolean
  /** Game clock hour (0..24), or null when the game has none. */
  hour: number | null
  now: number
  /** When each chore last ran (ms). */
  last: Record<string, number>
  /** Chores that last found nothing to do: not before this time (ms). */
  quietUntil?: Record<string, number>
  setting: (name: string) => ChoreSetting
  /** Asked lazily, in order of preference: can it do something useful right now? */
  applicable: (name: string) => boolean
  /** Why a chore that isn't applicable has nothing to do ("35 seeds, enough"), for the status. */
  whyNot?: (name: string) => string | null
}

/** A chore's effective settings: the profile's over the chore's own defaults. */
export function effective (c: ChoreSpec, s: ChoreSetting): { enabled: boolean, when: ChoreWhen, hours: [number, number] | null, cooldownMs: number, quietMs: number } {
  const cooldown = s.cooldownMinutes ?? c.cooldownMinutes
  return {
    enabled: s.enabled ?? c.enabled ?? true,
    when: s.when ?? c.when,
    hours: s.hours,
    cooldownMs: cooldown * 60_000,
    quietMs: (s.quietMinutes ?? c.quietMinutes ?? Math.max(30, cooldown * 3)) * 60_000
  }
}

/** Why a chore is not a candidate now ("cooling 4m"), or null when it is. Applicability is not asked. */
export function choreBlocked (c: ChoreSpec, p: Omit<PickInput, 'applicable'>): string | null {
  if (MODE_RANK[c.mode] > (MODE_RANK[p.mode] ?? 0)) return `needs idle mode ${c.mode}`
  const e = effective(c, p.setting(c.name))
  if (!e.enabled) return 'off'
  if (!windowOk(e.when, e.hours, p.isNight, p.hour)) return e.when === 'day' && p.isNight ? 'waits for the day' : e.when === 'night' && !p.isNight ? 'waits for the night' : 'outside its hours'
  const last = p.last[c.name]
  if (last !== undefined && p.now - last < e.cooldownMs) return `again in ${mins(e.cooldownMs - (p.now - last))}`
  const quiet = p.quietUntil?.[c.name]
  if (quiet !== undefined && p.now < quiet) return `found nothing to do, again in ${mins(quiet - p.now)}`
  return null
}

const mins = (ms: number) => ms < 90_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.round(ms / 60_000)}m`

/**
 * The chore to run now, or null. Candidates: the mode's chores and those of the modes below it,
 * enabled, inside their window and past their cooldown. Higher modes first (productive chores
 * before ambient ones), then the one that ran least recently; the first applicable one wins.
 */
export function pickChore (chores: readonly ChoreSpec[], p: PickInput): { name: string, reason: string } | null {
  return explainChores(chores, p).pick
}

export interface ChoreExplanation {
  pick: { name: string, reason: string } | null
  /** Each chore of the mode and below that was not picked, with why ("not needed", "again in 4m"). */
  why: Record<string, string>
}

/**
 * pickChore with the reasons: why each chore of the mode was passed over, for the status line
 * ("idle (active): tidy_storage not needed, extend_farm again in 8m, ...").
 */
export function explainChores (chores: readonly ChoreSpec[], p: PickInput): ChoreExplanation {
  const why: Record<string, string> = {}
  const rank = MODE_RANK[p.mode] ?? 0
  if (rank === 0) return { pick: null, why }
  const cands: ChoreSpec[] = []
  for (const c of chores) {
    if (MODE_RANK[c.mode] > rank) continue
    const b = choreBlocked(c, p)
    if (b) why[c.name] = b
    else cands.push(c)
  }
  cands.sort((a, b) => (MODE_RANK[b.mode] - MODE_RANK[a.mode]) || ((p.last[a.name] ?? 0) - (p.last[b.name] ?? 0)))
  for (const c of cands) {
    let ok = false
    try { ok = p.applicable(c.name) } catch { ok = false }
    if (ok) return { pick: { name: c.name, reason: `idle mode ${p.mode}: ${c.name}` }, why }
    let w: string | null = null
    try { w = p.whyNot?.(c.name) ?? null } catch {}
    why[c.name] = w ? `not needed (${w})` : 'not needed'
  }
  return { pick: null, why }
}

/** "tidy_storage not needed, extend_farm again in 8m" from explainChores' reasons, ambient chores last. */
export function choreSummary (why: Record<string, string>, top = 6): string {
  const ambient = new Set(['look_around', 'go_home', 'rest_by_bed'])
  return Object.entries(why).sort((a, b) => Number(ambient.has(a[0])) - Number(ambient.has(b[0])))
    .slice(0, top).map(([n, w]) => `${n} ${w}`).join(', ')
}
