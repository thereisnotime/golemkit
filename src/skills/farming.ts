import type { Bot } from 'mineflayer'
import type { Block } from 'prismarine-block'
import type { Vec3 } from 'vec3'
import { defineSkill, defineAction, z, ok, fail, sleep, checkAborted, fmtPos, type ActionResult } from '../core/index.ts'
import { reachBlock, findItem, vec, isReplaceable, within, digBlock, DigRefusedError } from './world.ts'
import { pickupNearby } from './pickup.ts'

/** Crop block -> the age it is ripe at and the item that replants it. */
export const CROPS: Record<string, { ripe: number, seed: string }> = {
  wheat: { ripe: 7, seed: 'wheat_seeds' },
  carrots: { ripe: 7, seed: 'carrot' },
  potatoes: { ripe: 7, seed: 'potato' },
  beetroots: { ripe: 3, seed: 'beetroot_seeds' }
}

export const SEEDS: Record<string, string> = Object.fromEntries(Object.entries(CROPS).map(([crop, c]) => [c.seed, crop]))

/** True for a ripe crop. `age` comes from block properties, which prismarine-block gives as a string ('7'). */
export function isMature (blockName: string, age: unknown): boolean {
  const c = CROPS[blockName]
  const n = typeof age === 'string' && age !== '' ? Number(age) : age
  return !!c && typeof n === 'number' && Number.isFinite(n) && n >= c.ripe
}

export function seedFor (cropName: string): string | null {
  return CROPS[cropName]?.seed ?? null
}

/** Seeds in the inventory, preferring `want` if given. */
function pickSeed (bot: Bot, want?: string): string | null {
  if (want) return findItem(bot, want) ? want : null
  for (const s of Object.keys(SEEDS)) if (findItem(bot, s)) return s
  return null
}

function age (b: Block): unknown {
  return (b.getProperties() as Record<string, unknown>).age
}

/** Farmland with air above, nearest first. */
function emptyFarmland (bot: Bot, radius: number, count: number, point?: Vec3): Vec3[] {
  return bot.findBlocks({
    ...(point ? { point } : {}),
    matching: bot.registry.blocksByName.farmland.id,
    maxDistance: radius,
    count: count * 4,
    useExtraInfo: (b: Block) => isReplaceable(bot.blockAt(b.position.offset(0, 1, 0))?.name) && bot.blockAt(b.position.offset(0, 1, 0))?.name !== 'water'
  }).slice(0, count)
}

export async function plantOn (bot: Bot, farmland: Vec3, seed: string, signal: AbortSignal): Promise<boolean> {
  const it = findItem(bot, seed)
  if (!it) return false
  const soil = bot.blockAt(farmland)
  if (soil?.name !== 'farmland') return false
  await reachBlock(bot, farmland, signal)
  await bot.equip(it, 'hand')
  try {
    await bot.placeBlock(soil, vec(bot, 0, 1, 0))
  } catch {
    await sleep(200, signal)
  }
  return !!CROPS[bot.blockAt(farmland.offset(0, 1, 0))?.name ?? '']
}

const harvest = defineAction({
  name: 'harvest',
  description: 'Harvest ripe wheat, carrots, potatoes and beetroot nearby (or within a radius of x y z, e.g. one field), pick up the drops and replant from the inventory.',
  params: z.object({
    radius: z.number().min(1).max(32).default(16).describe('how far to look for crops, in blocks'),
    max: z.number().int().min(1).max(256).default(64).describe('stop after this many crops'),
    replant: z.boolean().default(true),
    x: z.number().optional().describe('centre of the field (with y and z); default where the bot stands'),
    y: z.number().optional(),
    z: z.number().optional()
  }),
  async run ({ bot, signal, log }, { radius, max, replant, x, y, z: cz }): Promise<ActionResult> {
    const ids = Object.keys(CROPS).map(n => bot.registry.blocksByName[n].id)
    const point = x !== undefined && y !== undefined && cz !== undefined ? vec(bot, x, y, cz) : undefined
    let harvested = 0
    let replanted = 0
    while (harvested < max) {
      checkAborted(signal)
      const found = bot.findBlock({ ...(point ? { point } : {}), matching: ids, maxDistance: radius, useExtraInfo: (b: Block) => isMature(b.name, age(b)) })
      if (!found) break
      const pos = found.position
      const crop = found.name
      try {
        await reachBlock(bot, pos, signal)
        await digBlock(bot, found, signal)
        harvested++
      } catch (e) {
        checkAborted(signal)
        if (e instanceof DigRefusedError && !harvested) return fail(e.message)
        log.debug('harvest failed', { crop, at: fmtPos(pos), error: (e as Error).message })
        break
      }
      if (replant) {
        await sleep(100, signal)
        const seed = seedFor(crop)
        if (seed && findItem(bot, seed) && await plantOn(bot, pos.offset(0, -1, 0), seed, signal).catch(() => false)) replanted++
      }
      // pick up every few crops so drops don't despawn or scatter
      if (harvested % 8 === 0) await pickupNearby(bot, signal, { radius: 6, maxMs: 8000 })
    }
    if (!harvested) return fail(`no ripe crops within ${radius} blocks${point ? ` of ${fmtPos(point)}` : ''}`)
    await pickupNearby(bot, signal, { radius: 8, maxMs: 15000 })
    // seeds may only have arrived with the pickup: fill whatever farmland we left bare
    if (replant) {
      for (const p of emptyFarmland(bot, Math.min(radius, 12), harvested - replanted, point)) {
        checkAborted(signal)
        const seed = pickSeed(bot)
        if (!seed) break
        if (await plantOn(bot, p, seed, signal).catch(() => false)) replanted++
      }
    }
    return ok(`harvested ${harvested} crops${replant ? `, replanted ${replanted}` : ''}`)
  }
})

