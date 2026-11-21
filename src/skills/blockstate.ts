// Block states and how to get them: which neighbour to click, on which face, where on the
// face (the cursor), and which way the bot must look so the server gives the placed block the
// facing, half, axis or hinge a blueprint asks for. Then: did it work, and what to do if not.
// All pure, so the vanilla placement rules below are unit tested; placement.ts drives the bot.
//
// Vanilla 1.21 placement rules this follows (server side, BlockItem#getPlacementState):
//   stairs     facing = player's horizontal look; half = top when clicking a block's bottom face,
//              or a side face above its middle (cursor y > 0.5); shape follows the neighbours
//   slab       type = top when clicking a bottom face or a side above the middle
//   log/pillar axis = axis of the clicked face
//   door       facing = horizontal look; hinge from the neighbours, or (between two equal
//              sides, e.g. in a wall) from the cursor x/z on the face below
//   trapdoor   side face: facing = that face, half from cursor y; top/bottom face: facing =
//              opposite of the look, half bottom/top. Opened afterwards by using it.
//   wall torch, ladder: facing = opposite of the first horizontal look direction whose wall
//              holds it, so look straight at the wall (pitch 0)
//   torch      standing when the look is mostly down; lantern hangs when looking up
//   bed        facing = horizontal look; the head goes one block that way
//   chest, furnace, smoker, barrel...: facing = opposite of the look (they face the player)
//   fence gate facing = horizontal look

export type Facing = 'north' | 'east' | 'south' | 'west'
export const FACINGS: Facing[] = ['north', 'east', 'south', 'west']
export type Dir = 'down' | 'up' | Facing
export const DIRS: Dir[] = ['down', 'up', 'north', 'south', 'west', 'east']

export const DIR_VEC: Record<Dir, { x: number, y: number, z: number }> = {
  down: { x: 0, y: -1, z: 0 },
  up: { x: 0, y: 1, z: 0 },
  north: { x: 0, y: 0, z: -1 },
  south: { x: 0, y: 0, z: 1 },
  west: { x: -1, y: 0, z: 0 },
  east: { x: 1, y: 0, z: 0 }
}

const OPPOSITE: Record<Dir, Dir> = { down: 'up', up: 'down', north: 'south', south: 'north', west: 'east', east: 'west' }
export const opposite = <T extends Dir>(d: T): T => OPPOSITE[d] as T

/** Desired block-state properties, Minecraft names and values: { facing: 'north', half: 'top' }. */
export type BlockState = Record<string, string>

export function isFacing (v: unknown): v is Facing {
  return v === 'north' || v === 'east' || v === 'south' || v === 'west'
}

/** A horizontal direction turned clockwise (seen from above) `turns` quarter turns. */
export function turnFacing (f: Facing, turns: number): Facing {
  return FACINGS[(FACINGS.indexOf(f) + ((turns % 4) + 4)) % 4]!
}

/** A state turned with its blueprint: facings rotate, x/z axes swap on odd turns. */
export function rotateState (state: BlockState | undefined, turns: number): BlockState | undefined {
  if (!state) return state
  const t = ((turns % 4) + 4) % 4
  if (!t) return state
  const out: BlockState = { ...state }
  if (isFacing(out.facing)) out.facing = turnFacing(out.facing, t)
  if (t % 2 === 1 && (out.axis === 'x' || out.axis === 'z')) out.axis = out.axis === 'x' ? 'z' : 'x'
  return out
}

/** Arrow shorthand in layers: the side a stair climbs towards (north is up in the drawing). */
export const ARROWS: Record<string, Facing> = { '^': 'north', v: 'south', '<': 'west', '>': 'east' }

/**
 * Parses "roof[facing=north,half=top]" into a role and a state ("roof" alone has no state).
 * Returns null for malformed text.
 */
