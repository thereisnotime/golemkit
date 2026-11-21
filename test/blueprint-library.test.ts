import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, symlinkSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import nbt from 'prismarine-nbt'
import { parseBlueprint, solidCells, rotate, isNaturalBlock, BLUEPRINTS_DIR } from '../src/skills/blueprint.ts'
import {
  readSchematic, importStructure, structureToYaml, captureStructure, countBlocks, parseBlockString, cleanState, parseBox, type WorldBlock
} from '../src/skills/schematic.ts'
import {
  loadLibrary, libraryDirs, searchLibrary, decideBuilding, buildingPolicy, checkDesign, unplaceableCells, floatingCells, safeChild,
  writeLearned, renameLearned, deleteLearned, findLearnedFile, withMeta, guessTags, type IndexEntry
} from '../src/skills/blueprint-library.ts'
import { findToggle, parseToggleValue } from '../src/core/toggles.ts'
import { parseProfile } from '../src/core/profile.ts'

const tmp = () => mkdtempSync(join(tmpdir(), 'bplib-'))

// ------------------------------------------------------------------ a tiny test structure in every format

/**
 * 3x3x3: a cobblestone floor; oak plank walls with a door (south side, middle) and a chest in
 * the middle; the top ring has a modded block in the north-west corner, the door's top half and
 * water in the middle (never placed).
 */
type B = { name: string, props?: Record<string, string> }
function sample (x: number, y: number, z: number): B {
  if (y === 0) return { name: 'minecraft:cobblestone' }
  if (x === 1 && z === 2) return { name: 'minecraft:oak_door', props: { facing: 'north', half: y === 1 ? 'lower' : 'upper', hinge: 'left', open: 'false', powered: 'false' } }
  if (x === 1 && z === 1) return y === 1 ? { name: 'minecraft:chest', props: { facing: 'north', type: 'single', waterlogged: 'false' } } : { name: 'minecraft:water', props: { level: '0' } }
  if (y === 2 && x === 0 && z === 0) return { name: 'create:shaft', props: { axis: 'y' } }
  return { name: 'minecraft:oak_planks' }
}
const W = 3
const H = 3
const D = 3
const each = (f: (x: number, y: number, z: number) => void) => { for (let y = 0; y < H; y++) for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) f(x, y, z) }
const blockString = (b: B) => `${b.name}${b.props ? `[${Object.entries(b.props).map(([k, v]) => `${k}=${v}`).join(',')}]` : ''}`

const int = (value: number) => ({ type: 'int', value })
const str = (value: string) => ({ type: 'string', value })
const compound = (value: Record<string, unknown>, name = '') => ({ type: 'compound', name, value })
const write = (root: unknown, gzip = true) => { const raw = nbt.writeUncompressed(root as never, 'big'); return gzip ? gzipSync(raw) : raw }

function varints (ids: number[]): number[] {
  const out: number[] = []
  for (let v of ids) {
    while (v >= 0x80) { out.push(((v & 0x7f) | 0x80) << 24 >> 24); v >>>= 7 }
    out.push(v << 24 >> 24) // signed bytes, as NBT stores them
  }
  return out
}

function paletteOf () {
  const keys: string[] = []
  each((x, y, z) => { const k = blockString(sample(x, y, z)); if (!keys.includes(k)) keys.push(k) })
  return keys
}

function spongeV2 (): Buffer {
  const keys = paletteOf()
  const ids: number[] = []
  each((x, y, z) => ids.push(keys.indexOf(blockString(sample(x, y, z)))))
  const pal: Record<string, unknown> = Object.fromEntries(keys.map((k, i) => [k, int(i)]))
  return write(compound({
    Version: int(2), DataVersion: int(3955), Width: { type: 'short', value: W }, Height: { type: 'short', value: H }, Length: { type: 'short', value: D },
    Palette: compound(pal), PaletteMax: int(keys.length), BlockData: { type: 'byteArray', value: varints(ids) }
  }, 'Schematic'))
}

function spongeV3 (): Buffer {
  // ids shifted by 200 so every index is a two-byte varint
  const keys = paletteOf()
  const ids: number[] = []
  each((x, y, z) => ids.push(200 + keys.indexOf(blockString(sample(x, y, z)))))
  const pal = Object.fromEntries(keys.map((k, i) => [k, int(200 + i)]))
  return write(compound({
    Schematic: compound({
      Version: int(3), DataVersion: int(3955), Width: { type: 'short', value: W }, Height: { type: 'short', value: H }, Length: { type: 'short', value: D },
      Blocks: compound({ Palette: compound(pal), Data: { type: 'byteArray', value: varints(ids) }, BlockEntities: { type: 'list', value: { type: 'compound', value: [] } } })
    })
  }))
}

