import type { Bot } from 'mineflayer'
import { defineSkill, defineAction, z, noParams, ok, fail, goals, goto, fmtPos, sleep, checkAborted, itemName } from '../core/index.ts'
import { findItem, placeAt, digBlock, DigRefusedError } from './world.ts'

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
      ? ok(`pillared up ${placed} block${placed === 1 ? '' : 's'} with ${block}, at ${fmtPos(bot.entity.position)}`)
      : fail('could not build a pillar here')
  }
})

const isNight = (bot: Bot) => { const t = bot.time.timeOfDay; return t >= 12_500 && t <= 23_500 }

const bunker = defineAction({
  name: 'bunker',
  description: 'Hide from phantoms and other mobs: dig straight down 3 blocks, seal the hole above with a dug ' +
    'block, wait until morning (or until no hostiles are near), then climb out. Needs digging; not in protected areas.',
  params: z.object({
    depth: z.number().int().min(2).max(4).default(3),
    maxMinutes: z.number().min(0.5).max(15).default(8).describe('give up waiting after this long'),
    untilDay: z.boolean().default(true).describe('stay until morning instead of until mobs leave')
  }),
  longRunning: true,
  async run ({ bot, agent, signal, log }, { depth, maxMinutes, untilDay }) {
    if (!agent.canDig) return fail('digging is disabled for this bot')
    if (agent.protectedAreas.isProtected(bot.entity.position)) return fail("can't dig in here (protected area); move away first")
    const start = bot.entity.position.floored()
    // Dig down under our feet, but never into liquid, air pockets or bedrock.
    let dug = 0
    for (let i = 1; i <= depth; i++) {
      checkAborted(signal)
      const feet = bot.entity.position.floored()
      const below = bot.blockAt(feet.offset(0, -1, 0))
      const under = bot.blockAt(feet.offset(0, -2, 0))
      if (!below || below.boundingBox !== 'block' || below.name === 'bedrock' || below.hardness === null || below.hardness < 0) break
      if (!under || under.boundingBox !== 'block' || /water|lava/.test(under.name)) break // don't open into a cave or liquid
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
    const out = await agent.act('pillar', { height: dug }, { caller: { kind: 'system', name: 'bunker' } }).catch(() => null)
    return ok(`sheltered ${dug} blocks down${sealed ? ' (sealed)' : ''} and ${out?.ok ? 'climbed back out' : 'stayed in the hole (couldn\'t climb out)'}`)
  }
})

export const survival = () => defineSkill({
  name: 'survival',
  description: 'Eating, sleeping and emergency pillars.',
  actions: [eat, sleepInBed, wake, pillar, bunker],
  observe: (_agent, bot) => ({ hasFood: !!bestFood(bot), sleeping: bot.isSleeping })
})