export function parseStateString (text: string): { role: string, state?: BlockState } | null {
  const m = /^\s*([a-z0-9_:]+)\s*(?:\[([^\]]*)\])?\s*$/.exec(text)
  if (!m) return null
  if (m[2] === undefined) return { role: m[1]! }
  const state: BlockState = {}
  for (const part of m[2].split(',').map(s => s.trim()).filter(Boolean)) {
    const kv = /^([a-z_]+)\s*=\s*([a-z0-9_]+)$/.exec(part)
    if (!kv) return null
    state[kv[1]!] = kv[2]!
  }
  return { role: m[1]!, state }
}

// ------------------------------------------------------------------ block families

export type Family =
  | 'plain' | 'stairs' | 'slab' | 'pillar' | 'door' | 'trapdoor' | 'wall_mounted' | 'torch' | 'lantern'
  | 'bed' | 'look' | 'look_opposite'

const bare = (name: string) => name.replace(/^[a-z0-9_]+:/, '')

/** How a block's state is decided when it is placed, from its name. */
export function familyOf (name: string, state?: BlockState): Family {
  const n = bare(name)
  if (/_stairs$/.test(n)) return 'stairs'
  if (/_slab$/.test(n)) return 'slab'
  if (/_trapdoor$/.test(n)) return 'trapdoor'
  if (/_door$/.test(n)) return 'door'
  if (/_bed$/.test(n)) return 'bed'
  if (n === 'ladder' || /wall_torch$/.test(n)) return 'wall_mounted'
  if (/^(soul_|redstone_)?torch$/.test(n)) return state && isFacing(state.facing) ? 'wall_mounted' : 'torch'
  if (/lantern$/.test(n) && n !== 'jack_o_lantern') return 'lantern'
  if (/_fence_gate$/.test(n)) return 'look'
  if (/^(chest|trapped_chest|ender_chest|furnace|smoker|blast_furnace|barrel|carved_pumpkin|jack_o_lantern|stonecutter|loom|beehive|bee_nest|lectern|observer)$/.test(n)) return 'look_opposite'
  if (/(_log|_wood|_stem|_hyphae)$/.test(n) || /^(hay_block|bone_block|basalt|polished_basalt|quartz_pillar|purpur_pillar|bamboo_block|stripped_bamboo_block|muddy_mangrove_roots|deepslate|chain)$/.test(n)) return 'pillar'
  return 'plain'
}

/** The block a placed item turns into for a state (a torch on a wall is a wall_torch). */
export function blockNameFor (item: string, state?: BlockState): string {
  const n = bare(item)
  if (state && isFacing(state.facing) && /^(soul_|redstone_)?torch$/.test(n)) return n.replace(/torch$/, 'wall_torch')
  return n
}

/** Mineflayer yaw for looking along a horizontal direction (0 = north, counter-clockwise positive). */
export function yawFor (f: Facing): number {
  return { north: 0, west: Math.PI / 2, south: Math.PI, east: -Math.PI / 2 }[f]
}

/** Horizontal direction a mineflayer yaw looks along (what the server reads as the player's facing). */
export function facingOfYaw (yaw: number): Facing {
  // mineflayer yaw -> notchian degrees: 180 - deg(yaw); notchian 0 = south, 90 = west, 180 = north, 270 = east
  const deg = 180 - (yaw * 180) / Math.PI
  const i = ((Math.floor(deg / 90 + 0.5) % 4) + 4) % 4
  return (['south', 'west', 'north', 'east'] as Facing[])[i]!
}

// ------------------------------------------------------------------ the placement planner

/** What placement can see around the target cell. */
export interface PlaceEnv {
  /** The neighbour in this direction is a solid block we may click (full, not interactive). */
  solid (d: Dir): boolean
  /** Name of the neighbour in this direction (to avoid merging a slab into a double slab). */
  name? (d: Dir): string | undefined
  /** The neighbour cell is free (air or replaceable): needed above a door, and for a bed's head. */
  free? (d: Dir): boolean
}

export interface Cursor { x: number, y: number, z: number }

