// start_over: leave a bad base behind and start again somewhere better (docs/guide/start-over.md).
// The owner says "start over" (or settings.startOver.go fires it once on start): the bot packs the
// most precious things from its chests near home, walks off in one direction by day (digging in
// at night), and settles at the first place far enough away with grass, trees, water and animals
// that isn't snowy, protected or built on. Home, bed and a chest go there; the old base anchor,
// farms and home places are dropped so its usual behaviours build fresh around the new home.
//
// The decisions are pure in startOverPlan.ts. The state lives in storage (startOver) so a restart
// or a death picks it up where it was; the start_over behaviour (adapter behaviors/startOver.ts)
// runs the steps through these actions.
import type { Bot } from 'mineflayer'
import type { Block } from 'prismarine-block'
import {
  defineSkill, defineAction, z, ok, fail, fmtPos, travel, checkAborted, itemName, surfaceY,
  type Agent, type ActionResult
} from '../core/index.ts'
import {
  startOverSettings, packPlan, siteVerdict, abandonedState, angleCompass, inAvoided, pointAt, wetTop,
  type StartOverSettings, type StartOverState, type SiteFacts, type AvoidPoint, type Pos
} from './startOverPlan.ts'
import { chestView, chestTotals, takeItemsFromOwnChests, fmtTally } from './containers.ts'
import { foodPoints } from './trip.ts'
import { getHome, setHome, findStandable, type Place } from './navigation.ts'
import { surfaceWater, surfaceAt, offLimits, spawnOf, freezes, BUILD } from './food.ts'
import { ownBedsNear } from './bed.ts'
import { vec, reachBlock, digBlock } from './world.ts'
import { pickupNearby } from './pickup.ts'
import { LOGS, ANIMALS } from './searchPlan.ts'

export const START_OVER_KEY = 'startOver'
/** Set while it has no home on purpose (travelling): the NPC controller doesn't put home where it stands. */
export const HOME_AWAY_KEY = 'home.away'

/** settings.startOver for this bot. */
export function startOverConfig (agent: Agent): StartOverSettings {
  return startOverSettings((agent.settings as { startOver?: unknown } | undefined)?.startOver)
}

export function startOverState (agent: Agent): StartOverState | null {
  return agent.storage.get<StartOverState | null>(START_OVER_KEY, null) ?? null
}

export function saveStartOver (agent: Agent, st: StartOverState): void {
  agent.storage.set(START_OVER_KEY, st)
}

/** A start-over is under way (packing, travelling or settling). */
export function startingOver (agent: Agent): boolean {
  const st = startOverState(agent)
  return !!st && (st.phase === 'packing' || st.phase === 'travelling' || st.phase === 'settling')
}

/** Log line and journal event for a step. */
export function noteStartOver (agent: Agent, bot: Bot | null, step: string, text: string, data: Record<string, unknown> = {}): void {
  agent.log.child('start_over').info(`start_over: ${text}`)
  try {
    const p = bot?.entity?.position
    agent.journal?.record('start_over', { step, text, ...data }, { ...(p ? { pos: { x: p.x, y: p.y, z: p.z } } : {}), ...(bot?.game?.dimension ? { dim: bot.game.dimension } : {}) })
  } catch {}
}

/** The places to keep away from: world spawn (spawnRadius) and settings.startOver.avoid. */
export function avoidPoints (bot: Bot, s: StartOverSettings): AvoidPoint[] {
  const out: AvoidPoint[] = []
  const sp = spawnOf(bot)
  if (sp && s.spawnRadius > 0) out.push({ x: sp.x, z: sp.z, radius: s.spawnRadius, name: 'spawn' })
  return [...out, ...s.avoid]
}

