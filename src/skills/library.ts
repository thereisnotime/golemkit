// Blueprint library actions: list, search, show, pick (the building policy), import from a
// schematic file, capture a region of the world, save an LLM-designed blueprint, rename and
// delete. The pure parts are in blueprint-library.ts (index, search, checks, policy, files) and
// schematic.ts (formats). Everything written goes to the bot's learned library,
// data/bots/<name>/blueprints/; imports are read only from the import folder.
import { readFile } from 'node:fs/promises'
import { lstatSync, existsSync, readdirSync } from 'node:fs'
import YAML from 'yaml'
import type { ActionContext } from '../core/index.ts'
import { defineSkill, defineAction, z, ok, fail, checkAborted, fmtPos } from '../core/index.ts'
import { vec } from './world.ts'
import { inventoryCounts } from './toolkit.ts'
import { parseBlueprint, renderBlueprint, rotate, resolveRoles, materials, fmtMaterials, isNaturalBlock, solidCells, FACINGS, type Facing } from './blueprint.ts'
import {
  libraryDirs, loadLibrary, learnedDir, importDir, limits, searchLibrary, fmtEntry, decideBuilding, buildingPolicy, checkDesign,
  safeChild, checkName, writeLearned, deleteLearned, renameLearned, withMeta, guessTags, materialSummary, today,
  type SearchQuery, type LibraryKind
} from './blueprint-library.ts'
import { readSchematic, importStructure, captureStructure, structureToYaml, countBlocks, parseBox, isVanillaBlockOrItem } from './schematic.ts'

type Ctx = Pick<ActionContext, 'agent' | 'caller' | 'player'>

/** Writing to the library is for owners: a chat caller and the player an LLM acts for must be owners. */
function ownerDenied (ctx: Ctx, what: string): string | null {
  if (ctx.caller.kind === 'player' && !ctx.agent.isOwner(ctx.caller.name)) return `only my owners can ${what}`
  if (ctx.player && !ctx.agent.isOwner(ctx.player)) return `only my owners can ${what} (asked for ${ctx.player})`
  return null
}

const library = (ctx: Pick<ActionContext, 'agent'>) => loadLibrary(libraryDirs(ctx.agent))
const facingSchema = z.enum(FACINGS as [Facing, ...Facing[]])
const tagsSchema = z.union([z.array(z.string()), z.string()]).optional().describe('house, defence, farm, decoration, or your own (a list, or comma separated)')
/** Tags from a list or a comma-separated string (chat). */
const tagList = (t: string[] | string | undefined) => (t === undefined ? undefined : (Array.isArray(t) ? t : t.split(',')).map(s => s.trim().toLowerCase()).filter(Boolean))
const kindSchema = z.enum(['shipped', 'user', 'learned'])

function author (ctx: Ctx): string {
  return ctx.player ?? (ctx.caller.kind === 'player' ? ctx.caller.name : `${ctx.agent.username} (${ctx.caller.kind})`)
}

const blueprintList = defineAction({
  name: 'blueprint_list',
  description: 'List the blueprints in the libraries (shipped, user folders, and the ones I learned: captured, imported, designed) with size, blocks, tags and main materials.',
  params: z.object({ library: kindSchema.optional().describe('only this library') }),
  exclusive: false,
  run (ctx, { library: kind }) {
    const lib = library(ctx)
    const rows = lib.entries.filter(e => !kind || e.library === kind)
    if (!rows.length) return ok(kind ? `no ${kind} blueprints` : 'no blueprints')
    return ok(`${rows.length} blueprints, policy ${buildingPolicy(ctx.agent.settings)}: ${rows.map(fmtEntry).join(' | ')}${lib.errors.length ? ` | broken: ${lib.errors.join('; ').slice(0, 300)}` : ''}`,
      rows.map(e => ({ name: e.name, library: e.library, size: e.size, blocks: e.blocks, tags: e.tags })))
  }
})

