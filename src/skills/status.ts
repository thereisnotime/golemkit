import { defineSkill, defineAction, z, noParams, ok, fmtPos } from '../core/index.ts'

const pos = defineAction({
  name: 'pos',
  description: 'Report the bot\'s position.',
  params: noParams,
  exclusive: false,
  aliases: ['where'],
  run: ({ bot }) => ok(`${fmtPos(bot.entity.position)} in ${bot.game.dimension}`)
})

const hp = defineAction({
  name: 'hp',
  description: 'Report health, food and what the bot is doing.',
  params: noParams,
  exclusive: false,
  aliases: ['status'],
  run: ({ bot, agent }) => ok(`health ${Math.round(bot.health)}/20, food ${bot.food}/20, doing ${agent.currentAction?.name ?? 'nothing'}`)
})

const stop = defineAction({
  name: 'stop',
  description: 'Stop whatever the bot is doing.',
  params: noParams,
  exclusive: false,
  run: ({ agent }) => { agent.stopActions('stopped'); return ok('stopped') }
})

const say = defineAction({
  name: 'say',
  capabilities: ['chat'],
  description: 'Say something in public chat.',
  params: z.object({ text: z.string().min(1) }),
  exclusive: false,
  run: ({ agent }, { text }) => { agent.say(text); return ok('') }
})

export const status = () => defineSkill({
  name: 'status',
  description: 'Status, stop and chat.',
  actions: [pos, hp, stop, say]
})
