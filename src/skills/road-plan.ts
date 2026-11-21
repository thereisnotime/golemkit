// Road and staircase planner, pure and unit tested (test/roads.test.ts). Three parts:
//   planRoad      A* over (x, z, feet height, heading, vertical trend, steps since the last turn
//                 and since the last height change). Height changes only on straight moves, turns
//                 only on landings, heavy penalty for up-then-down, cut/fill limits for every lane,
//                 no overlap with buildings, other roads or the route itself. Switchbacks come out
//                 of the search on slopes steeper than one block per block.
//   roadGeometry  the blocks for a planned route (floor, stairs, landings, base, cut, railings,
//                 lanterns); used to build and to check the result.
//   connect       joins many endpoints (door fronts) cheapest-first (Kruskal on planned costs,
//                 re-planned as roads get laid), with T-junctions onto roads already laid.
// The world side (scanning, building, storage, actions) is roads.ts.
import type { BlockState, Facing } from './blockstate.ts'
import { FACINGS } from './blockstate.ts'

// ------------------------------------------------------------------ terrain

/** Ground height of a column nobody knows (not loaded, outside the scan). */
export const NO_GROUND = -32768
/** Never build here: buildings, trees, protected areas, unloaded columns. */
export const BLOCKED = 1
/** Near a building: no lanes, except the straight stub in front of a door. */
export const MARGIN = 2
/** Water or lava; ground is the liquid's surface block. Lanes only when bridging. */
export const LIQUID = 4
/** A lane of a road already there (roadF = its walking height). */
export const ROAD = 8
/** A railing of a road already there. */
export const RAIL = 16

/**
 * The search area as a height map. `ground` is the y of the top natural ground block of each
 * column (so the natural walking height is ground + 1); cells are indexed x-major per row.
 */
export interface RoadTerrain {
  x0: number
  z0: number
  w: number
  d: number
  ground: Int16Array
  flags: Uint8Array
  /** Walking (feet) height of an existing road cell. */
  roadF: Int16Array
  /** Facing index (FACINGS) of an existing road cell's stair, -1 when flat. */
  roadStair: Int8Array
}

export function createTerrain (x0: number, z0: number, w: number, d: number): RoadTerrain {
  const n = w * d
  return { x0, z0, w, d, ground: new Int16Array(n).fill(NO_GROUND), flags: new Uint8Array(n), roadF: new Int16Array(n), roadStair: new Int8Array(n).fill(-1) }
}

export function cloneTerrain (t: RoadTerrain): RoadTerrain {
  return { ...t, ground: t.ground.slice(), flags: t.flags.slice(), roadF: t.roadF.slice(), roadStair: t.roadStair.slice() }
}

/** Index of a world column in the terrain, -1 outside. */
export function cellIndex (t: RoadTerrain, x: number, z: number): number {
  const ix = x - t.x0
  const iz = z - t.z0
  return ix < 0 || iz < 0 || ix >= t.w || iz >= t.d ? -1 : ix + iz * t.w
}

/** A terrain from a height function (null = unknown); `flags` adds BLOCKED, LIQUID... per column. */
export function terrainFrom (box: { x0: number, z0: number, x1: number, z1: number }, ground: (x: number, z: number) => number | null, flags?: (x: number, z: number) => number): RoadTerrain {
  const t = createTerrain(box.x0, box.z0, box.x1 - box.x0 + 1, box.z1 - box.z0 + 1)
  for (let z = box.z0; z <= box.z1; z++) {
    for (let x = box.x0; x <= box.x1; x++) {
      const i = cellIndex(t, x, z)
      const g = ground(x, z)
      t.ground[i] = g === null ? NO_GROUND : g
      t.flags[i] = (g === null ? BLOCKED : 0) | (flags ? flags(x, z) : 0)
    }
  }
  return t
}

/** Marks a building's footprint BLOCKED and a ring of `margin` cells around it MARGIN. */
export function addBuilding (t: RoadTerrain, box: { x0: number, z0: number, x1: number, z1: number }, margin = 1): void {
  for (let z = box.z0 - margin; z <= box.z1 + margin; z++) {
    for (let x = box.x0 - margin; x <= box.x1 + margin; x++) {
      const i = cellIndex(t, x, z)
      if (i < 0) continue
      const inside = x >= box.x0 && x <= box.x1 && z >= box.z0 && z <= box.z1
      t.flags[i] |= inside ? BLOCKED : MARGIN
    }
  }
}

/** MARGIN around every BLOCKED cell for which `isBuilding` says so (not trees or unloaded columns). */
export function markMargins (t: RoadTerrain, margin: number, isBuilding: (i: number) => boolean): void {
  if (margin <= 0) return
  const src: number[] = []
  for (let i = 0; i < t.flags.length; i++) if ((t.flags[i]! & BLOCKED) && isBuilding(i)) src.push(i)
  for (const i of src) {
    const x = i % t.w
    const z = (i - x) / t.w
    for (let dz = -margin; dz <= margin; dz++) {
      for (let dx = -margin; dx <= margin; dx++) {
        const nx = x + dx
        const nz = z + dz
        if (nx < 0 || nz < 0 || nx >= t.w || nz >= t.d) continue
        const j = nx + nz * t.w
        if (!(t.flags[j]! & BLOCKED)) t.flags[j]! |= MARGIN
      }
    }
  }
}

// ------------------------------------------------------------------ options

export interface RoadOptions {
  /** Lanes (1, 3 or 5; even widths round up). */
  width: number
  /** Deepest cut below natural ground for any lane (blocks). */
  maxCut: number
  /** Highest fill above natural ground for any lane (blocks). */
  maxFill: number
  /** Cut/fill depth beyond this costs no more (a deep base is capped too). */
  costCap: number
  /** Cost per block of cut or fill per lane. */
  cutFillWeight: number
  /** Cost of a turn (prefer long straight flights). */
  turnCost: number
  /** Cost of a height change (no stairs for nothing). */
  riseCost: number
  /** Cost of changing vertical direction (up then down). */
  bumpCost: number
  /** Never change vertical direction on one route. */
  monotone: boolean
  /** May cross water and lava on a deck. */
  bridge: boolean
  /** Extra cost per lane over liquid. */
  bridgeCost: number
  /** Expanded nodes before giving up. */
  maxNodes: number
  /** A* heuristic weight (>1 is faster, slightly less optimal). */
  heuristicWeight: number
  /** Cells straight out of a door before the first turn. */
  straight: number
  /** Extra cut/fill per cell a flight may cost to get an even gradient. */
  gradientSlack: number
}

export const ROAD_DEFAULTS: RoadOptions = {
  width: 3,
  maxCut: 6,
  maxFill: 6,
  costCap: 10,
  cutFillWeight: 0.35,
  turnCost: 3,
  riseCost: 0.2,
  bumpCost: 25,
  monotone: false,
  bridge: false,
  bridgeCost: 1.5,
  maxNodes: 400_000,
  heuristicWeight: 1.2,
  straight: 3,
  gradientSlack: 0.25
}

