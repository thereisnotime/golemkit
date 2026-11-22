// Small formatting helpers shared by core and adapters.

/** Block coordinates as "x y z" (floored). */
export function fmtPos (p: { x: number, y: number, z: number }): string {
  return `${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}`
}

/** Straight-line distance, computed exactly like vec3's distanceTo (other - this). */
export function distance (from: { x: number, y: number, z: number }, to: { x: number, y: number, z: number }): number {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const dz = to.z - from.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}
