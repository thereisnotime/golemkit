// The staircase mine (dig_mine): from a dry, unprotected spot near home, a 1-wide, 2-high
// staircase at 45 degrees down to mine.depthY, a main tunnel with side branches there, every
// ore in the walls that it wants and can mine, torches on the way, and back up the same stairs.
// The mine is remembered (storage `mines`, site kind `mine`), so the next trip walks down and
// carries on at the face. The decisions are pure (stairMinePlan.ts); the digging safety
// (no straight down, no lava or water next to a dug block, no caves, solid floor) is planStep
// from mining.ts, the retreat and torches are safe mining's (minePlan.ts).
import type { Bot } from 'mineflayer'
import type { ActionContext, ActionResult, Agent } from '../core/index.ts'
import { defineAction, z, ok, fail, goals, checkAborted, fmtPos, siteBook, needsSurvival } from '../core/index.ts'
import { digBlock, DigRefusedError, gotoWithin, vec } from './world.ts'
import { ensureTool, equipFor, inventoryCounts, toolTier, bestToolIn, ensureSticks, usablePlankUnits } from './toolkit.ts'
import { isNaturalBlock } from './blueprint.ts'
import { pickupNearby } from './pickup.ts'
import { craftItem, spawnProtectionOf } from './crafting.ts'
import { inSpawnProtection } from './stationPlan.ts'
import { planStep, digHazard, kitOf, lookFor, placeTorch, undergroundNow, DIRS } from './mining.ts'
import { miningSettings, undergroundRetreat, torchDue, caveHazard } from './minePlan.ts'
import { getHome, sameDimension } from './navigation.ts'
import { getFarms } from './food.ts'
import { bestFood } from './survival.ts'
import {
  stairMineSettings, stairMineReadiness, pickEntrance, mineTargetY, mineTripStep, branchEvery, sides, mineJunk,
  visibleOre, tunnelAir, nextMineName, pickMine, mineLit, mineSiteVerdict, ORE_FAMILIES, ENTRANCE_STEPS,
  type StairMineSettings, type EntranceCandidate, type MineSite, type MinePhase, type Dir, type P, type BlockLook
} from './stairMinePlan.ts'

const MINES_KEY = 'mines'
const LAST_TRIP_KEY = 'mines.lastTrip'
const key = (p: P) => `${p.x},${p.y},${p.z}`
const add = (p: P, dx: number, dy: number, dz: number): P => ({ x: p.x + dx, y: p.y + dy, z: p.z + dz })
const floorP = (v: { x: number, y: number, z: number }): P => ({ x: Math.floor(v.x), y: Math.floor(v.y), z: Math.floor(v.z) })
const AIR = /^(air|cave_air|void_air)$/
const WET = /water|lava|ice|bubble_column|kelp|seagrass/

export function stairMineConfig (agent: Agent): StairMineSettings {
  return stairMineSettings((agent.settings as { mine?: unknown }).mine)
}

export function getMines (agent: Agent): MineSite[] { return agent.storage.get<MineSite[]>(MINES_KEY, []) }
export function saveMine (agent: Agent, m: MineSite): void {
  agent.storage.set(MINES_KEY, [...getMines(agent).filter(x => x.id !== m.id), m])
}
/** When the last trip down ended (ms), for mine.cooldownMinutes. */
export function lastMineTrip (agent: Agent): number | undefined { return agent.storage.get<number>(LAST_TRIP_KEY) }

/** The mine it would use now (remembered, not bad, near home), or null. */
export function knownMine (agent: Agent, bot: Bot): MineSite | null {
  const s = stairMineConfig(agent)
  const home = getHome(agent)
  const book = siteBook(agent)
  return pickMine(getMines(agent), home && sameDimension(bot, home) ? home : null, s.radius, bot.game?.dimension, id => book.isBad('mine', id))
}

/** A known mine that is lit (night trips go only down a lit mine). */
export function knownLitMine (agent: Agent, bot: Bot): MineSite | null {
  const m = knownMine(agent, bot)
  return m && mineLit(m, miningSettings(agent.settings.mining).torchEvery) ? m : null
}