/** Starts a start-over (state packing at home, or where it stands). Returns false when one is already under way. */
export function beginStartOver (agent: Agent, bot: Bot, by: string, direction?: string, run?: string): boolean {
  if (startingOver(agent)) return false
  const home = getHome(agent)
  const p = bot.entity.position
  const origin = home ?? { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), dimension: bot.game?.dimension }
  const st: StartOverState = { phase: 'packing', startedAt: Date.now(), by, origin: { x: origin.x, y: origin.y, z: origin.z, ...(origin.dimension ? { dim: origin.dimension } : {}) } }
  if (direction) st.direction = direction
  if (run) st.run = run
  saveStartOver(agent, st)
  noteStartOver(agent, bot, 'start', `starting over (asked by ${by}), old base at ${fmtPos(origin)}`, { by, origin: st.origin })
  return true
}

/** Drops the old base from storage (abandonedState) and keeps it as the place old_base. */
export function abandonOldBase (agent: Agent, origin: StartOverState['origin']): string[] {
  const r = abandonedState(k => agent.storage.get(k), origin, startOverConfig(agent).oldBaseRadius)
  for (const k of r.del) agent.storage.delete(k)
  for (const [k, v] of Object.entries(r.set)) agent.storage.set(k, v)
  agent.storage.set(HOME_AWAY_KEY, 'starting over')
  return r.del
}

// ------------------------------------------------------------------ looking at a place

const GRASS_PLANTS = /^(short_grass|grass|tall_grass|fern)$/

function blockIds (bot: Bot, names: readonly string[]): number[] {
  return names.map(n => bot.registry.blocksByName[n]?.id).filter((x): x is number => x !== undefined)
}

export type LookSettings = Pick<StartOverSettings, 'lookRadius' | 'waterRadius' | 'animalRadius' | 'treeDepth' | 'iceAsWater' | 'caps' | 'minGrass' | 'minLogs' | 'minWater'>

/** What the place around the bot looks like for settling (SiteFacts), within the look radii of the settings. */
export function lookAround (agent: Agent, bot: Bot, s: LookSettings): SiteFacts {
  const radius = s.lookRadius
  const here = bot.entity.position.floored()
  const ground = bot.blockAt(here.offset(0, -1, 0)) as (Block & { biome?: { name?: string } }) | null
  // a server-synced registry (NeoForge) keeps biome names only as keys of biomesByName
  const byName = (bot.registry as { biomesByName?: Record<string, unknown> }).biomesByName ?? {}
  const raw = ground?.biome as ({ name?: string, id?: number } | undefined)
  const biome = raw?.name || (raw ? Object.keys(byName).find(k => byName[k] === raw || (byName[k] as { id?: number } | undefined)?.id === raw.id && raw.id !== undefined) : undefined)?.replace(/^minecraft:/, '') || null
  const cold = freezes(bot, { x: here.x, y: here.y, z: here.z })
  const surface = (p: { x: number, y: number, z: number }, depth: number) => { const sy = surfaceY(bot, p.x, p.z); return sy === null || sy - p.y <= depth }
  const grassId = bot.registry.blocksByName.grass_block?.id
  const grass = grassId === undefined ? 0 : bot.findBlocks({
    matching: grassId, maxDistance: radius, count: Math.max(s.caps.grass, s.minGrass),
    useExtraInfo: (b: Block) => { const up = bot.blockAt(b.position.offset(0, 1, 0)); return !!up && (up.name === 'air' || GRASS_PLANTS.test(up.name)) }
  }).length
  // logs under the surface are a mineshaft or a cave, not trees
  const logs = bot.findBlocks({ matching: blockIds(bot, LOGS), maxDistance: radius, count: Math.max(s.caps.logs, s.minLogs) * 2 }).filter(p => surface(p, s.treeDepth)).length
  const waterCount = Math.max(s.caps.water, s.minWater)
  let water = surfaceWater(bot, here, s.waterRadius, waterCount * 3).filter(w => !freezes(bot, w)).length
  // iceAsWater: frozen water counts too (the cold-farm code breaks the ice and keeps a farm's water open)
  if (s.iceAsWater) {
    const ice = blockIds(bot, ['ice'])
    if (ice.length) water += bot.findBlocks({ matching: ice, maxDistance: s.waterRadius, count: waterCount, useExtraInfo: (b: Block) => bot.blockAt(b.position.offset(0, 1, 0))?.name === 'air' }).length
  }
  const animals = Object.values(bot.entities ?? {}).filter(e => e?.position && ANIMALS.includes(e.name ?? '') && e.position.distanceTo(bot.entity.position) <= s.animalRadius).length
  const buildNames = Object.keys(bot.registry.blocksByName).filter(n => BUILD.test(n))
  const buildBlocks = bot.findBlocks({ matching: blockIds(bot, buildNames), maxDistance: radius + 16, count: 64 }).filter(p => surface(p, 3)).length
  return { biome, cold, grass, logs, water, animals, buildBlocks, protected: offLimits(agent, bot, here, 0) }
}

