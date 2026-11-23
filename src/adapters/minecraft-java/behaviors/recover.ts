// recover_drops: right after a respawn, go back for the things dropped at the death spot if they
// can still be had and the spot is safe enough, pick them up, put the armour back on and go home.
// The decision is recoverDecision (src/skills/recoverPlan.ts); the trip is the recover_items
// action, which gives up on the way when the despawn gets close, the bot gets hurt badly, or the
// spot turns out to be a danger zone. One recovery per death.
import type { Bot } from 'mineflayer'
import { z, needsSurvival } from '../../../core/index.ts'
import { defineBehavior } from '../../../brains/behaviors/types.ts'
import { RECOVER_DEFAULTS, type RecoverDecision, type RecoverOptions } from '../../../skills/recoverPlan.ts'
import { lastOwnDeath, deathReported, decideRecovery, markHandled } from '../../../skills/recover.ts'
import { getHome, sameDimension } from '../../../skills/navigation.ts'
import { ownerTarget, flatDist } from './util.ts'

/** Above chores, keep_fed's normal meals and stay_safe's night trip home when unprepared (70); below water (78), mobs (80) and low health (88+). */
export const RECOVER_SCORE = 72
/** Trips per death: one cut short by a fight or a danger can be picked up again while time is left. */
const MAX_ATTEMPTS = 3
/** Time to spare (despawn minus walk and margin) from which prepare_trip runs first. */
const PREP_SPARE_MS = 90_000

const options = z.object({
  maxDistance: z.number().min(16).max(2000).default(RECOVER_DEFAULTS.maxDistance).describe('farthest death spot worth a trip, in blocks'),
  marginSeconds: z.number().min(5).max(120).default(RECOVER_DEFAULTS.marginSeconds).describe('seconds to have left on arrival for picking up (walking speed estimate)'),
  giveUpHealth: z.number().min(0).max(19).default(RECOVER_DEFAULTS.giveUpHealth).describe('turn back at or below this health'),
  nightMaxDistance: z.number().min(0).max(2000).default(RECOVER_DEFAULTS.nightMaxDistance).describe('at night with poor gear, only spots this close'),
  nightGear: z.number().min(0).max(100).default(RECOVER_DEFAULTS.nightGear).describe('gear score (15 naked, about 72 in iron with shield and sword) from which night trips are fine'),
  freeThreat: z.number().min(0).max(10).default(RECOVER_DEFAULTS.freeThreat).describe('threat points (zombie 1, skeleton 1.5, witch 2) fine with any gear'),
  gearPerThreat: z.number().min(0).max(50).default(RECOVER_DEFAULTS.gearPerThreat).describe('gear score needed per threat point above that'),
  avoidPlayerKillers: z.boolean().default(true).describe("don't go back where a player killed it"),
  maxWaterDepth: z.number().min(0).max(64).default(RECOVER_DEFAULTS.maxWaterDepth).describe('more water than this above the spot: give up'),
  radius: z.number().min(2).max(24).default(10).describe('pick up drops this close to the spot'),
  goHome: z.boolean().default(true).describe('go home afterwards'),
  announce: z.boolean().default(true).describe('tell the owner what came back (or why not)')
})
type Options = z.infer<typeof options>