/** The first stair steps of a mine as the site check sees them; null when not loaded. */
export function mineEntranceLook (bot: Bot, m: MineSite): { steps: ('air' | 'water' | 'lava' | 'solid')[] } | null {
  const steps: ('air' | 'water' | 'lava' | 'solid')[] = []
  let p = m.entrance
  for (let i = 1; i <= 3; i++) {
    p = add(p, m.dir.x, -1, m.dir.z)
    for (const q of [p, add(p, 0, 1, 0)]) {
      const b = bot.blockAt(vec(bot, q.x, q.y, q.z))
      if (!b) return null
      steps.push(/lava/.test(b.name) ? 'lava' : /water|bubble/.test(b.name) ? 'water' : AIR.test(b.name) || b.boundingBox !== 'block' ? 'air' : 'solid')
    }
  }
  return { steps }
}
export { mineSiteVerdict }

// ------------------------------------------------------------------ finding a spot

function surfaceAt (bot: Bot, x: number, z: number, yHint: number): P | null {
  for (let y = yHint + 12; y >= yHint - 16; y--) {
    const b = bot.blockAt(vec(bot, x, y, z))
    if (!b) return null
    if (b.boundingBox === 'block' && !/leaves|_log$|glass|^snow$/.test(b.name)) {
      const a = bot.blockAt(vec(bot, x, y + 1, z))
      const h = bot.blockAt(vec(bot, x, y + 2, z))
      if (!a || !h || (a.boundingBox === 'block' && a.name !== 'snow') || h.boundingBox === 'block') return null
      return { x, y: y + 1, z }
    }
  }
  return null
}

/** Looks at spots around home for an entrance, ENTRANCE_STEPS safe steps down each. */
export function entranceCandidates (agent: Agent, bot: Bot, center: P, s: StairMineSettings): EntranceCandidate[] {
  const at = lookFor(bot)
  const spawn = (bot as { spawnPoint?: { x: number, z: number } }).spawnPoint ?? null
  const spawnR = spawnProtectionOf(agent)
  const farms = getFarms(agent)
  const out: EntranceCandidate[] = []
  const seen = new Set<string>()
  for (let r = Math.max(2, s.minFromHome); r <= s.radius; r += 4) {
    const n = Math.max(8, Math.round(r * 0.8))
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2
      const x = Math.round(center.x + Math.cos(a) * r)
      const z = Math.round(center.z + Math.sin(a) * r)
      if (seen.has(`${x},${z}`)) continue
      seen.add(`${x},${z}`)
      const pos = surfaceAt(bot, x, z, center.y)
      if (!pos) continue
      const homeDist = Math.hypot(pos.x - center.x, pos.z - center.z)
      let wet = false
      for (let dx = -3; dx <= 3 && !wet; dx++) for (let dz = -3; dz <= 3 && !wet; dz++) for (let dy = -3; dy <= 1 && !wet; dy++) {
        wet = WET.test(at({ x: pos.x + dx, y: pos.y + dy, z: pos.z + dz })?.name ?? '')
      }
      let roofed = false
      for (let dy = 2; dy <= 12 && !roofed; dy++) { const b = at(add(pos, 0, dy, 0)); roofed = !!b && b.solid && !/leaves|_log$/.test(b.name) }
      const prot = agent.protectedAreas.isProtected(pos) || inSpawnProtection(pos, spawn, spawnR)
      const farm = farms.some(f => Math.max(Math.abs(f.x - pos.x), Math.abs(f.z - pos.z)) <= ((f.size ?? 9) - 1) / 2 + 3)
      for (const dir of DIRS) {
        out.push({ pos, dir, homeDist, protectedArea: prot, wet, roofed, farm, safeSteps: wet || prot || roofed || farm ? 0 : safeStepsFrom(agent, at, pos, dir) })
      }
    }
  }
  return out
}

function allowedFor (agent: Agent) {
  return (p: P, name: string) => !agent.protectedAreas.isProtected(p) && (isNaturalBlock(name) || AIR.test(name))
}

