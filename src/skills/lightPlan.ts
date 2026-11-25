// Spawn-proofing (pure, unit-tested): which spots around home or a farm are dark enough for
// hostile mobs, where torches go so every one of them gets light, and what to craft or smelt
// to have the torches. In 1.21.1 overworld monsters spawn only at block light 0, and a torch
// gives 14 at its own block, one less per block of Manhattan distance, so a torch about every
// 12 blocks keeps flat ground safe; a higher target leaves a margin for walls and corners the
// estimate doesn't see. lighting.ts reads the world into these and does the placing.

export interface Pos { x: number, y: number, z: number }

/** Light a placed torch gives at its own block. */
export const TORCH_LIGHT = 14

/**
 * Block light of light sources the bot may see (1.21.1). Blocks with a `lit` state only count
 * when lit; the rest always. Used to estimate light where the client has no light data and for
 * torches the plan adds.
 */
export const LIGHT_LEVELS: Record<string, number> = {
  torch: 14, wall_torch: 14, soul_torch: 10, soul_wall_torch: 10, redstone_torch: 7, redstone_wall_torch: 7,
  lantern: 15, soul_lantern: 10, glowstone: 15, sea_lantern: 15, jack_o_lantern: 15, shroomlight: 15,
  ochre_froglight: 15, verdant_froglight: 15, pearlescent_froglight: 15, beacon: 15, conduit: 15, end_rod: 14,
  lava: 15, fire: 15, soul_fire: 10, campfire: 15, soul_campfire: 10, redstone_lamp: 15, furnace: 13,
  blast_furnace: 13, smoker: 13, crying_obsidian: 10, magma_block: 3, copper_bulb: 15, candle: 3
}

/** Blocks whose light depends on their `lit` state. */
export const LIT_STATE = /^(campfire|soul_campfire|redstone_lamp|furnace|blast_furnace|smoker|copper_bulb|candle)$/

export interface LightSource extends Pos { level: number }

/** One standable spot of the survey: a free cell with a floor under it and room above. */
export interface LightCell extends Pos {
  /** Real block light at the cell from the chunk's light data; null when unknown. */
  light: number | null
  /** Sky light at the cell (above 0: open to the sky or next to an opening); null or missing when unknown. */
  sky?: number | null
  /** A monster could spawn here (full, opaque floor; free cell and head room). Only these need light. */
  spawnable: boolean
  /** Block in the cell (air, short_grass, wheat...). */
  block: string
  /** Snow layers in the cell when `block` is snow (1 is replaced by a torch placed there). */
  layers?: number
  /** Block under it. */
  floor: string
  /** The floor's top can hold a torch (full sturdy block, nothing that opens a GUI). */
  floorTorch: boolean
  /** A wall block next to the cell a wall torch can hang on, when there is one. */
  wall?: Pos | null
  /** Water in the cell or the cell waterlogged. */
  water?: boolean
  /** Within a block of a door, gate or trapdoor. */
  nearDoor?: boolean
  /** Protected area, spawn protection, or a spot the server refused before. */
  offLimits?: boolean
  /** A torch the bot put here was taken away (by the owner, most likely): leave the spot alone. */
  removed?: boolean
}

export interface TorchSpot extends Pos {
  kind: 'floor' | 'wall'
  /** The block it is placed against: the floor under it, or the wall. */
  against: Pos
}

/** Floors and cells a torch never goes on or in: crops and their soil, paths. */
const NO_TORCH_FLOOR = /^(farmland|dirt_path|soul_sand|soul_soil|mud)$|leaves$/
const FREE_CELL = /^(air|cave_air)$/

/** One layer of snow: a torch goes in its place. */
export function thinSnow (c: Pick<LightCell, 'block' | 'layers'>): boolean {
  return c.block === 'snow' && (c.layers ?? 1) <= 1
}

/** Why no torch can go in this cell, or null when one can (floor first, else on the wall). */
export function torchSpotProblem (c: LightCell): string | null {
  if (c.offLimits) return 'off limits'
  if (c.water) return 'water'
  if (c.removed) return 'a torch there was taken away'
  // a single snow layer is replaced by whatever is placed into it, a torch too (SnowLayerBlock.canBeReplaced)
  if (!FREE_CELL.test(c.block) && !thinSnow(c)) return `${c.block} is there`
  if (c.floor === 'farmland') return 'farmland'
  if (c.floor === 'dirt_path') return 'a path'
  if (c.nearDoor) return 'in front of a door'
  if (c.floorTorch && !NO_TORCH_FLOOR.test(c.floor)) return null
  if (c.wall) return null
  return 'nothing to put a torch on'
}

