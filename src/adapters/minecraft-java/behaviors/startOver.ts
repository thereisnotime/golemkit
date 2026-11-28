// start_over: runs a start-over step by step (skills/startOver.ts, decisions in
// skills/startOverPlan.ts startOverStep): pack at the old base, leave it behind, walk legs in one
// direction by day, dig in at night, look around once far enough, settle (home, bed, chest).
// The state is in storage, so after a restart or a death it carries on where it was. Fires once
// by itself with settings.startOver.go; otherwise the owner's start_over action starts it.
import type { Bot } from 'mineflayer'
import { z, needsSurvival, fmtPos, sleep } from '../../../core/index.ts'
import { defineBehavior } from '../../../brains/behaviors/types.ts'
import {
  startOverStep, chooseHeading, siteVerdict, fallbackOk, betterBest, angleCompass, packValue,
  type StartOverState, type StepFacts, type SiteFacts
} from '../../../skills/startOverPlan.ts'
import {
  startOverConfig, startOverState, saveStartOver, startingOver, beginStartOver, abandonOldBase, noteStartOver,
  avoidPoints, avoidedAt, lookAround, factsText, HOME_AWAY_KEY
} from '../../../skills/startOver.ts'
import { daylightMs, foodPoints } from '../../../skills/trip.ts'
import { fmtTally } from '../../../skills/containers.ts'
import { getHome, setHome } from '../../../skills/navigation.ts'
import { itemName } from '../../../core/index.ts'
import { ownerTarget } from './util.ts'

/** Above chores, farm, tools and lighting (30 and under) and keep_fed's meals while it isn't hungry; below hunger, recover_drops (72) and immediate danger. */
export const START_OVER_SCORE = 58
/** At night: dig in, like stay_safe's shelter. */
export const START_OVER_NIGHT_SCORE = 66
/** Things worth putting in the new chest: ores and ingots (tools, food, seeds, logs, torches stay on it for the work ahead). */
const STASH = /^(raw_(iron|gold|copper)|(iron|gold|copper|netherite)_ingot|diamond|emerald|redstone|lapis_lazuli|.*_ore)$/

const options = z.object({
  announce: z.boolean().default(true).describe('tell the owner when it leaves, settles or gives up')
})
type Options = z.infer<typeof options>

