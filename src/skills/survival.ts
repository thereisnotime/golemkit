import type { Bot } from 'mineflayer'
import type { ActionContext, ActionResult } from '../core/index.ts'
import { defineSkill, defineAction, z, noParams, ok, fail, goals, goto, fmtPos, sleep, checkAborted, itemName } from '../core/index.ts'
import { findItem, placeAt, digBlock, DigRefusedError } from './world.ts'
import { air } from './air.ts'
import { floodsIfDug } from './airPlan.ts'

/** Cheap full blocks that don't fall, for pillars and emergency shelters. */
const FILLER = /^(dirt|coarse_dirt|grass_block|rooted_dirt|mud|clay|cobblestone|cobbled_deepslate|mossy_cobblestone|netherrack|stone|deepslate|andesite|diorite|granite|calcite|tuff|blackstone|basalt|end_stone|sandstone|red_sandstone|terracotta|.*_terracotta|.*_planks|.*_log|snow_block)$/

/** The most plentiful cheap filler block in the inventory, or null. */
export function fillerBlock (bot: Bot): string | null {
  const it = bot.inventory.items().filter(i => FILLER.test(itemName(i))).sort((a, b) => b.count - a.count)[0]
  return it ? itemName(it) : null
}

const BAD_FOOD = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'suspicious_stew', 'chorus_fruit'])

export function bestFood (bot: Bot) {
  const foods = (bot.registry as any).foodsByName ?? {}
  return bot.inventory.items()
    .filter(i => foods[i.name] && !BAD_FOOD.has(i.name))
    .sort((a, b) => (foods[b.name].foodPoints ?? 0) - (foods[a.name].foodPoints ?? 0))[0]
}

const eat = defineAction({
  name: 'eat',
  capabilities: ['eat'],
  description: 'Eat the best food in the inventory.',
  params: noParams,
  async run ({ bot }) {
    if (bot.food >= 20) return fail('not hungry')
    const food = bestFood(bot)
    if (!food) return fail('nothing to eat')
    await bot.equip(food, 'hand')
    await bot.consume()
    return ok(`ate ${food.name}, food ${bot.food}/20`)
  }
})

const sleepInBed = defineAction({
  name: 'sleep',
  capabilities: ['sleep'],
  description: 'Sleep in a bed within 16 blocks (only works at night or during storms).',
  params: noParams,
  async run ({ bot, signal }) {
    const bed = bot.findBlock({ matching: b => bot.isABed(b), maxDistance: 16 })
    if (!bed) return fail('no bed nearby')
    await goto(bot, new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2), signal)
    await bot.sleep(bed)
    return ok('sleeping')
  }
})

const wake = defineAction({
  name: 'wake',
  capabilities: ['sleep'],
  description: 'Get out of bed.',
  params: noParams,
  async run ({ bot }) {
    if (!bot.isSleeping) return fail('not sleeping')
    await bot.wake()
    return ok('awake')
  }
})

const pillar = defineAction({
  name: 'pillar',
  capabilities: ['place'],
  description: 'Emergency escape: jump and place blocks underneath to stand on a pillar out of reach of mobs. ' +
    'Uses dirt/cobblestone/planks from the inventory.',
  params: z.object({
    height: z.number().int().min(1).max(8).default(3).describe('how many blocks to rise'),
    item: z.string().optional().describe('block to use; default the most plentiful dirt/cobblestone/planks')
  }),
  async run ({ bot, agent, signal }, { height, item }) {
    const block = item ?? fillerBlock(bot)
    if (!block || !findItem(bot, block)) return fail(item ? `no ${item}` : 'no dirt, cobblestone or planks to pillar with')
    if (agent.protectedAreas.isProtected(bot.entity.position)) return fail('can\'t build here (protected area)')
    const placed = await pillarUp(bot, signal, block, height)
    return placed
      ? ok(`pillared up ${placed} block${placed === 1 ? '' : 's'} with ${block}, at ${fmtPos(bot.entity.position)}`)
      : fail('could not build a pillar here')
  }
})

/**
 * Jumps and places `block` underneath, `height` times (stops at a ceiling or when out of blocks).
 * Returns how many blocks it rose. The pillar action's body, also used to build cover.
 */
