// A small farm on a reserved plot (the base's farm_plot inside its walls), without a bucket.
// Pure, unit-tested in test/food-source.test.ts; foodSources.ts reads the blocks and does the work.
//
// The 1.21.1 rules this relies on (FarmBlock, CropBlock, IceBlock, Biome.shouldFreeze):
// - Farmland is wet when water (source or flowing) is within 4 blocks sideways, at its own height
//   or one above (FarmBlock.isNearWater: pos -4,0,-4 to +4,1,+4). Rain wets it too.
// - Dry farmland with a crop on it stays farmland (crops are in MAINTAINS_FARMLAND); bare dry
//   farmland turns back into dirt. So a plot without water works if every tilled cell is
//   planted right away.
// - Crops grow when the light at the crop is 9 or more (sky or block light, whatever the time
//   of day: getRawBrightness with no darkening). Under the open sky that is always true; under a
//   roof it takes torches (14 at the torch, one less per block, so within 5 steps).
// - Growth chance per random tick is 1 / (floor(25 / f) + 1), f from the farmland around the crop:
//   1 for the crop's own block plus 1 (dry) or 3 (wet) under it, plus a quarter of that for each
//   of the 8 neighbours. An all-wet 3x3 gives f = 10 (1 in 3), all-dry f = 4 (1 in 7): a dry plot
//   grows a bit more than half as fast. Wheat needs 7 steps, about 24 minutes wet, 55 dry.
// - Ice broken without Silk Touch over a solid block becomes a water source, but it drops
//   nothing, so ice can't be carried there. With a Silk Touch tool it can: put the ice in the
//   plot's centre and break it with a bare hand or a plain tool, and there is water.
// - Water freezes in a cold biome only as the top block under the sky with block light below 10.
//   Inside a roofed base it never freezes; inside open walls it needs a block over it or a torch.

import { z } from 'zod'

export type PlotGround =
  | 'farmland'
  | 'tillable' // grass, dirt, coarse dirt, rooted dirt, dirt path
  | 'swap' // stone, gravel, sand, the base's floor: dig it out and put dirt in its place
  | 'water'
  | 'blocked' // something it must not touch (a chest, protected)

export type PlotAbove = 'air' | 'crop' | 'plant' | 'snow' | 'torch' | 'blocked'

export interface PlotCell {
  dx: number
  dz: number
  ground: PlotGround
  above: PlotAbove
  /** Light at the crop's block (one above the ground), or null when the server sends none. */
  sky: number | null
  block: number | null
  /** The ground block's name, for reasons. */
  name?: string
}

export type PlotWaterMode = 'auto' | 'water' | 'dry'

export interface PlotFarmInput {
  /** Side of the plot (3 or 5). Cells are keyed by dx,dz from the centre. */
  size: number
  cells: PlotCell[]
  /** Water within reach of the plot, as dx,dy,dz from its centre ground (dy 0 or 1 hydrates). */
  water: { dx: number, dy: number, dz: number }[]
  /** Ice blocks it carries (only from Silk Touch), and whether it can break one without Silk Touch. */
  iceItems: number
  /** A water bucket in hand for the centre (choosePlotWater picked it and it got one). */
  bucket?: boolean
  plainBreak: boolean
  /** Cold biome and open sky over the centre: water there would freeze without help. */
  freezes: boolean
  /** Torches carried or that it can make now. */
  torches: number
  /** Dirt carried (for swapping stone cells). */
  dirt: number
  /** Seeds carried. */
  seeds: number
  /** Ring spots just outside the plot where a torch can stand (dx,dz from the centre). */
  torchSpots: { dx: number, dz: number }[]
  mode: PlotWaterMode
  /** May dig out stone or sand cells and put dirt in (farming.plotSwap). */
  swap: boolean
  /** Fewer cells than this that can hold a crop: not worth a farm. Default 3. */
  minCells?: number
}

