// Spawn-proofing: the light_up action surveys the standable spots around a point, plans torches
// so every spot a monster could spawn on gets light (pure planner in lightPlan.ts), makes the
// torches from coal or charcoal and puts them down. Torches it places are remembered as its own
// (`lighting.torches`), so it can tell them from the owner's; a remembered torch that is gone
// was taken away by someone, and the spot is left alone after that. It only places torches into
// air, on blocks that are already there: it never breaks or replaces anything. Around its own
// farms it keeps off the farmland (no trampling) and only counts the ground the field is on.
//
// Protected areas: the zones the bot learns (src/core/protection.ts) come from refused *breaks*,
// a 41-block box around one refusal, and a lag rollback while harvesting can put one over the
// bot's own farm. Placing is a different permission, so a learned zone doesn't stop torches by
// itself; once the server has refused two torches inside one (one can be lag), that zone is off
// limits for torches, as is every refused spot. The world spawn is always kept clear.
import type { Bot } from 'mineflayer'
import type { Block } from 'prismarine-block'
import { defineSkill, defineAction, z, ok, fail, fmtPos, goals, checkAborted, sleep, type Agent, type ActionResult } from '../core/index.ts'
import { vec, findItem, within, gotoWithin, isPlaceFace, REACH } from './world.ts'
import { craftItem, smeltItem } from './crafting.ts'
import { inventoryCounts } from './toolkit.ts'
import { spawnOf, getFarms, type Farm } from './food.ts'
import { getHome, getPlaces, sameDimension } from './navigation.ts'
import {
  planTorches, placingOrder, torchSupplyStep, surfaceCells, spotProblems, LIGHT_LEVELS, LIT_STATE,
  type LightCell, type LightSource, type Pos, type TorchSpot, type TorchPlan
} from './lightPlan.ts'

const OWN_KEY = 'lighting.torches'
const REMOVED_KEY = 'lighting.removed'
const REFUSED_KEY = 'lighting.refused'
const MAX_REMEMBERED = 2000

export interface OwnTorch extends Pos { dim?: string, at: number }

const k = (p: Pos) => `${p.x},${p.y},${p.z}`

/** Torches this bot placed (and that were still there when it last looked). */
export function ownTorches (agent: Pick<Agent, 'storage'>): OwnTorch[] {
  return agent.storage?.get<OwnTorch[]>(OWN_KEY, []) ?? []
}

function remember (agent: Agent, keyName: string, add: Pos[], dim?: string): void {
  if (!add.length) return
  const list = agent.storage.get<OwnTorch[]>(keyName, [])
  const have = new Set(list.map(k))
  const now = Date.now()
  for (const p of add) if (!have.has(k(p))) list.push({ x: p.x, y: p.y, z: p.z, ...(dim ? { dim } : {}), at: now })
  agent.storage.set(keyName, list.slice(-MAX_REMEMBERED))
}

const isTorchBlock = (n: string | undefined) => !!n && /(^|_)torch$|wall_torch$/.test(n) && !/redstone/.test(n)
const FLUID = /^(water|lava|bubble_column|seagrass|tall_seagrass|kelp|kelp_plant)$/
const PASSAGE = /_door$|fence_gate$|_trapdoor$/
/** Floors no monster spawns on even when they are full blocks. */
const NO_SPAWN_FLOOR = /glass$|leaves$|^(barrier|bedrock|ice|packed_ice|blue_ice|mangrove_roots|tinted_glass|beacon|magma_block)$/

function fullCube (b: Block | null): boolean {
  if (!b || b.boundingBox !== 'block') return false
  const s = (b as any).shapes as number[][] | undefined
  return !s || (s.length === 1 && s[0]!.join(',') === '0,0,0,1,1,1')
}

function passable (b: Block | null): boolean {
  if (!b || b.boundingBox !== 'empty') return false
  if (FLUID.test(b.name)) return false
  return (b.getProperties?.() as Record<string, unknown> | undefined)?.waterlogged !== true
}

function wet (b: Block | null): boolean {
  if (!b) return false
  return FLUID.test(b.name) || (b.getProperties?.() as Record<string, unknown> | undefined)?.waterlogged === true
}

const zoneKey = (z: Pos) => `${z.x},${z.y},${z.z}`

