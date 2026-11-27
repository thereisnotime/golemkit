// Pure planning for base projects (src/skills/projects.ts): the stages of the base blueprint
// (meta.stages in blueprints/fortress.yaml: walls, floor, towers, walkway), which of their
// blocks are already there, where the base stands (fitting the blueprint to what is built),
// where things go inside the walls (a storage row, a workshop, a reserved farm plot), the bill of
// materials against what it carries and what its chests hold, and how much to gather per session.
// No bot, no world: callers pass block readers. Unit tests: test/base-plan.test.ts.
import type { Blueprint, Facing, Pos, ResolvedRole, WorldCell } from './blueprint.ts'
import { diffCells, haveFor, isNaturalBlock, isReplaceableName, roleAccepts, solidCells } from './blueprint.ts'
import { familyOf, opposite, isFacing, DIR_VEC, type Dir, type BlockState } from './blockstate.ts'

// ------------------------------------------------------------------ stages

export interface Stage {
  name: string
  title: string
  /** Cells of these roles belong to the stage... */
  roles: string[]
  /** ...and cells drawn with these glyphs (the gate torches of the walls, say). */
  glyphs: string[]
  /** Stages to finish first. */
  after: string[]
  /** Leave cells alone that have a block on top that isn't part of the plan (a hut on the old floor, a torch). */
  skipCovered: boolean
}

const strs = (v: unknown): string[] => Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : typeof v === 'string' ? [v] : []

/** The stages a blueprint declares in meta.stages; one stage "build" with everything when it declares none. Pure. */
export function blueprintStages (bp: Pick<Blueprint, 'meta' | 'roles' | 'name'>): Stage[] {
  const raw = (bp.meta as { stages?: unknown } | undefined)?.stages
  if (!Array.isArray(raw) || !raw.length) {
    return [{ name: 'build', title: `the ${bp.name}`, roles: Object.keys(bp.roles), glyphs: [], after: [], skipCovered: false }]
  }
  return raw.flatMap(r => {
    const o = r as Record<string, unknown>
    if (!o || typeof o.name !== 'string') return []
    return [{
      name: o.name,
      title: typeof o.title === 'string' ? o.title : o.name,
      roles: strs(o.roles),
      glyphs: strs(o.glyphs),
      after: strs(o.after),
      skipCovered: o.skipCovered === true
    }]
  })
}

/** The cells of one stage: by glyph first (a glyph names its stage), then by role. Pure. */
export function stageCells<T extends { role: string, local?: { glyph?: string } }> (cells: readonly T[], stage: Stage, all: readonly Stage[]): T[] {
  const claimed = new Set(all.flatMap(s => s.glyphs))
  return cells.filter(c => {
    const g = c.local?.glyph
    if (g && stage.glyphs.includes(g)) return true
    if (g && claimed.has(g)) return false
    return stage.roles.includes(c.role)
  })
}

// ------------------------------------------------------------------ survey

export interface StageSurvey<T> {
  /** Solid cells in the stage. */
  total: number
  done: T[]
  /** To place or to dig and place. */
  todo: T[]
  /** Someone else's block is there: left alone. */
  blocked: T[]
  /** Under a build that isn't part of the plan: left alone. */
  covered: T[]
  /** Not loaded: can't tell. */
  unknown: T[]
  /** Hang on a block that isn't there and that nothing will put there (a ladder whose wall spot holds someone's block): left alone. */
  unsupported: { cell: T, support: Pos }[]
}

export interface SurveyOptions {
  canDig: boolean
  /** Blocks this bot placed itself (may be dug and replaced). */
  own?: (p: Pos) => boolean
  skipCovered?: boolean
  /** Planned cell positions (any stage), so the walls on top of the foundation don't count as covering it. */
  planned?: (p: Pos) => boolean
  /** Left out entirely (a reserved farm plot). */
  exclude?: (p: Pos) => boolean
  /** Attachments: a solid face to hang on is there now, or will be built. Without it, attachments aren't checked. */
  support?: { solidAt: (p: Pos) => boolean, willBuild: (p: Pos) => boolean }
}

/**
 * What a stage still needs at its spot. Pure. Uses the build's own cell check (a block the role
 * accepts counts, natural blocks and the bot's own may be dug, anything else is someone's build
 * and is left alone). With skipCovered a cell is left alone when the block above it is not
 * natural, not air and not planned (the old hut stands on the floor, a torch sits on it).
 */
