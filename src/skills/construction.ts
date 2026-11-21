// Building whole structures from blueprints (blueprints/*.yaml): `build` places one, `build_plan`
// says what it takes. The planning is pure (blueprint.ts); this file scans the world, picks a
// site, places blocks in order and reports the real outcome. A build in progress is kept in
// agent.storage, so a preempted or interrupted build resumes on the same spot and skips the
// blocks that are already right.
import type { Bot } from 'mineflayer'
import type { ActionContext, ActionResult, Agent } from '../core/index.ts'
import { defineSkill, defineAction, z, ok, fail, checkAborted, sleep, fmtPos, goals, travel } from '../core/index.ts'
import { vec, placeAt, digBlock, DigRefusedError, gotoWithin, isReplaceable } from './world.ts'
import { equipFor, inventoryCounts } from './toolkit.ts'
import {
  loadBlueprints, rotate, placeCells, bounds, facingToward, resolveRoles, materials, fmtMaterials, orderCells, diffCells,
  cellState, chooseSite, isNaturalBlock, isSoftBlock, FACINGS,
  type Blueprint, type Column, type Facing, type Pos, type ResolvedRole, type WorldCell
} from './blueprint.ts'
import { gatherMaterials, wantsForRoles } from './materials.ts'

const ACTIVE_KEY = 'build.active'
/** Default keep-out radius around the world spawn (vanilla spawn protection is 16). */
const SPAWN_KEEP_OUT = 24
const SITE_RADIUS = 10

interface ActiveBuild { template: string, origin: Pos, facing: Facing, material?: string, startedAt: number, placed: number, total: number }

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
}

interface PlanInput { template: string, x?: number, y?: number, z?: number, facing?: Facing, material?: string }

/** Works out where and how a structure goes. Returns a message string when it can't. */
function planBuild ({ bot, agent, player }: Pick<ActionContext, 'bot' | 'agent' | 'player'>, p: PlanInput): Plan | string {
  const { blueprints, errors } = loadBlueprints()
  const bp = blueprints.get(p.template)
  if (!bp) return `unknown blueprint "${p.template}"; known: ${[...blueprints.keys()].join(', ') || 'none'}${errors.length ? ` (broken: ${errors.join('; ').slice(0, 200)})` : ''}`
  const me = bot.entity.position
  const requester = (player && bot.players[player]?.entity?.position) || me
  const active = agent.storage.get<ActiveBuild | undefined>(ACTIVE_KEY)
  let origin: Pos
  let facing: Facing
  let resumed = false
  let material = p.material
  if (p.x !== undefined && p.z !== undefined) {
    const y = p.y ?? ((groundY(bot, p.x, p.z) ?? Math.floor(me.y) - 1) + 1)
    origin = { x: Math.floor(p.x), y: Math.floor(y), z: Math.floor(p.z) }
    facing = p.facing ?? (bp.site === 'near' ? facingToward(origin, requester) : bp.facing)
  } else if (active && active.template === bp.name && Math.hypot(active.origin.x - me.x, active.origin.z - me.z) < 64 && (!p.material || p.material === active.material)) {
    origin = active.origin
    facing = active.facing
    material = material ?? active.material
    resumed = true
  } else if (bp.site === 'here') {
    origin = { x: Math.floor(me.x), y: Math.floor(me.y), z: Math.floor(me.z) }
    facing = p.facing ?? bp.facing
  } else {
    const cache = new Map<string, Column | null>()
    const ny = Math.floor(requester.y)
    const column = (x: number, z: number) => {
      const k = `${x},${z}`
      if (!cache.has(k)) cache.set(k, scanColumn(bot, x, z, ny, bp.height))
      return cache.get(k)!
    }
    const turned = rotate(bp, p.facing ?? 'south')
    const underground = !!scanColumn(bot, Math.floor(requester.x), Math.floor(requester.z), ny, 2)?.covered
    const size = Math.max(turned.width, turned.depth)
    const site = chooseSite(column, size, size, requester, { radius: SITE_RADIUS, canDig: agent.canDig, forbidden: forbiddenFor(agent, bot), allowCovered: underground })
    if (!site) return `no flat, clear spot for a ${bp.name} within ${SITE_RADIUS} blocks of ${fmtPos(requester)} (needs open sky, natural ground, no trees, water or player builds, outside protected areas); try another place or give x y z`
    origin = site.origin
    facing = p.facing ?? facingToward(origin, requester)
  }
  const turned = rotate(bp, facing)
  const cells = placeCells(turned, origin)
  const forbidden = forbiddenFor(agent, bot)
  const bad = cells.find(c => forbidden(c))
  if (bad) return `won't build at ${fmtPos(origin)}: ${fmtPos(bad)} is in a protected area or too close to spawn`
  const roles = resolveRoles(turned, inventoryCounts(bot), material)
  return { bp: turned, origin, facing, cells, roles, resumed }
}

