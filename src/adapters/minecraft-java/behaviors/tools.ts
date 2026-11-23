// keep_tools_upgraded: re-crafts worn or broken tools and upgrades them (wood -> stone ->
// iron -> diamond) when there is nothing else to do. The decision reuses the pure planner
// nextToolUpgrade (src/skills/progression.ts); the work goes through ctx.act().
import type { Bot } from 'mineflayer'
import { z, needsSurvival, itemName } from '../../../core/index.ts'
import { defineBehavior } from '../../../brains/behaviors/types.ts'
import { nextToolUpgrade, senseNearby, type Nearby } from '../../../skills/progression.ts'
import { inventoryCounts, toolTier, usablePlankUnits, type ToolKind } from '../../../skills/toolkit.ts'

/** Blackboard need set while upgrade_tools is stuck for wood; chop_wood_loop scores higher for it. */
export const WOOD_NEED = 'wood'

const KINDS: ToolKind[] = ['pickaxe', 'sword', 'axe', 'shovel']

/** Tools whose remaining durability share is below `min` and that have no spare of the same tier or better. Pure-ish (reads the inventory). */
export function wornTools (bot: Bot, min: number): string[] {
  const items = bot.inventory?.items() ?? []
  const out: string[] = []
  for (const kind of KINDS) {
    const tools = items.filter(i => toolTier(itemName(i), kind) > 0)
    if (!tools.length) continue
    const best = tools.sort((a, b) => toolTier(itemName(b), kind) - toolTier(itemName(a), kind))[0]!
    const max = (best as any).maxDurability ?? bot.registry.itemsByName[itemName(best)]?.maxDurability
    const used = (() => { try { return (best as any).durabilityUsed ?? 0 } catch { return 0 } })()
    if (!max) continue
    const spare = tools.filter(t => t !== best && toolTier(itemName(t), kind) >= toolTier(itemName(best), kind)).length
    if ((max - used) / max < min && !spare) out.push(itemName(best))
  }
  return out
}

export const keepToolsUpgraded = defineBehavior({
  name: 'keep_tools_upgraded',
  capabilities: ['craft'],
  category: 'work',
  description: 'Keeps tools usable and moving up the tiers when the bot is idle: re-crafts a worn or broken pickaxe/axe/shovel/sword, ' +
    'makes stone tools as soon as it can mine 3 cobblestone, then a furnace, iron (smelted with coal or charcoal) and diamond tools, up to `upTo`. ' +
    'A sword comes right after the pickaxe (wooden while there is no cobblestone). Short of wood it takes logs or planks from its own chests nearby, ' +
    'otherwise it raises a wood need that chop_wood_loop picks up, and retries as soon as the wood is there. Gathering steps need digging enabled.',
  options: z.object({
    upTo: z.enum(['stone', 'iron', 'diamond']).default('iron').describe('highest tier to work towards'),
    minDurability: z.number().min(0).max(0.9).default(0.1).describe('replace a tool when less than this share of its durability is left'),
    armour: z.boolean().default(false).describe('also make iron armour once iron tools are done'),
    senseSeconds: z.number().min(5).max(600).default(30).describe('how often to look around for stone and ore (the scan costs CPU)')
  }),
  requires: ['upgrade_tools'],
  uses: ['craft'],
  priority: 'npc',
  create (o, { agent }) {
    let sensed: { at: number, nearby: Nearby } | null = null
    let lastNeed: string | undefined
    const nearby = (bot: Bot, now: number): Nearby => {
      if (!sensed || now - sensed.at > o.senseSeconds * 1000) {
        sensed = { at: now, nearby: senseNearby({ bot, agent, signal: new AbortController().signal, log: agent.log }) }
      }
      return sensed.nearby
    }
    const want = (bot: Bot, now: number) => {
      if (!bot.entity || !needsSurvival(bot)) return null
      const worn = wornTools(bot, o.minDurability)
      if (worn.length) return { worn: worn[0]! }
      const step = nextToolUpgrade(inventoryCounts(bot), nearby(bot, now), bot.game?.gameMode, { upTo: o.upTo, armour: o.armour })
      if (!step || (step.do === 'gather' && !agent.canDig)) return null
      return { step }
    }
    return {
      cooldownMs: 20_000,
      failureCooldownMs: 60_000,
      maxFailureCooldownMs: 900_000,
      score: ({ bot, now, current }) => current === 'keep_tools_upgraded' || want(bot, now) ? 28 : 0,
      // stuck for wood: the back-off ends as soon as the usable wood changes (chopped, or put in its inventory)
      retryKey: ({ bot }) => lastNeed === 'wood' && bot.inventory ? `wood ${usablePlankUnits(inventoryCounts(bot))}` : 'same',
      async run (ctx) {
        const w = want(ctx.bot, ctx.now)
        if (!w) return { ok: true, message: 'tools are fine' }
        if ('worn' in w) return ctx.act('craft', { item: w.worn, count: 1 })
        sensed = null // look again after the work
        const r = await ctx.act('upgrade_tools', { up_to: o.upTo, armour: o.armour })
        lastNeed = (r.data as { need?: string } | undefined)?.need
        ctx.bb.setNeed(WOOD_NEED, lastNeed === 'wood' ? 1 : 0)
        return r
      }
    }
  }
})
