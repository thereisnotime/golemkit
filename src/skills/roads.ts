// Roads and staircases between buildings. road-plan.ts plans (pure); this file reads the world
// into a height map, finds doors (finished builds, the bot's own blocks, doors nearby), builds a
// planned road (survival by hand, creative by hand or with /fill when op), checks it can be walked,
// and remembers every road it built (agent storage `road.built`) so it can take it out again or
// build it once more.
import type { Bot } from 'mineflayer'
import type { ActionContext, ActionResult, Agent } from '../core/index.ts'
import { defineSkill, defineAction, z, ok, fail, checkAborted, fmtPos, travel } from '../core/index.ts'
import { vec, digBlock, DigRefusedError, isReplaceable } from './world.ts'
import { equipFor, inventoryCounts } from './toolkit.ts'
import { isNaturalBlock, isSoftBlock } from './blueprint.ts'
import { FACINGS, UNREACHABLE, type BlockState, type Facing } from './blockstate.ts'
import { placeBlockState, reachToDig, newStandMemory, NotPlaceableYet } from './placement.ts'
import { gatherMaterials, countWant } from './materials.ts'
import { isCreative, takeFromCreative } from './creative.ts'
import { chooseMethod, creativeSettings, planCommands, runCommands, handPause, blockString, mergeRuns, fillCommand, BUILD_METHODS, type BuildMethod } from './creative-build.ts'
import { getPlacements, ownBlocks, SPAWN_KEEP_OUT } from './construction.ts'
import { getPlaces } from './navigation.ts'
import {
  createTerrain, cellIndex, markMargins, planRoad, roadGeometry, routeProblems, connect, paletteFor, isRoadMaterial, roadOptions,
  NO_GROUND, BLOCKED, LIQUID, ROAD, RAIL, PALETTE_NAMES, facingIndex,
  type RoadTerrain, type RoadEnd, type RouteCell, type RoadGeometry, type RoadOptions, type RoadBlock, type RoadPalette
} from './road-plan.ts'

const ROADS_KEY = 'road.built'
const ROADS_MAX = 50
/** Cells around the endpoints that are scanned and searched. */
const PAD = 24
/** Largest area one plan may cover (per side). */
const MAX_SIDE = 224
const SCAN_UP = 24
const SCAN_DOWN = 32

/** A road this bot built: enough to treat it as a road later, take it out, or build it again. */
export interface RoadRecord {
  id: number
  at: number
  label: string
  width: number
  palette: string
  /** [x, z, f, turn, junction] */
  route: number[][]
  /** [x, z, f, stair facing index or -1, natural ground] */
  surface: number[][]
  /** [x, z, f, natural ground] */
  rails: number[][]
  /** Blocks it placed. */
  placed: [number, number, number, string][]
  /** Blocks it dug out of the way (natural ground, plants...), to put back on removal. */
  cut: [number, number, number, string][]
  removed?: boolean
}

export function getRoads (agent: Pick<Agent, 'storage'>): RoadRecord[] {
  return agent.storage.get<RoadRecord[] | undefined>(ROADS_KEY) ?? []
}

function saveRoads (agent: Pick<Agent, 'storage'>, list: RoadRecord[]): void {
  agent.storage.set(ROADS_KEY, list.slice(-ROADS_MAX))
}

export interface RoadSettings { width: number, palette: string, maxCut: number, maxFill: number, lanterns: boolean, margin: number }

/** settings.road with defaults (road.width, road.palette, road.maxCut, road.maxFill, road.lanterns are live toggles). */
export function roadSettings (settings: Record<string, unknown>): RoadSettings {
  const r = (settings.road ?? {}) as Partial<Record<keyof RoadSettings, unknown>>
  const num = (v: unknown, d: number, lo: number, hi: number) => { const n = Number(v); return Number.isFinite(n) && v !== undefined && v !== null && v !== '' ? Math.min(hi, Math.max(lo, n)) : d }
  return {
    width: num(r.width, 3, 1, 5),
    palette: PALETTE_NAMES.includes(String(r.palette)) ? String(r.palette) : 'stone_bricks',
    maxCut: num(r.maxCut, 6, 0, 16),
    maxFill: num(r.maxFill, 6, 0, 24),
    lanterns: r.lanterns === true,
    margin: num(r.margin, 1, 0, 3)
  }
}

const isLog = (n: string) => /(_log|_wood|_stem|_hyphae)$/.test(n) && !n.startsWith('stripped_')
const key3 = (x: number, y: number, z: number) => `${x},${y},${z}`

/** Protected areas and the keep-out around world spawn (settings.build.spawnKeepOut). */
function forbiddenFor (agent: Agent, bot: Bot): (p: { x: number, y: number, z: number }) => boolean {
  const spawn = bot.spawnPoint
  const keepOut = Number((agent.settings.build as { spawnKeepOut?: number } | undefined)?.spawnKeepOut ?? SPAWN_KEEP_OUT)
  return p => agent.protectedAreas.isProtected(p) || (!!spawn && Math.abs(p.x - spawn.x) <= keepOut && Math.abs(p.z - spawn.z) <= keepOut)
}

export interface Box { x0: number, z0: number, x1: number, z1: number }

/**
 * Reads the world into a height map: natural ground per column (through plants, snow and
 * leaves), water and lava, trees and player-made blocks (BLOCKED; player builds get a MARGIN),
 * protected areas, and the roads this bot built (ROAD/RAIL with their walking heights).
 */
