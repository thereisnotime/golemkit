// How many chunks around the bot the client asks the server to send (settings.world.viewDistance).
// Mineflayer keeps every column it gets in memory, (2d+1)^2 of them, about 90 KB each on a
// 1.21 world: d=10 is ~440 columns (~40 MB), d=6 ~170 (~15 MB). The server caps it at its own
// view-distance. Mineflayer names: tiny 6, short 8, normal 10, far 12 (its default).

export type ViewDistance = 'tiny' | 'short' | 'normal' | 'far' | number

const NAMED: Record<string, number> = { tiny: 6, short: 8, normal: 10, far: 12 }

/** Default: Mineflayer's own ('far', 12; the server's view-distance caps it). */
export const DEFAULT_VIEW_DISTANCE: ViewDistance = 'far'

/** Chunk radius for a name or number (2..32), or null when it is neither. */
export function viewDistanceChunks (v: unknown): number | null {
  if (typeof v === 'string') return NAMED[v.trim().toLowerCase()] ?? (/^\d+$/.test(v.trim()) ? viewDistanceChunks(Number(v)) : null)
  if (typeof v === 'number' && Number.isInteger(v) && v >= 2 && v <= 32) return v
  return null
}

/** The value to hand Mineflayer: the setting when valid, else the default. */
export function resolveViewDistance (setting: unknown): ViewDistance {
  if (setting == null) return DEFAULT_VIEW_DISTANCE
  if (typeof setting === 'string' && setting.trim().toLowerCase() in NAMED) return setting.trim().toLowerCase() as ViewDistance
  return viewDistanceChunks(setting) ?? DEFAULT_VIEW_DISTANCE
}