export async function pillarUp (bot: Bot, signal: AbortSignal, block: string, height: number): Promise<number> {
  const at = (dy: number) => bot.blockAt(bot.entity.position.floored().offset(0, dy, 0))
  const up = bot.entity.position.floored().scaled(0).offset(0, 1, 0)
  let placed = 0
  try {
    await bot.look(bot.entity.yaw, -Math.PI / 2, true)
    for (let i = 0; i < height; i++) {
      checkAborted(signal)
      if (at(2)?.boundingBox !== 'empty') break // ceiling
      const it = findItem(bot, block)
      if (!it) break
      await bot.equip(it, 'hand')
      const ground = at(-1)
      if (!ground || ground.boundingBox !== 'block') break
      const floorY = Math.floor(bot.entity.position.y)
      bot.setControlState('jump', true)
      const until = Date.now() + 1500
      while (bot.entity.position.y < floorY + 1.05 && Date.now() < until) await sleep(50, signal)
      try {
        await bot.placeBlock(ground, up)
        placed++
      } catch {
        await sleep(200, signal)
        if (bot.blockAt(ground.position.offset(0, 1, 0))?.boundingBox === 'block') placed++
        else break
      } finally {
        bot.setControlState('jump', false)
      }
      await sleep(250, signal)
    }
  } finally {
    bot.setControlState('jump', false)
  }
  return placed
}

/** Highest solid block above the head (within `range`), or null when the sky is open. */
export function roofAbove (bot: Bot, range = 24): number | null {
  const p = bot.entity.position.floored()
  for (let dy = 2; dy <= range; dy++) {
    const b = bot.blockAt(p.offset(0, dy, 0))
    if (b && b.boundingBox === 'block' && !/leaves|glass/.test(b.name)) return p.y + dy
  }
  return null
}

const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const
const LIQUID = /water|lava/

/** Carves one step up into a wall (dig the 2 blocks of the next step, then walk/jump onto it). No blocks needed. */
async function stairStep (ctx: any): Promise<boolean> {
  const { bot, agent, signal } = ctx
  const p = bot.entity.position.floored()
  const solid = (b: any) => b && b.boundingBox === 'block'
  // Try the side whose step is cheapest: the step block itself must be solid (to stand on).
  for (const [dx, dz] of SIDES) {
    const step = p.offset(dx, 0, dz) // we'll stand on top of this
    const a = p.offset(dx, 1, dz)
    const b = p.offset(dx, 2, dz)
    if (!solid(bot.blockAt(step))) continue
    const around = [a, b, b.offset(0, 1, 0), p.offset(0, 2, 0)].flatMap((q: any) => [q, ...SIDES.map(([sx, sz]) => q.offset(sx, 0, sz))])
    if (around.some((q: any) => LIQUID.test(bot.blockAt(q)?.name ?? ''))) continue
    if ([a, b].some((q: any) => agent.protectedAreas.isProtected(q))) continue
    try {
      for (const q of [p.offset(0, 2, 0), b, a]) {
        const blk = bot.blockAt(q)
        if (!solid(blk)) continue
        if (blk.hardness === null || blk.hardness < 0) throw new Error('unbreakable')
        const tool = (bot.pathfinder as any).bestHarvestTool?.(blk)
        if (tool) await bot.equip(tool, 'hand').catch(() => {})
        await digBlock(bot, blk, signal)
      }
      // Jump onto the step.
      await bot.lookAt(a.offset(0.5, 0.5, 0.5), true)
      bot.setControlState('forward', true)
      bot.setControlState('jump', true)
      const until = Date.now() + 1500
      while (Date.now() < until && Math.floor(bot.entity.position.y) < a.y) await sleep(50, signal)
      bot.setControlState('jump', false)
      await sleep(250, signal)
      bot.setControlState('forward', false)
      if (Math.floor(bot.entity.position.y) >= a.y) return true
    } catch (e) {
      bot.setControlState('jump', false); bot.setControlState('forward', false)
      checkAborted(signal)
      if (e instanceof DigRefusedError) return false
    }
  }
  return false
}

/** Bots in the middle of climb_out (on their own or inside goto). Reflexes read it. */
const climbingBots = new WeakSet<object>()

/** Whether this bot is climbing out of a cave or pit right now. */
export function isClimbingOut (bot: object): boolean {
  return climbingBots.has(bot)
}

/** Where an attacker is, relative to the bot, for keepClimbing. */
export interface ClimbThreat {
  /** Horizontal distance in blocks. */
  dist: number
  /** Attacker's feet minus the bot's feet, in blocks (negative: below). */
  dy: number
  /** Shoots from afar (skeleton, pillager...) or flies. */
  ranged: boolean
  creeper?: boolean
}

/**
 * While climbing out underground, is going on climbing the safer answer to an attack than
 * stopping to fight? Yes unless a melee mob is right on us at our level (it would hit us all
 * the way up) or a creeper is close. A mob below the pillar can't follow, and an archer in a
 * cave loses its line of sight once the bot is up the shaft, while chasing it underground is
 * how Pax died. Pure, for tests.
 */