export function roadOptions (o: Partial<RoadOptions> = {}): RoadOptions {
  const r = { ...ROAD_DEFAULTS, ...Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) } as RoadOptions
  const w = Math.max(1, Math.min(5, Math.round(r.width)))
  r.width = w % 2 ? w : w + 1
  r.maxCut = Math.max(0, r.maxCut)
  r.maxFill = Math.max(0, r.maxFill)
  r.straight = Math.max(1, Math.round(r.straight))
  return r
}

// ------------------------------------------------------------------ directions

const DX = [0, 1, 0, -1]
const DZ = [-1, 0, 1, 0]
export const facingIndex = (f: Facing) => FACINGS.indexOf(f)
const opp = (h: number) => (h + 2) & 3
/** 0: lanes run along x (heading north/south), 1: along z (heading east/west), 2: a landing square. */
const kindOf = (h: number) => h & 1

/** Direction from one cell to its neighbour, -1 when not neighbours. */
export function stepDir (a: { x: number, z: number }, b: { x: number, z: number }): number {
  for (let h = 0; h < 4; h++) if (b.x - a.x === DX[h] && b.z - a.z === DZ[h]) return h
  return -1
}

/** The lane cells of a route cell (perpendicular to `dir`), or the landing square at a turn. */
export function laneCells (x: number, z: number, dir: number, turn: boolean, half: number): { x: number, z: number }[] {
  const out: { x: number, z: number }[] = []
  if (turn) {
    for (let j = -half; j <= half; j++) for (let i = -half; i <= half; i++) out.push({ x: x + i, z: z + j })
  } else if (kindOf(dir) === 0) {
    for (let k = -half; k <= half; k++) out.push({ x: x + k, z })
  } else {
    for (let k = -half; k <= half; k++) out.push({ x, z: z + k })
  }
  return out
}

/** Railing candidates beside a route cell: both sides, or the ring around a landing. */
function sideCells (x: number, z: number, dir: number, turn: boolean, half: number): { x: number, z: number }[] {
  const r = half + 1
  if (turn) {
    const out: { x: number, z: number }[] = []
    for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) if (Math.max(Math.abs(i), Math.abs(j)) === r) out.push({ x: x + i, z: z + j })
    return out
  }
  return kindOf(dir) === 0 ? [{ x: x - r, z }, { x: x + r, z }] : [{ x, z: z - r }, { x, z: z + r }]
}

// ------------------------------------------------------------------ planning

/** A route endpoint: a door front (with `out`, the way out of the door) or a plain point. */
export interface RoadEnd {
  x: number
  z: number
  /** Walking height; default the natural ground + 1. */
  f?: number
  /** Door: the direction leading away from the door. The route leaves (or arrives) straight along it. */
  out?: Facing
  label?: string
}

export interface PlanRequest {
  from: RoadEnd[]
  /** Road cells (world x/z) the route may start from as a T-junction. */
  fromRoads?: { x: number, z: number }[]
  to: RoadEnd[]
  /** Road cells the route may end on as a T-junction. */
  toRoads?: { x: number, z: number }[]
}

export interface RouteCell {
  x: number
  z: number
  /** Walking (feet) height; the road block is at f - 1. */
  f: number
  /** Travel direction at this cell (the way to the next cell; the last cell keeps the way in). */
  dir: Facing
  /** The route turns here: a landing. */
  turn: boolean
  /** An existing road cell the route starts or ends on. Nothing is built on it. */
  junction?: boolean
}

export interface PlanStats { nodes: number, rejected: Record<string, number>, ms: number }

export type PlanResult =
  | { ok: true, route: RouteCell[], cost: number, fromEnd: number, toEnd: number, stats: PlanStats }
  | { ok: false, reason: string, stats: PlanStats }

const REJECT = ['', 'blocked', 'cut/fill limit', 'other road', 'water/lava', 'outside the area']

interface Search {
  t: RoadTerrain
  o: RoadOptions
  half: number
  landing: number
  minSeg: number
  sTcap: number
  sCcap: number
  fMin: number
  exempt: Set<number>
  memo: Map<number, number>
  rejected: number[]
}

/** One lane column at walking height f: cost >= 0, or minus a REJECT code. */
function laneCost (s: Search, x: number, z: number, f: number, allowRail: boolean): number {
  const t = s.t
  const i = cellIndex(t, x, z)
  if (i < 0) return -5
  const fl = t.flags[i]!
  if (fl & BLOCKED) return -1
  if ((fl & MARGIN) && !s.exempt.has(i)) return -1
  if (fl & ROAD) return -3
  if ((fl & RAIL) && !allowRail) return -3
  const g = t.ground[i]!
  if (g === NO_GROUND) return -1
  const d = f - 1 - g
  const o = s.o
  if (fl & LIQUID) {
    if (!o.bridge) return -4
    if (d < 0 || d > o.maxFill) return -2
    return o.bridgeCost + o.cutFillWeight * Math.min(d, o.costCap)
  }
  if (d > o.maxFill || -d > o.maxCut) return -2
  return o.cutFillWeight * Math.min(Math.abs(d), o.costCap)
}

/** A railing column: anything but a building, the edge of the area, or (unless at a junction) another road. */
function railCode (s: Search, x: number, z: number, allowRail: boolean): number {
  const i = cellIndex(s.t, x, z)
  if (i < 0) return -5
  const fl = s.t.flags[i]!
  if (fl & BLOCKED) return -1
  if ((fl & ROAD) && !allowRail) return -3
  return 0
}

/** Cost of the whole width of a route cell at f (kind: 0/1 lanes, 2 landing square), memoised. */
function footprint (s: Search, x: number, z: number, f: number, kind: number, allowRail: boolean): number {
  const i = cellIndex(s.t, x, z)
  if (i < 0) return -5
  const key = ((i * 1024 + (f - s.fMin)) * 3 + kind) * 2 + (allowRail ? 1 : 0)
  const hit = s.memo.get(key)
  if (hit !== undefined) return hit
  let cost = 0
  const lanes = laneCells(x, z, kind === 1 ? 1 : 0, kind === 2, s.half)
  for (const l of lanes) {
    const c = laneCost(s, l.x, l.z, f, allowRail)
    if (c < 0) { s.memo.set(key, c); return c }
    cost += c
  }
  for (const r of sideCells(x, z, kind === 1 ? 1 : 0, kind === 2, s.half)) {
    const c = railCode(s, r.x, r.z, allowRail)
    if (c < 0) { s.memo.set(key, c); return c }
  }
  s.memo.set(key, cost)
  return cost
}