const searchParams = z.object({
  text: z.string().optional().describe('what is wanted, e.g. "small stone house" or "watchtower"'),
  tags: tagsSchema,
  material: z.string().optional().describe('a block it should use, e.g. cobblestone, spruce'),
  max_size: z.number().int().min(1).optional().describe('largest footprint side'),
  max_height: z.number().int().min(1).optional(),
  max_blocks: z.number().int().min(1).optional(),
  size: z.enum(['small', 'medium', 'large']).optional().describe('small < 150 blocks, medium < 500, large'),
  library: kindSchema.optional(),
  limit: z.number().int().min(1).max(20).default(5)
})

const toQuery = (p: z.infer<typeof searchParams>): SearchQuery => ({
  text: p.text, tags: tagList(p.tags), material: p.material, maxSize: p.max_size, maxHeight: p.max_height, maxBlocks: p.max_blocks, size: p.size, library: p.library as LibraryKind | undefined
})

const blueprintSearch = defineAction({
  name: 'blueprint_search',
  description: 'Search the blueprint libraries by text, tags, material and size; best match first, with why it matched.',
  params: searchParams,
  exclusive: false,
  run (ctx, p) {
    const hits = searchLibrary(library(ctx).entries, toQuery(p)).slice(0, p.limit)
    if (!hits.length) return ok('no blueprint matches; blueprint_list shows them all, blueprint_design makes a new one')
    return ok(hits.map(h => `${fmtEntry(h.entry)}${h.why.length ? ` (${h.why.join(', ')})` : ''}`).join(' | '), hits.map(h => ({ name: h.entry.name, score: h.score, why: h.why })))
  }
})

const blueprintShow = defineAction({
  name: 'blueprint_show',
  description: 'Show one blueprint: library info (author, source, tags, rating), a text drawing (top view and layers) and its materials vs my inventory. build_plan with the same template says where it would go.',
  params: z.object({
    name: z.string(),
    layers: z.boolean().default(true).describe('false: top view only'),
    facing: facingSchema.optional().describe('turn it first')
  }),
  exclusive: false,
  run (ctx, { name, layers, facing }) {
    const lib = library(ctx)
    const bp = lib.blueprints.get(name)
    const e = lib.entries.find(x => x.name === name)
    if (!bp || !e) return fail(`unknown blueprint "${name}"; blueprint_search finds one`)
    const turned = facing ? rotate(bp, facing) : bp
    const inv = ctx.bot?.entity ? inventoryCounts(ctx.bot) : {}
    const info = [`${e.library} library`, e.author && `by ${e.author}`, e.source, e.created, e.rating !== undefined && `rated ${e.rating}/5`, e.tags.length && `tags ${e.tags.join(',')}`, e.notes].filter(Boolean).join(', ')
    return ok(`${info}\n${renderBlueprint(turned, { layers })}\nmaterials: ${fmtMaterials(materials(turned.cells, resolveRoles(turned, inv), inv))}`, e)
  }
})

/** Is an owner (or, with no owners set, the requester) on the server right now? */
function ownerOnline (ctx: Pick<ActionContext, 'agent' | 'bot' | 'player'>): { online: boolean, who?: string } {
  const players = Object.keys(ctx.bot?.players ?? {}).filter(p => p !== ctx.agent.username)
  const owners = ctx.agent.owners
  const who = owners.length ? players.find(p => owners.includes(p.toLowerCase())) : ctx.player && players.includes(ctx.player) ? ctx.player : undefined
  return who ? { online: true, who } : { online: false }
}

const blueprintPick = defineAction({
  name: 'blueprint_pick',
  description: 'Decide which blueprint to build for a request, following the building policy (config "building"): library = best saved match, creative = design a new one with blueprint_design ' +
    '(a saved match as fallback), ask = offer the owner 2-3 matches when they are online. Call it before build when the request does not name a blueprint.',
  params: searchParams.omit({ limit: true }).extend({ text: z.string().describe('the request, e.g. "a small house by the river"') }),
  exclusive: false,
  run (ctx, p) {
    const policy = buildingPolicy(ctx.agent.settings)
    const hits = searchLibrary(library(ctx).entries, toQuery({ ...p, limit: 3 }))
    const on = ownerOnline(ctx)
    const d = decideBuilding(policy, hits, on.online, on.who)
    return ok(d.message, { policy, mode: d.mode, pick: d.pick?.name, options: d.options.map(o => o.name) })
  }
})

