// Base safety, planned: which dark spaces under and around a base mobs can spawn in and reach it
// (or the bot can wander into), and how to fix each. Pure and unit tested
// (test/base-safety-plan.test.ts); baseSafety.ts reads the world into it and does the work.
//
// Why: a bot that digs stone near home hollows out the ground under its own base. Pax mined its
// cobblestone right under the fortress floor, wandered into the dark tunnels, and was shot there
// by skeletons twice in a row (it respawned in its bed just above). A staircase mine dug one block
// from the walls is the same kind of hole. The scan below finds such cavities by sky light (dark =
// underground), follows each to where it meets the open air (its openings: a hole in the floor, a
// cave mouth or a mine entrance next to the walls) and counts the spots a mob could spawn on.
// The fixes are a small list of techniques tried in order (settings baseSafety.techniques): cap a
// mine entrance, fill a small cavity in whole, seal the openings of a bigger one, light it.
import type { SafetyTechnique, CapKind, MinePlacement } from '../core/baseSafety.ts'

export interface Pos { x: number, y: number, z: number }

/** What the scan needs to know about one block. */
export interface Cell {
  name: string
  /** A full block a mob can't walk through (and stand on). */
  solid: boolean
  /** Block light (torches); unset = unknown (treated as 0). */
  light?: number
  /** Sky light; unset = unknown (then "dark" means something solid overhead). */
  sky?: number
}
/** Block reader; undefined = not loaded. */
export type Look = (p: Pos) => Cell | undefined

/** The base as the scan sees it. */
export interface BaseArea {
  /** The footprint, walls included (inclusive corners). */
  min: { x: number, z: number }
  max: { x: number, z: number }
  /** The y of the floor blocks (the blueprint's layer 0). */
  floorY: number
  /** Columns inside the walls. */
  inside: (x: number, z: number) => boolean
  /** Columns kept for soil (a farm plot): an empty one is a hole too, filled with dirt. */
  soil?: (x: number, z: number) => boolean
}

export interface ScanOptions {
  /** Blocks around the footprint looked at too. */
  margin: number
  /** Blocks below the floor looked at. */
  depth: number
  /** Blocks above the floor looked at (to see where a cavity meets the open air). Default 3. */
  above?: number
  /** Sky light below this is underground. Default 4. */
  skyDark?: number
  /** Also report holes in the floor surface inside the walls. Default true. */
  floorHoles?: boolean
}

/** Blocks at floor level that are meant to be open and are no hole: a farm's water. */
const MEANT_OPEN = /^(water|lava|bubble_column)$/

/** A mine the bot dug (stairMine.ts): its entrance and the blocks it dug (stairs, tunnel), as far as known. */
export interface MineRef { id: string, entrance: Pos, cells: Pos[] }

/** Where an opening is: in a column inside the walls, under the walls, or around them. */
export type Where = 'inside' | 'under_wall' | 'near'
export interface Opening extends Pos { where: Where }

export interface Cavity {
  id: number
  cells: Pos[]
  size: number
  /** Cells under the footprint. */
  under: number
  /** Cavity cells next to open air that isn't dark: where mobs (and the bot) get in and out. */
  openings: Opening[]
  /** Dark cells a mob could spawn on (solid below, room above, no block light). */
  spawnable: Pos[]
  /** Reaches the edge of the scanned box: it goes on further (a cave), so its size is unknown. */
  edge: boolean
  /** Mines whose entrance or first steps are part of it. */
  mines: string[]
}

/** A hole in the floor surface inside the walls: open to the sky, so not a cavity, but a gap in the floor all the same. */
export interface FloorHole {
  x: number
  z: number
  /** Open blocks to fill, bottom up, ending with the floor block. */
  cells: Pos[]
  /** In a column kept for soil (a farm plot): filled with dirt, not stone. */
  soil: boolean
  /** It goes deeper than the scan looks: only the top of it is filled. */
  deep: boolean
}

export interface ScanResult {
  cavities: Cavity[]
  /** Holes in the floor surface inside the walls (not part of a cavity). */
  holes: FloorHole[]
  /** The ones that matter: an opening, and spawn spots or a way into the base. */
  threats: Cavity[]
  /** Blocks not loaded (the scan can't tell). */
  unknown: number
  box: { min: Pos, max: Pos }
}