export function keepClimbing (t: ClimbThreat): boolean {
  if (t.creeper) return t.dist > 4 || t.dy <= -3
  if (t.ranged) return true
  if (t.dy <= -2) return true
  return t.dist > 2.5
}

export const climbOut = defineAction({
  name: 'climb_out',
  capabilities: ['move', 'dig'],
  description: 'Get out of a pit, shaft or cave straight up to open sky: dig the block above if needed, jump and place ' +
    'a block underneath, repeat. Without blocks it carves stair steps up into the wall instead.',
  params: z.object({ maxBlocks: z.number().int().min(1).max(64).default(32).describe('give up after rising this many blocks') }),
  async run (ctx, { maxBlocks }) {
    climbingBots.add(ctx.bot)
    try {
      return await climbOutNow(ctx, maxBlocks)
    } finally {
      climbingBots.delete(ctx.bot)
    }
  }
})

async function climbOutNow (ctx: ActionContext, maxBlocks: number): Promise<ActionResult> {
  const { bot, agent, signal } = ctx
  const startY = Math.floor(bot.entity.position.y)
  let fails = 0
  while (Math.floor(bot.entity.position.y) - startY < maxBlocks) {
    checkAborted(signal)
    if (roofAbove(bot) === null && bot.blockAt(bot.entity.position.floored().offset(0, 1, 0))?.boundingBox !== 'block') {
      // Open sky above: step off the pillar onto solid ground nearby if there is any.
      return ok(`out in the open at ${fmtPos(bot.entity.position)} (rose ${Math.floor(bot.entity.position.y) - startY} blocks)`)
    }
    // Clear the two blocks above the head.
    for (const dy of [1, 2]) {
      const b = bot.blockAt(bot.entity.position.floored().offset(0, dy, 0))
      if (b && b.boundingBox === 'block') {
        if (!agent.canDig) return fail('a block is in the way above and I may not dig')
        if (agent.protectedAreas.isProtected(b.position)) return fail('the way up is in a protected area')
        if (/water|lava/.test(bot.blockAt(b.position.offset(0, 1, 0))?.name ?? '')) return fail(`liquid above at ${fmtPos(b.position)}; not digging into it`)
        const tool = (bot.pathfinder as any).bestHarvestTool?.(b)
        if (tool) await bot.equip(tool, 'hand').catch(() => {})
        try { await digBlock(bot, b, signal) } catch (e) { checkAborted(signal); if (e instanceof DigRefusedError) return fail(e.message); fails++ }
        await sleep(300, signal)
      }
    }
    const r = fillerBlock(bot) ? await (pillar as any).run(ctx, { height: 1 }).catch(() => null) : null
    if (!r?.ok) {
      // No blocks (or the pillar failed): carve one stair step up into a wall instead.
      if (await stairStep(ctx)) { fails = 0; continue }
      if (++fails > 6) return fail(`couldn't climb further (no blocks to pillar and no wall I can carve steps into), at ${fmtPos(bot.entity.position)}`)
      await sleep(400, signal)
    }
  }
  return fail(`rose ${maxBlocks} blocks and still no open sky, at ${fmtPos(bot.entity.position)}`)
}

const isNight = (bot: Bot) => { const t = bot.time.timeOfDay; return t >= 12_500 && t <= 23_500 }