/** Learned protected zones (by key) holding at least two spots where the server refused a torch. */
export function zonesRefusingTorches (agent: Pick<Agent, 'protectedAreas'>, refused: readonly Pos[]): Set<string> {
  const n = new Map<string, number>()
  for (const r of refused) {
    const z = agent.protectedAreas?.zoneAt?.(r)
    if (z) n.set(zoneKey(z), (n.get(zoneKey(z)) ?? 0) + 1)
  }
  return new Set([...n].filter(([, c]) => c >= 2).map(([key]) => key))
}

/**
 * Whether a torch may not go at `p`: near the world spawn, or inside a learned protected zone
 * where the server already refused a torch.
 */
export function torchOffLimits (agent: Pick<Agent, 'protectedAreas'>, bot: Bot, p: Pos, spawnClearance: number, refusedZones: Set<string>): boolean {
  const spawn = spawnOf(bot)
  if (spawn && spawnClearance > 0 && Math.hypot(p.x - spawn.x, p.z - spawn.z) < spawnClearance) return true
  const zone = agent.protectedAreas?.zoneAt?.(p)
  return !!zone && refusedZones.has(zoneKey(zone))
}

/**
 * Keeps the pathfinder off farmland (and the crops on it) until the returned function is
 * called: walking there tramples nothing, but jumps and drops do, and paths across a field
 * jump. Torches around a farm are reached from the ring.
 */
function keepOffFarmland (bot: Bot): () => void {
  const m = (bot as any).pathfinder?.movements
  if (!m?.exclusionAreasStep) return () => {}
  const farmland = bot.registry.blocksByName.farmland?.id
  const noStep = (b: { position: { x: number, y: number, z: number } }) =>
    bot.blockAt(vec(bot, b.position.x, b.position.y - 1, b.position.z))?.type === farmland ? Infinity : 0
  m.exclusionAreasStep.push(noStep)
  return () => { m.exclusionAreasStep = m.exclusionAreasStep.filter((f: unknown) => f !== noStep) }
}

export interface Survey {
  cells: LightCell[]
  sources: LightSource[]
  /** Own torches that were found gone (and are now left alone). */
  gone: Pos[]
  /** Cells whose chunk isn't loaded. */
  unloaded: number
  /** Whether the chunks had light data (some cell with sky or block light above 0). */
  realLight: boolean
}

/**
 * Reads the standable cells within `radius` (flat) and `yRange` (up and down) of `centre`, the
 * light sources around it, and which of its own torches are gone.
 */