const k = (p: Pos) => `${p.x},${p.y},${p.z}`
const N6: [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
const add = (p: Pos, d: [number, number, number]): Pos => ({ x: p.x + d[0], y: p.y + d[1], z: p.z + d[2] })
const manhattan = (a: Pos, b: Pos) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z)

export const inFootprint = (a: Pick<BaseArea, 'min' | 'max'>, x: number, z: number) => x >= a.min.x && x <= a.max.x && z >= a.min.z && z <= a.max.z

/** Where a column is relative to the base. Pure. */
export function whereOf (a: BaseArea, x: number, z: number): Where {
  if (a.inside(x, z)) return 'inside'
  return inFootprint(a, x, z) ? 'under_wall' : 'near'
}

/**
 * Scans the ground under and around a base. Pure. Every open (not solid) block in the box that is
 * at or below the floor level and dark (sky light under skyDark, or with something solid overhead
 * when the sky light is unknown) belongs to a cavity; cavities are grown block by block (6 neighbours). A cavity block next to an
 * open block that isn't dark is an opening. A cavity is a threat when it has an opening and either
 * spawn spots or an opening into the footprint (a hole in the floor, a tunnel under the walls).
 */
export function scanBase (area: BaseArea, look: Look, o: ScanOptions, mines: readonly MineRef[] = []): ScanResult {
  const box = {
    min: { x: area.min.x - o.margin, y: area.floorY - o.depth, z: area.min.z - o.margin },
    max: { x: area.max.x + o.margin, y: area.floorY + (o.above ?? 3), z: area.max.z + o.margin }
  }
  const skyDark = o.skyDark ?? 4
  const inBox = (p: Pos) => p.x >= box.min.x && p.x <= box.max.x && p.y >= box.min.y && p.y <= box.max.y && p.z >= box.min.z && p.z <= box.max.z
  const onEdge = (p: Pos) => p.x === box.min.x || p.x === box.max.x || p.z === box.min.z || p.z === box.max.z || p.y === box.min.y
  const memo = new Map<string, Cell | null>()
  let unknown = 0
  const at = (p: Pos): Cell | null => {
    const id = k(p)
    let c = memo.get(id)
    if (c === undefined) {
      c = look(p) ?? null
      if (!c && inBox(p)) unknown++
      memo.set(id, c)
    }
    return c
  }
  const open = (p: Pos) => { const c = at(p); return !!c && !c.solid }
  const covered = (p: Pos) => {
    for (let y = p.y + 1; y <= box.max.y + 8; y++) { const c = at({ x: p.x, y, z: p.z }); if (!c) return true; if (c.solid) return true }
    return false
  }
  // only at or below the floor: a hut or a roofed room standing on the base is not a cave
  const dark = (p: Pos) => { if (p.y > area.floorY) return false; const c = at(p); if (!c || c.solid) return false; return c.sky !== undefined ? c.sky < skyDark : covered(p) }

  const seen = new Set<string>()
  const cavities: Cavity[] = []
  for (let y = box.min.y; y <= box.max.y; y++) {
    for (let x = box.min.x; x <= box.max.x; x++) {
      for (let z = box.min.z; z <= box.max.z; z++) {
        const s = { x, y, z }
        if (seen.has(k(s)) || !dark(s)) continue
        // grow the cavity
        const cells: Pos[] = [s]
        seen.add(k(s))
        for (let i = 0; i < cells.length; i++) {
          for (const d of N6) {
            const q = add(cells[i]!, d)
            if (!inBox(q) || seen.has(k(q)) || !dark(q)) continue
            seen.add(k(q))
            cells.push(q)
          }
        }
        const openings: Opening[] = []
        const spawnable: Pos[] = []
        let edge = false
        let under = 0
        for (const c of cells) {
          if (onEdge(c)) edge = true
          if (inFootprint(area, c.x, c.z)) under++
          if (N6.some(d => { const q = add(c, d); return inBox(q) && open(q) && !dark(q) })) openings.push({ ...c, where: whereOf(area, c.x, c.z) })
          const below = at({ x: c.x, y: c.y - 1, z: c.z })
          const head = at({ x: c.x, y: c.y + 1, z: c.z })
          if (below?.solid && (!head || !head.solid) && (at(c)?.light ?? 0) === 0) spawnable.push(c)
        }
        const keys = new Set(cells.map(k))
        const near = (p: Pos) => keys.has(k(p)) || N6.some(d => keys.has(k(add(p, d))))
        const ms = mines.filter(m => near(m.entrance) || m.cells.some(near)).map(m => m.id)
        cavities.push({ id: cavities.length + 1, cells, size: cells.length, under, openings, spawnable, edge, mines: ms })
      }
    }
  }
  const threats = cavities.filter(c => c.openings.length > 0 && (c.spawnable.length > 0 || c.openings.some(p => p.where !== 'near')))
  // holes in the floor surface: an open floor block inside the walls that the sky reaches. It
  // isn't dark, so it isn't a cavity, but it is a hole in the floor (a mob can stand in it, the
  // bot and its owner fall in), and the floor stage may not see it (a farm plot, a cell under a hut)
  const holes: FloorHole[] = []
  if (o.floorHoles !== false) {
    const y = area.floorY
    // a mine's stairs inside the walls are capped, not filled
    const mineCols = new Set(mines.flatMap(m => [m.entrance, ...m.cells]).map(p => `${p.x},${p.z}`))
    for (let x = area.min.x; x <= area.max.x; x++) {
      for (let z = area.min.z; z <= area.max.z; z++) {
        if (!area.inside(x, z) || mineCols.has(`${x},${z}`)) continue
        const top = at({ x, y, z })
        if (!top || top.solid || MEANT_OPEN.test(top.name) || seen.has(k({ x, y, z }))) continue
        const cells: Pos[] = []
        let deep = true
        for (let yy = y; yy >= y - o.depth; yy--) {
          const c = at({ x, y: yy, z })
          if (!c) break
          if (c.solid || seen.has(k({ x, y: yy, z }))) { deep = false; break }
          cells.push({ x, y: yy, z })
        }
        holes.push({ x, z, cells: cells.reverse(), soil: !!area.soil?.(x, z), deep })
      }
    }
  }
  return { cavities, threats, holes, unknown, box }
}