/** One way to place a block: click `ref` (a neighbour of the target) on `face`, at `cursor`, looking at yaw/pitch. */
export interface PlacementOption {
  /** Direction from the target cell to the block we click. */
  ref: Dir
  /** Face of the reference block we click (points from the reference to the target). */
  face: Dir
  /** Click position on the reference block, 0..1 on each axis. */
  cursor: Cursor
  /** Look direction to send before clicking; undefined = just look at the click point. */
  yaw?: number
  pitch?: number
  /** Use the block once after placing (open a trapdoor or door). */
  activate?: boolean
  /** Short description for logs: "below, up face, yaw south". */
  why: string
}

const LOOK_DOWN = -Math.PI / 2
const LOOK_UP = Math.PI / 2
const LEVEL = 0
/** Natural slightly-down look for yaw-only placements (the pitch doesn't change the result). */
const GLANCE = -0.5

/** The click point on a reference block's face: the face centre, with y nudged for halves. */
export function faceCursor (face: Dir, yNudge?: 'top' | 'bottom'): Cursor {
  const v = DIR_VEC[face]
  const c = { x: 0.5 + v.x * 0.5, y: 0.5 + v.y * 0.5, z: 0.5 + v.z * 0.5 }
  if (v.y === 0 && yNudge) c.y = yNudge === 'top' ? 0.75 : 0.25
  return c
}

/**
 * Cursor x/z (on the top face of the block below a door) that gives the wanted hinge when the
 * neighbours don't decide it. Mirrors DoorBlock#getHinge: facing north, left hinge needs x <= 0.5.
 */
export function doorHingeCursor (facing: Facing, hinge: 'left' | 'right'): { x: number, z: number } {
  const lo = 0.25
  const hi = 0.75
  const left = hinge === 'left'
  switch (facing) {
    case 'north': return { x: left ? lo : hi, z: 0.5 }
    case 'south': return { x: left ? hi : lo, z: 0.5 }
    case 'east': return { x: 0.5, z: left ? lo : hi }
    case 'west': return { x: 0.5, z: left ? hi : lo }
  }
}

/** The hinge the server picks from a cursor when the neighbours are even (the same rule, for tests). */
export function hingeFromCursor (facing: Facing, cx: number, cz: number): 'left' | 'right' {
  const v = DIR_VEC[facing]
  const left = (v.x >= 0 || !(cz < 0.5)) && (v.x <= 0 || !(cz > 0.5)) && (v.z >= 0 || !(cx > 0.5)) && (v.z <= 0 || !(cx < 0.5))
  return left ? 'left' : 'right'
}

/** Neighbours to try, nicest first: below, the four sides, above. */
const ORDER: Dir[] = ['down', 'north', 'south', 'west', 'east', 'up']

function option (ref: Dir, extra: Partial<PlacementOption> & { why?: string } = {}, nudge?: 'top' | 'bottom'): PlacementOption {
  const face = opposite(ref)
  return { ref, face, cursor: faceCursor(face, nudge), ...extra, why: `${ref === 'down' ? 'below' : ref === 'up' ? 'above' : ref}${extra.why ? `, ${extra.why}` : ''}` }
}

/**
 * Every way to place `item` at a cell so it ends up in `state`, best first, given which
 * neighbours can be clicked. Empty when nothing works yet (e.g. a log along x with no
 * neighbour on that axis, or a wall torch with no wall): the caller tries again later.
 */