/** The torch a cell can take, or null. Floor torches when the floor allows, else on the wall. */
export function torchFor (c: LightCell): TorchSpot | null {
  if (torchSpotProblem(c)) return null
  if (c.floorTorch && !NO_TORCH_FLOOR.test(c.floor)) return { x: c.x, y: c.y, z: c.z, kind: 'floor', against: { x: c.x, y: c.y - 1, z: c.z } }
  return c.wall ? { x: c.x, y: c.y, z: c.z, kind: 'wall', against: c.wall } : null
}

/** How many surveyed cells can't take a torch, by reason, most common first: "40 off limits, 12 farmland". */
export function spotProblems (cells: readonly LightCell[], top = 3): string {
  const n = new Map<string, number>()
  for (const c of cells) {
    const why = torchSpotProblem(c)
    if (why) n.set(why, (n.get(why) ?? 0) + 1)
  }
  return [...n].sort((a, b) => b[1] - a[1]).slice(0, top).map(([why, c]) => `${c} ${why}`).join(', ')
}

/**
 * The cells on the ground sheet around `centre`: the ones at the centre's level (within
 * `seedDy`) and every cell connected to them by steps of at most `step` blocks up or down to a
 * neighbouring column, plus cells open to the sky (light data). Caves under the area (sealed by
 * a roof of 1+ blocks, so 3+ below the surface next to them) and pockets inside hills drop out;
 * slopes, the ring around a farm and buildings at the centre's level stay. Used for farms, where
 * only the surface around the field matters and torches in a cave below are wasted (and out of
 * reach).
 */
export function surfaceCells<T extends LightCell> (cells: readonly T[], centre: Pos, o: { seedDy?: number, step?: number } = {}): T[] {
  const seedDy = o.seedDy ?? 1
  const step = o.step ?? 2
  const col = (x: number, z: number) => `${x},${z}`
  const byColumn = new Map<string, number[]>()
  cells.forEach((c, i) => {
    const k = col(c.x, c.z)
    const list = byColumn.get(k)
    if (list) list.push(i)
    else byColumn.set(k, [i])
  })
  const reached = new Array<boolean>(cells.length).fill(false)
  const queue: number[] = []
  cells.forEach((c, i) => {
    if (Math.abs(c.y - centre.y) <= seedDy) { reached[i] = true; queue.push(i) }
  })
  while (queue.length) {
    const c = cells[queue.pop()!]!
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      for (const j of byColumn.get(col(c.x + dx, c.z + dz)) ?? []) {
        if (reached[j] || Math.abs(cells[j]!.y - c.y) > step) continue
        reached[j] = true
        queue.push(j)
      }
    }
  }
  // open to the sky but not connected (a ledge, a walkway): still the surface; it doesn't spread
  // further, so a cave mouth doesn't pull in the cave behind it
  return cells.filter((c, i) => reached[i] || (c.sky ?? 0) > 0)
}

export const manhattan = (a: Pos, b: Pos) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z)

/**
 * Estimated block light at a cell: the real light when known, raised by what the sources give
 * (level minus Manhattan distance). Light doesn't go through walls, so the estimate can be
 * high behind one; a re-check with real light data catches those.
 */
export function estimateLight (c: Pos & { light?: number | null }, sources: readonly LightSource[]): number {
  let best = c.light ?? 0
  for (const s of sources) {
    const l = s.level - manhattan(s, c)
    if (l > best) best = l
  }
  return Math.max(0, Math.min(15, best))
}

export interface TorchPlanOptions {
  /** Every spawnable cell should end up with at least this block light (1 = no spawns). Default 1. */
  target?: number
  /** Torches at most. Default 16. */
  maxTorches?: number
  /** Light of a torch. Default TORCH_LIGHT. */
  torchLight?: number
}

export interface TorchPlan {
  torches: TorchSpot[]
  /** Spawnable cells below the target before the plan. */
  dark: number
  /** Spawnable cells still below the target with the planned torches (max torches, or no spot can reach them). */
  left: number
  /** Spawnable cells looked at. */
  spawnable: number
}

/**
 * Greedy torch cover: repeatedly picks the spot that lights the most dark cells up to the target
 * (floor torches before wall torches on a tie, then the one nearest the darkest cells' middle by
 * position order, so the plan is stable), until no cell is dark, maxTorches is reached or no spot
 * helps. Greedy set cover is within a log factor of the minimum and fast enough for a few thousand
 * cells.
 */