/**
 * Whether a leg from the bot at `deg` ends (or passes half way and three quarters) over water or ice:
 * true water, false land, null not loaded. For dryLegHeading.
 */
export function legWet (bot: Bot, deg: number, length: number): boolean | null {
  const p = bot.entity.position
  let seen = false
  for (const f of [0.5, 0.75, 1]) {
    const q = pointAt({ x: p.x, z: p.z }, deg, length * f)
    const top = surfaceAt(bot, q.x, Math.floor(p.y), q.z)
    if (!top) continue
    seen = true
    if (wetTop(top.name)) return true
  }
  return seen ? false : null
}

/** Short text of the facts for logs. */
export function factsText (f: SiteFacts): string {
  return `${f.biome?.replace(/_/g, ' ') ?? 'unknown biome'}${f.cold ? ' (cold)' : ''}: grass ${f.grass}, logs ${f.logs}, water ${f.water}, animals ${f.animals}, build blocks ${f.buildBlocks}${f.protected ? ', protected' : ''}`
}

// ------------------------------------------------------------------ actions

/** The free inventory slots (main inventory, 36). */
function freeSlots (bot: Bot): number {
  const n = (bot.inventory as { emptySlotCount?: () => number }).emptySlotCount?.()
  return typeof n === 'number' ? n : Math.max(0, 36 - bot.inventory.items().length)
}

function inventoryTally (bot: Bot): Record<string, number> {
  const t: Record<string, number> = {}
  for (const i of bot.inventory.items()) t[itemName(i)] = (t[itemName(i)] ?? 0) + i.count
  return t
}

function stackSize (bot: Bot): (name: string) => number {
  return n => (bot.registry.itemsByName[n] as { stackSize?: number } | undefined)?.stackSize ?? 64
}

const startOverAction = defineAction({
  name: 'start_over',
  exclusive: false,
  description: 'Leave this base behind and start over somewhere better: pack the most precious things from my chests near home ' +
    '(iron and diamond gear, ores and ingots, the best weapon, armour, shield and bow, arrows, food, seeds, the bed, torches, a stack of logs, some cobblestone), ' +
    'walk off in one direction by day (500+ blocks, digging in at night) to a place with grass, trees, water and animals that is not snowy, protected or built on, ' +
    'then set home there with a bed and a chest and build up from scratch. cancel stops it; status says how far it got.',
  params: z.object({
    cancel: z.boolean().default(false).describe('stop a start-over under way (it stays where it is)'),
    status: z.boolean().default(false).describe('only say how far it got'),
    direction: z.enum(['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']).optional().describe('which way to go (default: away from spawn and the avoid points)')
  }),
  run ({ agent, bot: client, caller, player }, p): ActionResult {
    const bot = client as Bot
    const st = startOverState(agent)
    if (p.status) return ok(st ? startOverText(st) : 'not starting over')
    if (p.cancel) {
      if (!st || !startingOver(agent)) return fail('not starting over')
      saveStartOver(agent, { ...st, phase: 'failed', doneAt: Date.now(), note: `cancelled by ${player ?? caller.name}` })
      agent.storage.delete(HOME_AWAY_KEY)
      if (!getHome(agent)) { const q = bot.entity.position.floored(); setHome(agent, { x: q.x, y: q.y, z: q.z, dimension: bot.game?.dimension }) }
      noteStartOver(agent, bot, 'cancel', `cancelled by ${player ?? caller.name}`)
      return ok(`stopped starting over (${st.phase})${getHome(agent) ? `; home is ${fmtPos(getHome(agent)!)}` : ''}`)
    }
    if (!beginStartOver(agent, bot, player ?? caller.name, p.direction)) return fail(`already starting over: ${st ? startOverText(st) : ''}`)
    return ok('starting over: packing the best things from my chests first, then off to find a better place')
  }
})