export function scanTerrain (bot: Bot, agent: Agent, box: Box, yMin: number, yMax: number, margin: number): RoadTerrain {
  const t = createTerrain(box.x0, box.z0, box.x1 - box.x0 + 1, box.z1 - box.z0 + 1)
  const building = new Uint8Array(t.w * t.d)
  const top = Math.min(319, yMax + SCAN_UP)
  const bottom = Math.max(-64, yMin - SCAN_DOWN)
  const world = bot.world as unknown as { getBlockStateId (p: unknown): number, getColumnAt (p: unknown): unknown }
  const names = bot.registry.blocksByStateId as Record<number, { name: string } | undefined>
  const p = bot.entity.position.floored()
  const own = ownBlocks(agent)
  const roads = getRoads(agent).filter(r => !r.removed)
  const ours = new Set<string>()
  for (const r of roads) for (const [x, y, z] of r.placed) ours.add(key3(x, y, z))
  const forbidden = forbiddenFor(agent, bot)
  for (let z = box.z0; z <= box.z1; z++) {
    for (let x = box.x0; x <= box.x1; x++) {
      const i = cellIndex(t, x, z)
      p.set(x, top, z)
      if (!world.getColumnAt(p)) { t.flags[i] = BLOCKED; continue }
      let ground = NO_GROUND
      let flags = 0
      for (let y = top; y >= bottom; y--) {
        const n = names[world.getBlockStateId(p.set(x, y, z))]?.name ?? 'air'
        if (n === 'water' || n === 'lava') { ground = y; flags = LIQUID; break }
        if (isReplaceable(n) || isSoftBlock(n) || n.endsWith('_leaves')) continue
        if (ours.has(key3(x, y, z))) continue // our own road: the record says what's under it
        if (isLog(n)) { ground = y; flags = BLOCKED; break }
        if (isNaturalBlock(n) && !own.has({ x, y, z })) { ground = y; break }
        ground = y
        flags = BLOCKED
        building[i] = 1
        break
      }
      if (ground === NO_GROUND) flags = BLOCKED
      else if (forbidden({ x, y: ground, z })) flags |= BLOCKED
      t.ground[i] = ground
      t.flags[i] = flags
    }
  }
  for (const r of roads) {
    for (const [x, z, f, stair, g] of r.surface) {
      const i = cellIndex(t, x!, z!)
      if (i < 0) continue
      t.flags[i] = ROAD
      building[i] = 0
      t.ground[i] = g!
      t.roadF[i] = f!
      t.roadStair[i] = stair!
    }
    for (const [x, z, , g] of r.rails) {
      const i = cellIndex(t, x!, z!)
      if (i < 0 || (t.flags[i]! & ROAD)) continue
      t.flags[i] = RAIL
      building[i] = 0
      t.ground[i] = g!
    }
  }
  markMargins(t, margin, i => building[i] === 1)
  return t
}

// ------------------------------------------------------------------ endpoints

const DOOR = /_door$/

/** The way out of a door: the side whose front cell is open (no roof over it, room to stand). */
export function doorEnd (bot: Bot, at: { x: number, y: number, z: number }): RoadEnd | null {
  let b = bot.blockAt(vec(bot, at.x, at.y, at.z))
  if (!b || !DOOR.test(b.name)) return null
  const props = (b.getProperties?.() ?? {}) as Record<string, unknown>
  if (props.half === 'upper') b = bot.blockAt(b.position.offset(0, -1, 0))
  if (!b || !DOOR.test(b.name)) return null
  const facing = (FACINGS as string[]).includes(String(props.facing)) ? props.facing as Facing : 'north'
  const pos = b.position
  const sides: Facing[] = [FACINGS[(facingIndex(facing) + 2) % 4]!, facing]
  const score = (s: Facing) => {
    const v = DIRV[s]
    const x = pos.x + v[0]
    const z = pos.z + v[1]
    let roof = 0
    for (let dy = 2; dy <= 8; dy++) {
      const n = bot.blockAt(vec(bot, x, pos.y + dy, z))?.name
      if (n && !isReplaceable(n) && !n.endsWith('_leaves') && !isNaturalBlock(n)) roof++
    }
    const feet = bot.blockAt(vec(bot, x, pos.y, z))?.name
    return roof * 2 + (feet && !isReplaceable(feet) && !isSoftBlock(feet) ? 5 : 0)
  }
  const out = score(sides[0]!) <= score(sides[1]!) ? sides[0]! : sides[1]!
  const v = DIRV[out]
  return { x: pos.x + v[0], z: pos.z + v[1], f: pos.y, out, label: `the door at ${pos.x} ${pos.y} ${pos.z}` }
}
const DIRV: Record<Facing, [number, number]> = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }

/** Door endpoints of the structures this bot finished (build records them). */
function placementEnds (agent: Agent): RoadEnd[] {
  return getPlacements(agent).flatMap(p => {
    if (!p.door) return []
    const v = DIRV[p.facing]
    return [{ x: p.door.x + v[0], z: p.door.z + v[1], f: p.door.y, out: p.facing, label: `the ${p.template} at ${p.origin.x} ${p.origin.y} ${p.origin.z}` }]
  })
}

/** Doors among the bot's own blocks (build.own), one per structure. */
function ownDoorEnds (bot: Bot, agent: Agent): RoadEnd[] {
  const list = agent.storage.get<string[] | undefined>('build.own') ?? []
  const out: RoadEnd[] = []
  for (const k of list) {
    const [x, y, z] = k.split(',').map(Number) as [number, number, number]
    const b = bot.blockAt(vec(bot, x, y, z))
    if (!b || !DOOR.test(b.name)) continue
    const e = doorEnd(bot, { x, y, z })
    if (e) out.push(e)
  }
  return out
}

/** Doors within `radius` of the bot. */
function nearbyDoorEnds (bot: Bot, radius: number): RoadEnd[] {
  const ids = Object.values(bot.registry.blocksByName).filter(d => DOOR.test(d.name) && !/trapdoor/.test(d.name)).map(d => d.id)
  return bot.findBlocks({ matching: ids, maxDistance: radius, count: 128 }).flatMap(p => { const e = doorEnd(bot, p); return e ? [e] : [] })
}

/** One endpoint per door: a double door, or the same door found twice, counts once. */
export function dedupeEnds (ends: RoadEnd[]): RoadEnd[] {
  const out: RoadEnd[] = []
  for (const e of ends) if (!out.some(o => Math.abs(o.x - e.x) + Math.abs(o.z - e.z) <= 1 && o.out === e.out && Math.abs((o.f ?? 0) - (e.f ?? 0)) <= 1)) out.push(e)
  return out
}

