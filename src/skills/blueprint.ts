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
//
// Palette entries can carry a block state: `R: { role: roof, state: { facing: north, half: top } }`
// or the short form `R: "roof[facing=north,half=top]"`. In layers, ^ v < > are stairs of the
// `stairs` role (default: a role named roof) climbing north, south, west, east. States turn with
// the blueprint when it is rotated. Roles marked `wood: true` follow the build's wood theme.
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import { z } from 'zod'
import { FACINGS, ARROWS, rotateState, parseStateString, isFacing, type Facing, type BlockState } from './blockstate.ts'

export { FACINGS, type Facing, type BlockState }

const StateSchema = z.record(z.string(), z.union([z.string(), z.boolean(), z.number()]))
const FallbackSchema = z.union([z.string(), z.object({ item: z.string(), state: StateSchema.optional() })])

const RoleSchema = z.object({
  default: z.string().min(1).describe('block placed when the inventory has nothing better that fits'),
  accept: z.string().optional().describe('regex of item/block names that count as this role (default: only the default)'),
  kind: z.enum(['block', 'door', 'attachment', 'furnish']).default('block').describe('door, attachment and furnish go in after the blocks'),
  optional: z.boolean().default(false).describe('skipped (with a note) when the bot has none'),
  material: z.boolean().default(false).describe('the build action\'s `material` parameter replaces this role'),
  wood: z.boolean().default(false).describe('the default\'s wood (oak_planks) follows the build theme (spruce_planks)'),
  state: StateSchema.optional().describe('block state for every cell of this role (cells can add to it)'),
  fallback: z.array(FallbackSchema).optional().describe('items used instead when the bot has none of this role, in order'),
  gather: z.boolean().default(true).describe('false: never gathered or crafted for this role, only used if carried')
})

const LayerSchema = z.union([z.string(), z.array(z.string())])

export const BlueprintSchema = z.object({
  name: z.string().regex(/^[a-z0-9_]+$/, 'lowercase letters, digits and _'),
  description: z.string().min(1),
  facing: z.enum(['north', 'east', 'south', 'west']).default('south'),
  site: z.enum(['near', 'here']).default('near').describe('near: find a flat spot near the player; here: around the bot\'s feet (emergency shelter)'),
  roles: z.record(z.string(), RoleSchema),
  palette: z.record(z.string(), z.union([
    z.string(),
    z.object({ role: z.string(), state: StateSchema.optional() }),
    z.object({ block: z.string(), state: StateSchema.optional() })
  ])),
  stairs: z.string().optional().describe('role used by the ^ v < > stair shorthand (default: a role named roof)'),
  layers: z.array(LayerSchema).min(1),
  meta: z.object({
    tags: z.array(z.string()).optional().describe('house, defence, farm, decoration, ...'),
    style: z.string().optional(),
    author: z.string().optional(),
    description: z.string().optional(),
    source: z.string().optional().describe('shipped, designed, captured, imported from <file>, ...'),
    created: z.string().optional().describe('ISO date'),
    rating: z.number().min(0).max(5).optional(),
    notes: z.string().optional()
  }).passthrough().optional().describe('library metadata (blueprint_search reads it); not used for building')
})

export type BlueprintFile = z.infer<typeof BlueprintSchema>
export type Role = z.infer<typeof RoleSchema>

/**
 * One cell of a structure. `role` is a role name or "air" (must be clear). Coordinates are local.
 * `state` is the wanted block state; `passive` cells (a bed's head, a door's top) are filled by
 * placing their other half. `glyph` is the character the cell was drawn with.
 */
export interface Cell { x: number, y: number, z: number, role: string, state?: BlockState, passive?: boolean, glyph?: string }

