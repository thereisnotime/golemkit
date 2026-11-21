// Finding and fetching without the LLM: find_target (what is in view, remembered spots, a
// surface spiral like find_food, and prospecting for ores), bring_item (inventory, own chests,
// crafting, gathering, then a search) and fetch_drops (go to where the owner died and bring
// the items back). The decisions are pure and live in searchPlan.ts.
import type { Bot } from 'mineflayer'
import type { Block } from 'prismarine-block'
import type { Entity } from 'prismarine-entity'
import type { Agent, ActionContext, ActionResult } from '../core/index.ts'
import {
  defineSkill, defineAction, z, ok, fail, goals, travel, sleep, checkAborted, fmtPos, needsSurvival, itemName,
  surfaceY, parseDeathMessage
} from '../core/index.ts'
import { getPlaces, setPlace, sameDimension } from './navigation.ts'
import { digBlock, DigRefusedError, reachBlock, vec, gotoWithin, findItem } from './world.ts'
import { pickupNearby } from './pickup.ts'
import { climbOut, roofAbove } from './survival.ts'
import { collectBlocks } from './gather.ts'
import { craftItem, smeltItem } from './crafting.ts'
import { gatherMaterials, plankFuel } from './materials.ts'
import { fellTree } from './woodcutting.ts'
import { mineStone } from './mining.ts'
import { CROPS, isMature, plantOn } from './farming.ts'
import { withdraw as withdrawAction, knownContainers, CONTAINER_RE } from './containers.ts'
import { moddedNames } from './mods.ts'
import { offLimits, spawnOf, surfaceAt, topY, isNight, inOwnFarm, getFoodSpots } from './food.ts'
import {
  scoutWaypoints, scoutStopReason, nextWaypoint, sectorsText, sectorOf, rankSpots, DEFAULT_SCOUT_LIMITS,
  type Pos, type Waypoint
} from './foodPlan.ts'
import {
  resolveTarget, isResolveError, searchPhases, villageVerdict, portalVerdict, describeFind, gatherSource, bringSteps,
  isOwnChest, parseChestList, tossAccount, dropsTrip, progressDue, ORES, SMELTS, ingredientFor,
  type ResolvedTarget, type RegistryNames, type SearchPhase, type GatherSource
} from './searchPlan.ts'

type Ctx = Pick<ActionContext, 'bot' | 'agent' | 'signal' | 'log'> & Partial<Pick<ActionContext, 'player' | 'caller'>>

// ------------------------------------------------------------------ memory: own chests, deaths, last seen

const OWN_CHESTS_KEY = 'search.ownChests'
const DEATHS_KEY = 'search.deaths'

export interface DeathRecord { player: string, at: number, pos?: Pos, dim?: string, message?: string, posFrom?: 'entity' | 'last_seen' }

const lastSeen = new WeakMap<Agent, Map<string, { pos: Pos, dim?: string, at: number }>>()

function store (agent: Agent): Agent['storage'] | null {
  return (agent as { storage?: Agent['storage'] }).storage ?? null
}

export function ownChests (agent: Agent): Pos[] {
  return store(agent)?.get<Pos[]>(OWN_CHESTS_KEY, []) ?? []
}

function configuredChests (agent: Agent): Pos[] {
  const s = (agent.settings as { storage?: { chests?: unknown } }).storage
  return parseChestList(s?.chests)
}

export function recentDeaths (agent: Agent): DeathRecord[] {
  return store(agent)?.get<DeathRecord[]>(DEATHS_KEY, []) ?? []
}

const floorPos = (p: { x: number, y: number, z: number }): Pos => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) })

/** The online player's name with the right case (owners are stored in lower case). */
function playerName (bot: Bot, name: string | undefined): string | undefined {
  if (!name) return undefined
  if (bot.players?.[name]) return name
  return Object.keys(bot.players ?? {}).find(n => n.toLowerCase() === name.toLowerCase()) ?? name
}

function playerEnt (bot: Bot, name: string | undefined): Entity | undefined {
  const n = playerName(bot, name)
  return n ? bot.players?.[n]?.entity : undefined
}

/** Where a player was last seen by this bot (this session), if within maxAgeMs. */
function seenAt (agent: Agent, bot: Bot, name: string, maxAgeMs = 15 * 60_000): Pos | null {
  const e = playerEnt(bot, name)
  if (e) return floorPos(e.position)
  const s = lastSeen.get(agent)?.get(name.toLowerCase())
  return s && Date.now() - s.at <= maxAgeMs && (!s.dim || s.dim === bot.game?.dimension) ? s.pos : null
}

/** Who the bot works for in this call: the asking player, else the first owner. */
function askerOf (ctx: Ctx, explicit?: string): string | undefined {
  return playerName(ctx.bot, explicit ?? ctx.player ?? ctx.agent.owners?.[0])
}

function setup (agent: Agent, bot: Bot): () => void {
  const seen = new Map<string, { pos: Pos, dim?: string, at: number }>()
  lastSeen.set(agent, seen)
  const tick = setInterval(() => {
    for (const [name, p] of Object.entries(bot.players ?? {})) {
      if (name === bot.username || !p.entity) continue
      seen.set(name.toLowerCase(), { pos: floorPos(p.entity.position), dim: bot.game?.dimension, at: Date.now() })
    }
  }, 2000)
  tick.unref?.()
  const onMessage = (text: string) => {
    const d = parseDeathMessage(text)
    if (!d || d.victim === bot.username) return
    const ent = playerEnt(bot, d.victim)
    const last = seen.get(d.victim.toLowerCase())
    const pos = ent ? floorPos(ent.position) : last && Date.now() - last.at < 60_000 ? last.pos : undefined
    const rec: DeathRecord = { player: d.victim, at: Date.now(), message: text, dim: bot.game?.dimension, ...(pos ? { pos, posFrom: ent ? 'entity' : 'last_seen' } : {}) }
    const st = store(agent)
    if (st) st.set(DEATHS_KEY, [rec, ...recentDeaths(agent)].slice(0, 10))
    agent.log.child('search').info('player died', { player: d.victim, at: pos ? fmtPos(pos) : 'unknown' })
  }
  agent.on('serverMessage', onMessage)
  // chests and barrels this bot puts down are its own storage
  const orig = bot.placeBlock
  bot.placeBlock = async function (this: Bot, ref: any, face: any, ...rest: any[]) {
    const r = await (orig as any).call(this, ref, face, ...rest)
    try {
      const p = ref.position.plus(face)
      const b = bot.blockAt(p)
      if (b && CONTAINER_RE.test(b.name)) {
        const st = store(agent)
        const pos = floorPos(p)
        if (st && !isOwnChest(pos, ownChests(agent), [])) st.set(OWN_CHESTS_KEY, [...ownChests(agent), pos].slice(-64))
      }
    } catch {}
    return r
  } as Bot['placeBlock']
  return () => {
    clearInterval(tick)
    agent.off('serverMessage', onMessage)
    if (bot.placeBlock !== orig) bot.placeBlock = orig
  }
}

// ------------------------------------------------------------------ progress