export function surveyLight (bot: Bot, agent: Agent, centre: Pos, radius: number, yRange: number, spawnClearance: number): Survey {
  const dim = bot.game?.dimension
  const own = ownTorches(agent).filter(t => !t.dim || !dim || t.dim === dim)
  const removed = new Set(agent.storage.get<Pos[]>(REMOVED_KEY, []).map(k))
  const refused = new Set(agent.storage.get<Pos[]>(REFUSED_KEY, []).map(k))
  const refusedZones = zonesRefusingTorches(agent, agent.storage.get<Pos[]>(REFUSED_KEY, []))
  const gone: Pos[] = []
  for (const t of own) {
    if (Math.hypot(t.x - centre.x, t.z - centre.z) > radius + 16) continue
    const b = bot.blockAt(vec(bot, t.x, t.y, t.z))
    if (b && !isTorchBlock(b.name)) gone.push(t)
  }
  if (gone.length) {
    const g = new Set(gone.map(k))
    agent.storage.set(OWN_KEY, ownTorches(agent).filter(t => !g.has(k(t))))
    remember(agent, REMOVED_KEY, gone, dim)
    for (const p of gone) removed.add(k(p))
  }

  const cells: LightCell[] = []
  let unloaded = 0
  let lightSeen = false
  const cx = Math.floor(centre.x), cy = Math.floor(centre.y), cz = Math.floor(centre.z)
  const at = (x: number, y: number, z: number) => bot.blockAt(vec(bot, x, y, z))
  for (let x = cx - radius; x <= cx + radius; x++) {
    for (let z = cz - radius; z <= cz + radius; z++) {
      if (Math.hypot(x - cx, z - cz) > radius) continue
      let above = at(x, cy + yRange + 1, z)
      let here = at(x, cy + yRange, z)
      if (!here) { unloaded++; continue }
      for (let y = cy + yRange; y >= cy - yRange; y--) {
        const below = at(x, y - 1, z)
        if (here && above && below && passable(here) && passable(above) && below.boundingBox === 'block' && !wet(below)) {
          const light = typeof (here as any).light === 'number' ? (here as any).light as number : null
          const sky = typeof (here as any).skyLight === 'number' ? (here as any).skyLight as number : null
          if ((sky ?? 0) > 0 || (light ?? 0) > 0) lightSeen = true
          const floorFull = fullCube(below)
          let wall: Pos | null = null
          for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            const w = at(x + dx, y, z + dz)
            if (fullCube(w) && isPlaceFace(w) && !/leaves$/.test(w!.name)) { wall = { x: x + dx, y, z: z + dz }; break }
          }
          let nearDoor = false
          for (let dx = -1; dx <= 1 && !nearDoor; dx++) {
            for (let dz = -1; dz <= 1 && !nearDoor; dz++) {
              for (let dy = -1; dy <= 1; dy++) if (PASSAGE.test(at(x + dx, y + dy, z + dz)?.name ?? '')) { nearDoor = true; break }
            }
          }
          const p = { x, y, z }
          cells.push({
            ...p,
            light,
            sky,
            spawnable: floorFull && !(below as any).transparent && !NO_SPAWN_FLOOR.test(below.name),
            block: here.name,
            floor: below.name,
            floorTorch: floorFull && isPlaceFace(below),
            wall,
            water: wet(here),
            nearDoor,
            offLimits: refused.has(k(p)) || torchOffLimits(agent, bot, p, spawnClearance, refusedZones),
            removed: removed.has(k(p))
          })
        }
        above = here
        here = below
        if (!here) break
      }
    }
  }
  if (!lightSeen) for (const c of cells) { c.light = null; c.sky = null }

  const sources: LightSource[] = []
  const ids = Object.keys(LIGHT_LEVELS).map(n => bot.registry.blocksByName[n]?.id).filter((x): x is number => x !== undefined)
  const found = bot.findBlocks({ point: vec(bot, cx, cy, cz), matching: ids, maxDistance: radius + 15, count: 4096 })
  for (const p of found) {
    const b = bot.blockAt(p)
    if (!b) continue
    const level = LIGHT_LEVELS[b.name] ?? 0
    if (LIT_STATE.test(b.name) && (b.getProperties?.() as Record<string, unknown> | undefined)?.lit !== true) continue
    if (level > 0) sources.push({ x: p.x, y: p.y, z: p.z, level })
  }
  return { cells, sources, gone, unloaded, realLight: lightSeen }
}

/**
 * Puts one torch at `spot` against its floor or wall. Null when it worked, else why not.
 */
async function placeTorch (bot: Bot, spot: TorchSpot, signal: AbortSignal): Promise<string | null> {
  const pos = vec(bot, spot.x, spot.y, spot.z)
  const target = bot.blockAt(pos)
  if (!target) return 'not loaded'
  if (isTorchBlock(target.name)) return null
  if (!/^(air|cave_air)$/.test(target.name)) return `${target.name} is there now`
  const ref = bot.blockAt(vec(bot, spot.against.x, spot.against.y, spot.against.z))
  if (!isPlaceFace(ref)) return 'the block to put it on is gone'
  if (!within(bot, pos, REACH - 0.3)) {
    const restore = keepOffFarmland(bot)
    try {
      await gotoWithin(bot, new goals.GoalNear(pos.x, pos.y, pos.z, 2), signal, 25_000)
    } catch (e) {
      checkAborted(signal)
      return `could not get there (${(e as Error).message})`
    } finally {
      restore()
    }
  }
  if (!within(bot, pos)) return 'could not get close enough'
  const torch = findItem(bot, 'torch')
  if (!torch) return 'out of torches'
  await bot.equip(torch, 'hand')
  checkAborted(signal)
  const face = pos.minus(ref.position)
  try {
    await bot.placeBlock(ref, face)
  } catch (e) {
    await sleep(300, signal)
    if (!isTorchBlock(bot.blockAt(pos)?.name)) return `the server didn't take it (${(e as Error).message})`
  }
  return isTorchBlock(bot.blockAt(pos)?.name) ? null : "the server didn't take it"
}

function blockNear (bot: Bot, name: string, range: number): boolean {
  const id = bot.registry.blocksByName[name]?.id
  return id !== undefined && !!bot.findBlock({ matching: id, maxDistance: range })
}