export interface Blueprint {
  name: string
  description: string
  meta?: Record<string, unknown>
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

const stringify = (st: Record<string, string | boolean | number> | undefined): BlockState | undefined =>
  st ? Object.fromEntries(Object.entries(st).map(([k, v]) => [k, String(v)])) : undefined

/** A bed's head or a door's top half: comes with the other half, never placed by itself. */
export const isPassiveState = (st: BlockState | undefined) => !!st && (st.part === 'head' || st.half === 'upper')

const STATE_VALUES: Record<string, RegExp> = {
  facing: /^(north|south|east|west|up|down)$/,
  half: /^(top|bottom|upper|lower)$/,
  type: /^(top|bottom|double)$/,
  axis: /^(x|y|z)$/,
  hinge: /^(left|right)$/,
  open: /^(true|false)$/,
  hanging: /^(true|false)$/,
  part: /^(head|foot)$/,
  shape: /^(straight|inner|outer|inner_left|inner_right|outer_left|outer_right)$/
}

/** False when a known state property has a value the builder can't use (chest type=single, rail shape=ascending_east). */
export function validStateValue (key: string, value: string): boolean {
  const re = STATE_VALUES[key]
  return !re || re.test(value)
}

function stateProblems (st: BlockState | undefined, where: string): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(st ?? {})) {
    const re = STATE_VALUES[k]
    if (re && !re.test(v)) out.push(`${where}: bad ${k} "${v}"`)
  }
  return out
}

/** Parses and validates a blueprint. Throws an Error that says what is wrong. */
export function parseBlueprint (text: string | unknown, source = 'blueprint'): Blueprint {
  const raw = typeof text === 'string' ? YAML.parse(text) : text
  const r = BlueprintSchema.safeParse(raw)
  if (!r.success) throw new Error(`${source}: ${z.prettifyError(r.error).replace(/\n/g, '; ')}`)
  const f = r.data
  const problems: string[] = []
  const roles: Record<string, Role> = { ...f.roles }
  const palette = new Map<string, { role: string, state?: BlockState }>()
  for (const [ch, v] of Object.entries(f.palette)) {
    if ([...ch].length !== 1) problems.push(`palette key "${ch}" must be one character`)
    if (ch === ' ') problems.push('" " is reserved for "don\'t care"')
    // A plain block ("minecraft:oak_stairs[facing=north]" or { block, state }) gets a role of its own.
    let entry: { role: string, state?: BlockState } | null
    if (typeof v === 'string') {
      entry = parseStateString(v)
      if (entry && (v.trim().startsWith('minecraft:') || (!roles[entry.role] && entry.role.includes(':')))) entry = { role: blockRole(roles, entry.role), state: entry.state }
    } else if ('block' in v) {
      entry = { role: blockRole(roles, v.block), state: stringify(v.state) }
    } else {
      entry = { role: v.role, state: stringify(v.state) }
    }
    if (!entry) { problems.push(`palette "${ch}": can't read "${String(v)}" (use role, role[key=value,...] or minecraft:block[key=value])`); continue }
    if (entry.role !== 'air' && entry.role !== 'skip' && !roles[entry.role]) problems.push(`palette "${ch}" uses unknown role "${entry.role}"`)
    problems.push(...stateProblems(entry.state, `palette "${ch}"`))
    palette.set(ch, entry)
  }
  // ^ v < > : stairs of the stairs role, unless the palette defines those characters itself
  const stairRole = f.stairs ?? (roles.roof ? 'roof' : undefined)
  if (f.stairs && !roles[f.stairs]) problems.push(`stairs: unknown role "${f.stairs}"`)
  if (stairRole && roles[stairRole]) {
    for (const [ch, facing] of Object.entries(ARROWS)) if (!palette.has(ch)) palette.set(ch, { role: stairRole, state: { facing, half: 'bottom' } })
  }
  for (const [name, role] of Object.entries(roles)) {
    if (role.accept) { try { new RegExp(role.accept) } catch { problems.push(`role ${name}: bad accept regex`) } }
    problems.push(...stateProblems(stringify(role.state), `role ${name}`))
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
        const v = palette.get(ch)
        if (v === undefined) { problems.push(`layer ${y} row ${z}: "${ch}" is not in the palette`); return }
        if (v.role === 'skip') return
        const roleState = v.role === 'air' ? undefined : stringify(roles[v.role]?.state)
        const state = roleState || v.state ? { ...roleState, ...v.state } : undefined
        const cell: Cell = { x, y, z, role: v.role, glyph: ch }
        if (state) cell.state = state
        if (isPassiveState(state)) cell.passive = true
        cells.push(cell)
      })
    })
  })
  if (!cells.some(c => c.role !== 'air' && !c.passive)) problems.push('no blocks to place')
  if (problems.length) throw new Error(`${source}: ${[...new Set(problems)].slice(0, 6).join('; ')}`)
  const bp: Blueprint = { name: f.name, description: f.description, facing: f.facing, site: f.site, roles, width, depth, height: layers.length, cells }
  if (f.meta) bp.meta = f.meta
  return bp
}