/** Milestone messages to the asker, rate limited (important ones always go out). */
function reporter (ctx: Ctx, who: string | undefined): (msg: string, important?: boolean) => void {
  let last = 0
  const log = ctx.log
  return (msg, important = false) => {
    log.info(msg)
    if (!who || ctx.caller?.kind !== 'player') return
    const now = Date.now()
    if (!progressDue(last, now, important)) return
    last = now
    ctx.agent.whisper(who, msg)
  }
}

// ------------------------------------------------------------------ sensing

function registryNames (agent: Agent, bot: Bot): RegistryNames {
  const r = bot.registry as any
  const m = (() => { try { return moddedNames(agent) } catch { return { blocks: [], items: [], entities: [] } } })()
  const names = (arr: any[] | undefined) => (arr ?? []).map(x => String(x.name))
  return {
    blocks: [...names(r.blocksArray), ...m.blocks],
    items: [...names(r.itemsArray), ...m.items],
    entities: [...new Set([...names(r.entitiesArray), ...m.entities])],
    biomes: names(r.biomesArray)
  }
}

interface Sighting extends Pos { what: string, count: number, capped?: boolean, note?: string }

const ids = (bot: Bot, names: readonly string[]) => names.map(n => bot.registry.blocksByName[n]?.id).filter((x): x is number => x !== undefined)
const dist = (a: { x: number, z: number }, b: { x: number, z: number }) => Math.hypot(a.x - b.x, a.z - b.z)

/** Crops the bot may take: in its own farm, or a village farm (a villager within 24 blocks). */
function cropAllowed (agent: Agent, bot: Bot, p: Pos): boolean {
  if (agent.protectedAreas?.isProtected(p)) return false
  if (inOwnFarm(agent, p)) return true
  return Object.values(bot.entities ?? {}).some(e => e?.name === 'villager' && e.position && Math.hypot(e.position.x - p.x, e.position.y - p.y, e.position.z - p.z) <= 24)
}

const WORKSTATIONS = ['composter', 'lectern', 'smithing_table', 'fletching_table', 'cartography_table', 'brewing_stand', 'blast_furnace', 'smoker', 'cauldron', 'loom', 'stonecutter', 'grindstone', 'barrel']

function lookVillage (bot: Bot, radius: number): Sighting | null {
  const here = bot.entity.position
  const villagers = Object.values(bot.entities ?? {}).filter(e => e?.name === 'villager' && e.position && e.position.distanceTo(here) <= radius)
  const golems = Object.values(bot.entities ?? {}).filter(e => e?.name === 'iron_golem' && e.position && e.position.distanceTo(here) <= radius)
  const bedIds = Object.values(bot.registry.blocksByName).filter(b => b.name.endsWith('_bed')).map(b => b.id)
  const r = Math.min(radius, 96)
  const bells = bot.findBlocks({ matching: ids(bot, ['bell']), maxDistance: r, count: 8 })
  const beds = bot.findBlocks({ matching: bedIds, maxDistance: r, count: 64 })
  const jobs = bot.findBlocks({ matching: ids(bot, WORKSTATIONS), maxDistance: r, count: 32 })
  const paths = bot.findBlocks({ matching: ids(bot, ['dirt_path']), maxDistance: r, count: 64 })
  const centres: Pos[] = [...bells.map(floorPos), ...villagers.slice(0, 4).map(v => floorPos(v.position)), ...beds.slice(0, 4).map(floorPos)]
  let best: { at: Pos, score: number, why: string } | null = null
  for (const c of centres) {
    const near = (p: { x: number, y: number, z: number }) => Math.hypot(p.x - c.x, p.z - c.z) <= 48
    const v = villageVerdict({
      beds: beds.filter(near).length,
      bells: bells.filter(near).length,
      villagers: villagers.filter(e => near(e.position)).length,
      workstations: jobs.filter(near).length,
      paths: paths.filter(near).length,
      golems: golems.filter(e => near(e.position)).length
    })
    if (v.village && (!best || v.score > best.score)) best = { at: c, score: v.score, why: v.why }
  }
  return best ? { ...best.at, what: 'a village', count: 1, note: best.why } : null
}

function lookPortal (bot: Bot, radius: number): Sighting | null {
  const r = Math.min(radius, 96)
  const lit = bot.findBlocks({ matching: ids(bot, ['nether_portal']), maxDistance: r, count: 1 })
  if (lit.length) return { ...floorPos(lit[0]!), what: 'a nether portal', count: 1, note: 'lit' }
  const obs = bot.findBlocks({ matching: ids(bot, ['obsidian']), maxDistance: r, count: 256 }).map(floorPos)
  const v = portalVerdict(obs)
  return v.portal && v.at ? { ...v.at, what: 'a nether portal frame', count: 1, note: v.why } : null
}

function biomeName (bot: Bot, p: Pos): string | null {
  try {
    const b = bot.blockAt(vec(bot, p.x, p.y, p.z)) as (Block & { biome?: { name?: string } }) | null
    return b?.biome?.name ?? null
  } catch {
    return null
  }
}

function lookBiome (bot: Bot, t: ResolvedTarget, radius: number): Sighting | null {
  const re = new RegExp(t.biomePattern ?? '^$')
  const here = floorPos(bot.entity.position)
  const r = Math.min(radius, 128)
  let best: { p: Pos, d: number, name: string } | null = null
  for (let dx = -r; dx <= r; dx += 16) {
    for (let dz = -r; dz <= r; dz += 16) {
      const d = Math.hypot(dx, dz)
      if (d > r || (best && d >= best.d)) continue
      const x = here.x + dx
      const z = here.z + dz
      const y = surfaceY(bot, x, z)
      if (y === null) continue
      const name = biomeName(bot, { x, y: y - 1, z })
      if (name && re.test(name)) best = { p: { x, y, z }, d, name }
    }
  }
  return best ? { ...best.p, what: best.name.replace(/_/g, ' '), count: 1 } : null
}

/** Liquid source blocks with open air above (no lakes under the ground). */
function liquidSources (bot: Bot, name: string, radius: number): Block[] {
  return bot.findBlocks({ matching: ids(bot, [name]), maxDistance: radius, count: 32, useExtraInfo: (b: Block) => Number((b.getProperties() as { level?: number | string }).level ?? 0) === 0 && bot.blockAt(b.position.offset(0, 1, 0))?.name === 'air' })
    .map(p => bot.blockAt(p)).filter((b): b is Block => !!b)
}

