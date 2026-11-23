// Where to put down a crafting table or a furnace (pure, unit-tested): not inside the server's
// spawn protection (a square of spawn-protection blocks around the world spawn, 16 by default),
// not in a protected area the bot learned about, not on a spot the server already refused. When
// the bot stands inside spawn protection, the nearest point outside it to walk to first.
// crafting.ts reads the world into these and does the placing.

export interface XZ { x: number, z: number }
export interface Pos extends XZ { y: number }

/** Vanilla server.properties spawn-protection. */
export const SPAWN_PROTECTION = 16

export interface StationRules {
  /** The world spawn (the compass target), or null when unknown. */
  spawn?: XZ | null
  /** spawn-protection radius in blocks (0 = none). Default SPAWN_PROTECTION. */
  spawnRadius?: number
  /** A protected area (a claim, a refused break or placement). */
  isProtected?: (p: Pos) => boolean
  /** Spots the server refused a placement at in this session. */
  refused?: ReadonlySet<string>
}

export const spotKey = (p: Pos) => `${p.x},${p.y},${p.z}`

/**
 * Inside vanilla spawn protection: within `radius` blocks of the spawn block on both axes (a
 * square, as the server checks it). Radius 0 or no spawn: never.
 */
export function inSpawnProtection (p: XZ, spawn: XZ | null | undefined, radius = SPAWN_PROTECTION): boolean {
  if (!spawn || radius <= 0) return false
  return Math.max(Math.abs(Math.floor(p.x) - Math.floor(spawn.x)), Math.abs(Math.floor(p.z) - Math.floor(spawn.z))) <= radius
}

/** Why a station can't go here, or null when it can. */
export function stationSpotBlocked (p: Pos, r: StationRules): string | null {
  if (r.refused?.has(spotKey(p))) return 'the server refused it before'
  if (inSpawnProtection(p, r.spawn, r.spawnRadius ?? SPAWN_PROTECTION)) return 'inside spawn protection'
  if (r.isProtected?.(p)) return 'in a protected area'
  return null
}

/** The candidate spots a station may go on, nearest to `from` first. */
export function rankStationSpots<T extends Pos> (cands: readonly T[], from: Pos, r: StationRules): T[] {
  return cands
    .filter(c => !stationSpotBlocked(c, r))
    .map(c => ({ c, d: Math.hypot(c.x + 0.5 - from.x, c.z + 0.5 - from.z) + Math.abs(c.y - Math.floor(from.y)) * 0.5 }))
    .sort((a, b) => a.d - b.d)
    .map(x => x.c)
}

/**
 * Where to walk to get out of spawn protection: the nearest point `margin` blocks past its edge
 * (straight out through the closest side of the square), or null when `from` is already outside.
 */
export function leaveSpawnPoint (from: XZ, spawn: XZ | null | undefined, radius = SPAWN_PROTECTION, margin = 3): XZ | null {
  if (!spawn || !inSpawnProtection(from, spawn, radius)) return null
  const sx = Math.floor(spawn.x)
  const sz = Math.floor(spawn.z)
  const dx = Math.floor(from.x) - sx
  const dz = Math.floor(from.z) - sz
  const out = radius + margin + 1
  // the side closest to where it stands (on a tie, along x)
  if (Math.abs(dx) >= Math.abs(dz)) return { x: sx + (dx >= 0 ? out : -out) + 0.5, z: from.z }
  return { x: from.x, z: sz + (dz >= 0 ? out : -out) + 0.5 }
}

/**
 * A readable reason for a refused placement. mineflayer says "Server refused to place X at
 * (x, y, z): the block is still snow", which reads as if the snow were the problem; the server
 * refused it, most likely spawn protection or a claim.
 */
export function refusedPlacementText (item: string, p: Pos, r: Pick<StationRules, 'spawn' | 'spawnRadius'>): string {
  const radius = r.spawnRadius ?? SPAWN_PROTECTION
  const inSpawn = inSpawnProtection(p, r.spawn, radius)
  const d = r.spawn ? Math.round(Math.hypot(p.x - r.spawn.x, p.z - r.spawn.z)) : null
  const why = inSpawn ? `spawn protection: ${d} blocks from the world spawn, inside its ${radius}-block square` : 'a protected area or claim, most likely'
  return `the server refused to place ${item} at ${p.x} ${p.y} ${p.z} (${why})`
}

/** Whether an error from placing a block means the server refused it (not "no room", not "nothing to click"). */
export function isPlacementRefusal (message: string): boolean {
  return /Server refused to place|the block is still|placing .* did nothing/i.test(message)
}