/** The steps for the floor holes: fill each, bottom up (a deep one only its top 3). Pure. */
export function planHoleFills (holes: readonly FloorHole[]): FixStep[] {
  return holes.flatMap(h => {
    const cells = h.deep ? h.cells.slice(-3) : h.cells
    // the floor block itself in stone (dirt in a farm plot), what is under it with any filler
    return cells.map((pos, i) => ({ technique: 'seal' as const, action: 'fill' as const, pos, ...(h.soil ? { soil: true } : i === cells.length - 1 ? { floor: true } : {}) }))
  })
}

/** One line per hole for chat and status. Pure. */
export function describeHole (h: FloorHole): string {
  const top = h.cells.at(-1) ?? { x: h.x, y: 0, z: h.z }
  return `hole in the floor at ${top.x} ${top.y} ${top.z}: ${h.cells.length}${h.deep ? '+' : ''} block${h.cells.length === 1 ? '' : 's'} deep${h.soil ? ' (farm plot: dirt)' : ''}`
}

// ------------------------------------------------------------------ fixes

export type FixAction = 'fill' | 'torch' | 'cap'
export interface FixStep {
  technique: SafetyTechnique
  action: FixAction
  pos: Pos
  /** cap: what goes there. */
  cap?: Exclude<CapKind, 'light' | 'none'>
  mine?: string
  /** fill with dirt (a farm plot), not stone. */
  soil?: boolean
  /** fill with a stone block if it has one: the top of a hole in the floor. */
  floor?: boolean
}

export interface FixOptions {
  techniques: readonly SafetyTechnique[]
  fillMax: number
  sealMax: number
  lightSpacing: number
  capWith: CapKind
}

export interface TechniqueResult {
  steps: FixStep[]
  /** Openings it dealt with. */
  covers: Opening[]
  /** Nothing more to do about the cavity. */
  done: boolean
}