export const recoverDrops = defineBehavior({
  name: 'recover_drops',
  capabilities: ['move', 'inventory'],
  category: 'survival',
  description: 'After a death, goes back for the dropped things before they despawn (5 minutes): only when they can still be had ' +
    '(not lava, void, deep water or another dimension, close enough for the time left at walking speed) and the spot is safe enough ' +
    "for its gear (the killer and the hostiles reported there; night counts). Waits while it isn't, gives up when the despawn gets close, " +
    'it gets hurt badly or the spot is a danger zone; picks the items up, puts armour and weapon back on, goes home and says what came ' +
    'back ("got back 23 of 31 items: stone sword, ..."). Once per death, right after the respawn, below immediate safety.',
  options,
  requires: ['recover_items'],
  uses: ['go_home', 'prepare_trip'],
  priority: 'behavior',
  create (o: Options, { agent }) {
    const plan: RecoverOptions = {
      maxDistance: o.maxDistance, marginSeconds: o.marginSeconds, giveUpHealth: o.giveUpHealth, nightMaxDistance: o.nightMaxDistance,
      nightGear: o.nightGear, freeThreat: o.freeThreat, gearPerThreat: o.gearPerThreat, avoidPlayerKillers: o.avoidPlayerKillers, maxWaterDepth: o.maxWaterDepth
    }
    const log = agent.log.child('behaviors')
    let cached: { at: number, id: number, dec: RecoverDecision } | null = null
    let waitUntil = 0
    let lastWhy = ''
    const tell = (bot: Bot, text: string) => {
      if (!o.announce) return
      let owner: { name: string } | null = null
      try { owner = ownerTarget(agent, bot) } catch {}
      if (owner && bot.players?.[owner.name]) agent.whisper(owner.name, text); else agent.say(text)
    }
    const decide = (bot: Bot, now: number) => {
      const d = lastOwnDeath(agent, now)
      if (!d || d.handled || (d.attempts ?? 0) >= MAX_ATTEMPTS) return null
      if (!bot.entity || !(bot.health > 0) || !deathReported(agent, d, now)) return null
      if (cached && cached.id === d.id && now - cached.at < 2000) return { d, dec: cached.dec }
      const dec = decideRecovery(agent, bot, d, plan, now)
      cached = { at: now, id: d.id, dec }
      if (dec.do === 'skip') {
        markHandled(d, dec.why)
        log.info(`recover_drops: not going back: ${dec.why}`)
        const items = d.lost.reduce((n, i) => n + i.count, 0)
        if (items && !/nothing on me|kept my inventory/.test(dec.why)) tell(bot, `lost ${items} items where I died: ${dec.why}`)
      } else if (dec.do === 'wait') {
        waitUntil = now + dec.retryMs
        if (dec.why !== lastWhy) log.info(`recover_drops: waiting: ${dec.why}`)
      } else log.debug(`recover_drops: going back: ${dec.why}`)
      lastWhy = dec.why
      return { d, dec }
    }
    return {
      failureCooldownMs: 5000,
      maxFailureCooldownMs: 20_000,
      score ({ bot, now, current }) {
        if (current === 'recover_drops') return RECOVER_SCORE
        if (!needsSurvival(bot as Bot) || now < waitUntil) return 0
        const r = decide(bot as Bot, now)
        return r?.dec.do === 'go' ? RECOVER_SCORE : 0
      },
      async run (ctx) {
        const bot = ctx.bot as Bot
        cached = null
        const r = decide(bot, Date.now())
        if (!r) return { ok: true, message: 'nothing to recover' }
        if (r.dec.do !== 'go') return { ok: r.dec.do === 'wait', message: r.dec.why }
        // the trip prep (pantry food, a weapon) when there is time to spare; never a reason not to go
        const spare = r.dec.leftMs - r.dec.etaMs - o.marginSeconds * 1000
        if (agent.getAction('prepare_trip') && spare >= PREP_SPARE_MS) {
          const p = await ctx.act('prepare_trip', { purpose: 'getting my things back', kind: 'travel', distance: r.dec.distance, waive: ['weapon', 'food', 'health'] })
          log.debug(`recover_drops: prepare_trip: ${p.message}`)
        }
        const res = await ctx.act('recover_items', { force: true, radius: o.radius, max_distance: o.maxDistance, give_up_health: o.giveUpHealth })
        if (!r.d.handled) markHandled(r.d, res.message) // recover_items refused: no second try
        tell(bot, res.message.replace(/^not going back: /, 'not going back for my things: '))
        const home = getHome(agent)
        if (o.goHome && home && sameDimension(bot, home) && agent.getAction('go_home') && bot.entity && flatDist(bot.entity.position, home) > 8) {
          const h = await ctx.act('go_home', { range: 3 })
          if (!h.ok) log.info(`recover_drops: ${h.message}`)
        }
        return res
      }
    }
  }
})
