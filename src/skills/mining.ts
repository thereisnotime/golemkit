// Getting stone fast and safely. Instead of pathing to random buried stone (minutes of
// "took too long to decide path" on a loaded server), the bot mines what is in reach and
// exposed nearby, then digs a staircase down from where it stands and a short 3-wide strip
// at the first stone layer: no walking, many blocks per step. Every block is checked first:
// never straight down, nothing next to lava or water, a solid floor under every step,
// nothing loaded-unknown, nothing protected, only natural blocks. The planning is pure and
// unit tested (planStep, digHazard); mineStone runs it.
// Safe mining (settings.mining, minePlan.ts): below mining.safeDepth only when ready (weapon,
// food, gear), never break into a cave pocket, a torch every few steps, and abandon the dig and
// go back up the staircase when health or the odds turn underground.
import type { Bot } from 'mineflayer'
import type { ActionContext, ActionResult } from '../core/index.ts'
import { ok, fail, goals, checkAborted, fmtPos, isHostile } from '../core/index.ts'
import { digBlock, DigRefusedError, gotoWithin, vec } from './world.ts'
import { ensureTool, equipFor, inventoryCounts, toolTier, bestToolIn, harvestProblem, dropWatch, ensureSticks } from './toolkit.ts'

/** Digging gives nothing (wrong tool, full inventory...): stop and say why instead of mining on. */
export class NothingDropsError extends Error {}
import { isNaturalBlock } from './blueprint.ts'
import { digKeepOut, stepOutOfKeepOut } from './baseArea.ts'
import { pickupNearby } from './pickup.ts'
import { perMinute, makeRoom } from './efficiency.ts'
import { craftItem } from './crafting.ts'
import { wornArmorPoints } from './gear.ts'
import {
  miningSettings, miningReadiness, notReadyText, surfaceAbove, caveHazard, torchDue, torchCrafts,
  undergroundRetreat, isUnderground, depthAllowed, targetDepth, hostilesThatCount, OPEN_SKY_LIGHT,
  type MiningSettings, type Kit, type Readiness, type HostileSeen
} from './minePlan.ts'

export interface P { x: number, y: number, z: number }
/** What the planner needs to know about a block; null when the chunk is not loaded. `sky` is the sky light when known. */
export type BlockLook = (p: P) => { name: string, solid: boolean, sky?: number } | null

const LIQUID = /^(water|lava|flowing_water|flowing_lava|bubble_column)$/
const FALLING = /^(sand|red_sand|gravel|suspicious_sand|suspicious_gravel)$/
/** Blocks that are stone for the purpose of "we reached the stone layer". */
export const STONE_LIKE = /^(stone|deepslate|andesite|diorite|granite|tuff|calcite)$/
const ORE = /_ore$/
const AIR = /^(air|cave_air|void_air)$/