/** A named place, a player, "me", or coordinates, as a road endpoint (a door next to it counts as that door). */
function resolvePoint (ctx: Pick<ActionContext, 'bot' | 'agent' | 'player'>, name: string | undefined, x?: number, y?: number, z?: number): RoadEnd | string {
  const { bot, agent, player } = ctx
  let p: { x: number, y: number, z: number } | null = null
  let label = ''
  if (x !== undefined && z !== undefined) {
    p = { x: Math.floor(x), y: Math.floor(y ?? bot.entity.position.y), z: Math.floor(z) }
    label = `${p.x} ${p.y} ${p.z}`
  } else if (!name || name === 'me' || name === 'here') {
    const who = name === 'me' && player ? bot.players[player]?.entity : undefined
    const at = who?.position ?? bot.entity.position
    p = { x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) }
    label = who ? player! : 'here'
  } else {
    const place = getPlaces(agent as Agent)[name]
    const pl = bot.players[name]?.entity
    if (place) { p = { x: Math.floor(place.x), y: Math.floor(place.y), z: Math.floor(place.z) }; label = name } else if (pl) { p = { x: Math.floor(pl.position.x), y: Math.floor(pl.position.y), z: Math.floor(pl.position.z) }; label = name }
  }
  if (!p) return `don't know where "${name}" is (a saved place, a player I can see, "me", or x y z)`
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (!DOOR.test(bot.blockAt(vec(bot, p.x + dx, p.y + dy, p.z + dz))?.name ?? '')) continue
        const e = doorEnd(bot, { x: p.x + dx, y: p.y + dy, z: p.z + dz })
        if (e) return { ...e, label: `${label} (${e.label})` }
      }
    }
  }
  return { x: p.x, z: p.z, f: y !== undefined || !name || name === 'me' || name === 'here' || !!bot.players[name] ? p.y : undefined, label }
}

/** The area around some endpoints, or a reason it's too big. */
function boxAround (ends: { x: number, z: number }[], pad: number): Box | string {
  const xs = ends.map(e => e.x)
  const zs = ends.map(e => e.z)
  const box = { x0: Math.min(...xs) - pad, z0: Math.min(...zs) - pad, x1: Math.max(...xs) + pad, z1: Math.max(...zs) + pad }
  if (box.x1 - box.x0 > MAX_SIDE || box.z1 - box.z0 > MAX_SIDE) return `the places are too far apart for one plan (${box.x1 - box.x0}x${box.z1 - box.z0} blocks, at most ${MAX_SIDE}); connect them in steps`
  return box
}

/** Endpoints standing on one of our roads become T-junction starts/targets. */
function onRoad (t: RoadTerrain, e: RoadEnd): boolean {
  const i = cellIndex(t, e.x, e.z)
  return !e.out && i >= 0 && !!(t.flags[i]! & ROAD)
}

// ------------------------------------------------------------------ building

type Ctx = Pick<ActionContext, 'bot' | 'agent' | 'signal' | 'log' | 'player'>

export interface BuildOptions { method?: BuildMethod, gather: boolean, palette: RoadPalette }

export interface RoadBuildReport {
  method: 'hand' | 'commands'
  placed: number
  already: number
  cleared: number
  /** Things in the way that aren't natural or road blocks: left alone. */
  kept: string[]
  unreachable: number
  /** Items that ran out, with how many blocks went without. */
  missing: Record<string, number>
  commands: number
  notes: string[]
  placedList: RoadRecord['placed']
  cutList: RoadRecord['cut']
  /** Walkability problems found reading the road back. */
  problems: string[]
}

const blockRight = (bot: Bot, b: RoadBlock): boolean => {
  const w = bot.blockAt(vec(bot, b.x, b.y, b.z))
  if (!w || w.name !== b.block) return false
  if (!b.state?.facing) return true
  return (w.getProperties?.() as Record<string, unknown> | undefined)?.facing === b.state.facing
}

/** What may be dug out of a road's way: natural blocks and road blocks, nothing else. */
function diggable (name: string): boolean {
  return isNaturalBlock(name) || isRoadMaterial(name)
}

/**
 * Reads a road back: every lane's block is the floor or the stair facing the right way, and
 * the two blocks above it are free to walk through. Empty when it can be walked.
 */
export function walkCheck (bot: Bot, route: RouteCell[], geo: RoadGeometry, pal: RoadPalette, problems: string[] = []): string[] {
  for (const c of geo.surface) {
    const floor = bot.blockAt(vec(bot, c.x, c.f - 1, c.z))
    const want = c.stair ? pal.stair : pal.floor
    if (!floor || floor.name !== want) { problems.push(`${floor?.name ?? 'nothing'} at ${c.x} ${c.f - 1} ${c.z}, not ${want}`); continue }
    if (c.stair && (floor.getProperties?.() as Record<string, unknown> | undefined)?.facing !== c.stair) problems.push(`stair at ${c.x} ${c.f - 1} ${c.z} faces ${(floor.getProperties?.() as Record<string, unknown>).facing}, not ${c.stair}`)
    for (const dy of [0, 1]) {
      const b = bot.blockAt(vec(bot, c.x, c.f + dy, c.z))
      if (b && b.boundingBox !== 'empty') problems.push(`${b.name} blocks the way at ${c.x} ${c.f + dy} ${c.z}`)
    }
  }
  return [...routeProblems(route), ...problems]
}

/** Builds a planned road. Honest about what went in and what didn't. */
export async function buildRoad (ctx: Ctx, route: RouteCell[], geo: RoadGeometry, opts: BuildOptions): Promise<RoadBuildReport> {
  const { bot, agent, log } = ctx
  const creative = isCreative(bot)
  const ccfg = creativeSettings(agent.settings)
  const report: RoadBuildReport = { method: 'hand', placed: 0, already: 0, cleared: 0, kept: [], unreachable: 0, missing: {}, commands: 0, notes: [], placedList: [], cutList: [], problems: [] }
  if (chooseMethod(creative, opts.method, ccfg.method) === 'commands') {
    const done = await buildWithCommands(ctx, geo, report)
    if (done) {
      report.problems = walkCheck(bot, route, geo, opts.palette)
      return report
    }
    report.notes.push('no op rights for commands, built by hand instead')
  }
  await buildByHand(ctx, route, geo, opts, report, creative ? ccfg.handDelayMs : 0)
  report.problems = walkCheck(bot, route, geo, opts.palette)
  log.info('road: built', { placed: report.placed, already: report.already, cleared: report.cleared, problems: report.problems.length })
  return report
}