/** "travelling ne, 640 blocks from the old base, 7 legs" style status. */
export function startOverText (st: StartOverState): string {
  switch (st.phase) {
    case 'packing': return 'packing at the old base'
    case 'travelling': return `travelling ${st.heading !== undefined ? angleCompass(st.heading) : ''}, ${Math.round(st.farthest ?? 0)} blocks from the old base so far, ${st.legs ?? 0} legs${st.best ? `; best so far ${fmtPos(st.best)} (${st.best.why})` : ''}`
    case 'settling': return `settling at ${st.target ? fmtPos(st.target) : '?'}`
    case 'settled': return `settled at ${st.target ? fmtPos(st.target) : '?'}${st.note ? ` (${st.note})` : ''}`
    case 'failed': return `stopped: ${st.note ?? 'unknown'}`
  }
}

const packAction = defineAction({
  name: 'start_over_pack',
  internal: true,
  capabilities: ['containers', 'move'],
  description: 'Packs for a start-over: its own bed by home comes along, then the most precious things from its chests near home (startOverPlan.packPlan) up to the inventory space.',
  params: z.object({ radius: z.number().int().min(8).max(128).optional().describe('chests within this many blocks of home (default startOver.packRadius)') }),
  async run ({ agent, bot: client, signal, log }, p): Promise<ActionResult> {
    const bot = client as Bot
    const s = startOverConfig(agent)
    const notes: string[] = []
    // its own bed by home comes along (the respawn point moves with it)
    const home = getHome(agent)
    const carriesBed = bot.inventory.items().some(i => /_bed$/.test(itemName(i)))
    if (home && !carriesBed && !s.leave.some(n => /bed/.test(n))) {
      for (const b of ownBedsNear(agent, bot, home, 8)) {
        checkAborted(signal)
        const pos = vec(bot, b.pos.x, b.pos.y, b.pos.z)
        try {
          await reachBlock(bot, pos, signal, 3, 20_000)
          const block = bot.blockAt(pos)
          if (block && /_bed$/.test(block.name)) {
            await digBlock(bot, block, signal, 600)
            await pickupNearby(bot, signal, { radius: 6, maxMs: 6000 })
            const got = bot.inventory.items().some(i => /_bed$/.test(itemName(i)))
            notes.push(got ? `took my bed from ${fmtPos(b.pos)}` : `broke my bed at ${fmtPos(b.pos)} but didn't get it back`)
          }
        } catch (e) { checkAborted(signal); notes.push(`bed at ${fmtPos(b.pos)}: ${(e as Error).message}`) }
        break
      }
    }
    const chests = chestView(agent, bot, p.radius ?? s.packRadius)
    const totals = chestTotals(chests).has
    const picks = packPlan({ chests: totals, inventory: inventoryTally(bot), freeSlots: freeSlots(bot), stackSize: stackSize(bot), foodPoints: n => foodPoints(bot, n), take: s.take, leave: s.leave, keepFree: s.freeSlots })
    if (!picks.length) return ok(`nothing worth packing in ${chests.length} chests${notes.length ? `; ${notes.join('; ')}` : ''}`, { took: {} })
    log.info(`start_over: packing ${picks.map(x => `${x.count} ${x.name}`).join(', ')}`)
    const left: Record<string, number> = Object.fromEntries(picks.map(x => [x.name, x.count]))
    const took: Record<string, number> = {}
    for (const c of chests) {
      checkAborted(signal)
      if (!c.contents) continue
      const part: Record<string, number> = {}
      for (const [k, n] of Object.entries(left)) { const t = Math.min(n, c.contents[k] ?? 0); if (t > 0) part[k] = t }
      if (!Object.keys(part).length) continue
      const r = await takeItemsFromOwnChests({ bot, agent, signal }, part, 256, {}, [c])
      for (const [k, n] of Object.entries(r.took)) { took[k] = (took[k] ?? 0) + n; left[k] = (left[k] ?? 0) - n }
      notes.push(...r.notes)
      if (freeSlots(bot) <= s.freeSlots) break
    }
    return ok(`packed ${fmtTally(took)}${notes.length ? `; ${notes.slice(0, 4).join('; ')}` : ''}`, { took })
  }
})

