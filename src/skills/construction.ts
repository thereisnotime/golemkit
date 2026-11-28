// Building whole structures from blueprints (blueprints/*.yaml): `build` places one, `build_plan`
// says what it takes (and previews it). The planning is pure (blueprint.ts, blockstate.ts);
// this file scans the world, picks a site and a door side, prepares the ground, places blocks
// in order with the right facing/half/axis (placement.ts), checks every block afterwards and
// fixes what's off once, and reports the real outcome. A build in progress is kept in
// agent.storage, so a preempted or interrupted build resumes on the same spot and skips the
// blocks that are already right.
import type { Bot } from 'mineflayer'
import type { ActionContext, ActionResult, Agent } from '../core/index.ts'
import { defineSkill, defineAction, z, ok, fail, checkAborted, sleep, fmtPos, goals, travel, materialSourcesSettings } from '../core/index.ts'
import { vec, digBlock, DigRefusedError, gotoWithin, isReplaceable, findItem } from './world.ts'
import { equipFor, inventoryCounts, ensureTool } from './toolkit.ts'
import {
  rotate, placeCells, bounds, facingToward, facingsToward, pickFacing, resolveRoles, materials, fmtMaterials, orderCells, diffCells,
  cellState, chooseSite, isNaturalBlock, isSoftBlock, roleAccepts, solidCells, fillCells, pickTheme, renderBlueprint, pickNearby, enclosedColumns, FACINGS, WOODS,
  type Blueprint, type Column, type Facing, type Pos, type ResolvedRole, type WorldCell, type BlockState
} from './blueprint.ts'
import { checkCell, fixFor, familyOf, summarize, skipReason, finishDespiteUnreachable, underForeignRoof, distToBlock, UNREACHABLE, EYE, type QualityRow } from './blockstate.ts'
import { placeBlockState, toggleBlock, reachToDig, newStandMemory, NotPlaceableYet, PLACE_REACH, type StandMemory } from './placement.ts'
import { wantsForRoles, type RoleWants } from './materials.ts'
import { gatherFromSources } from './materialSources.ts'
import { takeItemsFromOwnChests } from './containers.ts'
import { isCreative, takeFromCreative } from './creative.ts'
import { libraryDirs, loadLibrary } from './blueprint-library.ts'
import { chooseMethod, creativeSettings, cellBlocks, planCommands, runCommands, handPause, BUILD_METHODS, type BuildMethod } from './creative-build.ts'
import { baseAnchored } from '../core/baseAnchored.ts'

// the build in progress is at the base
baseAnchored({ keys: ['build.active'] })

const ACTIVE_KEY = 'build.active'
/** Positions of blocks this bot placed for builds, so it never mistakes its own work for a player's. */
const OWN_KEY = 'build.own'

/** settings.respectBuilds: leave blocks that look player-made alone (default off: bots may use anything). */
export function respectsBuilds (agent: Pick<Agent, 'settings'>): boolean {
  return (agent.settings as { respectBuilds?: boolean }).respectBuilds === true
}
const OWN_MAX = 6000

/** The blocks this bot placed itself (agent storage, keyed by position). */
export function ownBlocks (agent: Pick<Agent, 'storage'>): { has: (p: Pos) => boolean, add: (p: Pos) => void, save: () => void } {
  const list = agent.storage.get<string[] | undefined>(OWN_KEY) ?? []
  const set = new Set(list)
  let dirty = false
  return {
    has: p => set.has(`${p.x},${p.y},${p.z}`),
    add: p => { const k = `${p.x},${p.y},${p.z}`; if (!set.has(k)) { set.add(k); dirty = true } },
    save: () => { if (dirty) { agent.storage.set(OWN_KEY, [...set].slice(-OWN_MAX)); dirty = false } }
  }
}
/** Finished builds (template, where, which way, the door), newest last, so roads can find them. */
const PLACEMENTS_KEY = 'build.placements'
const PLACEMENTS_MAX = 100

export interface Placement {
  template: string
  origin: Pos
  facing: Facing
  /** Footprint box. */
  box: { min: Pos, max: Pos }
  /** The door's lower half (no door: the middle of the entrance side). */
  door?: Pos
  at: number
}

/** The structures this bot finished building (agent storage). */
export function getPlacements (agent: Pick<Agent, 'storage'>): Placement[] {
  return agent.storage.get<Placement[] | undefined>(PLACEMENTS_KEY) ?? []
}

/** Forgets placements (e.g. a structure that was taken down). */
export function setPlacements (agent: Pick<Agent, 'storage'>, list: Placement[]): void {
  agent.storage.set(PLACEMENTS_KEY, list.slice(-PLACEMENTS_MAX))
}

function recordPlacement (agent: Pick<Agent, 'storage'>, plan: Pick<Plan, 'bp' | 'origin' | 'facing' | 'cells' | 'roles'>): void {
  const door = plan.cells.find(c => plan.roles[c.role]?.kind === 'door' && !c.passive)
  const box = bounds(plan.bp, plan.origin)
  const same = (p: Placement) => p.origin.x === plan.origin.x && p.origin.y === plan.origin.y && p.origin.z === plan.origin.z
  const list = getPlacements(agent).filter(p => !same(p))
  list.push({ template: plan.bp.name, origin: plan.origin, facing: plan.facing, box, ...(door ? { door: { x: door.x, y: door.y, z: door.z } } : {}), at: Date.now() })
  setPlacements(agent, list)
}

/** Default keep-out radius around the world spawn (vanilla spawn protection is 16). */
export const SPAWN_KEEP_OUT = 24
const SITE_RADIUS = 10
/** Placement starts once the bot is this close to the footprint (horizontally), and gives up beyond SITE_FAR. */
const SITE_NEAR = 6
const SITE_FAR = 12
/** Pathfinder search limit while building (cost over the straight-line distance): stand spots are close. */
const BUILD_SEARCH_RADIUS = 32
/** Blocks used to fill dips under a floor (site preparation). */
const FILL_ITEMS = ['dirt', 'coarse_dirt', 'cobblestone', 'cobbled_deepslate', 'andesite', 'diorite', 'granite', 'gravel']

interface ActiveBuild { template: string, origin: Pos, facing: Facing, material?: string, theme?: string, startedAt: number, placed: number, total: number }

function blockName (bot: Bot, p: Pos): string | undefined {
  const b = bot.blockAt(vec(bot, p.x, p.y, p.z))
  return b ? b.name : undefined
}

const isLog = (n: string) => /(_log|_wood|_stem|_hyphae)$/.test(n) && !n.startsWith('stripped_')

/** Ground and clutter of one column near `nearY`, or null when not loaded. */
export function scanColumn (bot: Bot, x: number, z: number, nearY: number, height: number): Column | null {
  let ground: number | null = null
  let groundName = ''
  for (let y = nearY + 6; y >= nearY - 10; y--) {
    const b = bot.blockAt(vec(bot, x, y, z))
    if (!b) return null
    const n = b.name
    if (n === 'water' || n === 'lava') { ground = y; groundName = n; break }
    if (isReplaceable(n) || isSoftBlock(n) || n.endsWith('_leaves')) continue
    if (isLog(n)) return { ground: y, groundName: n, soft: 0, foreign: true, liquid: false }
    ground = y
    groundName = n
    break
  }
  if (ground === null) return null
  if (groundName === 'water' || groundName === 'lava') return { ground, groundName, soft: 0, foreign: false, liquid: true }
  let soft = 0
  let foreign = false
  for (let y = ground + 1; y <= ground + height + 1; y++) {
    const n = blockName(bot, { x, y, z }) ?? 'air'
    if (isReplaceable(n)) continue
    if (isLog(n) || !isNaturalBlock(n)) { foreign = true; break }
    soft++
  }
  let covered = false
  for (let y = ground + height + 2; y <= ground + height + 16 && !covered; y++) {
    const n = blockName(bot, { x, y, z })
    if (n && !isReplaceable(n) && !n.endsWith('_leaves') && !isLog(n) && !isSoftBlock(n)) covered = true
  }
  return { ground, groundName, soft, foreign, liquid: false, covered }
}

