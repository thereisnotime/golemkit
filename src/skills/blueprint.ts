// Blueprints: structures as data (blueprints/*.yaml), plus the pure planning the build action
// uses: parsing and validation, rotation, material accounting, placement order, resume
// (which blocks are already right) and site choice. Nothing here touches the bot, so it is
// all unit tested; construction.ts does the walking and placing.
//
//   name: hut
//   description: Small one-room house
//   facing: south                 # the side the entrance is on, as the layers are drawn
//   roles:                        # what each kind of block is made of
//     wall: { default: oak_planks, accept: "_planks$", material: true }
//     door: { default: oak_door, accept: "_door$", kind: door }
//   palette: { "#": wall, D: door, ".": air }   # " " = don't care
//   layers:                       # bottom to top; rows north to south, columns west to east
//     - ["#####", ...]
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import { z } from 'zod'

export type Facing = 'north' | 'east' | 'south' | 'west'
export const FACINGS: Facing[] = ['north', 'east', 'south', 'west']

const RoleSchema = z.object({
  default: z.string().min(1).describe('block placed when the inventory has nothing better that fits'),
  accept: z.string().optional().describe('regex of item/block names that count as this role (default: only the default)'),
  kind: z.enum(['block', 'door', 'attachment']).default('block').describe('door and attachment go in last'),
  optional: z.boolean().default(false).describe('skipped (with a note) when the bot has none'),
  material: z.boolean().default(false).describe('the build action\'s `material` parameter replaces this role')
})

const LayerSchema = z.union([z.string(), z.array(z.string())])

export const BlueprintSchema = z.object({
  name: z.string().regex(/^[a-z0-9_]+$/, 'lowercase letters, digits and _'),
  description: z.string().min(1),
  facing: z.enum(['north', 'east', 'south', 'west']).default('south'),
  site: z.enum(['near', 'here']).default('near').describe('near: find a flat spot near the player; here: around the bot\'s feet (emergency shelter)'),
  roles: z.record(z.string(), RoleSchema),
  palette: z.record(z.string(), z.string()),
  layers: z.array(LayerSchema).min(1)
})

export type BlueprintFile = z.infer<typeof BlueprintSchema>
export type Role = z.infer<typeof RoleSchema>

/** One cell of a structure. `role` is a role name or "air" (must be clear). Coordinates are local. */
export interface Cell { x: number, y: number, z: number, role: string }

export interface Blueprint {
  name: string
  description: string
  facing: Facing
  site: 'near' | 'here'
  roles: Record<string, Role>
  /** Size along x (west-east), z (north-south) and y. */
  width: number
  depth: number
  height: number
  cells: Cell[]
}

const rows = (l: string | string[]) => (Array.isArray(l) ? l : l.replace(/^\n+|\n+$/g, '').split('\n'))

/** Parses and validates a blueprint. Throws an Error that says what is wrong. */
export function parseBlueprint (text: string | unknown, source = 'blueprint'): Blueprint {
  const raw = typeof text === 'string' ? YAML.parse(text) : text
  const r = BlueprintSchema.safeParse(raw)
  if (!r.success) throw new Error(`${source}: ${z.prettifyError(r.error).replace(/\n/g, '; ')}`)
  const f = r.data
  const problems: string[] = []
  for (const [ch, v] of Object.entries(f.palette)) {
    if ([...ch].length !== 1) problems.push(`palette key "${ch}" must be one character`)
    if (ch === ' ') problems.push('" " is reserved for "don\'t care"')
    if (v !== 'air' && v !== 'skip' && !f.roles[v]) problems.push(`palette "${ch}" uses unknown role "${v}"`)
  }
  for (const [name, role] of Object.entries(f.roles)) {
    if (role.accept) { try { new RegExp(role.accept) } catch { problems.push(`role ${name}: bad accept regex`) } }
  }
  const layers = f.layers.map(rows)
  const depth = layers[0]!.length
  const width = Math.max(...layers.flat().map(s => s.length))
  const cells: Cell[] = []
  layers.forEach((layer, y) => {
    if (layer.length !== depth) problems.push(`layer ${y} has ${layer.length} rows, layer 0 has ${depth}`)
    layer.forEach((row, z) => {
      if (row.length > width) problems.push(`layer ${y} row ${z} is too long`)
      ;[...row].forEach((ch, x) => {
        if (ch === ' ') return
        const v = f.palette[ch]
        if (v === undefined) { problems.push(`layer ${y} row ${z}: "${ch}" is not in the palette`); return }
        if (v !== 'skip') cells.push({ x, y, z, role: v })
      })
    })
  })
  if (!cells.some(c => c.role !== 'air')) problems.push('no blocks to place')
  if (problems.length) throw new Error(`${source}: ${[...new Set(problems)].slice(0, 6).join('; ')}`)
  return { name: f.name, description: f.description, facing: f.facing, site: f.site, roles: f.roles, width, depth, height: layers.length, cells }
}