/** What of the target is loaded around the bot within radius, nearest first, or null. */
export function lookFor (agent: Agent, bot: Bot, t: ResolvedTarget, radius: number): Sighting | null {
  const here = bot.entity.position
  if (t.kind === 'structure') return t.structure === 'village' ? lookVillage(bot, radius) : lookPortal(bot, radius)
  if (t.kind === 'biome') return lookBiome(bot, t, radius)
  if (t.kind === 'mob') {
    const mobs = Object.values(bot.entities ?? {}).filter(e => e?.position && t.mobs?.includes(e.name ?? '') && e.position.distanceTo(here) <= radius)
      .sort((a, b) => a.position.distanceTo(here) - b.position.distanceTo(here))
    if (!mobs.length) return null
    const kinds = [...new Set(mobs.map(m => m.name))]
    return { ...floorPos(mobs[0]!.position), what: kinds.length === 1 ? kinds[0]!.replace(/_/g, ' ') : t.label, count: mobs.length }
  }
  if (t.kind !== 'block' || !t.blocks?.length) return null
  const r = Math.min(radius, 96)
  if (t.liquid) {
    const src = liquidSources(bot, t.blocks[0]!, r).filter(b => !offLimits(agent, bot, b.position, 0))
    return src.length ? { ...floorPos(src[0]!.position), what: t.label, count: 1 } : null
  }
  const matching = ids(bot, t.blocks)
  if (!matching.length) return null
  const found = bot.findBlocks({
    matching,
    maxDistance: r,
    count: 64,
    ...(t.ripe ? { useExtraInfo: (b: Block) => isMature(b.name, (b.getProperties() as Record<string, unknown>).age) && cropAllowed(agent, bot, floorPos(b.position)) } : {})
  })
  if (!found.length) return null
  // prefer one outside protected areas (it can be fetched), but report the nearest either way
  const free = found.find(p => !agent.protectedAreas?.isProtected(p))
  const at = free ?? found[0]!
  const name = bot.blockAt(at)?.name ?? t.blocks[0]!
  return { ...floorPos(at), what: t.ore ? `${name.replace(/_/g, ' ')}` : t.label, count: found.length, capped: found.length >= 64, ...(free ? {} : { note: 'in a protected area' }) }
}

// ------------------------------------------------------------------ the spiral scout (find_food's, generalised)

interface ScoutOutcome { seen: Sighting | null, reason: string, farthest: number, legs: number, sectors: number[] }

async function scout (ctx: Ctx, center: Pos, radius: number, maxMinutes: number, atNight: boolean, look: () => Sighting | null, say: (m: string) => void): Promise<ScoutOutcome> {
  const { bot, agent, signal, log } = ctx
  const t0 = Date.now()
  const spawn = spawnOf(bot)
  const away = spawn && Math.hypot(center.x - spawn.x, center.z - spawn.z) > 4 ? Math.atan2(center.z - spawn.z, center.x - spawn.x) : Math.random() * Math.PI * 2
  const wps: Waypoint[] = scoutWaypoints(center, radius, { startAngle: away, skip: (w) => offLimits(agent, bot, w, 0) })
  const visited = new Set<number>()
  const blocked = new Map<number, number>()
  const sectors: number[] = []
  let legs = 0
  let walked = 0
  let consecutiveFailures = 0
  let farthest = 0
  let reason = ''
  const limits = { ...DEFAULT_SCOUT_LIMITS, atNight, maxMs: maxMinutes * 60_000, maxWalk: Math.max(600, radius * 12) }
  const progress = () => ({
    legs, walked, consecutiveFailures, elapsedMs: Date.now() - t0, night: isNight(bot), health: bot.health ?? 20,
    hostilesNear: Object.values(bot.entities).filter(e => e?.type === 'hostile' && e.position.distanceTo(bot.entity.position) < 12).length
  })
  while (true) {
    checkAborted(signal)
    const stop = scoutStopReason(progress(), limits)
    if (stop) { reason = stop; break }
    const i = nextWaypoint(wps, visited, blocked)
    if (i < 0) { reason = `covered every direction out to ${radius} blocks`; break }
    visited.add(i)
    const w = wps[i]!
    const top = surfaceAt(bot, w.x, Math.floor(bot.entity.position.y), w.z)
    if (top && /water|lava/.test(top.name)) { log.debug('find_target: skipping wet waypoint', { at: `${w.x} ${w.z}`, block: top.name }); continue }
    const start = bot.entity.position.clone()
    const sky = topY(bot, w.x, w.z)
    let wentUnder = false
    let seen: Sighting | null = null
    const ctl = new AbortController()
    const leg = AbortSignal.any([signal, ctl.signal])
    try {
      await travel(bot, sky !== null ? { x: w.x, y: sky, z: w.z } : top ? { x: w.x, y: top.position.y + 1, z: w.z } : { x: w.x, z: w.z }, leg, {
        range: 8,
        stepTimeoutMs: 45_000,
        onProgress: () => {
          seen = look()
          const y = bot.entity.position.y
          if (y < Math.min(start.y, sky ?? start.y) - 10 && roofAbove(bot, 32) !== null) { wentUnder = true; ctl.abort() }
          if (seen || scoutStopReason(progress(), limits)) ctl.abort()
        }
      })
      consecutiveFailures = 0
    } catch (e) {
      checkAborted(signal)
      if (!ctl.signal.aborted) {
        consecutiveFailures++
        blocked.set(w.sector, w.ring + 1)
        log.debug('find_target: leg failed', { to: `${w.x} ${w.z}`, error: (e as Error).message })
      }
    }
    if (wentUnder) {
      blocked.set(w.sector, w.ring)
      consecutiveFailures++
      log.info('find_target: ended up underground, climbing out', { at: fmtPos(bot.entity.position) })
      const r = await (climbOut as any).run(ctx, { maxBlocks: 64 }).catch((e: Error) => ({ ok: false, message: e.message }))
      if (!r?.ok) { reason = `fell into a cave at ${fmtPos(bot.entity.position)} and couldn't climb out (${r?.message ?? 'unknown'})`; break }
    }
    legs++
    walked += bot.entity.position.distanceTo(start)
    sectors.push(sectorOf(center, bot.entity.position))
    farthest = Math.max(farthest, Math.round(dist(bot.entity.position, center)))
    seen ??= look()
    if (seen) return { seen, reason: 'found', farthest, legs, sectors }
    if (legs % 4 === 0) say(`still looking: ${farthest} blocks out, ${sectorsText(sectors)}`)
  }
  return { seen: null, reason, farthest, legs, sectors }
}

// ------------------------------------------------------------------ fetching

const invCount = (bot: Bot, match: (n: string) => boolean) => bot.inventory.items().reduce((n, i) => n + (match(itemName(i)) ? i.count : 0), 0)

function inventoryMap (bot: Bot): Record<string, number> {
  const out: Record<string, number> = {}
  for (const i of bot.inventory.items()) out[itemName(i)] = (out[itemName(i)] ?? 0) + i.count
  return out
}

function gained (before: Record<string, number>, after: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(after)) if (v > (before[k] ?? 0)) out[k] = v - (before[k] ?? 0)
  return out
}

/** Matches an item name for a wanted item ("log" means any log). */
function matcher (item: string): (n: string) => boolean {
  if (item === 'log' || item === 'logs') return n => /_log$|_stem$/.test(n)
  if (item === 'planks') return n => /_planks$/.test(n)
  return n => n === item
}

/**
 * Runs a step that may put down crafting tables or furnaces, then digs up the ones it put down
 * (new ones within 8 blocks that weren't there before) and picks them up.
 */