const bunker = defineAction({
  name: 'bunker',
  capabilities: ['dig', 'place'],
  description: 'Hide from phantoms and other mobs: dig straight down 3 blocks, seal the hole above with a dug ' +
    'block, wait until morning (or until no hostiles are near), then climb out. Needs digging; not in protected areas.',
  params: z.object({
    depth: z.number().int().min(2).max(4).default(3),
    maxMinutes: z.number().min(0.5).max(15).default(8).describe('give up waiting after this long'),
    untilDay: z.boolean().default(true).describe('stay until morning instead of until mobs leave')
  }),
  longRunning: true,
  async run (ctx, { depth, maxMinutes, untilDay }) {
    const { bot, agent, signal, log } = ctx
    if (!agent.canDig) return fail('digging is disabled for this bot')
    if (agent.protectedAreas.isProtected(bot.entity.position)) return fail("can't dig in here (protected area); move away first")
    const start = bot.entity.position.floored()
    const roof = roofAbove(bot, 12)
    if (roof !== null) return fail(`already under cover (a block ${roof - start.y} above me); use climb_out to get to the surface`)
    // Only worth it if we'll be able to seal the top: we carry a block, or the ground drops one
    // by hand (dirt, sand...). Stone without a pickaxe drops nothing.
    const top = bot.blockAt(start.offset(0, -1, 0))
    const handDrops = /^(dirt|grass_block|coarse_dirt|rooted_dirt|mud|clay|sand|red_sand|snow_block|podzol|mycelium)$/.test(top?.name ?? '')
    const pickaxe = bot.inventory.items().some(i => /_pickaxe$/.test(i.name))
    if (!fillerBlock(bot) && !handDrops && !pickaxe) return fail(`no block to seal a shelter with and the ground here (${top?.name ?? 'unknown'}) won't give me one`)
    // Dig down under our feet, but never into liquid, air pockets or bedrock.
    let dug = 0
    for (let i = 1; i <= depth; i++) {
      checkAborted(signal)
      const feet = bot.entity.position.floored()
      const below = bot.blockAt(feet.offset(0, -1, 0))
      const under = bot.blockAt(feet.offset(0, -2, 0))
      if (!below || below.boundingBox !== 'block' || below.name === 'bedrock' || below.hardness === null || below.hardness < 0) break
      if (!under || under.boundingBox !== 'block' || /water|lava/.test(under.name)) break // don't open into a cave or liquid
      // nor beside water or ice: Pax's bunker by the frozen farm pond flooded and it drowned in it later
      const flood = floodsIfDug(SIDES.map(([dx, dz]) => bot.blockAt(below.position.offset(dx, 0, dz))?.name))
      if (flood) { log.debug(`bunker: stopped digging at ${fmtPos(below.position)}, ${flood}`); break }
      try {
        const tool = (bot.pathfinder as any).bestHarvestTool?.(below)
        if (tool) await bot.equip(tool, 'hand').catch(() => {})
        await digBlock(bot, below, signal)
      } catch (e) {
        checkAborted(signal)
        if (e instanceof DigRefusedError) { agent.markProtected(below.position); return fail(e.message) }
        break
      }
      await sleep(500, signal) // fall into the hole
      dug++
    }
    if (dug < 2) return fail('ground here is too thin or unsafe to dig a shelter')
    await sleep(900, signal) // let the dug blocks drop into our inventory
    // Seal the opening: the block at the original feet level, two above our head is open sky.
    const feet = bot.entity.position.floored()
    const cover = feet.offset(0, 2, 0)
    const filler = fillerBlock(bot)
    if (!filler) return fail('dug in but have no block to seal the hole with')
    try { await placeAt(bot, filler, cover, signal) } catch (e) { checkAborted(signal); log.debug('seal failed', { error: (e as Error).message }) }
    const sealed = bot.blockAt(cover)?.boundingBox === 'block'
    log.info(`bunkered ${dug} deep${sealed ? ', sealed' : ', NOT sealed'}`, { at: fmtPos(start) })
    // Wait it out.
    const until = Date.now() + maxMinutes * 60_000
    while (Date.now() < until) {
      checkAborted(signal)
      const night = isNight(bot)
      const threat = bot.nearestEntity(e => (e.type === 'hostile' || e.name === 'phantom') && e.position.distanceTo(bot.entity.position) < 24)
      if (untilDay ? !night : !threat) break
      await sleep(3000, signal)
    }
    // Climb out: break the seal and pillar back up.
    const lid = bot.blockAt(cover)
    if (lid && lid.boundingBox === 'block') await digBlock(bot, lid, signal).catch(() => {})
    // Climb out. Run pillar inline (agent.act from inside an action would preempt this very
    // action), then check we're really back at the surface; if not, dig a staircase up.
    const outside = () => bot.entity.position.y >= start.y - 0.2
    let how = 'climbed back out'
    if (!outside()) await (climbOut as any).run(ctx, { maxBlocks: dug + 4 }).catch(() => null)
    if (!outside()) {
      try { await goto(bot, new goals.GoalNear(start.x, start.y, start.z, 1), signal); how = 'dug a staircase out' } catch (e) { checkAborted(signal) }
    }
    const out = { ok: outside() }
    return ok(`sheltered ${dug} blocks down${sealed ? ' (sealed)' : ''} and ${out.ok ? how : `am still in the hole at ${fmtPos(bot.entity.position)} (couldn't climb out)`}`)
  }
})

export const survival = () => defineSkill({
  name: 'survival',
  description: 'Eating, sleeping, emergency pillars and getting air.',
  actions: [eat, sleepInBed, wake, pillar, climbOut, bunker, air],
  observe: (_agent, bot) => ({ hasFood: !!bestFood(bot), sleeping: bot.isSleeping })
})