function forbiddenFor (agent: Agent, bot: Bot): (p: Pos) => boolean {
  const spawn = bot.spawnPoint
  const keepOut = Number((agent.settings.build as { spawnKeepOut?: number } | undefined)?.spawnKeepOut ?? SPAWN_KEEP_OUT)
  return (p: Pos) => agent.protectedAreas.isProtected(p) ||
    (!!spawn && Math.abs(p.x - spawn.x) <= keepOut && Math.abs(p.z - spawn.z) <= keepOut)
}

/** Where blueprints are loaded from: shipped, `settings.build.blueprintDirs`, then the learned library (blueprint-library.ts). */
export function blueprintDirs (agent?: Pick<Agent, 'settings' | 'dataDir'>): string[] {
  return libraryDirs(agent).map(d => d.dir)
}

/** Every blueprint this bot can build (cached until a file changes). */
const allBlueprints = (agent: Pick<Agent, 'settings' | 'dataDir'>) => loadLibrary(libraryDirs(agent))

/** Ground y below a column (for explicit x/z without y). */
function groundY (bot: Bot, x: number, z: number): number | null {
  const c = scanColumn(bot, x, z, Math.floor(bot.entity.position.y), 4)
  return c ? c.ground : null
}

interface Plan {
  bp: Blueprint
  origin: Pos
  facing: Facing
  cells: WorldCell[]
  roles: Record<string, ResolvedRole>
  resumed: boolean
  theme?: string
  /** Dips under the floor to fill first. */
  fills: Pos[]
}

interface PlanInput { template: string, x?: number, y?: number, z?: number, facing?: Facing, material?: string, theme?: string }

const DIR: Record<Facing, [number, number]> = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }

/**
 * Is the side a door would face open? Looks at the ground just outside the footprint in front
 * of the door: walkable, natural, no water or player builds, roughly level with the floor.
 */
function frontOpen (bp: Blueprint, origin: Pos, facing: Facing, column: (x: number, z: number) => Column | null): boolean {
  const turned = rotate(bp, facing)
  const doors = placeCells(turned, origin).filter(c => bp.roles[c.role]?.kind === 'door')
  if (!doors.length) return true
  const box = bounds(turned, origin)
  const [dx, dz] = DIR[facing]
  for (const d of doors) {
    for (let k = 1; k <= 6; k++) {
      const x = d.x + dx * k
      const z = d.z + dz * k
      if (x >= box.min.x && x <= box.max.x && z >= box.min.z && z <= box.max.z) continue
      // two columns outside the footprint must be fine
      for (let j = 0; j < 2; j++) {
        const c = column(x + dx * j, z + dz * j)
        if (!c || c.foreign || c.liquid || Math.abs(c.ground - (origin.y - 1)) > 1) return false
      }
      break
    }
  }
  return true
}

/** Works out where and how a structure goes. Returns a message string when it can't. */
function planBuild ({ bot, agent, player }: Pick<ActionContext, 'bot' | 'agent' | 'player'>, p: PlanInput): Plan | string {
  const { blueprints, errors } = allBlueprints(agent)
  const bp = blueprints.get(p.template)
  if (!bp) return `unknown blueprint "${p.template}"; known: ${[...blueprints.keys()].join(', ') || 'none'}${errors.length ? ` (broken: ${errors.join('; ').slice(0, 200)})` : ''}`
  const me = bot.entity.position
  const requester = (player && bot.players[player]?.entity?.position) || me
  const active = agent.storage.get<ActiveBuild | undefined>(ACTIVE_KEY)
  let origin: Pos
  let facing: Facing
  let resumed = false
  let material = p.material
  let theme = p.theme
  const cache = new Map<string, Column | null>()
  const ny = Math.floor(requester.y)
  const column = (x: number, z: number) => {
    const k = `${x},${z}`
    if (!cache.has(k)) cache.set(k, scanColumn(bot, x, z, ny, bp.height))
    return cache.get(k)!
  }
  if (p.x !== undefined && p.z !== undefined) {
    const y = p.y ?? ((groundY(bot, p.x, p.z) ?? Math.floor(me.y) - 1) + 1)
    origin = { x: Math.floor(p.x), y: Math.floor(y), z: Math.floor(p.z) }
    facing = p.facing ?? (bp.site === 'near' ? facingToward(origin, requester) : bp.facing)
  } else if (active && active.template === bp.name && Math.hypot(active.origin.x - me.x, active.origin.z - me.z) < 64 && (!p.material || p.material === active.material)) {
    origin = active.origin
    facing = active.facing
    material = material ?? active.material
    theme = theme ?? active.theme
    resumed = true
  } else if (bp.site === 'here') {
    origin = { x: Math.floor(me.x), y: Math.floor(me.y), z: Math.floor(me.z) }
    facing = p.facing ?? bp.facing
  } else {
    const turned = rotate(bp, p.facing ?? 'south')
    const underground = !!scanColumn(bot, Math.floor(requester.x), Math.floor(requester.z), ny, 2)?.covered
    const size = Math.max(turned.width, turned.depth)
    const radius = SITE_RADIUS + Math.ceil(size / 2)
    const opts = { canDig: agent.canDig, forbidden: forbiddenFor(agent, bot), allowCovered: underground }
    // nothing close by (hills, forest): look twice as far before giving up
    const site = chooseSite(column, size, size, requester, { radius, ...opts }) ?? chooseSite(column, size, size, requester, { radius: radius * 2, ...opts })
    if (!site) return `no flat, clear spot for a ${bp.name} within ${radius * 2} blocks of ${fmtPos(requester)} (needs open sky, natural ground, no trees, water or player builds, outside protected areas); try another place or give x y z`
    origin = site.origin
    // the door faces whoever asked, unless that side is blocked (a cliff, water, a build): then the next best open side
    facing = p.facing ?? pickFacing(facingsToward(origin, requester), f => frontOpen(bp, origin, f, column))
  }
  const turned = rotate(bp, facing)
  const cells = placeCells(turned, origin)
  // a door's top half is drawn as "don't care": it still has to be clear (a leaf there traps the bot inside)
  const taken = new Set(cells.map(c => `${c.x},${c.y},${c.z}`))
  for (const d of cells.filter(c => turned.roles[c.role]?.kind === 'door' && !c.passive)) {
    const top = { x: d.x, y: d.y + 1, z: d.z }
    if (taken.has(`${top.x},${top.y},${top.z}`)) continue
    const state = { half: 'upper' }
    cells.push({ ...top, role: d.role, state, passive: true, local: { x: d.local.x, y: d.local.y + 1, z: d.local.z, role: d.role, state, passive: true } })
  }
  const forbidden = forbiddenFor(agent, bot)
  const bad = cells.find(c => forbidden(c))
  if (bad) return `won't build at ${fmtPos(origin)}: ${fmtPos(bad)} is in a protected area or too close to spawn`
  const inv = inventoryCounts(bot)
  theme = theme ?? pickTheme(inv) ?? undefined
  const roles = resolveRoles(turned, inv, material, theme)
  const fills = bp.site === 'near' ? fillCells(cells, (x, z) => column(x, z)?.ground ?? null).filter(f => !forbidden(f)) : []
  return { bp: turned, origin, facing, cells, roles, resumed, theme, fills }
}