/** Craft and smelt until it has `want` torches or can't make more. Returns the torches in hand, or a failure. */
async function supplyTorches (bot: Bot, signal: AbortSignal, log: { debug: (m: string, f?: Record<string, unknown>) => void }, want: number): Promise<number | ActionResult> {
  let last = ''
  for (let i = 0; i < 12; i++) {
    checkAborted(signal)
    const step = torchSupplyStep(inventoryCounts(bot), want, { furnaceNear: blockNear(bot, 'furnace', 32), tableNear: blockNear(bot, 'crafting_table', 16) })
    if (step.do === 'ready') return step.torches
    if (step.do === 'stuck') return fail(step.why, { need: step.need })
    const sig = `${step.do} ${step.item} ${step.count}`
    if (sig === last) return fail(`could not ${step.do} ${step.item} (${step.why})`)
    last = sig
    log.debug(`light_up: ${step.why}`, { do: step.do, item: step.item, count: step.count })
    const r = step.do === 'craft' ? await craftItem(bot, signal, step.item, step.count) : await smeltItem(bot, signal, log, step.item, step.count)
    if (!r.ok) {
      const have = inventoryCounts(bot).torch ?? 0
      if (have > 0) return have
      return fail(`${step.why}: ${r.message}`)
    }
  }
  return inventoryCounts(bot).torch ?? 0
}

/** The bot's own farm centred on `c` (light_home passes the farm's x/z), or named `place`. */
function farmAt (agent: Agent, c: Pos, place?: string): Farm | undefined {
  return getFarms(agent).find(f => place ? f.name === place.toLowerCase() : f.x === c.x && f.z === c.z)
}

/** Centre from a place name ("home", "farm:1"), coordinates, or where the bot stands. */
function centreFor (agent: Agent, bot: Bot, p: { place?: string, x?: number, y?: number, z?: number }): Pos | string {
  if (p.place) {
    const name = p.place.toLowerCase()
    const place = name === 'home' ? getHome(agent) : getPlaces(agent)[name]
    const farm = place ? undefined : getFarms(agent).find(f => f.name === name)
    if (farm) {
      if (farm.dim && bot.game?.dimension && farm.dim !== bot.game.dimension) return `${p.place} is in ${farm.dim}`
      return { x: Math.floor(farm.x), y: Math.floor(farm.y) + 1, z: Math.floor(farm.z) }
    }
    if (!place) return `I don't know a place called ${p.place}`
    if (!sameDimension(bot, place)) return `${p.place} is in ${place.dimension}`
    return { x: Math.floor(place.x), y: Math.floor(place.y), z: Math.floor(place.z) }
  }
  const me = bot.entity.position.floored()
  return { x: p.x !== undefined ? Math.floor(p.x) : me.x, y: p.y !== undefined ? Math.floor(p.y) : me.y, z: p.z !== undefined ? Math.floor(p.z) : me.z }
}