function pickItem (bot: Bot, r: ResolvedRole): string | null {
  const inv = inventoryCounts(bot)
  if ((inv[r.item] ?? 0) > 0) return r.item
  if (r.strict) return null
  return Object.entries(inv).filter(([k, n]) => n > 0 && r.accept.test(k)).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
}

const DIR: Record<Facing, [number, number]> = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }

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
export function remainingWants (ctx: Pick<ActionContext, 'bot' | 'agent' | 'player'>, template: string, material?: string): { required: Record<string, number>, optional: Record<string, number>, note: string } | string {
  const planned = planBuild(ctx, { template, material })
  if (typeof planned !== 'string') {
    const diff = diffCells(planned.cells, q => blockName(ctx.bot, q), planned.roles, ctx.agent.canDig)
    const left = [...diff.place, ...diff.dig]
    const done = diff.done.filter(c => c.role !== 'air').length
    return { ...wantsForRoles(left, planned.roles), note: done ? `${done} blocks of the ${template} are already in place` : '' }
  }
  const bp = loadBlueprints().blueprints.get(template)
  if (!bp) return planned
  return { ...wantsForRoles(bp.cells, resolveRoles(bp, inventoryCounts(ctx.bot), material)), note: '' }
}

export interface BuildParams extends PlanInput { gather: boolean }