interface ItemPick { item: string, state?: BlockState, fallback: boolean }

/** The item to place for a role now: its own items first, then its fallbacks. */
function pickItem (bot: Bot, r: ResolvedRole, cellState?: BlockState): ItemPick | null {
  const inv = inventoryCounts(bot)
  if ((inv[r.item] ?? 0) > 0) return { item: r.item, state: cellState, fallback: false }
  if (!r.strict) {
    const own = Object.entries(inv).filter(([k, n]) => n > 0 && r.accept.test(k)).sort((a, b) => b[1] - a[1])[0]?.[0]
    if (own) return { item: own, state: cellState, fallback: false }
  }
  for (const f of r.fallbacks ?? []) {
    const have = (inv[f.item] ?? 0) > 0 ? f.item : Object.entries(inv).filter(([k, n]) => n > 0 && f.accept.test(k)).sort((a, b) => b[1] - a[1])[0]?.[0]
    if (have) return { item: have, state: f.state ? { ...cellState, ...f.state } : undefined, fallback: true }
  }
  return null
}

/** Keeps the pathfinder from digging through or scaffolding inside the structure while we build. */
function guardBox (bot: Bot, box: { min: Pos, max: Pos }): () => void {
  const m = bot.pathfinder?.movements as any
  if (!m?.exclusionAreasBreak) return () => {}
  const inside = (b: { position: Pos }) => {
    const p = b.position
    return p.x >= box.min.x && p.x <= box.max.x && p.z >= box.min.z && p.z <= box.max.z && p.y >= box.min.y && p.y <= box.max.y + 1
  }
  const cost = (b: { position: Pos }) => (inside(b) ? Infinity : 0)
  m.exclusionAreasBreak.push(cost)
  m.exclusionAreasPlace.push(cost)
  return () => {
    m.exclusionAreasBreak = m.exclusionAreasBreak.filter((f: unknown) => f !== cost)
    m.exclusionAreasPlace = m.exclusionAreasPlace.filter((f: unknown) => f !== cost)
  }
}

/**
 * Shopping list for what a blueprint still needs here: the blocks not yet in place at the site
 * build would use (the one in progress, or the spot it would pick). Falls back to the whole
 * blueprint when no site can be worked out.
 */
export function remainingWants (ctx: Pick<ActionContext, 'bot' | 'agent' | 'player'>, template: string, material?: string, theme?: string): (RoleWants & { note: string }) | string {
  const planned = planBuild(ctx, { template, material, theme })
  if (typeof planned !== 'string') {
    const diff = diffCells(planned.cells, q => blockName(ctx.bot, q), planned.roles, ctx.agent.canDig, ownBlocks(ctx.agent).has)
    const left = [...diff.place, ...diff.dig]
    const done = solidCells(diff.done).length
    return { ...wantsForRoles(left, planned.roles), note: done ? `${done} blocks of the ${template} are already in place` : '' }
  }
  const bp = allBlueprints(ctx.agent).blueprints.get(template)
  if (!bp) return planned
  return { ...wantsForRoles(bp.cells, resolveRoles(bp, inventoryCounts(ctx.bot), material, theme)), note: '' }
}

export interface BuildParams extends PlanInput {
  gather: boolean
  path?: boolean
  replace?: boolean
  method?: BuildMethod
  /** Only these cells of the blueprint (one stage of a base project). Not in the action schema. */
  only?: (c: WorldCell) => boolean
  /**
   * Working on its own (base projects): only natural blocks and its own may be dug, whatever
   * settings.respectBuilds says, and spots holding anything else are left out instead of failing the build.
   */
  autonomous?: boolean
}

/**
 * Where a new structure would go near the bot (or the player): the spot and door side build
 * picks without coordinates. A message when there is none.
 */
export function planSite (ctx: Pick<ActionContext, 'bot' | 'agent' | 'player'>, template: string): { origin: Pos, facing: Facing } | string {
  const p = planBuild(ctx, { template })
  return typeof p === 'string' ? p : { origin: p.origin, facing: p.facing }
}

type BuildCtx = Pick<ActionContext, 'bot' | 'agent' | 'signal' | 'log' | 'player'>

/** A cell close enough to place into from where the bot stands now (and the bot isn't in it). */
function cellInReach (bot: Bot, c: Pos): boolean {
  const p = bot.entity.position
  const feet = { x: Math.floor(p.x), y: Math.floor(p.y + 0.01), z: Math.floor(p.z) }
  if (feet.x === c.x && feet.z === c.z && (feet.y === c.y || feet.y + 1 === c.y)) return false
  return distToBlock({ x: p.x, y: p.y + EYE, z: p.z }, c) <= PLACE_REACH - 0.8
}

/** Horizontal distance from a point to a box (0 inside). */
function distToBox (p: { x: number, z: number }, box: { min: Pos, max: Pos }): number {
  const dx = Math.max(box.min.x - p.x, 0, p.x - (box.max.x + 1))
  const dz = Math.max(box.min.z - p.z, 0, p.z - (box.max.z + 1))
  return Math.hypot(dx, dz)
}

/** Fills dips under the floor with dirt or cobblestone, whatever the bot carries. Optional: returns how many. */
async function prepareGround (ctx: BuildCtx, fills: Pos[], stands: StandMemory): Promise<{ filled: number, short: number }> {
  const { bot, signal, log } = ctx
  let filled = 0
  let short = 0
  let fails = 0
  const todo = [...fills]
  const solid = (p: Pos) => !isReplaceable(blockName(bot, p))
  const ready = (f: Pos) => solid({ x: f.x, y: f.y - 1, z: f.z }) || [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => solid({ x: f.x + dx!, y: f.y, z: f.z + dz! }))
  for (let i = 0; i < todo.length; i++) {
    checkAborted(signal)
    // the lowest dips first (todo is sorted by y), nearest one in reach first within a level
    const j = pickNearby(todo, i, f => String(f.y), ready, f => cellInReach(bot, f), f => bot.entity.position.distanceTo(vec(bot, f.x + 0.5, f.y, f.z + 0.5)))
    if (j !== i) todo.splice(i, 0, ...todo.splice(j, 1))
    const f = todo[i]!
    if (!isReplaceable(blockName(bot, f))) continue
    const item = FILL_ITEMS.find(i => findItem(bot, i))
    if (!item || fails >= 2) { short++; continue }
    try {
      await placeBlockState(bot, item, vec(bot, f.x, f.y, f.z), undefined, signal, { log, stands })
      filled++
      fails = 0
    } catch (e) {
      checkAborted(signal)
      fails++
      log.debug('site prep: fill failed', { at: fmtPos(f), error: (e as Error).message })
    }
  }
  return { filled, short }
}