export function planPlacement (item: string, state: BlockState | undefined, env: PlaceEnv): PlacementOption[] {
  const s = state ?? {}
  const fam = familyOf(item, s)
  const out: PlacementOption[] = []
  const solid = (d: Dir) => env.solid(d)
  const facing = isFacing(s.facing) ? s.facing : undefined
  const look = facing ? { yaw: yawFor(facing), pitch: GLANCE } : {}
  const lookWhy = facing ? `look ${facing}` : undefined

  switch (fam) {
    case 'stairs': {
      const top = s.half === 'top'
      for (const d of ORDER) {
        if (!solid(d)) continue
        if (d === 'down' && top) continue
        if (d === 'up' && !top) continue
        out.push(option(d, { ...look, why: lookWhy }, d === 'down' || d === 'up' ? undefined : top ? 'top' : 'bottom'))
      }
      return out
    }
    case 'slab': {
      const top = s.type === 'top'
      if (s.type === 'double') return ORDER.filter(solid).map(d => option(d)) // second half is a second click, not handled
      for (const d of ORDER) {
        if (!solid(d)) continue
        if (d === 'down' && top) continue
        if (d === 'up' && !top) continue
        // clicking the top of a bottom slab (or the bottom of a top slab) of the same kind merges them
        if ((d === 'down' || d === 'up') && env.name?.(d) === bare(item)) continue
        out.push(option(d, {}, d === 'down' || d === 'up' ? undefined : top ? 'top' : 'bottom'))
      }
      return out
    }
    case 'pillar': {
      const axis = s.axis ?? 'y'
      const along: Dir[] = axis === 'x' ? ['west', 'east'] : axis === 'z' ? ['north', 'south'] : ['down', 'up']
      for (const d of along) if (solid(d)) out.push(option(d, { why: `axis ${axis}` }))
      return out
    }
    case 'door': {
      if (!solid('down')) return out
      if (env.free && !env.free('up')) return out
      const f = facing ?? 'north'
      const hinge = s.hinge === 'right' ? 'right' : 'left'
      const c = doorHingeCursor(f, hinge)
      out.push({ ref: 'down', face: 'up', cursor: { x: c.x, y: 1, z: c.z }, yaw: yawFor(f), pitch: GLANCE, activate: s.open === 'true', why: `below, look ${f}, hinge ${hinge}` })
      return out
    }
    case 'trapdoor': {
      const f = facing ?? 'north'
      const top = s.half === 'top'
      const activate = s.open === 'true'
      // clicking a side face: facing = that face, half from the cursor height
      const back = opposite(f)
      if (solid(back)) out.push(option(back, { activate, why: `hinged on ${back}` }, top ? 'top' : 'bottom'))
      // clicking the block below/above: facing = opposite of where we look
      const vertical: Dir = top ? 'up' : 'down'
      if (solid(vertical)) out.push(option(vertical, { yaw: yawFor(opposite(f)), pitch: GLANCE, activate, why: `look ${opposite(f)}` }))
      return out
    }
    case 'wall_mounted': {
      if (!facing) return out
      const wall = opposite(facing)
      if (solid(wall)) out.push(option(wall, { yaw: yawFor(wall), pitch: LEVEL, why: `on the ${wall} wall, look ${wall}` }))
      return out
    }
    case 'torch': {
      if (solid('down')) out.push(option('down', { pitch: LOOK_DOWN, yaw: undefined, why: 'look down' }))
      return out
    }
    case 'lantern': {
      if (s.hanging === 'true') {
        if (solid('up')) out.push(option('up', { pitch: LOOK_UP, why: 'hanging, look up' }))
      } else if (solid('down')) {
        out.push(option('down', { pitch: LOOK_DOWN, why: 'look down' }))
      }
      return out
    }
    case 'bed': {
      const f = facing ?? 'north'
      if (!solid('down')) return out
      if (env.free && !env.free(f)) return out
      out.push(option('down', { yaw: yawFor(f), pitch: GLANCE, why: `look ${f}` }))
      return out
    }
    case 'look':
    case 'look_opposite': {
      const yaw = facing ? yawFor(fam === 'look' ? facing : opposite(facing)) : undefined
      for (const d of ORDER) if (solid(d)) out.push(option(d, yaw === undefined ? {} : { yaw, pitch: LEVEL, why: `look ${facingOfYaw(yaw)}` }))
      return out
    }
    default:
      for (const d of ORDER) if (solid(d)) out.push(option(d))
      return out
  }
}

