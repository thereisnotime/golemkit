// Structures from outside: Sponge .schem (v1-v3), Litematica .litematic and vanilla structure
// .nbt files, and regions of the live world (blueprint_capture), all turned into the YAML
// blueprint format with plain-block palette entries (`{ block: oak_stairs, state: {...} }`).
// Pure apart from reading the NBT buffer, so every format is unit tested with generated files.
//
//   const s = await readSchematic(buffer)            // -> Structure (palette + dense grid)
//   const { yaml, warnings } = structureToYaml(s, { name: 'tower' })
import { createRequire } from 'node:module'
import { gunzipSync } from 'node:zlib'
import YAML from 'yaml'
import nbt from 'prismarine-nbt'
import { validStateValue, facingToward, kindForBlock, itemForBlock, parseBlueprint, isGroundOrPlant, type BlockState, type Facing } from './blueprint.ts'

/** One block type in a structure: a namespaced name and its state properties. */
export interface PaletteEntry { name: string, state?: BlockState }

/**
 * A box of blocks. `grid[(y * depth + z) * width + x]` is a palette index, or -1 for "don't
 * care" (structure void, or a block the capture left out). Air is a palette entry like any other.
 */
export interface Structure {
  width: number
  height: number
  depth: number
  palette: PaletteEntry[]
  grid: Int32Array
  /** Where it came from: "sponge v2", "litematica (2 regions)", "structure", "mcedit (legacy)", "world". */
  format: string
  /** Things the reader had to guess or leave out (unknown legacy ids...), passed on to the import. */
  warnings?: string[]
}

export const DONT_CARE = -1

export function emptyStructure (width: number, height: number, depth: number, format: string): Structure {
  return { width, height, depth, palette: [], grid: new Int32Array(width * height * depth).fill(DONT_CARE), format }
}

export const cellIndex = (s: Pick<Structure, 'width' | 'depth'>, x: number, y: number, z: number) => (y * s.depth + z) * s.width + x

/** Palette index for a block, adding it when new. */
export function paletteIndex (s: Structure, e: PaletteEntry, cache = new Map<string, number>()): number {
  const k = stateKey(e)
  let i = cache.get(k)
  if (i === undefined) {
    i = s.palette.findIndex(p => stateKey(p) === k)
    if (i < 0) { s.palette.push(e); i = s.palette.length - 1 }
    cache.set(k, i)
  }
  return i
}

const stateKey = (e: PaletteEntry) => `${e.name}[${Object.entries(e.state ?? {}).sort().map(([k, v]) => `${k}=${v}`).join(',')}]`

/** "minecraft:oak_stairs[facing=east,half=bottom]" -> { name, state }. Modded ids keep their namespace. */
export function parseBlockString (text: string): PaletteEntry {
  const m = /^\s*([^[\s]+)\s*(?:\[([^\]]*)\])?\s*$/.exec(text)
  if (!m) return { name: text.trim() }
  const out: PaletteEntry = { name: m[1]! }
  if (m[2]) {
    const state: BlockState = {}
    for (const part of m[2].split(',')) {
      const [k, v] = part.split('=').map(s => s.trim())
      if (k && v !== undefined) state[k] = v
    }
    if (Object.keys(state).length) out.state = state
  }
  return out
}

// ------------------------------------------------------------------ NBT readers

/** Largest box any reader will expand (air included), so a huge file can't eat the memory. */
export const MAX_VOLUME = 4_000_000
/** Largest unzipped NBT read. */
const MAX_UNZIPPED = 64 * 1024 * 1024

/** Reads a .schem, .litematic or structure .nbt (gzipped or not) into a Structure. Throws a readable Error. */
export async function readSchematic (buf: Buffer): Promise<Structure> {
  let root: any
  if (buf.length > 8 && buf.readUInt32BE(0) === AXIOM_MAGIC) return readAxiom(buf)
  if (buf.subarray(0, 4).toString('latin1') === 'PK\x03\x04') throw new Error('it is a zip archive; take the schematic out of it first')
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    // unzip here, with a cap, so a small file can't inflate into gigabytes
    try { buf = gunzipSync(buf, { maxOutputLength: MAX_UNZIPPED }) } catch (e) { throw new Error(`can't unzip it (${(e as Error).message.slice(0, 80)})`) }
  }
  try {
    const { parsed } = await nbt.parse(buf, 'big')
    root = nbt.simplify(parsed)
  } catch (e) {
    throw new Error(`not an NBT file (${(e as Error).message.slice(0, 80)})`)
  }
  return readSchematicNbt(root)
}

/** Picks the reader by the NBT content (the file extension is never trusted). */
export function readSchematicNbt (root: any): Structure {
  if (root?.Regions) return readLitematic(root)
  if (Array.isArray(root?.blocks) && Array.isArray(root?.size)) return readStructureNbt(root)
  const s = root?.Schematic ?? root
  if (s && (s.Palette || s.Blocks?.Palette || s.BlockData)) return readSponge(s)
  if (s && Array.isArray(s.Blocks) && Array.isArray(s.Data) && s.Width !== undefined) return readLegacySchematic(s)
  throw new Error('unknown format: expected a Sponge/WorldEdit .schem, a legacy MCEdit .schematic, a Litematica .litematic or a structure .nbt')
}

function checkVolume (w: number, h: number, d: number): void {
  if (!(w > 0 && h > 0 && d > 0)) throw new Error(`empty or broken size ${w}x${h}x${d}`)
  if (w * h * d > MAX_VOLUME) throw new Error(`too big: ${w}x${d}x${h} is over ${MAX_VOLUME} blocks of volume`)
}