/** A short dirt path from the door with a shovel, over grass only. Optional: returns how many blocks. */
async function makePath (ctx: BuildCtx, plan: Plan): Promise<number> {
  const { bot, agent, signal, log } = ctx
  const door = plan.cells.find(c => plan.roles[c.role]?.kind === 'door' && !c.passive)
  if (!door || !agent.canDig) return 0
  const box = bounds(plan.bp, plan.origin)
  const [dx, dz] = DIR[plan.facing]
  const spots: Pos[] = []
  for (let k = 1; k <= 8 && spots.length < 3; k++) {
    const x = door.x + dx * k
    const z = door.z + dz * k
    if (x >= box.min.x && x <= box.max.x && z >= box.min.z && z <= box.max.z) continue
    let found: Pos | null = null
    for (let y = plan.origin.y; y >= plan.origin.y - 3 && !found; y--) {
      const n = blockName(bot, { x, y, z })
      if (n === 'grass_block' || n === 'dirt') found = { x, y, z }
      else if (n && !isReplaceable(n) && !isSoftBlock(n)) break
    }
    if (!found || agent.protectedAreas.isProtected(found)) break
    spots.push(found)
  }
  if (!spots.length) return 0
  if (isCreative(bot)) {
    if (!bot.inventory.items().some(i => /_shovel$/.test(i.name))) await takeFromCreative(bot, signal, { wooden_shovel: 1 })
  } else {
    const tool = await ensureTool(bot, signal, 'shovel', { cheapOnly: true })
    if (!tool.ok) return 0
  }
  let made = 0
  for (const s of spots) {
    checkAborted(signal)
    try {
      const above = bot.blockAt(vec(bot, s.x, s.y + 1, s.z))
      if (above && !isReplaceable(above.name) && !isSoftBlock(above.name)) continue
      if (above && above.name !== 'air') await digBlock(bot, above, signal)
      const ground = bot.blockAt(vec(bot, s.x, s.y, s.z))
      if (!ground) continue
      await gotoWithin(bot, new goals.GoalLookAtBlock(ground.position, bot.world), signal, 15_000)
      const shovel = bot.inventory.items().find(i => /_shovel$/.test(i.name))
      if (shovel) await bot.equip(shovel, 'hand')
      await bot.activateBlock(ground)
      await sleep(250, signal)
      if (blockName(bot, s) === 'dirt_path') made++
    } catch (e) {
      checkAborted(signal)
      log.debug('path: skipped a block', { at: fmtPos(s), error: (e as Error).message })
    }
  }
  return made
}