// ------------------------------------------------------------------ verification

/** Properties that follow from the neighbours or are cosmetic: a mismatch is reported, not fixed. */
const SOFT = new Set(['shape', 'hinge'])
/** Properties never compared (they change on their own). */
const IGNORED = new Set(['waterlogged', 'powered', 'occupied', 'in_wall', 'lit', 'distance', 'persistent', 'snowy', 'type_chest'])

export type CheckStatus = 'ok' | 'missing' | 'wrong_block' | 'wrong_state' | 'soft'

export interface CellCheck {
  status: CheckStatus
  /** Properties that are wrong and matter (facing, half, axis...). */
  hard: string[]
  /** Properties that are wrong but follow from neighbours (stair shape, door hinge). */
  soft: string[]
}

/**
 * Compares the block in the world with what the plan wants. Only the properties the plan names
 * are compared, and only those the block has (a glass pane standing in for a trapdoor has no
 * facing). `accepts` says whether the block name is right for the cell's role.
 */
export function checkCell (accepts: (name: string) => boolean, want: BlockState | undefined, actual: string | undefined, props: Record<string, unknown> | undefined, replaceable: (name: string) => boolean): CellCheck {
  const name = actual ?? 'air'
  if (replaceable(name)) return { status: 'missing', hard: [], soft: [] }
  if (!accepts(name)) return { status: 'wrong_block', hard: [], soft: [] }
  const hard: string[] = []
  const soft: string[] = []
  for (const [k, v] of Object.entries(want ?? {})) {
    if (IGNORED.has(k) || k === 'part') continue
    if (!props || !(k in props)) continue
    if (String(props[k]) === v) continue
    // stairs report straight/inner/outer shapes; "inner"/"outer" asks for either side
    if (k === 'shape' && (v === 'inner' || v === 'outer') && String(props[k]).startsWith(v)) continue
    ;(SOFT.has(k) ? soft : hard).push(k)
  }
  if (hard.length) return { status: 'wrong_state', hard, soft }
  if (soft.length) return { status: 'soft', hard, soft }
  return { status: 'ok', hard, soft }
}

export type FixAction = 'none' | 'place' | 'toggle' | 'replace' | 'report'

/**
 * What the quality pass does about one cell: place what's missing, use (toggle) a door or
 * trapdoor that is only open/closed wrong, break and re-place a block with a wrong facing, half
 * or axis, and leave everything else alone (soft mismatches, foreign blocks, nothing to dig with).
 */
export function fixFor (check: CellCheck, family: Family, canDig: boolean): FixAction {
  switch (check.status) {
    case 'ok':
    case 'soft':
      return 'none'
    case 'missing':
      return 'place'
    case 'wrong_block':
      return 'report'
    case 'wrong_state':
      if (check.hard.length === 1 && check.hard[0] === 'open' && (family === 'door' || family === 'trapdoor' || family === 'look')) return 'toggle'
      return canDig ? 'replace' : 'report'
  }
}

export interface QualityRow { role: string, label: string, optional: boolean, check: CellCheck }

export interface QualitySummary {
  /** Cells that are right (ok or soft). */
  built: number
  total: number
  /** Required cells still missing or wrong. */
  missingRequired: number
  /** Cells right in block but with a cosmetic difference (shape, hinge). */
  soft: number
  /** Cells with the right block in a wrong facing/half/axis. */
  wrongState: number
  /** Optional roles that are absent, with counts: { bed: 1, window: 4 }. */
  skipped: Record<string, number>
}