export const BLUEPRINTS_DIR = fileURLToPath(new URL('../../blueprints/', import.meta.url))

/** Loads every blueprints/*.yaml. Broken files are reported in `errors`, not thrown. */
export function loadBlueprints (dir = BLUEPRINTS_DIR): { blueprints: Map<string, Blueprint>, errors: string[] } {
  const blueprints = new Map<string, Blueprint>()
  const errors: string[] = []
  if (!existsSync(dir)) return { blueprints, errors: [`no blueprints directory at ${dir}`] }
  for (const f of readdirSync(dir).filter(f => /\.ya?ml$/.test(f)).sort()) {
    try {
      const bp = parseBlueprint(readFileSync(join(dir, f), 'utf8'), f)
      blueprints.set(bp.name, bp)
    } catch (e) {
      errors.push((e as Error).message)
    }
  }
  return { blueprints, errors }
}

// ------------------------------------------------------------------ rotation & placement

/** Turns a blueprint so its entrance faces `facing` (quarter turns clockwise seen from above). */
export function rotate (bp: Blueprint, facing: Facing): Blueprint {
  const turns = (FACINGS.indexOf(facing) - FACINGS.indexOf(bp.facing) + 4) % 4
  let out = bp
  for (let i = 0; i < turns; i++) {
    const d = out.depth
    out = { ...out, width: out.depth, depth: out.width, cells: out.cells.map(c => ({ ...c, x: d - 1 - c.z, z: c.x })) }
  }
  return { ...out, facing }
}

export interface Pos { x: number, y: number, z: number }
export interface WorldCell extends Pos { role: string, local: Cell }

/** World positions: the footprint is centred on origin x/z; origin.y is the level of layer 0. */
export function placeCells (bp: Blueprint, origin: Pos): WorldCell[] {
  const ox = Math.floor(origin.x) - Math.floor(bp.width / 2)
  const oz = Math.floor(origin.z) - Math.floor(bp.depth / 2)
  return bp.cells.map(c => ({ x: ox + c.x, y: Math.floor(origin.y) + c.y, z: oz + c.z, role: c.role, local: c }))
}

/** Bounding box of a placed structure (inclusive). */
export function bounds (bp: Blueprint, origin: Pos): { min: Pos, max: Pos } {
  const ox = Math.floor(origin.x) - Math.floor(bp.width / 2)
  const oz = Math.floor(origin.z) - Math.floor(bp.depth / 2)
  const y = Math.floor(origin.y)
  return { min: { x: ox, y, z: oz }, max: { x: ox + bp.width - 1, y: y + bp.height - 1, z: oz + bp.depth - 1 } }
}

/** Direction from a point to another, rounded to the dominant axis (which way a door should face). */
export function facingToward (from: { x: number, z: number }, to: { x: number, z: number }): Facing {
  const dx = to.x - from.x
  const dz = to.z - from.z
  if (Math.abs(dx) > Math.abs(dz)) return dx > 0 ? 'east' : 'west'
  return dz > 0 ? 'south' : 'north'
}

// ------------------------------------------------------------------ materials

export interface ResolvedRole {
  role: string
  /** Item placed (preferred; other accepted items are used when it runs out unless strict). */
  item: string
  accept: RegExp
  kind: Role['kind']
  optional: boolean
  /** Only `item` counts (the player named the material). */
  strict: boolean
}