export async function buildStructure (ctx: BuildCtx, params: BuildParams): Promise<ActionResult> {
  const { bot, agent, signal, log } = ctx
  const t0 = Date.now()
  const planned = planBuild(ctx, params)
  if (typeof planned === 'string') return fail(planned)
  let { bp, origin, facing, cells, roles, theme } = planned
  if (params.only) {
    cells = cells.filter(params.only)
    const cols = new Set(cells.map(c => `${c.x},${c.z}`))
    planned.cells = cells
    planned.fills = planned.fills.filter(f => cols.has(`${f.x},${f.z}`))
    if (!solidCells(cells).length) return ok(`nothing of the ${bp.name} to build there`)
  }
  const at = (p: Pos) => blockName(bot, p)
  const own = ownBlocks(agent)
  // replace=true (only for an owner): blocks in the footprint that don't fit may be dug and replaced,
  // e.g. our own older builds from before build.own existed. Never inside protected areas.
  // By default bots may dig anything they need (settings.respectBuilds off). With respectBuilds on,
  // only natural blocks and their own work, unless an owner asks with replace=true.
  const respect = respectsBuilds(agent)
  const ownerAsked = !!params.replace && !!ctx.player && agent.isOwner(ctx.player)
  if (respect && params.replace && !ownerAsked) return fail('replace=true is only for my owners: I don\'t dig up blocks I can\'t tell are mine otherwise')
  const mine = params.autonomous ? (p: Pos) => own.has(p) : (p: Pos) => own.has(p) || ((!respect || ownerAsked) && !agent.protectedAreas.isProtected(p))
  let diff = diffCells(cells, at, roles, agent.canDig, mine)
  let leftOut = ''
  if (diff.blocked.length && params.autonomous) {
    // on its own: someone else's blocks stay, the rest of the stage goes ahead
    const skip = new Set(diff.blocked.map(c => `${c.x},${c.y},${c.z}`))
    leftOut = `left ${diff.blocked.length} spot${diff.blocked.length === 1 ? '' : 's'} alone (blocks I didn't place, e.g. ${at(diff.blocked[0]!)} at ${fmtPos(diff.blocked[0]!)}); `
    cells = cells.filter(c => !skip.has(`${c.x},${c.y},${c.z}`))
    planned.cells = cells
    diff = diffCells(cells, at, roles, agent.canDig, mine)
  }
  if (diff.blocked.length) {
    const b = diff.blocked[0]!
    if (planned.resumed) agent.storage.delete(ACTIVE_KEY)
    return fail(`won't build a ${bp.name} at ${fmtPos(origin)}: ${diff.blocked.length} spot${diff.blocked.length === 1 ? '' : 's'} in the footprint hold blocks that ${respect ? 'look player-made (respectBuilds is on; an owner can say replace=true) or that ' : ''}I may not dig (${at(b)} at ${fmtPos(b)})`)
  }
  const solid = solidCells(cells)
  const total = solid.length
  const already = solidCells(diff.done).length
  const save = (placed: number) => { own.save(); agent.storage.set(ACTIVE_KEY, { template: bp.name, origin, facing, material: params.material, theme, startedAt: Date.now(), placed, total } satisfies ActiveBuild) }
  if (already === total && !diff.clear.length) {
    agent.storage.delete(ACTIVE_KEY)
    if (!params.only) recordPlacement(agent, planned)
    return ok(`${leftOut}the ${bp.name}${params.only ? ' part' : ''} at ${fmtPos(origin)} is already complete`)
  }

  // Creative: by hand (default) or with /fill and /setblock when op (falls back to hand without op)
  const creative = isCreative(bot)
  const ccfg = creativeSettings(agent.settings)
  let methodNote = ''
  if (chooseMethod(creative, params.method, ccfg.method) === 'commands') {
    const r = await buildWithCommands(ctx, { ...planned, roles }, diff, own, total, save)
    if (typeof r !== 'string') return r
    methodNote = `no op rights for commands (${r.slice(0, 80)}), built by hand instead; `
    log.info('build: commands refused, building by hand', { reply: r.slice(0, 200) })
  }

  // Materials for what is still to place; gather first if asked.
  let rows = materials([...diff.place, ...diff.dig], roles, inventoryCounts(bot))
  let gatherNote = leftOut + methodNote
  if ((params.gather || isCreative(bot)) && rows.some(r => r.missing)) {
    const want = wantsForRoles([...diff.place, ...diff.dig], roles)
    log.info('gathering materials before building', { need: fmtMaterials(rows) })
    const g = await gatherFromSources(ctx, want.required, { optional: want.optional, fallbacks: want.fallbacks, accepts: want.accepts, ...(theme ? { theme } : {}) })
    gatherNote = leftOut + methodNote + (isCreative(bot) ? `${g.message}; ` : `gathered first (${g.message}); `)
    log.info('materials gathered', { ok: g.ok, result: g.message })
    checkAborted(signal)
    await travel(bot, { x: origin.x, y: origin.y, z: origin.z }, signal, { range: 3 }).catch(e => { checkAborted(signal); log.debug('travel back to site', { error: (e as Error).message }) })
    theme = params.theme ?? theme ?? pickTheme(inventoryCounts(bot)) ?? undefined
    roles = resolveRoles(bp, inventoryCounts(bot), params.material, theme)
    diff = diffCells(cells, at, roles, agent.canDig, mine)
    rows = materials([...diff.place, ...diff.dig], roles, inventoryCounts(bot))
  }
  const required = rows.filter(r => !r.optional)
  if (required.length && required.every(r => r.have === 0)) {
    return fail(`${gatherNote}can't start the ${bp.name}: ${fmtMaterials(rows)}. Use gather_materials template=${bp.name}, or build with gather=true`)
  }

  // Placement walks are short on purpose (a few seconds each), so be at the site first. A travel
  // back from gathering that stopped far off used to leave every block to time out on its own.
  const box = bounds(bp, origin)
  if (!isCreative(bot) && distToBox(bot.entity.position, box) > SITE_NEAR) {
    const p = bot.entity.position
    const tx = Math.min(Math.max(Math.floor(p.x), box.min.x - 2), box.max.x + 2)
    const tz = Math.min(Math.max(Math.floor(p.z), box.min.z - 2), box.max.z + 2)
    await travel(bot, { x: tx, z: tz }, signal, { range: 3 }).catch(e => { checkAborted(signal); log.debug('travel to site', { error: (e as Error).message }) })
    const away = distToBox(bot.entity.position, box)
    if (away > SITE_FAR) {
      save(already)
      return fail(`${gatherNote}couldn't get to the ${bp.name} site at ${fmtPos(origin)}: stopped ${Math.round(away)} blocks away at ${fmtPos(bot.entity.position)}. Calling build again resumes it`)
    }
  }

  save(already)
  const unguard = guardBox(bot, box)
  // placement paths are short but the machine may be busy: give the pathfinder longer to think,
  // but keep its search near (an unreachable spot otherwise explores the whole area until the
  // think timeout); the walk itself has a short budget per stand spot (placement.ts)
  const pf = bot.pathfinder as { thinkTimeout?: number, searchRadius?: number } | undefined
  const thinkBefore = pf?.thinkTimeout
  const radiusBefore = pf?.searchRadius
  if (pf && (thinkBefore ?? 0) < 15_000) pf.thinkTimeout = 15_000
  if (pf && (radiusBefore ?? -1) < 0) pf.searchRadius = BUILD_SEARCH_RADIUS
  let placed = 0
  let dug = 0
  let fixed = 0
  let relaxed = 0
  let consecutiveFails = 0
  let prep = { filled: 0, short: 0 }
  const outOf = new Set<string>()
  const usedFallback = new Map<string, string>()
  const errors: string[] = []
  const unreachable = new Set<string>()
  const key = (p: Pos) => `${p.x},${p.y},${p.z}`
  // where (not) to stand, shared by every placement of this build: failed spots aren't tried
  // again, the inside of other structures in the footprint (a hut) is ruled out, and cells
  // still to build are avoided when there is a choice
  const planKeys = new Set(cells.map(key))
  const solidKeys = new Set(solidCells(cells).map(key))
  const insideCache = new Map<string, boolean>()
  const stands = newStandMemory({
    inside: p => {
      const k = key(p)
      let v = insideCache.get(k)
      if (v === undefined) {
        v = underForeignRoof(q => bot.blockAt(vec(bot, q.x, q.y, q.z)), p, q => planKeys.has(key(q)), isNaturalBlock)
        insideCache.set(k, v)
      }
      return v
    },
    unbuilt: p => solidKeys.has(key(p)) && isReplaceable(at(p))
  })
  const noteFail = (c: Pos, e: unknown) => {
    const msg = (e as Error).message
    errors.push(`${msg} at ${fmtPos(c)}`)
    if (UNREACHABLE.test(msg)) unreachable.add(key(c))
  }
  const front = (c: Pos) => ({ x: c.x + DIR[facing][0] * 2, y: origin.y, z: c.z + DIR[facing][1] * 2 })

  /** Places one cell (digging what's in the way first). 'later' = nothing to click for its state yet. */
  const placeCell = async (c: WorldCell, relax: boolean): Promise<'done' | 'skip' | 'later' | 'failed'> => {
    const state = cellState(c, at(c), roles, agent.canDig, mine(c))
    if (state === 'done') return 'done'
    if (state === 'blocked') { errors.push(`${at(c)} in the way at ${fmtPos(c)}`); return 'failed' }
    const r = c.role === 'air' || c.passive ? null : roles[c.role]!
    const pick = r ? pickItem(bot, r, c.state) : null
    if (r && !pick) {
      if (!r.optional) outOf.add(r.strict ? r.item : wantLabel(r))
      return 'skip'
    }
    if (state === 'dig' || state === 'clear') {
      const b = bot.blockAt(vec(bot, c.x, c.y, c.z))
      if (b && !isReplaceable(b.name)) {
        await reachToDig(bot, b.position, signal, log, stands)
        await equipFor(bot, b)
        await digBlock(bot, b, signal)
        dug++
      }
      if (!r) return 'done'
    }
    if (r!.kind === 'door') {
      // the top half isn't a cell of its own: a leaf or plant there would block the door (and trap the bot inside)
      const above = at({ x: c.x, y: c.y + 1, z: c.z })
      if (!isReplaceable(above)) {
        const b = bot.blockAt(vec(bot, c.x, c.y + 1, c.z))
        if (!b || !agent.canDig || (respectsBuilds(agent) && !isNaturalBlock(b.name) && !own.has(b.position))) { errors.push(`no headroom for the door at ${fmtPos(c)} (${above})`); return 'failed' }
        await reachToDig(bot, b.position, signal, log, stands)
        await equipFor(bot, b)
        await digBlock(bot, b, signal)
        dug++
      }
      // Put the door in from outside so the bot doesn't shut itself in.
      const f = front(c)
      await gotoWithin(bot, new goals.GoalNear(f.x, f.y, f.z, 1), signal, 20_000).catch(e => { checkAborted(signal); log.debug('door approach', { error: (e as Error).message }) })
    }
    try {
      const res = await placeBlockState(bot, pick!.item, vec(bot, c.x, c.y, c.z), relax ? undefined : pick!.state, signal, { accepts: n => roleAccepts(r!, n), canDig: agent.canDig, log, stands })
      own.add(c)
      if (creative) await handPause(ccfg.handDelayMs, signal) // a player doesn't place 10 blocks a second
      if (pick!.fallback) usedFallback.set(c.role, pick!.item)
      if (!res.ok) log.debug('placed with a wrong state', { at: fmtPos(c), item: pick!.item, wrong: res.check.hard.join(','), via: res.via })
      return 'done'
    } catch (e) {
      if (e instanceof NotPlaceableYet) return 'later'
      throw e
    }
  }

  try {
    // 1. site preparation: fill dips under the floor (clutter in the footprint is dug as cells come up)
    if (planned.fills.length) {
      // dirt for the dips out of its chests first (material source chests): without filler they stay open under the floor
      const open = planned.fills.filter(f => isReplaceable(at(f))).length
      const filler = FILL_ITEMS.reduce((n, i) => n + (inventoryCounts(bot)[i] ?? 0), 0)
      if (!creative && open > filler && materialSourcesSettings((agent.settings as { materials?: unknown }).materials).sources.includes('chests')) {
        await takeItemsFromOwnChests({ bot, agent: agent as Agent, signal }, { dirt: open - filler }, 64).catch(e => { checkAborted(signal); log.debug('site prep: no dirt from chests', { error: (e as Error).message }) })
      }
      prep = await prepareGround(ctx, planned.fills, stands)
      if (prep.filled || prep.short) log.info('site prepared', { filled: prep.filled, short: prep.short })
    }

    // 2. blocks: foundation and floor first, then walls, roof, attachments, furnishings, door
    const solidAt = (p: Pos) => { const n = at(p); return !!n && !isReplaceable(n) }
    // a bed's head or door top that holds a plant is cleared like an air cell
    const clearing = diff.clear.map(c => (c.passive ? { ...c, role: 'air', passive: undefined } : c))
    // doors go in at the very end, after the retries and the quality pass: a closed door is a wall to the
    // pathfinder, so anything still missing inside would be out of reach once it's in
    const isDoor = (c: WorldCell) => !c.passive && roles[c.role]?.kind === 'door'
    const ordered = orderCells([...clearing, ...diff.dig, ...diff.place], roles, solidAt, solidAt)
    const doors = ordered.filter(isDoor)
    const todo = ordered.filter(c => !isDoor(c))
    // resuming with the door already in: take it out so the bot can get in and out, it goes back in at
    // the end; only when something still to build is closed in behind it (blueprint.enclosedColumns)
    const doorsIn = diff.done.filter(isDoor)
    const doorY = doorsIn.length ? Math.min(...doorsIn.map(d => d.y)) : 0
    const closedIn = doorsIn.length ? enclosedColumns(cells, c => { const w = c as WorldCell; return w.role !== 'air' && roles[w.role]?.kind !== 'attachment' }, doorY) : new Set<string>()
    if (todo.some(c => c.role !== 'air' && closedIn.has(`${c.x},${c.z}`)) && agent.canDig) {
      for (const d of doorsIn) {
        const b = bot.blockAt(vec(bot, d.x, d.y, d.z))
        if (!b || !roleAccepts(roles[d.role]!, b.name)) continue
        await reachToDig(bot, b.position, signal, log, stands).catch(e => { checkAborted(signal) })
        await digBlock(bot, b, signal).catch(e => { checkAborted(signal); log.debug('could not take the door out', { error: (e as Error).message }) })
        await sleep(300, signal)
        doors.push(d)
      }
    }
    log.info(`building ${bp.name}`, { at: fmtPos(origin), facing, theme, todo: todo.length, already })
    // Placements the server refused get one more try at the end, from wherever the bot is then
    // (often it was standing in the way, or the server was slow to confirm). Cells with nothing
    // to click for their state yet (a log needing a neighbour on its axis) wait for later.
    const retried = new Set<WorldCell>()
    let deferred: WorldCell[] = []
    let retryPassStarted = false
    // batching: within a layer, whatever is ready (something to click) and in reach from where the
    // bot stands goes first, so it walks only when nothing near is left (a floor spreads from the
    // part already laid instead of zigzagging across the site)
    const groupOf = (c: WorldCell) => {
      const kind = c.role === 'air' || c.passive ? 'air' : roles[c.role]?.kind ?? 'block'
      return `${retried.has(c) ? 'retry:' : ''}${kind === 'block' ? `block:${c.y}` : kind}`
    }
    const readyOf = (c: WorldCell) => {
      if (c.role === 'air' || c.passive || cellState(c, at(c), roles, agent.canDig, mine(c)) !== 'place') return true
      return [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]].some(([dx, dy, dz]) => solidAt({ x: c.x + dx!, y: c.y + dy!, z: c.z + dz! }))
    }
    const distOf = (c: WorldCell) => bot.entity.position.distanceTo(vec(bot, c.x + 0.5, c.y, c.z + 0.5))
    for (let i = 0; i < todo.length; i++) {
      const j = pickNearby(todo, i, groupOf, readyOf, c => cellInReach(bot, c), distOf)
      if (j !== i) todo.splice(i, 0, ...todo.splice(j, 1))
      const c = todo[i]!
      checkAborted(signal)
      if (retried.has(c) && !retryPassStarted) { retryPassStarted = true; await sleep(800, signal) }
      try {
        const r = await placeCell(c, false)
        if (r === 'later') { deferred.push(c); continue }
        if (r === 'done' && c.role !== 'air' && !c.passive) {
          placed++
          consecutiveFails = 0
          if ((placed + already) % 10 === 0) { save(placed + already); log.debug('build progress', { placed: placed + already, of: total }) }
        }
        // a deferred cell may be placeable now
        if (deferred.length && r === 'done') {
          const still: WorldCell[] = []
          for (const d of deferred) {
            const rr = await placeCell(d, false).catch(e => { checkAborted(signal); noteFail(d, e); return 'failed' as const })
            if (rr === 'later') still.push(d)
            else if (rr === 'done') placed++
          }
          deferred = still
        }
      } catch (e) {
        checkAborted(signal)
        if (e instanceof DigRefusedError) {
          agent.markProtected(c)
          errors.push(e.message)
          break
        }
        log.debug('build: cell failed', { at: fmtPos(c), role: c.role, error: (e as Error).message, retry: !retried.has(c) })
        if (!retried.has(c)) {
          retried.add(c)
          todo.push(c)
          // nothing works at all: the site is out of reach, don't spend an hour proving it
          if (retried.size >= 12 && placed === 0 && dug === 0) { errors.push(`can't get to the site at ${fmtPos(origin)}`); break }
          continue
        }
        noteFail(c, e)
        if (++consecutiveFails >= 8) { errors.push('too many placements failed in a row'); break }
      }
    }
    // whatever never got a proper neighbour goes in plain (the quality pass reports the state)
    for (const d of deferred) {
      checkAborted(signal)
      const r = await placeCell(d, true).catch(e => { checkAborted(signal); noteFail(d, e); return 'failed' as const })
      if (r === 'done') { placed++; relaxed++ }
      // still nothing to click (a ladder or wall torch whose wall isn't there): say so, instead of a bare "stopped"
      else if (r === 'later') errors.push(`nothing to place ${roles[d.role]?.item ?? d.role} against at ${fmtPos(d)} (the block it hangs on is missing)`)
    }

    // 3. quality check: every block and its state; fix what's off, once
    // (blocks that already failed twice for reach aren't tried a third time: they're reported)
    fixed = await qualityFix(ctx, cells.filter(c => !isDoor(c)), roles, errors, stands, unreachable)

    // 4. the door, from outside, then its own check
    for (const d of doors) {
      checkAborted(signal)
      const r = await placeCell(d, false).catch(e => { checkAborted(signal); noteFail(d, e); return 'failed' as const })
      if (r === 'done') placed++
    }
    fixed += await qualityFix(ctx, cells.filter(isDoor), roles, errors, stands, unreachable)
  } finally {
    unguard()
    if (pf && thinkBefore !== undefined) pf.thinkTimeout = thinkBefore
    if (pf && radiusBefore !== undefined) pf.searchRadius = radiusBefore
  }

  const rowsQ = qualityRows(bot, cells, roles)
  const sum = summarize(rowsQ)
  save(sum.built)
  let pathNote = ''
  if (sum.missingRequired === 0 && params.path !== false && bp.site === 'near') {
    const n = await makePath(ctx, { ...planned, roles }).catch(e => { checkAborted(signal); log.debug('path failed', { error: (e as Error).message }); return 0 })
    if (n) pathNote = `; made a ${n}-block path from the door`
  }
  const where = `at ${fmtPos(origin)} facing ${facing}`
  const parts: string[] = []
  if (placed) parts.push(`placed ${placed}`)
  if (already) parts.push(`${already} already there`)
  if (fixed) parts.push(`fixed ${fixed}`)
  if (dug) parts.push(`cleared ${dug}`)
  if (prep.filled) parts.push(`filled ${prep.filled} under the floor`)
  const counts = parts.length ? ` (${parts.join(', ')})` : ''
  const skipped = Object.entries(sum.skipped).map(([role, n]) => `${n > 1 ? `${n} ` : ''}${role} (${skipReason(roles[role]?.item ?? role)})`)
  const subs = [...usedFallback].map(([role, item]) => `${role}: ${item} instead of ${roles[role]!.item}`)
  const notes = [
    skipped.length ? `skipped: ${skipped.join(', ')}` : '',
    subs.length ? `used ${subs.join(', ')}` : '',
    sum.wrongState ? `${sum.wrongState} block${sum.wrongState === 1 ? '' : 's'} facing the wrong way` : '',
    sum.soft ? `${sum.soft} with a different corner/hinge` : '',
    prep.short ? `${prep.short} dips left unfilled (no dirt or cobblestone)` : ''
  ].filter(Boolean)
  const tail = notes.length ? `; ${notes.join('; ')}` : ''
  const secs = Math.round((Date.now() - t0) / 1000)
  const data = { origin, facing, placed, total, built: sum.built, fixed, skipped: sum.skipped, wrongState: sum.wrongState, relaxed, seconds: secs, theme }
  // a few blocks nothing can reach (after a retry and other standing spots): done, honestly, instead of a retry loop
  const missingKeys = solidCells(cells).filter((c, i) => !roles[c.role]!.optional && rowsQ[i]!.check.status !== 'ok' && rowsQ[i]!.check.status !== 'soft').map(key)
  if (sum.missingRequired > 0 && finishDespiteUnreachable(missingKeys, unreachable, total, outOf.size > 0)) {
    agent.storage.delete(ACTIVE_KEY)
    if (!params.only) recordPlacement(agent, { ...planned, bp, roles })
    const at = missingKeys.map(k => k.replace(/,/g, ' ')).join(', ')
    return ok(`${gatherNote}built a ${bp.name} ${where}: ${sum.built}/${total} blocks${counts}; ${missingKeys.length} block${missingKeys.length === 1 ? '' : 's'} unreachable at ${at}, skipped${tail}`, { ...data, unreachable: missingKeys })
  }
  if (sum.missingRequired === 0) {
    agent.storage.delete(ACTIVE_KEY)
    if (!params.only) recordPlacement(agent, { ...planned, bp, roles })
    return ok(`${gatherNote}built a ${bp.name} ${where}: ${sum.built}/${total} blocks${counts}${tail}${pathNote}`, data)
  }
  const why = outOf.size ? `out of ${[...outOf].join(', ')}` : errors.slice(0, 2).join('; ') || 'stopped'
  const stuck = missingKeys.filter(k => unreachable.has(k)).length
  const stuckNote = stuck ? ` (${stuck} of them unreachable from anywhere I could stand)` : ''
  return fail(`${gatherNote}built ${sum.built}/${total} blocks of the ${bp.name} ${where}${counts}, ${sum.missingRequired} required still missing${stuckNote}: ${why}${tail}. Calling build again resumes it`, { ...data, unreachable: missingKeys.filter(k => unreachable.has(k)) })
}