/** Min-heap of node ids by priority. */
class Heap {
  pri: number[] = []
  ids: number[] = []
  get size (): number { return this.ids.length }
  push (p: number, id: number): void {
    const a = this.pri
    const b = this.ids
    let i = a.length
    a.push(p); b.push(id)
    while (i > 0) {
      const up = (i - 1) >> 1
      if (a[up]! <= p) break
      a[i] = a[up]!; b[i] = b[up]!
      i = up
    }
    a[i] = p; b[i] = id
  }
  pop (): number {
    const a = this.pri
    const b = this.ids
    const top = b[0]!
    const lp = a.pop()!
    const lid = b.pop()!
    const n = a.length
    if (n) {
      let i = 0
      while (true) {
        let c = 2 * i + 1
        if (c >= n) break
        if (c + 1 < n && a[c + 1]! < a[c]!) c++
        if (a[c]! >= lp) break
        a[i] = a[c]!; b[i] = b[c]!
        i = c
      }
      a[i] = lp; b[i] = lid
    }
    return top
  }
}

/**
 * Plans one road from any of `from` (door fronts, points, road cells) to any of `to`. Pure.
 * Returns the route cell by cell with walking heights, or why there is none.
 */
export function planRoad (t: RoadTerrain, req: PlanRequest, opts: Partial<RoadOptions> = {}): PlanResult {
  const t0 = Date.now()
  const o = roadOptions(opts)
  const half = (o.width - 1) / 2
  const landing = half + 1
  let gMin = Infinity
  for (const g of t.ground) if (g !== NO_GROUND && g < gMin) gMin = g
  if (gMin === Infinity) gMin = 0
  const s: Search = {
    t, o, half, landing,
    minSeg: Math.max(o.width + 1, o.straight, landing + 1),
    sTcap: 0, sCcap: landing,
    fMin: gMin - o.maxCut - 4,
    exempt: new Set(), memo: new Map(), rejected: [0, 0, 0, 0, 0, 0]
  }
  s.sTcap = s.minSeg
  const sT0door = Math.max(0, s.minSeg - o.straight)
  const stats = (nodes: number): PlanStats => ({ nodes, rejected: Object.fromEntries(s.rejected.map((n, i) => [REJECT[i]!, n]).filter(([k, n]) => k && n)), ms: Date.now() - t0 })
  const failWith = (reason: string, nodes = 0): PlanResult => ({ ok: false, reason, stats: stats(nodes) })

  // the stub in front of a door may run through the building's margin
  for (const e of [...req.from, ...req.to]) {
    if (!e.out) continue
    const h = facingIndex(e.out)
    for (let k = 0; k <= o.straight; k++) {
      for (const l of laneCells(e.x + DX[h]! * k, e.z + DZ[h]! * k, h, false, half)) {
        const i = cellIndex(t, l.x, l.z)
        if (i >= 0) s.exempt.add(i)
      }
    }
  }

  // targets
  const endsAt = new Map<number, { end: number, f?: number, inH: number }[]>()
  req.to.forEach((e, n) => {
    const i = cellIndex(t, e.x, e.z)
    if (i < 0) return
    if (!endsAt.has(i)) endsAt.set(i, [])
    endsAt.get(i)!.push({ end: n, f: e.f, inH: e.out ? opp(facingIndex(e.out)) : -1 })
  })
  const toRoad = new Set<number>()
  for (const r of req.toRoads ?? []) {
    const i = cellIndex(t, r.x, r.z)
    if (i >= 0 && (t.flags[i]! & ROAD)) toRoad.add(i)
  }
  if (!endsAt.size && !toRoad.size) return failWith('no target inside the area')
  /** Is the cell ahead of (x, z) in direction h a flat target road cell at f, a T-junction? */
  const junctionAhead = (x: number, z: number, f: number, h: number, roads: Set<number>): number => {
    const ai = cellIndex(t, x + DX[h]!, z + DZ[h]!)
    if (ai < 0 || !roads.has(ai) || t.roadF[ai] !== f || t.roadStair[ai]! >= 0) return -1
    // the old road's cells beside it (across the new road) must be flat at the same height too
    const p = (h + 1) & 3
    for (let k = -half; k <= half; k++) {
      const j = cellIndex(t, x + DX[h]! + DX[p]! * k, z + DZ[h]! + DZ[p]! * k)
      if (j < 0) return -1
      if ((t.flags[j]! & ROAD) && (t.roadF[j] !== f || t.roadStair[j]! >= 0)) return -1
    }
    return ai
  }

  // a quick look whether any target can be arrived at, before searching the whole area for it
  const reachable = req.to.some(e => {
    if (e.f === undefined) return true
    const hs = e.out ? [opp(facingIndex(e.out))] : [0, 1, 2, 3]
    return hs.some(h => footprint(s, e.x, e.z, e.f!, kindOf(h), false) >= 0)
  }) || [...toRoad].some(i => {
    if (t.roadStair[i]! >= 0) return false
    const ex = (i % t.w) + t.x0
    const ez = Math.floor(i / t.w) + t.z0
    for (let h = 0; h < 4; h++) {
      const nx = ex - DX[h]!
      const nz = ez - DZ[h]!
      const ni = cellIndex(t, nx, nz)
      if (ni < 0 || (t.flags[ni]! & ROAD)) continue
      if (junctionAhead(nx, nz, t.roadF[i]!, h, toRoad) === i && footprint(s, nx, nz, t.roadF[i]!, kindOf(h), true) >= 0) return true
    }
    return false
  })
  if (!reachable) return failWith(toRoad.size ? 'no flat stretch of the road there is at a height a road can join (or room beside it)' : 'no room for the road at the target')
  const singleF = req.to.length === 1 && !toRoad.size && req.to[0]!.f !== undefined ? req.to[0]!.f! : null

  // heuristic: grid distance to the nearest target around buildings (and water when not bridging)
  const N = t.w * t.d
  const dist = new Int32Array(N).fill(-1)
  const queue: number[] = []
  for (const i of [...endsAt.keys(), ...toRoad]) { if (dist[i] !== 0) { dist[i] = 0; queue.push(i) } }
  const passable = (i: number) => { const fl = t.flags[i]!; return !(fl & BLOCKED) && (o.bridge || !(fl & LIQUID)) && t.ground[i] !== NO_GROUND }
  for (let qi = 0; qi < queue.length; qi++) {
    const i = queue[qi]!
    const x = i % t.w
    const z = (i - x) / t.w
    for (let h = 0; h < 4; h++) {
      const nx = x + DX[h]!
      const nz = z + DZ[h]!
      if (nx < 0 || nz < 0 || nx >= t.w || nz >= t.d) continue
      const j = nx + nz * t.w
      if (dist[j]! >= 0 || !passable(j)) continue
      dist[j] = dist[i]! + 1
      queue.push(j)
    }
  }

  // nodes
  const nX: number[] = []
  const nZ: number[] = []
  const nF: number[] = []
  const nH: number[] = []
  const nT: number[] = []
  const nST: number[] = []
  const nSC: number[] = []
  const nG: number[] = []
  const nPar: number[] = []
  const nDepth: number[] = []
  const nGoal: number[] = [] // -1 no, -2 junction ahead, >= 0 index into req.to
  const nSrc: number[] = [] // >= 0 index into req.from, -1 - cell index for a road start
  const heap = new Heap()
  const best = new Map<number, number>()
  const closed = new Set<number>()
  const keyOf = (x: number, z: number, f: number, h: number, tr: number, sT: number, sC: number) =>
    ((((cellIndex(t, x, z) * 1024 + (f - s.fMin)) * 4 + h) * 3 + (tr + 1)) * 8 + sT) * 8 + sC
  const prio = (x: number, z: number, f: number, g: number) => {
    const i = cellIndex(t, x, z)
    let hd = dist[i]! < 0 ? 1e6 : dist[i]!
    if (singleF !== null) hd = Math.max(hd, Math.abs(f - singleF))
    return g + o.heuristicWeight * hd
  }

  const goalOf = (x: number, z: number, f: number, h: number, sT: number, sC: number, junction: boolean): number => {
    if (junction && sC >= landing) return -2
    const list = endsAt.get(cellIndex(t, x, z))
    if (!list) return -1
    for (const e of list) {
      if (e.f !== undefined && e.f !== f) continue
      if (e.inH >= 0 && (h !== e.inH || sT < o.straight || sC < landing)) continue
      return e.end
    }
    return -1
  }

  const addNode = (x: number, z: number, f: number, h: number, tr: number, sT: number, sC: number, g: number, par: number, src: number, junction: boolean): void => {
    const key = keyOf(x, z, f, h, tr, sT, sC)
    const b = best.get(key)
    if (b !== undefined && nG[b]! <= g) return
    if (closed.has(key)) return
    const id = nX.length
    nX.push(x); nZ.push(z); nF.push(f); nH.push(h); nT.push(tr); nST.push(sT); nSC.push(sC); nG.push(g)
    nPar.push(par); nDepth.push(par >= 0 ? nDepth[par]! + 1 : 0); nSrc.push(src)
    nGoal.push(goalOf(x, z, f, h, sT, sC, junction))
    best.set(key, id)
    heap.push(prio(x, z, f, g), id)
  }

  // starts
  const startNotes: string[] = []
  req.from.forEach((e, n) => {
    const i = cellIndex(t, e.x, e.z)
    if (i < 0) { startNotes.push(`${e.label ?? `${e.x} ${e.z}`} is outside the area`); return }
    const g = t.ground[i]!
    const f = e.f ?? (g === NO_GROUND ? null : g + 1)
    if (f === null) { startNotes.push(`no ground known at ${e.x} ${e.z}`); return }
    const hs = e.out ? [facingIndex(e.out)] : [0, 1, 2, 3]
    let any = false
    for (const h of hs) {
      const fp = footprint(s, e.x, e.z, f, kindOf(h), false)
      if (fp < 0) { s.rejected[-fp]!++; continue }
      any = true
      // a door's stub: the first turn comes `straight` cells out
      addNode(e.x, e.z, f, h, 0, e.out ? sT0door : 0, landing, 1 + fp, -1, n, false)
    }
    if (!any) startNotes.push(`${e.label ?? `the start at ${e.x} ${e.z}`} has no room for a ${o.width}-wide road (${REJECT[lastReject(s)] || 'blocked'})`)
  })
  const fromRoad = new Set<number>()
  for (const r of req.fromRoads ?? []) {
    const i = cellIndex(t, r.x, r.z)
    if (i < 0 || !(t.flags[i]! & ROAD) || t.roadStair[i]! >= 0) continue
    fromRoad.add(i)
  }
  for (const i of fromRoad) {
    const ex = (i % t.w) + t.x0
    const ez = Math.floor(i / t.w) + t.z0
    const f = t.roadF[i]!
    for (let h = 0; h < 4; h++) {
      const nx = ex + DX[h]!
      const nz = ez + DZ[h]!
      const ni = cellIndex(t, nx, nz)
      if (ni < 0 || (t.flags[ni]! & ROAD)) continue
      // leaving the road at a T: the road cell is "ahead" when looking back
      if (junctionAhead(nx, nz, f, opp(h), fromRoad) !== i) continue
      const fp = footprint(s, nx, nz, f, kindOf(h), true)
      if (fp < 0) { s.rejected[-fp]!++; continue }
      addNode(nx, nz, f, h, 0, 0, landing, 1 + fp, -1, -1 - i, false)
    }
  }
  if (!heap.size) return failWith(startNotes.join('; ') || 'no room to start a road here')
  if (heap.ids.every(id => dist[cellIndex(t, nX[id]!, nZ[id]!)]! < 0)) {
    return failWith('the target is cut off from the start (buildings or water in between, or outside the search area)')
  }

  const lim = o.width + 1
  /** The route would come back within the width of itself (crossing over or under, or running alongside). */
  const selfConflict = (id: number): boolean => {
    const cx = nX[id]!
    const cz = nZ[id]!
    const d = nDepth[id]!
    let skip = 0
    for (let j = nPar[id]!; j >= 0; j = nPar[j]!) {
      if (skip > 0) { skip--; continue }
      const ch = Math.max(Math.abs(cx - nX[j]!), Math.abs(cz - nZ[j]!))
      if (ch < lim) { if (2 * ch < d - nDepth[j]!) return true } else skip = ch - lim
    }
    return false
  }

  let expanded = 0
  let found = -1
  while (heap.size) {
    const id = heap.pop()
    const key = keyOf(nX[id]!, nZ[id]!, nF[id]!, nH[id]!, nT[id]!, nST[id]!, nSC[id]!)
    if (best.get(key) !== id || closed.has(key)) continue
    if (selfConflict(id)) { best.delete(key); continue }
    closed.add(key)
    if (nGoal[id]! !== -1) { found = id; break }
    if (++expanded > o.maxNodes) return failWith(`gave up after ${o.maxNodes} search nodes (the area is too big or too rough; try a smaller distance or a bigger maxCut/maxFill)`, expanded)
    const x = nX[id]!
    const z = nZ[id]!
    const f = nF[id]!
    const h = nH[id]!
    const tr = nT[id]!
    const sT = nST[id]!
    const sC = nSC[id]!
    const g = nG[id]!
    for (const m of [h, (h + 3) & 3, (h + 1) & 3]) {
      const turn = m !== h
      let extra = 0
      if (turn) {
        if (sT < s.minSeg || sC < landing) continue
        const sq = footprint(s, x, z, f, 2, false)
        if (sq < 0) { s.rejected[-sq]!++; continue }
        extra = o.turnCost + sq * 0.5
      }
      const nx = x + DX[m]!
      const nz = z + DZ[m]!
      if (cellIndex(t, nx, nz) < 0) { s.rejected[5]!++; continue }
      const sT2 = turn ? 1 : Math.min(sT + 1, s.sTcap)
      for (const dy of [0, 1, -1]) {
        let bump = false
        if (dy !== 0) {
          // flat for `landing` steps after a turn (and after the start), so a landing is a flat square
          if (sT2 <= landing) continue
          if (tr !== 0 && dy !== tr) {
            if (o.monotone || sC < landing) continue
            bump = true
          }
        }
        const f2 = f + dy
        const jn = dy === 0 && toRoad.size > 0 && sC + 1 >= landing && junctionAhead(nx, nz, f2, m, toRoad) >= 0
        const fp = footprint(s, nx, nz, f2, kindOf(m), jn)
        if (fp < 0) { s.rejected[-fp]!++; continue }
        const sC2 = dy !== 0 ? 0 : Math.min(sC + 1, s.sCcap)
        const tr2 = dy !== 0 ? dy : tr
        const g2 = g + 1 + fp + extra + (dy ? o.riseCost : 0) + (bump ? o.bumpCost : 0)
        addNode(nx, nz, f2, m, tr2, sT2, sC2, g2, id, nSrc[id]!, jn)
      }
    }
  }
  if (found < 0) {
    const why = Object.entries(stats(expanded).rejected).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k).join(', ')
    return failWith(`no road possible within the area${why ? ` (stopped by: ${why})` : ''}`, expanded)
  }

  // the route, start to goal
  const ids: number[] = []
  for (let j = found; j >= 0; j = nPar[j]!) ids.push(j)
  ids.reverse()
  const cells: { x: number, z: number, f: number, junction?: boolean }[] = ids.map(j => ({ x: nX[j]!, z: nZ[j]!, f: nF[j]! }))
  const src = nSrc[ids[0]!]!
  if (src < 0) {
    const ri = -1 - src
    cells.unshift({ x: (ri % t.w) + t.x0, z: Math.floor(ri / t.w) + t.z0, f: t.roadF[ri]!, junction: true })
  }
  const goal = nGoal[found]!
  if (goal === -2) {
    const h = nH[found]!
    cells.push({ x: nX[found]! + DX[h]!, z: nZ[found]! + DZ[h]!, f: nF[found]!, junction: true })
  }
  const startDir = nH[ids[0]!]!
  let route = toRoute(cells, startDir)
  const startFlat = landing - nST[ids[0]!]!
  const endFlat = goal === -2 || (goal >= 0 && req.to[goal]?.out) ? landing : 0
  route = smoothGradient(route, s, startFlat, endFlat)
  return { ok: true, route, cost: nG[found]!, fromEnd: src, toEnd: goal, stats: stats(expanded) }
}