export function planTorches (cells: readonly LightCell[], sources: readonly LightSource[], o: TorchPlanOptions = {}): TorchPlan {
  const target = Math.max(1, Math.min(15, o.target ?? 1))
  const max = o.maxTorches ?? 16
  const torch = o.torchLight ?? TORCH_LIGHT
  const reach = torch - target // a torch lights a cell to the target within this Manhattan distance
  const spawnable = cells.filter(c => c.spawnable)
  const darkCells = spawnable.filter(c => estimateLight(c, sources) < target)
  const dark = darkCells.length
  if (!dark || reach < 0) return { torches: [], dark, left: dark, spawnable: spawnable.length }

  // dark cells by column, for the neighbourhood lookups
  const byColumn = new Map<number, number[]>()
  const col = (x: number, z: number) => x * 1e8 + z
  darkCells.forEach((c, i) => {
    const k = col(c.x, c.z)
    const list = byColumn.get(k)
    if (list) list.push(i)
    else byColumn.set(k, [i])
  })
  const candidates: { spot: TorchSpot, covers: number[] }[] = []
  for (const c of cells) {
    const spot = torchFor(c)
    if (!spot) continue
    const covers: number[] = []
    for (let dx = -reach; dx <= reach; dx++) {
      const rest = reach - Math.abs(dx)
      for (let dz = -rest; dz <= rest; dz++) {
        const list = byColumn.get(col(c.x + dx, c.z + dz))
        if (!list) continue
        const dyMax = rest - Math.abs(dz)
        for (const i of list) if (Math.abs(darkCells[i]!.y - c.y) <= dyMax) covers.push(i)
      }
    }
    if (covers.length) candidates.push({ spot, covers })
  }
  const lit = new Array<boolean>(dark).fill(false)
  const torches: TorchSpot[] = []
  // lazy greedy: a candidate's gain only shrinks, so the cached gain is an upper bound; the best by
  // cached gain whose fresh gain is unchanged is the best by fresh gain (same pick as the eager loop)
  const gain = candidates.map(c => c.covers.length)
  const above = (a: number, b: number) => gain[a]! > gain[b]! || (gain[a] === gain[b] && better(candidates[a]!.spot, candidates[b]!.spot))
  const heap = new MaxHeap(candidates.map((_, i) => i), above)
  let left = dark
  while (left > 0 && torches.length < max) {
    let pick = -1
    while (heap.size) {
      const top = heap.pop()!
      let fresh = 0
      for (const i of candidates[top]!.covers) if (!lit[i]) fresh++
      if (fresh === 0) continue
      if (fresh === gain[top]) { pick = top; break }
      gain[top] = fresh
      heap.push(top)
    }
    if (pick < 0) break
    const best = candidates[pick]!
    torches.push(best.spot)
    for (const i of best.covers) if (!lit[i]) { lit[i] = true; left-- }
  }
  return { torches, dark, left, spawnable: spawnable.length }
}

/** A binary max-heap of indices ordered by `above`. */
class MaxHeap {
  private items: number[] = []
  private readonly above: (a: number, b: number) => boolean
  constructor (items: number[], above: (a: number, b: number) => boolean) {
    this.above = above
    for (const i of items) this.push(i)
  }

  get size (): number { return this.items.length }

  push (v: number): void {
    const a = this.items
    a.push(v)
    let i = a.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (!this.above(a[i]!, a[p]!)) break
      ;[a[i], a[p]] = [a[p]!, a[i]!]
      i = p
    }
  }

  pop (): number | undefined {
    const a = this.items
    const top = a[0]
    const last = a.pop()
    if (a.length && last !== undefined) {
      a[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1, r = l + 1
        let m = i
        if (l < a.length && this.above(a[l]!, a[m]!)) m = l
        if (r < a.length && this.above(a[r]!, a[m]!)) m = r
        if (m === i) break
        ;[a[i], a[m]] = [a[m]!, a[i]!]
        i = m
      }
    }
    return top
  }
}

/** Tie-break: floor torches first, then by position so the plan doesn't depend on input order. */
function better (a: TorchSpot, b: TorchSpot): boolean {
  if (a.kind !== b.kind) return a.kind === 'floor'
  return a.x !== b.x ? a.x < b.x : a.z !== b.z ? a.z < b.z : a.y < b.y
}

/** The order to place torches in: nearest first from `from`, then nearest to the last one. */
export function placingOrder<T extends Pos> (spots: readonly T[], from: Pos): T[] {
  const rest = [...spots]
  const out: T[] = []
  let at = from
  while (rest.length) {
    let bi = 0
    for (let i = 1; i < rest.length; i++) if (manhattan(rest[i]!, at) < manhattan(rest[bi]!, at)) bi = i
    const next = rest.splice(bi, 1)[0]!
    out.push(next)
    at = next
  }
  return out
}

// ------------------------------------------------------------------ torches from coal or charcoal

export type SupplyStep =
  | { do: 'ready', torches: number }
  | { do: 'craft', item: string, count: number, why: string }
  | { do: 'smelt', item: string, count: number, why: string }
  | { do: 'stuck', why: string, need: 'coal' | 'wood' }

const isLog = (n: string) => /(_log|_stem|_wood|_hyphae)$/.test(n)
const isPlank = (n: string) => n.endsWith('_planks')