/**
 * The commands method (creative, op): clears the plan's air cells, fills dips under the floor,
 * places the structure bottom-up with merged /fill runs and /setblock, attachments last, then
 * reads every block back. Returns the server's reply text when the bot has no op rights.
 */
async function buildWithCommands (ctx: BuildCtx, plan: Plan, diff: ReturnType<typeof diffCells>, own: ReturnType<typeof ownBlocks>, total: number, save: (placed: number) => void): Promise<ActionResult | string> {
  const { bot, agent, signal, log } = ctx
  const { bp, origin, facing, cells, roles } = plan
  const P3 = (c: Pos) => ({ x: c.x, y: c.y, z: c.z })
  const blocks = solidCells([...diff.place, ...diff.dig]).flatMap(c => cellBlocks(c, roles[c.role]!.item, roles[c.role]!.kind ?? 'block'))
  const commands = planCommands({ clear: diff.clear.map(P3), fills: plan.fills.filter(f => isReplaceable(blockName(bot, f))).map(P3), blocks })
  if (!commands.length) return ok(`the ${bp.name} at ${fmtPos(origin)} is already complete`)
  const t0 = Date.now()
  log.info(`building ${bp.name} with commands`, { at: fmtPos(origin), facing, commands: commands.length, blocks: blocks.length })
  const run = await runCommands(agent, commands, signal, log)
  if (run.noRights) return run.noRights
  await sleep(1000, signal) // block updates
  const rowsQ = qualityRows(bot, cells, roles)
  const sum = summarize(rowsQ)
  solidCells(cells).forEach((c, i) => { if (rowsQ[i]!.check.status === 'ok' || rowsQ[i]!.check.status === 'soft') own.add(c) })
  save(sum.built)
  const warn = `${run.sent} op commands, each shown to other ops as an admin message (gamerule logAdminCommands)`
  log.warn('build: op commands are visible to other ops', { commands: run.sent })
  const secs = Math.round((Date.now() - t0) / 1000)
  const data = { origin, facing, method: 'commands', commands: run.sent, total, built: sum.built, wrongState: sum.wrongState, seconds: secs }
  const errs = run.errors.length ? `; server said: ${run.errors.slice(0, 2).join(' | ')}` : ''
  if (sum.missingRequired === 0) {
    agent.storage.delete(ACTIVE_KEY)
    recordPlacement(agent, plan)
    return ok(`built a ${bp.name} at ${fmtPos(origin)} facing ${facing} with commands: ${sum.built}/${total} blocks right${sum.wrongState ? `, ${sum.wrongState} facing the wrong way` : ''} (${warn})${errs}`, data)
  }
  return fail(`placed a ${bp.name} at ${fmtPos(origin)} with commands but only ${sum.built}/${total} blocks are right, ${sum.missingRequired} required missing (${warn})${errs}. Calling build again with method=hand finishes it by hand`, data)
}