/** Counts for the final report: "built 182/186, skipped: bed (no wool)". */
export function summarize (rows: QualityRow[]): QualitySummary {
  const s: QualitySummary = { built: 0, total: rows.length, missingRequired: 0, soft: 0, wrongState: 0, skipped: {} }
  for (const r of rows) {
    const st = r.check.status
    if (st === 'ok' || st === 'soft') { s.built++; if (st === 'soft') s.soft++; continue }
    if (st === 'wrong_state') s.wrongState++
    if (r.optional && st === 'missing') s.skipped[r.label] = (s.skipped[r.label] ?? 0) + 1
    else if (!r.optional) s.missingRequired++
  }
  return s
}

/** Errors that mean "couldn't get there" rather than "couldn't place it". */
export const UNREACHABLE = /no path|took (too|to) long|can't get within reach|couldn't reach|not within reach|stuck/i

/**
 * Whether a build with a few required blocks missing still counts as done: every missing block
 * failed for reach (path timeouts, nowhere to stand) after its retry, nothing ran out, and they
 * are a handful (at most 3, or 3% of the structure). Calling build again would just fail the same way.
 */
export function finishDespiteUnreachable (missing: string[], unreachable: Set<string>, total: number, ranOut: boolean): boolean {
  if (!missing.length || ranOut) return false
  if (missing.length > Math.max(3, Math.ceil(total * 0.03))) return false
  return missing.every(k => unreachable.has(k))
}

/** Why an optional item is usually missing, for the report. */
export function skipReason (item: string): string {
  if (/_bed$|carpet$/.test(item)) return 'no wool'
  if (/glass/.test(item)) return 'no glass'
  if (/torch$|lantern$/.test(item)) return 'no coal'
  if (/furnace$/.test(item)) return 'no cobblestone'
  return 'none in inventory'
}

// ------------------------------------------------------------------ where to stand

export interface StandCandidate {
  x: number, y: number, z: number
  /** No open side at feet and head level: a pocket (under a floor, in a cave) the pathfinder can only reach by digging. */
  sealed?: boolean
}

/** What else the stand ranking weighs, besides reach and the bot's distance. */
export interface StandRankOptions {
  /** The cell being placed (its level counts, not the clicked block's). Default: the clicked block. */
  target?: { x: number, y: number, z: number }
  /** Spots that already failed in this build ("x,y,z"): never tried again. */
  failed?: Set<string>
  /** Cells of the structure still to be built: standing in one works, but it's in the way later. */
  unbuilt?: (p: { x: number, y: number, z: number }) => boolean
}

/** The two things stand-spot search reads about a block. */
export interface StandBlock { name: string, boundingBox: string }

/**
 * Spots a bot can stand on around `target` (feet positions): a full block below (not a fence,
 * wall or bed), two passable blocks for the body, no liquid, fire or door. `inside` excludes
 * spots in other structures (a hut standing in the footprint: its inside is only reachable
 * through its door, if at all). Each spot says whether it is sealed (no open side).
 */
export function standCandidatesIn (at: (p: { x: number, y: number, z: number }) => StandBlock | null | undefined, target: { x: number, y: number, z: number }, opts: { radius?: number, inside?: (p: { x: number, y: number, z: number }) => boolean } = {}): StandCandidate[] {
  const radius = opts.radius ?? 4
  const P = (x: number, y: number, z: number) => ({ x, y, z })
  const passable = (x: number, y: number, z: number) => {
    const b = at(P(x, y, z))
    return !!b && b.boundingBox === 'empty' && b.name !== 'water' && b.name !== 'lava' && !/door|fire/.test(b.name)
  }
  const floor = (x: number, y: number, z: number) => {
    const b = at(P(x, y, z))
    return !!b && b.boundingBox === 'block' && !/fence|wall|_bed$/.test(b.name)
  }
  const out: StandCandidate[] = []
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dy = -5; dy <= 2; dy++) {
        const x = target.x + dx
        const y = target.y + dy
        const z = target.z + dz
        if (!floor(x, y - 1, z) || !passable(x, y, z) || !passable(x, y + 1, z)) continue
        if (opts.inside?.(P(x, y, z))) continue
        // open: some side to walk to at the same level, or a step up/down onto
        const open = ([[1, 0], [-1, 0], [0, 1], [0, -1]] as const).some(([sx, sz]) =>
          (passable(x + sx, y, z + sz) && passable(x + sx, y + 1, z + sz)) ||
          (passable(x + sx, y + 1, z + sz) && passable(x + sx, y + 2, z + sz) && passable(x, y + 2, z)))
        out.push(open ? P(x, y, z) : { ...P(x, y, z), sealed: true })
      }
    }
  }
  return out
}