const legAction = defineAction({
  name: 'start_over_leg',
  internal: true,
  capabilities: ['move'],
  description: 'Walks one leg of a start-over towards x z (travel, avoiding water), giving up after `minutes`.',
  params: z.object({ x: z.number(), z: z.number(), minutes: z.number().min(0.5).max(30).default(4) }),
  async run ({ bot: client, signal }, p): Promise<ActionResult> {
    const bot = client as Bot
    const from = bot.entity.position.clone()
    const timer = AbortSignal.timeout(p.minutes * 60_000)
    try {
      await travel(bot, { x: p.x, z: p.z }, AbortSignal.any([signal, timer]), { range: 8, avoidWater: true })
    } catch (e) {
      checkAborted(signal)
      const moved = Math.hypot(bot.entity.position.x - from.x, bot.entity.position.z - from.z)
      return fail(`${timer.aborted ? 'leg took too long' : (e as Error).message} (moved ${Math.round(moved)} blocks, at ${fmtPos(bot.entity.position)})`, { moved })
    }
    const moved = Math.hypot(bot.entity.position.x - from.x, bot.entity.position.z - from.z)
    return ok(`walked ${Math.round(moved)} blocks to ${fmtPos(bot.entity.position)}`, { moved })
  }
})

const settleAction = defineAction({
  name: 'start_over_settle',
  internal: true,
  capabilities: ['move'],
  description: 'Sets home for a start-over at x y z (walking there first): a standable spot on the ground.',
  params: z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() }),
  async run ({ agent, bot: client, signal }, p): Promise<ActionResult> {
    const bot = client as Bot
    if (Math.hypot(bot.entity.position.x - p.x, bot.entity.position.z - p.z) > 6) {
      try { await travel(bot, p, signal, { range: 3 }) } catch (e) { checkAborted(signal); return fail(`couldn't get to ${fmtPos(p)}: ${(e as Error).message}`) }
    }
    const q = bot.entity.position.floored()
    const spot: Place = findStandable(bot, q.x, q.y, q.z, 3, true) ?? { x: q.x, y: q.y, z: q.z }
    const home = { x: spot.x, y: spot.y, z: spot.z, dimension: bot.game?.dimension }
    setHome(agent, home)
    agent.storage.delete(HOME_AWAY_KEY)
    return ok(`home is now ${fmtPos(home)}`, home)
  }
})

/** Whether `p` is inside an avoided area (spawn, settings.startOver.avoid). */
export function avoidedAt (bot: Bot, s: StartOverSettings, p: { x: number, z: number }): boolean {
  return !!inAvoided(p, avoidPoints(bot, s))
}

export type { Pos }

export const startOver = () => defineSkill({
  name: 'start_over',
  description: 'Starting over somewhere better: pack the best things, walk off, settle with home, bed and chest.',
  actions: [startOverAction, packAction, legAction, settleAction]
})
