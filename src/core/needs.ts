// Settings for the needs layer, idle modes and site health (profile keys `needs:`, `idle:`,
// `sites:`, live toggles needs.*, idle.*, sites.*). Game-agnostic: which needs and chores exist
// comes from the game adapter; this file only knows their shape. See docs/guide/needs-and-idle.md.
import { z } from 'zod'

/** The needs the stock adapters know. An adapter may add others; their settings take the same shape. */
export const NEED_NAMES = ['safety', 'food', 'gear', 'supplies', 'rest'] as const

/** What the bot does when nothing else scores, from doing nothing to scouting trips. */
export const IDLE_MODES = ['off', 'passive', 'idle', 'active', 'explore'] as const
export type IdleMode = typeof IDLE_MODES[number]

const unit = z.number().min(0).max(1)

export const SearchSettingsSchema = z.object({
  enabled: z.boolean().optional().describe('go looking when a need has no visible way to be met (default on)'),
  radius: z.number().int().min(16).max(512).optional().describe('how far a search may go from where it starts, in blocks (default 160)'),
  minutes: z.number().min(1).max(30).optional().describe('give a search up after this many minutes (default 6)'),
  cooldownMinutes: z.number().min(1).max(1440).optional().describe('wait this long before searching for the same need again (default 30)'),
  perDay: z.number().int().min(0).max(100).optional().describe('searches per need per real day at most (default 6, 0 = never)'),
  atNight: z.boolean().optional().describe('also search at night (default off: mobs)')
}).strict()

export const NeedSettingSchema = z.union([z.boolean(), z.object({
  enabled: z.boolean().optional().describe('true: always on; false: off; unset: on when a behaviour serving it is armed'),
  threshold: unit.optional().describe('urgency (0..1) from which the behaviours serving it are boosted and it may search (default 0.5)'),
  boost: z.number().min(0).max(60).optional().describe('score added to a serving behaviour at urgency 1 (default needs.boost)'),
  search: z.boolean().optional().describe('may go looking for this need (default needs.search.enabled)'),
  radius: z.number().int().min(16).max(512).optional().describe('search radius for this need (default needs.search.radius)'),
  minutes: z.number().min(1).max(30).optional().describe('search time for this need (default needs.search.minutes)')
}).strict()])

export const NeedsSettingsSchema = z.object({
  enabled: z.boolean().optional().describe('the needs layer: boosts and go-looking (default on)'),
  boost: z.number().min(0).max(60).optional().describe('score added to a serving behaviour at urgency 1 (default 15)'),
  search: SearchSettingsSchema.optional().describe('go looking: limits for every need'),
  safety: NeedSettingSchema.optional().describe('stay safe: hostiles close, low health'),
  food: NeedSettingSchema.optional().describe('stay fed: hunger, nothing to eat'),
  gear: NeedSettingSchema.optional().describe('gear up: weapon, tools, armour up to the target tier'),
  supplies: NeedSettingSchema.optional().describe('keep the base supplied: wood, food in the pantry, seeds'),
  rest: NeedSettingSchema.optional().describe('rest: home and in bed at night')
}).catchall(NeedSettingSchema)

const Hour = z.number().min(0).max(24)

export const ChoreSettingSchema = z.union([z.boolean(), z.object({
  enabled: z.boolean().optional().describe('run this chore (default: the chore\'s own default)'),
  radius: z.number().int().min(2).max(512).optional().describe('how far from home the chore may go (default idle.radius, explore: idle.exploreRadius)'),
  when: z.enum(['day', 'night', 'any']).optional().describe('time of day it may run (default: the chore\'s own)'),
  hours: z.tuple([Hour, Hour]).optional().describe('game clock window [from, to] in hours (Minecraft: 0 midnight, 6 sunrise); wraps past midnight when from > to'),
  cooldownMinutes: z.number().min(0).max(1440).optional().describe('pause after it ran before it may run again'),
  quietMinutes: z.number().min(0).max(1440).optional().describe('pause after a run that found nothing to do (default three cooldowns, at least 30)')
}).strict()])

export const IdleSettingsSchema = z.object({
  mode: z.enum(IDLE_MODES).optional().describe('off | passive (look around) | idle (light, near home) | active (chores) | explore (chores and scouting trips); default idle'),
  radius: z.number().int().min(4).max(256).optional().describe('idle and active chores stay within this many blocks of home (default 24)'),
  exploreRadius: z.number().int().min(32).max(1024).optional().describe('explore mode: how far a scouting trip may go (default 200)'),
  exploreMinutes: z.number().min(1).max(30).optional().describe('explore mode: give a scouting trip up after this many minutes (default 8)'),
  chores: z.record(z.string(), ChoreSettingSchema).optional().describe('per chore: true/false or { enabled, radius, when, hours, cooldownMinutes, quietMinutes }')
}).strict()

export const SitesSettingsSchema = z.object({
  enabled: z.boolean().optional().describe('check the places it depends on (farm, bed, chests, home) and mark bad ones (default on)'),
  failures: z.number().int().min(1).max(20).optional().describe('unreachable or no-work checks in a row before a site is bad (default 3)'),
  checkMinutes: z.number().min(0.5).max(240).optional().describe('check one site at most this often (default 5)'),
  recheckHours: z.number().min(0.1).max(720).optional().describe('look at a bad site again after this many hours (default 6)'),
  replace: z.boolean().optional().describe('replace a bad site when it can (a new farm near home); off = only tell (default on)'),
  tell: z.boolean().optional().describe('whisper the owners online when a site goes bad or is fine again (default on)')
}).strict()

export interface SearchSettings { enabled: boolean, radius: number, minutes: number, cooldownMinutes: number, perDay: number, atNight: boolean }

