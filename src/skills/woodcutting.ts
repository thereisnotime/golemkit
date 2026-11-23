import type { Bot } from 'mineflayer'
import type { Block } from 'prismarine-block'
import type { Vec3 } from 'vec3'
import { defineSkill, defineAction, z, ok, fail, checkAborted, fmtPos, goals, sleep, travel, dangerMemory, type Agent, type ActionResult, type ActionContext } from '../core/index.ts'
import { reachBlock, within, placeAt, findItem, isReplaceable, digBlock, DigRefusedError, gotoWithin } from './world.ts'
import { pickupNearby } from './pickup.ts'
import { ensureTool, inventoryCounts, planksFor } from './toolkit.ts'
import { fillerBlock } from './survival.ts'
import { autoUpgrade } from './progression.ts'
import { scoutWaypoints, compass, type XZ } from './foodPlan.ts'
import {
  nextTreeStep, mergeTreeSpot, markTreeSpotEmpty, recordTreeSearch, treeRetryInMs, spotKey, DEFAULT_TREE_RINGS,
  type TreeSpot, type SearchRecord
} from './treePlan.ts'

/** Wood type of a natural log ("oak" for oak_log), or null for anything else (stripped logs included). */
export function woodType (name: string): string | null {
  if (name.startsWith('stripped_')) return null
  const m = /^([a-z_]+)_(log|stem)$/.exec(name)
  if (!m || m[1] === 'mushroom') return null
  return m[1]
}

export function saplingFor (wood: string): string | null {
  if (wood === 'mangrove') return 'mangrove_propagule'
  if (wood === 'crimson' || wood === 'warped') return null // fungi need nylium, skip
  return `${wood}_sapling`
}

/** Leaves the world grew (players' leaves are persistent). */
export function isNaturalLeaves (name: string, props: Record<string, unknown>): boolean {
  if (!name.endsWith('_leaves') && name !== 'nether_wart_block' && name !== 'warped_wart_block') return false
  return props.persistent !== true && props.persistent !== 'true'
}

const SOIL = new Set(['dirt', 'grass_block', 'podzol', 'coarse_dirt', 'rooted_dirt', 'mud', 'moss_block', 'mycelium'])
const MAX_LOGS = 80
const SPREAD = 4 // how far branches may reach sideways from the trunk

interface Tree { wood: string, base: Vec3, logs: Vec3[] }

/** Collects the connected logs of one tree and checks it is natural (has natural leaves). */
function scanTree (bot: Bot, start: Block): Tree | null {
  const wood = woodType(start.name)
  if (!wood) return null
  // walk down to the base of the trunk
  let base = start.position
  while (bot.blockAt(base.offset(0, -1, 0))?.name === start.name) base = base.offset(0, -1, 0)
  const logs: Vec3[] = []
  const seen = new Set<string>()
  const queue = [base]
  let naturalLeaves = 0
  while (queue.length && logs.length < MAX_LOGS) {
    const p = queue.shift()!
    const key = `${p.x},${p.y},${p.z}`
    if (seen.has(key)) continue
    seen.add(key)
    const b = bot.blockAt(p)
    if (!b) continue
    if (b.name !== start.name) {
      if (isNaturalLeaves(b.name, b.getProperties() as Record<string, unknown>)) naturalLeaves++
      continue
    }
    if (p.y < base.y || Math.abs(p.x - base.x) > SPREAD || Math.abs(p.z - base.z) > SPREAD) continue
    logs.push(p)
    for (let dx = -1; dx <= 1; dx++) for (let dy = 0; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      if (dx || dy || dz) queue.push(p.offset(dx, dy, dz))
    }
  }
  if (naturalLeaves < 3) return null // log pile, house wall or a stump: not a tree
  logs.sort((a, b) => a.y - b.y || a.distanceTo(base) - b.distanceTo(base))
  return { wood, base, logs }
}