/** Sponge schematic v1/v2 (Palette + BlockData) and v3 (Blocks.Palette + Blocks.Data). Varint indices, x fastest, then z, then y. */
export function readSponge (s: any): Structure {
  const w = Number(s.Width) & 0xffff
  const h = Number(s.Height) & 0xffff
  const d = Number(s.Length) & 0xffff
  checkVolume(w, h, d)
  const v3 = !!s.Blocks?.Palette
  const pal: Record<string, number> = v3 ? s.Blocks.Palette : s.Palette
  const data: number[] = v3 ? s.Blocks.Data : s.BlockData
  if (!pal || !Array.isArray(data)) throw new Error('sponge schematic without a palette or block data')
  const out = emptyStructure(w, h, d, `sponge v${s.Version ?? (v3 ? 3 : 2)}`)
  const byId = new Map<number, number>()
  const cache = new Map<string, number>()
  for (const [str, id] of Object.entries(pal)) byId.set(Number(id), paletteIndex(out, parseBlockString(str), cache))
  let i = 0
  let p = 0
  while (p < data.length && i < out.grid.length) {
    let value = 0
    let shift = 0
    let b: number
    do {
      b = data[p++]! & 0xff
      value |= (b & 0x7f) << shift
      shift += 7
      if (shift > 35) throw new Error('broken block data (varint too long)')
    } while (b & 0x80)
    // sponge order is (y * length + z) * width + x, the same as ours
    const idx = byId.get(value)
    if (idx === undefined) throw new Error(`block data uses palette id ${value}, not in the palette`)
    out.grid[i++] = idx
  }
  if (i < out.grid.length) throw new Error(`block data is short: ${i} of ${out.grid.length} blocks`)
  return out
}

/** Vanilla structure block file: size [x,y,z], palette (or palettes[0]), blocks [{ pos, state }]. Missing positions are structure void. */
export function readStructureNbt (root: any): Structure {
  const [w, h, d] = (root.size as number[]).map(Number) as [number, number, number]
  checkVolume(w, h, d)
  const pal: any[] = root.palette ?? root.palettes?.[0]
  if (!Array.isArray(pal)) throw new Error('structure file without a palette')
  const out = emptyStructure(w, h, d, 'structure')
  const cache = new Map<string, number>()
  const map = pal.map(e => paletteIndex(out, toEntry(e), cache))
  for (const b of root.blocks as any[]) {
    const [x, y, z] = (b.pos as number[]).map(Number) as [number, number, number]
    if (x < 0 || y < 0 || z < 0 || x >= w || y >= h || z >= d) continue
    const idx = map[Number(b.state)]
    if (idx === undefined) throw new Error(`block at ${x} ${y} ${z} uses palette entry ${b.state}, not in the palette`)
    out.grid[cellIndex(out, x, y, z)] = idx
  }
  return out
}

function toEntry (e: { Name?: string, id?: string, Properties?: Record<string, unknown> }): PaletteEntry {
  // a few mod structure files write the block name as "id"
  const out: PaletteEntry = { name: String(e.Name ?? e.id) }
  if (e.Properties && Object.keys(e.Properties).length) out.state = Object.fromEntries(Object.entries(e.Properties).map(([k, v]) => [k, String(v)]))
  return out
}

/** A long from prismarine-nbt ([high, low] int32 pair) as an unsigned 64-bit BigInt. */
const toU64 = (l: [number, number]) => BigInt.asUintN(64, (BigInt(l[0]) << 32n) | BigInt(l[1] >>> 0))

/**
 * Litematica: Regions, each with Position, Size (negative = extends the other way),
 * BlockStatePalette and BlockStates packed tightly at max(2, ceil(log2(palette))) bits per
 * entry, entries spanning two longs. Order (y * sizeZ + z) * sizeX + x. Regions are merged.
 */
export function readLitematic (root: any): Structure {
  const regions = Object.entries(root.Regions as Record<string, any>)
  if (!regions.length) throw new Error('litematic without regions')
  const boxes = regions.map(([name, r]) => {
    const size = { x: Number(r.Size.x), y: Number(r.Size.y), z: Number(r.Size.z) }
    const pos = { x: Number(r.Position.x), y: Number(r.Position.y), z: Number(r.Position.z) }
    const min = { x: pos.x + (size.x < 0 ? size.x + 1 : 0), y: pos.y + (size.y < 0 ? size.y + 1 : 0), z: pos.z + (size.z < 0 ? size.z + 1 : 0) }
    return { name, r, min, sx: Math.abs(size.x), sy: Math.abs(size.y), sz: Math.abs(size.z) }
  })
  const lo = { x: Math.min(...boxes.map(b => b.min.x)), y: Math.min(...boxes.map(b => b.min.y)), z: Math.min(...boxes.map(b => b.min.z)) }
  const w = Math.max(...boxes.map(b => b.min.x + b.sx)) - lo.x
  const h = Math.max(...boxes.map(b => b.min.y + b.sy)) - lo.y
  const d = Math.max(...boxes.map(b => b.min.z + b.sz)) - lo.z
  checkVolume(w, h, d)
  const out = emptyStructure(w, h, d, regions.length > 1 ? `litematica (${regions.length} regions)` : 'litematica')
  const cache = new Map<string, number>()
  for (const b of boxes) {
    checkVolume(b.sx, b.sy, b.sz)
    const pal: any[] = b.r.BlockStatePalette
    if (!Array.isArray(pal) || !pal.length) throw new Error(`region ${b.name} has no palette`)
    const map = pal.map(e => paletteIndex(out, toEntry(e), cache))
    const bits = BigInt(Math.max(2, Math.ceil(Math.log2(pal.length))))
    const mask = (1n << bits) - 1n
    const longs = (b.r.BlockStates as [number, number][]).map(toU64)
    const n = b.sx * b.sy * b.sz
    if (BigInt(longs.length) * 64n < BigInt(n) * bits) throw new Error(`region ${b.name}: block states are short`)
    for (let i = 0; i < n; i++) {
      const start = BigInt(i) * bits
      const word = Number(start / 64n)
      const off = start % 64n
      let v = (longs[word]! >> off) & mask
      if (off + bits > 64n) v |= (longs[word + 1]! << (64n - off)) & mask
      const idx = map[Number(v)]
      if (idx === undefined) throw new Error(`region ${b.name}: palette id ${v} out of range`)
      const x = i % b.sx
      const z = Math.floor(i / b.sx) % b.sz
      const y = Math.floor(i / (b.sx * b.sz))
      const name = out.palette[idx]!.name
      // regions overlap rarely; air from a later region doesn't erase blocks of an earlier one
      const at = cellIndex(out, b.min.x - lo.x + x, b.min.y - lo.y + y, b.min.z - lo.z + z)
      if (isAirName(name) && out.grid[at] !== DONT_CARE) continue
      out.grid[at] = idx
    }
  }
  return out
}