function lastReject (s: Search): number {
  let best = 0
  for (let i = 1; i < s.rejected.length; i++) if (s.rejected[i]! > s.rejected[best]!) best = i
  return best
}

/** Cells to route cells with directions and turn flags. */
function toRoute (cells: { x: number, z: number, f: number, junction?: boolean }[], startDir: number): RouteCell[] {
  const n = cells.length
  const dirs = cells.map((c, i) => (i + 1 < n ? stepDir(c, cells[i + 1]!) : i > 0 ? stepDir(cells[i - 1]!, c) : startDir))
  return cells.map((c, i) => ({
    x: c.x, z: c.z, f: c.f,
    dir: FACINGS[dirs[i]!]!,
    turn: i > 0 && i + 1 < n && dirs[i - 1] !== dirs[i],
    ...(c.junction ? { junction: true } : {})
  }))
}

/**
 * Steps (by the index of the cell stepped into) that must stay flat: around landings, the first
 * `startFlat` steps and the last `endFlat` steps (door fronts, junctions).
 */
export function lockedSteps (route: RouteCell[], half: number, startFlat: number, endFlat: number): boolean[] {
  const n = route.length
  const landing = half + 1
  const locked = new Array<boolean>(n).fill(false)
  locked[0] = true
  const first = route[0]?.junction ? 1 : 0
  const last = route[n - 1]?.junction ? n - 2 : n - 1
  for (let s = first + 1; s <= Math.min(n - 1, first + startFlat); s++) locked[s] = true
  for (let s = Math.max(1, last - endFlat + 1); s <= n - 1; s++) locked[s] = true
  if (route[n - 1]?.junction) locked[n - 1] = true
  if (route[0]?.junction && n > 1) locked[1] = true
  route.forEach((c, i) => { if (c.turn) for (let s = i - half; s <= i + landing; s++) if (s >= 1 && s < n) locked[s] = true })
  return locked
}