export async function buildStructure (ctx: Pick<ActionContext, 'bot' | 'agent' | 'signal' | 'log' | 'player'>, params: BuildParams): Promise<ActionResult> {
  const { bot, agent, signal, log } = ctx
  const planned = planBuild(ctx, params)
  if (typeof planned === 'string') return fail(planned)
  let { bp, origin, facing, cells, roles } = planned
  const at = (p: Pos) => blockName(bot, p)
  let diff = diffCells(cells, at, roles, agent.canDig)
  if (diff.blocked.length) {
    const b = diff.blocked[0]!
    if (planned.resumed) agent.storage.delete(ACTIVE_KEY)
    return fail(`won't build a ${bp.name} at ${fmtPos(origin)}: ${diff.blocked.length} spot${diff.blocked.length === 1 ? '' : 's'} in the footprint hold blocks that look player-made or that I may not dig (${at(b)} at ${fmtPos(b)})`)
  }
  const solid = cells.filter(c => c.role !== 'air')
  const total = solid.length
  const already = diff.done.filter(c => c.role !== 'air').length
  const save = (placed: number) => agent.storage.set(ACTIVE_KEY, { template: bp.name, origin, facing, material: params.material, startedAt: Date.now(), placed, total } satisfies ActiveBuild)
  if (already === total && !diff.clear.length) {
    agent.storage.delete(ACTIVE_KEY)
    return ok(`the ${bp.name} at ${fmtPos(origin)} is already complete`)
  }

  // Materials for what is still to place; gather first if asked.
  let rows = materials([...diff.place, ...diff.dig], roles, inventoryCounts(bot))
  let gatherNote = ''
  if (params.gather && rows.some(r => r.missing)) {
    const want = wantsForRoles([...diff.place, ...diff.dig], roles)
    log.info('gathering materials before building', { need: fmtMaterials(rows) })
    const g = await gatherMaterials(ctx, want.required, { optional: want.optional })
    gatherNote = `gathered first (${g.message}); `
    checkAborted(signal)
    await travel(bot, { x: origin.x, y: origin.y, z: origin.z }, signal, { range: 3 }).catch(e => { checkAborted(signal); log.debug('travel back to site', { error: (e as Error).message }) })
    roles = resolveRoles(bp, inventoryCounts(bot), params.material)
    diff = diffCells(cells, at, roles, agent.canDig)
    rows = materials([...diff.place, ...diff.dig], roles, inventoryCounts(bot))
  }
  const required = rows.filter(r => !r.optional)
  if (required.length && required.every(r => r.have === 0)) {
    return fail(`${gatherNote}can't start the ${bp.name}: ${fmtMaterials(rows)}. Use gather_materials template=${bp.name}, or build with gather=true`)
  }

  save(already)
  const unguard = guardBox(bot, bounds(bp, origin))
  let placed = 0
  let dug = 0
  let consecutiveFails = 0
  const outOf = new Set<string>()
  const skippedOptional = new Set<string>()
  const errors: string[] = []
  const front = (c: Pos) => ({ x: c.x + DIR[facing][0] * 2, y: origin.y, z: c.z + DIR[facing][1] * 2 })
  try {
    const solidAt = (p: Pos) => { const n = at(p); return !!n && !isReplaceable(n) }
    const todo = orderCells([...diff.clear, ...diff.dig, ...diff.place], roles, solidAt)
    log.info(`building ${bp.name}`, { at: fmtPos(origin), facing, todo: todo.length, already })
    // Placements the server refused get one more try at the end, from wherever the bot is then
    // (often it was standing in the way, or the server was slow to confirm).
    const retried = new Set<WorldCell>()
    let retryPassStarted = false
    for (let i = 0; i < todo.length; i++) {
      const c = todo[i]!
      checkAborted(signal)
      if (retried.has(c) && !retryPassStarted) { retryPassStarted = true; await sleep(800, signal) }
      const state = cellState(c, at(c), roles, agent.canDig)
      if (state === 'done') continue
      if (state === 'blocked') { errors.push(`${at(c)} in the way at ${fmtPos(c)}`); continue }
      const r = c.role === 'air' ? null : roles[c.role]!
      const item = r ? pickItem(bot, r) : null
      if (r && !item) {
        if (r.optional) skippedOptional.add(r.item)
        else outOf.add(r.strict ? r.item : wantLabel(r))
        continue
      }
      try {
        if (state === 'dig' || state === 'clear') {
          const b = bot.blockAt(vec(bot, c.x, c.y, c.z))
          if (b && !isReplaceable(b.name)) {
            await gotoWithin(bot, new goals.GoalLookAtBlock(b.position, bot.world), signal, 20_000)
            await equipFor(bot, b)
            await digBlock(bot, b, signal)
            dug++
          }
          if (!r) continue
        }
        if (r!.kind === 'door') {
          const above = at({ x: c.x, y: c.y + 1, z: c.z })
          if (!isReplaceable(above)) { errors.push(`no headroom for the door at ${fmtPos(c)}`); continue }
          // Put the door in from outside so the bot doesn't shut itself in.
          const f = front(c)
          await gotoWithin(bot, new goals.GoalNear(f.x, f.y, f.z, 1), signal, 20_000).catch(e => { checkAborted(signal); log.debug('door approach', { error: (e as Error).message }) })
        }
        await placeAt(bot, item!, vec(bot, c.x, c.y, c.z), signal)
        placed++
        consecutiveFails = 0
        if ((placed + already) % 10 === 0) { save(placed + already); log.debug('build progress', { placed: placed + already, of: total }) }
      } catch (e) {
        checkAborted(signal)
        if (e instanceof DigRefusedError) {
          agent.markProtected(c)
          errors.push(e.message)
          break
        }
        if (!retried.has(c)) { retried.add(c); todo.push(c); continue }
        errors.push(`${(e as Error).message} at ${fmtPos(c)}`)
        if (++consecutiveFails >= 8) { errors.push('too many placements failed in a row'); break }
      }
    }
  } finally {
    unguard()
  }

  const finalDiff = diffCells(cells, at, roles, agent.canDig)
  const doneSolid = finalDiff.done.filter(c => c.role !== 'air')
  const doneRequired = doneSolid.filter(c => !roles[c.role]!.optional).length
  const totalRequired = solid.filter(c => !roles[c.role]!.optional).length
  const optionalLeft = solid.length - doneSolid.length - (totalRequired - doneRequired)
  save(doneSolid.length)
  const where = `at ${fmtPos(origin)} facing ${facing}`
  const parts: string[] = []
  if (placed) parts.push(`placed ${placed}`)
  if (already) parts.push(`${already} already there`)
  if (dug) parts.push(`cleared ${dug}`)
  const counts = parts.length ? ` (${parts.join(', ')})` : ''
  const optNote = skippedOptional.size || optionalLeft ? `; left out optional ${[...skippedOptional].join(', ') || `${optionalLeft} block(s)`}` : ''
  if (doneRequired >= totalRequired) {
    agent.storage.delete(ACTIVE_KEY)
    return ok(`${gatherNote}built a ${bp.name} ${where}: ${doneSolid.length}/${total} blocks${counts}${optNote}`, { origin, facing, placed, total })
  }
  const why = outOf.size ? `out of ${[...outOf].join(', ')}` : errors.slice(0, 2).join('; ') || 'stopped'
  return fail(`${gatherNote}built ${doneRequired}/${totalRequired} blocks of the ${bp.name} ${where}${counts}, ${why}. Calling build again resumes it`, { origin, facing, placed, total })
}

