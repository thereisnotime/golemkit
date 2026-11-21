import type { Bot } from 'mineflayer'
import type { Block } from 'prismarine-block'
import type { Vec3 } from 'vec3'
import { defineSkill, defineAction, z, ok, fail, checkAborted, fmtPos, type ActionResult, type ActionContext } from '../core/index.ts'
import { reachBlock, within, placeAt, findItem, isReplaceable, digBlock, DigRefusedError } from './world.ts'
import { pickupNearby } from './pickup.ts'
import { ensureTool } from './toolkit.ts'

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

function findTree (bot: Bot, radius: number, skip: (p: Vec3) => boolean = () => false): Tree | null {
  const ids = Object.values(bot.registry.blocksByName).filter(b => woodType(b.name)).map(b => b.id)
  // Plenty of candidates: the nearest logs are often one tree, a wooden house or a protected spot.
  const candidates = bot.findBlocks({ matching: ids, maxDistance: radius, count: 256 })
  const tried = new Set<string>()
  for (const p of candidates) {
    if (skip(p)) continue
    const b = bot.blockAt(p)
    if (!b) continue
    const tree = scanTree(bot, b)
    if (!tree) continue
    const key = `${tree.base.x},${tree.base.y},${tree.base.z}`
    if (tried.has(key)) continue
    tried.add(key)
    return tree
  }
  return null
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
  let axeNote = ''
  if (makeAxe) {
    const axe = await ensureTool(bot, signal, 'axe', { cheapOnly: true }).catch(e => { checkAborted(signal); return fail((e as Error).message) })
    if (axe.ok && (axe.data as { crafted?: boolean } | undefined)?.crafted) axeNote = `crafted a ${(axe.data as { item: string }).item}, `
  }
  // Trees in areas where the server refuses breaking (spawn protection) are skipped; if a cut
  // gets refused anyway, the area is remembered and the next tree is tried.
  const skip = (p: Vec3) => agent.protectedAreas.isProtected(p)
  let tree = findTree(bot, radius, skip)
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
    return fail(zoneNear
      ? `no tree I'm allowed to cut within ${radius} blocks (trees near spawn are protected); try further away`
      : `no natural tree within ${radius} blocks`)
  }
  log.debug('felling tree', { wood: tree.wood, at: fmtPos(tree.base), logs: tree.logs.length })
  const soil = bot.blockAt(tree.base.offset(0, -1, 0))?.name ?? ''
  if (!logName) logName = `${tree.wood}_log`
  let cut = firstCut
  let skipped = 0
  for (const p of tree.logs) {
    checkAborted(signal)
    const b = bot.blockAt(p)
    if (!b || b.name !== logName) continue // already gone (fell with a neighbour or someone else cut it)
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
  if (!cut) return fail(`couldn't reach the ${tree.wood} tree at ${fmtPos(tree.base)}`)
  const picked = await pickupNearby(bot, signal, { radius: 10, maxMs: 20_000 })

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
  const left = skipped ? `, ${skipped} log${skipped === 1 ? '' : 's'} out of reach` : ''
  return ok(`${axeNote}chopped ${cut} ${logName}${left}, picked up ${picked} items${planted}`)
}

const chopTree = defineAction({
  name: 'chop_tree',
  description: 'Fell the nearest natural tree (any wood type): cut the logs it can reach, pick up the drops and plant a sapling. ' +
    'Crafts a wooden axe first if there is none and the inventory has the wood. Needs digging enabled. ' +
    'For "get N planks/logs" or materials for a build, prefer gather_materials, which chops as many trees as needed.',
  params: z.object({
    radius: z.number().min(4).max(64).default(32).describe('how far to look for a tree, in blocks'),
    replant: z.boolean().default(true).describe('plant a sapling of the same kind afterwards if the bot has one'),
    make_axe: z.boolean().default(true).describe('craft a wooden axe first when there is none and there is wood for it')
  }),
  aliases: ['chop'],
  run: (ctx, { radius, replant, make_axe }) => fellTree(ctx, { radius, replant, makeAxe: make_axe })
})

export const woodcutting = () => defineSkill({
  name: 'woodcutting',
  description: 'Felling trees.',
  actions: [chopTree]
})
