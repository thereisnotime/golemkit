// Phantoms: what to do about them, pure. Phantoms spawn at night over a player who hasn't been in
// a bed (or died) for three in-game days, and lying down in a bed resets that timer even when the
// night doesn't skip. Unlike zombies and skeletons they don't stop a player from sleeping. They
// circle high, dive, hit and climb away, so a bot that only fights back after a hit (the reflexes)
// is always a dive late: Pax stood still and took about ten hits from them.
//
// So: at night, with a bed in reach and no ground mob close, go to bed when phantoms are about or
// the bot hasn't been in a bed for a while; otherwise, with a phantom close, start the fight before
// the next dive (the fight loop holds still and swings when a flyer comes into reach).
import { z } from 'zod'

export interface PhantomSettings {
  /** Master switch (combat.phantoms.enabled). Default true. */
  enabled: boolean
  /** Go to bed against phantoms and against the timer that spawns them. Default true. */
  sleep: boolean
  /** Real minutes without a bed (or a death) after which it goes to bed at night anyway. Phantoms come after 3 in-game days (60 min). Default 30. */
  insomniaMinutes: number
  /** A bed this close (blocks). Default 16. */
  bedRange: number
  /** Start fighting a phantom this close instead of waiting for its hit. 0 = only fight back. Default 16. */
  engageRange: number
  /** A ground mob this close means no bed now (the game refuses, and it would be hit in bed). Default 8. */
  groundClear: number
  /** After a refused or failed bed, wait this long before trying again (seconds). Default 60. */
  retrySeconds: number
  /** With phantoms about, a bed this recent (minutes) already reset the timer: fight them instead. Default 5. */
  recentMinutes: number
}

export const PHANTOM_DEFAULTS: PhantomSettings = {
  enabled: true, sleep: true, insomniaMinutes: 30, bedRange: 16, engageRange: 16, groundClear: 8, retrySeconds: 60, recentMinutes: 5
}

const schema = z.object({
  enabled: z.boolean(),
  sleep: z.boolean(),
  insomniaMinutes: z.number().min(0).max(1440),
  bedRange: z.number().min(1).max(64),
  engageRange: z.number().min(0).max(48),
  groundClear: z.number().min(0).max(32),
  retrySeconds: z.number().min(0).max(3600),
  recentMinutes: z.number().min(0).max(120)
}).partial()

/** settings.combat.phantoms over the defaults; `false` turns it off; bad values fall back per key. */
export function phantomSettings (raw: unknown): PhantomSettings {
  if (raw === false) return { ...PHANTOM_DEFAULTS, enabled: false }
  const out = { ...PHANTOM_DEFAULTS }
  if (!raw || typeof raw !== 'object') return out
  for (const k of Object.keys(PHANTOM_DEFAULTS) as (keyof PhantomSettings)[]) {
    const v = (raw as Record<string, unknown>)[k]
    if (v === undefined) continue
    const one = schema.safeParse({ [k]: v })
    if (one.success) (out as Record<string, unknown>)[k] = v
  }
  return out
}

export interface PhantomInput {
  night: boolean
  sleeping: boolean
  /** Phantoms within 32 blocks. */
  phantoms: number
  nearestPhantom: number | null
  /** Ms since it last lay in a bed or died; null = never seen. */
  sinceRestMs: number | null
  bedDist: number | null
  /** A ground hostile within groundClear. */
  groundHostile: boolean
  /** Ms since the last refused or failed bed; null = none. */
  sinceBedFailMs: number | null
  /** What it is doing now. */
  current: string | null
}

/**
 * sleep: lie down (stay: keep lying so the night can skip; else get up again at once, the bed
 * already reset the timer and the phantoms overhead are still there). wake: get up to fight.
 */
export type PhantomStep = { do: 'sleep', stay: boolean, why: string } | { do: 'engage' | 'wake' | 'none', why: string }

/** Actions that already fight or escape: leave them alone. */
const BUSY = new Set(['defend', 'attack', 'protect', 'retreat', 'bunker', 'ranged_defense', 'water_bucket', 'air', 'sleep', 'set_spawn'])

export function phantomStep (s: PhantomSettings, i: PhantomInput): PhantomStep {
  if (!s.enabled || !i.night) return { do: 'none', why: '' }
  const close = i.phantoms > 0 && i.nearestPhantom !== null && s.engageRange > 0 && i.nearestPhantom <= s.engageRange
  if (i.sleeping) return close ? { do: 'wake', why: `phantom at ${Math.round(i.nearestPhantom!)} blocks: out of bed to fight it` } : { do: 'none', why: '' }
  if (i.current && BUSY.has(i.current)) return { do: 'none', why: `busy with ${i.current}` }
  const insomnia = i.sinceRestMs === null || i.sinceRestMs > s.insomniaMinutes * 60_000
  const bedOk = s.sleep && i.bedDist !== null && i.bedDist <= s.bedRange && !i.groundHostile &&
    (i.sinceBedFailMs === null || i.sinceBedFailMs > s.retrySeconds * 1000)
  const recent = i.sinceRestMs !== null && i.sinceRestMs <= s.recentMinutes * 60_000
  if (bedOk && i.phantoms > 0 && !recent) return { do: 'sleep', stay: false, why: `${i.phantoms} phantom${i.phantoms === 1 ? '' : 's'} about: in and out of bed (they don't stop sleep, and a bed resets their timer)` }
  if (bedOk && insomnia && i.phantoms === 0) return { do: 'sleep', stay: true, why: i.sinceRestMs === null ? 'no bed since it came online: to bed before phantoms come' : `${Math.round(i.sinceRestMs / 60_000)} min without a bed: to bed before phantoms come` }
  if (close) {
    return { do: 'engage', why: `phantom at ${Math.round(i.nearestPhantom ?? 0)} blocks: fighting before its dive` }
  }
  return { do: 'none', why: '' }
}