/**
 * Evens out the stairs on each straight flight: the same total rise spread at a constant
 * gradient, when the cut and fill stay within the limits and cost little more.
 */
function smoothGradient (route: RouteCell[], s: Search, startFlat: number, endFlat: number): RouteCell[] {
  const n = route.length
  if (n < 4) return route
  const locked = lockedSteps(route, s.half, startFlat, endFlat)
  const out = route.map(c => ({ ...c }))
  const costAt = (i: number, f: number) => footprint(s, out[i]!.x, out[i]!.z, f, out[i]!.turn ? 2 : kindOf(facingIndex(out[i]!.dir)), false)
  // segments between turns (and the ends)
  const cuts = [0, ...out.map((c, i) => (c.turn ? i : -1)).filter(i => i > 0), n - 1]
  for (let k = 0; k + 1 < cuts.length; k++) {
    const a = cuts[k]!
    const b = cuts[k + 1]!
    if (out.slice(a, b + 1).some(c => c.junction && c !== out[a] && c !== out[b])) continue
    const steps: number[] = []
    for (let i = a + 1; i <= b; i++) steps.push(out[i]!.f - out[i - 1]!.f)
    const ups = steps.filter(d => d > 0).length
    const downs = steps.filter(d => d < 0).length
    if ((ups && downs) || !(ups || downs)) continue
    const sign = ups ? 1 : -1
    const R = ups || downs
    const free: number[] = []
    for (let i = a + 1; i <= b; i++) if (!locked[i]) free.push(i)
    if (free.length < R) continue
    const want = new Set<number>()
    for (let q = 0; q < R; q++) want.add(free[Math.floor((q + 0.5) * free.length / R)]!)
    const newF: number[] = []
    let f = out[a]!.f
    let ok = true
    let oldCost = 0
    let newCost = 0
    for (let i = a + 1; i <= b; i++) {
      f += want.has(i) ? sign : 0
      newF.push(f)
      if (i === b) continue // the turn cell or the end keeps its height (same total rise)
      const c0 = costAt(i, out[i]!.f)
      const c1 = costAt(i, f)
      if (c1 < 0) { ok = false; break }
      oldCost += Math.max(0, c0)
      newCost += c1
    }
    if (!ok || newF[newF.length - 1] !== out[b]!.f) continue
    if (newCost > oldCost + s.o.gradientSlack * (b - a)) continue
    for (let i = a + 1; i <= b; i++) out[i]!.f = newF[i - a - 1]!
  }
  return out
}