export interface NeedSetting {
  /** true/false when set; null = automatic (on when a serving behaviour is in the set). */
  enabled: boolean | null
  threshold: number
  boost: number
  search: boolean
  radius: number
  minutes: number
}

export interface NeedsSettings {
  enabled: boolean
  boost: number
  search: SearchSettings
  /** Per need; needs not mentioned get `need(name)`'s defaults. */
  need (name: string): NeedSetting
}

export const SEARCH_DEFAULTS: SearchSettings = { enabled: true, radius: 160, minutes: 6, cooldownMinutes: 30, perDay: 6, atNight: false }
export const NEED_THRESHOLD = 0.5
export const NEED_BOOST = 15

const obj = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
const num = (v: unknown, d: number, min = -Infinity, max = Infinity): number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : d
const bool = (v: unknown, d: boolean): boolean => typeof v === 'boolean' ? v : d

/** settings.needs with defaults; wrong types fall back to the default (the profile schema already reports them). */
export function needsSettings (raw: unknown): NeedsSettings {
  const o = raw === false ? { enabled: false } : obj(raw)
  const s = obj(o.search)
  const search: SearchSettings = {
    enabled: bool(s.enabled, SEARCH_DEFAULTS.enabled),
    radius: num(s.radius, SEARCH_DEFAULTS.radius, 16, 512),
    minutes: num(s.minutes, SEARCH_DEFAULTS.minutes, 1, 30),
    cooldownMinutes: num(s.cooldownMinutes, SEARCH_DEFAULTS.cooldownMinutes, 1, 1440),
    perDay: num(s.perDay, SEARCH_DEFAULTS.perDay, 0, 100),
    atNight: bool(s.atNight, SEARCH_DEFAULTS.atNight)
  }
  const boost = num(o.boost, NEED_BOOST, 0, 60)
  return {
    enabled: bool(o.enabled, true),
    boost,
    search,
    need (name: string): NeedSetting {
      const v = o[name]
      const n = typeof v === 'boolean' ? { enabled: v } : obj(v)
      return {
        enabled: typeof n.enabled === 'boolean' ? n.enabled : null,
        threshold: num(n.threshold, NEED_THRESHOLD, 0, 1),
        boost: num(n.boost, boost, 0, 60),
        search: bool(n.search, search.enabled),
        radius: num(n.radius, search.radius, 16, 512),
        minutes: num(n.minutes, search.minutes, 1, 30)
      }
    }
  }
}

export interface ChoreSetting {
  /** null = the chore's own default. */
  enabled: boolean | null
  radius: number | null
  when: 'day' | 'night' | 'any' | null
  hours: [number, number] | null
  cooldownMinutes: number | null
  quietMinutes: number | null
}

export interface IdleSettings {
  mode: IdleMode
  radius: number
  exploreRadius: number
  exploreMinutes: number
  chore (name: string): ChoreSetting
  /** Chore names the settings mention (to warn about unknown ones). */
  mentioned: string[]
}

export const IDLE_DEFAULTS = { mode: 'idle' as IdleMode, radius: 24, exploreRadius: 200, exploreMinutes: 8 }

/** settings.idle with defaults. `idle: off` (a string) is short for { mode: off }. */
export function idleSettings (raw: unknown): IdleSettings {
  const o = typeof raw === 'string' ? { mode: raw } : raw === false ? { mode: 'off' } : obj(raw)
  const chores = obj(o.chores)
  const mode = (IDLE_MODES as readonly string[]).includes(o.mode as string) ? o.mode as IdleMode : IDLE_DEFAULTS.mode
  return {
    mode,
    radius: num(o.radius, IDLE_DEFAULTS.radius, 4, 256),
    exploreRadius: num(o.exploreRadius, IDLE_DEFAULTS.exploreRadius, 32, 1024),
    exploreMinutes: num(o.exploreMinutes, IDLE_DEFAULTS.exploreMinutes, 1, 30),
    mentioned: Object.keys(chores),
    chore (name: string): ChoreSetting {
      const v = chores[name]
      const c = typeof v === 'boolean' ? { enabled: v } : obj(v)
      const h = Array.isArray(c.hours) && c.hours.length === 2 && c.hours.every(x => typeof x === 'number' && x >= 0 && x <= 24) ? c.hours as [number, number] : null
      return {
        enabled: typeof c.enabled === 'boolean' ? c.enabled : null,
        radius: typeof c.radius === 'number' && c.radius > 0 ? c.radius : null,
        when: c.when === 'day' || c.when === 'night' || c.when === 'any' ? c.when : null,
        hours: h,
        cooldownMinutes: typeof c.cooldownMinutes === 'number' && c.cooldownMinutes >= 0 ? c.cooldownMinutes : null,
        quietMinutes: typeof c.quietMinutes === 'number' && c.quietMinutes >= 0 ? c.quietMinutes : null
      }
    }
  }
}

export interface SitesSettings { enabled: boolean, failures: number, checkMinutes: number, recheckHours: number, replace: boolean, tell: boolean }

export const SITES_DEFAULTS: SitesSettings = { enabled: true, failures: 3, checkMinutes: 5, recheckHours: 6, replace: true, tell: true }

export function sitesSettings (raw: unknown): SitesSettings {
  const o = raw === false ? { enabled: false } : obj(raw)
  return {
    enabled: bool(o.enabled, SITES_DEFAULTS.enabled),
    failures: num(o.failures, SITES_DEFAULTS.failures, 1, 20),
    checkMinutes: num(o.checkMinutes, SITES_DEFAULTS.checkMinutes, 0.5, 240),
    recheckHours: num(o.recheckHours, SITES_DEFAULTS.recheckHours, 0.1, 720),
    replace: bool(o.replace, SITES_DEFAULTS.replace),
    tell: bool(o.tell, SITES_DEFAULTS.tell)
  }
}