/** One way to make a cavity safe: null when it doesn't apply (the reason goes to `why`). */
export type Technique = (c: Cavity, open: readonly Opening[], o: FixOptions, why: string[]) => TechniqueResult | null

const nearMine = (c: Cavity, p: Pos, mines: readonly MineRef[]) => mines.some(m => c.mines.includes(m.id) && [m.entrance, ...m.cells].some(q => manhattan(q, p) <= 2))

/** Torch spots on a cavity's spawn spots, at most `spacing` apart (greedy, nearest the openings first). Pure. */
export function torchSpots (c: Pick<Cavity, 'spawnable' | 'openings'>, spacing: number): Pos[] {
  const fromOpen = (p: Pos) => c.openings.length ? Math.min(...c.openings.map(o => manhattan(o, p))) : 0
  const order = [...c.spawnable].sort((a, b) => fromOpen(a) - fromOpen(b) || a.y - b.y)
  const out: Pos[] = []
  for (const p of order) if (!out.some(t => manhattan(t, p) <= spacing)) out.push(p)
  return out
}

/** Cells to fill, the far end first (the bot backs out towards the openings), bottom up. Pure. */
export function fillOrder (c: Pick<Cavity, 'cells' | 'openings'>): Pos[] {
  const fromOpen = (p: Pos) => c.openings.length ? Math.min(...c.openings.map(o => manhattan(o, p))) : 0
  return [...c.cells].sort((a, b) => fromOpen(b) - fromOpen(a) || a.y - b.y)
}

/** The techniques by name; settings.baseSafety.techniques says which run and in what order. */
export function techniques (mines: readonly MineRef[]): Record<SafetyTechnique, Technique> {
  return {
    // mine entrances are capped by planMineCaps (their stairs are open to the sky, not a dark cavity);
    // here a cavity a mine runs into only keeps its mine openings for that
    cap (c, open) {
      if (!c.mines.length) return null
      const covers = open.filter(p => nearMine(c, p, mines))
      return covers.length ? { steps: [], covers, done: covers.length === open.length } : null
    },
    // a small, closed-off pocket (not a cave going on, not a mine): fill it in whole
    fill (c, open, o, why) {
      if (o.fillMax <= 0) { why.push('fill: fillMax 0'); return null }
      if (c.mines.length) return null
      if (c.edge) { why.push('fill: it goes on past the scanned box'); return null }
      if (c.size > o.fillMax) { why.push(`fill: ${c.size} blocks > fillMax ${o.fillMax}`); return null }
      const steps = fillOrder(c).map(pos => ({ technique: 'fill' as const, action: 'fill' as const, pos }))
      return { steps, covers: [...open], done: true }
    },
    // block every opening (except a mine's: that one is capped or lit)
    seal (c, open, o, why) {
      const todo = open.filter(p => !nearMine(c, p, mines))
      if (!todo.length) return null
      if (todo.length > o.sealMax) { why.push(`seal: ${todo.length} openings > sealMax ${o.sealMax}`); return null }
      const steps = todo.map(p => ({ technique: 'seal' as const, action: 'fill' as const, pos: { x: p.x, y: p.y, z: p.z } }))
      return { steps, covers: todo, done: todo.length === open.length }
    },
    // torches on its spawn spots: it stays open, but nothing spawns in it
    light (c, open, o, why) {
      if (!c.spawnable.length) { why.push('light: no spawn spots to light'); return null }
      const steps = torchSpots(c, o.lightSpacing).map(pos => ({ technique: 'light' as const, action: 'torch' as const, pos }))
      return { steps, covers: [], done: true }
    }
  }
}

export interface CavityFix {
  cavity: Cavity
  steps: FixStep[]
  /** What stays unsafe after the steps, if anything. */
  unfixed?: string
}

/**
 * The fix for each threat: the techniques in order, each taking the openings the earlier ones
 * left; one that says done ends the list. Pure.
 */