/** Up to `max` distinct natural trees within `radius`, nearest first. */
function scanTrees (bot: Bot, radius: number, skip: (p: Vec3) => boolean = () => false, max = 1): Tree[] {
  const ids = Object.values(bot.registry.blocksByName).filter(b => woodType(b.name)).map(b => b.id)
  // Plenty of candidates: the nearest logs are often one tree, a wooden house or a protected spot.
  const candidates = bot.findBlocks({ matching: ids, maxDistance: radius, count: 256 })
  const tried = new Set<string>()
  const out: Tree[] = []
  for (const p of candidates) {
    if (out.length >= max) break
    if (skip(p)) continue
    // logs of a tree already found are skipped without a scan
    if (out.some(t => t.logs.some(l => l.x === p.x && l.y === p.y && l.z === p.z))) continue
    const b = bot.blockAt(p)
    if (!b) continue
    const tree = scanTree(bot, b)
    if (!tree) continue
    const key = `${tree.base.x},${tree.base.y},${tree.base.z}`
    if (tried.has(key)) continue
    tried.add(key)
    out.push(tree)
  }
  return out
}

function findTree (bot: Bot, radius: number, skip: (p: Vec3) => boolean = () => false): Tree | null {
  return scanTrees(bot, radius, skip, 1)[0] ?? null
}

async function equipAxe (bot: Bot, block: Block): Promise<void> {
  const tool = bot.pathfinder.bestHarvestTool(block)
  if (tool && bot.heldItem?.type !== tool.type) await bot.equip(tool, 'hand').catch(() => {})
}

export interface FellOptions {
  radius: number
  replant: boolean
  /** Craft a wooden axe first when there is none and the inventory has the wood for it. */
  makeAxe?: boolean
}

/**
 * Fells one natural tree (the chop_tree action's body, reused by gather_materials inside its
 * own lock). Crafts an axe first when asked and the wood for it is already in the inventory.
 */