const plant = defineAction({
  name: 'plant',
  description: 'Plant seeds (wheat_seeds, carrot, potato, beetroot_seeds) on empty farmland nearby.',
  params: z.object({
    seed: z.string().optional().describe('seed item; default whatever seeds the bot has'),
    count: z.number().int().min(1).max(256).default(64).describe('how many to plant at most'),
    radius: z.number().min(1).max(32).default(12),
    x: z.number().optional().describe('centre of the field (with y and z); default where the bot stands'),
    y: z.number().optional(),
    z: z.number().optional()
  }),
  async run ({ bot, signal }, { seed, count, radius, x, y, z: cz }): Promise<ActionResult> {
    if (seed && !SEEDS[seed]) return fail(`${seed} is not a seed I can plant`)
    if (!pickSeed(bot, seed)) return fail(seed ? `no ${seed}` : 'no seeds')
    const point = x !== undefined && y !== undefined && cz !== undefined ? vec(bot, x, y, cz) : undefined
    const spots = emptyFarmland(bot, radius, count, point)
    if (!spots.length) return fail(`no empty farmland within ${radius} blocks`)
    let planted = 0
    for (const p of spots) {
      checkAborted(signal)
      const s = pickSeed(bot, seed)
      if (!s) break
      if (await plantOn(bot, p, s, signal).catch(() => false)) planted++
    }
    return planted ? ok(`planted ${planted}`) : fail('could not plant anything')
  }
})

export const TILLABLE = ['dirt', 'grass_block', 'dirt_path', 'coarse_dirt', 'rooted_dirt']

const till = defineAction({
  name: 'till',
  description: 'Turn dirt or grass into farmland with a hoe, either at x y z or the nearest spots next to water. Needs digging enabled.',
  params: z.object({
    x: z.number().optional().describe('block to till; omit x/y/z to pick dirt near water'),
    y: z.number().optional(),
    z: z.number().optional(),
    count: z.number().int().min(1).max(64).default(1),
    radius: z.number().min(1).max(16).default(8)
  }),
  async run ({ bot, agent, signal }, p): Promise<ActionResult> {
    if (!agent.canDig) return fail('changing terrain is disabled for this bot')
    const hoe = bot.inventory.items().find(i => i.name.endsWith('_hoe'))
    if (!hoe) return fail('no hoe')
    const ids = TILLABLE.map(n => bot.registry.blocksByName[n]?.id).filter((n): n is number => n !== undefined)
    const freeAbove = (pos: Vec3) => bot.blockAt(pos.offset(0, 1, 0))?.name === 'air'
    let targets: Vec3[]
    if (p.x !== undefined && p.y !== undefined && p.z !== undefined) {
      const pos = vec(bot, p.x, p.y, p.z)
      const b = bot.blockAt(pos)
      if (!b || !TILLABLE.includes(b.name)) return fail(`can't till ${b?.name ?? 'that'}`)
      if (!freeAbove(pos)) return fail('something is on top of that block')
      targets = [pos]
    } else {
      const water = bot.registry.blocksByName.water.id
      targets = bot.findBlocks({
        matching: ids,
        maxDistance: p.radius,
        count: p.count * 8,
        useExtraInfo: (b: Block) => freeAbove(b.position) &&
          !!bot.findBlock({ point: b.position, matching: water, maxDistance: 4 })
      }).slice(0, p.count)
      if (!targets.length) return fail(`no dirt next to water within ${p.radius} blocks`)
    }
    let tilled = 0
    for (const pos of targets) {
      checkAborted(signal)
      await reachBlock(bot, pos, signal)
      if (!within(bot, pos)) continue
      await bot.equip(hoe, 'hand')
      const b = bot.blockAt(pos)
      if (!b) continue
      await bot.activateBlock(b, vec(bot, 0, 1, 0))
      await sleep(150, signal)
      if (bot.blockAt(pos)?.name === 'farmland') tilled++
    }
    return tilled ? ok(`tilled ${tilled} block${tilled === 1 ? '' : 's'}`) : fail('could not till anything')
  }
})

export const farming = () => defineSkill({
  name: 'farming',
  description: 'Harvesting, planting and tilling crops.',
  actions: [harvest, plant, till],
  observe: (_agent, bot) => {
    const ids = Object.keys(CROPS).map(n => bot.registry.blocksByName[n].id)
    const ripe = bot.findBlocks({ matching: ids, maxDistance: 16, count: 64, useExtraInfo: (b: Block) => isMature(b.name, age(b)) })
    return { ripeCropsNearby: ripe.length }
  }
})
