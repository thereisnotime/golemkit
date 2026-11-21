import type { Bot } from 'mineflayer'
import type { Block } from 'prismarine-block'
import type { Item } from 'prismarine-item'
import { defineSkill, defineAction, z, ok, fail, goals, fmtPos, itemName, checkAborted, sleep, type Agent, type ActionResult } from '../core/index.ts'
import { vec, reachBlock, within, gotoWithin } from './world.ts'

const SEARCH = 32
const SETTLE_MS = 150
export const CONTAINER_RE = /^(chest|trapped_chest|barrel|.*shulker_box)$/

const TOOL_RE = /(_pickaxe|_axe|_shovel|_hoe|_sword|_helmet|_chestplate|_leggings|_boots)$|^(shears|bow|crossbow|trident|shield|fishing_rod|flint_and_steel|mace|elytra|totem_of_undying)$/

export function isToolOrArmor (name: string): boolean {
  return TOOL_RE.test(name)
}

/**
 * Which inventory items a deposit moves. item="all" moves everything except tools, armour,
 * food (when keepEssentials) and anything named in keep.
 */
export function selectDeposits<T extends { name: string }> (items: T[], opts: { item: string, keep?: string[], keepEssentials?: boolean, isFood?: (name: string) => boolean }): T[] {
  const keep = new Set(opts.keep ?? [])
  return items.filter(i => {
    if (keep.has(i.name)) return false
    if (opts.item !== 'all') return i.name === opts.item
    if (opts.keepEssentials === false) return true
    return !isToolOrArmor(i.name) && !opts.isFood?.(i.name)
  })
}

/** Summarises a list of items as {name: count}. */
export function tally (items: { name: string, count: number }[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const i of items) out[i.name] = (out[i.name] ?? 0) + i.count
  return out
}

export function fmtTally (t: Record<string, number>): string {
  const e = Object.entries(t)
  return e.length ? e.map(([n, c]) => `${c}x ${n}`).join(', ') : 'empty'
}

// What the bot saw inside containers, per agent, keyed by position. In memory only.
const seen = new WeakMap<Agent, Map<string, { block: string, contents: Record<string, number>, at: number }>>()

function remember (agent: Agent, block: Block, items: Item[]): Record<string, number> {
  const contents = tally(items.map(i => ({ name: itemName(i), count: i.count })))
  let m = seen.get(agent)
  if (!m) { m = new Map(); seen.set(agent, m) }
  m.set(fmtPos(block.position), { block: block.name, contents, at: Date.now() })
  return contents
}

/** Containers the bot has looked into this run, with what it saw (newest first). */
export function knownContainers (agent: Agent): { x: number, y: number, z: number, block: string, contents: Record<string, number>, at: number }[] {
  const m = seen.get(agent)
  if (!m) return []
  return [...m.entries()].map(([pos, v]) => {
    const [x, y, z] = pos.split(' ').map(Number) as [number, number, number]
    return { x, y, z, ...v }
  }).sort((a, b) => b.at - a.at)
}

function findContainer (bot: Bot, at?: { x?: number, y?: number, z?: number }): Block | string {
  if (at && at.x !== undefined && at.y !== undefined && at.z !== undefined) {
    const b = bot.blockAt(vec(bot, at.x, at.y, at.z))
    if (!b) return `${at.x} ${at.y} ${at.z} is not loaded`
    if (!CONTAINER_RE.test(b.name)) return `no container at ${at.x} ${at.y} ${at.z} (found ${b.name})`
    return b
  }
  const ids = Object.values(bot.registry.blocksByName).filter(b => CONTAINER_RE.test(b.name)).map(b => b.id)
  return bot.findBlock({ matching: ids, maxDistance: SEARCH }) ?? `no chest or barrel within ${SEARCH} blocks`
}

/**
 * Walks into reach and opens the container. If the server doesn't answer (seen when the bot
 * stands where it can't see the front of the chest), steps to a spot with line of sight and
 * tries once more.
 */
async function openAt (bot: Bot, block: Block, signal: AbortSignal) {
  await reachBlock(bot, block.position, signal)
  try {
    return await bot.openContainer(block)
  } catch (e) {
    checkAborted(signal)
    await gotoWithin(bot, new goals.GoalLookAtBlock(block.position, bot.world, { reach: 3 }), signal, 15_000).catch(() => {})
    checkAborted(signal)
    try {
      return await bot.openContainer(block)
    } catch {
      throw new Error(`couldn't open the ${block.name} at ${fmtPos(block.position)}`)
    }
  }
}

const coords = {
  x: z.number().optional().describe('container x; omit all three to use the nearest chest/barrel'),
  y: z.number().optional(),
  z: z.number().optional()
}

const isFoodFn = (bot: Bot) => {
  const foods = (bot.registry as any).foodsByName ?? {}
  return (name: string) => !!foods[name]
}