// ------------------------------------------------------------------ checks

/**
 * What is wrong with a route, if anything: neighbours only, at most one block up or down per
 * step, no height change on or next to a landing. Empty when it's fine.
 */
export function routeProblems (route: RouteCell[], width = 3): string[] {
  const half = (roadOptions({ width }).width - 1) / 2
  const out: string[] = []
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1]!
    const b = route[i]!
    if (stepDir(a, b) < 0) out.push(`cells ${i - 1} and ${i} are not neighbours`)
    if (Math.abs(b.f - a.f) > 1) out.push(`step ${i} changes height by ${b.f - a.f}`)
  }
  route.forEach((c, i) => {
    if (!c.turn) return
    for (let s = i - half; s <= i + half + 1; s++) {
      if (s < 1 || s >= route.length) continue
      if (route[s]!.f !== route[s - 1]!.f) out.push(`height change at step ${s}, next to the landing at ${i}`)
    }
  })
  return out
}

// ------------------------------------------------------------------ geometry

export interface RoadPalette { floor: string, stair: string, base: string, rail: string, light: string }

export const ROAD_PALETTES: Record<string, RoadPalette> = {
  stone_bricks: { floor: 'stone_bricks', stair: 'stone_brick_stairs', base: 'cobblestone', rail: 'stone_brick_wall', light: 'lantern' },
  cobblestone: { floor: 'cobblestone', stair: 'cobblestone_stairs', base: 'cobblestone', rail: 'cobblestone_wall', light: 'lantern' },
  stone: { floor: 'stone', stair: 'stone_stairs', base: 'cobblestone', rail: 'cobblestone_wall', light: 'lantern' },
  oak: { floor: 'oak_planks', stair: 'oak_stairs', base: 'cobblestone', rail: 'oak_fence', light: 'lantern' },
  spruce: { floor: 'spruce_planks', stair: 'spruce_stairs', base: 'cobblestone', rail: 'spruce_fence', light: 'lantern' }
}
export const PALETTE_NAMES = Object.keys(ROAD_PALETTES) as [string, ...string[]]

export function paletteFor (name: string | undefined): RoadPalette {
  return ROAD_PALETTES[name ?? ''] ?? ROAD_PALETTES.stone_bricks!
}

/** Every block a road may consist of (any palette): cutting through these is fine, they're road. */
export function isRoadMaterial (name: string): boolean {
  return Object.values(ROAD_PALETTES).some(p => p.floor === name || p.stair === name || p.base === name || p.rail === name || p.light === name)
}

export type RoadPart = 'base' | 'floor' | 'stair' | 'rail' | 'light'

export interface RoadBlock { x: number, y: number, z: number, block: string, state?: BlockState, part: RoadPart, row: number }

export interface SurfaceCell { x: number, z: number, f: number, stair?: Facing, row: number, ground: number }

export interface RailCell { x: number, z: number, f: number, ground: number, row: number }

export interface RoadGeometry {
  surface: SurfaceCell[]
  rails: RailCell[]
  /** Blocks to place, in building order (by route row: base bottom-up, floor or stair, railing; lanterns last). */
  blocks: RoadBlock[]
  /** Cells that must be air: head-room f..f+2 over every lane and the cut down to it. */
  clear: { x: number, y: number, z: number, row: number }[]
  /** Cells where two rows disagree (should never happen). */
  conflicts: string[]
  stats: { length: number, stairs: number, landings: number, maxCut: number, maxFill: number, rails: number, materials: Record<string, number> }
}

export interface GeometryOptions {
  width?: number
  palette?: string | RoadPalette
  lanterns?: boolean
  /** Deepest base under a road or railing block (deeper parts are left hanging). */
  maxBase?: number
}

const PART_ORDER: Record<RoadPart, number> = { base: 0, floor: 1, stair: 1, rail: 2, light: 3 }