export async function fellTree ({ bot, agent, signal, log }: Pick<ActionContext, 'bot' | 'agent' | 'signal' | 'log'>, { radius, replant, makeAxe = true }: FellOptions): Promise<ActionResult> {
  if (!agent.canDig) return fail('digging is disabled for this bot')
  let axeNote = await autoUpgrade({ bot, agent, signal, log }, { kinds: ['axe', 'pickaxe'] })
  if (makeAxe && !axeNote) {
    const axe = await ensureTool(bot, signal, 'axe', { cheapOnly: true }).catch(e => { checkAborted(signal); return fail((e as Error).message) })
    if (axe.ok && (axe.data as { crafted?: boolean } | undefined)?.crafted) axeNote = `crafted a ${(axe.data as { item: string }).item}, `
  }
  // Trees in areas where the server refuses breaking (spawn protection) are skipped; if a cut
  // gets refused anyway, the area is remembered and the next tree is tried. Trees in (or past) a
  // remembered danger zone (a skeleton or patrol from a recent fight) are skipped too.
  const danger = dangerMemory(agent)
  const from = bot.entity.position.clone()
  let avoided = 0
  const skip = (p: Vec3) => {
    if (agent.protectedAreas.isProtected(p)) return true
    if (danger.isInDanger(p) || danger.crosses(from, p)) { avoided++; return true }
    return false
  }
  let tree = findTree(bot, radius, skip)
  const logsBefore = logsHeld(bot)
  let firstCut = 0
  let logName = ''
  for (let attempt = 0; tree && attempt < 3; attempt++) {
    const base = bot.blockAt(tree.base)
    if (!base) break
    logName = base.name // read before cutting, the block is air afterwards
    try {
      if (!within(bot, tree.base)) await reachBlock(bot, tree.base, signal, 2, 12_000)
      await equipAxe(bot, base)
      await digBlock(bot, base, signal)
      firstCut = 1
      break // first log came off: this tree can be felled
    } catch (e) {
      checkAborted(signal)
      if (!(e instanceof DigRefusedError)) break
      agent.markProtected(tree.base)
      log.debug('tree is in a protected area, trying another', { at: fmtPos(tree.base) })
      tree = findTree(bot, radius, skip)
    }
  }
  if (!tree) {
    const me = bot.entity.position
    const zoneNear = agent.protectedAreas.zones.some(z => Math.hypot(z.x - me.x, z.z - me.z) < radius + 24)
    if (avoided && !zoneNear) return fail(`no tree within ${radius} blocks outside the danger zones I remember (${danger.active().map(z => z.kind).join(', ')} nearby)`)
    return fail(zoneNear
      ? `no tree I'm allowed to cut within ${radius} blocks (trees near spawn are protected); try further away`
      : `no natural tree within ${radius} blocks`)
  }
  log.debug('felling tree', { wood: tree.wood, at: fmtPos(tree.base), logs: tree.logs.length })
  rememberTreesNear(bot, agent, skip)
  const soil = bot.blockAt(tree.base.offset(0, -1, 0))?.name ?? ''
  if (!logName) logName = `${tree.wood}_log`
  let cut = firstCut
  let skipped = 0
  for (const p of tree.logs) {
    checkAborted(signal)
    const b = bot.blockAt(p)
    if (!b || b.name !== logName) continue // already gone (fell with a neighbour or someone else cut it)
    // High logs can't be reached from the ground: don't spend path searches on them, climb instead.
    if (!within(bot, p) && p.y - tree.base.y > 4) continue
    try {
      if (!within(bot, p)) await reachBlock(bot, p, signal, 2, 12_000)
      if (!within(bot, p)) { skipped++; continue }
      await equipAxe(bot, b)
      await digBlock(bot, b, signal)
      cut++
    } catch (e) {
      checkAborted(signal)
      if (e instanceof DigRefusedError) return cut ? ok(`chopped ${cut} ${logName}, then: ${e.message}`) : fail(e.message)
      log.debug('log skipped', { at: fmtPos(p), error: (e as Error).message })
      skipped++
    }
  }
  // Tall trees (spruce, jungle): climb the trunk on a pillar and cut the rest from inside it.
  const highLeft = tree.logs.filter(p => bot.blockAt(p)?.name === logName).length
  let climbed = 0
  if (cut && highLeft) {
    const r = await climbAndChop(bot, signal, log, tree, logName, (p) => agent.protectedAreas.isProtected(p))
    cut += r.cut
    climbed = r.climbed
  }
  skipped = tree.logs.filter(p => bot.blockAt(p)?.name === logName).length
  if (!cut) return fail(`couldn't reach the ${tree.wood} tree at ${fmtPos(tree.base)}`)
  const picked = await collectTreeDrops(bot, signal)
  const logsGot = logsHeld(bot) - logsBefore

  let planted = ''
  const sapling = saplingFor(tree.wood)
  if (replant && sapling && findItem(bot, sapling) && SOIL.has(soil) && isReplaceable(bot.blockAt(tree.base)?.name)) {
    try {
      await placeAt(bot, sapling, tree.base, signal)
      planted = `, planted a ${sapling}`
    } catch (e) {
      checkAborted(signal)
      log.debug('replant failed', { sapling, error: (e as Error).message })
    }
  }
  const left = skipped ? `, left ${skipped} log${skipped === 1 ? '' : 's'} out of reach` : ''
  const lost = cut - logsGot > 0 ? `, ${cut - logsGot} of the logs didn't reach my inventory (drops I couldn't get to${bot.inventory.emptySlotCount() === 0 ? ', inventory full' : ''})` : ''
  const climb = climbed ? `, climbed ${climbed} up the trunk` : ''
  log.debug('tree felled', { cut, logsGot, skipped, climbed, picked })
  return ok(`${axeNote}chopped ${cut} ${logName}${climb}${left}, ${logsGot} logs in the inventory${lost}, picked up ${picked} items${planted}`, { cut, logsGot, skipped })
}

/** Logs (any wood) in the inventory. */
function logsHeld (bot: Bot): number {
  return Object.entries(inventoryCounts(bot)).reduce((n, [k, v]) => n + (planksFor(k) ? v : 0), 0)
}

const isAir = (name: string | undefined) => !name || name === 'air' || name === 'cave_air'