function acceptRe (role: Role): RegExp {
  return new RegExp(role.accept ?? `^${role.default.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
}

/**
 * Picks the item for each role: the `material` the player asked for (material roles), else
 * the accepted item the inventory has most of, else the role's default.
 */
export function resolveRoles (bp: Blueprint, inventory: Record<string, number>, material?: string): Record<string, ResolvedRole> {
  const out: Record<string, ResolvedRole> = {}
  for (const [name, role] of Object.entries(bp.roles)) {
    const accept = acceptRe(role)
    if (role.material && material) {
      out[name] = { role: name, item: material, accept: new RegExp(`^${material.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), kind: role.kind, optional: role.optional, strict: true }
      continue
    }
    const owned = Object.entries(inventory).filter(([k, n]) => n > 0 && accept.test(k)).sort((a, b) => b[1] - a[1])
    out[name] = { role: name, item: owned[0]?.[0] ?? role.default, accept, kind: role.kind, optional: role.optional, strict: false }
  }
  return out
}

/** How many of each role's item an inventory holds (any accepted item unless strict). */
export function haveFor (r: ResolvedRole, inventory: Record<string, number>): number {
  if (r.strict) return inventory[r.item] ?? 0
  return Object.entries(inventory).reduce((n, [k, v]) => n + (r.accept.test(k) ? v : 0), 0)
}

export interface MaterialRow {
  role: string
  item: string
  /** Human label: "oak_planks (or any _planks)". */
  label: string
  need: number
  have: number
  missing: number
  optional: boolean
}

/** Material needs of a set of cells vs what the inventory holds. */
export function materials (cells: { role: string }[], roles: Record<string, ResolvedRole>, inventory: Record<string, number>): MaterialRow[] {
  const need = new Map<string, number>()
  for (const c of cells) if (c.role !== 'air') need.set(c.role, (need.get(c.role) ?? 0) + 1)
  return [...need].map(([role, n]) => {
    const r = roles[role]!
    const have = haveFor(r, inventory)
    const generic = !r.strict && /^_[a-z_]+\$$/.test(r.accept.source)
    return { role, item: r.item, label: generic ? `${r.item} (or any ${r.accept.source.slice(0, -1)})` : r.item, need: n, have, missing: Math.max(0, n - have), optional: r.optional }
  })
}

export function fmtMaterials (rows: MaterialRow[]): string {
  return rows.map(r => `${r.need} ${r.label}${r.optional ? ' (optional)' : ''}: have ${r.have}${r.missing ? `, missing ${r.missing}` : ''}`).join('; ')
}

// ------------------------------------------------------------------ order

/**
 * Placement order: clear "air" cells first, then solid blocks layer by layer (floor, walls,
 * roof), each layer starting from cells with support below and spreading to neighbours (a
 * roof goes in from the walls inwards), then attachments (torches) and doors last.
 * `groundBelow` says whether the world has a solid block under a bottom-layer cell.
 */
export function orderCells<T extends { x: number, y: number, z: number, role: string }> (cells: T[], roles: Record<string, { kind: Role['kind'] }>, groundBelow?: (p: Pos) => boolean): T[] {
  const kind = (c: T) => (c.role === 'air' ? 'air' : roles[c.role]?.kind ?? 'block')
  const air = cells.filter(c => kind(c) === 'air').sort((a, b) => b.y - a.y || a.z - b.z || a.x - b.x)
  const blocks = cells.filter(c => kind(c) === 'block')
  const key = (p: { x: number, y: number, z: number }) => `${p.x},${p.y},${p.z}`
  const solid = new Set<string>()
  const minY = Math.min(...blocks.map(c => c.y))
  const out: T[] = []
  for (const y of [...new Set(blocks.map(c => c.y))].sort((a, b) => a - b)) {
    const layer = blocks.filter(c => c.y === y).sort((a, b) => a.z - b.z || (a.z % 2 ? b.x - a.x : a.x - b.x))
    // The bottom layer stands on the ground, except over dips: those go in from a neighbour.
    const supported = (c: T) => (y === minY ? !groundBelow || groundBelow({ x: c.x, y: y - 1, z: c.z }) : false) || solid.has(key({ x: c.x, y: y - 1, z: c.z }))
    const seeds = layer.filter(supported)
    const done = new Set<string>()
    const queue = [...seeds]
    const byPos = new Map(layer.map(c => [key(c), c]))
    while (queue.length) {
      const c = queue.shift()!
      if (done.has(key(c))) continue
      done.add(key(c))
      out.push(c)
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const n = byPos.get(key({ x: c.x + dx, y, z: c.z + dz }))
        if (n && !done.has(key(n))) queue.push(n)
      }
    }
    for (const c of layer) if (!done.has(key(c))) out.push(c) // floating: tried last, may fail
    for (const c of layer) solid.add(key(c))
  }
  const attachments = cells.filter(c => kind(c) === 'attachment')
  const doors = cells.filter(c => kind(c) === 'door')
  return [...air, ...out, ...attachments, ...doors]
}