// ------------------------------------------------------------------ legacy MCEdit / WorldEdit 6 / Schematica

/**
 * Pre-1.13 numeric ids to 1.21 names. The id:data -> flattened table is minecraft-data's
 * pc/common/legacy.json (PrismarineJS, generated from Mojang's 1.13 data fixer); 1.12.2's
 * blocks.json gives the old name -> id map that Schematica files need. Only names renamed after
 * 1.13 are fixed up here.
 */
let legacyData: { blocks: Record<string, string>, oldIds: Map<string, number> } | null = null
function legacyTable () {
  if (!legacyData) {
    try {
      const req = createRequire(createRequire(import.meta.url).resolve('mineflayer'))
      const blocks = req('minecraft-data/minecraft-data/data/pc/common/legacy.json').blocks as Record<string, string>
      const old = req('minecraft-data')('1.12.2')
      legacyData = { blocks, oldIds: new Map(Object.values(old.blocksByName as Record<string, { name: string, id: number }>).map(b => [b.name, b.id])) }
    } catch (e) {
      throw new Error(`can't load the legacy block table from minecraft-data (${(e as Error).message.slice(0, 80)})`)
    }
  }
  return legacyData
}

/** Names that changed after 1.13 (legacy.json is the 1.13 flattening). */
const LEGACY_RENAME: Record<string, string> = { grass: 'short_grass', sign: 'oak_sign', wall_sign: 'oak_wall_sign', grass_path: 'dirt_path' }

/** One legacy id + data value as a 1.21 palette entry, or null when the id is unknown. */
export function legacyBlock (id: number, data: number): PaletteEntry | null {
  const t = legacyTable().blocks
  const str = t[`${id}:${data}`] ?? t[`${id}:0`]
  if (!str) return null
  const e = parseBlockString(str)
  let name = bare(e.name)
  // 1.13's stone_slab (smooth stone texture) became smooth_stone_slab in 1.14
  if (name === 'stone_slab' && (id === 43 || id === 44) && (data & 7) === 0) name = 'smooth_stone_slab'
  name = LEGACY_RENAME[name] ?? name
  const out: PaletteEntry = { name }
  if (e.state) {
    const st = { ...e.state }
    // the table guesses outer_right for every stair; the real shape follows from the neighbours
    if (/_stairs$/.test(name)) delete st.shape
    if (Object.keys(st).length) out.state = st
  }
  return out
}

const DOOR_OR_TALL = /(_door|^sunflower|^lilac|^rose_bush|^peony|^tall_grass|^large_fern)$/

/**
 * MCEdit / WorldEdit 6 / Schematica `.schematic` (Minecraft before 1.13): Width/Height/Length,
 * Blocks (low 8 bits of the id) with AddBlocks (or Add: high 4 bits, two per byte, even index
 * in the low nibble) and Data (4-bit values), order (y * length + z) * width + x. Schematica's
 * SchematicaMapping (name -> id in this file) is honoured. Ids the table doesn't know are left
 * out with a warning. The upper half of doors and tall plants takes its type (and a door its
 * facing) from the lower half, as the old format stored it only there.
 */
export function readLegacySchematic (s: any): Structure {
  const w = Number(s.Width) & 0xffff
  const h = Number(s.Height) & 0xffff
  const d = Number(s.Length) & 0xffff
  checkVolume(w, h, d)
  const materials = String(s.Materials ?? 'Alpha')
  if (materials !== 'Alpha') throw new Error(`"${materials}" schematics (other than Java edition "Alpha") aren't supported`)
  const ids: number[] = s.Blocks
  const data: number[] = s.Data
  const add: number[] | undefined = Array.isArray(s.AddBlocks) ? s.AddBlocks : Array.isArray(s.Add) ? s.Add : undefined
  const n = w * h * d
  if (ids.length < n || data.length < n) throw new Error(`block data is short: ${Math.min(ids.length, data.length)} of ${n} blocks`)
  const table = legacyTable()
  // Schematica: ids in the file are its own, the mapping gives the name for each
  let remap: Map<number, { vanilla?: number, modded?: string }> | null = null
  if (s.SchematicaMapping && typeof s.SchematicaMapping === 'object') {
    remap = new Map()
    for (const [name, id] of Object.entries(s.SchematicaMapping as Record<string, number>)) {
      const [ns, path] = name.includes(':') ? name.split(':') as [string, string] : ['minecraft', name]
      const vanilla = ns === 'minecraft' ? table.oldIds.get(path) : undefined
      remap.set(Number(id), vanilla !== undefined ? { vanilla } : { modded: ns === 'minecraft' ? path : name })
    }
  }
  const out = emptyStructure(w, h, d, remap ? 'schematica (legacy)' : 'mcedit (legacy)')
  const cache = new Map<string, number>()
  const byKey = new Map<number, number>()
  const unknown = new Map<number, number>()
  const modded = new Set<string>()
  for (let i = 0; i < n; i++) {
    let id = ids[i]! & 0xff
    if (add && (i >> 1) < add.length) id |= ((i & 1) === 0 ? add[i >> 1]! & 0x0f : (add[i >> 1]! & 0xf0) >> 4) << 8
    const dv = data[i]! & 0x0f
    let vid = id
    if (remap) {
      const m = remap.get(id)
      if (m?.modded) {
        modded.add(m.modded)
        out.grid[i] = paletteIndex(out, { name: m.modded.includes(':') ? m.modded : `legacy:${m.modded}` }, cache)
        continue
      }
      if (m?.vanilla === undefined) { if (id !== 0) unknown.set(id, (unknown.get(id) ?? 0) + 1); continue }
      vid = m.vanilla
    }
    const key = (vid << 4) | dv
    let idx = byKey.get(key)
    if (idx === undefined) {
      const e = legacyBlock(vid, dv)
      idx = e ? paletteIndex(out, e, cache) : DONT_CARE
      byKey.set(key, idx)
    }
    if (idx === DONT_CARE) { unknown.set(vid, (unknown.get(vid) ?? 0) + 1); continue }
    out.grid[i] = idx
  }
  // upper halves: name (and door facing/open) from the half below
  const fixed = new Map<string, { up: number, low: number }>()
  for (let y = 1; y < h; y++) {
    for (let z = 0; z < d; z++) {
      for (let x = 0; x < w; x++) {
        const at = cellIndex(out, x, y, z)
        const up = out.palette[out.grid[at]!]
        if (!up || up.state?.half !== 'upper' || !DOOR_OR_TALL.test(up.name)) continue
        const belowIdx = out.grid[cellIndex(out, x, y - 1, z)]!
        const low = out.palette[belowIdx]
        if (!low || low.state?.half !== 'lower' || !DOOR_OR_TALL.test(low.name)) continue
        const k = `${out.grid[at]}/${belowIdx}`
        let pair = fixed.get(k)
        if (!pair) {
          // a door's hinge is only in the upper half, everything else only in the lower one
          const door = /_door$/.test(low.name)
          const hinge = up.state.hinge ?? low.state.hinge ?? 'left'
          const upper: BlockState = door ? { ...low.state, half: 'upper', hinge } : { half: 'upper' }
          const lower: BlockState = door ? { ...low.state, hinge } : low.state
          pair = { up: paletteIndex(out, { name: low.name, state: upper }, cache), low: paletteIndex(out, { name: low.name, state: lower }, cache) }
          fixed.set(k, pair)
        }
        out.grid[at] = pair.up
        out.grid[cellIndex(out, x, y - 1, z)] = pair.low
      }
    }
  }
  const warnings: string[] = []
  if (unknown.size) warnings.push(`unknown legacy block ids left out: ${[...unknown].slice(0, 8).map(([id, c]) => `${id} (${c}x)`).join(', ')}`)
  if (modded.size) warnings.push(`Schematica mapping names blocks from mods (no state kept): ${[...modded].slice(0, 6).join(', ')}`)
  if (Array.isArray(s.TileEntities) && s.TileEntities.length) warnings.push('tile entities (chest contents, sign text, bed colours, skull types) are not imported')
  if (warnings.length) out.warnings = warnings
  return out
}