/** Jumps and places a block under itself (one step of a pillar). True when it worked. */
async function jumpPlace (bot: Bot, signal: AbortSignal, item: string): Promise<boolean> {
  const it = findItem(bot, item)
  if (!it) return false
  const feet = bot.entity.position.floored()
  const ground = bot.blockAt(feet.offset(0, -1, 0))
  if (!ground || ground.boundingBox !== 'block') return false
  await bot.equip(it, 'hand')
  await bot.look(bot.entity.yaw, -Math.PI / 2, true)
  try {
    bot.setControlState('jump', true)
    const until = Date.now() + 1500
    while (bot.entity.position.y < feet.y + 1.05 && Date.now() < until) await sleep(50, signal)
    try {
      await bot.placeBlock(ground, feet.minus(ground.position))
    } catch {
      await sleep(200, signal)
    }
  } finally {
    bot.setControlState('jump', false)
  }
  await sleep(250, signal)
  return bot.blockAt(feet)?.boundingBox === 'block'
}

/**
 * Climbs a tall trunk: stands in the trunk column (its bottom logs are cut), cuts every log in
 * reach, pillars up one block with a filler block (or one of the logs) and repeats. On the way
 * down it digs its pillar again, so nothing is left behind and the filler comes back.
 */
async function climbAndChop (bot: Bot, signal: AbortSignal, log: ActionContext['log'], tree: Tree, logName: string, isProtected: (p: Vec3) => boolean): Promise<{ cut: number, climbed: number }> {
  const left = () => tree.logs.filter(p => bot.blockAt(p)?.name === logName)
  const column = tree.logs.filter(p => p.x === tree.base.x && p.z === tree.base.z)
  const standAt = tree.base
  if (!isAir(bot.blockAt(standAt)?.name) || !isAir(bot.blockAt(standAt.offset(0, 1, 0))?.name) || isProtected(standAt)) return { cut: 0, climbed: 0 }
  try {
    await gotoWithin(bot, new goals.GoalBlock(standAt.x, standAt.y, standAt.z), signal, 8000)
  } catch (e) {
    checkAborted(signal)
    return { cut: 0, climbed: 0 }
  }
  if (!bot.entity.position.floored().equals(standAt)) return { cut: 0, climbed: 0 }
  let cut = 0
  const pillar: Vec3[] = []
  try {
    for (let level = 0; level < 24; level++) {
      checkAborted(signal)
      for (const p of left().sort((a, b) => b.y - a.y)) {
        if (!within(bot, p)) continue
        const b = bot.blockAt(p)
        if (!b) continue
        await equipAxe(bot, b)
        try { await digBlock(bot, b, signal, 80); cut++ } catch (e) { checkAborted(signal); if (e instanceof DigRefusedError) return { cut, climbed: pillar.length } }
      }
      const rest = left()
      if (!rest.length) break
      const feet = bot.entity.position.floored()
      const top = Math.max(...rest.map(p => p.y))
      if (top <= feet.y + 1) break // what is left is beside us but out of reach: climbing won't help
      if (!isAir(bot.blockAt(feet.offset(0, 2, 0))?.name)) {
        // a log of this tree right above the head is in reach and was cut; anything else (leaves) ends the climb
        break
      }
      const filler = fillerBlock(bot)
      if (!filler || !await jumpPlace(bot, signal, filler)) break
      pillar.push(feet)
    }
  } finally {
    // down again: dig the pillar under our feet, top first (one-block drops, the blocks come back)
    for (const p of pillar.reverse()) {
      const b = bot.blockAt(p)
      if (!b || isAir(b.name)) continue
      try {
        await bot.dig(b, true)
      } catch (e) {
        log.debug('pillar block left', { at: fmtPos(p), error: (e as Error).message })
        break
      }
      const until = Date.now() + 1500
      while (!bot.entity.onGround && Date.now() < until) await sleep(50, signal).catch(() => {})
    }
  }
  log.debug('climbed trunk', { cut, climbed: pillar.length, column: column.length })
  return { cut, climbed: pillar.length }
}

/**
 * Picks up what a felled tree dropped: waits a moment for drops to land, sweeps around the
 * trunk, then frees drops caught in leaves (breaking the natural leaf under them when in
 * reach) and sweeps once more. Returns the number of items picked up.
 */