const blueprintImport = defineAction({
  name: 'blueprint_import',
  description: 'Import a schematic file (Sponge .schem, Litematica .litematic or structure .nbt) from the import folder into my learned blueprints (owners only). ' +
    'Refuses more than the block limit (default 4000) and suggests a crop.',
  params: z.object({
    file: z.string().describe('file name inside the import folder (blueprints/import/ unless configured)'),
    name: z.string().optional().describe('blueprint name (default: from the file name)'),
    crop: z.string().optional().describe('keep only "x1 y1 z1 x2 y2 z2" (the file\'s own coordinates)'),
    max_blocks: z.number().int().min(1).optional().describe('block limit for this import (default settings.build.importMaxBlocks, 4000)'),
    air: z.boolean().default(true).describe('false: empty space in the file is "don\'t care" instead of "must be clear"'),
    exact: z.boolean().default(false).describe('keep the exact wood of wooden blocks (default: any wood, following the build theme)'),
    facing: facingSchema.optional().describe('the side its entrance is on as drawn; default the side of the first door'),
    tags: tagsSchema,
    description: z.string().optional(),
    overwrite: z.boolean().default(false)
  }),
  exclusive: false,
  async run (ctx, p) {
    const denied = ownerDenied(ctx, 'import blueprints')
    if (denied) return fail(denied)
    const root = importDir(ctx.agent)
    const path = safeChild(root, p.file)
    if (!path || p.file.includes('/') || p.file.includes('\\')) return fail(`"${p.file}" isn't a file name in the import folder`)
    if (!existsSync(path)) {
      const there = existsSync(root) ? readdirSync(root).filter(f => /\.(schem|schematic|litematic|nbt)$/i.test(f)) : []
      return fail(`no ${p.file} in the import folder${there.length ? `; there: ${there.join(', ')}` : ' (it is empty)'}`)
    }
    const st = lstatSync(path)
    if (!st.isFile()) return fail(`${p.file} is not a regular file`)
    if (st.size > 16 * 1024 * 1024) return fail(`${p.file} is ${Math.round(st.size / 1048576)} MB; schematics over 16 MB aren't read`)
    const name = (p.name ?? p.file.replace(/\.[^.]+$/, '')).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48)
    const bad = checkName(name)
    if (bad) return fail(bad)
    const lib = library(ctx)
    const clash = lib.entries.find(e => e.name === name && e.library !== 'learned')
    if (clash) return fail(`${name} is a ${clash.library} blueprint; import it under another name`)
    let crop
    if (p.crop) { crop = parseBox(p.crop); if (!crop) return fail('crop must be six whole numbers: x1 y1 z1 x2 y2 z2') }
    try {
      const s = await readSchematic(await readFile(path))
      checkAborted(ctx.signal)
      const max = p.max_blocks ?? limits(ctx.agent).importMaxBlocks
      const names = [...new Set(s.palette.map(e => e.name.replace(/^minecraft:/, '')))]
      const tags = tagList(p.tags) ?? guessTags(`${name} ${p.description ?? ''}`, names)
      const out = importStructure(s, {
        name, description: p.description, facing: p.facing, air: p.air, anyWood: !p.exact, maxBlocks: max, ...(crop ? { crop } : {}),
        meta: { tags, author: author(ctx), source: `imported from ${p.file} (${s.format})`, created: today() }
      })
      const saved = writeLearned(learnedDir(ctx.agent), name, out.yaml, p.overwrite)
      ctx.log.info('blueprint imported', { file: p.file, name, blocks: out.blocks, saved })
      return ok(`imported ${p.file} as ${name}: ${out.width}x${out.depth}x${out.height}, ${out.blocks} blocks, entrance ${out.facing}${out.warnings.length ? `; ${out.warnings.join('; ')}` : ''}. build_plan template=${name} preview=true to check it`,
        { name, size: [out.width, out.depth, out.height], blocks: out.blocks, warnings: out.warnings })
    } catch (e) {
      checkAborted(ctx.signal)
      return fail(`can't import ${p.file}: ${(e as Error).message}`)
    }
  }
})