// ------------------------------------------------------------------ Axiom .bp

export const AXIOM_MAGIC = 0x0ae5bb36

/**
 * Axiom blueprint (.bp): int magic 0x0AE5BB36, then length-prefixed header NBT (name, author,
 * block count; not compressed), a length-prefixed PNG thumbnail, and length-prefixed gzipped
 * NBT whose BlockRegion list holds 16x16x16 sections ({X, Y, Z} in section units, BlockStates
 * {palette, data}) packed like 1.16+ chunk sections: max(4, ceil(log2(palette))) bits, entries
 * never span two longs, order (y * 16 + z) * 16 + x. Layout as read by PiTheGuy/SchemConvert.
 */
export async function readAxiom (buf: Buffer): Promise<Structure> {
  let o = 4
  const chunk = (what: string) => {
    if (o + 4 > buf.length) throw new Error(`axiom blueprint cut short before the ${what}`)
    const n = buf.readInt32BE(o)
    if (n < 0 || o + 4 + n > buf.length) throw new Error(`axiom blueprint: broken ${what} length`)
    const out = buf.subarray(o + 4, o + 4 + n)
    o += 4 + n
    return out
  }
  const header = chunk('header')
  chunk('thumbnail')
  let data = chunk('block data')
  let name = ''
  try { name = String(nbt.simplify((await nbt.parse(header, 'big')).parsed).Name ?? '') } catch {}
  try { data = gunzipSync(data, { maxOutputLength: MAX_UNZIPPED }) } catch (e) { throw new Error(`axiom blueprint: can't unzip the blocks (${(e as Error).message.slice(0, 80)})`) }
  const root = nbt.simplify((await nbt.parse(data, 'big')).parsed)
  const regions: any[] = root.BlockRegion
  if (!Array.isArray(regions) || !regions.length) throw new Error('axiom blueprint without block regions')
  const xs = regions.map(r => Number(r.X)); const ys = regions.map(r => Number(r.Y)); const zs = regions.map(r => Number(r.Z))
  const lo = { x: Math.min(...xs), y: Math.min(...ys), z: Math.min(...zs) }
  const w = (Math.max(...xs) - lo.x + 1) * 16
  const h = (Math.max(...ys) - lo.y + 1) * 16
  const d = (Math.max(...zs) - lo.z + 1) * 16
  checkVolume(w, h, d)
  const out = emptyStructure(w, h, d, 'axiom')
  const cache = new Map<string, number>()
  for (const r of regions) {
    const pal: any[] = r.BlockStates?.palette
    if (!Array.isArray(pal) || !pal.length) throw new Error(`axiom section ${r.X} ${r.Y} ${r.Z} has no palette`)
    const map = pal.map(e => paletteIndex(out, toEntry(e), cache))
    const bits = BigInt(Math.max(4, Math.ceil(Math.log2(pal.length))))
    const perLong = Math.floor(64 / Number(bits))
    const longs = Array.isArray(r.BlockStates.data) ? (r.BlockStates.data as [number, number][]).map(toU64) : null
    if (pal.length > 1 && (!longs || longs.length * perLong < 4096)) throw new Error(`axiom section ${r.X} ${r.Y} ${r.Z}: block states are short`)
    const mask = (1n << bits) - 1n
    const bx = (Number(r.X) - lo.x) * 16; const by = (Number(r.Y) - lo.y) * 16; const bz = (Number(r.Z) - lo.z) * 16
    for (let i = 0; i < 4096; i++) {
      const v = longs ? Number((longs[Math.floor(i / perLong)]! >> (BigInt(i % perLong) * bits)) & mask) : 0
      const idx = map[v]
      if (idx === undefined) throw new Error(`axiom section ${r.X} ${r.Y} ${r.Z}: palette id ${v} out of range`)
      out.grid[cellIndex(out, bx + (i & 15), by + (i >> 8), bz + ((i >> 4) & 15))] = idx
    }
  }
  if (name) out.format = `axiom (${name})`
  return out
}