/** The planks a log makes: oak_log -> oak_planks, stripped_spruce_wood -> spruce_planks, crimson_stem -> crimson_planks. */
export function plankFor (log: string): string {
  return log.replace(/^stripped_/, '').replace(/_(log|wood|stem|hyphae)$/, '_planks')
}

function most (inv: Record<string, number>, test: (n: string) => boolean): [string, number] | null {
  let best: [string, number] | null = null
  for (const [n, c] of Object.entries(inv)) if (c > 0 && test(n) && (!best || c > best[1])) best = [n, c]
  return best
}

const sum = (inv: Record<string, number>, test: (n: string) => boolean) =>
  Object.entries(inv).reduce((s, [n, c]) => s + (test(n) ? c : 0), 0)

/**
 * The next step towards `want` torches: craft torches from coal or charcoal and sticks, sticks
 * from planks, planks from logs; with no coal, smelt charcoal from logs (planks as fuel, a
 * furnace from 8 cobblestone when there is none nearby). `ready` as soon as it has the torches,
 * or has some and can't make more. `stuck` says why.
 */
export function torchSupplyStep (inv: Record<string, number>, want: number, o: { furnaceNear?: boolean, tableNear?: boolean } = {}): SupplyStep {
  const have = inv.torch ?? 0
  if (have >= want) return { do: 'ready', torches: want }
  const runs = Math.ceil((want - have) / 4)
  const coal = (inv.coal ?? 0) + (inv.charcoal ?? 0)
  const sticks = inv.stick ?? 0
  const planks = sum(inv, isPlank)
  const logs = sum(inv, isLog)
  const enough = (why: string, need: 'coal' | 'wood'): SupplyStep => have > 0 ? { do: 'ready', torches: have } : { do: 'stuck', why, need }

  if (coal > 0) {
    const n = Math.min(runs, coal)
    if (sticks >= n) return { do: 'craft', item: 'torch', count: n * 4, why: `${n * 4} torches from ${n} coal` }
    const stickRuns = Math.ceil((n - sticks) / 4)
    if (planks >= 2) return { do: 'craft', item: 'stick', count: Math.min(stickRuns, Math.floor(planks / 2)) * 4, why: 'sticks for torches' }
    const log = most(inv, isLog)
    if (log) return { do: 'craft', item: plankFor(log[0]), count: 4, why: 'planks for sticks' }
    return enough('no sticks, planks or logs for torch handles', 'wood')
  }

  // charcoal: k logs smelted, fuel planks ceil(k / 1.5), sticks from planks too
  const log = most(inv, isLog)
  if (!log) return enough('out of coal and charcoal, and no logs to make charcoal', 'coal')
  const furnace = !!o.furnaceNear || (inv.furnace ?? 0) > 0
  if (!furnace && (inv.cobblestone ?? 0) < 8) return enough('out of coal and charcoal; no furnace and fewer than 8 cobblestone to make one', 'coal')
  // logs that can go into the furnace once the planks for fuel (and one stick run) are made
  // a furnace is crafted on a crafting table: one from 4 planks when there is none
  const table = !!o.tableNear || (inv.crafting_table ?? 0) > 0
  const tablePlanks = furnace || table ? 0 : 4
  const otherFuel = planks + sum(inv, n => isLog(n) && n !== log[0])
  let k = 0
  for (let t = Math.min(runs, log[1]); t >= 1; t--) {
    const fuel = Math.ceil(t / 1.5)
    const planksNeeded = Math.max(0, fuel + tablePlanks - otherFuel) + (sticks >= t ? 0 : 2)
    if (t + Math.ceil(planksNeeded / 4) <= log[1]) { k = t; break }
  }
  if (!k) return enough('out of coal and charcoal, and too few logs to make charcoal and fuel', 'coal')
  if (!furnace && tablePlanks && planks < 4) return { do: 'craft', item: plankFor(log[0]), count: 4, why: 'planks for a crafting table (for the furnace)' }
  if (!furnace) return { do: 'craft', item: 'furnace', count: 1, why: 'a furnace for charcoal' }
  const fuel = Math.ceil(k / 1.5)
  if (otherFuel < fuel) return { do: 'craft', item: plankFor(log[0]), count: Math.ceil((fuel - otherFuel) / 4) * 4, why: 'planks to burn for charcoal' }
  return { do: 'smelt', item: log[0], count: k, why: `charcoal from ${k} ${log[0]}` }
}

// ------------------------------------------------------------------ when to look again

/**
 * Whether an area is due for a light check: never checked, checked longer than `everyMs` ago,
 * or a hostile was seen there since the last check.
 */
export function lightCheckDue (lastChecked: number | undefined, now: number, everyMs: number, mobSeenAt?: number): boolean {
  if (lastChecked === undefined) return true
  if (mobSeenAt !== undefined && mobSeenAt > lastChecked) return true
  return now - lastChecked >= everyMs
}