const top = (m: Record<string, number>, n = 6) => Object.fromEntries(Object.entries(m).slice(0, n))

const blueprintCapture = defineAction({
  name: 'blueprint_capture',
  description: 'Save a build in the world as a learned blueprint (owners only), so it can be built again elsewhere: "save this as X". Give two corners (x1 y1 z1 x2 y2 z2), ' +
    'or a centre (x y z, default where the asking player stands) and a size. Keeps only player-made blocks unless all=true; the empty inside stays "must be clear". At most 32 per side.',
  params: z.object({
    name: z.string().describe('name for the new blueprint (lowercase, digits, _)'),
    x1: z.number().optional(), y1: z.number().optional(), z1: z.number().optional(),
    x2: z.number().optional(), y2: z.number().optional(), z2: z.number().optional(),
    x: z.number().optional().describe('centre instead of corners; y is the level of the floor'),
    y: z.number().optional(),
    z: z.number().optional(),
    size: z.number().int().min(1).optional().describe('footprint side around the centre (default 11)'),
    height: z.number().int().min(1).optional().describe('height from the floor up around the centre (default 10)'),
    all: z.boolean().default(false).describe('keep natural blocks (ground, plants, leaves) too'),
    exact: z.boolean().default(false).describe('keep the exact wood of wooden blocks (default: any wood, following the build theme)'),
    facing: facingSchema.optional().describe('the side its entrance is on; default the side of the first door'),
    description: z.string().optional(),
    tags: tagsSchema,
    overwrite: z.boolean().default(false)
  }),
  exclusive: false,
  run (ctx, p) {
    const denied = ownerDenied(ctx, 'save blueprints')
    if (denied) return fail(denied)
    const bad = checkName(p.name)
    if (bad) return fail(bad)
    const { bot, agent } = ctx
    if (!bot?.entity) return fail('not in the world right now')
    const clash = library(ctx).entries.find(e => e.name === p.name && e.library !== 'learned')
    if (clash) return fail(`${p.name} is a ${clash.library} blueprint; pick another name`)
    const lim = limits(agent)
    let min: { x: number, y: number, z: number }
    let max: { x: number, y: number, z: number }
    const corners = [p.x1, p.y1, p.z1, p.x2, p.y2, p.z2]
    if (corners.every(v => v !== undefined)) {
      const [ax, ay, az, bx, by, bz] = corners.map(v => Math.floor(v!)) as [number, number, number, number, number, number]
      min = { x: Math.min(ax, bx), y: Math.min(ay, by), z: Math.min(az, bz) }
      max = { x: Math.max(ax, bx), y: Math.max(ay, by), z: Math.max(az, bz) }
    } else if (corners.some(v => v !== undefined)) {
      return fail('give all six corner coordinates (x1 y1 z1 x2 y2 z2), or a centre x y z with a size')
    } else {
      const who = (ctx.player && bot.players[ctx.player]?.entity?.position) || bot.entity.position
      const c = { x: Math.floor(p.x ?? who.x), y: Math.floor(p.y ?? who.y - 1), z: Math.floor(p.z ?? who.z) }
      const size = p.size ?? 11
      const half = Math.floor(size / 2)
      min = { x: c.x - half, y: c.y, z: c.z - half }
      max = { x: c.x - half + size - 1, y: c.y + (p.height ?? 10) - 1, z: c.z - half + size - 1 }
    }
    const dims = [max.x - min.x + 1, max.y - min.y + 1, max.z - min.z + 1]
    if (dims.some(d => d > lim.captureMaxSize)) return fail(`region ${dims[0]}x${dims[2]}x${dims[1]} is too big: at most ${lim.captureMaxSize} on each side`)
    try {
      const s = captureStructure((x, y, z) => {
        const b = bot.blockAt(vec(bot, x, y, z))
        return b ? { name: b.name, state: b.getProperties?.() as Record<string, unknown> | undefined } : null
      }, min, max, { all: p.all, isNatural: isNaturalBlock })
      const n = countBlocks(s)
      if (!n) return fail(`nothing player-made between ${fmtPos(min)} and ${fmtPos(max)}${p.all ? '' : ' (all=true keeps natural blocks too)'}`)
      if (n > lim.captureMaxBlocks) return fail(`${n} blocks, over the limit of ${lim.captureMaxBlocks}; capture a smaller region`)
      const names = [...new Set(s.palette.map(e => e.name))]
      const out = structureToYaml(s, {
        name: p.name, description: p.description ?? `${p.name.replace(/_/g, ' ')}, captured at ${fmtPos(min)}`, facing: p.facing, anyWood: !p.exact,
        meta: { tags: tagList(p.tags) ?? guessTags(`${p.name} ${p.description ?? ''}`, names), author: author(ctx), source: `captured at ${fmtPos(min)} to ${fmtPos(max)}`, created: today() }
      })
      parseBlueprint(out.yaml, p.name)
      const saved = writeLearned(learnedDir(agent), p.name, out.yaml, p.overwrite)
      ctx.log.info('blueprint captured', { name: p.name, min: fmtPos(min), max: fmtPos(max), blocks: out.blocks, saved })
      return ok(`saved ${p.name}: ${out.width}x${out.depth}x${out.height}, ${out.blocks} blocks, entrance ${out.facing}${out.warnings.length ? `; ${out.warnings.join('; ')}` : ''}. build template=${p.name} builds it again`,
        { name: p.name, size: [out.width, out.depth, out.height], blocks: out.blocks, min, max, warnings: out.warnings })
    } catch (e) {
      return fail(`can't capture: ${(e as Error).message}`)
    }
  }
})

