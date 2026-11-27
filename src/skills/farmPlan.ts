// Pure planning for looking after a farm: which bare farmland to plant, which trampled dirt
// to till again, which cells to add so the plot grows towards its target size, and whether
// the water in the middle has to be put back. No mineflayer here, so it is unit-tested.
import type { Pos } from './foodPlan.ts'

/** What one ground cell of a farm square is (keys "dx,dz" from the farm's water block). */
export type FarmCell =
  | 'ripe' // farmland with a ripe crop
  | 'growing' // farmland with a crop that is not ripe yet
  | 'bare' // farmland with air above
  | 'dirt' // grass/dirt it may till (trampled farmland turns back into dirt)
  | 'water'
  | 'blocked' // fences, torches, stone, sand, a tree, protected ground...

export interface FarmGrid {
  /** The farm's water block. */
  center: Pos
  cells: Record<string, FarmCell>
}

export interface FarmWorkOptions {
  /** Side of the square the farm grows towards (odd, 3..9). Default 9. */
  targetSize?: number
  /** Plantable seeds carried. */
  seeds: number
  /** Seeds kept back for replanting: new cells are only added with seeds beyond this. Default 4. */
  seedReserve?: number
  /** Has (or can make) a hoe and may dig: without one, only bare farmland is planted. Default true. */
  canTill?: boolean
  /** Can put water back (a water bucket, or a bucket and a source near). Default false. */
  canWater?: boolean
  /** A farm without water (a dry plot): every cell may be tilled, nothing to put back. Default false. */
  dry?: boolean
}

export interface FarmWork {
  /** Bare farmland to plant, nearest to the water first. */
  plant: Pos[]
  /** Dirt inside the farm's current square (trampled, or never tilled): till and plant. */
  retill: Pos[]
  /** Dirt outside the current square, up to the target size: till and plant to grow the farm. */
  extend: Pos[]
  /** The water in the middle is gone and can be put back here. */
  water: Pos | null
  /** Side of the square the farmland covers now (1 with no farmland). */
  size: number
  target: number
  /** Farmland now (ripe, growing and bare). */
  farmland: number
  /** Seeds short of doing all the work (planting, re-tilling, growing to the target) and keeping the reserve. */
  seedsWanted: number
  reason: string
}

/** Farmland stays wet within 4 blocks (square) of water at its height. */
export const HYDRATION = 4

const key = (dx: number, dz: number) => `${dx},${dz}`
const parse = (k: string): [number, number] => { const [a, b] = k.split(','); return [Number(a), Number(b)] }
const cheb = (dx: number, dz: number) => Math.max(Math.abs(dx), Math.abs(dz))

export function oddSize (n: number): number {
  const s = Math.max(3, Math.min(9, Math.round(n)))
  return s % 2 ? s : s - 1
}

/**
 * What to do on a farm now. Planting bare farmland comes first (it reverts to dirt if left
 * bare), then re-tilling dirt inside the current square, then one ring at a time outwards
 * towards the target size. Only cells it has seeds for are tilled (bare farmland dries out),
 * and growing never touches the last `seedReserve` seeds. Cells out of the water's reach
 * are never tilled.
 */
export function planFarmWork (g: FarmGrid, o: FarmWorkOptions): FarmWork {
  const target = oddSize(o.targetSize ?? 9)
  const th = (target - 1) / 2
  const reserve = Math.max(0, o.seedReserve ?? 4)
  const canTill = o.canTill !== false
  const cells = Object.entries(g.cells).map(([k, v]) => { const [dx, dz] = parse(k); return { dx, dz, v } })
  const waters = cells.filter(c => c.v === 'water')
  const centerWet = g.cells[key(0, 0)] === 'water'
  // the centre counts as water when it can be put back
  const water = !o.dry && !centerWet && o.canWater && g.cells[key(0, 0)] !== undefined ? { ...g.center } : null
  const wetFrom = [...waters.map(c => [c.dx, c.dz] as const), ...(water ? [[0, 0] as const] : [])]
  const wet = (dx: number, dz: number) => !!o.dry || wetFrom.some(([wx, wz]) => cheb(dx - wx, dz - wz) <= HYDRATION)
  const isLand = (v: FarmCell) => v === 'ripe' || v === 'growing' || v === 'bare'
  const land = cells.filter(c => isLand(c.v))
  const h = land.reduce((m, c) => Math.max(m, cheb(c.dx, c.dz)), 0)
  const size = land.length ? 2 * h + 1 : 1
  const at = (c: { dx: number, dz: number }): Pos => ({ x: g.center.x + c.dx, y: g.center.y, z: g.center.z + c.dz })
  const near = (a: { dx: number, dz: number }, b: { dx: number, dz: number }) =>
    (cheb(a.dx, a.dz) - cheb(b.dx, b.dz)) || ((Math.abs(a.dx) + Math.abs(a.dz)) - (Math.abs(b.dx) + Math.abs(b.dz))) || (a.dx - b.dx) || (a.dz - b.dz)

  let seeds = Math.max(0, o.seeds)
  const bare = cells.filter(c => c.v === 'bare').sort(near)
  const plant = bare.slice(0, seeds).map(at)
  seeds -= plant.length

  const dirt = canTill ? cells.filter(c => c.v === 'dirt' && cheb(c.dx, c.dz) <= th && !(c.dx === 0 && c.dz === 0) && wet(c.dx, c.dz)).sort(near) : []
  const inside = dirt.filter(c => land.length && cheb(c.dx, c.dz) <= h)
  const retill = inside.slice(0, seeds).map(at)
  seeds -= retill.length

  const outside = dirt.filter(c => !land.length || cheb(c.dx, c.dz) > h)
  const extend = outside.slice(0, Math.max(0, seeds - reserve)).map(at)

  const all = bare.length + inside.length + outside.length
  const seedsWanted = Math.max(0, all + reserve - Math.max(0, o.seeds))
  const parts: string[] = []
  if (water) parts.push('put the water back')
  if (plant.length) parts.push(`plant ${plant.length} bare farmland`)
  if (retill.length) parts.push(`re-till ${retill.length}`)
  if (extend.length) parts.push(`grow by ${extend.length} towards ${target}x${target}`)
  let reason = parts.length ? parts.join(', ') : 'nothing to do'
  if (!parts.length && all > 0) reason = `${all} cells waiting for seeds (have ${o.seeds}, keeping ${reserve})`
  if (!o.dry && !centerWet && !water) reason += '; the water is gone and there is no bucket'
  return { plant, retill, extend, water, size, target, farmland: land.length, seedsWanted, reason }
}

/** Cells of work that can be done now. */
export function farmWorkCount (w: Pick<FarmWork, 'plant' | 'retill' | 'extend' | 'water'>): number {
  return w.plant.length + w.retill.length + w.extend.length + (w.water ? 1 : 0)
}