// ------------------------------------------------------------------ crop / trim / limits

const bare = (name: string) => name.replace(/^minecraft:/, '')

export const isAirName = (name: string) => /^(minecraft:)?(air|cave_air|void_air)$/.test(name)

/** Blocks that are never placed: kept out of the blueprint (with a warning when they matter). */
const SKIP_SILENT = /^(structure_void)$/
const SKIP_WARN = /^(water|lava|bubble_column|fire|soul_fire|piston_head|moving_piston|barrier|light|jigsaw|spawner|trial_spawner|vault|structure_block|command_block|chain_command_block|repeating_command_block|nether_portal|end_portal|end_gateway|frosted_ice|modded_block)$/

export type BlockClass = 'air' | 'skip' | 'block'

export function classify (e: PaletteEntry): BlockClass {
  if (isAirName(e.name)) return 'air'
  const n = bare(e.name)
  if (SKIP_SILENT.test(n) || SKIP_WARN.test(n)) return 'skip'
  return 'block'
}

/** Number of blocks that would be placed (not air, not skipped, not passive halves). */
export function countBlocks (s: Structure): number {
  const placed = s.palette.map(e => classify(e) === 'block' && !(e.state?.half === 'upper' || e.state?.part === 'head'))
  let n = 0
  for (const i of s.grid) if (i >= 0 && placed[i]) n++
  return n
}

export interface Box { x1: number, y1: number, z1: number, x2: number, y2: number, z2: number }

/** A sub-box (inclusive local coordinates, any corner order), clamped to the structure. */
export function cropStructure (s: Structure, b: Box): Structure {
  const x1 = Math.max(0, Math.min(b.x1, b.x2))
  const y1 = Math.max(0, Math.min(b.y1, b.y2))
  const z1 = Math.max(0, Math.min(b.z1, b.z2))
  const x2 = Math.min(s.width - 1, Math.max(b.x1, b.x2))
  const y2 = Math.min(s.height - 1, Math.max(b.y1, b.y2))
  const z2 = Math.min(s.depth - 1, Math.max(b.z1, b.z2))
  if (x2 < x1 || y2 < y1 || z2 < z1) throw new Error(`crop box ${b.x1} ${b.y1} ${b.z1} ${b.x2} ${b.y2} ${b.z2} is outside the ${s.width}x${s.height}x${s.depth} structure`)
  const out = emptyStructure(x2 - x1 + 1, y2 - y1 + 1, z2 - z1 + 1, s.format)
  out.palette = s.palette
  if (s.warnings) out.warnings = s.warnings
  for (let y = y1; y <= y2; y++) for (let z = z1; z <= z2; z++) for (let x = x1; x <= x2; x++) out.grid[cellIndex(out, x - x1, y - y1, z - z1)] = s.grid[cellIndex(s, x, y, z)]!
  return out
}

/** Bounding box of the blocks that get placed, or null when there are none. */
export function blockBounds (s: Structure): Box | null {
  const placed = s.palette.map(e => classify(e) === 'block')
  let b: Box | null = null
  for (let y = 0; y < s.height; y++) {
    for (let z = 0; z < s.depth; z++) {
      for (let x = 0; x < s.width; x++) {
        const i = s.grid[cellIndex(s, x, y, z)]!
        if (i < 0 || !placed[i]) continue
        if (!b) b = { x1: x, y1: y, z1: z, x2: x, y2: y, z2: z }
        else { b.x1 = Math.min(b.x1, x); b.y1 = Math.min(b.y1, y); b.z1 = Math.min(b.z1, z); b.x2 = Math.max(b.x2, x); b.y2 = Math.max(b.y2, y); b.z2 = Math.max(b.z2, z) }
      }
    }
  }
  return b
}

/** Drops the empty margin around the blocks. */
export function trimStructure (s: Structure): Structure {
  const b = blockBounds(s)
  if (!b) throw new Error('no blocks to place in it (only air or blocks the bot never places)')
  if (b.x1 === 0 && b.y1 === 0 && b.z1 === 0 && b.x2 === s.width - 1 && b.y2 === s.height - 1 && b.z2 === s.depth - 1) return s
  return cropStructure(s, b)
}

/** A crop that fits under the block limit: the bottom layers, as many as fit. Null when one layer is already too much. */
export function suggestCrop (s: Structure, limit: number): Box | null {
  let best: Box | null = null
  for (let y = 0; y < s.height; y++) {
    const box = { x1: 0, y1: 0, z1: 0, x2: s.width - 1, y2: y, z2: s.depth - 1 }
    if (countBlocks(cropStructure(s, box)) > limit) break
    best = box
  }
  return best
}

export const fmtBox = (b: Box) => `${b.x1} ${b.y1} ${b.z1} ${b.x2} ${b.y2} ${b.z2}`

export function parseBox (text: string): Box | null {
  const n = text.trim().split(/[\s,]+/).map(Number)
  if (n.length !== 6 || n.some(v => !Number.isInteger(v))) return null
  return { x1: n[0]!, y1: n[1]!, z1: n[2]!, x2: n[3]!, y2: n[4]!, z2: n[5]! }
}

// ------------------------------------------------------------------ to blueprint YAML

/** State properties the builder can place or check; the rest follow from neighbours (fence sides, waterlogged...). */
const KEEP_STATE = new Set(['facing', 'half', 'type', 'axis', 'hinge', 'open', 'hanging', 'part', 'face', 'attachment', 'rotation', 'shape'])

/** The state worth keeping for a block: placeable properties with values the format accepts. */
export function cleanState (name: string, state: BlockState | undefined): BlockState | undefined {
  if (!state) return undefined
  const stairs = /_stairs$/.test(name)
  const out: BlockState = {}
  for (const [k, v] of Object.entries(state)) {
    if (!KEEP_STATE.has(k)) continue
    if (k === 'shape' && !stairs) continue // rails and the like: follows the neighbours
    if (!validStateValue(k, v)) continue // chest type=single, ...
    out[k] = v
  }
  return Object.keys(out).length ? out : undefined
}