export const startOverBehavior = defineBehavior({
  name: 'start_over',
  capabilities: ['move', 'containers'],
  category: 'routine',
  description: 'Carries out a start-over (the start_over action, or settings.startOver.go once on start): packs the most precious things from ' +
    'its chests near home, leaves the old base behind (kept as the place old_base), walks off in one direction by day and digs in at night, ' +
    'looks around once it is far enough (startOver.minDistance, default 500) and settles at the first place with grass, trees, water and animals that ' +
    "isn't snowy, protected or built on: home, bed and a chest there, then its other behaviours build up from scratch. Resumes after a restart or a death.",
  options,
  requires: ['start_over_pack', 'start_over_leg', 'start_over_settle'],
  uses: ['check_chests', 'deposit', 'bunker', 'place_bed', 'place_chest'],
  priority: 'behavior',
  create (o: Options, { agent }) {
    let fired = false
    let waitUntil = 0
    /** The last look, so the step after it can use it (cleared once it moves on). */
    let looked: { x: number, z: number, facts: SiteFacts } | null = null
    const tell = (bot: Bot, text: string) => {
      if (!o.announce) return
      let owner: { name: string } | null = null
      try { owner = ownerTarget(agent, bot) } catch {}
      if (owner && bot.players?.[owner.name]) agent.whisper(owner.name, text); else agent.say(text)
    }
    const save = (st: StartOverState) => saveStartOver(agent, st)
    return {
      failureCooldownMs: 5000,
      maxFailureCooldownMs: 30_000,
      score ({ bot, now }) {
        const b = bot as Bot
        if (!b.entity || !needsSurvival(b)) return 0
        if (!fired) {
          fired = true
          const s = startOverConfig(agent)
          // settings.startOver.go: once; the stored state (even settled or failed) keeps it from firing again
          if (s.go && !startOverState(agent)) beginStartOver(agent, b, 'settings', s.direction || undefined)
        }
        if (now < waitUntil || !startingOver(agent)) return 0
        const st = startOverState(agent)!
        const light = daylightMs(b)
        if (st.phase === 'packing' && light < 120_000) return 0 // leaves at daybreak; home is the place to be tonight
        return st.phase === 'travelling' && light === 0 ? START_OVER_NIGHT_SCORE : START_OVER_SCORE
      },
      async run (ctx) {
        const bot = ctx.bot as Bot
        const s = startOverConfig(agent)
        let st = startOverState(agent)
        if (!st || !startingOver(agent)) return { ok: true, message: 'not starting over' }
        const pos = bot.entity.position
        const here = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) }
        const night = daylightMs(bot) === 0
        if (!night && st.shelterFails) { st = { ...st, shelterFails: 0 }; save(st) }
        const facts: StepFacts = { pos: here, isNight: night, daylightMs: daylightMs(bot), avoided: avoidedAt(bot, s, here) }
        if (looked && Math.hypot(looked.x - here.x, looked.z - here.z) < 16) facts.site = looked.facts
        const step = startOverStep(st, facts, s)
        switch (step.do) {
          case 'none': return { ok: true, message: 'nothing to do' }
          case 'pack': {
            if (agent.getAction('check_chests')) await ctx.act('check_chests', { radius: 48, max: 8 })
            // room first: what isn't worth packing goes into the old chests
            const used = bot.inventory.items().length
            if (used > 24 && agent.getAction('deposit')) {
              const keep = [...new Set(bot.inventory.items().map(itemName))].filter(n => packValue(n, m => foodPoints(bot, m), s.take, s.leave))
              const d = await ctx.act('deposit', { item: 'all', keep })
              noteStartOver(agent, bot, 'room', `made room: ${d.message}`)
            }
            const r = await ctx.act('start_over_pack', {})
            const took = (r.data as { took?: Record<string, number> } | undefined)?.took ?? {}
            noteStartOver(agent, bot, 'pack', r.message, { took })
            const heading = st.heading ?? chooseHeading(st.origin, avoidPoints(bot, s), s.maxDistance, st.direction ?? s.direction)
            const dropped = abandonOldBase(agent, st.origin)
            st = { ...st, phase: 'travelling', heading, packed: took, legs: 0, fails: 0, turns: 0, legsSinceTurn: 0, farthest: 0 }
            save(st)
            noteStartOver(agent, bot, 'leave', `left the old base ${fmtPos(st.origin)} (kept as place old_base), heading ${angleCompass(heading)}; dropped ${dropped.length} base keys`, { heading })
            tell(bot, `starting over: packed ${fmtTally(took)}, heading ${angleCompass(heading)} to find a better place (${s.minDistance}+ blocks)`)
            return { ok: true, message: `packed and left, heading ${angleCompass(heading)}` }
          }
          case 'shelter': {
            const r = await ctx.act('bunker', { untilDay: true, maxMinutes: 15 })
            if (r.ok) { noteStartOver(agent, bot, 'night', r.message); return r }
            if (/already under cover/.test(r.message)) { await sleep(15_000, ctx.signal); return { ok: true, message: 'waiting out the night under cover' } }
            st = { ...st, shelterFails: (st.shelterFails ?? 0) + 1 }
            save(st)
            noteStartOver(agent, bot, 'night', `couldn't dig in (${st.shelterFails}/3): ${r.message}`)
            if ((st.shelterFails ?? 0) < 3) await ctx.act('start_over_leg', { x: here.x + 12, z: here.z + 12, minutes: 0.5 })
            return r
          }
          case 'wait': {
            await sleep(10_000, ctx.signal)
            return { ok: true, message: step.why }
          }
          case 'look': {
            const f = lookAround(agent, bot)
            looked = { x: here.x, z: here.z, facts: f }
            const v = siteVerdict(f, s)
            st = { ...st, best: betterBest(st.best, here, v, fallbackOk(f, s)) }
            save(st)
            noteStartOver(agent, bot, 'look', `${fmtPos(here)} ${Math.round(Math.hypot(here.x - st.origin.x, here.z - st.origin.z))} from the old base: ${v.ok ? 'good' : 'no'}: ${factsText(f)}`, { facts: f, ok: v.ok, score: v.score })
            return { ok: true, message: v.why }
          }
          case 'leg': {
            const r = await ctx.act('start_over_leg', { x: step.target.x, z: step.target.z, minutes: s.legMinutes })
            const moved = (r.data as { moved?: number } | undefined)?.moved ?? 0
            const p = bot.entity.position
            const dist = Math.hypot(p.x - st.origin.x, p.z - st.origin.z)
            st = { ...st, legs: (st.legs ?? 0) + 1, legsSinceTurn: (st.legsSinceTurn ?? 0) + 1, fails: !r.ok && moved < 16 ? (st.fails ?? 0) + 1 : 0, farthest: Math.max(st.farthest ?? 0, dist) }
            save(st)
            looked = null
            noteStartOver(agent, bot, 'leg', `leg ${st.legs} ${angleCompass(step.heading)}: ${r.message}; ${Math.round(dist)} from the old base`, { ok: r.ok, moved: Math.round(moved), dist: Math.round(dist) })
            return r
          }
          case 'turn': {
            st = { ...st, heading: step.heading, turns: (st.turns ?? 0) + 1, legsSinceTurn: 0, fails: 0 }
            save(st)
            noteStartOver(agent, bot, 'turn', `${step.why}: turning ${angleCompass(step.heading)}`)
            return { ok: true, message: step.why }
          }
          case 'give_up': {
            st = { ...st, phase: 'failed', doneAt: Date.now(), note: step.why }
            save(st)
            agent.storage.delete(HOME_AWAY_KEY)
            if (!getHome(agent)) setHome(agent, { ...here, dimension: bot.game?.dimension })
            noteStartOver(agent, bot, 'give_up', `${step.why}; home is here now, ${fmtPos(here)}`)
            tell(bot, `couldn't find a better place: ${step.why}. I'll make do here (${fmtPos(here)})`)
            return { ok: false, message: step.why }
          }
          case 'settle': {
            if (st.phase !== 'settling') { st = { ...st, phase: 'settling', target: { x: step.at.x, y: step.at.y, z: step.at.z, why: step.why } }; save(st) }
            let h = await ctx.act('start_over_settle', { x: step.at.x, y: step.at.y, z: step.at.z })
            if (!h.ok) h = await ctx.act('start_over_settle', here) // can't get there: right here then
            if (!h.ok) { waitUntil = Date.now() + 30_000; return h }
            const notes = [h.message]
            if (bot.inventory.items().some(i => /_bed$/.test(itemName(i))) && agent.getAction('place_bed')) {
              const b = await ctx.act('place_bed', { range: 6 })
              notes.push(b.message)
            }
            if (agent.getAction('place_chest')) {
              const c = await ctx.act('place_chest', { range: 6 })
              notes.push(c.message)
              const stash: Record<string, number> = {}
              for (const i of bot.inventory.items()) if (STASH.test(itemName(i))) stash[itemName(i)] = (stash[itemName(i)] ?? 0) + i.count
              if (c.ok && Object.keys(stash).length && agent.getAction('deposit')) {
                const d = await ctx.act('deposit', { items: stash })
                notes.push(d.message)
              }
            }
            const home = getHome(agent)
            st = { ...st, phase: 'settled', doneAt: Date.now(), note: notes.join('; ') }
            save(st)
            noteStartOver(agent, bot, 'settle', `settled at ${home ? fmtPos(home) : fmtPos(here)} (${step.why}): ${notes.join('; ')}`, { home })
            tell(bot, `started over at ${home ? fmtPos(home) : fmtPos(here)}, ${Math.round(Math.hypot(here.x - st.origin.x, here.z - st.origin.z))} blocks from the old base: ${step.why}`)
            return { ok: true, message: `settled at ${home ? fmtPos(home) : fmtPos(here)}` }
          }
        }
      }
    }
  }
})