async function tidyStations<T> (ctx: Ctx, fn: () => Promise<T>): Promise<T> {
  const { bot, signal } = ctx
  const stationIds = ids(bot, ['crafting_table', 'furnace'])
  const key = (p: { x: number, y: number, z: number }) => `${p.x},${p.y},${p.z}`
  const before = new Set(bot.findBlocks({ matching: stationIds, maxDistance: 24, count: 64 }).map(key))
  try {
    return await fn()
  } finally {
    if (!signal.aborted) {
      const fresh = bot.findBlocks({ matching: stationIds, maxDistance: 24, count: 64 }).filter(p => !before.has(key(p)))
      for (const p of fresh) {
        const b = bot.blockAt(p)
        if (!b || !/crafting_table|furnace/.test(b.name)) continue
        try {
          await reachBlock(bot, p, signal, 2, 15_000)
          await digBlock(bot, b, signal)
          ctx.log.info('picked up a station it put down', { block: b.name, at: fmtPos(p) })
        } catch (e) { checkAborted(signal) }
      }
      if (fresh.length) await pickupNearby(bot, signal, { radius: 6, maxMs: 6000 }).catch(() => 0)
    }
  }
}

/** Harvests up to `want` ripe crops of one kind from own or village farms nearby, replanting. Returns the item gained. */
async function harvestCrops (ctx: Ctx, block: string, item: string, want: number): Promise<number> {
  const { bot, agent, signal, log } = ctx
  const match = matcher(item)
  const start = invCount(bot, match)
  const seed = CROPS[block]?.seed
  const skip = new Set<string>()
  let dug = 0
  for (let tries = 0; tries < want * 3 + 6 && invCount(bot, match) - start < want; tries++) {
    checkAborted(signal)
    const ps = bot.findBlocks({
      matching: ids(bot, [block]),
      maxDistance: 32,
      count: 64,
      useExtraInfo: (b: Block) => isMature(b.name, (b.getProperties() as Record<string, unknown>).age) && cropAllowed(agent, bot, floorPos(b.position))
    }).filter(p => !skip.has(fmtPos(p)))
    const p = ps[0]
    if (!p) break
    const b = bot.blockAt(p)
    if (!b) { skip.add(fmtPos(p)); continue }
    try {
      await reachBlock(bot, p, signal, 2, 15_000)
      await digBlock(bot, b, signal)
      dug++
      if (seed && findItem(bot, seed)) await plantOn(bot, p.offset(0, -1, 0), seed, signal).catch(() => false)
    } catch (e) {
      checkAborted(signal)
      if (e instanceof DigRefusedError) agent.markProtected(p)
      skip.add(fmtPos(p))
      log.debug('harvest skipped a crop', { at: fmtPos(p), error: (e as Error).message })
    }
    if (dug % 6 === 0) await pickupNearby(bot, signal, { radius: 6, maxMs: 6000 })
  }
  await pickupNearby(bot, signal, { radius: 8, maxMs: 10_000 })
  return invCount(bot, match) - start
}

/** Fills empty buckets from source blocks of a liquid nearby. Returns buckets filled. */
async function fillBuckets (ctx: Ctx, liquid: string, want: number): Promise<number> {
  const { bot, signal } = ctx
  const full = `${liquid}_bucket`
  const start = invCount(bot, n => n === full)
  for (let i = 0; i < want + 2 && invCount(bot, n => n === full) - start < want; i++) {
    checkAborted(signal)
    const bucket = findItem(bot, 'bucket')
    if (!bucket) break
    const src = liquidSources(bot, liquid, 24)[0]
    if (!src) break
    await gotoWithin(bot, new goals.GoalNear(src.position.x, src.position.y + 1, src.position.z, 3), signal, 20_000).catch(e => { checkAborted(signal) })
    await bot.equip(bucket, 'hand')
    await bot.lookAt(src.position.offset(0.5, 0.5, 0.5), true)
    bot.activateItem()
    await sleep(600, signal)
    bot.deactivateItem()
  }
  return invCount(bot, n => n === full) - start
}

/** Fetches `count` of a target near where the bot stands (it walks to `at` first). Returns what it got. */
async function fetchTarget (ctx: Ctx, t: ResolvedTarget, at: Pos | null, count: number): Promise<{ got: number, message: string }> {
  const { bot, agent, signal } = ctx
  if (!t.fetch || !t.item) return { got: 0, message: `${t.label} isn't something I can bring` }
  if (at && dist(bot.entity.position, at) > 16) {
    try { await travel(bot, at, signal, { range: 4 }) } catch (e) { checkAborted(signal); return { got: 0, message: `couldn't get to it (${(e as Error).message})` } }
  }
  const match = matcher(t.item)
  const start = invCount(bot, match)
  const got = () => invCount(bot, match) - start
  const notes: string[] = []
  if (t.fetch === 'harvest') {
    await harvestCrops(ctx, t.blocks![0]!, t.item, count)
  } else if (t.fetch === 'bucket') {
    if (!findItem(bot, 'bucket')) return { got: 0, message: `I need an empty bucket to bring ${t.label}` }
    await fillBuckets(ctx, t.blocks![0]!, count)
  } else if (t.fetch === 'chop' && t.blocks?.length === 1) {
    if (!agent.canDig) return { got: 0, message: 'digging is disabled for this bot' }
    const r = await tidyStations(ctx, () => collectBlocks(ctx, t.blocks![0]!, Math.min(64, count)))
    if (!r.ok) notes.push(r.message)
  } else if (t.fetch === 'chop') {
    if (!agent.canDig) return { got: 0, message: 'digging is disabled for this bot' }
    for (let trees = 0; got() < count && trees < Math.ceil(count / 3) + 3; trees++) {
      checkAborted(signal)
      const r = await tidyStations(ctx, () => fellTree(ctx, { radius: 32, replant: true }))
      if (!r.ok) { notes.push(r.message); break }
    }
  } else {
    if (!agent.canDig) return { got: 0, message: 'digging is disabled for this bot' }
    for (const block of t.blocks ?? []) {
      if (got() >= count) break
      checkAborted(signal)
      if (!bot.findBlocks({ matching: ids(bot, [block]), maxDistance: 48, count: 1 }).length) continue
      const r = await tidyStations(ctx, () => collectBlocks(ctx, block, Math.min(64, count - got())))
      if (!r.ok) notes.push(r.message)
    }
  }
  const n = got()
  return { got: n, message: n ? `got ${n} ${t.item}${n < count ? ` of ${count}` : ''}` : `got no ${t.item}${notes.length ? ` (${notes.join('; ')})` : ''}` }
}

// ------------------------------------------------------------------ delivery

/** Walks to the player (following if they move) and stays near them. Throws when they can't be found. */
async function goToPlayer (ctx: Ctx, who: string, fallback: Pos | null): Promise<Entity> {
  const { bot, agent, signal } = ctx
  let ent = playerEnt(bot, who)
  if (!ent) {
    const last = seenAt(agent, bot, who) ?? fallback
    if (!last) throw new Error(`I can't see ${who} and don't know where they are`)
    await travel(bot, last, signal, { range: 3 }).catch(e => { checkAborted(signal) })
    ent = playerEnt(bot, who)
    if (!ent) throw new Error(`I went back to ${fmtPos(last)} but can't see ${who}`)
  }
  for (let i = 0; i < 4; i++) {
    checkAborted(signal)
    ent = playerEnt(bot, who) ?? ent
    if (ent.position.distanceTo(bot.entity.position) <= 3.5) return ent
    if (ent.position.distanceTo(bot.entity.position) > 48) await travel(bot, floorPos(ent.position), signal, { range: 3 }).catch(e => { checkAborted(signal) })
    else await gotoWithin(bot, new goals.GoalFollow(ent, 2), signal, 20_000).catch(e => { checkAborted(signal) })
  }
  ent = playerEnt(bot, who) ?? ent
  if (ent.position.distanceTo(bot.entity.position) > 6) throw new Error(`couldn't get close to ${who} (${Math.round(ent.position.distanceTo(bot.entity.position))} blocks away)`)
  return ent
}