export function surveyStage<T extends WorldCell> (cells: readonly T[], blockAt: (p: Pos) => string | undefined, roles: Record<string, ResolvedRole>, o: SurveyOptions): StageSurvey<T> {
  const out: StageSurvey<T> = { total: 0, done: [], todo: [], blocked: [], covered: [], unknown: [], unsupported: [] }
  for (const c of solidCells([...cells])) {
    if (o.exclude?.(c)) continue
    out.total++
    const here = blockAt(c)
    if (here === undefined) { out.unknown.push(c); continue }
    const r = roles[c.role]
    if (r && roleAccepts(r, here)) { out.done.push(c); continue }
    if (o.skipCovered) {
      const up = { x: c.x, y: c.y + 1, z: c.z }
      const above = blockAt(up)
      if (above && !isReplaceableName(above) && !isNaturalBlock(above) && !o.planned?.(up)) { out.covered.push(c); continue }
    }
    const d = diffCells([c], blockAt, roles, o.canDig, o.own)
    if (d.blocked.length) { out.blocked.push(c); continue }
    if (d.done.length) { out.done.push(c); continue }
    const sup = o.support && r ? supportOf(r.item, c.state, c) : null
    if (sup && o.support && !o.support.solidAt(sup) && !o.support.willBuild(sup)) { out.unsupported.push({ cell: c, support: sup }); continue }
    out.todo.push(c)
  }
  return out
}

/**
 * The block an attachment hangs on: behind a ladder or wall torch, below a standing torch or
 * lantern, above a hanging one. Null for blocks that need no particular neighbour. Pure.
 */
export function supportOf (item: string, state: BlockState | undefined, at: Pos): Pos | null {
  const f = familyOf(item, state)
  let d: Dir | null = null
  if (f === 'wall_mounted') d = state && isFacing(state.facing) ? opposite(state.facing) : null
  else if (f === 'torch') d = 'down'
  else if (f === 'lantern') d = state?.hanging === 'true' ? 'up' : 'down'
  if (!d) return null
  const v = DIR_VEC[d]
  return { x: at.x + v.x, y: at.y + v.y, z: at.z + v.z }
}

// ------------------------------------------------------------------ where the base is

export interface AnchorCandidate { origin: Pos, facing: Facing, source: string }
export interface Anchor extends AnchorCandidate { score: number }

/**
 * Fits the base blueprint to what is built: for each candidate (a place, a build in progress,
 * the settings) and one block up or down, `score` says what share of the walls is already
 * there (0..1). The best one at or above `min` wins; ties go to the earlier candidate. Pure.
 */
export function fitAnchor (candidates: readonly AnchorCandidate[], score: (origin: Pos, facing: Facing) => number, min = 0.3): Anchor | null {
  let best: Anchor | null = null
  for (const c of candidates) {
    for (const dy of [0, -1, 1]) {
      const origin = { x: c.origin.x, y: c.origin.y + dy, z: c.origin.z }
      const s = score(origin, c.facing)
      if (s >= min && (!best || s > best.score + 1e-9)) best = { ...c, origin, score: s }
    }
  }
  return best
}

// ------------------------------------------------------------------ inside the walls

export interface Column { x: number, z: number }
/** The floor level of the base (layer 0). */
export interface Interior { y: number, cols: Column[] }

/**
 * The inside of the base: floor columns (cells of `floorRoles` on the lowest layer) with nothing
 * planned on the two blocks above, so a chest or a farm there doesn't block a wall or a ladder. Pure.
 */
export function interiorOf (cells: readonly WorldCell[], floorRoles: readonly string[]): Interior | null {
  const solid = solidCells([...cells])
  if (!solid.length) return null
  const y = Math.min(...solid.map(c => c.y))
  const taken = new Set(solid.filter(c => c.y === y + 1 || c.y === y + 2).map(c => `${c.x},${c.z}`))
  const cols = solid.filter(c => c.y === y && floorRoles.includes(c.role) && !taken.has(`${c.x},${c.z}`)).map(c => ({ x: c.x, z: c.z }))
  return cols.length ? { y, cols } : null
}

export interface Fit { x: number, z: number, facing: Facing, cells: Column[] }

const SIDES: [Facing, number, number][] = [['south', 0, -1], ['north', 0, 1], ['east', -1, 0], ['west', 1, 0]]

/**
 * A spot for a row of `length` things against an inside wall, facing into the room. Pure. Every
 * column must be inside and `free`; the column behind each must be outside the interior (the
 * wall); nothing within `keepClear` of an `avoid` spot (the gate). Picks the spot whose row is
 * longest-backed and nearest `near`. The returned x/z is the centre a build of a 1-deep
 * blueprint `length` wide expects (placeCells centres on floor(width/2)).
 */