export interface PlotFarmPlan {
  ok: boolean
  /** Where its water comes from: water already in reach, a bucket poured in the middle, ice it carries, or none (a dry plot). */
  water: 'near' | 'bucket' | 'ice' | 'none'
  /** What the centre becomes. */
  centre: 'water' | 'torch' | 'crop'
  /** Cells to till and plant now (dx,dz), centre first out; as many as there are seeds. */
  till: [number, number][]
  /** Cells to dig out and fill with dirt first (stone, sand). */
  swap: [number, number][]
  /** Torches to put up (dx,dz at crop height), the centre first. */
  torches: [number, number][]
  /** Lowest light a crop cell gets once the torches are up (null: unknown light). */
  minLight: number | null
  growth: 'wet' | 'dry'
  reason: string
}

/** Crops grow at this light and above. */
export const CROP_LIGHT = 9
/** Light a torch gives at its own block. */
export const TORCH_LIGHT = 14
/** Farmland is kept wet by water this many blocks away (square), at its height or one above. */
export const WET_RANGE = 4

/** Wet-farmland test of 1.21.1 FarmBlock.isNearWater, from water offsets relative to the farmland. */
export function hydrated (cell: { dx: number, dz: number }, water: readonly { dx: number, dy: number, dz: number }[]): boolean {
  return water.some(w => (w.dy === 0 || w.dy === 1) && Math.max(Math.abs(w.dx - cell.dx), Math.abs(w.dz - cell.dz)) <= WET_RANGE)
}

/** Light at a cell from torches (Manhattan through air, both at crop height). */
export function torchLight (cell: { dx: number, dz: number }, torches: readonly (readonly [number, number])[]): number {
  return torches.reduce((m, [tx, tz]) => Math.max(m, TORCH_LIGHT - Math.abs(tx - cell.dx) - Math.abs(tz - cell.dz)), 0)
}

/** Random-tick growth chance of a crop (1.21.1 CropBlock.getGrowthSpeed, no row penalty), for docs and status. */
export function growthChance (wet: boolean): number {
  const g = wet ? 3 : 1
  const f = 1 + g + 8 * (g / 4)
  return 1 / (Math.floor(25 / f) + 1)
}

const ring = (c: { dx: number, dz: number }) => Math.max(Math.abs(c.dx), Math.abs(c.dz))
const near = (a: { dx: number, dz: number }, b: { dx: number, dz: number }) =>
  ring(a) - ring(b) || (Math.abs(a.dx) + Math.abs(a.dz)) - (Math.abs(b.dx) + Math.abs(b.dz)) || a.dx - b.dx || a.dz - b.dz

/**
 * The work to turn a reserved plot into a farm. Water first: water already in reach of the plot,
 * else ice it carries (Silk Touch) broken in the centre, else (mode auto or dry) a dry plot with
 * a torch in the centre. Cells that can't hold a crop are left; stone and sand are swapped for
 * dirt when allowed and it has the dirt. Torches go up until every crop cell has light 9.
 */