export interface Delivery { given: number, pickedUp: number | null, ok: boolean, message: string }

/**
 * Hands items to a player: walks up to them, looks at them, tosses the items and watches them
 * being picked up, then reports what really happened (tossAccount).
 */
async function deliver (ctx: Ctx, who: string, items: Record<string, number>, fallback: Pos | null): Promise<Delivery> {
  const { bot, signal } = ctx
  const names = Object.keys(items).filter(k => items[k]! > 0)
  const total = names.reduce((n, k) => n + items[k]!, 0)
  const label = names.length === 1 ? names[0]! : 'items'
  if (!total) return { given: 0, pickedUp: 0, ok: false, message: 'nothing to hand over' }
  let ent: Entity
  try { ent = await goToPlayer(ctx, who, fallback) } catch (e) { checkAborted(signal); return { given: 0, pickedUp: null, ok: false, message: (e as Error).message } }
  const has = (n: string) => names.includes(n)
  const before = invCount(bot, has)
  let picked = 0
  const onCollect = (collector: Entity, collected: Entity) => {
    if (collector?.id !== ent.id) return
    try {
      const it = collected.getDroppedItem?.()
      if (it && has(itemName(it))) picked += it.count
    } catch {}
  }
  bot.on('playerCollect', onCollect)
  try {
    await bot.lookAt(ent.position.offset(0, 1.6, 0), true).catch(() => {})
    for (const n of names) {
      let left = items[n]!
      for (const stack of bot.inventory.items().filter(i => itemName(i) === n)) {
        if (left <= 0) break
        checkAborted(signal)
        const k = Math.min(stack.count, left)
        await bot.toss(stack.type, null, k).catch(() => {})
        left -= k
        await sleep(150, signal)
      }
    }
    const tossed = before - invCount(bot, has)
    for (let i = 0; i < 20 && picked < tossed; i++) await sleep(200, signal)
  } finally {
    bot.removeListener('playerCollect', onCollect)
  }
  const acc = tossAccount({ requested: total, before, after: invCount(bot, has), pickedUp: picked }, label, who)
  return acc
}

// ------------------------------------------------------------------ find engine

interface FindOptions {
  radius: number
  maxMinutes: number
  bring: boolean
  count: number
  go: boolean
  prospect: boolean
  atNight: boolean
  /** Who to report to and come back to. */
  who?: string
  /** Deliver what was fetched to `who` (false when bring_item delivers itself). */
  deliver: boolean
}

interface FindOutcome { ok: boolean, message: string, at?: Pos, got?: Record<string, number> }

async function findEngine (ctx: Ctx, t: ResolvedTarget, o: FindOptions): Promise<FindOutcome> {
  const { bot, agent, signal, log } = ctx
  const say = reporter(ctx, o.who)
  const t0 = Date.now()
  const origin = floorPos(bot.entity.position)
  const dim = bot.game?.dimension
  const view = Math.min(o.radius, 96)
  const before = inventoryMap(bot)
  const look = (r = view) => lookFor(agent, bot, t, r)
  const phases: SearchPhase[] = searchPhases(t, { prospect: o.prospect || (o.bring && !!t.ore), canDig: agent.canDig, feetY: origin.y })
  if (!phases.length) return { ok: false, message: `${t.label} isn't something lying around in the world${t.note ? `: ${t.note}` : ''}` }
  const secs = () => `${Math.round((Date.now() - t0) / 1000)}s`
  const notes: string[] = []

  const found = async (s: Sighting, how: string): Promise<FindOutcome> => {
    const at = { x: s.x, y: s.y, z: s.z }
    setPlace(agent, `found:${t.key}`, { ...at, ...(dim ? { dimension: dim } : {}) })
    try { agent.journal?.record('found', { target: t.key, what: s.what, count: s.count, how, ...(s.note ? { note: s.note } : {}) }, { pos: at, ...(dim ? { dim } : {}) }) } catch {}
    const ownerAt = o.who ? seenAt(agent, bot, o.who) : null
    const ref = ownerAt ?? origin
    const refName = ownerAt ? 'you' : 'where I started'
    const sy = t.kind === 'block' && !t.liquid ? surfaceY(bot, at.x, at.z) : null
    const text = describeFind({ ...at, what: s.what, count: s.count, capped: s.capped }, ref, refName, sy) + (s.note ? ` (${s.note})` : '')
    say(`found ${text}`, true)
    const parts = [`${how}: ${text}, remembered as found:${t.key}`]
    let fetched: Record<string, number> = {}
    let ok = true
    if (o.bring) {
      if (!t.fetch) { parts.push(`can't bring ${t.label}`); ok = false } else {
        say(`fetching ${o.count} ${t.item}`)
        const r = await fetchTarget(ctx, t, at, o.count)
        fetched = gained(before, inventoryMap(bot))
        if (t.item) fetched = Object.fromEntries(Object.entries(fetched).filter(([k]) => matcher(t.item!)(k)))
        parts.push(r.message)
        if (!r.got) ok = false
      }
    }
    if (o.go) {
      if (!o.bring && dist(bot.entity.position, at) > 4) {
        try { await travel(bot, t.kind === 'block' && t.ore ? { x: at.x, z: at.z } : at, signal, { range: 3 }); parts.push(`I'm there now (${fmtPos(bot.entity.position)})`) } catch (e) { checkAborted(signal); parts.push(`couldn't walk all the way (${(e as Error).message})`) }
      } else parts.push(`staying here at ${fmtPos(bot.entity.position)}`)
    } else if (o.who) {
      if (o.deliver && Object.keys(fetched).length) {
        const d = await deliver(ctx, o.who, fetched, origin)
        parts.push(d.message)
        if (!d.ok) ok = false
      } else if ((o.deliver || !o.bring) && dist(bot.entity.position, origin) > 8) {
        try { await goToPlayer(ctx, o.who, origin); parts.push('back with you') } catch (e) { checkAborted(signal); parts.push((e as Error).message) }
      }
    }
    return { ok, message: `${parts.join('; ')} (${secs()})`, at, got: fetched }
  }

  // underground: get to the sky first, the scout and the report both assume the surface
  for (const phase of phases) {
    checkAborted(signal)
    if (phase === 'view') {
      const s = look()
      if (s) return found(s, 'in sight')
      continue
    }
    if (phase === 'memory') {
      const places = getPlaces(agent)
      const spots: Pos[] = []
      const own = places[`found:${t.key}`]
      if (own && sameDimension(bot, own)) spots.push(own)
      if (t.kind === 'mob') for (const s of rankSpots(getFoodSpots(agent), ['animals'], Date.now(), origin, dim)) if (s.animals?.some(a => t.mobs?.includes(a))) spots.push(s)
      if (t.structure === 'village' && places['food:village_farm']) spots.push(places['food:village_farm']!)
      const near = spots.filter(p => dist(p, origin) <= o.radius * 1.5).slice(0, 2)
      for (const p of near) {
        checkAborted(signal)
        say(`checking a spot I remember at ${fmtPos(p)}`)
        const ctl = new AbortController()
        let seen: Sighting | null = null
        try {
          await travel(bot, p, AbortSignal.any([signal, ctl.signal]), { range: 6, onProgress: () => { seen = look(); if (seen) ctl.abort() } })
        } catch (e) { checkAborted(signal); if (!ctl.signal.aborted) log.debug('find_target: remembered spot unreachable', { at: fmtPos(p), error: (e as Error).message }) }
        seen ??= look()
        if (seen) return found(seen, `at a spot I remembered`)
        if (own && p === own) setPlace(agent, `found:${t.key}`, null)
        notes.push(`nothing at the spot I remembered (${fmtPos(p)})`)
      }
      continue
    }
    if (phase === 'scout') {
      if (isNight(bot) && !o.atNight) { notes.push('it is night, so I did not scout (at_night=true to go anyway)'); continue }
      if (roofAbove(bot, 32) !== null) {
        const sy = surfaceY(bot, bot.entity.position.x, bot.entity.position.z)
        if (sy === null || sy - bot.entity.position.y > 6) {
          const r = await (climbOut as any).run(ctx, { maxBlocks: 64 }).catch((e: Error) => ({ ok: false, message: e.message }))
          if (!r?.ok) { notes.push(`couldn't climb out to scout (${r?.message})`); continue }
        }
      }
      say(`nothing in sight, scouting up to ${o.radius} blocks for ${t.label}`)
      const r = await scout(ctx, floorPos(bot.entity.position), o.radius, Math.max(1, o.maxMinutes - (Date.now() - t0) / 60_000), o.atNight, () => look(Math.min(view, 64)), say)
      if (r.seen) return found(r.seen, `scouted ${r.farthest} blocks ${sectorsText(r.sectors)}`)
      notes.push(r.legs ? `scouted ${r.farthest} blocks ${sectorsText(r.sectors)}, no ${t.label}; stopped: ${r.reason}` : `didn't get to scout (${r.reason})`)
      continue
    }
    if (phase === 'prospect' && t.ore) {
      say(`no ${t.label} in sight, strip mining for it`)
      const ore = ORES[t.ore]!
      const r = await tidyStations(ctx, () => mineStone(ctx, o.count, { item: ore.drop, sources: ore.blocks, minDepth: 20, maxSteps: 64, returnUp: !o.go }))
      const got = invCount(bot, n => n === ore.drop) - (before[ore.drop] ?? 0)
      if (got > 0) {
        const at = floorPos(bot.entity.position)
        return found({ ...at, what: t.label, count: got, note: `mined ${got} ${ore.drop} prospecting` }, 'prospecting')
      }
      notes.push(`prospecting: ${r.message}`)
    }
  }
  // not found: come back unless told to stay out
  if (!o.go && o.who && dist(bot.entity.position, origin) > 8) {
    try { await goToPlayer(ctx, o.who, origin); notes.push('came back') } catch (e) { checkAborted(signal); notes.push((e as Error).message) }
  }
  return { ok: false, message: `didn't find ${t.label}: ${notes.join('; ') || 'nothing in range'} (${secs()})` }
}