/** /fill and /setblock (creative, op). Returns false when the bot has no rights (nothing sent but the probe). */
async function buildWithCommands (ctx: Ctx, geo: RoadGeometry, report: RoadBuildReport): Promise<boolean> {
  const { bot, agent, signal, log } = ctx
  const forbidden = forbiddenFor(agent, bot)
  const nameAt = (x: number, y: number, z: number) => bot.blockAt(vec(bot, x, y, z))?.name ?? 'air'
  const clear: { x: number, y: number, z: number }[] = []
  const keptAt = (n: string, p: { x: number, y: number, z: number }) => { if (report.kept.length < 8) report.kept.push(`${n} at ${p.x} ${p.y} ${p.z}`) }
  const target = new Set(geo.blocks.map(b => key3(b.x, b.y, b.z)))
  for (const c of geo.clear) {
    if (target.has(key3(c.x, c.y, c.z))) continue
    const n = nameAt(c.x, c.y, c.z)
    if (n === 'air' || n === 'cave_air') continue
    if (forbidden(c)) { keptAt(n, c); continue }
    if (!diggable(n)) { keptAt(n, c); continue }
    clear.push(c)
    report.cutList.push([c.x, c.y, c.z, n])
  }
  const blocks = geo.blocks.filter(b => {
    const n = nameAt(b.x, b.y, b.z)
    if (blockRight(bot, b)) { report.already++; return false }
    if (forbidden(b)) { keptAt(n, b); return false }
    if (!isReplaceable(n) && !diggable(n)) { keptAt(n, b); return false }
    if (!isReplaceable(n) || n === 'water' || n === 'lava') report.cutList.push([b.x, b.y, b.z, n])
    return true
  })
  const commands = planCommands({
    clear,
    fills: [],
    blocks: blocks.map(b => ({ x: b.x, y: b.y, z: b.z, block: blockString(b.block, b.state as Record<string, unknown> | undefined), late: b.part === 'light' }))
  })
  if (!commands.length) return true
  log.info('road: building with commands', { commands: commands.length, blocks: blocks.length, clear: clear.length })
  const run = await runCommands(agent, commands, signal, log)
  if (run.noRights) { report.cutList = []; report.already = 0; report.kept = []; return false }
  report.method = 'commands'
  report.commands = run.sent
  if (run.errors.length) report.notes.push(`server said: ${run.errors.slice(0, 2).join(' | ')}`)
  log.warn('road: op commands are visible to other ops', { commands: run.sent })
  for (const b of blocks) {
    if (blockRight(bot, b)) { report.placed++; report.placedList.push([b.x, b.y, b.z, b.block]) }
  }
  report.cleared = clear.length
  return true
}