/** Every planned block checked against the world. */
function qualityRows (bot: Bot, cells: WorldCell[], roles: Record<string, ResolvedRole>): QualityRow[] {
  return solidCells(cells).map(c => {
    const r = roles[c.role]!
    const b = bot.blockAt(vec(bot, c.x, c.y, c.z))
    const check = checkCell(n => roleAccepts(r, n), c.state, b?.name, b?.getProperties?.() as Record<string, unknown> | undefined, isReplaceable)
    return { role: c.role, label: c.role, optional: r.optional, check }
  })
}

/** One fix per wrong block: place what's missing, toggle an open/closed mismatch, break and re-place a wrong facing. */
async function qualityFix (ctx: BuildCtx, cells: WorldCell[], roles: Record<string, ResolvedRole>, errors: string[], stands?: StandMemory, unreachable?: Set<string>): Promise<number> {
  const { bot, agent, signal, log } = ctx
  let fixed = 0
  // what stands now seeds the order, so a missing floor block comes after a neighbour to click
  const solidAt = (p: Pos) => !isReplaceable(blockName(bot, p))
  const ordered = orderCells(solidCells(cells), roles, solidAt, solidAt)
  for (const c of ordered) {
    checkAborted(signal)
    if (unreachable?.has(`${c.x},${c.y},${c.z}`)) continue
    const r = roles[c.role]!
    const p = vec(bot, c.x, c.y, c.z)
    const b = bot.blockAt(p)
    const check = checkCell(n => roleAccepts(r, n), c.state, b?.name, b?.getProperties?.() as Record<string, unknown> | undefined, isReplaceable)
    const action = fixFor(check, familyOf(b?.name ?? r.item, c.state), agent.canDig)
    if (action === 'none' || action === 'report') continue
    const pick = pickItem(bot, r, c.state)
    try {
      if (action === 'toggle') { await toggleBlock(bot, p, signal); fixed++; continue }
      if (!pick) continue
      if (action === 'replace' && b) {
        await reachToDig(bot, b.position, signal, log, stands)
        await equipFor(bot, b)
        await digBlock(bot, b, signal)
        await sleep(200, signal)
      }
      const res = await placeBlockState(bot, pick.item, p, pick.state, signal, { accepts: n => roleAccepts(r, n), canDig: agent.canDig, log, stands })
      if (res.ok) fixed++
    } catch (e) {
      checkAborted(signal)
      if (e instanceof DigRefusedError) { agent.markProtected(c); errors.push(e.message); break }
      log.debug('quality fix failed', { at: fmtPos(c), role: c.role, action, error: (e as Error).message })
    }
  }
  return fixed
}