/** The blocks for a planned route on a terrain. Pure; the same function feeds building and checks. */
export function roadGeometry (route: RouteCell[], t: RoadTerrain, opts: GeometryOptions = {}): RoadGeometry {
  const width = roadOptions({ width: opts.width ?? 3 }).width
  const half = (width - 1) / 2
  const pal = typeof opts.palette === 'object' ? opts.palette : paletteFor(opts.palette)
  const maxBase = opts.maxBase ?? 12
  const n = route.length
  const key = (x: number, z: number) => `${x},${z}`
  const conflicts: string[] = []
  const groundAt = (x: number, z: number) => { const i = cellIndex(t, x, z); return i < 0 ? NO_GROUND : t.ground[i]! }
  const flagsAt = (x: number, z: number) => { const i = cellIndex(t, x, z); return i < 0 ? BLOCKED : t.flags[i]! }
  const dirAt = (i: number) => facingIndex(route[i]!.dir)

  // stairs: the higher cell of each one-block rise, facing the way up
  const stairOf: (Facing | undefined)[] = route.map((c, i) => {
    let s: Facing | undefined
    if (i > 0 && c.f - route[i - 1]!.f === 1) s = FACINGS[stepDir(route[i - 1]!, c)]
    if (i + 1 < n && route[i + 1]!.f - c.f === -1) {
      const down = FACINGS[opp(stepDir(c, route[i + 1]!))]
      if (s && s !== down) conflicts.push(`row ${i} would need stairs both ways`)
      s = s ?? down
    }
    return s
  })

  const surf = new Map<string, SurfaceCell>()
  route.forEach((c, i) => {
    if (c.junction) return
    for (const l of laneCells(c.x, c.z, dirAt(i), c.turn, half)) {
      if (flagsAt(l.x, l.z) & ROAD) continue // an existing road: blend in, don't overwrite
      const k = key(l.x, l.z)
      const had = surf.get(k)
      const stair = c.turn ? undefined : stairOf[i]
      if (had) {
        if (had.f !== c.f || had.stair !== stair) conflicts.push(`${l.x} ${l.z}: rows ${had.row} and ${i} disagree`)
        continue
      }
      surf.set(k, { x: l.x, z: l.z, f: c.f, ...(stair ? { stair } : {}), row: i, ground: groundAt(l.x, l.z) })
    }
  })

  // railings where the drop beside the road is 2 or more
  const railWant = new Map<string, RailCell>()
  route.forEach((c, i) => {
    if (c.junction) return
    for (const r of sideCells(c.x, c.z, dirAt(i), c.turn, half)) {
      const k = key(r.x, r.z)
      if (surf.has(k)) continue
      const fl = flagsAt(r.x, r.z)
      if (fl & (BLOCKED | ROAD)) continue
      const had = railWant.get(k)
      if (!had || had.f < c.f) railWant.set(k, { x: r.x, z: r.z, f: c.f, ground: groundAt(r.x, r.z), row: i })
    }
  })
  const rails = [...railWant.values()].filter(r => {
    if (r.ground === NO_GROUND) return false
    if (flagsAt(r.x, r.z) & LIQUID) return true
    return r.f - 1 - r.ground >= 2
  })

  const blocks: RoadBlock[] = []
  const clear: RoadGeometry['clear'] = []
  let maxCut = 0
  let maxFill = 0
  const baseCol = (x: number, z: number, g: number, top: number, row: number) => {
    const from = Math.max(g + 1, top - maxBase + 1)
    for (let y = from; y <= top; y++) blocks.push({ x, y, z, block: pal.base, part: 'base', row })
  }
  for (const c of surf.values()) {
    const liquid = !!(flagsAt(c.x, c.z) & LIQUID)
    const g = liquid ? c.ground - 1 : c.ground
    maxFill = Math.max(maxFill, c.f - 1 - c.ground)
    maxCut = Math.max(maxCut, c.ground - (c.f - 1))
    baseCol(c.x, c.z, g, c.f - 2, c.row)
    blocks.push(c.stair
      ? { x: c.x, y: c.f - 1, z: c.z, block: pal.stair, state: { facing: c.stair, half: 'bottom' }, part: 'stair', row: c.row }
      : { x: c.x, y: c.f - 1, z: c.z, block: pal.floor, part: 'floor', row: c.row })
    for (let y = c.f; y <= Math.max(c.f + 2, c.ground); y++) clear.push({ x: c.x, y, z: c.z, row: c.row })
  }
  for (const r of rails) {
    const liquid = !!(flagsAt(r.x, r.z) & LIQUID)
    baseCol(r.x, r.z, liquid ? r.ground - 1 : r.ground, r.f - 1, r.row)
    blocks.push({ x: r.x, y: r.f, z: r.z, block: pal.rail, part: 'rail', row: r.row })
  }
  if (opts.lanterns) {
    const railAt = new Map(rails.map(r => [key(r.x, r.z), r]))
    route.forEach((c, i) => {
      if (!c.turn || i === 0) return
      const din = stepDir(route[i - 1]!, c)
      const dout = dirAt(i)
      const r = half + 1
      const x = c.x + DX[din]! * r + DX[opp(dout)]! * r
      const z = c.z + DZ[din]! * r + DZ[opp(dout)]! * r
      const rail = railAt.get(key(x, z))
      if (rail) { blocks.push({ x, y: rail.f + 1, z, block: pal.light, part: 'light', row: i }); return }
      const g = groundAt(x, z)
      const fl = flagsAt(x, z)
      if (g === NO_GROUND || (fl & (BLOCKED | ROAD | LIQUID)) || surf.has(key(x, z)) || g > c.f - 1 || g < c.f - 2) return
      baseCol(x, z, g, c.f - 1, i)
      blocks.push({ x, y: c.f, z, block: pal.rail, part: 'rail', row: i })
      blocks.push({ x, y: c.f + 1, z, block: pal.light, part: 'light', row: i })
    })
  }
  blocks.sort((a, b) => (a.part === 'light' ? 1 : 0) - (b.part === 'light' ? 1 : 0) || a.row - b.row || PART_ORDER[a.part] - PART_ORDER[b.part] || a.y - b.y)
  const materials: Record<string, number> = {}
  for (const b of blocks) materials[b.block] = (materials[b.block] ?? 0) + 1
  const surface = [...surf.values()].sort((a, b) => a.row - b.row)
  return {
    surface,
    rails,
    blocks,
    clear,
    conflicts,
    stats: {
      length: route.filter(c => !c.junction).length,
      stairs: stairOf.filter((s, i) => s && !route[i]!.junction).length,
      landings: route.filter(c => c.turn).length,
      maxCut,
      maxFill,
      rails: rails.length,
      materials
    }
  }
}

/**
 * Walkability problems of a built (or planned) road: the route itself (routeProblems) and every
 * lane: each row's lanes at the row's height, and each rise a stair on the higher cell facing up
 * on every lane. Empty when it's fine.
 */
export function geometryProblems (route: RouteCell[], geo: RoadGeometry, width = 3): string[] {
  const out = routeProblems(route, width)
  const half = (roadOptions({ width }).width - 1) / 2
  const at = new Map(geo.surface.map(c => [`${c.x},${c.z}`, c]))
  route.forEach((c, i) => {
    if (c.junction) return
    const lanes = laneCells(c.x, c.z, facingIndex(c.dir), c.turn, half)
    const rise = i > 0 && c.f - route[i - 1]!.f === 1 ? FACINGS[stepDir(route[i - 1]!, c)] : undefined
    const fall = i + 1 < route.length && route[i + 1]!.f - c.f === -1 ? FACINGS[opp(stepDir(c, route[i + 1]!))] : undefined
    const want = rise ?? fall
    for (const l of lanes) {
      const s = at.get(`${l.x},${l.z}`)
      if (!s) continue // existing road under a junction
      if (s.f !== c.f) out.push(`lane ${l.x} ${l.z} of row ${i} is at ${s.f}, not ${c.f}`)
      if (want && s.stair !== want) out.push(`lane ${l.x} ${l.z} of row ${i} should be a stair facing ${want}, is ${s.stair ?? 'flat'}`)
      if (!want && s.stair && s.row === i) out.push(`lane ${l.x} ${l.z} of row ${i} is a stair on a flat row`)
    }
  })
  return out
}

/** Marks a laid road in the terrain: its lanes become ROAD (with heights and stairs), its railings RAIL. */
export function layRoad (t: RoadTerrain, geo: RoadGeometry): void {
  for (const c of geo.surface) {
    const i = cellIndex(t, c.x, c.z)
    if (i < 0) continue
    t.flags[i]! |= ROAD
    t.flags[i]! &= ~MARGIN
    t.roadF[i] = c.f
    t.roadStair[i] = c.stair ? facingIndex(c.stair) : -1
  }
  for (const r of geo.rails) {
    const i = cellIndex(t, r.x, r.z)
    if (i >= 0) t.flags[i]! |= RAIL
  }
}

// ------------------------------------------------------------------ networks

export interface ConnectedRoad {
  route: RouteCell[]
  geometry: RoadGeometry
  cost: number
  /** Endpoint indices joined (to = -1 when it ends on a road as a T-junction). */
  from: number
  to: number
}

export interface ConnectResult {
  roads: ConnectedRoad[]
  /** Endpoints that couldn't be joined, with the reason. */
  failed: { ends: number[], reason: string }[]
  /** Endpoint indices per connected group at the end (one group when everything is joined). */
  groups: number[][]
  terrain: RoadTerrain
}