// ------------------------------------------------------------------ resume / world diff

export type CellState = 'done' | 'place' | 'dig' | 'blocked' | 'clear'

/**
 * What a cell needs, given the block there now: already right, place into empty space, dig a
 * natural block first (only if digging is allowed), or blocked by something player-made.
 */
export function cellState (cell: { role: string }, current: string | undefined, roles: Record<string, ResolvedRole>, canDig: boolean): CellState {
  const name = current ?? 'air'
  if (cell.role === 'air') {
    if (isReplaceableName(name)) return 'done'
    // The upper half of a door (or the other half of a bed) sits in a cell the blueprint marks as
    // air; when the blueprint itself has that door/bed, it's ours, not a player's block.
    if (/_door$|_bed$/.test(name) && Object.values(roles).some(r => r.accept.test(name) || r.item === name)) return 'done'
    if (isNaturalBlock(name)) return canDig ? 'clear' : 'blocked'
    return 'blocked'
  }
  const r = roles[cell.role]!
  if (r.accept.test(name) || name === r.item) return 'done'
  if (isReplaceableName(name)) return 'place'
  if (isNaturalBlock(name)) return canDig ? 'dig' : 'blocked'
  return 'blocked'
}

export interface BuildDiff<T> { done: T[], place: T[], dig: T[], clear: T[], blocked: T[] }

/** Sorts cells by what they need. Used for resume (skip what's done) and to refuse player builds. */
export function diffCells<T extends { x: number, y: number, z: number, role: string }> (cells: T[], blockAt: (p: Pos) => string | undefined, roles: Record<string, ResolvedRole>, canDig: boolean): BuildDiff<T> {
  const out: BuildDiff<T> = { done: [], place: [], dig: [], clear: [], blocked: [] }
  for (const c of cells) out[cellState(c, blockAt(c), roles, canDig)].push(c)
  return out
}

// ------------------------------------------------------------------ block classes

const REPLACEABLE = new Set([
  'air', 'cave_air', 'void_air', 'water', 'short_grass', 'grass', 'tall_grass', 'fern', 'large_fern',
  'snow', 'dead_bush', 'vine', 'seagrass', 'tall_seagrass', 'fire'
])

export function isReplaceableName (name: string): boolean {
  return REPLACEABLE.has(name)
}

const NATURAL = [
  /^(grass_block|dirt|coarse_dirt|podzol|rooted_dirt|mud|clay|mycelium|moss_block|moss_carpet|farmland|dirt_path)$/,
  /^(sand|red_sand|gravel|suspicious_sand|suspicious_gravel|sandstone|red_sandstone|snow_block|powder_snow|ice|packed_ice|blue_ice)$/,
  /^(stone|granite|diorite|andesite|deepslate|tuff|calcite|dripstone_block|pointed_dripstone|smooth_basalt|basalt|netherrack|end_stone|obsidian|magma_block|soul_sand|soul_soil)$/,
  /^(terracotta|[a-z_]+_terracotta)$/,
  /_ore$/,
  /^(short_grass|tall_grass|fern|large_fern|dead_bush|vine|glow_lichen|cobweb|sweet_berry_bush|sugar_cane|bamboo|cactus|pumpkin|melon|lily_pad|kelp|kelp_plant|seagrass|tall_seagrass|pink_petals|leaf_litter|bush|firefly_bush|short_dry_grass|tall_dry_grass|wildflowers|spore_blossom|hanging_roots|big_dripleaf|small_dripleaf|azalea|flowering_azalea|cave_vines|cave_vines_plant)$/,
  /^(dandelion|poppy|blue_orchid|allium|azure_bluet|[a-z]+_tulip|oxeye_daisy|cornflower|lily_of_the_valley|sunflower|lilac|rose_bush|peony|torchflower|pitcher_plant|brown_mushroom|red_mushroom|snow)$/,
  /_leaves$/
]