const deposit = defineAction({
  name: 'deposit',
  description: 'Put items into the nearest chest/barrel (or the one at x y z). item="all" stores everything except tools, armour, food and anything in keep.',
  params: z.object({
    item: z.string().default('all').describe('item name, or "all"'),
    count: z.number().int().positive().optional().describe('how many; default all of them'),
    keep: z.array(z.string()).optional().describe('item names never to store'),
    ...coords
  }),
  aliases: ['store'],
  async run ({ bot, agent, signal, log }, p): Promise<ActionResult> {
    const items = selectDeposits(bot.inventory.items().map(i => ({ name: itemName(i), type: i.type, count: i.count })), {
      item: p.item, keep: p.keep, isFood: isFoodFn(bot)
    })
    if (!items.length) return fail(p.item === 'all' ? 'nothing to store' : `no ${p.item}`)
    const block = findContainer(bot, p)
    if (typeof block === 'string') return fail(block)
    const win = await openAt(bot, block, signal)
    const stored: Record<string, number> = {}
    let full = false
    const failed: string[] = []
    try {
      const byType = new Map<number, { name: string, count: number }>()
      for (const i of items) {
        const e = byType.get(i.type) ?? { name: i.name, count: 0 }
        e.count += i.count
        byType.set(i.type, e)
      }
      let left = p.count ?? Infinity
      for (const [type, e] of byType) {
        checkAborted(signal)
        if (left <= 0) break
        const n = Math.min(e.count, left)
        const before = win.containerCount(type, null)
        let err: Error | null = null
        try {
          await win.deposit(type, null, n)
        } catch (x) {
          err = x as Error
        }
        await sleep(SETTLE_MS, signal)
        // count what actually arrived in the container, the deposit may be partial
        const moved = win.containerCount(type, null) - before
        if (moved > 0) { stored[e.name] = moved; left -= moved }
        if (err) {
          log.debug('deposit failed', { item: e.name, error: err.message })
          if (win.firstEmptyContainerSlot() === null) { full = true; break }
          failed.push(e.name)
        }
      }
      remember(agent, block, win.containerItems())
    } finally {
      win.close()
    }
    const what = fmtTally(stored)
    const skipped = failed.length ? `, couldn't move ${failed.join(', ')}` : ''
    if (what === 'empty') return fail(full ? 'that container is full' : `stored nothing${skipped}`)
    return ok(`stored ${what} in ${block.name} at ${fmtPos(block.position)}${full ? ' (it is full now)' : ''}${skipped}`, stored)
  }
})

const withdraw = defineAction({
  name: 'withdraw',
  description: 'Take items out of the nearest chest/barrel (or the one at x y z).',
  params: z.object({
    item: z.string().describe('item name, or "all" to empty the container'),
    count: z.number().int().positive().optional().describe('how many; default all of that item'),
    ...coords
  }),
  aliases: ['take'],
  async run ({ bot, agent, signal }, p): Promise<ActionResult> {
    const block = findContainer(bot, p)
    if (typeof block === 'string') return fail(block)
    const win = await openAt(bot, block, signal)
    const got: Record<string, number> = {}
    try {
      const inside = win.containerItems().filter(i => p.item === 'all' || itemName(i) === p.item)
      if (!inside.length) {
        remember(agent, block, win.containerItems())
        return fail(`no ${p.item === 'all' ? 'items' : p.item} in that ${block.name}`)
      }
      const byType = new Map<number, { name: string, count: number }>()
      for (const i of inside) {
        const e = byType.get(i.type) ?? { name: itemName(i), count: 0 }
        e.count += i.count
        byType.set(i.type, e)
      }
      let left = p.count ?? Infinity
      for (const [type, e] of byType) {
        checkAborted(signal)
        if (left <= 0) break
        const n = Math.min(e.count, left)
        const before = win.containerCount(type, null)
        try {
          await win.withdraw(type, null, n)
        } catch {}
        await sleep(SETTLE_MS, signal)
        const moved = before - win.containerCount(type, null)
        if (moved > 0) { got[e.name] = moved; left -= moved }
        if (moved < n) break // inventory full
      }
      remember(agent, block, win.containerItems())
    } finally {
      win.close()
    }
    const what = fmtTally(got)
    if (what === 'empty') return fail('took nothing (inventory full?)')
    return ok(`took ${what}`, got)
  }
})

const listContainer = defineAction({
  name: 'list_container',
  description: 'Say what is inside the nearest chest/barrel (or the one at x y z). Looks inside if it is within reach and the bot is idle, otherwise reports what it saw last time.',
  params: z.object(coords),
  exclusive: false,
  aliases: ['chest'],
  async run ({ bot, agent }, p): Promise<ActionResult> {
    const block = findContainer(bot, p)
    if (typeof block === 'string') return fail(block)
    const where = `${block.name} at ${fmtPos(block.position)}`
    // only open it when nothing else is using the body or a window
    if (within(bot, block.position) && !agent.currentAction && !bot.currentWindow) {
      const win = await bot.openContainer(block).catch(() => null)
      if (win) {
        try {
          const contents = remember(agent, block, win.containerItems())
          return ok(`${where}: ${fmtTally(contents)}`, contents)
        } finally {
          win.close()
        }
      }
    }
    const mem = seen.get(agent)?.get(fmtPos(block.position))
    if (!mem) return fail(`I can't look inside the ${where} from here and haven't seen inside it yet`)
    const ago = Math.round((Date.now() - mem.at) / 60000)
    return ok(`${where} (seen ${ago ? `${ago} min ago` : 'just now'}): ${fmtTally(mem.contents)}`, mem.contents)
  }
})

export const containers = () => defineSkill({
  name: 'containers',
  description: 'Storing items in and taking them out of chests and barrels.',
  actions: [deposit, withdraw, listContainer],
  observe: (_agent, bot) => {
    const ids = Object.values(bot.registry.blocksByName).filter(b => CONTAINER_RE.test(b.name)).map(b => b.id)
    return { containersNearby: bot.findBlocks({ matching: ids, maxDistance: 16, count: 64 }).length }
  }
})