/** Block by block like a player (survival, or creative hand), row by row from the start. */
async function buildByHand (ctx: Ctx, route: RouteCell[], geo: RoadGeometry, opts: BuildOptions, report: RoadBuildReport, pauseMs: number): Promise<void> {
  const { bot, agent, signal, log } = ctx
  const forbidden = forbiddenFor(agent, bot)
  const creative = isCreative(bot)
  // materials for what isn't there yet
  const todo = geo.blocks.filter(b => !blockRight(bot, b))
  report.already = geo.blocks.length - todo.length
  const need: Record<string, number> = {}
  for (const b of todo) need[b.block] = (need[b.block] ?? 0) + 1
  const short = () => Object.fromEntries(Object.entries(need).map(([k, n]) => [k, n - countWant(k, inventoryCounts(bot))]).filter(([, n]) => (n as number) > 0)) as Record<string, number>
  if (Object.keys(short()).length) {
    if (creative) {
      const r = await takeFromCreative(bot, signal, short())
      if (r.error) report.notes.push(r.error)
    } else if (opts.gather) {
      const want = short()
      const light = opts.palette.light
      const optional = want[light] ? { [light]: want[light]! } : undefined
      delete want[light]
      log.info('road: gathering materials', { want: JSON.stringify(want) })
      const g = await gatherMaterials(ctx, want, { optional })
      report.notes.push(`gathered first: ${g.message}`)
      checkAborted(signal)
    }
  }
  const start = route.find(c => !c.junction) ?? route[0]!
  if (!creative && bot.entity.position.distanceTo(vec(bot, start.x, start.f, start.z)) > 8) {
    await travel(bot, { x: start.x, y: start.f, z: start.z }, signal, { range: 3 }).catch(e => { checkAborted(signal); log.debug('road: travel to the start', { error: (e as Error).message }) })
  }
  const stands = newStandMemory()
  const keptAt = (n: string, p: { x: number, y: number, z: number }) => { if (report.kept.length < 8) report.kept.push(`${n} at ${p.x} ${p.y} ${p.z}`) }
  let fails = 0
  let stop = ''

  /** Clears one cell of anything natural or road-made; false when it has to stay. */
  const clearCell = async (p: { x: number, y: number, z: number }): Promise<boolean> => {
    const b = bot.blockAt(vec(bot, p.x, p.y, p.z))
    if (!b || isReplaceable(b.name)) return true
    if (forbidden(p) || !diggable(b.name)) { keptAt(b.name, p); return false }
    if (!agent.canDig) { keptAt(`${b.name} (digging is off)`, p); return false }
    await reachToDig(bot, b.position, signal, log, stands)
    await equipFor(bot, b)
    await digBlock(bot, b, signal)
    report.cutList.push([p.x, p.y, p.z, b.name])
    report.cleared++
    return true
  }

  const placeOne = async (b: RoadBlock): Promise<'done' | 'later' | 'failed'> => {
    if (blockRight(bot, b)) return 'done'
    if (!await clearCell(b)) return 'failed'
    if (!countWant(b.block, inventoryCounts(bot))) { report.missing[b.block] = (report.missing[b.block] ?? 0) + 1; return 'failed' }
    try {
      await placeBlockState(bot, b.block, vec(bot, b.x, b.y, b.z), b.state as BlockState | undefined, signal, { canDig: agent.canDig, log, stands })
      report.placed++
      report.placedList.push([b.x, b.y, b.z, b.block])
      if (pauseMs) await handPause(pauseMs, signal)
      return 'done'
    } catch (e) {
      if (e instanceof NotPlaceableYet) return 'later'
      throw e
    }
  }

  const rows = new Map<number, { clear: RoadGeometry['clear'], blocks: RoadBlock[] }>()
  for (const c of geo.clear) { if (!rows.has(c.row)) rows.set(c.row, { clear: [], blocks: [] }); rows.get(c.row)!.clear.push(c) }
  const lights = geo.blocks.filter(b => b.part === 'light')
  for (const b of geo.blocks) { if (b.part === 'light') continue; if (!rows.has(b.row)) rows.set(b.row, { clear: [], blocks: [] }); rows.get(b.row)!.blocks.push(b) }
  const later: RoadBlock[] = []
  const order = [...[...rows.keys()].sort((a, b) => a - b).map(r => rows.get(r)!), { clear: [], blocks: lights }]
  outer: for (const row of order) {
    // head-room from the top down (sand and gravel would fall into a hole dug from below)
    for (const c of [...row.clear].sort((a, b) => b.y - a.y)) {
      checkAborted(signal)
      try { await clearCell(c) } catch (e) {
        checkAborted(signal)
        if (e instanceof DigRefusedError) { agent.markProtected(c); stop = e.message; break outer }
        if (UNREACHABLE.test((e as Error).message)) report.unreachable++
        log.debug('road: clear failed', { at: fmtPos(c), error: (e as Error).message })
      }
    }
    for (const b of row.blocks) {
      checkAborted(signal)
      try {
        const r = await placeOne(b)
        if (r === 'later') later.push(b)
        if (r === 'done') fails = 0
        else if (r === 'failed' && ++fails >= 16) { stop = 'too many blocks failed in a row'; break outer }
      } catch (e) {
        checkAborted(signal)
        if (e instanceof DigRefusedError) { agent.markProtected(b); stop = e.message; break outer }
        const msg = (e as Error).message
        if (UNREACHABLE.test(msg)) report.unreachable++
        log.debug('road: block failed', { at: fmtPos(b), block: b.block, error: msg })
        if (++fails >= 16) { stop = 'too many blocks failed in a row'; break outer }
      }
    }
  }
  for (const b of later) {
    checkAborted(signal)
    await placeOne(b).catch(e => { checkAborted(signal); log.debug('road: late block failed', { at: fmtPos(b), error: (e as Error).message }) })
  }
  if (stop) report.notes.push(`stopped: ${stop}`)

}

// ------------------------------------------------------------------ results and records

function summary (geo: RoadGeometry): string {
  const s = geo.stats
  const mats = Object.entries(s.materials).map(([k, n]) => `${n} ${k}`).join(', ')
  return `${s.length} long, ${s.stairs} stair rows, ${s.landings} landings, cut up to ${s.maxCut}, fill up to ${s.maxFill}, ${s.rails} railing posts; needs ${mats || 'nothing'}`
}

function reportText (r: RoadBuildReport, total: number): string {
  const parts = [`${r.placed + r.already}/${total} blocks in place (placed ${r.placed}${r.already ? `, ${r.already} already there` : ''}${r.cleared ? `, cleared ${r.cleared}` : ''})`]
  if (r.method === 'commands') parts.push(`${r.commands} op commands, each shown to other ops`)
  const missing = Object.entries(r.missing).map(([k, n]) => `${n} ${k}`)
  if (missing.length) parts.push(`ran out of ${missing.join(', ')}`)
  if (r.unreachable) parts.push(`${r.unreachable} spots I couldn't reach`)
  if (r.kept.length) parts.push(`left alone: ${r.kept.slice(0, 3).join(', ')}`)
  if (r.problems.length) parts.push(`not walkable yet: ${r.problems.length} problems, e.g. ${r.problems.slice(0, 2).join('; ')}`)
  else parts.push('walkable end to end')
  return [...parts, ...r.notes].join('; ')
}

function recordRoad (agent: Agent, label: string, width: number, palette: string, route: RouteCell[], geo: RoadGeometry, r: RoadBuildReport, id?: number): RoadRecord {
  const list = getRoads(agent)
  const rec: RoadRecord = {
    id: id ?? (list.reduce((m, x) => Math.max(m, x.id), 0) + 1),
    at: Date.now(),
    label,
    width,
    palette,
    route: route.map(c => [c.x, c.z, c.f, c.turn ? 1 : 0, c.junction ? 1 : 0]),
    surface: geo.surface.map(c => [c.x, c.z, c.f, c.stair ? facingIndex(c.stair) : -1, c.ground]),
    rails: geo.rails.map(c => [c.x, c.z, c.f, c.ground]),
    placed: r.placedList,
    cut: r.cutList
  }
  saveRoads(agent, [...list.filter(x => x.id !== rec.id), rec])
  agent.storage.flush()
  return rec
}

function routeOf (rec: RoadRecord): RouteCell[] {
  const cells = rec.route
  return cells.map((c, i) => {
    const next = cells[i + 1] ?? c
    const prev = cells[i - 1] ?? c
    const [ax, az, bx, bz] = cells[i + 1] ? [c[0]!, c[1]!, next[0]!, next[1]!] : [prev[0]!, prev[1]!, c[0]!, c[1]!]
    const dir: Facing = bx > ax ? 'east' : bx < ax ? 'west' : bz > az ? 'south' : 'north'
    return { x: c[0]!, z: c[1]!, f: c[2]!, dir, turn: c[3] === 1, ...(c[4] === 1 ? { junction: true } : {}) }
  })
}