function wantLabel (r: ResolvedRole): string {
  const src = r.accept.source
  for (const k of ['planks', 'trapdoor', 'door', 'stairs', 'slab', 'fence', 'log']) if (src.includes(`_${k}`)) return k === 'door' ? 'doors' : k
  return r.item
}

const facingSchema = z.enum(FACINGS as [Facing, ...Facing[]])
const themeSchema = z.string().optional().describe(`wood to build with: ${WOODS.join(', ')}; default whatever wood the bot has most of`)

const build = defineAction({
  name: 'build',
  description: 'Build a whole structure from a blueprint. For "build a house" use small_house (cozy 5x5 wooden house: log corners, pitched stair roof, windows, door, torches, ' +
    'crafting table, chest, bed if there is wool). Others: cottage (bigger 7x7 house on a cobblestone foundation with porch, glass windows, furnace), cabin (log cabin), ' +
    'watchtower (ladder, fenced platform), fortress (15x15 walled compound to put a house in), hut (plain box, quick), shelter (emergency 3x3 box around the bot), wall_segment, platform, tower. ' +
    'Picks a flat, clear spot near whoever asked (never in protected areas or over player builds), fills small dips, digs bumps and plants, faces the door to the player ' +
    '(or an open side), places blocks with the right facing (stairs, slabs, logs, doors, torches...), checks every block afterwards and fixes mistakes, and skips blocks ' +
    'that are already right, so calling it again resumes an interrupted build. gather=true first gathers what is missing. Reports blocks built and what was skipped. ' +
    'Learned blueprints (captured, imported, designed) build the same way; blueprint_pick chooses one when the request names none.',
  params: z.object({
    template: z.string().describe('blueprint name: small_house (default house), cottage, cabin, watchtower, fortress, hut, shelter, wall_segment, platform, tower, or a learned one (blueprint_search finds them)'),
    x: z.number().optional().describe('centre of the footprint; omit to pick a spot near the player'),
    y: z.number().optional().describe('level of the floor (layer 0); default the ground there + 1'),
    z: z.number().optional(),
    facing: facingSchema.optional().describe('side the entrance faces; default towards the player'),
    material: z.string().optional().describe('main block, e.g. spruce_planks or cobblestone; default whatever fits that the bot has most of'),
    theme: themeSchema,
    gather: z.boolean().default(false).describe('gather missing materials first (chop trees, mine, craft)'),
    path: z.boolean().default(true).describe('dig a short dirt path from the door afterwards when the bot can make a shovel'),
    method: z.enum(BUILD_METHODS).optional().describe('creative only: hand = place block by block like a player (default), commands = /fill and /setblock when the bot is op (fast; every command shows to other ops as an admin message), auto = the build.creativeMethod setting. Survival always builds by hand'),
    replace: z.boolean().default(false).describe('owners only: also dig up and replace blocks in the footprint that look player-made (e.g. an older build of ours being upgraded). Only when the owner asked to fix, upgrade or rebuild something there')
  }),
  longRunning: true,
  run: (ctx, p) => buildStructure(ctx, p)
})

const buildPlan = defineAction({
  name: 'build_plan',
  description: 'What a blueprint needs vs what the bot carries, and where it would go. preview=true adds a text drawing (top view and every layer). Without a template, lists the blueprints.',
  params: z.object({
    template: z.string().optional(),
    material: z.string().optional(),
    theme: themeSchema,
    x: z.number().optional(),
    y: z.number().optional(),
    z: z.number().optional(),
    facing: facingSchema.optional(),
    preview: z.boolean().default(false).describe('include a text drawing of the structure')
  }),
  exclusive: false,
  run (ctx, p) {
    const { blueprints, errors } = allBlueprints(ctx.agent)
    if (!p.template) {
      const list = [...blueprints.values()].map(b => `${b.name} (${b.width}x${b.depth}x${b.height}, ${solidCells(b.cells).length} blocks): ${b.description}`)
      return ok(`blueprints: ${list.join(' | ')}${errors.length ? ` | broken: ${errors.join('; ')}` : ''}`)
    }
    const bp0 = blueprints.get(p.template)
    if (!ctx.bot?.entity) {
      if (!bp0) return fail(`unknown blueprint "${p.template}"`)
      const prev = p.preview ? `\n${renderBlueprint(bp0)}` : ''
      return ok(`${bp0.name}: ${fmtMaterials(materials(bp0.cells, resolveRoles(bp0, {}, p.material, p.theme), {}))}${prev}`)
    }
    const planned = planBuild(ctx, { ...p, template: p.template })
    if (typeof planned === 'string') {
      if (!bp0) return fail(planned)
      const inv = inventoryCounts(ctx.bot)
      const prev = p.preview ? `\n${renderBlueprint(bp0)}` : ''
      return fail(`${planned}. Materials: ${fmtMaterials(materials(bp0.cells, resolveRoles(bp0, inv, p.material, p.theme), inv))}${prev}`)
    }
    const inv = inventoryCounts(ctx.bot)
    const diff = diffCells(planned.cells, q => blockName(ctx.bot, q), planned.roles, ctx.agent.canDig, ownBlocks(ctx.agent).has)
    const todo = solidCells([...diff.place, ...diff.dig])
    const rows = materials(todo, planned.roles, inv)
    const missing = rows.filter(r => r.missing && !r.optional)
    const blocked = diff.blocked.length ? `; ${diff.blocked.length} spots blocked by player-made blocks, won't build there` : ''
    const status = missing.length ? `missing ${missing.map(r => `${r.missing} ${r.label}`).join(', ')}` : 'have everything needed'
    const prep = planned.fills.length ? `; ${planned.fills.length} dips to fill first` : ''
    const prev = p.preview ? `\n${renderBlueprint(planned.bp)}` : ''
    return ok(`${planned.bp.name} ${planned.resumed ? '(resuming) ' : ''}at ${fmtPos(planned.origin)} facing ${planned.facing}${planned.theme ? `, ${planned.theme} wood` : ''}: ${todo.length} blocks to place, ${solidCells(diff.done).length} already there; ${fmtMaterials(rows) || 'nothing to place'}; ${status}${blocked}${prep}${prev}`,
      { origin: planned.origin, facing: planned.facing, materials: rows })
  }
})

export const construction = () => defineSkill({
  name: 'construction',
  capabilities: ['move', 'place'],
  description: 'Building structures from blueprints.',
  actions: [build, buildPlan],
  observe (agent) {
    const a = agent.storage.get<ActiveBuild | undefined>(ACTIVE_KEY)
    return a ? { build: { template: a.template, at: fmtPos(a.origin), facing: a.facing, progress: `${a.placed}/${a.total}` } } : {}
  }
})