// ------------------------------------------------------------------ actions

const findTarget = defineAction({
  name: 'find_target',
  description: 'Find something and report where it is: blocks and families (iron, diamonds, coal, logs, sand, water, lava), ' +
    'mobs (sheep, cows, villager), structures (village, nether portal, chest), biomes (desert, snow, ocean) or modded names. ' +
    'Looks at what is loaded around it, then remembered spots, then scouts a spiral on the surface by day (and can strip mine for ores). ' +
    'Remembers the spot as a place (found:iron for iron), reports coordinates, distance and direction from you, and comes back (or stays there with go). ' +
    'With bring it also fetches count of it and hands them over.',
  params: z.object({
    target: z.string().min(1).describe('what to look for, e.g. iron, sheep, water, village, desert'),
    radius: z.number().min(16).max(512).default(160).describe('how far to search, in blocks'),
    max_minutes: z.number().min(1).max(30).default(8).describe('give up after this long'),
    bring: z.boolean().default(false).describe('also fetch some of it (blocks and items only) and hand it over'),
    count: z.number().int().min(1).max(256).default(1).describe('how many to bring'),
    go: z.boolean().default(false).describe('walk there and stay, instead of coming back to report'),
    prospect: z.boolean().default(false).describe('ores: strip mine for it when none is in sight (always on with bring)'),
    at_night: z.boolean().default(false).describe('also scout at night (dangerous)')
  }),
  longRunning: true,
  async run (ctx, p): Promise<ActionResult> {
    const t = resolveTarget(p.target, registryNames(ctx.agent, ctx.bot))
    if (isResolveError(t)) return fail(`${t.error}${t.suggestions.length ? `; did you mean ${t.suggestions.join(', ')}?` : ''}`)
    if (p.bring && !needsSurvival(ctx.bot)) return fail(`in ${ctx.bot.game.gameMode} mode use creative_get instead of fetching`)
    const r = await findEngine(ctx, t, {
      radius: p.radius, maxMinutes: p.max_minutes, bring: p.bring, count: p.count, go: p.go, prospect: p.prospect, atNight: p.at_night,
      who: askerOf(ctx), deliver: true
    })
    return r.ok ? ok(r.message, { at: r.at, target: t.key, got: r.got }) : fail(r.message, { at: r.at, target: t.key })
  }
})

/** Own chests within range in this dimension, those known to hold the item first. */
function chestCandidates (agent: Agent, bot: Bot, item: string): { pos: Pos, known: number | null }[] {
  const own = [...ownChests(agent), ...configuredChests(agent)]
  const seen = knownContainers(agent)
  const here = bot.entity.position
  return own
    .filter((p, i) => own.findIndex(q => q.x === p.x && q.y === p.y && q.z === p.z) === i)
    .filter(p => Math.hypot(p.x - here.x, p.y - here.y, p.z - here.z) <= 96)
    .map(p => {
      const s = seen.find(c => c.x === p.x && c.y === p.y && c.z === p.z)
      return { pos: p, known: s ? (s.contents[item] ?? 0) : null }
    })
    .filter(c => c.known === null || c.known > 0)
    .sort((a, b) => (b.known ?? 0.5) - (a.known ?? 0.5))
}