interface RoadParams { width?: number, palette?: string, lanterns?: boolean, bridge?: boolean, maxCut?: number, maxFill?: number }

function optionsFor (agent: Agent, p: RoadParams): { o: Partial<RoadOptions>, palette: string, lanterns: boolean, margin: number } {
  const s = roadSettings(agent.settings)
  const o: Partial<RoadOptions> = {
    width: p.width ?? s.width,
    maxCut: agent.canDig ? (p.maxCut ?? s.maxCut) : 0,
    maxFill: p.maxFill ?? s.maxFill,
    bridge: !!p.bridge
  }
  return { o, palette: p.palette ?? s.palette, lanterns: p.lanterns ?? s.lanterns, margin: s.margin }
}

const shared = {
  width: z.number().int().min(1).max(5).optional().describe('lanes (1, 3 or 5; even widths round up); default the road.width setting (3)'),
  palette: z.enum(PALETTE_NAMES).optional().describe(`look: ${PALETTE_NAMES.join(', ')}; default the road.palette setting (stone_bricks: stone brick floor and stairs, cobblestone base, stone brick wall railings)`),
  lanterns: z.boolean().optional().describe('lanterns on posts at the landings (default the road.lanterns setting)'),
  bridge: z.boolean().default(false).describe('may cross water or lava on a deck'),
  maxCut: z.number().int().min(0).max(16).optional().describe('deepest cut into the ground (default road.maxCut, 6; 0 without digging)'),
  maxFill: z.number().int().min(0).max(24).optional().describe('highest fill above the ground (default road.maxFill, 6)'),
  dry_run: z.boolean().default(false).describe('only plan: length, stairs, landings, cut/fill and the materials needed'),
  gather: z.boolean().default(true).describe('survival: gather missing materials first (stone bricks are smelted and crafted from cobblestone)'),
  method: z.enum(BUILD_METHODS).optional().describe('creative only: hand (default, block by block) or commands (/fill and /setblock when op; every command shows to other ops)')
}

const buildRoadAction = defineAction({
  name: 'build_road',
  description: 'Plan and build a road with proper stairs between two places, like a person would: straight flights, stairs only on straight stretches (every stair facing up), ' +
    'flat landings at turns, switchbacks on steep slopes, a base filled down to the ground, head-room cut, wall railings where the drop beside it is 2 or more, ' +
    'never through buildings, trees or protected areas, joining existing roads at T-junctions. From the bot (or from_x/from_z, or `from` = a saved place or player) ' +
    'to x y z (or `to`). A point next to a door starts or ends straight out of that door. dry_run=true only plans and lists the materials. ' +
    'redo (a road id from road_list) builds a removed road again. Survival gathers stone bricks first; creative builds by hand or with commands.',
  params: z.object({
    x: z.number().optional().describe('target x'),
    y: z.number().optional().describe('target walking height (default the ground there + 1)'),
    z: z.number().optional().describe('target z'),
    to: z.string().optional().describe('target: a saved place name, a player name, or "me"'),
    from_x: z.number().optional(),
    from_y: z.number().optional(),
    from_z: z.number().optional(),
    from: z.string().optional().describe('start: a saved place, a player, or "me" (default where the bot stands)'),
    redo: z.number().int().optional().describe('id of a road built earlier (see road_list): build it again on the same line'),
    ...shared
  }),
  longRunning: true,
  async run (ctx, p) {
    const { bot, agent, log } = ctx
    if (p.redo !== undefined) return redoRoad(ctx, p.redo, p)
    const from = resolvePoint(ctx, p.from_x !== undefined ? undefined : p.from, p.from_x, p.from_y, p.from_z)
    if (typeof from === 'string') return fail(from)
    if (p.x === undefined && !p.to) return fail('where to? give x y z or `to` (a saved place or a player)')
    const to = resolvePoint(ctx, p.to, p.x, p.y, p.z)
    if (typeof to === 'string') return fail(to)
    const { o, palette, lanterns, margin } = optionsFor(agent, p)
    const box = boxAround([from, to], PAD)
    if (typeof box === 'string') return fail(box)
    const ys = [from.f, to.f, bot.entity.position.y].filter((v): v is number => v !== undefined)
    const t = scanTerrain(bot, agent, box, Math.min(...ys), Math.max(...ys), margin)
    const res = planRoad(t, {
      from: onRoad(t, from) ? [] : [from], fromRoads: onRoad(t, from) ? [from] : [],
      to: onRoad(t, to) ? [] : [to], toRoads: onRoad(t, to) ? [to] : []
    }, o)
    const label = `${from.label} to ${to.label}`
    if (!res.ok) return fail(`no road from ${label}: ${res.reason}`, { stats: res.stats })
    const width = roadOptions(o).width
    const geo = roadGeometry(res.route, t, { width, palette, lanterns })
    log.info('road: planned', { label, length: geo.stats.length, stairs: geo.stats.stairs, landings: geo.stats.landings, nodes: res.stats.nodes, ms: res.stats.ms })
    if (p.dry_run) return ok(`road from ${label}: ${summary(geo)}`, { route: res.route.length, stats: geo.stats })
    const r = await buildRoad(ctx, res.route, geo, { method: p.method, gather: p.gather, palette: paletteFor(palette) })
    const rec = recordRoad(agent, label, width, palette, res.route, geo, r)
    const text = `road ${rec.id} from ${label} (${geo.stats.length} long, ${geo.stats.stairs} stair rows, ${geo.stats.landings} landings): ${reportText(r, geo.blocks.length)}`
    const good = r.problems.length === 0 && !Object.keys(r.missing).length
    return good ? ok(text, { id: rec.id, stats: geo.stats }) : fail(text, { id: rec.id, stats: geo.stats, problems: r.problems.slice(0, 10) })
  }
})