/** How many steps down from `pos` going `dir` plan safely, in a world where the earlier steps are dug. */
function safeStepsFrom (agent: Agent, at: BlockLook, pos: P, dir: Dir): number {
  const dug = new Set<string>()
  const view: BlockLook = (p) => dug.has(key(p)) ? { name: 'air', solid: false } : at(p)
  const tunnel = new Set<string>()
  let feet = pos
  for (let i = 0; i < ENTRANCE_STEPS; i++) {
    const plan = planStep(view, feet, dir, true, allowedFor(agent), false, { belowY: pos.y - 1, tunnel })
    if (typeof plan === 'string') return i
    for (const p of plan.dig) { dug.add(key(p)); tunnel.add(key(p)) }
    feet = plan.stand
  }
  return ENTRANCE_STEPS
}

// ------------------------------------------------------------------ the trip

export interface DigMineOptions {
  /** Ore family it came for (stops once `want` of its drop are in). Default iron. */
  ore?: string
  /** Drops wanted on this trip (0 = until another limit). */
  want?: number
  maxMinutes?: number
  /** Start a new mine even when one is known. */
  fresh?: boolean
}

type Ctx = Pick<ActionContext, 'bot' | 'agent' | 'signal' | 'log'>

export async function digMine (ctx: Ctx, o: DigMineOptions = {}): Promise<ActionResult> {
  const { bot, agent, signal, log } = ctx
  if (!agent.canDig) return fail('digging is disabled for this bot')
  if (!needsSurvival(bot)) return fail('a mine is for survival mode')
  const s = stairMineConfig(agent)
  if (o.maxMinutes) s.minutes = o.maxMinutes
  const ms = miningSettings(agent.settings.mining)
  const t0 = Date.now()
  const ore = o.ore && ORE_FAMILIES[o.ore] ? o.ore : 'iron'
  const drop = ORE_FAMILIES[ore]!.drop
  const want = Math.max(0, o.want ?? 0)
  if (bot.game?.dimension && !/overworld/.test(bot.game.dimension)) return fail('the staircase mine is for the overworld')
  const kit = kitOf(bot)
  const ready = stairMineReadiness(kit, bot.health, s, ms)
  if (!ready.ready) return fail(`not ready to go down a mine: ${ready.missing.join(', ')}`, { notReady: true, ...(ready.need ? { need: ready.need } : {}) })
  const pickTier = () => toolTier(bestToolIn(Object.keys(inventoryCounts(bot)), 'pickaxe') ?? '', 'pickaxe')
  if (pickTier() < 2) return fail('a mine needs a stone pickaxe or better')

  const home = getHome(agent)
  const center: P = home && sameDimension(bot, home) ? floorP(home) : floorP(bot.entity.position)
  const at = lookFor(bot)
  const allowed = allowedFor(agent)
  const notes: string[] = []

  // the mine: a known one, else a new entrance near home
  let site = o.fresh ? null : knownMine(agent, bot)
  if (!site) {
    if (home && sameDimension(bot, home) && Math.hypot(bot.entity.position.x - home.x, bot.entity.position.z - home.z) > s.radius + 16) {
      await gotoWithin(bot, new goals.GoalNear(home.x, home.y, home.z, 4), signal, 90_000).catch(e => { checkAborted(signal); log.debug('mine: no way home', { error: (e as Error).message }) })
    }
    const pick = pickEntrance(entranceCandidates(agent, bot, center, s), s)
    if ('none' in pick) return fail(pick.none)
    const id = nextMineName(getMines(agent).map(m => m.id))
    site = { id, entrance: pick.pick.pos, dir: pick.pick.dir, ...(bot.game?.dimension ? { dim: bot.game.dimension } : {}), path: [], deepest: pick.pick.pos.y, mainSteps: 0, branches: 0, torches: 0, stairSteps: 0, trips: 0, lastAt: Date.now(), got: {} }
    saveMine(agent, site)
    notes.push(`new mine ${id} at ${fmtPos(site.entrance)}`)
    try { agent.journal?.record('found', { target: 'mine', what: `a spot for ${id}`, count: 1, how: 'dug a staircase mine' }, { pos: site.entrance }) } catch {}
  }
  const mine: MineSite = site
  const startCounts = inventoryCounts(bot)
  const got = () => (inventoryCounts(bot)[drop] ?? 0) - (startCounts[drop] ?? 0)

  // a spare stone pickaxe and sticks before going down: a stone pickaxe lasts about 130 blocks
  const picks = () => bot.inventory.items().filter(i => /_pickaxe$/.test(i.name) && toolTier(i.name, 'pickaxe') >= 2).length
  if (picks() < 2 && (inventoryCounts(bot).cobblestone ?? 0) >= 3 && usablePlankUnits(inventoryCounts(bot)) >= 2) {
    await ensureSticks(bot, signal, 2).catch(() => false)
    const r = await craftItem(bot, signal, 'stone_pickaxe', 1).catch(e => { checkAborted(signal); return fail((e as Error).message) })
    if (r.ok) notes.push('made a spare stone pickaxe')
  }
  if (!bot.inventory.items().some(i => i.name === 'stick')) await ensureSticks(bot, signal, 4).catch(() => false)

  // walk to the entrance, then down to where it left off
  const goTo = async (p: P, range: number, ms = 45_000) => {
    await gotoWithin(bot, range ? new goals.GoalNear(p.x, p.y, p.z, range) : new goals.GoalBlock(p.x, p.y, p.z), signal, ms)
  }
  try {
    await goTo(mine.entrance, 1, 90_000)
  } catch (e) {
    checkAborted(signal)
    siteBook(agent).report({ kind: 'mine', id: mine.id, pos: mine.entrance, label: `my mine ${mine.id}` }, { ok: false, fault: 'unreachable', reason: `couldn't get to the entrance: ${(e as Error).message}` })
    return fail(`couldn't get to ${mine.id} at ${fmtPos(mine.entrance)}: ${(e as Error).message}`)
  }
  let phase: MinePhase = 'down'
  let dir: Dir = mine.dir
  let mainDir: Dir = mine.faceDir ?? mine.dir
  const resumeAt = mine.face ?? mine.bottom ?? mine.path.at(-1)
  if (resumeAt) {
    // the stairs are there: walk down them (waypoints when the long path fails)
    let there = false
    try { await goTo(resumeAt, 1, 90_000); there = true } catch (e) { checkAborted(signal) }
    if (!there) {
      for (const w of [...mine.path, ...(mine.bottom ? [mine.bottom] : []), ...(mine.face ? [mine.face] : [])]) {
        try { await goTo(w, 1, 20_000) } catch (e) { checkAborted(signal); break }
      }
      there = Math.hypot(bot.entity.position.x - resumeAt.x, bot.entity.position.y - resumeAt.y, bot.entity.position.z - resumeAt.z) <= 3
    }
    if (!there) {
      siteBook(agent).report({ kind: 'mine', id: mine.id, pos: mine.entrance, label: `my mine ${mine.id}` }, { ok: false, fault: 'unreachable', reason: `couldn't walk down to ${fmtPos(resumeAt)}` })
      return fail(`couldn't walk down ${mine.id} to ${fmtPos(resumeAt)}`)
    }
    if (mine.bottom) { phase = 'main'; dir = mainDir }
  }

  let feet = floorP(bot.entity.position)
  const targetY = mineTargetY(mine.entrance.y, s, typeof (bot.game as unknown as { minY?: number })?.minY === 'number' ? (bot.game as unknown as { minY: number }).minY : -64)
  const tunnel = tunnelAir(at, feet, 6, 400)
  const caves = ms.safe ? { belowY: mine.entrance.y - 1, tunnel } : undefined
  const trail: P[] = [feet] // stands on this trip, for the walk back when the path fails
  let broken = 0
  let sinceTorch = 0
  let noTorches = false
  let branchesThisTrip = 0
  let mainSinceBranch = 0
  let stopped = ''
  let retreat = ''
  const oresMined: Record<string, number> = {}
  const before = inventoryCounts(bot)

  const breakAt = async (p: P): Promise<boolean> => {
    const b = bot.blockAt(vec(bot, p.x, p.y, p.z))
    if (!b || AIR.test(b.name) || (b.boundingBox === 'empty' && !/snow/.test(b.name))) return true
    if (!bot.canDigBlock(b)) return false
    await equipFor(bot, b)
    await digBlock(bot, b, signal, 80)
    broken++
    return true
  }
  const keepPickaxe = async () => {
    if (pickTier() >= 2) return
    const r = await ensureTool(bot, signal, 'pickaxe', { minTier: 'stone' }).catch(e => { checkAborted(signal); return fail((e as Error).message) })
    if (r.ok) notes.push(`pickaxe broke, ${r.message}`)
  }
  const eatIfHungry = async () => {
    if (bot.food >= 16 && !(bot.health < 14 && bot.food < 20)) return
    const f = bestFood(bot)
    if (!f) return
    try { await bot.equip(f, 'hand'); await bot.consume() } catch { checkAborted(signal) }
  }
  const room = async (dropHere: boolean) => {
    const free = bot.inventory.emptySlotCount()
    if (free >= s.minFreeSlots + 1 && !dropHere) return
    const stacks = bot.inventory.items().map(i => ({ name: i.name, count: i.count, item: i }))
    const toss = mineJunk(stacks, dropHere ? 36 : s.minFreeSlots + 1 - free, s.keepCobble)
    for (const t of toss) {
      const it = stacks.find(x => x.name === t.name && x.count === t.count && bot.inventory.slots[x.item.slot] === x.item)
      if (it) await bot.tossStack(it.item).catch(() => {})
    }
  }
  // ore in the walls of the tunnel around the bot, then its vein
  const mineOre = async () => {
    const spots = [feet, add(feet, 0, 1, 0)]
    const list = visibleOre(at, spots, pickTier(), s.ores)
      .filter(p => !agent.protectedAreas.isProtected(p))
      .sort((a, b) => Math.hypot(a.x - feet.x, a.y - feet.y, a.z - feet.z) - Math.hypot(b.x - feet.x, b.y - feet.y, b.z - feet.z))
    let n = 0
    for (const p of list) {
      checkAborted(signal)
      const eye = bot.entity.position.offset(0, 1.62, 0)
      if (eye.distanceTo(vec(bot, p.x + 0.5, p.y + 0.5, p.z + 0.5)) > 4.4) continue
      if (digHazard(at, p, tunnel)) continue
      if (caves && caveHazard(at, [p], feet, tunnel, caves.belowY)) continue
      const name = at(p)?.name ?? ''
      try {
        if (await breakAt(p)) { tunnel.add(key(p)); oresMined[name] = (oresMined[name] ?? 0) + 1; n++ }
      } catch (e) { checkAborted(signal); if (e instanceof DigRefusedError) agent.markProtected(vec(bot, p.x, p.y, p.z)) }
    }
    if (n) await pickupNearby(bot, signal, { radius: 5, maxMs: 4000 }).catch(() => 0)
  }
  /** One step: down (stairs) or flat. Returns null when it moved, else why not. */
  const step = async (d: Dir, down: boolean): Promise<string | null> => {
    const plan = planStep(at, feet, d, down, allowed, false, caves)
    if (typeof plan === 'string') return plan
    for (const p of plan.dig) {
      try {
        if (!await breakAt(p)) return `can't break ${at(p)?.name} at ${fmtPos(p)}`
      } catch (e) {
        checkAborted(signal)
        if (e instanceof DigRefusedError) { agent.markProtected(vec(bot, p.x, p.y, p.z)); return 'protected area' }
        throw e
      }
      tunnel.add(key(p))
    }
    try {
      await gotoWithin(bot, new goals.GoalBlock(plan.stand.x, plan.stand.y, plan.stand.z), signal, 6000)
    } catch (e) {
      checkAborted(signal)
      return `couldn't step to ${fmtPos(plan.stand)}`
    }
    const prev = feet
    feet = floorP(bot.entity.position)
    tunnel.add(key(feet)); tunnel.add(key(add(feet, 0, 1, 0)))
    trail.push(feet)
    sinceTorch++
    if (ms.torches && !noTorches && torchDue(sinceTorch, ms, (bot.blockAt(vec(bot, feet.x, feet.y, feet.z)) as { light?: number } | null)?.light)) {
      if (await placeTorch(bot, signal, prev)) { sinceTorch = 0; mine.torches++ } else noTorches = !bot.inventory.items().some(i => i.name === 'torch')
    }
    await mineOre()
    return null
  }
  const turnFrom = (d: Dir) => DIRS[(DIRS.findIndex(x => x.x === d.x && x.z === d.z) + 1) % 4]!

  try {
    await mineOre()
    for (;;) {
      checkAborted(signal)
      await eatIfHungry()
      await keepPickaxe()
      await room(false)
      const u = undergroundNow(bot, ms.hostileRadius)
      const retreatWhy = undergroundRetreat({ ...u, underground: u.underground || feet.y < mine.entrance.y - 3, health: bot.health }, ms)
      const kitNow = kitOf(bot)
      const next = mineTripStep({ phase, y: feet.y, targetY, elapsedMs: Date.now() - t0, freeSlots: bot.inventory.emptySlotCount(), food: kitNow.food, pickaxe: pickTier() >= 2, want, got: got(), branches: branchesThisTrip, retreat: retreatWhy }, s)
      if ('back' in next) { stopped = next.back; if (retreatWhy) retreat = retreatWhy; break }
      if (next.go === 'down') {
        let why = await step(dir, true)
        let turns = 0
        while (why && turns < 3) {
          log.debug('mine: step down unsafe, turning', { at: fmtPos(feet), reason: why })
          // a flat step first (a ledge of gravel or a cave below), then other directions
          if (turns === 0 && !(await step(dir, false))) { why = null; break }
          dir = turnFrom(dir); turns++
          why = await step(dir, true)
        }
        if (why) {
          if (feet.y <= targetY + 12) { phase = 'main'; notes.push(`stairs stopped at y ${feet.y}: ${why}`); continue }
          stopped = `every way down is unsafe (${why})`
          break
        }
        mine.stairSteps++
        if (mine.stairSteps % 4 === 0) mine.path.push(feet)
        mine.deepest = Math.min(mine.deepest, feet.y)
        continue
      }
      phase = next.go
      if (phase === 'main' && !mine.bottom) { mine.bottom = feet; mainDir = dir; mine.faceDir = dir }
      if (phase === 'main') {
        if (mainSinceBranch >= branchEvery(s)) {
          // a branch on each side, back to the main tunnel after each
          const junction = feet
          for (const side of sides(mainDir)) {
            let len = 0
            for (; len < s.branchLength; len++) {
              checkAborted(signal)
              const st = mineTripStep({ phase: 'branch', y: feet.y, targetY, elapsedMs: Date.now() - t0, freeSlots: bot.inventory.emptySlotCount(), food: kitOf(bot).food, pickaxe: pickTier() >= 2, want, got: got(), branches: branchesThisTrip, retreat: (() => { const v = undergroundNow(bot, ms.hostileRadius); return undergroundRetreat({ ...v, underground: true, health: bot.health }, ms) })() }, s)
              if ('back' in st) break
              await eatIfHungry()
              await keepPickaxe()
              if (await step(side, false)) break
            }
            // the dead end is where the junk goes: it isn't on the way back
            if (len > 2 && bot.inventory.emptySlotCount() < s.minFreeSlots + 3) await room(true)
            await gotoWithin(bot, new goals.GoalBlock(junction.x, junction.y, junction.z), signal, 20_000).catch(e => { checkAborted(signal) })
            feet = floorP(bot.entity.position)
          }
          branchesThisTrip++
          mine.branches++
          mainSinceBranch = 0
          continue
        }
        const why = await step(mainDir, false)
        if (why) {
          // the main tunnel turns once; twice blocked ends the trip
          const alt = sides(mainDir).find(d => typeof planStep(at, feet, d, false, allowed, false, caves) !== 'string')
          if (!alt) { stopped = `the tunnel is blocked (${why})`; break }
          mainDir = alt
          mine.faceDir = alt
          continue
        }
        mine.mainSteps++
        mainSinceBranch++
        mine.face = feet
      }
    }
  } catch (e) {
    checkAborted(signal)
    stopped = (e as Error).message
  }

  // back up the stairs: the whole way in one path, else the way it came, step by step
  if (!retreat) await pickupNearby(bot, signal, { radius: 6, maxMs: 6000 }).catch(() => 0)
  let up = false
  try { await goTo(mine.entrance, 1, 120_000); up = true } catch (e) { checkAborted(signal) }
  if (!up) {
    const back = [...trail].reverse().filter((_, i) => i % 3 === 0)
    for (const w of [...back, ...[...mine.path].reverse(), mine.entrance]) {
      try { await goTo(w, 1, 15_000) } catch (e) { checkAborted(signal) }
    }
    up = Math.hypot(bot.entity.position.x - mine.entrance.x, bot.entity.position.y - mine.entrance.y, bot.entity.position.z - mine.entrance.z) <= 3
  }
  mine.trips++
  mine.lastAt = Date.now()
  const after = inventoryCounts(bot)
  for (const f of Object.values(ORE_FAMILIES)) {
    const d = (after[f.drop] ?? 0) - (before[f.drop] ?? 0)
    if (d > 0) mine.got[f.drop] = (mine.got[f.drop] ?? 0) + d
  }
  saveMine(agent, mine)
  agent.storage.set(LAST_TRIP_KEY, Date.now())
  const gotText = Object.values(ORE_FAMILIES).map(f => [f.drop, (after[f.drop] ?? 0) - (before[f.drop] ?? 0)] as const).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(', ')
  const secs = Math.round((Date.now() - t0) / 1000)
  const where = `${mine.id} (${fmtPos(mine.entrance)}, down to y ${mine.deepest}${mine.branches ? `, ${mine.branches} branches` : ''}${mineLit(mine, ms.torchEvery) ? ', lit' : ''})`
  const msg = `${notes.length ? `${notes.join('; ')}; ` : ''}${where}: ${gotText ? `got ${gotText}` : 'no ore this time'}, ${broken} blocks in ${secs}s; back ${up ? 'up' : `NOT up (at ${fmtPos(bot.entity.position)})`} because ${stopped || 'done'}`
  log.info('mine trip', { mine: mine.id, got: gotText || 'nothing', broken, secs, stopped, up })
  const data = { mine: mine.id, got: got(), ores: oresMined, broken, stopped, up, ...(retreat ? { retreat } : {}) }
  return got() > 0 || (want === 0 && gotText) ? ok(msg, data) : fail(msg, data)
}

