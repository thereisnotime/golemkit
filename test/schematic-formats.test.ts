// More schematic formats: legacy MCEdit/WorldEdit 6 .schematic (numeric ids), Schematica's
// mapping, WorldEdit 7's extras in a Sponge .schem, gzipped Create structure files, and
// format detection by content. Every fixture is generated here with prismarine-nbt.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import nbt from 'prismarine-nbt'
import { parseBlueprint } from '../src/skills/blueprint.ts'
import { readSchematic, importStructure, legacyBlock, cellIndex } from '../src/skills/schematic.ts'

const int = (value: number) => ({ type: 'int', value })
const short = (value: number) => ({ type: 'short', value })
const str = (value: string) => ({ type: 'string', value })
const bytes = (value: number[]) => ({ type: 'byteArray', value: value.map(v => v << 24 >> 24) })
const compound = (value: Record<string, unknown>, name = '') => ({ type: 'compound', name, value })
const list = (type: string, value: unknown[]) => ({ type: 'list', value: { type, value } })
const write = (root: unknown, gzip = true) => { const raw = nbt.writeUncompressed(root as never, 'big'); return gzip ? gzipSync(raw) : raw }

/**
 * A 3x3x3 legacy hut: cobblestone floor (4), oak plank walls (5), an oak door on the south side
 * (64: lower data 3 = facing north, upper data 8 = left hinge), a chest facing north (54:2),
 * water above it (9), stairs (53:2) and an unknown id 253 in one corner of the top ring.
 */
function legacyHut (opts: { add?: boolean } = {}) {
  const W = 3; const H = 3; const D = 3
  const ids: number[] = []; const data: number[] = []
  for (let y = 0; y < H; y++) for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) {
    let id = 5; let dv = 0
    if (y === 0) id = 4
    else if (x === 1 && z === 2) { id = 64; dv = y === 1 ? 3 : 8 }
    else if (x === 1 && z === 1) { if (y === 1) { id = 54; dv = 2 } else id = 9 }
    else if (y === 2 && x === 2 && z === 0) { id = 53; dv = 2 }
    else if (y === 2 && (x === 0 && z === 0)) id = 253
    ids.push(id); data.push(dv)
  }
  const tag: Record<string, unknown> = {
    Width: short(W), Height: short(H), Length: short(D), Materials: str('Alpha'),
    Blocks: bytes(ids), Data: bytes(data),
    WEOffsetX: int(-1), WEOffsetY: int(0), WEOffsetZ: int(-1), WEOriginX: int(100), WEOriginY: int(64), WEOriginZ: int(100),
    Entities: list('compound', []), TileEntities: list('compound', [{ id: str('Chest'), x: int(1), y: int(1), z: int(1) }])
  }
  if (opts.add) {
    // AddBlocks: cell 1 (odd, high nibble) gets id 1 << 8 | 4 = 260, unknown
    const add = new Array(Math.ceil(W * H * D / 2)).fill(0)
    add[0] = 0x10
    tag.AddBlocks = bytes(add)
  }
  return write(compound(tag, 'Schematic'))
}