/** The item that places a block, when they differ (a wall torch comes from a torch). */
export function itemForBlock (block: string): string {
  const n = block.replace(/^minecraft:/, '')
  if (/^(soul_|redstone_)?wall_torch$/.test(n)) return n.replace('wall_torch', 'torch')
  const wall = /^(.+)_wall_(sign|hanging_sign|banner|head|skull|fan)$/.exec(n)
  if (wall) return `${wall[1]}_${wall[2]}`
  if (n === 'redstone_wire') return 'redstone'
  if (n === 'tripwire') return 'string'
  return n
}

/** When a plain block goes in: doors last, things that hang on a wall after the walls, furniture after that. */
export function kindForBlock (block: string): Role['kind'] {
  const n = block.replace(/^[a-z0-9_.-]+:/, '')
  if (/_door$/.test(n) && !/trapdoor$/.test(n)) return 'door'
  if (/(^|_)torch$|lantern$|^ladder$|_button$|^lever$|_sign$|_banner$|^tripwire_hook$/.test(n)) return 'attachment'
  if (/_bed$|^(chest|trapped_chest|barrel|furnace|smoker|blast_furnace|crafting_table|anvil|chipped_anvil|damaged_anvil|enchanting_table|brewing_stand|cauldron|lectern|loom|stonecutter|grindstone|smithing_table|cartography_table|fletching_table|composter|flower_pot)$|^potted_/.test(n)) return 'furnish'
  return 'block'
}

/** The implicit role of a plain block name in a palette: exactly that block, nothing else. */
function blockRole (roles: Record<string, Role>, block: string): string {
  const name = block.replace(/^minecraft:/, '')
  const key = `block:${name}`
  if (!roles[key]) {
    const item = itemForBlock(name)
    const role: Role = { default: item, kind: kindForBlock(name), optional: false, material: false, wood: false, gather: true }
    if (item !== name) role.accept = `^(${escapeRe(item)}|${escapeRe(name)})$`
    roles[key] = role
  }
  return key
}

export const BLUEPRINTS_DIR = fileURLToPath(new URL('../../blueprints/', import.meta.url))

/**
 * Loads every *.yaml in the given directories (default: the shipped blueprints/). Later
 * directories override earlier ones by blueprint name. Missing directories and broken files
 * are reported in `errors`, not thrown.
 */
/** A *.yaml file that holds a blueprint: everything but blueprints/sources.yaml (the fetch list). */
export const isBlueprintFile = (f: string) => /\.ya?ml$/.test(f) && f !== 'sources.yaml'

