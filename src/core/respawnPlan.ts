// Getting off the death screen: when the body is dead (health 0), ask the game to respawn, try
// again if nothing happens, and reconnect as a last resort. Covers a bot that logs in already dead
// (health 0 at login: Pax sat on the death screen after a reconnect and nothing ran). Game-agnostic:
// the adapter feeds it health readings and does what it says (profile key `respawn:`).
import { z } from 'zod'

export const RespawnSettingsSchema = z.object({
  enabled: z.boolean().optional().describe('respawn by itself when dead, also when it logs in dead (default on)'),
  retrySeconds: z.number().min(1).max(120).optional().describe('ask again this often while still dead (default 5)'),
  maxTries: z.number().int().min(1).max(50).optional().describe('after this many asks without coming back, reconnect (default 6)')
})
export type RespawnSettingsInput = z.infer<typeof RespawnSettingsSchema>

export interface RespawnSettings { enabled: boolean, retrySeconds: number, maxTries: number }
export const RESPAWN_DEFAULTS: RespawnSettings = { enabled: true, retrySeconds: 5, maxTries: 6 }

const obj = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
const num = (v: unknown, d: number, lo: number, hi: number): number => typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d

/** Per-key fallback: a bad value falls back on its default, the rest still apply. */
export function respawnSettings (raw: unknown): RespawnSettings {
  const o = raw === false ? { enabled: false } : obj(raw)
  const d = RESPAWN_DEFAULTS
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : d.enabled,
    retrySeconds: num(o.retrySeconds, d.retrySeconds, 1, 120),
    maxTries: Math.round(num(o.maxTries, d.maxTries, 1, 50))
  }
}

/** What the watcher knows. deadSince: when health first read 0 (null while alive). */
export interface RespawnState {
  health: number | null
  deadSince: number | null
  tries: number
  lastTry: number | null
}

export type RespawnAction =
  | { action: 'none' }
  | { action: 'respawn', attempt: number }
  | { action: 'reconnect' }

/** The decision for one tick. The first ask goes out at once; repeats retrySeconds apart. */
export function respawnDecision (s: RespawnState, now: number, opts: RespawnSettings): RespawnAction {
  if (!opts.enabled) return { action: 'none' }
  if (s.health === null || s.health > 0 || s.deadSince === null) return { action: 'none' }
  if (s.tries === 0) return { action: 'respawn', attempt: 1 }
  if (s.lastTry !== null && now - s.lastTry < opts.retrySeconds * 1000) return { action: 'none' }
  if (s.tries >= opts.maxTries) return { action: 'reconnect' }
  return { action: 'respawn', attempt: s.tries + 1 }
}

/** Folds a health reading into the state: dead starts the clock, alive clears it. */
export function respawnObserve (s: RespawnState, health: number | null, now: number): RespawnState {
  if (health === null) return { ...s, health }
  if (health > 0) return { health, deadSince: null, tries: 0, lastTry: null }
  return { ...s, health, deadSince: s.deadSince ?? now }
}

export const RESPAWN_INITIAL: RespawnState = { health: null, deadSince: null, tries: 0, lastTry: null }