test('legacy .schematic: ids and data values become 1.21 blocks with states', async () => {
  const s = await readSchematic(legacyHut())
  assert.equal(s.format, 'mcedit (legacy)')
  assert.deepEqual([s.width, s.height, s.depth], [3, 3, 3])
  const at = (x: number, y: number, z: number) => s.palette[s.grid[cellIndex(s, x, y, z)]!]
  assert.equal(at(0, 0, 0)?.name, 'cobblestone')
  assert.equal(at(0, 1, 0)?.name, 'oak_planks')
  assert.deepEqual(at(1, 1, 2), { name: 'oak_door', state: { hinge: 'left', half: 'lower', powered: 'false', facing: 'north', open: 'false' } })
  // the upper half keeps its hinge and takes facing from the lower half
  assert.equal(at(1, 2, 2)?.name, 'oak_door')
  assert.equal(at(1, 2, 2)?.state?.half, 'upper')
  assert.equal(at(1, 2, 2)?.state?.facing, 'north')
  assert.equal(at(1, 2, 2)?.state?.hinge, 'left')
  assert.equal(at(1, 1, 1)?.name, 'chest')
  assert.equal(at(1, 1, 1)?.state?.facing, 'north')
  // stairs: facing and half from the data value, no made-up shape
  assert.deepEqual(at(2, 2, 0), { name: 'oak_stairs', state: { half: 'bottom', facing: 'south' } })
  assert.equal(s.grid[cellIndex(s, 0, 2, 0)], -1, 'unknown id is left out')
  assert.match(s.warnings!.join(' '), /unknown legacy block ids left out: 253 \(1x\)/)
  assert.match(s.warnings!.join(' '), /tile entities/)

  const out = importStructure(s, { name: 'legacy_hut', maxBlocks: 4000 })
  assert.match(out.warnings.join(' '), /253/, 'reader warnings reach the import')
  assert.match(out.warnings.join(' '), /left out \(never placed\): water/)
  const bp = parseBlueprint(out.yaml, 'legacy_hut')
  assert.equal(bp.facing, 'south', 'entrance on the side of the door')
})

test('legacy .schematic: AddBlocks high nibbles and the renames after 1.13', async () => {
  const s = await readSchematic(legacyHut({ add: true }))
  assert.match(s.warnings!.join(' '), /260 \(1x\)/)
  assert.equal(legacyBlock(31, 1)?.name, 'short_grass')
  assert.equal(legacyBlock(208, 0)?.name, 'dirt_path')
  assert.equal(legacyBlock(63, 4)?.name, 'oak_sign')
  assert.equal(legacyBlock(68, 2)?.name, 'oak_wall_sign')
  assert.deepEqual(legacyBlock(44, 0), { name: 'smooth_stone_slab', state: { type: 'bottom' } })
  assert.deepEqual(legacyBlock(44, 3), { name: 'cobblestone_slab', state: { type: 'bottom' } })
  assert.deepEqual(legacyBlock(17, 4), { name: 'oak_log', state: { axis: 'x' } })
  assert.equal(legacyBlock(98, 0)?.name, 'stone_bricks')
  assert.equal(legacyBlock(139, 0)?.name, 'cobblestone_wall')
  assert.equal(legacyBlock(5, 13)?.name, 'oak_planks', 'unused data value falls back to :0')
  assert.equal(legacyBlock(4000, 0), null)
})

test('legacy .schematic: tall plants take their type from the lower half; Pocket files are refused', async () => {
  // rose bush lower (175:4) under a generic upper half (175:8 = data 8)
  const tag = { Width: short(1), Height: short(2), Length: short(1), Materials: str('Alpha'), Blocks: bytes([175, 175]), Data: bytes([4, 8]) }
  const s = await readSchematic(write(compound(tag, 'Schematic')))
  assert.equal(s.palette[s.grid[0]!]!.name, 'rose_bush')
  assert.equal(s.palette[s.grid[1]!]!.name, 'rose_bush')
  assert.equal(s.palette[s.grid[1]!]!.state?.half, 'upper')
  await assert.rejects(readSchematic(write(compound({ ...tag, Materials: str('Pocket') }, 'Schematic'))), /Pocket/)
})

test('Schematica .schematic: SchematicaMapping ids, modded names kept with a warning', async () => {
  const tag = {
    Width: short(3), Height: short(1), Length: short(1), Materials: str('Alpha'),
    Blocks: bytes([7, 9, 12]), Data: bytes([0, 0, 0]),
    SchematicaMapping: compound({ 'minecraft:cobblestone': short(7), 'minecraft:planks': short(9), 'create:shaft': short(12) })
  }
  const s = await readSchematic(write(compound(tag, 'Schematic')))
  assert.equal(s.format, 'schematica (legacy)')
  assert.deepEqual([0, 1, 2].map(i => s.palette[s.grid[i]!]!.name), ['cobblestone', 'oak_planks', 'create:shaft'])
  assert.match(s.warnings!.join(' '), /create:shaft/)
})

