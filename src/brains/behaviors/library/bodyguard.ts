// bodyguard: protects a player without the LLM. The fighting runs in the protect action
// (skills/bodyguard.ts); this behaviour decides when to run it, warns the player in chat
// (a per-tick hook, rate limited) and handles the player being far away or offline.
// While it is armed and the player is online, stay_safe doesn't go home at night and the
// reflexes leave target picking to protect (they still retreat, heal and pillar).
import type { Bot } from 'mineflayer'
import type { Agent } from '../../../core/index.ts'
import { z } from '../../../core/index.ts'
import { defineBehavior } from '../types.ts'
import { ownerTarget, dist } from './util.ts'
import { setEscort, lastSeen, playerThreats } from '../../../skills/bodyguard.ts'
import { WarnLimiter, warnText, warnKey } from '../../../skills/guard-plan.ts'
import { getHome } from '../../../skills/navigation.ts'

const options = z.object({
  player: z.string().optional().describe('who to protect; default the first owner online'),
  distance: z.number().min(1).max(8).default(3).describe('follow distance, blocks'),
  range: z.number().min(6).max(32).default(16).describe('protect radius around the player, blocks'),
  feed: z.boolean().default(true).describe('toss food to the player when their health is low (only if the server sends player health)'),
  keepFood: z.number().int().min(0).max(64).default(4).describe('food items to keep for itself when feeding'),
  warn: z.boolean().default(true).describe('warn the player in chat: "creeper behind you", "skeleton on the ridge east", "phantoms incoming"'),
  chat: z.boolean().default(true).describe('short callouts (fed you, ...)'),
  whisper: z.boolean().default(false).describe('send warnings as whispers instead of public chat'),
  whenGone: z.enum(['stay', 'home']).default('stay').describe('player offline: wait where they were last seen (stay) or go home'),
  catchUp: z.number().min(16).max(256).default(48).describe('player online but out of sight: walk to where they were last seen, up to this far')
})

type O = z.infer<typeof options>

function target (agent: Agent, bot: Bot, o: O) {
  return ownerTarget(agent, bot, o.player)
}

export const bodyguard = defineBehavior({
  name: 'bodyguard',
  category: 'combat',
  description: 'A real bodyguard for its owner (or a given player), no LLM needed: stays close and between them and danger, ' +
    'kills mobs that threaten them (creepers near them first, archers with a shot at them, diving phantoms, mobs coming ' +
    'for them or that hurt them), blocks arrows with a shield, warns them in chat, tosses them food when they look hurt, ' +
    'and stays with them at night instead of going home. Never attacks players, pets, villagers, golems or named mobs. ' +
    'Arm it when your owner says "guard me".',
  options,
  requires: ['protect'],
  uses: ['goto', 'go_home'],
  priority: 'behavior',
  prepare (o, { agent, player }) {
    return o.player || !player || agent.isOwner(player) ? o : { ...o, player }
  },
  hook (o, { agent }) {
    const limiter = new WarnLimiter(5000, 30_000)
    return ({ bot, now }) => {
      const t = target(agent, bot, o)
      if (!t) return
      const e = t.entity as any
      setEscort(agent, t.name, e?.position, bot.game?.dimension)
      if (!o.warn || !e?.position) return
      const ranked = playerThreats(bot, e, o.range)
      // one warning per tick at most: the most urgent threat the player may not have seen
      for (const th of ranked) {
        if (th.reason === 'on me' || th.reason === 'attacked me') continue
        const key = warnKey(th.name, e.position, th.e.position)
        if (!limiter.allow(key, now)) continue
        const same = ranked.filter(x => x.name === th.name && x.e.position.distanceTo(th.e.position) < 10).length
        const text = warnText(th.name, e.position, e.yaw ?? 0, th.e.position, same)
        if (o.whisper) agent.whisper(t.name, text)
        else agent.say(text)
        break
      }
    }
  },
  create (o, { agent }) {
    return {
      failureCooldownMs: 5000,
      maxFailureCooldownMs: 30_000,
      score ({ bot }) {
        const t = target(agent, bot, o)
        const me = bot.entity?.position
        if (!me) return 0
        if (t?.entity) {
          const threatened = playerThreats(bot, t.entity as any, o.range).length > 0
          return threatened ? 75 : 45
        }
        if (t) { // online, out of sight
          const seen = lastSeen(agent, t.name)
          return seen && dist(seen, me) > 4 && dist(seen, me) <= o.catchUp ? 40 : 0
        }
        // offline: wait where they were, or go home
        if (o.whenGone === 'home') {
          const home = getHome(agent)
          return home && agent.getAction('go_home') && dist(home, me) > 4 ? 22 : 0
        }
        const seen = lastSeen(agent, o.player)
        return seen && dist(seen, me) > 3 && dist(seen, me) <= 256 ? 22 : 0
      },
      async run (ctx) {
        const t = target(agent, ctx.bot, o)
        if (t?.entity) {
          return ctx.act('protect', { player: t.name, distance: o.distance, range: o.range, feed: o.feed, keepFood: o.keepFood, chat: o.chat })
        }
        if (!t && o.whenGone === 'home') return ctx.act('go_home', { range: 3 })
        const seen = lastSeen(agent, t?.name ?? o.player)
        if (!seen) return { ok: false, message: 'no idea where they are' }
        if (seen.dimension && ctx.bot.game?.dimension && seen.dimension !== ctx.bot.game.dimension) return { ok: false, message: 'they were last seen in another dimension' }
        return ctx.act('goto', { x: Math.floor(seen.x), y: Math.floor(seen.y), z: Math.floor(seen.z) })
      }
    }
  }
})
