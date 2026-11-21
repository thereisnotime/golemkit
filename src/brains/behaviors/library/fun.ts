// idle_antics: when the bot is standing around with nothing to do, it now and then does
// something funny or strange: spins, crouch-dances, stares at the sky, bobs up and down,
// does a little victory hop, or mutters a line. Pure flavour.
//
// It's a hook rather than a body-holding behaviour, so it still happens while follow_owner
// is armed: it only runs when the bot isn't moving and no real action holds the body, and
// each antic lasts a few seconds at most.
import type { Bot } from 'mineflayer'
import { z } from '../../../core/index.ts'
import { defineBehavior } from '../types.ts'

const ANTICS = ['spin', 'crouch_dance', 'sky_stare', 'bob', 'victory_hop', 'head_shake', 'moonwalk', 'stare_contest'] as const
type Antic = typeof ANTICS[number]

const QUIPS = [
  'did anyone else hear that?', 'i think that cow is judging me', 'this block looks suspicious',
  'brb, contemplating the void', 'the sky is very square today', '*hums the minecraft theme badly*',
  'i could build a castle. i won\'t. but i could.', 'do creepers have feelings?',
  'counting blocks... lost count', 'i\'m not idle, i\'m loading'
]

/** Holding body actions that idle antics may run alongside (the bot just stands near its owner). */
const PASSIVE_ACTIONS = new Set(['follow', 'guard', 'look_around'])

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

async function perform (bot: Bot, antic: Antic): Promise<void> {
  const yaw = bot.entity.yaw
  switch (antic) {
    case 'spin':
      for (let i = 1; i <= 8; i++) { await bot.look(yaw + (i * Math.PI) / 4, 0, true); await wait(120) }
      break
    case 'crouch_dance':
      for (let i = 0; i < 6; i++) { bot.setControlState('sneak', i % 2 === 0); await wait(250) }
      bot.setControlState('sneak', false)
      break
    case 'sky_stare':
      await bot.look(yaw, Math.PI / 2 - 0.05, true)
      await wait(2500)
      await bot.look(yaw, 0, true)
      break
    case 'bob':
      for (let i = 0; i < 4; i++) { await bot.look(yaw, i % 2 ? -0.6 : 0.6, true); await wait(300) }
      await bot.look(yaw, 0, true)
      break
    case 'victory_hop':
      for (let i = 0; i < 3; i++) { bot.setControlState('jump', true); await wait(250); bot.setControlState('jump', false); await wait(350) }
      break
    case 'head_shake':
      for (let i = 0; i < 6; i++) { await bot.look(yaw + (i % 2 ? 0.5 : -0.5), 0, true); await wait(150) }
      await bot.look(yaw, 0, true)
      break
    case 'moonwalk':
      bot.setControlState('back', true)
      await wait(700)
      bot.setControlState('back', false)
      break
    case 'stare_contest': {
      const p = bot.nearestEntity(e => e.type === 'player' && e.position.distanceTo(bot.entity.position) < 8)
      if (p) { await bot.lookAt(p.position.offset(0, 1.6, 0), true); await wait(3000) }
      break
    }
  }
}

export const idleAntics = defineBehavior({
  name: 'idle_antics',
  category: 'idle',
  description: 'When idle (standing around, nothing to do), now and then does something funny or strange: spins, crouch-dances, ' +
    'stares at the sky, hops, moonwalks, or mutters a line. Pure flavour; runs even while follow_owner is armed.',
  options: z.object({
    everySeconds: z.tuple([z.number().min(5), z.number().min(5)]).default([40, 120]).describe('random pause between antics [min, max]'),
    chat: z.number().min(0).max(1).default(0.15).describe('chance an antic comes with a quip in chat (0 = never)'),
    antics: z.array(z.enum(ANTICS)).optional().describe('which antics to use; default all'),
    quips: z.array(z.string().min(1).max(100)).optional().describe('custom chat lines')
  }),
  priority: 'idle',
  hook: (o) => {
    let next = Date.now() + 15_000
    let busy = false
    const pool = o.antics?.length ? o.antics : [...ANTICS]
    const lines = o.quips?.length ? o.quips : QUIPS
    return (ctx) => {
      const { bot, agent, now } = ctx
      if (busy || now < next) return
      const cur = agent.currentAction?.name
      const moving = bot.pathfinder?.isMoving?.() ?? false
      if (moving || (cur && !PASSIVE_ACTIONS.has(cur)) || bot.isSleeping) return
      const [a, b] = o.everySeconds
      next = now + (Math.min(a, b) + Math.random() * Math.abs(b - a)) * 1000
      const antic = pool[Math.floor(Math.random() * pool.length)]!
      busy = true
      ctx.log.debug('idle antic', { antic })
      if (Math.random() < o.chat) agent.say(lines[Math.floor(Math.random() * lines.length)]!)
      void perform(bot, antic).catch(() => {}).finally(() => {
        busy = false
        for (const k of ['sneak', 'jump', 'back'] as const) bot.setControlState(k, false)
      })
    }
  }
})