// palette characters: mnemonic first letter when free, then these, then more from Unicode
const POOL = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuwxyz0123456789#%&*+=?@~$!/;:()[]{}|-_,']
const EXTRA = Array.from({ length: 300 }, (_, i) => String.fromCodePoint(0xc0 + i)).filter(c => /\p{L}/u.test(c) && c !== '×' && c !== '÷')

function pickGlyphs (entries: PaletteEntry[]): string[] {
  const used = new Set<string>(['.', ' ', '^', 'v', '<', '>', '"', "'", '\\', '`'])
  const take = (c: string) => { used.add(c); return c }
  return entries.map(e => {
    const n = bare(e.name).replace(/^[a-z0-9_.-]+:/, '')
    const first = n.replace(/^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|stripped|polished|smooth|cut|chiseled|mossy|cracked)_/, '')[0] ?? 'x'
    for (const c of [first.toUpperCase(), first.toLowerCase()]) if (/[a-zA-Z0-9]/.test(c) && !used.has(c)) return take(c)
    const free = POOL.find(c => !used.has(c)) ?? EXTRA.find(c => !used.has(c))
    if (!free) throw new Error('too many different blocks for one blueprint (over 300)')
    return take(free)
  })
}

const WOOD_NAMES = 'oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak'
/** Overworld wooden building blocks: wood and kind. */
const WOODEN = new RegExp(`^(${WOOD_NAMES})_(planks|stairs|slab|log|wood|fence|fence_gate|door|trapdoor|pressure_plate|button)$`)

export interface ToBlueprintOptions {
  name: string
  description?: string
  /** Entrance side as the structure lies; default: the side the first door is on, else south. */
  facing?: Facing
  /** Keep air cells as "must be clear" (.); false leaves them as don't care. Default true. */
  air?: boolean
  meta?: Record<string, unknown>
  /**
   * Wooden blocks accept any wood and follow the build's wood theme (default true), when the
   * structure uses one wood per kind of block; false keeps every block exact.
   */
  anyWood?: boolean
  /** Known block names (vanilla registry); unknown ones are kept with a warning. Default: minecraft-data 1.21.1. */
  knownBlock?: (name: string) => boolean
}

export interface BlueprintText { yaml: string, warnings: string[], facing: Facing, width: number, depth: number, height: number, blocks: number }

let vanilla: { blocks: Set<string>, items: Set<string> } | null = null
function registry () {
  if (!vanilla) {
    try {
      const req = createRequire(createRequire(import.meta.url).resolve('mineflayer'))
      const md = req('minecraft-data')('1.21.1')
      vanilla = { blocks: new Set(Object.keys(md.blocksByName)), items: new Set(Object.keys(md.itemsByName)) }
    } catch {
      vanilla = { blocks: new Set(), items: new Set() }
    }
  }
  return vanilla
}

/** Vanilla 1.21.1 block names from minecraft-data (mineflayer's own copy). True when the data can't be loaded. */
export function isVanillaBlock (name: string): boolean {
  const r = registry()
  return r.blocks.size === 0 || r.blocks.has(bare(name))
}

/** A vanilla block or item name (role defaults can be items: redstone, string). */
export function isVanillaBlockOrItem (name: string): boolean {
  const r = registry()
  return r.blocks.size === 0 || r.blocks.has(bare(name)) || r.items.has(bare(name))
}

/** Block names that changed between versions, old (or newer) name -> the 1.21.1 one. */
const RENAMED: Record<string, string> = { grass: 'short_grass', grass_path: 'dirt_path', iron_chain: 'chain', sign: 'oak_sign', wall_sign: 'oak_wall_sign' }

/** A name the registry doesn't know, mapped to its 1.21.1 spelling when that one is known. */
function renamed (name: string, known: (n: string) => boolean): string {
  const to = RENAMED[name]
  return to && !known(name) && known(to) ? to : name
}

/**
 * Writes a structure as blueprint YAML. Blocks become plain palette entries with their
 * placeable state; air becomes "." (must be clear) unless `air` is false; water, portals,
 * command blocks and such are left out with a warning; modded and unknown blocks stay, with a
 * warning (the bot can only place what it carries). States stay as they are in the source:
 * the drawing is the structure as it lies (north up), and `facing` says where its entrance is,
 * so a rotated build turns every state with it.
 */