export function fitRow (interior: Interior, length: number, free: (c: Column) => boolean, o: { avoid?: Column[], keepClear?: number, near?: Column } = {}): Fit | null {
  const inside = new Set(interior.cols.map(c => `${c.x},${c.z}`))
  const isIn = (x: number, z: number) => inside.has(`${x},${z}`)
  const clear = o.keepClear ?? 2
  const ok = (c: Column) => isIn(c.x, c.z) && free(c) && !(o.avoid ?? []).some(a => Math.abs(a.x - c.x) + Math.abs(a.z - c.z) <= clear)
  let best: { fit: Fit, d: number } | null = null
  for (const start of interior.cols) {
    for (const [facing, bx, bz] of SIDES) {
      // the row runs along the wall: across the facing direction
      const [rx, rz] = bx === 0 ? [1, 0] : [0, 1]
      const cells: Column[] = []
      for (let i = 0; i < length; i++) cells.push({ x: start.x + rx * i, z: start.z + rz * i })
      if (!cells.every(c => ok(c) && !isIn(c.x + bx, c.z + bz))) continue
      // rotated blueprint: width along x for north/south, along z for east/west
      const half = Math.floor(length / 2)
      const centre = bx === 0 ? { x: start.x + half, z: start.z } : { x: start.x, z: start.z + half }
      const n = o.near ?? interior.cols[Math.floor(interior.cols.length / 2)]!
      const d = Math.hypot(centre.x - n.x, centre.z - n.z)
      if (!best || d < best.d) best = { fit: { ...centre, facing, cells }, d }
    }
  }
  return best?.fit ?? null
}

/**
 * The largest free square (up to `max`, at least `min`) inside, away from the walls by `margin`
 * and from `avoid`, for a farm plot. Pure. Returns its corner columns and size.
 */
export function fitSquare (interior: Interior, free: (c: Column) => boolean, o: { max?: number, min?: number, margin?: number, avoid?: Column[], keepClear?: number } = {}): { x0: number, z0: number, size: number } | null {
  const inside = new Set(interior.cols.map(c => `${c.x},${c.z}`))
  const margin = o.margin ?? 1
  const clear = o.keepClear ?? 2
  const good = (x: number, z: number) => {
    for (let dx = -margin; dx <= margin; dx++) for (let dz = -margin; dz <= margin; dz++) if (!inside.has(`${x + dx},${z + dz}`)) return false
    if ((o.avoid ?? []).some(a => Math.abs(a.x - x) + Math.abs(a.z - z) <= clear)) return false
    return free({ x, z })
  }
  for (let size = o.max ?? 5; size >= (o.min ?? 3); size--) {
    const starts = [...interior.cols].sort((a, b) => a.z - b.z || a.x - b.x)
    for (const s of starts) {
      let all = true
      for (let dx = 0; dx < size && all; dx++) for (let dz = 0; dz < size && all; dz++) if (!good(s.x + dx, s.z + dz)) all = false
      if (all) return { x0: s.x, z0: s.z, size }
    }
  }
  return null
}

// ------------------------------------------------------------------ materials

export interface BomRow {
  role: string
  item: string
  need: number
  carried: number
  stored: number
  /** Still to get after what it carries and what its chests hold. */
  missing: number
  optional: boolean
}

/** What the cells still to place need, what it carries and what its chests hold, per role. Pure. */
export function billOfMaterials (todo: readonly { role: string, passive?: boolean }[], roles: Record<string, ResolvedRole>, carried: Record<string, number>, stored: Record<string, number>): BomRow[] {
  const need = new Map<string, number>()
  for (const c of solidCells([...todo])) need.set(c.role, (need.get(c.role) ?? 0) + 1)
  return [...need].map(([role, n]) => {
    const r = roles[role]!
    const have = haveFor(r, carried)
    const inChests = haveFor(r, stored)
    return { role, item: r.item, need: n, carried: have, stored: inChests, missing: Math.max(0, n - have - inChests), optional: r.optional }
  })
}

/** One line per item (roles of the same item merged). */
export function fmtBom (rows: readonly BomRow[]): string {
  const by = new Map<string, BomRow>()
  for (const r of rows) {
    const m = by.get(r.item)
    if (!m) { by.set(r.item, { ...r }); continue }
    m.need += r.need
    m.carried = Math.max(m.carried, r.carried)
    m.stored = Math.max(m.stored, r.stored)
    m.missing = Math.max(0, m.need - m.carried - m.stored)
    m.optional = m.optional && r.optional
  }
  return [...by.values()].map(r => `${r.need} ${r.item}${r.optional ? ' (optional)' : ''} (carry ${r.carried}${r.stored ? `, chests ${r.stored}` : ''}${r.missing ? `, missing ${r.missing}` : ''})`).join(', ')
}