export function planPlotFarm (p: PlotFarmInput): PlotFarmPlan {
  const no = (reason: string): PlotFarmPlan => ({ ok: false, water: 'none', centre: 'crop', till: [], swap: [], torches: [], minLight: null, growth: 'dry', reason })
  const centre = p.cells.find(c => c.dx === 0 && c.dz === 0)
  if (!centre) return no('the plot is not loaded')
  // a centre it must not touch can't hold water or a crop, but a dry plot's torch still goes on it,
  // and with water in reach the other cells are the farm (Pax's plot was refused for days over this)
  const centreBlocked = centre.ground === 'blocked'

  // water
  let water: PlotFarmPlan['water'] = 'none'
  const wetFrom = [...p.water]
  if (p.mode !== 'dry') {
    if (centre.ground === 'water') { water = 'near'; wetFrom.push({ dx: 0, dy: 0, dz: 0 }) }
    else if (p.cells.filter(c => c.ground !== 'water').every(c => hydrated(c, wetFrom)) && wetFrom.length) water = 'near'
    else if (p.bucket && !centreBlocked) { water = 'bucket'; wetFrom.push({ dx: 0, dy: 0, dz: 0 }) }
    else if (p.iceItems > 0 && p.plainBreak && !centreBlocked) { water = 'ice'; wetFrom.push({ dx: 0, dy: 0, dz: 0 }) }
  }
  if (water === 'none' && p.mode === 'water') return no('no water in reach of the plot and no ice to make some (ice only travels with Silk Touch), and farming.plotWater is water')
  const centreKind: PlotFarmPlan['centre'] = water === 'ice' || water === 'bucket' || centre.ground === 'water' ? 'water' : water === 'none' ? 'torch' : 'crop'
  const growth: PlotFarmPlan['growth'] = water === 'none' ? 'dry' : 'wet'

  // cells for crops
  const usable = (c: PlotCell) => !(c.dx === 0 && c.dz === 0 && centreKind !== 'crop')
  const free = (c: PlotCell) => c.above === 'air' || c.above === 'plant' || c.above === 'snow'
  const cand = p.cells.filter(c => usable(c) && c.ground !== 'water' && c.ground !== 'blocked' && free(c)).sort(near)
  const fit = cand.filter(c => c.ground !== 'swap' || p.swap).length + p.cells.filter(c => c.above === 'crop').length
  const minCells = p.minCells ?? 3
  if (fit < minCells && p.seeds > 0) {
    const stone = cand.filter(c => c.ground === 'swap').length
    const blocked = p.cells.filter(c => c.ground === 'blocked').map(c => c.name).filter(Boolean)
    const what = blocked.length ? ` (${[...new Set(blocked)].join(', ')} it must not touch)` : ''
    return no(`only ${fit} cells of the plot can hold a crop (${minCells} needed): water, ice or blocks on the rest${what}${stone && !p.swap ? `, ${stone} stone cells and farming.plotSwap is off` : ''}`)
  }
  let dirt = p.dirt
  const swap: [number, number][] = []
  const till: [number, number][] = []
  let seeds = Math.max(0, p.seeds)
  for (const c of cand) {
    if (!seeds) break
    if (c.ground === 'swap') {
      if (!p.swap || dirt <= 0) continue
      swap.push([c.dx, c.dz]); dirt--
    }
    till.push([c.dx, c.dz]); seeds--
  }
  const growing = p.cells.filter(c => c.above === 'crop').length
  if (!till.length && !growing) {
    const stone = cand.filter(c => c.ground === 'swap').length
    if (!p.seeds) return no('no seeds to plant the plot')
    if (stone && !p.swap) return no(`${stone} cells of the plot are stone or sand and farming.plotSwap is off`)
    if (stone) return no(`${stone} cells of the plot are stone or sand and I have no dirt to put in`)
    return no('nothing on the plot can be tilled')
  }

  // light: under the sky crops always have it; else torches until every crop cell is at 9
  const crops = [...till.map(([dx, dz]) => ({ dx, dz })), ...p.cells.filter(c => c.above === 'crop')]
  const known = p.cells.some(c => (c.sky ?? 0) > 0 || (c.block ?? 0) > 0)
  const lightOf = (c: { dx: number, dz: number }, t: readonly (readonly [number, number])[]) => {
    const cell = p.cells.find(x => x.dx === c.dx && x.dz === c.dz)
    return Math.max(known ? (cell?.sky ?? 0) : 0, known ? (cell?.block ?? 0) : 0, torchLight(c, t))
  }
  const torches: [number, number][] = []
  const spots: [number, number][] = [...(centreKind === 'torch' ? [[0, 0] as [number, number]] : []), ...p.torchSpots.map(s => [s.dx, s.dz] as [number, number])]
  let left = p.torches
  const dark = () => crops.filter(c => lightOf(c, torches) < CROP_LIGHT)
  while (dark().length && left > 0) {
    // the spot that lights the most dark cells, the centre first on a tie
    let best: [number, number] | null = null
    let bestN = 0
    for (const s of spots) {
      if (torches.some(t => t[0] === s[0] && t[1] === s[1])) continue
      const n = dark().filter(c => torchLight(c, [...torches, s]) >= CROP_LIGHT).length
      if (n > bestN) { best = s; bestN = n }
    }
    if (!best) break
    torches.push(best); left--
  }
  // a dry plot's centre cell takes the torch even when the light is fine: it is no crop cell anyway
  if (centreKind === 'torch' && !torches.some(t => t[0] === 0 && t[1] === 0) && left > 0) torches.unshift([0, 0])
  const stillDark = dark().length
  const minLight = crops.length ? Math.min(...crops.map(c => lightOf(c, torches))) : null
  if (stillDark && known) return no(`${stillDark} plot cells would stay below light 9 and I have no more torches${p.torches ? '' : ' (coal and a stick make 4)'}`)

  // the centre water freezes under the sky in the cold with block light below 10. A block over
  // it has nothing to be placed against in a planted plot (crops all round), so a torch on the
  // ring does it: one step outside a 3x3 it gives the water 11, outside a 5x5 10.
  let centreLight = torchLight({ dx: 0, dz: 0 }, torches) - 1 // the water is one below the torches' level
  if (centreKind === 'water' && p.freezes && centreLight < 10 && left > 0) {
    const s2 = p.torchSpots.map(s => [s.dx, s.dz] as [number, number]).filter(s => !torches.some(t => t[0] === s[0] && t[1] === s[1]))
      .sort((a, b) => (Math.abs(a[0]) + Math.abs(a[1])) - (Math.abs(b[0]) + Math.abs(b[1])))[0]
    if (s2) { torches.push(s2); left--; centreLight = torchLight({ dx: 0, dz: 0 }, torches) - 1 }
  }
  if (centreKind === 'water' && p.freezes && centreLight < 10) return no('the water in the middle would freeze under the open sky and I have no torch to put next to it')

  const parts = [
    water === 'near' ? 'water in reach' : water === 'bucket' ? 'water from a bucket poured in the middle' : water === 'ice' ? 'ice I carry, broken in the middle for water' : 'no water: a dry plot (crops on dry farmland grow about half as fast and the farmland stays as long as it is planted)',
    `till and plant ${till.length}`,
    ...(swap.length ? [`swap ${swap.length} stone cells for dirt`] : []),
    ...(torches.length ? [`${torches.length} torch${torches.length > 1 ? 'es' : ''} for light${centreKind === 'water' && p.freezes ? ' and to keep the water open' : ''}`] : []),
    ...(stillDark && !known ? ['the server sends no light, so I could not check the light'] : [])
  ]
  return { ok: true, water, centre: centreKind, till, swap, torches, minLight, growth, reason: parts.join(', ') }
}