export const digMineAction = defineAction({
  name: 'dig_mine',
  capabilities: ['move', 'dig'],
  description: 'Go mining in its own staircase mine near home: a 1-wide, 2-high staircase at 45 degrees from a dry, unprotected spot near home (never straight down, never next to lava or water, never into a cave) ' +
    'down to settings.mine.depthY (16: iron depth), then a main tunnel with side branches, mining the iron, coal, copper (and diamonds with an iron pickaxe) it sees in the walls, ' +
    'torches on the way, and back up the stairs when it has what it came for, the time is up, the inventory is full, food or the pickaxe run out, or it gets hurt. The mine is remembered: the next trip carries on where this one stopped.',
  params: z.object({
    ore: z.enum(['iron', 'coal', 'copper', 'diamond', 'gold', 'redstone', 'lapis']).default('iron').describe('what it goes for (it stops once it has `count` of it)'),
    count: z.number().int().min(0).max(256).default(0).describe('how many of that ore to bring (raw iron, coal...); 0 = until the time, inventory or tools run out'),
    max_minutes: z.number().min(1).max(60).optional().describe('time down there at most (default settings.mine.minutes, 15)'),
    fresh: z.boolean().default(false).describe('start a new mine even when it knows one')
  }),
  longRunning: true,
  async run (ctx, p) {
    return digMine(ctx, { ore: p.ore, want: p.count, ...(p.max_minutes ? { maxMinutes: p.max_minutes } : {}), fresh: p.fresh })
  }
})