async function collectTreeDrops (bot: Bot, signal: AbortSignal): Promise<number> {
  await sleep(500, signal) // let falling drops land
  let picked = await pickupNearby(bot, signal, { radius: 10, maxMs: 15_000 })
  const caught = Object.values(bot.entities).filter(e => e.name === 'item' && e.position.distanceTo(bot.entity.position) <= 10)
  let freed = 0
  for (const e of caught) {
    const below = bot.blockAt(e.position.offset(0, -0.3, 0))
    if (!below || !isNaturalLeaves(below.name, below.getProperties() as Record<string, unknown>) || !within(bot, below.position)) continue
    try { await digBlock(bot, below, signal, 50); freed++ } catch (err) { checkAborted(signal) }
  }
  if (freed || caught.length) {
    await sleep(freed ? 400 : 0, signal)
    picked += await pickupNearby(bot, signal, { radius: 12, maxMs: 8000 })
  }
  return picked
}

// ------------------------------------------------------------------ remembered trees and the wood ladder

const SPOTS_KEY = 'woodcutting.treeSpots'
const SEARCHES_KEY = 'woodcutting.searches'

function store (agent: Agent): Agent['storage'] | null {
  return (agent as { storage?: Agent['storage'] }).storage ?? null
}

/** Places with trees this bot has seen (newest first). */
export function getTreeSpots (agent: Agent): TreeSpot[] {
  return store(agent)?.get<TreeSpot[]>(SPOTS_KEY, []) ?? []
}

function setTreeSpots (agent: Agent, spots: TreeSpot[]): void {
  store(agent)?.set(SPOTS_KEY, spots)
}

function treeSearches (agent: Agent): SearchRecord[] {
  return store(agent)?.get<SearchRecord[]>(SEARCHES_KEY, []) ?? []
}

/** Remembers the natural trees loaded around the bot (a few, clustered into one spot each). */
function rememberTreesNear (bot: Bot, agent: Agent, skip: (p: Vec3) => boolean, radius = 48): number {
  try {
    const trees = scanTrees(bot, radius, skip, 8)
    if (!trees.length) return 0
    const dim = bot.game?.dimension
    let spots = getTreeSpots(agent)
    const now = Date.now()
    for (const t of trees) {
      const near = trees.filter(o => Math.hypot(o.base.x - t.base.x, o.base.z - t.base.z) <= 24).length
      spots = mergeTreeSpot(spots, { x: t.base.x, y: t.base.y, z: t.base.z, ...(dim ? { dim } : {}), wood: t.wood, count: near, seen: now })
    }
    setTreeSpots(agent, spots)
    return trees.length
  } catch { return 0 }
}

const isNightTime = (bot: Bot) => { const t = bot.time?.timeOfDay ?? 6000; return t >= 13_000 && t < 23_000 }
const NO_TREE = /no (natural )?tree|no tree I'm allowed/

export interface WideFellOptions {
  /** Search rings, smallest first. Default 32, 64, 128, 250. */
  rings?: readonly number[]
  replant: boolean
  makeAxe?: boolean
  /** Walk back to where it started after felling a tree far away. Default true. */
  returnBack?: boolean
  /** Give up the search after this long (felling included). Default 10 minutes. */
  maxMinutes?: number
  /** Scout at night too. Default false. */
  atNight?: boolean
}

/**
 * The wood ladder: fells one tree, looking further out when there is none close. Remembered
 * tree spots first (nearest), then rings: a scan of what is loaded for the inner ones, a scouting
 * spiral out to the ring for the outer ones, skipping danger zones and protected areas. Empty
 * rings are remembered (TREE_RING_MEMORY_MS) so the next run starts further out; trees seen on
 * the way are remembered as spots to come back to. Walks back after a far tree.
 */