export function planFixes (threats: readonly Cavity[], o: FixOptions, mines: readonly MineRef[] = []): CavityFix[] {
  const all = techniques(mines)
  return threats.map(c => {
    let open: Opening[] = [...c.openings]
    const steps: FixStep[] = []
    const why: string[] = []
    let done = false
    for (const name of o.techniques) {
      const r = all[name]?.(c, open, o, why)
      if (!r) continue
      steps.push(...r.steps)
      const covered = new Set(r.covers.map(k))
      open = open.filter(p => !covered.has(k(p)))
      if (r.done || !open.length) { done = true; break }
    }
    const seen = new Set<string>()
    const uniq = steps.filter(s => { const id = `${s.action}:${k(s.pos)}`; if (seen.has(id)) return false; seen.add(id); return true })
    const out: CavityFix = { cavity: c, steps: uniq }
    if (!done) out.unfixed = `${open.length} opening${open.length === 1 ? '' : 's'} left${why.length ? ` (${why.join('; ')})` : ''}`
    return out
  })
}

/** One line per threat for chat and status. Pure. */
export function describeCavity (c: Cavity): string {
  const at = c.cells[0]!
  const where = c.openings.some(o => o.where === 'inside') ? 'opens into the base' : c.openings.some(o => o.where === 'under_wall') ? 'runs under the walls' : 'opens next to the walls'
  const what = c.mines.length ? `mine ${c.mines.join(', ')}` : c.under ? 'cavity under the base' : 'cavity by the base'
  return `${what} near ${at.x} ${at.y} ${at.z}: ${c.size}${c.edge ? '+' : ''} blocks, ${c.spawnable.length} spawn spots, ${c.openings.length} opening${c.openings.length === 1 ? '' : 's'} (${where})`
}

// ------------------------------------------------------------------ mine entrances

export interface MineFinding {
  mine: MineRef
  /** What is wrong with where it is (mineSpotProblem). */
  problem: string
  /** Where a cap goes: the dug blocks of its stairs at ground level, still open. */
  caps: Pos[]
  /** Its stairs are capped already. */
  capped: boolean
}

/** A cap that is in place: a solid block, or a trapdoor or slab (not solid to a mob's spawn check, but closed). */
export const isCap = (c: Cell | undefined) => !!c && (c.solid || /_trapdoor$|_slab$/.test(c.name))

/**
 * Known mines whose entrance is inside the base, on its walls or within `clearance` of them: their
 * stairs are a way under the walls (and, unlit, a spawner next to them). The cap goes over the
 * stairs where they cut through the ground: each dug block at the entrance's ground level (one
 * below its feet) that is still open. Pure.
 */
export function mineFindings (mines: readonly MineRef[], area: Pick<BaseArea, 'min' | 'max' | 'inside'>, look: Look, clearance: number): MineFinding[] {
  const out: MineFinding[] = []
  for (const m of mines) {
    // any entrance this close is a hole by the base, whatever the placement setting allows
    const problem = mineSpotProblem(m.entrance, area, clearance, 'outside')
    if (!problem) continue
    const ground = m.entrance.y - 1
    const cols = new Set<string>()
    const caps: Pos[] = []
    let anyCap = false
    for (const c of m.cells) {
      if (c.y > ground + 1 || c.y < ground - 2) continue
      const col = `${c.x},${c.z}`
      if (cols.has(col)) continue
      cols.add(col)
      const p = { x: c.x, y: ground, z: c.z }
      const here = look(p)
      if (isCap(here)) { anyCap = true; continue }
      if (here && !here.solid) caps.push(p)
    }
    out.push({ mine: m, problem, caps, capped: anyCap && !caps.length })
  }
  return out
}

/**
 * Small blocks that stand in a cap cell without filling it and don't give way to a placed block:
 * the torch a trip put on the first stair step, a ladder, a rail. A cap there is a solid block's
 * worth of air to a mob, so they are taken out before the cap goes on.
 */
const CAP_BLOCKERS = /(^|_)torch$|(^|_)lantern$|^ladder$|(^|_)rail$|_carpet$|_button$|_pressure_plate$|^redstone_wire$|^lever$|^cobweb$|_sign$/

/**
 * Whether a block in a cap cell has to be taken out before the cap can go on. Pure. Pax's first
 * mine had a torch on its first step, on the wall line: the cap step failed with "torch is
 * already there" every session for hours, the mine was never capped, so never retired.
 */
