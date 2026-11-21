import { defineSkill, defineAction, z, noParams, ok, fail, goals, goto, travel, surfaceY, roofed, TravelUndergroundError, holdGoal, playerEntity, fmtPos } from '../core/index.ts'
import { climbOut } from './survival.ts'

const come = defineAction({
  name: 'come',
  description: 'Walk to a player (default: whoever asked).',
  params: z.object({ player: z.string().optional().describe('player name; defaults to the requesting player') }),
  async run ({ bot, signal, player: caller }, { player }) {
    const who = player ?? caller
    const target = playerEntity(bot, who)
    if (!target) return fail(`can't see ${who ?? 'you'}`)
    const p = target.position
    await goto(bot, new goals.GoalNear(p.x, p.y, p.z, 1), signal)
    return ok(`reached ${who}`)
  }
})

const follow = defineAction({
  name: 'follow',
  description: 'Follow a player, staying close, until stopped.',
  params: z.object({
    player: z.string().optional().describe('player name; defaults to the requesting player'),
    distance: z.number().min(1).max(16).default(2).describe('how close to stay, in blocks')
  }),
  longRunning: true,
  async run ({ bot, signal, player: caller }, { player, distance }) {
    const who = player ?? caller
    const target = playerEntity(bot, who)
    if (!target) return fail(`can't see ${who ?? 'you'}`)
    await holdGoal(bot, new goals.GoalFollow(target, distance), signal)
    return ok(`stopped following ${who}`)
  }
})

const gotoAction = defineAction({
  name: 'goto',
  description: 'Walk to block coordinates, any distance (long trips go in legs and can take minutes; ' +
    'it keeps going in the background until it arrives, gets stuck or is stopped). Omit y to go to the surface at x/z.',
  params: z.object({
    x: z.number(),
    y: z.number().optional(),
    z: z.number()
  }),
  longRunning: true,
  async run (ctx, p) {
    const { bot, signal, log } = ctx
    const start = bot.entity.position.clone()
    const total = Math.round(Math.hypot(p.x - start.x, p.z - start.z))
    // Far trips start on the surface: from a cave the pathfinder just goes deeper.
    const climb = async (why: string) => {
      log.info(`goto: ${why}, climbing out first`, { at: fmtPos(bot.entity.position) })
      const r = await (climbOut as any).run(ctx, { maxBlocks: 64 }).catch((e: Error) => ({ ok: false, message: e.message }))
      return r?.ok ? null : `couldn't climb out (${r?.message ?? 'unknown'})`
    }
    const sy = surfaceY(bot, bot.entity.position.x, bot.entity.position.z)
    if (total > 24 && roofed(bot, 32) && sy !== null && sy - bot.entity.position.y > 8) {
      const err = await climb('starting underground')
      if (err) return fail(`${err}; I'm underground at ${fmtPos(bot.entity.position)} (target ${p.x} ${p.y ?? '~'} ${p.z})`)
    }
    const go = () => travel(bot, p, signal, { onProgress: ({ remaining, at }) => log.debug('travel progress', { remaining, at, total }) })
    try {
      try {
        await go()
      } catch (e) {
        if (signal.aborted || !(e instanceof TravelUndergroundError)) throw e
        const err = await climb('the route went underground')
        if (err) throw new Error(`${(e as Error).message}, and ${err}`)
        await go()
      }
    } catch (e) {
      if (signal.aborted) throw e
      return fail(`${(e as Error).message} (target ${p.x} ${p.y ?? '~'} ${p.z})`)
    }
    return ok(`arrived at ${fmtPos(bot.entity.position)} (${total} blocks)`)
  }
})

const gotoPlayer = defineAction({
  name: 'goto_player',
  description: 'Walk to where a player currently is (one-off, does not keep following).',
  params: z.object({ player: z.string() }),
  async run ({ bot, signal }, { player }) {
    const target = playerEntity(bot, player)
    if (!target) return fail(`can't see ${player}`)
    const p = target.position
    await goto(bot, new goals.GoalNear(p.x, p.y, p.z, 1), signal)
    return ok(`reached ${player}`)
  }
})

const lookAt = defineAction({
  name: 'look_at',
  description: 'Turn to look at a player.',
  params: z.object({ player: z.string().optional() }),
  exclusive: false,
  async run ({ bot, player: caller }, { player }) {
    const target = playerEntity(bot, player ?? caller)
    if (!target) return fail('can\'t see them')
    await bot.lookAt(target.position.offset(0, target.height, 0))
    return ok('looking')
  }
})

const jump = defineAction({
  name: 'jump',
  description: 'Jump once.',
  params: noParams,
  exclusive: false,
  async run ({ bot }) {
    bot.setControlState('jump', true)
    await bot.waitForTicks(5)
    bot.setControlState('jump', false)
    return ok('boing')
  }
})

const lookAround = defineAction({
  name: 'look_around',
  description: 'Glance around: at a nearby player now and then, otherwise a random direction (idle fidget).',
  params: z.object({ radius: z.number().min(1).max(32).default(10).describe('look at players within this distance') }),
  exclusive: false,
  internal: true,
  async run ({ bot }, { radius }) {
    const near = bot.nearestEntity(e => e.type === 'player' && e.position.distanceTo(bot.entity.position) < radius)
    if (near && Math.random() < 0.6) {
      await bot.lookAt(near.position.offset(0, near.height ?? 1.6, 0))
      return ok(`glanced at ${near.username ?? 'a player'}`)
    }
    await bot.look(bot.entity.yaw + (Math.random() - 0.5) * 1.6, bot.nearestEntity(e => e.name === 'enderman' && e.position.distanceTo(bot.entity.position) < 48) ? -0.7 : (Math.random() - 0.5) * 0.6) // never a random glance at an enderman
    return ok('looked around')
  }
})

export const movement = () => defineSkill({
  name: 'movement',
  description: 'Walking around: come, follow, goto.',
  actions: [come, follow, gotoAction, gotoPlayer, lookAt, jump, lookAround]
})