test('WorldEdit 7 .schem: metadata, offsets, block entities, biomes and entities do not get in the way', async () => {
  const pal = { 'minecraft:stone_bricks': int(0), 'minecraft:chest[facing=west,type=single,waterlogged=false]': int(1), 'minecraft:air': int(2) }
  const v3 = write(compound({
    Schematic: compound({
      Version: int(3), DataVersion: int(3955), Width: short(3), Height: short(1), Length: short(1),
      Offset: { type: 'intArray', value: [-1, 0, -1] },
      Metadata: compound({ WorldEdit: compound({ Version: str('7.3.6'), EditingPlatform: str('enginehub:neoforge'), Origin: { type: 'intArray', value: [0, 64, 0] } }), Date: { type: 'long', value: [0, 1] } }),
      Blocks: compound({
        Palette: compound(pal),
        Data: bytes([0, 1, 2]),
        BlockEntities: list('compound', [{ Id: str('minecraft:chest'), Pos: { type: 'intArray', value: [1, 0, 0] }, Data: compound({ Items: list('compound', []) }) }])
      }),
      Biomes: compound({ Palette: compound({ 'minecraft:plains': int(0) }), Data: bytes([0, 0, 0]) }),
      Entities: list('compound', [{ Id: str('minecraft:armor_stand'), Pos: list('double', [0.5, 0, 0.5]) }])
    })
  }))
  const s3 = await readSchematic(v3)
  assert.equal(s3.format, 'sponge v3')
  assert.deepEqual(s3.palette.map(p => p.name), ['minecraft:stone_bricks', 'minecraft:chest', 'minecraft:air'])
  assert.equal(importStructure(s3, { name: 'we3', maxBlocks: 100 }).blocks, 2)

  const v2 = write(compound({
    Version: int(2), DataVersion: int(3955), Width: short(2), Height: short(1), Length: short(1),
    Metadata: compound({ WEOffsetX: int(-3), WEOffsetY: int(1), WEOffsetZ: int(0) }),
    Offset: { type: 'intArray', value: [5, 64, 5] },
    Palette: compound({ 'minecraft:cobblestone_wall[east=low,north=none,south=none,up=true,waterlogged=false,west=none]': int(0), 'minecraft:oak_log[axis=x]': int(1) }), PaletteMax: int(2),
    BlockData: bytes([0, 1]),
    BlockEntities: list('compound', []),
    BiomePalette: compound({ 'minecraft:plains': int(0) }), BiomePaletteMax: int(1), BiomeData: bytes([0, 0])
  }, 'Schematic'))
  const s2 = await readSchematic(v2)
  assert.equal(s2.format, 'sponge v2')
  const out = importStructure(s2, { name: 'we2', maxBlocks: 100, anyWood: false })
  assert.match(out.yaml, /"block":"cobblestone_wall"\}/, 'wall sides follow the neighbours, not kept')
  assert.match(out.yaml, /"block":"oak_log","state":\{"axis":"x"\}/)
})

test('Create schematic: a gzipped structure .nbt with modded blocks keeps them as plain blocks', async () => {
  const palette = list('compound', [
    { Name: str('minecraft:andesite') },
    { Name: str('create:andesite_casing') },
    { Name: str('create:shaft'), Properties: compound({ axis: str('y'), waterlogged: str('false') }) }
  ])
  const blocks = list('compound', [
    { pos: list('int', [0, 0, 0]), state: int(0) },
    { pos: list('int', [1, 0, 0]), state: int(1) },
    { pos: list('int', [1, 1, 0]), state: int(2), nbt: compound({ id: str('create:simple_kinetic') }) }
  ])
  // Create writes these with a DataVersion, an entities list and gzip, like structure blocks do
  const buf = write(compound({ DataVersion: int(3955), size: list('int', [2, 2, 1]), palette, blocks, entities: list('compound', []) }))
  assert.equal(buf[0], 0x1f, 'gzipped')
  const s = await readSchematic(buf)
  assert.equal(s.format, 'structure')
  const out = importStructure(s, { name: 'create_bit', maxBlocks: 100 })
  assert.equal(out.blocks, 3)
  assert.match(out.warnings.join(' '), /modded blocks kept as plain blocks.*create:andesite_casing/)
  assert.match(out.yaml, /"block":"create:shaft","state":\{"axis":"y"\}/)
  parseBlueprint(out.yaml, 'create_bit')
})