/** Gets `want` more of an item into the inventory (no delivery). Returns what it did. */
async function obtain (ctx: Ctx, item: string, want: number, depth: number, say: (m: string, i?: boolean) => void, maxMinutes: number): Promise<string[]> {
  const { bot, agent, signal } = ctx
  const match = matcher(item)
  const start = invCount(bot, match)
  const missing = () => want - (invCount(bot, match) - start)
  const notes: string[] = []
  const def = bot.registry.itemsByName[item]
  const recipe = !!def && (() => { try { return bot.recipesAll(def.id, null, true).length > 0 } catch { return false } })()
  const source: GatherSource | null = gatherSource(item)
  const chests = chestCandidates(agent, bot, item)
  const steps = bringSteps({
    item, count: want, have: 0,
    inOwnChests: chests.reduce((n, c) => n + (c.known ?? 0), 0),
    uncheckedOwnChests: chests.filter(c => c.known === null).length,
    recipe, source, smeltFrom: depth < 1 ? SMELTS[item] ?? null : null, canDig: agent.canDig, creative: !needsSurvival(bot)
  })
  for (const step of steps) {
    if (missing() <= 0) break
    checkAborted(signal)
    if (step === 'inventory') continue
    if (step === 'chest') {
      for (const c of chests) {
        if (missing() <= 0) break
        say(`checking my chest at ${fmtPos(c.pos)}`)
        try {
          if (dist(bot.entity.position, c.pos) > 32) await travel(bot, c.pos, signal, { range: 3 })
          const r = await (withdrawAction as any).run(ctx, { item, count: missing(), ...c.pos }) as ActionResult
          notes.push(`chest ${fmtPos(c.pos)}: ${r.message}`)
        } catch (e) { checkAborted(signal); notes.push(`chest ${fmtPos(c.pos)}: ${(e as Error).message}`) }
      }
      continue
    }
    if (step === 'craft') {
      say(`crafting ${missing()} ${item}`)
      let r = await tidyStations(ctx, () => craftItem(bot, signal, item, missing())).catch(e => { checkAborted(signal); return fail((e as Error).message) })
      const ing = ingredientFor(item)
      if ((!r.ok || missing() > 0) && ing && depth < 1) {
        const need = Math.ceil(missing() / ing.makes) * ing.per - invCount(bot, matcher(ing.item))
        if (need > 0) {
          say(`need ${need} ${ing.item} for the ${item}, getting it`)
          notes.push(...(await obtain(ctx, ing.item, need, depth + 1, say, maxMinutes)))
        }
        r = await tidyStations(ctx, () => craftItem(bot, signal, item, missing())).catch(e => { checkAborted(signal); return fail((e as Error).message) })
      }
      notes.push(r.message)
      continue
    }
    if (step === 'smelt') {
      const from = SMELTS[item]!
      const n = missing()
      const fromMatch = matcher(from)
      if (invCount(bot, fromMatch) < n) {
        say(`need ${n} ${from} to smelt into ${item}, getting it`)
        notes.push(...(await obtain(ctx, from, n - invCount(bot, fromMatch), depth + 1, say, maxMinutes)))
      }
      const input = Object.keys(inventoryMap(bot)).find(fromMatch)
      if (!input) { notes.push(`no ${from} to smelt`); continue }
      const furnaceId = bot.registry.blocksByName.furnace?.id
      if (!findItem(bot, 'furnace') && !(furnaceId !== undefined && bot.findBlock({ matching: furnaceId, maxDistance: 32 }))) {
        const cobble = invCount(bot, x => x === 'cobblestone')
        if (cobble < 8) notes.push(...(await obtain(ctx, 'cobblestone', 8 - cobble, depth + 1, say, maxMinutes)))
        const f = await craftItem(bot, signal, 'furnace', 1).catch(e => { checkAborted(signal); return fail((e as Error).message) })
        if (!f.ok) { notes.push(`furnace: ${f.message}`); continue }
      }
      const fuelOf = () => ['coal', 'charcoal'].find(f => invCount(bot, x => x === f) > 0) ?? plankFuel(bot)
      if (!fuelOf()) await tidyStations(ctx, () => gatherMaterials(ctx, { planks: Math.ceil(n / 1.5) + 1 }, { radius: 32 }))
      say(`smelting ${Math.min(n, invCount(bot, x => x === input))} ${input}`)
      const r = await tidyStations(ctx, () => smeltItem(bot, signal, ctx.log, input, n, fuelOf())).catch(e => { checkAborted(signal); return fail((e as Error).message) })
      notes.push(r.message)
      continue
    }
    if (step === 'gather' && source) {
      say(`getting ${missing()} ${item}`)
      notes.push(await gatherOnce(ctx, item, source, missing()))
      continue
    }
    if (step === 'find' && source?.target) {
      const t = resolveTarget(source.target, registryNames(agent, bot))
      if (isResolveError(t)) continue
      say(`none close by, looking for ${t.label}`)
      const r = await findEngine(ctx, t, { radius: 160, maxMinutes, bring: false, count: 1, go: true, prospect: !!t.ore, atNight: false, deliver: false })
      notes.push(r.message)
      if (r.ok && missing() > 0) notes.push(await gatherOnce(ctx, item, source, missing()))
    }
  }
  return notes
}

async function gatherOnce (ctx: Ctx, item: string, source: GatherSource, want: number): Promise<string> {
  const { bot, agent, signal } = ctx
  if (source.how === 'materials') {
    const r = await tidyStations(ctx, () => gatherMaterials(ctx, { [item]: invCount(bot, matcher(item)) + want }, { radius: 32 }))
    return r.message
  }
  if (source.how === 'harvest') {
    const n = await harvestCrops(ctx, source.block!, item === 'wheat_seeds' ? 'wheat_seeds' : item, want)
    return n ? `harvested ${n} ${item}` : `no ripe ${source.block} I may take within 32 blocks`
  }
  if (source.how === 'bucket') {
    const n = await fillBuckets(ctx, source.block!, want)
    return n ? `filled ${n} buckets` : `couldn't fill a bucket (${findItem(bot, 'bucket') ? `no ${source.block} nearby` : 'no empty bucket'})`
  }
  if (!agent.canDig) return 'digging is disabled for this bot'
  if (source.how === 'chop' && source.block) {
    // one kind of wood: dig those logs (felling takes whatever tree is nearest)
    const r = await tidyStations(ctx, () => collectBlocks(ctx, source.block!, Math.min(64, want)))
    return r.message
  }
  if (source.how === 'chop') {
    const start = invCount(bot, matcher(item))
    let last = ''
    for (let i = 0; i < Math.ceil(want / 3) + 3 && invCount(bot, matcher(item)) - start < want; i++) {
      checkAborted(signal)
      const r = await tidyStations(ctx, () => fellTree(ctx, { radius: 32, replant: true }))
      last = r.message
      if (!r.ok) break
    }
    return `${invCount(bot, matcher(item)) - start} ${item} from trees${last ? ` (${last})` : ''}`
  }
  // collect: ores give their drop from either variant
  const ore = Object.values(ORES).find(o => o.drop === item || o.blocks.includes(item))
  const blocks = ore ? ore.blocks : [source.block!]
  const start = invCount(bot, matcher(item))
  const notes: string[] = []
  for (const b of blocks) {
    const left = want - (invCount(bot, matcher(item)) - start)
    if (left <= 0) break
    if (!bot.findBlocks({ matching: ids(bot, [b]), maxDistance: 48, count: 1 }).length) continue
    const r = await tidyStations(ctx, () => collectBlocks(ctx, b, Math.min(64, left)))
    notes.push(r.message)
  }
  return notes.join('; ') || `no ${blocks.join(' or ')} within 48 blocks`
}