/** Items to take out of its chests for this session: what the role accepts, up to what is still short. Pure. */
export function chestTakes (rows: readonly BomRow[], roles: Record<string, ResolvedRole>, stored: Record<string, number>, carry: number): Record<string, number> {
  const out: Record<string, number> = {}
  let room = carry
  for (const row of rows) {
    let short = Math.max(0, row.need - row.carried)
    const r = roles[row.role]!
    for (const [item, n] of Object.entries(stored).sort((a, b) => b[1] - a[1])) {
      if (short <= 0 || room <= 0) break
      if (!roleAccepts(r, item) && !(r.strict ? item === r.item : r.accept.test(item))) continue
      const t = Math.min(n - (out[item] ?? 0), short, room)
      if (t <= 0) continue
      out[item] = (out[item] ?? 0) + t
      short -= t
      room -= t
    }
  }
  return out
}

/**
 * Scales a shopping list down to `carry` items in all (one session's worth; the rest waits for
 * the next one), keeping at least 1 of everything wanted. Pure.
 */
export function sessionWants (wants: Record<string, number>, carry: number): Record<string, number> {
  const total = Object.values(wants).reduce((a, b) => a + b, 0)
  if (total <= carry) return { ...wants }
  const k = carry / total
  return Object.fromEntries(Object.entries(wants).map(([item, n]) => [item, Math.max(1, Math.floor(n * k))]))
}

// ------------------------------------------------------------------ the project list

export type ProjectKind = 'stage' | 'light' | 'row' | 'plot' | 'secure'

export interface ProjectDef {
  name: string
  title: string
  kind: ProjectKind
  /** row: the blueprint built against a wall. */
  blueprint?: string
  after?: string[]
  /** Words in a goal or a chat line that name it. */
  words: string[]
}

/** The projects after the base blueprint's own stages, in working order. */
export const EXTRA_PROJECTS: readonly ProjectDef[] = [
  { name: 'integrity', title: 'no way in for mobs: caves, holes and mine entrances under and by the base sealed, capped or lit', kind: 'secure', words: ['integrity', 'base safety', 'caves', 'cave', 'holes', 'mob proof base', 'seal', 'seal the base'] },
  { name: 'farm_plot', title: 'a farm plot kept free inside the walls', kind: 'plot', after: ['walls'], words: ['farm plot', 'plot', 'farm inside'] },
  { name: 'lighting', title: 'torches so no mob spawns inside', kind: 'light', after: ['walls', 'floor'], words: ['lighting', 'lights', 'light', 'torches', 'torch', 'gate torches', 'mob proof', 'spawn proof'] },
  { name: 'storage', title: 'a row of chests', kind: 'row', blueprint: 'storage_row', after: ['floor'], words: ['storage', 'chests', 'chest', 'storage room'] },
  { name: 'workshop', title: 'crafting table and furnaces', kind: 'row', blueprint: 'workshop_row', after: ['floor'], words: ['workshop', 'furnace', 'furnaces', 'crafting area', 'smelting'] }
]

/** Words for the stages of the stock fortress (other blueprints: the stage name and title). */
export const STAGE_WORDS: Record<string, string[]> = {
  walls: ['walls', 'wall', 'gate', 'gate torches'],
  floor: ['floor', 'stone floor', 'cobblestone floor'],
  towers: ['towers', 'tower', 'corner towers', 'watchtower', 'watchtowers'],
  walkway: ['walkway', 'walk', 'battlements', 'rampart', 'ramparts']
}

/** Every project's words, for goalMentions and chat. */
export function projectWords (stages: readonly Stage[]): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const s of stages) out[s.name] = [...new Set([s.name, ...(STAGE_WORDS[s.name] ?? []), s.title.toLowerCase()])]
  for (const p of EXTRA_PROJECTS) out[p.name] = [p.name, p.name.replace(/_/g, ' '), ...p.words]
  return out
}

/** The project a word names ("towers", "chests", "the walkway"), or null. Pure. */
export function projectNamed (word: string, words: Record<string, readonly string[]>): string | null {
  const w = word.toLowerCase().replace(/^(the|our|my|your|a|an|some)\s+/, '').replace(/_/g, ' ').trim()
  if (words[w.replace(/\s+/g, '_')]) return w.replace(/\s+/g, '_')
  const hit = Object.entries(words).find(([, ws]) => ws.includes(w))
  return hit ? hit[0] : null
}

/** Is it day enough, fed and healthy enough, with no hostile close: the "safe needs" gate. Pure. */
export function safeToWork (o: { health: number, food: number, danger: number, survival: boolean }, s: { minHealth: number, minFood: number }): string | null {
  if (!o.survival) return null
  if (o.health < s.minHealth) return `health ${Math.round(o.health)} below ${s.minHealth}`
  if (o.food < s.minFood) return `food ${Math.round(o.food)} below ${s.minFood}`
  if (o.danger >= 0.3) return 'hostiles close'
  return null
}