// ------------------------------------------------------------------ settings

export interface PlotFarmSettings {
  /** Wanted side of the base's farm plot (odd, 3 to 11): farm_plot fits one this big and grows a smaller one. */
  plotSize: number
  /** Smallest plot worth keeping (odd, 3 to plotSize). */
  plotMin: number
  /** Grass this far from home may be broken for seeds the plot is short of. */
  plotSeedRadius: number
}

export const PLOT_FARM_DEFAULTS: PlotFarmSettings = { plotSize: 7, plotMin: 3, plotSeedRadius: 32 }

const PLOT_SCHEMA = {
  plotSize: z.number().int().min(3).max(11),
  plotMin: z.number().int().min(3).max(11),
  plotSeedRadius: z.number().int().min(8).max(96)
}

const odd = (n: number) => n % 2 ? n : n - 1

/** settings.farming's plot knobs over the defaults; a value that fails its schema falls back to the default. Even sides go one down. */
export function plotFarmSettings (raw: unknown): PlotFarmSettings {
  const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const out: PlotFarmSettings = { ...PLOT_FARM_DEFAULTS }
  for (const k of Object.keys(PLOT_SCHEMA) as (keyof PlotFarmSettings)[]) {
    if (o[k] === undefined) continue
    const r = PLOT_SCHEMA[k].safeParse(o[k])
    if (r.success) out[k] = r.data
  }
  out.plotSize = Math.max(3, odd(out.plotSize))
  out.plotMin = Math.max(3, Math.min(out.plotSize, odd(out.plotMin)))
  return out
}