const propsTag = (b: B) => (b.props ? { Properties: compound(Object.fromEntries(Object.entries(b.props).map(([k, v]) => [k, str(v)]))) } : {})
const paletteList = (keys: string[]) => ({ type: 'list', value: { type: 'compound', value: keys.map(k => { const b = parseBlockString(k); return { Name: str(b.name), ...propsTag({ name: b.name, props: b.state }) } }) } })

function litematic (): Buffer {
  const keys = ['minecraft:air', ...paletteOf()]
  const bits = Math.max(2, Math.ceil(Math.log2(keys.length)))
  const n = W * H * D
  const longs = new Array<bigint>(Math.ceil(n * bits / 64)).fill(0n)
  let i = 0
  // litematica order: (y * sizeZ + z) * sizeX + x, entries packed across long boundaries
  each((x, y, z) => {
    const v = BigInt(keys.indexOf(blockString(sample(x, y, z))))
    const start = i * bits
    const w = Math.floor(start / 64)
    const off = BigInt(start % 64)
    longs[w] = BigInt.asUintN(64, longs[w]! | (v << off))
    if (Number(off) + bits > 64) longs[w + 1] = BigInt.asUintN(64, longs[w + 1]! | (v >> (64n - off)))
    i++
  })
  const pairs = longs.map(l => [Number(BigInt.asIntN(32, l >> 32n)), Number(BigInt.asIntN(32, l & 0xffffffffn))])
  // negative size: the region extends towards -x from its position
  return write(compound({
    Version: int(6),
    Regions: compound({
      main: compound({
        Position: compound({ x: int(W - 1), y: int(0), z: int(0) }),
        Size: compound({ x: int(-W), y: int(H), z: int(D) }),
        BlockStatePalette: paletteList(keys),
        BlockStates: { type: 'longArray', value: pairs }
      })
    })
  }))
}

function structureNbt (): Buffer {
  const keys = paletteOf()
  const blocks: unknown[] = []
  each((x, y, z) => blocks.push({ pos: { type: 'list', value: { type: 'int', value: [x, y, z] } }, state: int(keys.indexOf(blockString(sample(x, y, z)))) }))
  return write(compound({
    DataVersion: int(3955),
    size: { type: 'list', value: { type: 'int', value: [W, H, D] } },
    palette: paletteList(keys),
    blocks: { type: 'list', value: { type: 'compound', value: blocks } },
    entities: { type: 'list', value: { type: 'compound', value: [] } }
  }), false)
}

test('import: Sponge v2/v3, Litematica and structure .nbt all give the same blueprint', async () => {
  const outs: string[] = []
  for (const [fmt, buf] of [['sponge v2', spongeV2()], ['sponge v3', spongeV3()], ['litematica', litematic()], ['structure', structureNbt()]] as const) {
    const s = await readSchematic(buf)
    assert.equal(s.format, fmt)
    assert.deepEqual([s.width, s.height, s.depth], [3, 3, 3], fmt)
    const out = importStructure(s, { name: 'sample', maxBlocks: 4000, knownBlock: n => n !== 'not_a_block' })
    assert.equal(out.facing, 'south', `${fmt}: entrance on the door's side`)
    assert.equal(out.blocks, 25, `${fmt}: 9 floor, 8 walls + chest, 7 top ring (the door top is passive, water is left out)`)
    assert.ok(out.warnings.some(w => /left out.*water/.test(w)), `${fmt}: water warned`)
    assert.ok(out.warnings.some(w => /modded.*create:shaft/.test(w)), `${fmt}: modded block warned`)
    outs.push(out.yaml.replace(/\(.*\)/, ''))
    const bp = parseBlueprint(out.yaml)
    const chest = bp.cells.find(c => bp.roles[c.role]!.default === 'chest')!
    assert.deepEqual(chest.state, { facing: 'north' }, 'type=single and waterlogged are dropped')
    assert.equal(bp.roles[chest.role]!.kind, 'furnish')
    const door = bp.cells.filter(c => bp.roles[c.role]!.default === 'oak_door')
    assert.equal(door.length, 2)
    assert.equal(bp.roles[door[0]!.role]!.kind, 'door')
    assert.ok(door.some(c => c.passive), 'upper half is passive')
    assert.equal(bp.roles['block:create:shaft']!.default, 'create:shaft', 'modded blocks keep their namespace')
    assert.equal(door[0]!.role, 'wood_door', 'wooden blocks get a role that takes any wood')
    assert.ok(new RegExp(bp.roles.wood_door!.accept!).test('spruce_door') && bp.roles.wood_door!.wood)
    const exact = parseBlueprint(importStructure(s, { name: 'sample', maxBlocks: 4000, anyWood: false }).yaml)
    assert.ok(exact.roles['block:oak_door'] && !exact.roles.wood_door, 'anyWood=false keeps every block exact')
    assert.deepEqual(unplaceableCells(bp).map(c => c.role), [], 'converted blueprint is placeable in order')
  }
  assert.equal(new Set(outs).size, 1, 'every format converts to the same YAML')
})