export function loadBlueprints (dirs: string | string[] = [BLUEPRINTS_DIR]): { blueprints: Map<string, Blueprint>, errors: string[] } {
  const blueprints = new Map<string, Blueprint>()
  const errors: string[] = []
  for (const dir of Array.isArray(dirs) ? dirs : [dirs]) {
    if (!existsSync(dir)) { errors.push(`no blueprints directory at ${dir}`); continue }
    for (const f of readdirSync(dir).filter(isBlueprintFile).sort()) {
      try {
        const bp = parseBlueprint(readFileSync(join(dir, f), 'utf8'), f)
        blueprints.set(bp.name, bp)
      } catch (e) {
        errors.push((e as Error).message)
      }
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
  if (turns) out = { ...out, cells: out.cells.map(c => (c.state ? { ...c, state: rotateState(c.state, turns) } : c)) }
  return { ...out, facing }
}

export interface Pos { x: number, y: number, z: number }
export interface WorldCell extends Pos { role: string, local: Cell, state?: BlockState, passive?: boolean }

/** World positions: the footprint is centred on origin x/z; origin.y is the level of layer 0. */
export function placeCells (bp: Blueprint, origin: Pos): WorldCell[] {
  const ox = Math.floor(origin.x) - Math.floor(bp.width / 2)
  const oz = Math.floor(origin.z) - Math.floor(bp.depth / 2)
  return bp.cells.map(c => {
    const w: WorldCell = { x: ox + c.x, y: Math.floor(origin.y) + c.y, z: oz + c.z, role: c.role, local: c }
    if (c.state) w.state = c.state
    if (c.passive) w.passive = true
    return w
  })
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

// ------------------------------------------------------------------ wood themes

/** Overworld woods a theme can name. */
export const WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak'] as const
const WOOD_RE = /^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|bamboo|crimson|warped)_(.+)$/

/** The wood of an item name ("spruce_stairs" -> spruce), or null. */
export function woodOf (name: string): string | null {
  const m = WOOD_RE.exec(name.replace(/^[a-z0-9_]+:/, ''))
  return m ? m[1]! : null
}

/** The same item in another wood ("oak_stairs", "birch" -> "birch_stairs"). Non-wood names stay. */
export function swapWood (name: string, wood: string | undefined): string {
  if (!wood) return name
  const m = WOOD_RE.exec(name)
  if (!m) return name
  return `${wood}_${m[2]}`
}

/** The wood the inventory has most of (logs count 4, other wooden items 1 each), or null. */
export function pickTheme (inventory: Record<string, number>): string | null {
  const score = new Map<string, number>()
  for (const [k, n] of Object.entries(inventory)) {
    const w = woodOf(k)
    if (!w || !(WOODS as readonly string[]).includes(w)) continue
    score.set(w, (score.get(w) ?? 0) + n * (/_(log|wood)$/.test(k) ? 4 : 1))
  }
  return [...score].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
}

// ------------------------------------------------------------------ materials

export interface ResolvedFallback { item: string, accept: RegExp, state?: BlockState }

export interface ResolvedRole {
  role: string
  /** Item placed (preferred; other accepted items are used when it runs out unless strict). */
  item: string
  accept: RegExp
  kind: Role['kind']
  optional: boolean
  /** Only `item` counts (the player named the material). */
  strict: boolean
  /** Used instead, in order, when the bot has nothing the role accepts (fences for missing glass). */
  fallbacks?: ResolvedFallback[]
  /** false: never gathered for this role. */
  gather?: boolean
  /** Strict roles: what the role accepts regardless of the named material (a block already there counts). */
  fits?: RegExp
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function acceptRe (role: Role): RegExp {
  return new RegExp(role.accept ?? `^${escapeRe(role.default)}$`)
}

/** What counts as a fallback item: any wood of a wooden one ("oak_fence" -> any _fence), else exactly it. */
function fallbackRe (item: string): RegExp {
  const m = WOOD_RE.exec(item)
  return m ? new RegExp(`^(${WOODS.join('|')}|bamboo|crimson|warped)_${escapeRe(m[2]!)}$`) : new RegExp(`^${escapeRe(item)}$`)
}

/**
 * Picks the item for each role: the `material` the player asked for (material roles), else
 * the accepted item the inventory has most of (the theme's wood first for wood roles), else
 * the role's default in the theme's wood.
 */
export function resolveRoles (bp: Blueprint, inventory: Record<string, number>, material?: string, theme?: string): Record<string, ResolvedRole> {
  const out: Record<string, ResolvedRole> = {}
  const wood = theme && (WOODS as readonly string[]).includes(theme) ? theme : undefined
  for (const [name, role] of Object.entries(bp.roles)) {
    const accept = acceptRe(role)
    const fallbacks = role.fallback?.map(f => {
      const item = swapWood(typeof f === 'string' ? f : f.item, role.wood ? wood : undefined)
      const fb: ResolvedFallback = { item, accept: fallbackRe(item) }
      if (typeof f !== 'string' && f.state) fb.state = stringify(f.state)
      return fb
    })
    const base = { kind: role.kind, optional: role.optional, ...(fallbacks?.length ? { fallbacks } : {}), ...(role.gather ? {} : { gather: false }) }
    if (role.material && material) {
      out[name] = { role: name, item: material, accept: new RegExp(`^${escapeRe(material)}$`), strict: true, fits: accept, ...base }
      continue
    }
    const preferred = role.wood && wood ? swapWood(role.default, wood) : null
    const owned = Object.entries(inventory).filter(([k, n]) => n > 0 && accept.test(k)).sort((a, b) => b[1] - a[1])
    const item = preferred && (inventory[preferred] ?? 0) > 0 ? preferred : owned[0]?.[0] ?? preferred ?? role.default
    out[name] = { role: name, item, accept, strict: false, ...base }
  }
  return out
}

/** How many of each role's item an inventory holds (any accepted item unless strict). */
export function haveFor (r: ResolvedRole, inventory: Record<string, number>): number {
  if (r.strict) return inventory[r.item] ?? 0
  return Object.entries(inventory).reduce((n, [k, v]) => n + (r.accept.test(k) ? v : 0), 0)
}

/** True when a block name fills a role: the role's own items or one of its fallbacks. */
export function roleAccepts (r: ResolvedRole, name: string): boolean {
  // mixed materials are fine: oak planks from an earlier run count for a spruce wall
  return name === r.item || r.accept.test(name) || !!r.fits?.test(name) || !!r.fallbacks?.some(f => f.accept.test(name))
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

/** Cells that are placed as blocks: not air, not the passive half of a bed or door. */
export function solidCells<T extends { role: string, passive?: boolean }> (cells: T[]): T[] {
  return cells.filter(c => c.role !== 'air' && !c.passive)
}

/** Material needs of a set of cells vs what the inventory holds. */
export function materials (cells: { role: string, passive?: boolean }[], roles: Record<string, ResolvedRole>, inventory: Record<string, number>): MaterialRow[] {
  const need = new Map<string, number>()
  for (const c of solidCells(cells)) need.set(c.role, (need.get(c.role) ?? 0) + 1)
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
 * `groundBelow` says whether the world has a solid block under a bottom-layer cell. `solidNow`
 * (optional) says what is solid in the world right now: a cell next to one (or on one) is a
 * seed too, so a partly built layer (a resumed build, the quality pass, a floor around an
 * existing hut) carries on from what stands instead of from cells with nothing to click.
 */
export function orderCells<T extends { x: number, y: number, z: number, role: string, passive?: boolean }> (cells: T[], roles: Record<string, { kind: Role['kind'] }>, groundBelow?: (p: Pos) => boolean, solidNow?: (p: Pos) => boolean): T[] {
  const kind = (c: T) => (c.passive ? 'passive' : c.role === 'air' ? 'air' : roles[c.role]?.kind ?? 'block')
  const air = cells.filter(c => kind(c) === 'air').sort((a, b) => b.y - a.y || a.z - b.z || a.x - b.x)
  const blocks = cells.filter(c => kind(c) === 'block')
  const key = (p: { x: number, y: number, z: number }) => `${p.x},${p.y},${p.z}`
  const solid = new Set<string>()
  const minY = Math.min(...blocks.map(c => c.y))
  const out: T[] = []
  for (const y of [...new Set(blocks.map(c => c.y))].sort((a, b) => a - b)) {
    const layer = blocks.filter(c => c.y === y).sort((a, b) => a.z - b.z || (a.z % 2 ? b.x - a.x : a.x - b.x))
    // The bottom layer stands on the ground, except over dips: those go in from a neighbour.
    const touching = (c: T) => !!solidNow && (solidNow({ x: c.x, y: y - 1, z: c.z }) ||
      ([[1, 0], [-1, 0], [0, 1], [0, -1]] as const).some(([dx, dz]) => solidNow({ x: c.x + dx, y, z: c.z + dz })))
    const supported = (c: T) => (y === minY ? !groundBelow || groundBelow({ x: c.x, y: y - 1, z: c.z }) : false) || solid.has(key({ x: c.x, y: y - 1, z: c.z })) || touching(c)
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
  const attachments = cells.filter(c => kind(c) === 'attachment').sort((a, b) => a.y - b.y)
  const furnish = cells.filter(c => kind(c) === 'furnish')
  const doors = cells.filter(c => kind(c) === 'door')
  return [...air, ...out, ...attachments, ...furnish, ...doors]
}

/**
 * Batching: which pending cell to place next, as an index into `todo` at or after `from`. Only
 * cells of the same group as todo[from] (the same layer, say) are considered, so the layer
 * order holds. Among those that are ready (something to click), one in reach from where the
 * bot stands wins, nearest first; otherwise the nearest ready one. With nothing ready, `from`.
 */
export function pickNearby<T> (todo: T[], from: number, group: (c: T) => string, ready: (c: T) => boolean, inReach: (c: T) => boolean, dist: (c: T) => number, window = 400): number {
  const first = todo[from]
  if (first === undefined) return from
  if (ready(first) && inReach(first)) return from
  const g = group(first)
  let best = -1
  let bestReach = false
  let bestD = Infinity
  for (let j = from; j < todo.length && j < from + window; j++) {
    const c = todo[j]!
    if (group(c) !== g || !ready(c)) continue
    const r = inReach(c)
    const d = dist(c)
    if ((r && !bestReach) || (r === bestReach && d < bestD)) { best = j; bestReach = r; bestD = d }
  }
  return best < 0 ? from : best
}

// ------------------------------------------------------------------ resume / world diff

export type CellState = 'done' | 'place' | 'dig' | 'blocked' | 'clear'

/**
 * What a cell needs, given the block there now: already right (any block the role accepts, so
 * mixed materials count), place into empty space, dig a natural block or one this bot placed
 * itself (`own`) first (only if digging is allowed), or blocked by something player-made.
 */
export function cellState (cell: { role: string, passive?: boolean }, current: string | undefined, roles: Record<string, ResolvedRole>, canDig: boolean, own = false): CellState {
  const name = current ?? 'air'
  if (cell.passive) {
    // the other half of a bed or door: right when it's there, otherwise it only has to be clear
    if (roles[cell.role] && roleAccepts(roles[cell.role]!, name)) return 'done'
    return cellState({ role: 'air' }, current, roles, canDig, own)
  }
  if (cell.role === 'air') {
    if (isReplaceableName(name)) return 'done'
    // The upper half of a door (or the other half of a bed) sits in a cell the blueprint marks as
    // air; when the blueprint itself has that door/bed, it's ours, not a player's block.
    if (/_door$|_bed$/.test(name) && Object.values(roles).some(r => roleAccepts(r, name))) return 'done'
    // natural clutter, or a block this bot placed itself (a misplaced one): it may go
    if (isNaturalBlock(name) || own) return canDig ? 'clear' : 'blocked'
    return 'blocked'
  }
  const r = roles[cell.role]!
  if (roleAccepts(r, name)) return 'done'
  if (isReplaceableName(name)) return 'place'
  if (isNaturalBlock(name) || own) return canDig ? 'dig' : 'blocked'
  return 'blocked'
}

export interface BuildDiff<T> { done: T[], place: T[], dig: T[], clear: T[], blocked: T[] }

/** Sorts cells by what they need. Used for resume (skip what's done) and to refuse player builds. */
export function diffCells<T extends { x: number, y: number, z: number, role: string, passive?: boolean }> (cells: T[], blockAt: (p: Pos) => string | undefined, roles: Record<string, ResolvedRole>, canDig: boolean, own?: (p: Pos) => boolean): BuildDiff<T> {
  const out: BuildDiff<T> = { done: [], place: [], dig: [], clear: [], blocked: [] }
  for (const c of cells) out[cellState(c, blockAt(c), roles, canDig, !!own?.(c))].push(c)
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

/** Ground cover, plants, crops and leaves: what a structure file carries from its surroundings (not stone or sand, which builds use). */
export function isGroundOrPlant (name: string): boolean {
  return NATURAL[0]!.test(name) || NATURAL[5]!.test(name) || NATURAL[6]!.test(name) || NATURAL[7]!.test(name) ||
    /^(grass|wheat|carrots|potatoes|beetroots|melon_stem|pumpkin_stem|attached_melon_stem|attached_pumpkin_stem|nether_wart|potted_[a-z_]+|[a-z_]+_sapling)$/.test(name)
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

export interface Site { origin: Pos, score: number, bumps: number, soft: number, fills: number }

/**
 * Picks the best origin within `radius` of `center` for a w x d footprint: no water, nothing
 * player-made, no trees, ground varying by at most 1 block (2 if it may dig the bumps away),
 * close to the centre. origin.y is the level the floor goes on (one above the ground).
 */
export function chooseSite (column: (x: number, z: number) => Column | null, w: number, d: number, center: { x: number, z: number, y?: number }, opts: SiteOptions): Site | null {
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
      // a spot up a hill or down a slope is further to walk than it looks from above
      const climb = center.y === undefined ? 0 : Math.abs(s.floor - Math.floor(center.y)) * 0.7
      const score = dist + s.bumps * 1.5 + s.soft * 0.3 + s.fills * 0.8 + climb
      if (!best || score < best.score) best = { origin: { x: ox, y: s.floor, z: oz }, score, bumps: s.bumps, soft: s.soft, fills: s.fills }
    }
  }
  return best
}

function scoreSite (column: (x: number, z: number) => Column | null, x0: number, z0: number, w: number, d: number, opts: SiteOptions): { floor: number, bumps: number, soft: number, fills: number } | null {
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
  if (max - min > (opts.canDig ? 3 : 1)) return null
  // With digging: build on the most common height, dig the bumps above it and fill dips up to
  // two deep below it (site preparation). Without: on the highest.
  let base = max
  if (opts.canDig) {
    const freq = new Map<number, number>()
    for (const h of heights) freq.set(h, (freq.get(h) ?? 0) + 1)
    base = [...freq].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]![0]
    if (heights.some(h => h > base + 1 || h < base - 2)) return null
  }
  const bumps = heights.filter(h => h > base).length
  if (bumps > Math.ceil(w * d / 3)) return null
  const fills = opts.canDig ? heights.reduce((n, h) => n + Math.max(0, base - h), 0) : 0
  if (fills > Math.ceil(w * d / 2)) return null
  return { floor: base + 1, bumps, soft, fills }
}

// ------------------------------------------------------------------ site preparation & orientation

/**
 * Blocks to fill under the bottom layer where the ground dips (at most `maxDepth` deep), so a
 * floor or foundation doesn't hang in the air. `groundAt` gives the top solid y of a column.
 */
export function fillCells (cells: { x: number, y: number, z: number, role: string, passive?: boolean }[], groundAt: (x: number, z: number) => number | null, maxDepth = 2): Pos[] {
  const solid = solidCells(cells)
  if (!solid.length) return []
  const bottom = Math.min(...solid.map(c => c.y))
  const out: Pos[] = []
  const seen = new Set<string>()
  for (const c of solid) {
    if (c.y !== bottom || seen.has(`${c.x},${c.z}`)) continue
    seen.add(`${c.x},${c.z}`)
    const g = groundAt(c.x, c.z)
    if (g === null) continue
    for (let y = Math.max(g + 1, bottom - maxDepth); y < bottom; y++) out.push({ x: c.x, y, z: c.z })
  }
  return out.sort((a, b) => a.y - b.y)
}

/** The first facing in preference order whose front is open; the first one if none is. */
export function pickFacing (order: Facing[], open: (f: Facing) => boolean): Facing {
  return order.find(open) ?? order[0]!
}

/** Facings ordered by how close they point to a target: towards it first, away from it last. */
export function facingsToward (from: { x: number, z: number }, to: { x: number, z: number }): Facing[] {
  const first = facingToward(from, to)
  const i = FACINGS.indexOf(first)
  const dx = to.x - from.x
  const dz = to.z - from.z
  // second choice: the other axis's side the target leans to
  const second = Math.abs(dx) > Math.abs(dz) ? (dz >= 0 ? 'south' : 'north') : (dx >= 0 ? 'east' : 'west')
  const rest = [FACINGS[(i + 1) % 4]!, FACINGS[(i + 3) % 4]!, FACINGS[(i + 2) % 4]!]
  return [first, second as Facing, ...rest.filter(f => f !== second)]
}

// ------------------------------------------------------------------ preview

const STAIR_GLYPH: Record<Facing, string> = { north: '^', south: 'v', west: '<', east: '>' }

function glyphOf (bp: Blueprint, c: Cell): string {
  if (c.role === 'air') return '.'
  const def = bp.roles[c.role]?.default ?? ''
  if (/_stairs$/.test(def) && isFacing(c.state?.facing)) return STAIR_GLYPH[c.state!.facing as Facing]
  return c.glyph ?? '#'
}

/**
 * Text preview: a top-down view (the highest block of each column) and every layer, rows north
 * to south, plus a legend. Stairs show which way they climb (^ north, v south, < west, > east).
 */
export function renderBlueprint (bp: Blueprint, opts: { layers?: boolean } = {}): string {
  const grid = (pick: (x: number, z: number) => string) => {
    const lines: string[] = []
    for (let z = 0; z < bp.depth; z++) {
      let row = ''
      for (let x = 0; x < bp.width; x++) row += pick(x, z)
      lines.push(`  ${row}`.trimEnd())
    }
    return lines.join('\n')
  }
  const at = new Map(bp.cells.map(c => [`${c.x},${c.y},${c.z}`, c]))
  const solid = solidCells(bp.cells).length
  const out = [`${bp.name}: ${bp.width}x${bp.depth}, ${bp.height} high, ${solid} blocks, entrance ${bp.facing} (north is up)`]
  out.push('top view:')
  out.push(grid((x, z) => {
    for (let y = bp.height - 1; y >= 0; y--) {
      const c = at.get(`${x},${y},${z}`)
      if (c && c.role !== 'air') return glyphOf(bp, c)
    }
    return ' '
  }))
  if (opts.layers !== false) {
    for (let y = 0; y < bp.height; y++) {
      out.push(`layer ${y}:`)
      out.push(grid((x, z) => { const c = at.get(`${x},${y},${z}`); return c ? glyphOf(bp, c) : ' ' }))
    }
  }
  const legend = new Map<string, string>()
  for (const c of bp.cells) {
    const g = glyphOf(bp, c)
    if (legend.has(g) || g === '.' ) continue
    const r = bp.roles[c.role]
    const st = c.state ? Object.entries(c.state).filter(([k]) => k !== 'facing' || !'^v<>'.includes(g)).map(([k, v]) => `${k}=${v}`).join(',') : ''
    legend.set(g, `${c.role}${r ? ` (${r.default}${r.optional ? ', optional' : ''})` : ''}${st ? ` [${st}]` : ''}`)
  }
  out.push(`legend: ${[...legend].map(([g, d]) => `${g} ${d}`).join('; ')}; . air`)
  return out.join('\n')
}
