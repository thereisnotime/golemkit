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

// anti_afk: servers (or AFK plugins) kick players who don't move for a while. After some seconds
// without movement, look around, swing an arm, sneak or hop in place. It never walks, so it's safe
// next to ledges and doesn't disturb builds or follow.
const AFK_MOVES = ['look', 'swing', 'sneak', 'hop'] as const

export const antiAfk = defineBehavior({
  name: 'anti_afk',
  category: 'idle',
  description: 'Avoids idle (AFK) kicks: after some seconds without moving, looks around, swings an arm, sneaks or hops in place. Never walks.',
  options: z.object({
    afterSeconds: z.number().min(5).max(600).default(45).describe('seconds without movement before a small action'),
    moves: z.array(z.enum(AFK_MOVES)).optional().describe('which moves to use; default all')
  }),
  priority: 'idle',
  hook: (o) => {
    let lastPos = ''
    let still = Date.now()
    let busy = false
    const pool = o.moves?.length ? o.moves : [...AFK_MOVES]
    return (ctx) => {
      const { bot, now } = ctx
      if (!bot.entity || busy || bot.isSleeping) return
      const p = bot.entity.position
      const key = `${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)},${bot.entity.yaw.toFixed(2)},${bot.entity.pitch.toFixed(2)}`
      if (key !== lastPos) { lastPos = key; still = now; return }
      if (now - still < o.afterSeconds * 1000) return
      still = now
      busy = true
      const move = pool[Math.floor(Math.random() * pool.length)]!
      ctx.log.debug('anti-afk', { move })
      const yaw = bot.entity.yaw
      const run = async () => {
        switch (move) {
          case 'look': await bot.look(yaw + (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 0.8, false); break
          case 'swing': bot.swingArm('right'); break
          case 'sneak': bot.setControlState('sneak', true); await wait(400); bot.setControlState('sneak', false); break
          case 'hop': if (bot.entity.onGround) { bot.setControlState('jump', true); await wait(200); bot.setControlState('jump', false) } break
        }
      }
      void run().catch(() => {}).finally(() => { busy = false })
    }
  }
})