export async function fellTreeWide (ctx: Pick<ActionContext, 'bot' | 'agent' | 'signal' | 'log'>, o: WideFellOptions): Promise<ActionResult> {
  const { bot, agent, signal, log } = ctx
  if (!agent.canDig) return fail('digging is disabled for this bot')
  const rings = o.rings?.length ? [...o.rings].sort((a, b) => a - b) : [...DEFAULT_TREE_RINGS]
  const t0 = Date.now()
  const maxMs = (o.maxMinutes ?? 10) * 60_000
  const origin = bot.entity.position.floored()
  const dim = bot.game?.dimension
  const danger = dangerMemory(agent)
  const blocked = (p: XZ & { y?: number }) => {
    const v = { x: p.x, y: p.y ?? origin.y, z: p.z }
    return agent.protectedAreas.isProtected(v as any) || !!danger.isInDanger(v) || !!danger.crosses(origin, v)
  }
  const tried = new Set<string>()
  const notes: string[] = []
  const fell = (radius: number) => fellTree(ctx, { radius, replant: o.replant, makeAxe: o.makeAxe })
  const back = async (r: ActionResult, how: string): Promise<ActionResult> => {
    const far = Math.round(Math.hypot(bot.entity.position.x - origin.x, bot.entity.position.z - origin.z))
    let tail = ''
    if (far > 48 && o.returnBack !== false) {
      try { await travel(bot, origin, signal, { range: 4, stepTimeoutMs: 45_000 }); tail = ', walked back' } catch (e) { checkAborted(signal); tail = `, couldn't walk back (${(e as Error).message})` }
    }
    return ok(`${r.message} (${how}${tail})`, r.data)
  }
  for (let round = 0; round < rings.length + 6; round++) {
    checkAborted(signal)
    if (Date.now() - t0 > maxMs) { notes.push(`gave up after ${Math.round(maxMs / 60_000)} minutes`); break }
    const step = nextTreeStep({ from: origin, dim, now: Date.now(), spots: getTreeSpots(agent), searches: treeSearches(agent) }, { rings, skip: blocked, tried })
    if (!step) break
    log.debug('tree search step', { step: step.step, reason: step.reason })
    if (step.step === 'spot') {
      tried.add(spotKey(step.spot))
      const at = step.spot
      try {
        if (Math.hypot(at.x - bot.entity.position.x, at.z - bot.entity.position.z) > 16) await travel(bot, { x: at.x, z: at.z }, signal, { range: 8, stepTimeoutMs: 45_000 })
      } catch (e) {
        checkAborted(signal)
        notes.push(`couldn't get to the trees at ${at.x} ${at.z} (${(e as Error).message})`)
        setTreeSpots(agent, markTreeSpotEmpty(getTreeSpots(agent), at, Date.now(), 24, dim))
        continue
      }
      const r = await fell(32)
      if (r.ok) return back(r, `at trees I remembered, ${Math.round(Math.hypot(at.x - origin.x, at.z - origin.z))} blocks ${compass(origin, at)}`)
      setTreeSpots(agent, markTreeSpotEmpty(getTreeSpots(agent), at, Date.now(), 24, dim))
      notes.push(`no tree left at ${at.x} ${at.z}`)
      continue
    }
    tried.add(`ring:${step.radius}`)
    if (step.step === 'scan') {
      const r = await fell(step.radius)
      if (r.ok) {
        store(agent)?.set(SEARCHES_KEY, recordTreeSearch(treeSearches(agent), step.radius, true, Date.now()))
        return back(r, `within ${step.radius} blocks`)
      }
      if (NO_TREE.test(r.message)) store(agent)?.set(SEARCHES_KEY, recordTreeSearch(treeSearches(agent), step.radius, false, Date.now()))
      else notes.push(r.message)
      continue
    }
    // scout: a spiral of waypoints out to the ring, looking around at every one
    if (isNightTime(bot) && !o.atNight) { notes.push(`it is night, so I did not scout ${step.radius} blocks out`); break }
    const wps = scoutWaypoints(origin, step.radius, { step: 64, minRadius: step.covered, skip: blocked, startAngle: Math.random() * Math.PI * 2 })
    let found = false
    let failures = 0
    let legs = 0
    for (const w of wps) {
      checkAborted(signal)
      if (Date.now() - t0 > maxMs || failures >= 3 || (isNightTime(bot) && !o.atNight) || (bot.health ?? 20) <= 6) break
      if (danger.crosses(bot.entity.position, { x: w.x, y: origin.y, z: w.z })) continue
      const ctl = new AbortController()
      try {
        await travel(bot, { x: w.x, z: w.z }, AbortSignal.any([signal, ctl.signal]), {
          range: 8,
          stepTimeoutMs: 45_000,
          onProgress: () => { if (findTree(bot, 32, p => blocked(p))) ctl.abort() }
        })
        failures = 0
      } catch (e) {
        checkAborted(signal)
        if (!ctl.signal.aborted) { failures++; log.debug('tree scout: leg failed', { to: `${w.x} ${w.z}`, error: (e as Error).message }) }
      }
      legs++
      if (rememberTreesNear(bot, agent, p => blocked(p))) {
        const here = bot.entity.position
        try { agent.journal?.record('found', { target: 'tree', what: 'trees', count: 1, how: `scouted ${step.radius} blocks` }, { pos: { x: Math.floor(here.x), y: Math.floor(here.y), z: Math.floor(here.z) }, ...(dim ? { dim } : {}) }) } catch {}
        const r = await fell(48)
        if (r.ok) {
          found = true
          store(agent)?.set(SEARCHES_KEY, recordTreeSearch(treeSearches(agent), step.radius, true, Date.now()))
          const d = Math.round(Math.hypot(here.x - origin.x, here.z - origin.z))
          return back(r, `scouted ${d} blocks ${compass(origin, here)}, remembered the spot`)
        }
        notes.push(r.message)
      }
    }
    if (!found) {
      // only a ring walked all the way round counts as empty
      if (legs >= wps.length && failures < 3) store(agent)?.set(SEARCHES_KEY, recordTreeSearch(treeSearches(agent), step.radius, false, Date.now()))
      else { notes.push(`scouting ${step.radius} blocks out stopped after ${legs} of ${wps.length} legs`); break }
    }
  }
  if (Math.hypot(bot.entity.position.x - origin.x, bot.entity.position.z - origin.z) > 48 && o.returnBack !== false) {
    try { await travel(bot, origin, signal, { range: 4, stepTimeoutMs: 45_000 }) } catch (e) { checkAborted(signal) }
  }
  const retry = treeRetryInMs(treeSearches(agent), Date.now())
  const widest = rings[rings.length - 1]!
  return fail(`no natural tree I may cut within ${widest} blocks${notes.length ? ` (${notes.join('; ')})` : ''}${retry ? `; looking again in ${Math.ceil(retry / 60_000)} min` : ''}`, { need: 'trees', retryInMs: retry })
}