function wantLabel (r: ResolvedRole): string {
  if (r.accept.source.includes('_planks')) return 'planks'
  if (r.accept.source.includes('_door')) return 'doors'
  return r.item
}

const facingSchema = z.enum(FACINGS as [Facing, ...Facing[]])

const build = defineAction({
  name: 'build',
  description: 'Build a whole structure from a blueprint: hut (small 5x5 wooden house with door, roof and torch), shelter (emergency 3x3 box around the bot), ' +
    'wall_segment, platform, tower. Picks a flat, clear spot near whoever asked (never in protected areas or over player builds), levels small bumps, ' +
    'places floor, walls, roof, then torch and door, and skips blocks that are already right, so calling it again resumes an interrupted build. ' +
    'gather=true first chops trees and crafts whatever is missing. Reports how many blocks it placed. Use build_plan to check materials first.',
  params: z.object({
    template: z.string().describe('blueprint name: hut, shelter, wall_segment, platform, tower (build_plan lists all)'),
    x: z.number().optional().describe('centre of the footprint; omit to pick a spot near the player'),
    y: z.number().optional().describe('level of the floor (layer 0); default the ground there + 1'),
    z: z.number().optional(),
    facing: facingSchema.optional().describe('side the entrance faces; default towards the player'),
    material: z.string().optional().describe('main block, e.g. spruce_planks or cobblestone; default whatever fits that the bot has most of'),
    gather: z.boolean().default(false).describe('gather missing materials first (chop trees, craft planks and a door)')
  }),
  longRunning: true,
  run: (ctx, p) => buildStructure(ctx, p)
})

const buildPlan = defineAction({
  name: 'build_plan',
  description: 'What a blueprint needs vs what the bot carries, and where it would go. Without a template, lists the blueprints.',
  params: z.object({
    template: z.string().optional(),
    material: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    z: z.number().optional(),
    facing: facingSchema.optional()
  }),
  exclusive: false,
  run (ctx, p) {
    const { blueprints, errors } = loadBlueprints()
    if (!p.template) {
      const list = [...blueprints.values()].map(b => `${b.name} (${b.width}x${b.depth}x${b.height}, ${b.cells.filter(c => c.role !== 'air').length} blocks): ${b.description}`)
      return ok(`blueprints: ${list.join(' | ')}${errors.length ? ` | broken: ${errors.join('; ')}` : ''}`)
    }
    if (!ctx.bot?.entity) {
      const bp = blueprints.get(p.template)
      if (!bp) return fail(`unknown blueprint "${p.template}"`)
      return ok(`${bp.name}: ${fmtMaterials(materials(bp.cells, resolveRoles(bp, {}, p.material), {}))}`)
    }
    const planned = planBuild(ctx, { ...p, template: p.template })
    if (typeof planned === 'string') {
      const bp = blueprints.get(p.template)
      if (!bp) return fail(planned)
      const inv = inventoryCounts(ctx.bot)
      return fail(`${planned}. Materials: ${fmtMaterials(materials(bp.cells, resolveRoles(bp, inv, p.material), inv))}`)
    }
    const inv = inventoryCounts(ctx.bot)
    const diff = diffCells(planned.cells, q => blockName(ctx.bot, q), planned.roles, ctx.agent.canDig)
    const todo = [...diff.place, ...diff.dig]
    const rows = materials(todo, planned.roles, inv)
    const missing = rows.filter(r => r.missing && !r.optional)
    const blocked = diff.blocked.length ? `; ${diff.blocked.length} spots blocked by player-made blocks, won't build there` : ''
    const status = missing.length ? `missing ${missing.map(r => `${r.missing} ${r.label}`).join(', ')}` : 'have everything needed'
    return ok(`${planned.bp.name} ${planned.resumed ? '(resuming) ' : ''}at ${fmtPos(planned.origin)} facing ${planned.facing}: ${todo.length} blocks to place, ${diff.done.filter(c => c.role !== 'air').length} already there; ${fmtMaterials(rows) || 'nothing to place'}; ${status}${blocked}`,
      { origin: planned.origin, facing: planned.facing, materials: rows })
  }
})

export const construction = () => defineSkill({
  name: 'construction',
  description: 'Building structures from blueprints.',
  actions: [build, buildPlan],
  observe (agent) {
    const a = agent.storage.get<ActiveBuild | undefined>(ACTIVE_KEY)
    return a ? { build: { template: a.template, at: fmtPos(a.origin), facing: a.facing, progress: `${a.placed}/${a.total}` } } : {}
  }
})