// ------------------------------------------------------------------ water for a bigger plot

/** Plots this big and up get a water source in the centre when it can. */
export const PLOT_WATER_MIN = 5

export type PlotWaterSource = 'near' | 'bucket' | 'chest_bucket' | 'ice' | 'fill' | 'craft' | 'none'

export interface PlotWaterInput {
  size: number
  mode: PlotWaterMode
  /** Water already wets every cell of the plot. */
  near: boolean
  /** The centre can't be dug (something it must not touch). */
  centreBlocked: boolean
  /** Water buckets carried, and in containers it may take from. */
  waterBuckets: number
  storedWaterBuckets: number
  /** Empty buckets carried plus stored. */
  buckets: number
  /** Iron ingots carried plus stored (3 make a bucket). */
  iron: number
  /** A water source it can fill a bucket at. */
  fillFrom: boolean
  /** Silk Touch ice it carries and may use (farming.iceWater). */
  ice: boolean
  /** Below this side the plot stays as it was (water in reach or ice). Default PLOT_WATER_MIN. */
  minSize?: number
}

/**
 * Where the plot's centre water comes from. Water in reach first; a plot of 5 and up then takes a
 * water bucket it carries, one from a container, carried ice (the old ice path), an empty bucket
 * filled at water, a bucket crafted from 3 iron ingots and filled; else it stays dry. Smaller plots
 * keep the old rule (water in reach, else ice, else dry). Pure.
 */
export function choosePlotWater (i: PlotWaterInput): { source: PlotWaterSource, reason: string } {
  if (i.mode === 'dry') return { source: 'none', reason: 'farming.plotWater is dry' }
  if (i.near) return { source: 'near', reason: 'water already in reach of the plot' }
  if (i.centreBlocked) return { source: 'none', reason: 'the middle of the plot is something I must not touch, so no water there' }
  if (i.size < (i.minSize ?? PLOT_WATER_MIN)) return i.ice ? { source: 'ice', reason: 'ice I carry, broken in the middle' } : { source: 'none', reason: `a ${i.size}x${i.size} plot stays dry without water in reach or ice` }
  if (i.waterBuckets > 0) return { source: 'bucket', reason: 'a water bucket I carry' }
  if (i.storedWaterBuckets > 0) return { source: 'chest_bucket', reason: 'a water bucket from my chests' }
  if (i.ice) return { source: 'ice', reason: 'ice I carry, broken in the middle' }
  if (i.buckets > 0 && i.fillFrom) return { source: 'fill', reason: 'an empty bucket filled at water near home' }
  if (i.iron >= 3 && i.fillFrom) return { source: 'craft', reason: 'a bucket crafted from 3 iron ingots and filled at water near home' }
  const why = [
    'no water bucket',
    i.buckets > 0 ? 'no water near home to fill my bucket' : i.iron >= 3 ? 'no water near home to fill a bucket' : `no bucket and ${i.iron} iron ingots (3 make one)`,
    'no ice'
  ]
  return { source: 'none', reason: why.join(', ') }
}

// ------------------------------------------------------------------ seeds

/**
 * Seeds the plot is short of: the cells that can still take a crop against what it carries,
 * what its chests hold and what grass must give. Pure.
 */
export function plotSeedNeed (i: { cells: number, carried: number, stored: number }): { want: number, fromChests: number, fromGrass: number } {
  const want = Math.max(0, i.cells)
  const short = Math.max(0, want - Math.max(0, i.carried))
  const fromChests = Math.min(short, Math.max(0, i.stored))
  return { want, fromChests, fromGrass: short - fromChests }
}

/** Cells of a plot read that could take a crop now: not water, not blocked, nothing standing on them, not the centre when it gets water or a torch. Pure. */
export function plantableCells (cells: readonly PlotCell[], centreFree: boolean): number {
  return cells.filter(c => !(c.dx === 0 && c.dz === 0 && !centreFree) && c.ground !== 'water' && c.ground !== 'blocked' && (c.above === 'air' || c.above === 'plant' || c.above === 'snow')).length
}
