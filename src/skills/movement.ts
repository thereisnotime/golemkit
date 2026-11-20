import { defineSkill, defineAction, z, noParams, ok, fail, goals, goto, holdGoal, playerEntity, fmtPos } from '../core/index.ts'

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
  description: 'Walk to block coordinates. Omit y to go to the surface at x/z.',
  params: z.object({
    x: z.number(),
    y: z.number().optional(),
    z: z.number()
  }),
  async run ({ bot, signal }, p) {
    const goal = p.y === undefined ? new goals.GoalXZ(p.x, p.z) : new goals.GoalBlock(p.x, p.y, p.z)
    await goto(bot, goal, signal)
    return ok(`arrived at ${fmtPos(bot.entity.position)}`)
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

export const movement = () => defineSkill({
  name: 'movement',
  description: 'Walking around: come, follow, goto.',
  actions: [come, follow, gotoAction, gotoPlayer, lookAt, jump]
})