async function redoRoad (ctx: Ctx, id: number, p: { method?: BuildMethod, gather: boolean, dry_run: boolean }): Promise<ActionResult> {
  const { bot, agent } = ctx
  const rec = getRoads(agent).find(r => r.id === id)
  if (!rec) return fail(`no road ${id}; road_list shows them`)
  if (!rec.removed) return fail(`road ${id} is still there; remove_road first to build it again`)
  const route = routeOf(rec)
  const box = boxAround(route, (rec.width - 1) / 2 + 4)
  if (typeof box === 'string') return fail(box)
  const fs = route.map(c => c.f)
  const t = scanTerrain(bot, agent, box, Math.min(...fs), Math.max(...fs), 0)
  const geo = roadGeometry(route, t, { width: rec.width, palette: rec.palette, lanterns: roadSettings(agent.settings).lanterns })
  if (p.dry_run) return ok(`road ${id} (${rec.label}) again: ${summary(geo)}`)
  const r = await buildRoad(ctx, route, geo, { method: p.method, gather: p.gather, palette: paletteFor(rec.palette) })
  recordRoad(agent, rec.label, rec.width, rec.palette, route, geo, r, rec.id)
  const text = `road ${id} (${rec.label}) built again: ${reportText(r, geo.blocks.length)}`
  return r.problems.length || Object.keys(r.missing).length ? fail(text) : ok(text)
}

const connectBuildings = defineAction({
  name: 'connect_buildings',
  description: 'Join buildings with roads and stairs, cheapest roads first, each door getting a straight start, later roads joining earlier ones at T-junctions. ' +
    'Buildings come from: what the bot built (source=built, the default), doors among its own blocks (own), doors within radius of here (nearby), ' +
    'or door coordinates (doors="x y z; x y z"). Same road rules as build_road. dry_run=true only plans.',
  params: z.object({
    source: z.enum(['built', 'own', 'nearby', 'doors']).default('built').describe('built: structures this bot finished with build; own: doors among blocks it placed; nearby: every door within radius; doors: the given coordinates'),
    doors: z.string().optional().describe('door blocks as "x y z; x y z; ..." (source=doors)'),
    radius: z.number().int().min(4).max(96).default(48).describe('how far from here to look (built, own, nearby)'),
    ...shared
  }),
  longRunning: true,
  async run (ctx, p) {
    const { bot, agent, signal, log } = ctx
    const me = bot.entity.position
    let ends: RoadEnd[] = []
    if (p.source === 'doors' || p.doors) {
      const list = (p.doors ?? '').split(/[;|]/).map(s => s.trim().split(/[\s,]+/).map(Number)).filter(a => a.length >= 3 && a.every(Number.isFinite))
      for (const [x, y, zz] of list) {
        const e = doorEnd(bot, { x: x!, y: y!, z: zz! }) ?? doorEnd(bot, { x: x!, y: y! - 1, z: zz! })
        if (!e) return fail(`no door at ${x} ${y} ${zz}`)
        ends.push(e)
      }
    } else if (p.source === 'own') {
      ends = ownDoorEnds(bot, agent)
    } else if (p.source === 'nearby') {
      ends = nearbyDoorEnds(bot, p.radius)
    } else {
      ends = placementEnds(agent)
    }
    if (p.source !== 'doors' && !p.doors) ends = ends.filter(e => Math.hypot(e.x - me.x, e.z - me.z) <= p.radius)
    ends = dedupeEnds(ends)
    if (ends.length < 2) return fail(`found ${ends.length} door${ends.length === 1 ? '' : 's'} (source=${p.source}${p.source === 'doors' ? '' : `, within ${p.radius}`}); need at least two to connect`)
    const { o, palette, lanterns, margin } = optionsFor(agent, p)
    const box = boxAround(ends, PAD)
    if (typeof box === 'string') return fail(box)
    const ys = ends.map(e => e.f ?? Math.floor(me.y))
    const t = scanTerrain(bot, agent, box, Math.min(...ys), Math.max(...ys), margin)
    const existing = roadGroups(t)
    const width = roadOptions(o).width
    const t0 = Date.now()
    const res = connect(t, ends, o, { width, palette, lanterns }, existing)
    log.info('road: network planned', { ends: ends.length, roads: res.roads.length, groups: res.groups.length, ms: Date.now() - t0 })
    const unjoined = res.groups.length > 1 ? `; not joined: ${res.failed.slice(0, 2).map(f => f.reason).join(' | ') || 'no route found'}` : ''
    const label = (r: { from: number, to: number }) => `${r.from >= 0 ? ends[r.from]!.label : 'a road'} to ${r.to >= 0 ? ends[r.to]!.label : 'the road'}`
    if (p.dry_run) {
      const lines = res.roads.map((r, i) => `${i + 1}. ${label(r)}: ${summary(r.geometry)}`)
      return (res.groups.length > 1 ? fail : ok)(`${ends.length} doors, ${res.roads.length} roads: ${lines.join(' | ')}${unjoined}`, { roads: res.roads.length })
    }
    const done: string[] = []
    let good = res.groups.length === 1
    for (const r of res.roads) {
      checkAborted(signal)
      const b = await buildRoad(ctx, r.route, r.geometry, { method: p.method, gather: p.gather, palette: paletteFor(palette) })
      const rec = recordRoad(agent, label(r), width, palette, r.route, r.geometry, b)
      if (b.problems.length || Object.keys(b.missing).length) good = false
      done.push(`road ${rec.id} ${label(r)}: ${reportText(b, r.geometry.blocks.length)}`)
    }
    const text = `connected ${ends.length} doors with ${res.roads.length} roads: ${done.join(' | ')}${unjoined}`
    return good ? ok(text, { roads: res.roads.length }) : fail(text, { roads: res.roads.length })
  }
})