export function structureToYaml (input: Structure, opts: ToBlueprintOptions): BlueprintText {
  const s = trimStructure(input)
  const warnings: string[] = [...(input.warnings ?? [])]
  const known = opts.knownBlock ?? isVanillaBlock
  const cls = s.palette.map(classify)
  const used = new Set<number>()
  for (const i of s.grid) if (i >= 0) used.add(i)
  const skipped = new Set<string>()
  // palette entries that end up in the blueprint, merged when cleaning states makes two the same
  const entries: PaletteEntry[] = []
  const toEntry = new Map<number, number>()
  const byKey = new Map<string, number>()
  for (const i of [...used].sort((a, b) => a - b)) {
    if (cls[i] !== 'block') {
      if (cls[i] === 'skip' && !SKIP_SILENT.test(bare(s.palette[i]!.name))) skipped.add(bare(s.palette[i]!.name))
      continue
    }
    const src = s.palette[i]!
    const e: PaletteEntry = { name: renamed(bare(src.name), known) }
    const st = cleanState(e.name, src.state)
    if (st) e.state = st
    const k = stateKey(e)
    if (!byKey.has(k)) { byKey.set(k, entries.length); entries.push(e) }
    toEntry.set(i, byKey.get(k)!)
  }
  if (skipped.size) warnings.push(`left out (never placed): ${[...skipped].join(', ')}`)
  const modded = [...new Set(entries.filter(e => e.name.includes(':')).map(e => e.name))]
  if (modded.length) warnings.push(`modded blocks kept as plain blocks (the bot needs to carry them): ${modded.slice(0, 8).join(', ')}${modded.length > 8 ? ` and ${modded.length - 8} more` : ''}`)
  const unknown = [...new Set(entries.filter(e => !e.name.includes(':') && !known(e.name)).map(e => e.name))]
  if (unknown.length) warnings.push(`unknown blocks kept as plain blocks: ${unknown.slice(0, 8).join(', ')}`)
  const glyphs = pickGlyphs(entries)
  const keepAir = opts.air !== false
  const layers: string[][] = []
  let blocks = 0
  let firstDoor: { x: number, z: number } | null = null
  for (let y = 0; y < s.height; y++) {
    const rows: string[] = []
    for (let z = 0; z < s.depth; z++) {
      let row = ''
      for (let x = 0; x < s.width; x++) {
        const i = s.grid[cellIndex(s, x, y, z)]!
        if (i < 0) { row += ' '; continue }
        if (cls[i] === 'air') { row += keepAir ? '.' : ' '; continue }
        const e = toEntry.get(i)
        if (e === undefined) { row += ' '; continue }
        row += glyphs[e]
        const ent = entries[e]!
        if (!(ent.state?.half === 'upper' || ent.state?.part === 'head')) blocks++
        if (!firstDoor && kindForBlock(ent.name) === 'door') firstDoor = { x, z }
      }
      rows.push(row.replace(/ +$/, ''))
    }
    layers.push(rows)
  }
  const facing = opts.facing ?? (firstDoor ? facingToward({ x: (s.width - 1) / 2, z: (s.depth - 1) / 2 }, firstDoor) : 'south')
  const head: Record<string, unknown> = {
    name: opts.name,
    description: opts.description || `${opts.name.replace(/_/g, ' ')} (${s.format})`,
    facing,
    site: 'near'
  }
  // library metadata: whatever the caller gives, plus size, block count and the main materials
  const mats = new Map<string, number>()
  for (let i = 0; i < s.grid.length; i++) {
    const e = toEntry.get(s.grid[i]!)
    if (e === undefined) continue
    const ent = entries[e]!
    if (ent.state?.half === 'upper' || ent.state?.part === 'head') continue
    const item = itemForBlock(ent.name)
    mats.set(item, (mats.get(item) ?? 0) + 1)
  }
  head.meta = { ...opts.meta, size: [s.width, s.depth, s.height], blocks, materials: Object.fromEntries([...mats].sort((a, b) => b[1] - a[1]).slice(0, 6)) }
  // short lists and the materials map on one line each
  const doc = new YAML.Document(head)
  YAML.visit(doc, { Seq (_, n) { n.flow = true }, Map (_, n, path) { if (path.length > 3) n.flow = true } })
  // spruce stairs from a capture should be fine as oak stairs in survival: one role per kind of
  // wooden block, unless the build mixes woods for that kind on purpose
  const woodRole = new Map<string, string>()
  if (opts.anyWood !== false) {
    const bySuffix = new Map<string, Set<string>>()
    for (const e of entries) {
      const m = WOODEN.exec(e.name)
      if (m) bySuffix.set(m[2]!, (bySuffix.get(m[2]!) ?? new Set()).add(m[1]!))
    }
    for (const e of entries) {
      const m = WOODEN.exec(e.name)
      if (m && bySuffix.get(m[2]!)!.size === 1) woodRole.set(e.name, m[2]!)
    }
  }
  const roles = [...new Set(woodRole.values())].map(suffix => {
    const item = itemForBlock(entries.find(e => woodRole.get(e.name) === suffix)!.name)
    const isLog = /^(log|wood)$/.test(suffix)
    const kind = kindForBlock(item)
    return `  wood_${suffix}: { default: ${item}, accept: "^(${WOOD_NAMES})_${isLog ? '(log|wood)' : suffix}$", wood: true${kind === 'block' ? '' : `, kind: ${kind}`} }`
  })
  const lines = [doc.toString({ lineWidth: 0 }).trimEnd(), roles.length ? 'roles:' : 'roles: {}', ...roles, 'palette:']
  entries.forEach((e, i) => {
    const r = woodRole.get(e.name)
    const v = r ? (e.state ? { role: `wood_${r}`, state: e.state } : { role: `wood_${r}` }) : (e.state ? { block: e.name, state: e.state } : { block: e.name })
    lines.push(`  ${JSON.stringify(glyphs[i])}: ${JSON.stringify(v)}`)
  })
  if (keepAir && s.grid.some(i => i >= 0 && cls[i] === 'air')) lines.push('  ".": air')
  lines.push('layers:')
  layers.forEach((rows, y) => {
    lines.push(`  # y=${y}`)
    lines.push(`  - [${rows.map(r => JSON.stringify(r)).join(',\n     ')}]`)
  })
  return { yaml: lines.join('\n') + '\n', warnings, facing, width: s.width, depth: s.depth, height: s.height, blocks }
}

// ------------------------------------------------------------------ capture from the world

export interface WorldBlock { name: string, state?: Record<string, unknown> }

export interface CaptureOptions {
  /** Keep natural blocks (ground, plants, leaves) too. Default false: only what players built. */
  all?: boolean
  /** Natural-block test (blueprint.ts isNaturalBlock). */
  isNatural: (name: string) => boolean
}

/**
 * Reads a box of the world (inclusive corners) into a Structure. By default only player-made
 * blocks are kept; natural blocks and air outside the build are "don't care", air enclosed by
 * the build in its row and column (rooms, doorways) stays "must be clear". Throws when a block
 * is not loaded.
 */
