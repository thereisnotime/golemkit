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
  setting: (name: string) => ChoreSetting
  /** Asked lazily, in order of preference: can it do something useful right now? */
  applicable: (name: string) => boolean
}

/** A chore's effective settings: the profile's over the chore's own defaults. */
export function effective (c: ChoreSpec, s: ChoreSetting): { enabled: boolean, when: ChoreWhen, hours: [number, number] | null, cooldownMs: number } {
  return {
    enabled: s.enabled ?? c.enabled ?? true,
    when: s.when ?? c.when,
    hours: s.hours,
    cooldownMs: (s.cooldownMinutes ?? c.cooldownMinutes) * 60_000
  }
}

/**
 * The chore to run now, or null. Candidates: the mode's chores and those of the modes below it,
 * enabled, inside their window and past their cooldown. Higher modes first (productive chores
 * before ambient ones), then the one that ran least recently; the first applicable one wins.
 */
export function pickChore (chores: readonly ChoreSpec[], p: PickInput): { name: string, reason: string } | null {
  const rank = MODE_RANK[p.mode] ?? 0
  if (rank === 0) return null
  const cands = chores.filter(c => {
    if (MODE_RANK[c.mode] > rank) return false
    const e = effective(c, p.setting(c.name))
    if (!e.enabled) return false
    if (!windowOk(e.when, e.hours, p.isNight, p.hour)) return false
    const last = p.last[c.name]
    return last === undefined || p.now - last >= e.cooldownMs
  }).sort((a, b) => (MODE_RANK[b.mode] - MODE_RANK[a.mode]) || ((p.last[a.name] ?? 0) - (p.last[b.name] ?? 0)))
  for (const c of cands) {
    let ok = false
    try { ok = p.applicable(c.name) } catch { ok = false }
    if (ok) return { name: c.name, reason: `idle mode ${p.mode}: ${c.name}` }
  }
  return null
}