test('import: block limit refuses with a crop suggestion, crop works, junk is rejected', async () => {
  const s = await readSchematic(spongeV2())
  assert.throws(() => importStructure(s, { name: 'big', maxBlocks: 20 }), /25 blocks is over the limit of 20; crop it, e\.g\. crop="0 0 0 2 1 2" keeps the bottom 2 of 3 layers/)
  const cropped = importStructure(s, { name: 'low', maxBlocks: 20, crop: parseBox('0 0 0 2 1 2')! })
  assert.equal(cropped.blocks, 18)
  assert.equal(parseBlueprint(cropped.yaml).height, 2)
  assert.equal(parseBox('1 2 3'), null)
  await assert.rejects(readSchematic(Buffer.from('hello world, not nbt')), /not an NBT file|unknown format/)
  await assert.rejects(readSchematic(write(compound({ foo: int(1) }))), /unknown format/)
  assert.deepEqual(cleanState('rail', { shape: 'ascending_east' }), undefined, 'rail shape follows the neighbours')
  assert.deepEqual(cleanState('oak_stairs', { shape: 'inner_left', facing: 'east', waterlogged: 'false' }), { shape: 'inner_left', facing: 'east' })
})

// ------------------------------------------------------------------ capture

/** A fake world: grass ground at y=63, a 3x3 plank hut with a door at 10 64 12 (south side) and a tree log. */
function fakeWorld (): (x: number, y: number, z: number) => WorldBlock | null {
  const blocks = new Map<string, WorldBlock>()
  const set = (x: number, y: number, z: number, b: WorldBlock) => blocks.set(`${x},${y},${z}`, b)
  for (let x = 9; x <= 11; x++) {
    for (let z = 10; z <= 12; z++) {
      set(x, 64, z, { name: 'oak_planks' })
      for (let y = 65; y <= 66; y++) if (x !== 10 || z !== 11) set(x, y, z, { name: 'oak_planks' })
      set(x, 67, z, { name: 'oak_stairs', state: { facing: 'east', half: 'bottom', shape: 'straight', waterlogged: false } })
    }
  }
  set(10, 65, 12, { name: 'oak_door', state: { facing: 'north', half: 'lower', hinge: 'left', open: false, powered: false } })
  set(10, 66, 12, { name: 'oak_door', state: { facing: 'north', half: 'upper', hinge: 'left', open: false, powered: false } })
  set(10, 65, 11, { name: 'short_grass' })
  set(7, 64, 7, { name: 'oak_log', state: { axis: 'y' } })
  return (x, y, z) => {
    if (x < 0 || x > 30) return null // not loaded
    const b = blocks.get(`${x},${y},${z}`)
    if (b) return b
    if (y < 63) return { name: 'dirt' }
    if (y === 63) return { name: 'grass_block', state: { snowy: false } }
    if (y === 64 && x === 13) return { name: 'poppy' }
    return { name: 'air' }
  }
}