interface Group { id: string, ends: number[], free: number[], roads: { x: number, z: number }[] }

/** Each group is planned against its nearest few groups first. */
const NEAREST = 3

/**
 * Joins endpoints (door fronts) into one network, cheapest road first between groups (Kruskal on
 * planned costs). After each road is laid the terrain knows it (no overlaps, T-junctions allowed)
 * and plans that went near it are made again. Each door gets at most one road; groups that are
 * already networks join through T-junctions. `existing` are road networks already there (their
 * cells must be ROAD in the terrain): doors may join them too. Pure.
 */
export function connect (t0: RoadTerrain, ends: RoadEnd[], opts: Partial<RoadOptions> = {}, geo: GeometryOptions = {}, existing: { x: number, z: number }[][] = []): ConnectResult {
  const t = cloneTerrain(t0)
  const o = roadOptions(opts)
  const gopts = { ...geo, width: o.width }
  let groups: Group[] = [
    ...ends.map((_e, i) => ({ id: `d${i}`, ends: [i], free: [i], roads: [] })),
    ...existing.filter(r => r.length).map((r, k) => ({ id: `r${k}`, ends: [], free: [], roads: r }))
  ]
  // done when every door is in one group, and that group reaches a road network already there (if any)
  const hasOld = groups.some(g => g.id.startsWith('r'))
  const joined = () => {
    const withEnds = groups.filter(g => g.ends.length)
    return withEnds.length <= 1 && (!hasOld || !withEnds.length || /(^|\+)r/.test(withEnds[0]!.id))
  }
  const roads: ConnectedRoad[] = []
  const cache = new Map<string, { res: PlanResult, swap: boolean, limited?: boolean }>()
  const gid = (g: Group) => g.id
  /** Points of a group: its doors and its road cells. */
  const pointsOf = (g: Group) => [...g.ends.map(i => ends[i]!), ...g.roads]
  const gap = (a: Group, b: Group) => {
    let m = Infinity
    for (const p of pointsOf(a)) for (const q of pointsOf(b)) m = Math.min(m, Math.hypot(p.x - q.x, p.z - q.z))
    return m
  }
  const planPair = (a: Group, b: Group, full: boolean): { res: PlanResult, swap: boolean, limited?: boolean } => {
    // start from the side that still has a free door
    const swap = !a.free.length && b.free.length > 0
    const [s, d] = swap ? [b, a] : [a, b]
    // a node budget that grows with the distance: a far pair that fails shouldn't eat seconds
    // (made again with the full budget when nothing else works)
    const maxNodes = full ? o.maxNodes : Math.min(o.maxNodes, 60_000 + 3000 * Math.round(gap(a, b)))
    const res = planRoad(t, { from: s.free.map(i => ends[i]!), fromRoads: s.free.length ? [] : s.roads, to: d.free.map(i => ends[i]!), toRoads: d.roads }, { ...o, maxNodes })
    return { res, swap, limited: !res.ok && maxNodes < o.maxNodes && res.stats.nodes > maxNodes }
  }
  while (!joined()) {
    let bestPair: [number, number] | null = null
    let bestCost = Infinity
    // only the nearest few groups are planned against each other (far pairs are slow and rarely the cheapest);
    // when none of those works, every pair is tried
    const pairs: [number, number][] = []
    // (two road networks without doors aren't worth joining)
    for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) if (groups[i]!.ends.length || groups[j]!.ends.length) pairs.push([i, j])
    const gaps = new Map(pairs.map(([i, j]) => [`${i}|${j}`, gap(groups[i]!, groups[j]!)]))
    const nearest = new Set<string>()
    for (let i = 0; i < groups.length; i++) {
      pairs.filter(([a, b]) => a === i || b === i).sort((p, q) => gaps.get(`${p[0]}|${p[1]}`)! - gaps.get(`${q[0]}|${q[1]}`)!).slice(0, NEAREST).forEach(([a, b]) => nearest.add(`${a}|${b}`))
    }
    for (const round of [0, 1, 2]) {
      for (const [i, j] of pairs) {
        if (round === 0 && !nearest.has(`${i}|${j}`)) continue
        if (round === 1 && nearest.has(`${i}|${j}`)) continue
        const k = `${gid(groups[i]!)}|${gid(groups[j]!)}`
        if (round === 2 && cache.get(k)?.limited) cache.delete(k)
        if (!cache.has(k)) cache.set(k, planPair(groups[i]!, groups[j]!, round === 2))
        const r = cache.get(k)!.res
        if (r.ok && r.cost < bestCost) { bestCost = r.cost; bestPair = [i, j] }
      }
      if (bestPair) break
    }
    if (!bestPair) break
    const [i, j] = bestPair
    const a = groups[i]!
    const b = groups[j]!
    const { res, swap } = cache.get(`${gid(a)}|${gid(b)}`)!
    if (!res.ok) break
    const [s, d] = swap ? [b, a] : [a, b]
    const geometry = roadGeometry(res.route, t, gopts)
    layRoad(t, geometry)
    const fromEnd = res.fromEnd >= 0 ? s.free[res.fromEnd]! : -1
    const toEnd = res.toEnd >= 0 ? d.free[res.toEnd]! : -1
    roads.push({ route: res.route, geometry, cost: res.cost, from: fromEnd, to: toEnd })
    const merged: Group = {
      id: [a.id, b.id].sort().join('+'),
      ends: [...a.ends, ...b.ends].sort((x, y) => x - y),
      free: [],
      roads: [...a.roads, ...b.roads, ...geometry.surface.map(c => ({ x: c.x, z: c.z }))]
    }
    groups = [...groups.filter((_g, n) => n !== i && n !== j), merged]
    // plans that involve the joined groups, or pass near the new road, are made again
    const near = new Set<string>()
    const r = (o.width - 1) / 2 + 2
    for (const c of [...geometry.surface, ...geometry.rails]) for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) near.add(`${c.x + dx},${c.z + dz}`)
    const live = new Set(groups.map(gid))
    for (const [k, v] of [...cache]) {
      const [p, q] = k.split('|')
      if (!live.has(p!) || !live.has(q!)) { cache.delete(k); continue }
      if (v.res.ok && v.res.route.some(c => near.has(`${c.x},${c.z}`))) cache.delete(k)
    }
  }
  const failed: ConnectResult['failed'] = []
  if (!joined()) {
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        if (!groups[i]!.ends.length || !groups[j]!.ends.length) continue
        const v = cache.get(`${gid(groups[i]!)}|${gid(groups[j]!)}`)
        if (v && !v.res.ok) failed.push({ ends: [...groups[i]!.ends, ...groups[j]!.ends], reason: v.res.reason })
      }
    }
  }
  return { roads, failed, groups: groups.filter(g => g.ends.length).map(g => g.ends), terrain: t }
}