test('format detection is by content, not by extension', async () => {
  // a legacy schematic without gzip, and a structure file, read the same whatever they are called
  const legacy = write(compound({ Width: short(1), Height: short(1), Length: short(1), Blocks: bytes([4]), Data: bytes([0]) }, 'Schematic'), false)
  assert.equal((await readSchematic(legacy)).format, 'mcedit (legacy)')
  await assert.rejects(readSchematic(Buffer.from('PK\x03\x04 not nbt')), /zip archive/)
  await assert.rejects(readSchematic(write(compound({ foo: int(1) }))), /unknown format/)
})

test('Axiom .bp: header, thumbnail and 16^3 sections packed like chunk sections', async () => {
  const lenPrefixed = (b: Buffer) => { const n = Buffer.alloc(4); n.writeInt32BE(b.length); return Buffer.concat([n, b]) }
  const header = nbt.writeUncompressed(compound({ Name: str('tiny'), Author: str('test'), BlockCount: int(2) }) as never, 'big')
  // section (0,0,0): palette [air, stone, oak_log[axis=x]], 4 bits, 16 entries per long, no spanning
  const longs = new Array<bigint>(256).fill(0n)
  const put = (x: number, y: number, z: number, v: number) => { const i = (y * 16 + z) * 16 + x; longs[Math.floor(i / 16)] = longs[Math.floor(i / 16)]! | (BigInt(v) << BigInt((i % 16) * 4)) }
  put(1, 0, 2, 1)
  put(2, 0, 2, 2)
  put(2, 1, 2, 1)
  const pairs = longs.map(l => [Number(BigInt.asIntN(32, l >> 32n)), Number(BigInt.asIntN(32, l & 0xffffffffn))])
  const pal = (names: [string, Record<string, string>?][]) => list('compound', names.map(([n, p]) => ({ Name: str(n), ...(p ? { Properties: compound(Object.fromEntries(Object.entries(p).map(([k, v]) => [k, str(v)]))) } : {}) })))
  const blocks = gzipSync(nbt.writeUncompressed(compound({
    BlockRegion: list('compound', [
      { X: int(0), Y: int(0), Z: int(0), BlockStates: compound({ palette: pal([['minecraft:air'], ['minecraft:stone'], ['minecraft:oak_log', { axis: 'x' }]]), data: { type: 'longArray', value: pairs } }) },
      // a section of only structure void has no data array
      { X: int(-1), Y: int(0), Z: int(0), BlockStates: compound({ palette: pal([['minecraft:structure_void']]) }) }
    ])
  }) as never, 'big'))
  const magic = Buffer.alloc(4); magic.writeUInt32BE(0x0ae5bb36)
  const buf = Buffer.concat([magic, lenPrefixed(header), lenPrefixed(Buffer.from([0x89, 0x50, 0x4e, 0x47])), lenPrefixed(blocks)])
  const s = await readSchematic(buf)
  assert.equal(s.format, 'axiom (tiny)')
  assert.deepEqual([s.width, s.height, s.depth], [32, 16, 16])
  const at = (x: number, y: number, z: number) => s.palette[s.grid[cellIndex(s, x + 16, y, z)]!]
  assert.equal(at(1, 0, 2)?.name, 'minecraft:stone')
  assert.deepEqual(at(2, 0, 2), { name: 'minecraft:oak_log', state: { axis: 'x' } })
  assert.equal(at(2, 1, 2)?.name, 'minecraft:stone')
  const out = importStructure(s, { name: 'tiny', maxBlocks: 100, air: false, anyWood: false })
  assert.equal(out.blocks, 3)
  assert.deepEqual([out.width, out.depth, out.height], [2, 1, 2])
  await assert.rejects(readSchematic(buf.subarray(0, 20)), /axiom blueprint/)
})