const blueprintDesign = defineAction({
  name: 'blueprint_design',
  description: 'Check and save a blueprint you designed, as YAML (or JSON) in the blueprint format (see blueprint_show small_house for an example): name, description, facing (entrance side), ' +
    'roles {name: {default: block, accept?: regex, kind?: block|door|attachment|furnish, optional?}}, palette {char: role | "role[facing=north]" | {block: oak_stairs, state: {...}}}, ' +
    'layers bottom to top, each a list of rows north to south, columns west to east; " " = don\'t care, "." = air, ^ v < > = stairs of the roof role. ' +
    'It is validated (format, size, real block names, every block placeable in order, nothing floating); problems come back so you can fix and call again. Data only, nothing runs.',
  params: z.object({
    yaml: z.string().optional().describe('the blueprint as YAML or JSON text'),
    blueprint: z.record(z.string(), z.unknown()).optional().describe('the blueprint as an object instead of text'),
    tags: tagsSchema,
    save: z.boolean().default(true).describe('false: only check and preview'),
    overwrite: z.boolean().default(false).describe('replace a learned blueprint of the same name')
  }),
  exclusive: false,
  run (ctx, p) {
    const denied = ownerDenied(ctx, 'save blueprints')
    if (denied && p.save) return fail(denied)
    let raw: unknown
    try {
      raw = p.blueprint ?? (p.yaml !== undefined ? YAML.parse(p.yaml) : undefined)
    } catch (e) {
      return fail(`not valid YAML/JSON: ${(e as Error).message.split('\n')[0]}`)
    }
    if (!raw || typeof raw !== 'object') return fail('give the blueprint as yaml (text) or blueprint (object)')
    let bp
    try {
      bp = parseBlueprint(raw, 'design')
    } catch (e) {
      return fail(`${(e as Error).message}. Fix it and call blueprint_design again`)
    }
    const lim = limits(ctx.agent)
    const report = checkDesign(bp, { maxSize: lim.designMaxSize, maxBlocks: lim.designMaxBlocks }, isVanillaBlockOrItem)
    const warn = report.warnings.length ? ` Warnings: ${report.warnings.join('; ')}.` : ''
    if (report.problems.length) return fail(`design ${bp.name} has problems: ${report.problems.join(' | ')}.${warn} Fix them and call blueprint_design again`)
    const preview = renderBlueprint(bp, { layers: false })
    if (!p.save) return ok(`design ${bp.name} is fine (not saved).${warn}\n${preview}`)
    const lib = library(ctx)
    const clash = lib.entries.find(e => e.name === bp.name && e.library !== 'learned')
    if (clash) return fail(`${bp.name} is already a ${clash.library} blueprint; use another name`)
    const m = (bp.meta ?? {}) as Record<string, unknown>
    const base = p.blueprint ? YAML.stringify(raw, { lineWidth: 0 }) : p.yaml!
    const yaml = withMeta(base, {
      tags: tagList(p.tags) ?? (Array.isArray(m.tags) ? undefined : guessTags(`${bp.name} ${bp.description}`, Object.values(bp.roles).map(r => r.default))),
      author: typeof m.author === 'string' ? undefined : author(ctx),
      source: 'designed',
      created: today(),
      size: [bp.width, bp.depth, bp.height],
      blocks: solidCells(bp.cells).length,
      materials: top(materialSummary(bp))
    })
    try {
      writeLearned(learnedDir(ctx.agent), bp.name, yaml, p.overwrite)
    } catch (e) {
      return fail((e as Error).message)
    }
    ctx.log.info('blueprint designed', { name: bp.name, size: `${bp.width}x${bp.depth}x${bp.height}` })
    return ok(`saved design ${bp.name}.${warn} build template=${bp.name} builds it\n${preview}`, { name: bp.name, size: [bp.width, bp.depth, bp.height] })
  }
})