test('capture: player-made blocks only, trimmed, the inside kept clear, states from the world', () => {
  const world = fakeWorld()
  const s = captureStructure(world, { x: 8, y: 63, z: 9 }, { x: 14, y: 69, z: 14 }, { isNatural: isNaturalBlock })
  const out = structureToYaml(s, { name: 'hut_copy' })
  assert.deepEqual([out.width, out.depth, out.height], [3, 3, 4], 'trimmed to the hut: ground, flowers and air around it are left out')
  assert.equal(out.facing, 'south', 'door on the south side')
  const bp = parseBlueprint(out.yaml)
  assert.equal(solidCells(bp.cells).length, 9 + 8 + 8 + 9 - 1, 'floor, two wall rings (door lower counts, upper is passive), roof')
  const inside = bp.cells.filter(c => c.role === 'air')
  assert.deepEqual(inside.map(c => `${c.x},${c.y},${c.z}`).sort(), ['1,1,1', '1,2,1'], 'the room (with the grass in it) must be clear')
  const roof = bp.cells.find(c => c.y === 3)!
  assert.deepEqual(roof.state, { facing: 'east', half: 'bottom', shape: 'straight' })
  // turned to face east, the stairs turn with it
  assert.equal(rotate(bp, 'east').cells.find(c => c.y === 3)!.state!.facing, 'north', 'south to east is a quarter turn anticlockwise')
  assert.ok(!out.yaml.includes('grass_block') && !out.yaml.includes('poppy'), 'natural blocks are not captured')
  const all = captureStructure(world, { x: 8, y: 63, z: 9 }, { x: 14, y: 69, z: 14 }, { all: true, isNatural: isNaturalBlock })
  assert.ok(countBlocks(all) > countBlocks(s), 'all=true keeps the ground and plants too')
  assert.throws(() => captureStructure(world, { x: -2, y: 63, z: 9 }, { x: 2, y: 64, z: 10 }, { isNatural: isNaturalBlock }), /isn't loaded/)
})

// ------------------------------------------------------------------ design checks

const GOOD = `
name: tiny_hut
description: a 3x3 hut
facing: south
roles:
  wall: { default: cobblestone }
  roof: { default: oak_stairs }
  door: { default: oak_door, kind: door }
palette: { "#": wall, D: "door[facing=north]", ".": air }
layers:
  - ["###", "###", "###"]
  - ["###", "#.#", "#D#"]
  - ["###", "#.#", "# #"]
  - ["vvv", "###", "^^^"]
`

test('design checks: good, floating, oversized, unknown blocks and unplaceable states', () => {
  const known = (n: string) => ['cobblestone', 'oak_stairs', 'oak_door', 'oak_planks', 'torch', 'wall_torch'].includes(n)
  const lim = { maxSize: 24, maxBlocks: 1500 }
  const good = checkDesign(parseBlueprint(GOOD), lim, known)
  assert.deepEqual(good.problems, [])

  const floating = parseBlueprint(GOOD.replace('- ["vvv", "###", "^^^"]', '- ["   ", "   ", "   "]\n  - ["   ", " # ", "   "]'))
  const f = checkDesign(floating, lim, known)
  assert.match(f.problems.join(), /1 block float.*layer 4 row 1 col 1 "#" \(cobblestone\)/)
  assert.equal(floatingCells(floating).length, 1)

  const wide = parseBlueprint(GOOD.replace('- ["###", "###", "###"]', `- ["${'#'.repeat(30)}", "###", "###"]`))
  assert.match(checkDesign(wide, lim, known).problems.join(), /too big: 30x3x4, at most 24 on each side/)
  assert.match(checkDesign(parseBlueprint(GOOD), { maxSize: 24, maxBlocks: 10 }, known).problems.join(), /too many blocks: \d+, at most 10/)

  const typo = parseBlueprint(GOOD.replace('default: cobblestone', 'default: oak_plank'))
  assert.match(checkDesign(typo, lim, known).problems.join(), /unknown block "oak_plank" \(did you mean oak_planks\?\)/)

  // a wall torch facing south needs a wall to its north: in the open it has nothing to click
  const torch = parseBlueprint(GOOD.replace('".": air }', '".": air, t: "light[facing=south]" }').replace('door: { default: oak_door, kind: door }', 'door: { default: oak_door, kind: door }\n  light: { default: torch, kind: attachment }').replace('- ["###", "###", "###"]\n', '- ["###", "###", "###"]\n  - ["   ", "   ", "  t"]\n').replace(/- \["###", "#\.#", "#D#"\]\n {2}- \["###", "#\.#", "# #"\]\n {2}- \["vvv", "###", "\^\^\^"\]/, ''))
  assert.match(checkDesign(torch, lim, known).problems.join(), /can't be placed in build order.*\(torch\) \[facing=south\]/)
})

// ------------------------------------------------------------------ search and policy

const entry = (name: string, tags: string[], blocks: number, size: [number, number, number], materials: Record<string, number>, extra: Partial<IndexEntry> = {}): IndexEntry =>
  ({ name, library: 'shipped', file: `${name}.yaml`, description: name.replace(/_/g, ' '), tags, size, blocks, materials, ...extra })

const ENTRIES = [
  entry('small_house', ['house', 'wood'], 121, [5, 7, 7], { oak_planks: 65, oak_stairs: 31 }),
  entry('stone_house', ['house', 'stone'], 300, [7, 7, 6], { cobblestone: 200, oak_planks: 40 }),
  entry('castle_keep', ['defence'], 900, [15, 15, 12], { stone_bricks: 800 }),
  entry('wheat_farm', ['farm'], 60, [9, 9, 2], { farmland: 40, water: 1 }),
  entry('my_house', ['house'], 140, [5, 5, 5], { spruce_planks: 100 }, { library: 'learned', rating: 5 })
]

test('search: tags and text rank first, size filters, material counts, ties to rating and own library', () => {
  const names = (q: Parameters<typeof searchLibrary>[1]) => searchLibrary(ENTRIES, q).map(h => h.entry.name)
  assert.deepEqual(names({ tags: ['house'] }).slice(0, 1), ['my_house'], 'equal tag score: the rated learned one first')
  assert.deepEqual(names({ text: 'stone house' })[0], 'stone_house', 'name match beats tag-only matches')
  assert.deepEqual(names({ text: 'a fort' }), ['castle_keep'], 'synonyms: fort -> defence')
  assert.deepEqual(names({ tags: ['house'], maxSize: 5 }), ['my_house'], 'footprint limit is a hard filter')
  assert.deepEqual(names({ text: 'house', material: 'cobblestone' })[0], 'stone_house')
  assert.deepEqual(names({ text: 'spaceship' }), [], 'no match, no results')
  assert.equal(names({}).length, ENTRIES.length, 'no query lists everything')
  assert.deepEqual(names({ size: 'small', tags: ['house'] })[0], 'my_house')
  // the real shipped library: "house" finds houses, "defence" walls and towers
  const lib = loadLibrary(libraryDirs())
  const house = searchLibrary(lib.entries, { text: 'house' }).map(h => h.entry.name)
  assert.equal(house[0], 'small_house', 'name match first')
  assert.ok(house.includes('cottage') && house.includes('hut'))
  const def = searchLibrary(lib.entries, { tags: ['defence'] }).map(h => h.entry.name)
  assert.ok(def.includes('fortress') && def.includes('watchtower') && def.includes('wall_segment'))
  assert.deepEqual(guessTags('my lookout tower', []), ['defence'])
  assert.deepEqual(guessTags('thing', ['white_bed', 'oak_planks']), ['house'])
})

test('policy: library picks the best match, creative designs, ask asks only when the owner is online', () => {
  const hits = searchLibrary(ENTRIES, { tags: ['house'] })
  const lib = decideBuilding('library', hits, true)
  assert.equal(lib.mode, 'build')
  assert.equal(lib.pick!.name, 'my_house')
  assert.match(lib.message, /build template=my_house/)
  const none = decideBuilding('library', [], true)
  assert.equal(none.mode, 'design', 'nothing fits: design one')
  const creative = decideBuilding('creative', hits, false)
  assert.equal(creative.mode, 'design')
  assert.equal(creative.pick!.name, 'my_house', 'the best match is the fallback')
  assert.match(creative.message, /blueprint_design.*if the design keeps failing, build template=my_house/)
  const ask = decideBuilding('ask', hits, true, 'robin')
  assert.equal(ask.mode, 'ask')
  assert.equal(ask.options.length, 3, 'at most three to choose from')
  assert.match(ask.message, /ask robin which they want: my_house/)
  const offline = decideBuilding('ask', hits, false)
  assert.equal(offline.mode, 'build', 'owner offline: from the library')
  assert.equal(offline.pick!.name, 'my_house')
  assert.equal(buildingPolicy({}), 'library', 'default')
  assert.equal(buildingPolicy({ building: 'ask' }), 'ask')
  assert.equal(buildingPolicy({ building: 'nonsense' }), 'library')
  // the live toggle and the profile key
  const t = findToggle('building')!
  assert.deepEqual(parseToggleValue(t, 'creative'), { ok: true, value: 'creative' })
  assert.equal(parseToggleValue(t, 'wild').ok, false)
  const p = parseProfile('variant: companion\nbuilding: ask\nblueprints: [./mine]\nsettings: { build: { blueprintDirs: [/abs/other] } }\n', 'x', '/repo/profiles/x.yaml')
  assert.equal(p.options.settings!.building, 'ask')
  assert.deepEqual((p.options.settings!.build as { blueprintDirs: string[] }).blueprintDirs, ['/abs/other', join(process.cwd(), 'mine')])
})

// ------------------------------------------------------------------ files: safety, learned library

test('path safety: no .., absolute paths or symlinks out of a library folder', () => {
  const root = tmp()
  const outside = tmp()
  writeFileSync(join(outside, 'secret.schem'), 'x')
  assert.equal(safeChild(root, 'a.schem'), join(root, 'a.schem'))
  assert.equal(safeChild(root, '../x.schem'), null)
  assert.equal(safeChild(root, 'sub/../../x.schem'), null)
  assert.equal(safeChild(root, '/etc/passwd'), null)
  assert.equal(safeChild(root, 'a\0b'), null)
  assert.equal(safeChild(root, ''), null)
  symlinkSync(join(outside, 'secret.schem'), join(root, 'link.schem'))
  assert.equal(safeChild(root, 'link.schem'), null, 'a symlinked file')
  symlinkSync(outside, join(root, 'dir'))
  assert.equal(safeChild(root, 'dir/secret.schem'), null, 'a symlinked folder')
  assert.equal(safeChild(root, 'dir/new.yaml'), null, 'a new file under a symlinked folder')
  assert.throws(() => writeLearned(root, '../evil', 'x'), /bad name/)
  assert.throws(() => writeLearned(root, 'Evil', 'x'), /bad name/)
  // a symlinked yaml in the learned folder is neither loaded nor found
  writeFileSync(join(outside, 'ext.yaml'), 'name: ext\ndescription: e\nroles: {}\npalette: { "#": { block: stone } }\nlayers: [["#"]]\n')
  symlinkSync(join(outside, 'ext.yaml'), join(root, 'ext.yaml'))
  assert.equal(findLearnedFile(root, 'ext'), null)
  assert.ok(!loadLibrary([{ kind: 'learned', dir: root }]).blueprints.has('ext'))
})

test('learned library: write, rename, delete; never shadows a shipped name; meta is stamped', () => {
  const dataDir = tmp()
  const dirs = libraryDirs({ settings: {}, dataDir })
  assert.deepEqual(dirs.map(d => d.kind), ['shipped', 'learned'])
  assert.equal(dirs[0]!.dir, BLUEPRINTS_DIR)
  const dir = dirs[1]!.dir
  const yaml = withMeta(GOOD, { tags: ['house'], source: 'designed', created: '2026-11-21', size: [3, 3, 4] })
  assert.match(yaml, /source: designed/)
  writeLearned(dir, 'tiny_hut', yaml)
  assert.throws(() => writeLearned(dir, 'tiny_hut', yaml), /already exists/)
  writeLearned(dir, 'tiny_hut', yaml, true)
  let lib = loadLibrary(dirs)
  const e = lib.entries.find(x => x.name === 'tiny_hut')!
  assert.equal(e.library, 'learned')
  assert.deepEqual(e.tags, ['house'])
  assert.equal(e.source, 'designed')
  renameLearned(dir, 'tiny_hut', 'little_hut')
  assert.deepEqual(readdirSync(dir), ['little_hut.yaml'])
  assert.match(readFileSync(join(dir, 'little_hut.yaml'), 'utf8'), /^name: little_hut/m)
  lib = loadLibrary(dirs)
  assert.ok(lib.blueprints.has('little_hut') && !lib.blueprints.has('tiny_hut'))
  // a learned file that claims a shipped name is ignored, the shipped one stays
  writeFileSync(join(dir, 'hut.yaml'), GOOD.replace('name: tiny_hut', 'name: hut'))
  lib = loadLibrary(dirs)
  assert.equal(lib.entries.find(x => x.name === 'hut')!.library, 'shipped')
  assert.ok(lib.errors.some(x => /has the name of a shipped one/.test(x)))
  deleteLearned(dir, 'little_hut')
  assert.ok(!existsSync(join(dir, 'little_hut.yaml')))
  assert.throws(() => deleteLearned(dir, 'little_hut'), /no learned blueprint/)
})

// ------------------------------------------------------------------ the actions, with a fake agent

test('actions: owners only for writes, import only from the import folder, design errors say what to fix', async () => {
  const { blueprintLibrary } = await import('../src/skills/library.ts')
  const dataDir = tmp()
  const imports = tmp()
  writeFileSync(join(imports, 'sample.schem'), spongeV2())
  writeFileSync(join(tmp(), 'outside.schem'), spongeV2())
  const agent = {
    username: 'LibTest', dataDir, owners: ['libtester'],
    settings: { build: { importDir: imports }, building: 'ask' } as Record<string, unknown>,
    isOwner: (p: string) => p.toLowerCase() === 'libtester'
  }
  const actions = new Map(blueprintLibrary().actions!.map(a => [a.name, a]))
  const log = { info () {}, debug () {}, warn () {}, error () {}, child () { return log } }
  const run = async (name: string, params: Record<string, unknown>, who = 'LibTester', players: string[] = ['LibTester']) => {
    const a = actions.get(name)!
    const ctx = { agent, bot: { players: Object.fromEntries(players.map(p => [p, {}])) }, caller: { kind: 'player', name: who }, player: who, log, signal: new AbortController().signal }
    return a.run(ctx as never, a.params.parse(params) as never) as Promise<{ ok: boolean, message: string }>
  }
  assert.match((await run('blueprint_import', { file: 'sample.schem' }, 'Stranger')).message, /only my owners/)
  assert.match((await run('blueprint_import', { file: '../outside.schem' })).message, /isn't a file name in the import folder/)
  assert.match((await run('blueprint_import', { file: 'nope.schem' })).message, /there: sample\.schem/)
  const imp = await run('blueprint_import', { file: 'sample.schem', tags: ['house'] })
  assert.ok(imp.ok, imp.message)
  assert.match(imp.message, /imported sample\.schem as sample: 3x3x3, 25 blocks, entrance south/)
  assert.match((await run('blueprint_import', { file: 'sample.schem', max_blocks: 10, overwrite: true })).message, /over the limit of 10/)
  assert.match((await run('blueprint_show', { name: 'sample' })).message, /learned library, by LibTester, imported from sample\.schem/)

  const bad = await run('blueprint_design', { yaml: GOOD.replace('default: cobblestone', 'default: cobble_stone') })
  assert.equal(bad.ok, false)
  assert.match(bad.message, /unknown block "cobble_stone".*Fix them and call blueprint_design again/)
  assert.match((await run('blueprint_design', { yaml: 'name: [unclosed' })).message, /not valid YAML/)
  assert.match((await run('blueprint_design', { yaml: GOOD.replace('name: tiny_hut', 'name: hut') })).message, /already a shipped blueprint/)
  const good = await run('blueprint_design', { yaml: GOOD, tags: ['house'] })
  assert.ok(good.ok, good.message)
  assert.match(good.message, /saved design tiny_hut/)
  assert.match(readFileSync(join(dataDir, 'blueprints', 'tiny_hut.yaml'), 'utf8'), /source: designed/)

  // policy ask: the owner is online, so the bot asks; offline it picks from the library
  const ask = await run('blueprint_pick', { text: 'a small house' })
  assert.match(ask.message, /policy ask: ask LibTester which they want/)
  const off = await run('blueprint_pick', { text: 'a small house' }, 'LibTester', [])
  assert.match(off.message, /owner offline so from the library: use /)

  assert.match((await run('blueprint_delete', { name: 'hut' })).message, /only learned ones can be deleted/)
  assert.match((await run('blueprint_delete', { name: 'sample' }, 'Stranger')).message, /only my owners/)
  assert.match((await run('blueprint_rename', { from: 'sample', to: 'cottage' })).message, /already a shipped blueprint/)
  assert.ok((await run('blueprint_rename', { from: 'sample', to: 'sample_hut' })).ok)
  assert.ok((await run('blueprint_delete', { name: 'sample_hut' })).ok)
  const list = await run('blueprint_list', { library: 'learned' })
  assert.match(list.message, /^1 blueprints, policy ask: tiny_hut \(learned\)/)
})