const bringItem = defineAction({
  name: 'bring_item',
  description: 'Bring a player some of an item: from the inventory, from my own chests (ones I placed or listed in settings.storage.chests, never anyone else\'s), ' +
    'by crafting it (simple recipes), by gathering it (chop, mine, harvest village or own farms), or by finding its source first. ' +
    'Then walks to the player, follows them if they move, tosses it to them and says how many they really got.',
  params: z.object({
    item: z.string().min(1).describe('item name, e.g. oak_planks, bread, raw_iron, cobblestone'),
    count: z.number().int().min(1).max(256).default(1).describe('how many'),
    player: z.string().optional().describe('who to give it to; default whoever asked'),
    max_minutes: z.number().min(1).max(30).default(10).describe('time for a search when it has to look for the source')
  }),
  longRunning: true,
  async run (ctx, p): Promise<ActionResult> {
    const { bot, signal } = ctx
    const t0 = Date.now()
    const who = askerOf(ctx, p.player)
    let item = p.item.toLowerCase().replace(/^minecraft:/, '').trim().replace(/\s+/g, '_')
    if (item === 'logs' || item === 'wood') item = 'log'
    if (item !== 'log' && item !== 'planks' && !bot.registry.itemsByName[item]) {
      const t = resolveTarget(p.item, registryNames(ctx.agent, bot))
      const alt = !isResolveError(t) ? t.item : undefined
      if (!alt || (alt !== 'log' && !bot.registry.itemsByName[alt])) return fail(`I don't know an item called ${p.item}`)
      item = alt
    }
    const say = reporter(ctx, who)
    const origin = floorPos(bot.entity.position)
    const match = matcher(item)
    const notes: string[] = []
    if (invCount(bot, match) < p.count) notes.push(...await obtain(ctx, item, p.count - invCount(bot, match), 0, say, p.max_minutes))
    const have = invCount(bot, match)
    const secs = `${Math.round((Date.now() - t0) / 1000)}s`
    const how = notes.filter(Boolean).join('; ')
    if (!have) return fail(`couldn't get any ${item}${how ? `: ${how}` : ''} (${secs})`)
    if (!who || who === bot.username) return ok(`have ${have} ${item}${how ? ` (${how})` : ''} (${secs})`)
    say(`got ${Math.min(have, p.count)} ${item}, bringing it`, true)
    // generic names (any log, any planks) hand over whatever kinds it holds, up to the count
    const give: Record<string, number> = {}
    let left = Math.min(have, p.count)
    for (const [k, v] of Object.entries(inventoryMap(bot))) { if (left > 0 && match(k)) { give[k] = Math.min(v, left); left -= give[k]! } }
    const d = await deliver(ctx, who, give, origin)
    const msg = `${d.message}${how ? `; ${how}` : ''} (${Math.round((Date.now() - t0) / 1000)}s)`
    checkAborted(signal)
    return d.ok && d.given >= p.count ? ok(msg, { given: d.given, pickedUp: d.pickedUp }) : fail(msg, { given: d.given, pickedUp: d.pickedUp })
  }
})

const fetchDrops = defineAction({
  name: 'fetch_drops',
  description: 'Go to where a player (default: whoever asked) died and bring their dropped items back, if the bot can get there before they despawn (5 minutes). ' +
    'Uses the death message and where it last saw them, or coordinates you give.',
  params: z.object({
    player: z.string().optional().describe('whose items; default whoever asked'),
    x: z.number().optional().describe('where they died (with y and z), if the bot did not see it'),
    y: z.number().optional(),
    z: z.number().optional(),
    try_anyway: z.boolean().default(false).describe('go even when the items have probably despawned (they only age while the area is loaded)')
  }),
  longRunning: true,
  async run (ctx, p): Promise<ActionResult> {
    const { bot, agent, signal } = ctx
    const t0 = Date.now()
    const who = askerOf(ctx, p.player)
    if (!who) return fail('whose items?')
    const death = recentDeaths(agent).find(d => d.player.toLowerCase() === who.toLowerCase() && Date.now() - d.at < 30 * 60_000)
    const given = p.x !== undefined && p.z !== undefined ? { x: Math.floor(p.x), y: Math.floor(p.y ?? bot.entity.position.y), z: Math.floor(p.z) } : null
    const at = given ?? death?.pos ?? null
    if (!at) return fail(death ? `I saw ${who} die (${death.message}) but not where; tell me the coordinates` : `I don't know where ${who} died; tell me x y z`)
    if (death?.dim && bot.game?.dimension && death.dim !== bot.game.dimension && !given) return fail(`${who} died in ${death.dim}`)
    const diedAt = death?.at ?? Date.now()
    const trip = dropsTrip({ diedAt, now: Date.now(), distance: dist(bot.entity.position, at) })
    if (!trip.go && !p.try_anyway) return fail(`${trip.why}; not going (try_anyway=true to go anyway: items only age while someone keeps the area loaded)`)
    const say = reporter(ctx, who)
    const origin = floorPos(bot.entity.position)
    say(`going for your things at ${fmtPos(at)}, ${trip.why}`, true)
    const before = inventoryMap(bot)
    try {
      await travel(bot, at, signal, { range: 3, onProgress: (i) => say(`${i.remaining} blocks to go`) })
    } catch (e) {
      checkAborted(signal)
      if (dist(bot.entity.position, at) > 12) return fail(`couldn't get to ${fmtPos(at)}: ${(e as Error).message}`)
    }
    for (let round = 0; round < 3; round++) {
      checkAborted(signal)
      const any = bot.nearestEntity(e => e.name === 'item' && e.position.distanceTo(bot.entity.position) <= 14)
      if (!any) break
      await pickupNearby(bot, signal, { radius: 14, maxMs: 20_000 })
    }
    const got = gained(before, inventoryMap(bot))
    const n = Object.values(got).reduce((a, b) => a + b, 0)
    const secs = () => `${Math.round((Date.now() - t0) / 1000)}s`
    if (!n) {
      await goToPlayer(ctx, who, origin).catch(e => { checkAborted(signal) })
      return fail(`nothing left at ${fmtPos(at)} (despawned, picked up, or kept on death) (${secs()})`)
    }
    say(`picked up ${n} items, coming back`, true)
    const d = await deliver(ctx, who, got, origin)
    const list = Object.entries(got).map(([k, v]) => `${v} ${k}`).join(', ')
    return d.given >= n ? ok(`brought back ${list} from ${fmtPos(at)}: ${d.message} (${secs()})`, { got, given: d.given }) : fail(`picked up ${list} at ${fmtPos(at)}; ${d.message} (${secs()})`, { got, given: d.given })
  }
})

export const search = () => defineSkill({
  name: 'search',
  description: 'Finding things (find_target) and fetching them for players (bring_item, fetch_drops) without an LLM.',
  actions: [findTarget, bringItem, fetchDrops],
  setup,
  observe: (agent) => {
    const found = Object.entries(getPlaces(agent)).filter(([k]) => k.startsWith('found:')).slice(0, 10)
    return found.length ? { found: Object.fromEntries(found.map(([k, v]) => [k.slice(6), fmtPos(v)])) } : {}
  }
})