const blueprintDelete = defineAction({
  name: 'blueprint_delete',
  description: 'Delete one of my learned blueprints (captured, imported or designed). Owners only; shipped and user blueprints are never touched.',
  params: z.object({ name: z.string() }),
  exclusive: false,
  run (ctx, { name }) {
    const denied = ownerDenied(ctx, 'delete blueprints')
    if (denied) return fail(denied)
    const e = library(ctx).entries.find(x => x.name === name)
    if (e && e.library !== 'learned') return fail(`${name} is a ${e.library} blueprint; only learned ones can be deleted`)
    try {
      deleteLearned(learnedDir(ctx.agent), name)
      return ok(`deleted the learned blueprint ${name}`)
    } catch (err) {
      return fail((err as Error).message)
    }
  }
})

const blueprintRename = defineAction({
  name: 'blueprint_rename',
  description: 'Rename one of my learned blueprints. Owners only.',
  params: z.object({ from: z.string(), to: z.string() }),
  exclusive: false,
  run (ctx, { from, to }) {
    const denied = ownerDenied(ctx, 'rename blueprints')
    if (denied) return fail(denied)
    const lib = library(ctx)
    const e = lib.entries.find(x => x.name === from)
    if (e && e.library !== 'learned') return fail(`${from} is a ${e.library} blueprint; only learned ones can be renamed`)
    const clash = lib.entries.find(x => x.name === to && x.library !== 'learned')
    if (clash) return fail(`${to} is already a ${clash.library} blueprint`)
    try {
      renameLearned(learnedDir(ctx.agent), from, to)
      return ok(`renamed ${from} to ${to}`)
    } catch (err) {
      return fail((err as Error).message)
    }
  }
})

export const blueprintLibrary = () => defineSkill({
  name: 'blueprint-library',
  description: 'Blueprint libraries: search, show, import schematics, capture builds, save designs, building policy.',
  actions: [blueprintList, blueprintSearch, blueprintShow, blueprintPick, blueprintImport, blueprintCapture, blueprintDesign, blueprintDelete, blueprintRename],
  observe (agent) {
    const policy = buildingPolicy(agent.settings)
    return policy === 'library' ? {} : { building: policy }
  }
})