export function captureStructure (blockAt: (x: number, y: number, z: number) => WorldBlock | undefined | null, min: { x: number, y: number, z: number }, max: { x: number, y: number, z: number }, opts: CaptureOptions): Structure {
  const w = max.x - min.x + 1
  const h = max.y - min.y + 1
  const d = max.z - min.z + 1
  checkVolume(w, h, d)
  const out = emptyStructure(w, h, d, 'world')
  const cache = new Map<string, number>()
  const air: number[] = []
  for (let y = 0; y < h; y++) {
    for (let z = 0; z < d; z++) {
      for (let x = 0; x < w; x++) {
        const b = blockAt(min.x + x, min.y + y, min.z + z)
        if (!b) throw new Error(`the block at ${min.x + x} ${min.y + y} ${min.z + z} isn't loaded; stand closer to the region`)
        const name = bare(b.name)
        const at = cellIndex(out, x, y, z)
        if (isAirName(name) || /^(short_grass|tall_grass|fern|large_fern|snow)$/.test(name) && !opts.all) { air.push(at); continue }
        if (!opts.all && opts.isNatural(name)) continue
        const state = b.state && Object.keys(b.state).length ? Object.fromEntries(Object.entries(b.state).map(([k, v]) => [k, String(v)])) : undefined
        out.grid[at] = paletteIndex(out, state ? { name, state } : { name }, cache)
      }
    }
  }
  // air between built blocks along both its row (x) and its column (z) is part of the build
  const airIdx = paletteIndex(out, { name: 'air' }, cache)
  const built = (x: number, y: number, z: number) => out.grid[cellIndex(out, x, y, z)]! >= 0 && out.grid[cellIndex(out, x, y, z)] !== airIdx
  for (const at of air) {
    const x = at % w
    const z = Math.floor(at / w) % d
    const y = Math.floor(at / (w * d))
    let west = false; let east = false; let north = false; let south = false
    for (let i = x - 1; i >= 0 && !west; i--) west = built(i, y, z)
    for (let i = x + 1; i < w && !east; i++) east = built(i, y, z)
    for (let i = z - 1; i >= 0 && !north; i--) north = built(x, y, i)
    for (let i = z + 1; i < d && !south; i++) south = built(x, y, i)
    if (opts.all || (west && east && north && south)) out.grid[at] = airIdx
  }
  return out
}

// ------------------------------------------------------------------ import

/** Ground cover a bot can't pick up as it is (it drops dirt, or needs silk touch or a hoe). */
const GROUND_TO_DIRT = /^(grass_block|coarse_dirt|podzol|rooted_dirt|mycelium|dirt_path|farmland|moss_block)$/

/**
 * Structure files from mods and datapacks carry the ground and plants around a building. Ground
 * cover (grass, paths, podzol, farmland...) becomes dirt, so whatever stands on it is still
 * supported; plants, crops and leaves become "don't care". Returns the copy and what changed.
 */
export function dropTerrain (s: Structure): { s: Structure, dropped: string[], dirt: string[] } {
  const drop = s.palette.map(e => !GROUND_TO_DIRT.test(bare(e.name)) && isGroundOrPlant(bare(e.name)) && bare(e.name) !== 'dirt')
  const toDirt = s.palette.map(e => GROUND_TO_DIRT.test(bare(e.name)))
  if (!drop.some(Boolean) && !toDirt.some(Boolean)) return { s, dropped: [], dirt: [] }
  const out: Structure = { ...s, palette: s.palette.slice(), grid: s.grid.slice() }
  const dirtIdx = toDirt.some(Boolean) ? paletteIndex(out, { name: 'minecraft:dirt' }) : -1
  const dropped = new Set<string>()
  const dirt = new Set<string>()
  for (let i = 0; i < out.grid.length; i++) {
    const p = out.grid[i]!
    if (p < 0 || p >= drop.length) continue
    if (drop[p]) { dropped.add(bare(s.palette[p]!.name)); out.grid[i] = DONT_CARE } else if (toDirt[p]) { dirt.add(bare(s.palette[p]!.name)); out.grid[i] = dirtIdx }
  }
  return { s: out, dropped: [...dropped], dirt: [...dirt] }
}

export interface ImportOptions extends ToBlueprintOptions {
  /** false: ground cover becomes dirt, plants, crops and leaves are left out (dropTerrain). Default true: kept as they are. */
  terrain?: boolean
  /** Refuse above this many placed blocks (after crop and trim). */
  maxBlocks: number
  /** Keep only this box (local coordinates of the file, 0 0 0 = lowest north-west corner). */
  crop?: Box
}

/**
 * A schematic as blueprint YAML: crop, trim the empty margin, check the block limit (with a
 * crop suggestion when it's over), convert, and parse the result once so it surely loads.
 */
export function importStructure (input: Structure, opts: ImportOptions): BlueprintText {
  if (opts.terrain === false) {
    const t = dropTerrain(input)
    const notes: string[] = []
    const list = (a: string[]) => `${a.slice(0, 8).join(', ')}${a.length > 8 ? ` and ${a.length - 8} more` : ''}`
    if (t.dropped.length) notes.push(`left out plants and leaves: ${list(t.dropped)}`)
    if (t.dirt.length) notes.push(`ground cover made dirt: ${list(t.dirt)}`)
    input = notes.length ? { ...t.s, warnings: [...(t.s.warnings ?? []), ...notes] } : t.s
  }
  const s = opts.crop ? cropStructure(input, opts.crop) : input
  const b = blockBounds(s)
  if (!b) throw new Error('no blocks to place in it (only air or blocks the bot never places)')
  const trimmed = trimStructure(s)
  const n = countBlocks(trimmed)
  if (n > opts.maxBlocks) {
    const c = suggestCrop(trimmed, opts.maxBlocks)
    const off = opts.crop ? { x: Math.min(opts.crop.x1, opts.crop.x2), y: Math.min(opts.crop.y1, opts.crop.y2), z: Math.min(opts.crop.z1, opts.crop.z2) } : { x: 0, y: 0, z: 0 }
    const shift = (box: Box): Box => ({ x1: box.x1 + b.x1 + off.x, y1: box.y1 + b.y1 + off.y, z1: box.z1 + b.z1 + off.z, x2: box.x2 + b.x1 + off.x, y2: box.y2 + b.y1 + off.y, z2: box.z2 + b.z1 + off.z })
    const hint = c ? `; crop it, e.g. crop="${fmtBox(shift(c))}" keeps the bottom ${c.y2 + 1} of ${trimmed.height} layers` : ''
    throw new Error(`${trimmed.width}x${trimmed.depth}x${trimmed.height} with ${n} blocks is over the limit of ${opts.maxBlocks}${hint} (crop is "x1 y1 z1 x2 y2 z2" in the file's own coordinates, size ${input.width}x${input.height}x${input.depth} as x y z), or raise the limit`)
  }
  const out = structureToYaml(trimmed, opts)
  parseBlueprint(out.yaml, `${opts.name} (converted)`)
  return out
}