const lightUp = defineAction({
  name: 'light_up',
  capabilities: ['place', 'craft'],
  description: 'Spawn-proofs an area: finds the spots around a place (home, farm:1, coordinates, or here) where hostile mobs could spawn ' +
    '(block light below `target`; 1.21.1 monsters need light 0), works out the fewest torches that light them all, crafts torches from coal ' +
    'or charcoal (smelts charcoal from logs when out of coal) and places them: floor torches, wall torches where there is no floor; never on ' +
    'farmland, crops, paths, in front of doors, in water, near the world spawn or where the server refused a torch, and never breaking anything. ' +
    'Around its own farms it stays off the field and counts only the ground the field is on. Remembers its own torches. dry_run only reports.',
  params: z.object({
    place: z.string().optional().describe('remembered place to light up, e.g. home or farm:1; default x/y/z or where it stands'),
    x: z.number().optional(),
    y: z.number().optional(),
    z: z.number().optional(),
    radius: z.number().int().min(2).max(48).default(16).describe('flat radius around the centre'),
    y_range: z.number().int().min(1).max(16).default(6).describe('blocks above and below the centre to look at'),
    target: z.number().int().min(1).max(15).default(8).describe('light every spawnable spot to at least this (1 stops spawns; higher leaves a margin)'),
    max_torches: z.number().int().min(1).max(64).default(16).describe('torches to place at most this time'),
    craft: z.boolean().default(true).describe('craft torches (and smelt charcoal) when it has too few'),
    spawn_clearance: z.number().min(0).max(256).default(24).describe('never place within this distance of the world spawn'),
    surface: z.boolean().optional().describe('only the ground connected to the centre\'s level, no caves under it; default on around its own farms'),
    dry_run: z.boolean().default(false).describe('only report the dark spots and the planned torches')
  }),
  async run ({ bot, agent, signal, log }, p) {
    const centre = centreFor(agent, bot, p)
    if (typeof centre === 'string') return fail(centre)
    // around its own farm: the centre is the water, so stop on the ring, keep off the field and
    // look at the ground the field is on (not caves under it)
    const farm = farmAt(agent, centre, p.place)
    if (farm) centre.y = Math.max(centre.y, farm.y + 1)
    const surface = p.surface ?? !!farm
    if (Math.hypot(bot.entity.position.x - centre.x, bot.entity.position.z - centre.z) > 32) {
      const restore = farm ? keepOffFarmland(bot) : () => {}
      try {
        await gotoWithin(bot, new goals.GoalNear(centre.x, centre.y, centre.z, farm ? Math.ceil(farm.size / 2) + 1 : 3), signal, 90_000)
      } catch (e) {
        checkAborted(signal)
        return fail(`could not get to ${fmtPos(centre)} (${(e as Error).message})`)
      } finally {
        restore()
      }
    }
    const survey = surveyLight(bot, agent, centre, p.radius, p.y_range, p.spawn_clearance)
    const cells = surface ? surfaceCells(survey.cells, centre) : survey.cells
    const plan: TorchPlan = planTorches(cells, survey.sources, { target: p.target, maxTorches: p.max_torches })
    const where = p.place ?? fmtPos(centre)
    const summary = `${plan.spawnable} spawnable spots within ${p.radius} of ${where}, ${plan.dark} below light ${p.target}`
    const info = {
      centre, surface, dark: plan.dark, left: plan.left, spawnable: plan.spawnable, unloaded: survey.unloaded, realLight: survey.realLight,
      gone: survey.gone.length, torches: plan.torches.map(t => ({ x: t.x, y: t.y, z: t.z, kind: t.kind }))
    }
    if (survey.gone.length) log.info(`light_up: ${survey.gone.length} of its torches were taken away; leaving those spots alone`)
    if (!plan.dark) return ok(`${summary}: nothing to light`, { ...info, placed: [] })
    if (!plan.torches.length) {
      const why = spotProblems(cells)
      return ok(`${summary}, and no spot for a torch reaches them${why ? ` (${why})` : ''}`, { ...info, placed: [] })
    }
    if (p.dry_run) return ok(`${summary}; ${plan.torches.length} torches would fix ${plan.dark - plan.left}: ${plan.torches.map(t => `${t.x} ${t.y} ${t.z}${t.kind === 'wall' ? ' (wall)' : ''}`).join(', ')}`, { ...info, placed: [] })

    let have = inventoryCounts(bot).torch ?? 0
    if (have < plan.torches.length && p.craft) {
      const got = await supplyTorches(bot, signal, log, plan.torches.length)
      if (typeof got !== 'number') return { ...got, data: { ...info, ...(got.data as object | undefined), placed: [] } }
      have = got
    }
    if (!have) return fail('no torches, and no coal or charcoal to make them', { ...info, need: 'coal', placed: [] })

    const placed: Pos[] = []
    const failed: string[] = []
    const refused: Pos[] = []
    for (const spot of placingOrder(plan.torches, bot.entity.position.floored())) {
      checkAborted(signal)
      if (!findItem(bot, 'torch')) break
      const why = await placeTorch(bot, spot, signal)
      if (!why) { placed.push({ x: spot.x, y: spot.y, z: spot.z }); continue }
      failed.push(`${fmtPos(spot)}: ${why}`)
      if (/didn't take it/.test(why)) refused.push(spot)
      if (failed.length >= 5 && failed.length > placed.length) break
    }
    remember(agent, OWN_KEY, placed, bot.game?.dimension)
    remember(agent, REFUSED_KEY, refused)
    const short = plan.torches.length - placed.length
    const msg = `${summary}; placed ${placed.length} torch${placed.length === 1 ? '' : 'es'}` +
      (short > 0 ? `, ${short} not placed${failed.length ? ` (${failed.slice(0, 2).join('; ')})` : ' (out of torches)'}` : '') +
      (plan.left ? `; ${plan.left} spots still dark (max ${p.max_torches} a run, or no spot reaches them)` : '')
    if (!placed.length) return fail(msg, { ...info, placed })
    return ok(msg, { ...info, placed })
  }
})

export const lighting = () => defineSkill({
  name: 'lighting',
  capabilities: ['place'],
  description: 'Spawn-proofing with torches.',
  actions: [lightUp]
})