/**
 * Is `p` inside a structure that isn't part of the plan: a solid block that isn't natural and
 * isn't one of the plan's cells within a few blocks overhead (a roof). Spots under our own
 * roof-in-progress stay allowed; the inside of a player's hut doesn't.
 */
export function underForeignRoof (at: (p: { x: number, y: number, z: number }) => StandBlock | null | undefined, p: { x: number, y: number, z: number }, isPlanCell: (p: { x: number, y: number, z: number }) => boolean, isNatural: (name: string) => boolean, height = 5): boolean {
  for (let dy = 2; dy <= height; dy++) {
    const q = { x: p.x, y: p.y + dy, z: p.z }
    const b = at(q)
    if (!b || b.boundingBox !== 'block') continue
    if (isPlanCell(q) || isNatural(b.name) || /leaves/.test(b.name)) return false
    return true
  }
  return false
}

/** Key of a stand spot in a failed-spot cache. */
export const standKey = (p: { x: number, y: number, z: number }) => `${p.x},${p.y},${p.z}`

/**
 * Cost of standing at `c` (lower is better): the distance from the bot (height counts more,
 * since climbing or dropping is where paths go wrong), plus penalties for standing below the
 * target's level, in a sealed pocket, or inside a cell still to be built.
 */
export function standCost (c: StandCandidate, target: { x: number, y: number, z: number }, bot: { x: number, y: number, z: number }, unbuilt?: StandRankOptions['unbuilt']): number {
  let d = Math.hypot(c.x + 0.5 - bot.x, (c.y - bot.y) * 1.5, c.z + 0.5 - bot.z)
  const below = target.y - c.y
  if (below > 0) d += below * 1.5
  if (c.sealed) d += 6
  if (unbuilt && (unbuilt(c) || unbuilt({ x: c.x, y: c.y + 1, z: c.z }))) d += 4
  return d
}

export function distToBlock (p: { x: number, y: number, z: number }, b: { x: number, y: number, z: number }): number {
  const dx = Math.max(b.x - p.x, 0, p.x - (b.x + 1))
  const dy = Math.max(b.y - p.y, 0, p.y - (b.y + 1))
  const dz = Math.max(b.z - p.z, 0, p.z - (b.z + 1))
  return Math.hypot(dx, dy, dz)
}

export const EYE = 1.62

/**
 * Picks spots (feet positions) to place from: the clicked block within `reach` of the eyes,
 * not inside the cells the block will fill, not a spot that already failed; cheapest first
 * (see standCost: near the bot, at or above the target's level, open, out of the way).
 */
export function rankStands (cands: StandCandidate[], refBlock: { x: number, y: number, z: number }, occupied: { x: number, y: number, z: number }[], bot: { x: number, y: number, z: number }, reach = 4.4, opts: StandRankOptions = {}): StandCandidate[] {
  const blocked = (c: StandCandidate) => occupied.some(o => o.x === c.x && o.z === c.z && (o.y === c.y || o.y === c.y + 1))
  const target = opts.target ?? refBlock
  return cands
    .filter(c => !blocked(c) && !opts.failed?.has(standKey(c)) && distToBlock({ x: c.x + 0.5, y: c.y + EYE, z: c.z + 0.5 }, refBlock) <= reach)
    .map(c => ({ c, d: standCost(c, target, bot, opts.unbuilt) }))
    .sort((a, b) => a.d - b.d)
    .map(x => x.c)
}