/** Our roads in the area, one cell list per connected network. */
function roadGroups (t: RoadTerrain): { x: number, z: number }[][] {
  const seen = new Uint8Array(t.w * t.d)
  const out: { x: number, z: number }[][] = []
  for (let i = 0; i < seen.length; i++) {
    if (seen[i] || !(t.flags[i]! & ROAD)) continue
    const group: { x: number, z: number }[] = []
    const stack = [i]
    seen[i] = 1
    while (stack.length) {
      const j = stack.pop()!
      const x = j % t.w
      const zz = (j - x) / t.w
      group.push({ x: x + t.x0, z: zz + t.z0 })
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx
        const nz = zz + dz
        if (nx < 0 || nz < 0 || nx >= t.w || nz >= t.d) continue
        const k = nx + nz * t.w
        if (!seen[k] && (t.flags[k]! & ROAD)) { seen[k] = 1; stack.push(k) }
      }
    }
    out.push(group)
  }
  return out
}

const removeRoad = defineAction({
  name: 'remove_road',
  description: 'Take out a road this bot built (road_list shows them): breaks the blocks it placed (only where they are still its blocks) and, in creative, ' +
    'puts back the ground it dug away. build_road with redo set to its id builds it again.',
  params: z.object({
    id: z.number().int().optional().describe('road id; default the last one built'),
    restore: z.boolean().default(true).describe('creative: put back the natural blocks that were dug out for it'),
    method: z.enum(BUILD_METHODS).optional().describe('creative only: hand (default) or commands (/fill when op)')
  }),
  longRunning: true,
  async run (ctx, p) {
    const { bot, agent, signal, log } = ctx
    const list = getRoads(agent)
    const rec = p.id !== undefined ? list.find(r => r.id === p.id) : [...list].reverse().find(r => !r.removed)
    if (!rec) return fail(p.id !== undefined ? `no road ${p.id}` : 'no road of mine to remove')
    if (rec.removed) return fail(`road ${rec.id} was removed already`)
    const creative = isCreative(bot)
    const mine = rec.placed.filter(([x, y, zz, n]) => bot.blockAt(vec(bot, x, y, zz))?.name === n)
    const restore = p.restore && creative ? rec.cut.filter(([, , , n]) => isNaturalBlock(n) && !isSoftBlock(n) && n !== 'water' && n !== 'lava') : []
    let removed = 0
    let restored = 0
    let commands = 0
    const left: string[] = []
    if (chooseMethod(creative, p.method, creativeSettings(agent.settings).method) === 'commands') {
      const cmds = [
        ...mergeRuns(mine.map(([x, y, zz]) => ({ x, y, z: zz, block: 'air' }))),
        ...mergeRuns(restore.map(([x, y, zz, n]) => ({ x, y, z: zz, block: n })))
      ].map(fillCommand)
      const run = await runCommands(agent, cmds, signal, log)
      if (!run.noRights) {
        commands = run.sent
        removed = mine.filter(([x, y, zz, n]) => bot.blockAt(vec(bot, x, y, zz))?.name !== n).length
        restored = restore.filter(([x, y, zz, n]) => bot.blockAt(vec(bot, x, y, zz))?.name === n).length
      }
    }
    if (!commands) {
      // by hand: top down, then the ground back bottom up (creative)
      const stands = newStandMemory()
      for (const [x, y, zz, n] of [...mine].sort((a, b) => b[1] - a[1])) {
        checkAborted(signal)
        const b = bot.blockAt(vec(bot, x, y, zz))
        if (!b || b.name !== n) continue
        try {
          await reachToDig(bot, b.position, signal, log, stands)
          await equipFor(bot, b)
          await digBlock(bot, b, signal)
          removed++
        } catch (e) {
          checkAborted(signal)
          if (left.length < 5) left.push(`${n} at ${x} ${y} ${zz}`)
          log.debug('road: remove failed', { at: `${x} ${y} ${zz}`, error: (e as Error).message })
        }
      }
      if (restore.length) {
        const want: Record<string, number> = {}
        for (const [, , , n] of restore) want[n] = (want[n] ?? 0) + 1
        await takeFromCreative(bot, signal, want).catch(() => {})
        for (const [x, y, zz, n] of [...restore].sort((a, b) => a[1] - b[1])) {
          checkAborted(signal)
          if (!isReplaceable(bot.blockAt(vec(bot, x, y, zz))?.name)) continue
          try {
            await placeBlockState(bot, n, vec(bot, x, y, zz), undefined, signal, { log, stands })
            restored++
          } catch (e) { checkAborted(signal); log.debug('road: restore failed', { at: `${x} ${y} ${zz}`, error: (e as Error).message }) }
        }
      }
    }
    rec.removed = true
    rec.placed = mine.filter(([x, y, zz, n]) => bot.blockAt(vec(bot, x, y, zz))?.name === n)
    rec.cut = []
    saveRoads(agent, list)
    agent.storage.flush()
    const notes = [
      `removed ${removed}/${mine.length} of its blocks`,
      restore.length ? `put back ${restored}/${restore.length} ground blocks` : creative ? '' : 'the ground dug away is not put back in survival',
      commands ? `${commands} op commands` : '',
      left.length ? `couldn't break ${left.join(', ')}` : ''
    ].filter(Boolean)
    const text = `road ${rec.id} (${rec.label}): ${notes.join('; ')}. build_road redo=${rec.id} builds it again`
    return removed === mine.length ? ok(text) : fail(text)
  }
})

const roadList = defineAction({
  name: 'road_list',
  description: 'The roads this bot built: id, from where to where, length, stairs, and whether it was removed.',
  params: z.object({}),
  exclusive: false,
  run ({ agent }) {
    const list = getRoads(agent)
    if (!list.length) return ok('no roads built yet')
    return ok(list.map(r => {
      const stairs = r.surface.filter(c => c[3]! >= 0).length / Math.max(1, r.width)
      const turns = r.route.filter(c => c[3] === 1).length
      return `${r.id}: ${r.label}, ${r.route.length} long, ${Math.round(stairs)} stair rows, ${turns} landings${r.removed ? ' (removed)' : ''}`
    }).join(' | '))
  }
})

export const roads = () => defineSkill({
  name: 'roads',
  description: 'Roads and staircases between buildings: planning, building, removing.',
  actions: [buildRoadAction, connectBuildings, removeRoad, roadList]
})