/** Blocks the world generates (ground, plants, leaves). Anything else counts as player-made. Logs are not natural here: trees are left standing. */
export function isNaturalBlock (name: string): boolean {
  return NATURAL.some(re => re.test(name))
}

/** Plants and snow that break instantly and are in the way of a structure. */
export function isSoftBlock (name: string): boolean {
  return NATURAL[5]!.test(name) || NATURAL[6]!.test(name)
}

// ------------------------------------------------------------------ site choice

/** One column of the world around a candidate site, as scanned by construction.ts. */
export interface Column {
  /** y of the topmost solid ground block. */
  ground: number
  groundName: string
  /** Natural blocks in the space above ground that would have to be broken (plants, leaves). */
  soft: number
  /** Logs or player-made blocks in that space, or player-made ground: never build here. */
  foreign: boolean
  /** Ground is water or lava. */
  liquid: boolean
  /** Solid rock or blocks overhead (a cave): houses go under the open sky unless the player is underground too. */
  covered?: boolean
}

export interface SiteOptions {
  radius: number
  canDig: boolean
  /** Positions the bot must not build on (protected areas, spawn). */
  forbidden?: (p: Pos) => boolean
  /** Accept covered columns (caves). Default false. */
  allowCovered?: boolean
}

export interface Site { origin: Pos, score: number, bumps: number, soft: number }

/**
 * Picks the best origin within `radius` of `center` for a w x d footprint: no water, nothing
 * player-made, no trees, ground varying by at most 1 block (2 if it may dig the bumps away),
 * close to the centre. origin.y is the level the floor goes on (one above the ground).
 */
export function chooseSite (column: (x: number, z: number) => Column | null, w: number, d: number, center: { x: number, z: number }, opts: SiteOptions): Site | null {
  let best: Site | null = null
  const cx = Math.floor(center.x)
  const cz = Math.floor(center.z)
  for (let dx = -opts.radius; dx <= opts.radius; dx++) {
    for (let dz = -opts.radius; dz <= opts.radius; dz++) {
      const dist = Math.hypot(dx, dz)
      if (dist > opts.radius) continue
      // keep the structure off the requester's own spot: at least 2 blocks clear of the centre
      const ox = cx + dx
      const oz = cz + dz
      const x0 = ox - Math.floor(w / 2)
      const z0 = oz - Math.floor(d / 2)
      if (cx >= x0 - 1 && cx <= x0 + w && cz >= z0 - 1 && cz <= z0 + d) continue
      const s = scoreSite(column, x0, z0, w, d, opts)
      if (!s) continue
      const score = dist + s.bumps * 1.5 + s.soft * 0.3
      if (!best || score < best.score) best = { origin: { x: ox, y: s.floor, z: oz }, score, bumps: s.bumps, soft: s.soft }
    }
  }
  return best
}

function scoreSite (column: (x: number, z: number) => Column | null, x0: number, z0: number, w: number, d: number, opts: SiteOptions): { floor: number, bumps: number, soft: number } | null {
  const heights: number[] = []
  let soft = 0
  for (let x = x0; x < x0 + w; x++) {
    for (let z = z0; z < z0 + d; z++) {
      const c = column(x, z)
      if (!c || c.foreign || c.liquid || (c.covered && !opts.allowCovered)) return null
      if (opts.forbidden?.({ x, y: c.ground, z })) return null
      if (!isNaturalBlock(c.groundName)) return null
      heights.push(c.ground)
      soft += c.soft
    }
  }
  if (soft && !opts.canDig) return null
  const min = Math.min(...heights)
  const max = Math.max(...heights)
  if (max - min > (opts.canDig ? 2 : 1)) return null
  // With digging: build on the most common height and dig the bumps above it. Without: on the highest.
  let base = max
  if (opts.canDig) {
    const freq = new Map<number, number>()
    for (const h of heights) freq.set(h, (freq.get(h) ?? 0) + 1)
    base = [...freq].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]![0]
    if (heights.some(h => h > base + 1)) return null
  }
  const bumps = heights.filter(h => h > base).length
  if (bumps > Math.ceil(w * d / 3)) return null
  return { floor: base + 1, bumps, soft }
}