const chopTree = defineAction({
  name: 'chop_tree',
  description: 'Fell the nearest natural tree (any wood type): cut the logs it can reach, pick up the drops and plant a sapling. ' +
    'With rings it widens the search (remembered tree spots, then ring by ring, with a trip out and back) instead of giving up. ' +
    'Crafts a wooden axe first if there is none and the inventory has the wood. Needs digging enabled. ' +
    'For "get N planks/logs" or materials for a build, prefer gather_materials, which chops as many trees as needed.',
  params: z.object({
    radius: z.number().min(4).max(64).default(32).describe('how far to look for a tree, in blocks'),
    replant: z.boolean().default(true).describe('plant a sapling of the same kind afterwards if the bot has one'),
    make_axe: z.boolean().default(true).describe('craft a wooden axe first when there is none and there is wood for it'),
    rings: z.array(z.number().int().min(8).max(512)).max(8).optional()
      .describe('look further out when there is no tree close: remembered tree spots first, then these rings (e.g. [32, 64, 128, 250]); rings past 64 are a scouting trip out and back, by day')
  }),
  aliases: ['chop'],
  run: (ctx, { radius, replant, make_axe, rings }) => rings?.length
    ? fellTreeWide(ctx, { rings, replant, makeAxe: make_axe })
    : fellTree(ctx, { radius, replant, makeAxe: make_axe })
})

export const woodcutting = () => defineSkill({
  name: 'woodcutting',
  capabilities: ['move', 'dig'],
  description: 'Felling trees.',
  actions: [chopTree]
})