export function clearForCap (name: string | undefined, solid: boolean, replaceable: boolean): boolean {
  if (!name || solid || replaceable || isCap({ name, solid })) return false
  return CAP_BLOCKERS.test(name)
}

/**
 * Whether a known mine near the base gets retired (no more trips, a new one is dug): capped (just
 * now or already), outside the walls, not retired yet, retireCloseMines on and its own mine
 * allowed inside. Pure.
 */
export function retireMine (m: { inside?: boolean, retired?: unknown }, capped: boolean, s: { retireCloseMines: boolean, minePlacement: MinePlacement }): boolean {
  return capped && s.retireCloseMines && !m.inside && !m.retired && s.minePlacement !== 'outside'
}

/** The steps for the mine findings: a cap (or torches down the stairs) per entrance. Pure. */
export function planMineCaps (found: readonly MineFinding[], o: Pick<FixOptions, 'techniques' | 'capWith' | 'lightSpacing'>): { steps: FixStep[], unfixed: string[] } {
  const steps: FixStep[] = []
  const unfixed: string[] = []
  for (const f of found) {
    if (!f.caps.length) continue
    if (!o.techniques.includes('cap') || o.capWith === 'none') { unfixed.push(`${f.mine.id} ${f.problem}, left open (${o.techniques.includes('cap') ? 'capWith none' : 'cap off'})`); continue }
    if (o.capWith === 'light') {
      const below = f.mine.cells.filter(c => c.y < f.mine.entrance.y - 1)
      const spots: Pos[] = []
      for (const p of below) if (!spots.some(t => manhattan(t, p) <= o.lightSpacing)) spots.push(p)
      for (const pos of spots) steps.push({ technique: 'cap', action: 'torch', pos, mine: f.mine.id })
      continue
    }
    for (const pos of f.caps) steps.push({ technique: 'cap', action: 'cap', pos, cap: o.capWith, mine: f.mine.id })
  }
  return { steps, unfixed }
}

/** The blocks a staircase mine dug, as far as its record says: the start steps (3 high each), the stairs on in its direction down to the deepest y, and the tunnel spots. Pure. */
export function mineCells (m: { entrance: Pos, dir: { x: number, z: number }, start?: Pos[], path?: Pos[], deepest?: number, stairSteps?: number }): Pos[] {
  const out: Pos[] = []
  const steps = Math.max(m.start?.length ?? 0, m.stairSteps ?? 0, Math.max(0, m.entrance.y - (m.deepest ?? m.entrance.y)))
  for (let i = 1; i <= steps; i++) {
    const feet = { x: m.entrance.x + m.dir.x * i, y: m.entrance.y - i, z: m.entrance.z + m.dir.z * i }
    out.push(feet, { ...feet, y: feet.y + 1 }, { ...feet, y: feet.y + 2 })
  }
  for (const p of m.path ?? []) out.push(p, { ...p, y: p.y + 1 })
  return out
}

// ------------------------------------------------------------------ mine placement

/**
 * Why a mine entrance at this column is not right for the base, or null. Pure. outside: beyond the
 * footprint by more than `clearance` blocks (not hugging the wall, where its hole is a way under
 * it); inside: in a column inside the walls (it gets a cap); either: one or the other. Never on
 * the walls themselves.
 */
export function mineSpotProblem (p: { x: number, z: number }, area: Pick<BaseArea, 'min' | 'max' | 'inside'>, clearance: number, placement: MinePlacement): string | null {
  if (inFootprint(area, p.x, p.z)) {
    if (!area.inside(p.x, p.z)) return 'on the base walls'
    return placement === 'outside' ? 'inside the base walls' : null
  }
  if (placement === 'inside') return 'outside the base (minePlacement inside)'
  const dx = Math.max(area.min.x - p.x, 0, p.x - area.max.x)
  const dz = Math.max(area.min.z - p.z, 0, p.z - area.max.z)
  const d = Math.max(dx, dz)
  if (d <= clearance) return `${d} block${d === 1 ? '' : 's'} from the base walls (mineClearance ${clearance})`
  return null
}