const key = (p: P) => `${p.x},${p.y},${p.z}`
const add = (p: P, dx: number, dy: number, dz: number): P => ({ x: p.x + dx, y: p.y + dy, z: p.z + dz })
const NEIGHBOURS: [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
export const DIRS: { x: number, z: number }[] = [{ x: 1, z: 0 }, { x: 0, z: 1 }, { x: -1, z: 0 }, { x: 0, z: -1 }]

/**
 * Why digging p is unsafe, or null. `open` holds spots that are (or will be) air on purpose
 * (the tunnel), so they don't count as unknown neighbours. Unsafe: unloaded, a liquid, lava or
 * water touching it, a falling block right above (it would drop into the tunnel and keep coming).
 */
export function digHazard (at: BlockLook, p: P, open: Set<string> = new Set()): string | null {
  const b = at(p)
  if (!b) return 'not loaded'
  if (LIQUID.test(b.name)) return b.name
  for (const [dx, dy, dz] of NEIGHBOURS) {
    const q = add(p, dx, dy, dz)
    if (open.has(key(q))) continue
    const n = at(q)
    if (!n) return 'unloaded next to it'
    if (/lava/.test(n.name)) return 'lava next to it'
    if (/water|bubble_column/.test(n.name)) return 'water next to it'
    if (dy === 1 && FALLING.test(n.name)) return `${n.name} above`
  }
  return null
}

/** Why standing at `stand` is unsafe, or null: there must be a solid, non-liquid floor (no cave or drop below). */
export function standHazard (at: BlockLook, stand: P): string | null {
  const floor = at(add(stand, 0, -1, 0))
  if (!floor) return 'floor not loaded'
  if (LIQUID.test(floor.name)) return `${floor.name} below`
  if (!floor.solid) return 'no floor (cave or drop below)'
  return null
}

export interface StepPlan {
  /** Blocks to break, in order (top first so nothing is left hanging over the bot's head). */
  dig: P[]
  /** Where the bot stands afterwards. */
  stand: P
  /** Extra blocks to break next to the new spot (3-wide strip), each checked for safety. */
  side: P[]
}

/**
 * One step of a staircase (down = true: forward and one down) or a flat tunnel, from the bot's
 * feet in direction dir. Never digs straight down: the bot always moves forward. Returns the
 * plan, or the reason the step is unsafe. `allowed` filters protected or non-natural blocks.
 */
export function planStep (at: BlockLook, feet: P, dir: { x: number, z: number }, down: boolean, allowed: (p: P, name: string) => boolean = () => true, wide = false, caves?: { belowY: number, tunnel: Set<string> }): StepPlan | string {
  const front = add(feet, dir.x, 0, dir.z)
  const stand = down ? add(front, 0, -1, 0) : front
  // top first: the space above the new spot, the bot's own head height ahead, then the feet spot
  const dig = down ? [add(front, 0, 1, 0), front, stand] : [add(front, 0, 1, 0), front]
  const open = new Set<string>([key(feet), key(add(feet, 0, 1, 0)), ...dig.map(key)])
  for (const p of dig) {
    const b = at(p)
    if (!b) return 'not loaded ahead'
    if (AIR.test(b.name)) continue
    if (!allowed(p, b.name)) return `${b.name} at ${p.x} ${p.y} ${p.z} is not mine to dig`
    const h = digHazard(at, p, open)
    if (h) return `${h} at ${p.x} ${p.y} ${p.z}`
  }
  const s = standHazard(at, stand)
  if (s) return s
  // safe mining: don't open the tunnel into a cave or an air pocket below the surface
  if (caves) {
    const c = caveHazard(at, dig.filter(p => !AIR.test(at(p)?.name ?? 'air')), stand, new Set([...open, ...caves.tunnel]), caves.belowY)
    if (c) return c
  }
  const side: P[] = []
  if (wide && !down) {
    const perp = [{ x: dir.z, z: -dir.x }, { x: -dir.z, z: dir.x }]
    for (const d of perp) {
      for (const dy of [0, 1]) {
        const p = add(stand, d.x, dy, d.z)
        const b = at(p)
        if (!b || AIR.test(b.name) || !b.solid || !allowed(p, b.name)) continue
        if (digHazard(at, p, new Set([...open, ...side.map(key)]))) continue
        if (caves && caveHazard(at, [p], stand, new Set([...open, ...side.map(key), ...caves.tunnel]), caves.belowY)) continue
        side.push(p)
      }
    }
  }
  return { dig, stand, side }
}

/** True once the step ahead is in stone: head and feet blocks both stone-like. */
export function inStoneLayer (at: BlockLook, feet: P, dir: { x: number, z: number }): boolean {
  const a = at(add(feet, dir.x, 0, dir.z))
  const b = at(add(feet, dir.x, 1, dir.z))
  return !!a && !!b && STONE_LIKE.test(a.name) && STONE_LIKE.test(b.name)
}

// ------------------------------------------------------------------ running it

type Ctx = Pick<ActionContext, 'bot' | 'agent' | 'signal' | 'log'>

export function lookFor (bot: Bot): BlockLook {
  return (p) => {
    const b = bot.blockAt(vec(bot, p.x, p.y, p.z))
    return b ? { name: b.name, solid: b.boundingBox === 'block', ...(typeof (b as any).skyLight === 'number' ? { sky: (b as any).skyLight } : {}) } : null
  }
}

/** What the bot carries that matters for going underground. */
export function kitOf (bot: Bot): Kit {
  const items = bot.inventory.items()
  const foods = (bot.registry as any).foodsByName ?? {}
  const BAD = /^(rotten_flesh|spider_eye|poisonous_potato|pufferfish|suspicious_stew|chorus_fruit)$/
  const off = bot.inventory.slots[45]?.name
  return {
    weapon: items.some(i => /_(sword|axe)$/.test(i.name)),
    food: items.filter(i => foods[i.name] && !BAD.test(i.name)).reduce((n, i) => n + i.count, 0),
    armour: wornArmorPoints(bot),
    shield: off === 'shield' || items.some(i => i.name === 'shield'),
    torches: items.filter(i => i.name === 'torch').reduce((n, i) => n + i.count, 0)
  }
}

export interface MiningState {
  s: MiningSettings
  kit: Kit
  readiness: Readiness
  /** The surface over the bot (its feet when the sky is open). */
  surface: number
}

/** Settings, kit, readiness and the surface level for this bot right now. */
export function miningState (bot: Bot, settings: Record<string, unknown>): MiningState {
  const s = miningSettings(settings.mining)
  const kit = kitOf(bot)
  const feet = bot.entity.position.floored()
  return { s, kit, readiness: miningReadiness(kit, s), surface: surfaceAbove(lookFor(bot), { x: feet.x, y: feet.y, z: feet.z }) }
}

/**
 * May the bot go for a block at p under settings.mining: always when ready (or safe mining is
 * off), otherwise only when it is at most safeDepth below the bot's surface and under at most
 * safeDepth blocks of ground.
 */
export function depthOk (bot: Bot, m: MiningState, p: P): boolean {
  if (!m.s.safe || m.readiness.ready) return true
  if (m.surface - p.y > m.s.safeDepth) return false
  const over = surfaceAbove(lookFor(bot), p, m.s.safeDepth + 1)
  return depthAllowed(targetDepth(m.surface, p, over), false, m.s)
}

/**
 * Underground (real cover overhead, little sky light) and the hostiles that count, for
 * undergroundRetreat. With the mining settings, hostiles under open sky (the surface above the
 * mine) only count within hostileClose (hostilesThatCount); a bare radius counts every one.
 */
export function undergroundNow (bot: Bot, s: number | Pick<MiningSettings, 'hostileRadius' | 'surfaceHostiles' | 'hostileClose'>): { underground: boolean, hostiles: number, air?: number } {
  const o = typeof s === 'number' ? { hostileRadius: s, surfaceHostiles: true, hostileClose: 0 } : s
  const feet = bot.entity.position.floored()
  let cover = 0
  for (let dy = 2; dy <= 24; dy++) {
    const b = bot.blockAt(feet.offset(0, dy, 0))
    if (!b) break
    if (b.boundingBox === 'block' && !/leaves|_log$|glass/.test(b.name)) cover++
  }
  const head = bot.blockAt(feet.offset(0, 1, 0)) as any
  const me = bot.entity.position
  const seen: HostileSeen[] = []
  for (const e of Object.values(bot.entities)) {
    if (e === bot.entity || !isHostile(e)) continue
    const dist = e.position.distanceTo(me)
    if (dist > o.hostileRadius) continue
    const sky = (bot.blockAt(e.position.floored().offset(0, 1, 0)) as { skyLight?: number } | null)?.skyLight
    seen.push({ dist, dy: e.position.y - me.y, ...(typeof sky === 'number' ? { open: sky >= OPEN_SKY_LIGHT } : {}) })
  }
  const hostiles = hostilesThatCount(seen, o)
  // air only counts with the head in water: the value is whatever metadata last said, and can be stale
  const air = /water|bubble_column/.test(head?.name ?? '') ? (bot as any).oxygenLevel : undefined
  return { underground: isUnderground(cover, typeof head?.skyLight === 'number' ? head.skyLight : undefined), hostiles, ...(typeof air === 'number' ? { air } : {}) }
}

/** Has (or crafts) a torch and puts it on the tunnel floor at `spot` (an air block with a solid floor). */
export async function placeTorch (bot: Bot, signal: AbortSignal, spot: P): Promise<boolean> {
  let torch = bot.inventory.items().find(i => i.name === 'torch')
  if (!torch) {
    if (torchCrafts(inventoryCounts(bot)) < 1) return false
    if (!(bot.inventory.items().some(i => i.name === 'stick')) && !await ensureSticks(bot, signal, 1).catch(() => false)) return false
    const r = await craftItem(bot, signal, 'torch', 1).catch(() => null)
    if (!r?.ok) return false
    torch = bot.inventory.items().find(i => i.name === 'torch')
    if (!torch) return false
  }
  const floor = bot.blockAt(vec(bot, spot.x, spot.y - 1, spot.z))
  const here = bot.blockAt(vec(bot, spot.x, spot.y, spot.z))
  if (!floor || floor.boundingBox !== 'block' || !here || !AIR.test(here.name)) return false
  try {
    await bot.equip(torch, 'hand')
    await bot.placeBlock(floor, vec(bot, 0, 1, 0))
    return true
  } catch {
    checkAborted(signal)
    return /torch/.test(bot.blockAt(vec(bot, spot.x, spot.y, spot.z))?.name ?? '')
  }
}

const eye = (bot: Bot) => bot.entity.position.offset(0, 1.62, 0)
const inReach = (bot: Bot, p: P) => eye(bot).distanceTo(vec(bot, p.x, p.y, p.z).offset(0.5, 0.5, 0.5)) <= 4.4

export interface MineOptions {
  /** Item that counts as progress. Default cobblestone. */
  item?: string
  /** Blocks that yield it. Default stone. */
  sources?: string[]
  /** Most staircase/tunnel steps. Default 48. */
  maxSteps?: number
  /** Walk back up to the start when done. Default true. */
  returnUp?: boolean
  /** Keep the staircase going down at least this far before the strip (prospecting for ore). Default 0. */
  minDepth?: number
  /** Apply settings.mining (readiness depth cap, caves, torches, retreat). Default true. */
  safe?: boolean
}

/**
 * Mines `count` cobblestone (or `item` from `sources`): in-reach and nearby exposed stone first,
 * then a safe staircase down and a 3-wide strip in the stone layer. Picks up the drops and
 * reports blocks broken, the rate, and why it stopped.
 */
export async function mineStone (ctx: Ctx, count: number, opts: MineOptions = {}): Promise<ActionResult> {
  const { bot, agent, signal, log } = ctx
  if (!agent.canDig) return fail('digging is disabled for this bot')
  const item = opts.item ?? 'cobblestone'
  const sources = new Set(opts.sources ?? ['stone'])
  const tool = await ensureTool(bot, signal, 'pickaxe')
  if (!tool.ok) return fail(`stone needs a pickaxe: ${tool.message}`)
  const toolNote = (tool.data as { crafted?: boolean } | undefined)?.crafted ? `${tool.message}, ` : ''
  const have = () => inventoryCounts(bot)[item] ?? 0
  const start = have()
  const t0 = Date.now()
  const at = lookFor(bot)
  const pickTier = () => toolTier(bestToolIn(Object.keys(inventoryCounts(bot)), 'pickaxe') ?? '', 'pickaxe')
  // not the ground under its own base, not a recent death spot (baseArea.ts: settings baseSafety.keepOutDepth, deathSpots)
  const allowed = (p: P, name: string) => !agent.protectedAreas.isProtected(p) && (isNaturalBlock(name) || AIR.test(name)) && (AIR.test(name) || !digKeepOut(agent, p))
  let broken = 0
  let retreat = ''
  let notReady = false
  let lit = 0
  let yielded = 0 // source blocks broken: drops reach the inventory a moment later, so count these too
  let stopped = ''
  const got = () => have() - start
  const progress = () => Math.max(got(), yielded)

  // a pickaxe that breaks mid-run is replaced with the same tier when the cobblestone is there
  const startTier = pickTier()
  let triedAt = -1
  const keepPickaxe = async () => {
    const now = pickTier()
    if (now >= startTier || now === triedAt) return
    triedAt = now
    const tier = (['wooden', 'stone', 'iron', 'diamond'] as const)[Math.min(3, startTier - 1)]!
    const r = await ensureTool(bot, signal, 'pickaxe', { minTier: tier }).catch(e => { checkAborted(signal); return fail((e as Error).message) })
    log.debug('mine: pickaxe broke', { replaced: r.ok, note: r.message })
    if (r.ok) toolsMade.push(r.message)
  }
  const toolsMade: string[] = []
  const watch = dropWatch(bot)

  const breakAt = async (p: P): Promise<boolean> => {
    const b = bot.blockAt(vec(bot, p.x, p.y, p.z))
    if (!b || AIR.test(b.name) || b.boundingBox === 'empty' && !b.name.includes('snow')) return true
    if (!bot.canDigBlock(b)) return false
    await equipFor(bot, b)
    await keepPickaxe()
    const source = sources.has(b.name)
    if (source) { const why = harvestProblem(bot, b); if (why) throw new NothingDropsError(why) }
    await digBlock(bot, b, signal, 80)
    broken++
    if (source) {
      yielded++
      const why = watch.dug(b)
      if (why) {
        // Drops lying in the tunnel aren't lost: sweep them up and only stop if that gave nothing either.
        if (/lying around/.test(why)) await pickupNearby(bot, signal, { radius: 8, maxMs: 8000 })
        if (!/lying around/.test(why) || !watch.recheck()) throw new NothingDropsError(why)
      }
    }
    return true
  }

  // Ores next to the tunnel are free progress (coal for fuel, iron for tools) when the pickaxe can take them.
  const oresNear = async (spots: P[]) => {
    for (const s of spots) {
      for (const [dx, dy, dz] of NEIGHBOURS) {
        const p = add(s, dx, dy, dz)
        const b = at(p)
        if (!b || !ORE.test(b.name) || !allowed(p, b.name) || !inReach(bot, p)) continue
        const need = /diamond|emerald|gold|redstone/.test(b.name) ? 3 : /iron|lapis|copper/.test(b.name) ? 2 : 1
        if (pickTier() < need || digHazard(at, p)) continue
        try { await breakAt(p) } catch (e) { checkAborted(signal); if (e instanceof NothingDropsError) throw e }
      }
    }
  }

  try {
    // safe mining: depth cap when not ready, cave checks, torches, retreat
    const mine = miningState(bot, agent.settings)
    const safety = opts.safe !== false && mine.s.safe
    const cap = safety && !mine.readiness.ready ? mine.surface - mine.s.safeDepth : -Infinity
    // 1. stone already in reach (never the column under our own feet), then exposed stone close by
    const feet0 = bot.entity.position.floored()
    const ids = [...sources].map(n => bot.registry.blocksByName[n]?.id).filter((x): x is number => x !== undefined)
    const candidates = () => bot.findBlocks({ matching: ids, maxDistance: 12, count: 128 })
      .map(v => ({ x: v.x, y: v.y, z: v.z }))
      .filter(p => !(p.x === Math.floor(bot.entity.position.x) && p.z === Math.floor(bot.entity.position.z) && p.y < bot.entity.position.y))
      .filter(p => p.y >= cap && allowed(p, at(p)?.name ?? '') && !digHazard(at, p) && NEIGHBOURS.some(([dx, dy, dz]) => AIR.test(at(add(p, dx, dy, dz))?.name ?? 'x')))
    let pathFails = 0
    while (progress() < count && pathFails < 2) {
      checkAborted(signal)
      const list = candidates()
      const reach = list.filter(p => inReach(bot, p))
      if (reach.length) {
        for (const p of reach) {
          if (progress() >= count) break
          try { await breakAt(p) } catch (e) { checkAborted(signal); if (e instanceof NothingDropsError) throw e; if (e instanceof DigRefusedError) agent.markProtected(vec(bot, p.x, p.y, p.z)) }
        }
        continue
      }
      const near = list.sort((a, b) => Math.hypot(a.x - feet0.x, a.y - feet0.y, a.z - feet0.z) - Math.hypot(b.x - feet0.x, b.y - feet0.y, b.z - feet0.z))[0]
      if (!near) break
      try {
        await gotoWithin(bot, new goals.GoalLookAtBlock(vec(bot, near.x, near.y, near.z), bot.world, { reach: 4 }), signal, 8000)
      } catch (e) {
        checkAborted(signal)
        if (e instanceof NothingDropsError) throw e
        pathFails++
      }
      if (!inReach(bot, near)) { pathFails++; continue }
    }

    // 2. staircase down to the stone layer, then a 3-wide strip along it; not from inside the base:
    // first out past the ground it keeps whole (settings baseSafety.keepOutDepth)
    if (progress() < count) {
      const out = stepOutOfKeepOut(agent, bot.entity.position.floored())
      if (out) {
        log.debug('mine: stepping out from over the base first', { to: `${out.x} ${out.z}` })
        await gotoWithin(bot, new goals.GoalXZ(out.x, out.z), signal, 30_000).catch(e => { checkAborted(signal); log.debug('mine: could not step out', { error: (e as Error).message }) })
      }
    }
    let feet: P = bot.entity.position.floored()
    const startY = feet.y
    const minY = Math.max(startY - 20, typeof (bot.game as any)?.minY === 'number' ? (bot.game as any).minY + 6 : -58)
    const tunnel = new Set<string>()
    const caves = safety ? { belowY: mine.surface - 1, tunnel } : undefined
    let sinceTorch = 0
    let noTorches = false
    let torchesPlaced = 0
    let dir = DIRS.map(d => ({ d, plan: planStep(at, feet, d, true, allowed, false, caves) })).find(x => typeof x.plan !== 'string')?.d ?? DIRS[0]!
    let steps = 0
    let turns = 0
    let reachedStone = false
    let sweeps = 0
    while (steps < (opts.maxSteps ?? 48)) {
      checkAborted(signal)
      if (progress() >= count) {
        // enough broken, but drops lag or lie behind us: sweep, then mine on only for what is really missing
        if (got() >= count || sweeps >= 4) break
        sweeps++
        await pickupNearby(bot, signal, { radius: 8, maxMs: 10_000 })
        yielded = got()
        if (got() >= count) break
      }
      if (bot.inventory.emptySlotCount() === 0) await makeRoom(bot, 2, new Set([item]))
      if (bot.inventory.emptySlotCount() === 0) { stopped = 'inventory full'; break }
      if (safety) {
        const u = undergroundNow(bot, mine.s)
        const why = undergroundRetreat({ ...u, underground: u.underground || feet.y < mine.surface - 3, health: bot.health }, mine.s)
        if (why) { retreat = why; stopped = `abandoned the dig and headed back up: ${why}`; break }
      }
      reachedStone ||= inStoneLayer(at, feet, dir)
      const wantDown = (!reachedStone || feet.y > startY - (opts.minDepth ?? 0)) && feet.y > minY
      if (wantDown && feet.y <= cap) {
        notReady = true
        stopped = `${notReadyText(mine.readiness)} (staying within ${mine.s.safeDepth} blocks of the surface)`
        break
      }
      const down = wantDown
      let plan = planStep(at, feet, dir, down, allowed, !down, caves)
      if (typeof plan === 'string' && down) {
        const flat = planStep(at, feet, dir, false, allowed, true, caves)
        if (typeof flat !== 'string') plan = flat
      }
      if (typeof plan === 'string') {
        log.debug('mine: step unsafe, turning', { at: fmtPos(feet), reason: plan })
        if (++turns > 3) { stopped = `every way on is unsafe (${plan})`; break }
        dir = DIRS[(DIRS.indexOf(dir) + 1) % 4]!
        continue
      }
      turns = 0
      let blocked = false
      for (const p of plan.dig) {
        try {
          if (!await breakAt(p)) { blocked = true; break }
        } catch (e) {
          checkAborted(signal)
          if (e instanceof DigRefusedError) { agent.markProtected(vec(bot, p.x, p.y, p.z)); stopped = 'protected area'; blocked = true; break }
          throw e
        }
      }
      if (blocked) { if (stopped) break; dir = DIRS[(DIRS.indexOf(dir) + 1) % 4]!; continue }
      // falling blocks or water may have moved in: re-check before stepping
      if (standHazard(at, plan.stand) || plan.dig.some(p => { const b = at(p); return !b || !AIR.test(b.name) && b.solid })) {
        for (const p of plan.dig) await breakAt(p).catch(() => false)
        if (standHazard(at, plan.stand)) { dir = DIRS[(DIRS.indexOf(dir) + 1) % 4]!; continue }
      }
      try {
        await gotoWithin(bot, new goals.GoalBlock(plan.stand.x, plan.stand.y, plan.stand.z), signal, 6000)
      } catch (e) {
        checkAborted(signal)
        if (e instanceof NothingDropsError) throw e
        stopped = `couldn't step to ${fmtPos(plan.stand)}`
        break
      }
      const prev = feet
      feet = bot.entity.position.floored()
      steps++
      for (const p of [...plan.dig, feet, add(feet, 0, 1, 0)]) tunnel.add(key(p))
      // light the tunnel behind us: mobs don't spawn in it and the way back is visible
      sinceTorch++
      if (safety && !noTorches && feet.y < mine.surface - 2 && torchDue(sinceTorch, mine.s, (bot.blockAt(vec(bot, feet.x, feet.y, feet.z)) as any)?.light)) {
        if (await placeTorch(bot, signal, prev)) { sinceTorch = 0; torchesPlaced++ } else noTorches = !bot.inventory.items().some(i => i.name === 'torch') && torchCrafts(inventoryCounts(bot)) < 1
      }
      for (const p of plan.side) {
        if (progress() >= count) break
        if (digHazard(at, p, new Set([key(feet), key(add(feet, 0, 1, 0))]))) continue
        try { if (await breakAt(p)) tunnel.add(key(p)) } catch (e) { checkAborted(signal); if (e instanceof NothingDropsError) throw e }
      }
      await oresNear([feet, add(feet, 0, 1, 0)])
    }
    lit = torchesPlaced
    if (!stopped && progress() < count && steps >= (opts.maxSteps ?? 48)) stopped = `stopped after ${steps} steps`
    // drops land in the tunnel; one short sweep for the ones that didn't fly to us (not when fleeing)
    if (!retreat) await pickupNearby(bot, signal, { radius: 8, maxMs: 10_000 })
    if ((opts.returnUp !== false || retreat) && feet0.y - bot.entity.position.y > 2) {
      await gotoWithin(bot, new goals.GoalNear(feet0.x, feet0.y, feet0.z, 1), signal, 30_000).catch(e => { checkAborted(signal); log.debug('mine: no way back up', { error: (e as Error).message }) })
    }
  } catch (e) {
    checkAborted(signal)
    stopped = (e as Error).message
  }
  const ms = Date.now() - t0
  const rate = `${broken} blocks in ${Math.round(ms / 1000)}s, ${perMinute(broken, ms)}/min${lit ? `, ${lit} torch${lit === 1 ? '' : 'es'} placed` : ''}${toolsMade.length ? `; pickaxe broke, ${toolsMade.join(', ')}` : ''}`
  log.info('mined', { item, got: got(), wanted: count, broken, perMin: perMinute(broken, ms), ...(retreat ? { retreat } : {}) })
  const extra = { ...(retreat ? { retreat } : {}), ...(notReady ? { notReady: true } : {}) }
  if (got() >= count) return ok(`${toolNote}mined ${got()} ${item} (${rate})`, { got: got(), broken, ms, ...extra })
  if (got() > 0) return ok(`${toolNote}mined ${got()} of ${count} ${item} (${rate}); stopped: ${stopped || 'ran out of stone'}`, { got: got(), broken, ms, ...extra })
  return fail(`${toolNote}mined no ${item} (${rate}): ${stopped || 'no stone found'}`, { got: 0, broken, ms, ...extra })
}

