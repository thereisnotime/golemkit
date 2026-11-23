// Trips that behaviours start (keep_fed scouting and food trips, keep_spawn_bed looking for
// sheep): prepare (prepare_trip: pantry top-up, weapon, health), walk with a budget (food and
// daylight, core/trip.ts), and when the budget says turn back, go home and say why.
import type { Bot } from 'mineflayer'
import type { ActionResult } from '../../../core/index.ts'
import { activeTrip } from '../../../core/index.ts'
import type { BehaviorContext } from '../../../brains/npc/index.ts'
import { tripConfig, startBudget, turnedBackText, reportTurnBack, isTurnBack, type TripSpec } from '../../../skills/trip.ts'
import type { TripPrep } from '../../../core/index.ts'

/**
 * Runs `go` as a trip: prepare_trip first (a refusal is returned as the result, so the
 * behaviour backs off with the reason), then the budget while `go` runs. Short trips (under
 * trips.minDistance), trips inside a trip, and bots with trips.enabled off just run `go`.
 */
export async function tripRun (ctx: BehaviorContext, spec: TripSpec, go: () => Promise<ActionResult>): Promise<ActionResult> {
  const bot = ctx.bot as Bot
  const s = tripConfig(ctx.agent)
  if (!s.enabled || activeTrip(bot) || (spec.distance !== undefined && spec.distance < s.minDistance)) return go()
  let prep: TripPrep | null = null
  if (ctx.agent.getAction('prepare_trip')) {
    const r = await ctx.act('prepare_trip', { purpose: spec.purpose, kind: spec.kind, waive: spec.waive ?? [], ...(spec.distance !== undefined ? { distance: Math.round(spec.distance) } : {}) })
    if (!r.ok) return r
    prep = (r.data as { prep?: TripPrep } | undefined)?.prep ?? null
  }
  const budget = startBudget(bot, ctx.agent, spec, s, prep, ctx.log)
  try {
    let r: ActionResult
    try {
      r = await go()
    } catch (e) {
      if (!isTurnBack(e)) throw e
      r = { ok: false, message: (e as Error).message }
    }
    const trip = budget.trip
    if (!trip.turnBack) return r
    trip.returning = true
    const home = ctx.agent.getAction('go_home') ? await ctx.act('go_home', { range: 4 }) : undefined
    const text = turnedBackText(trip, home)
    reportTurnBack(ctx.agent, bot, text)
    return { ok: false, message: text, data: { turnedBack: trip.turnBack, ...(r.data && typeof r.data === 'object' ? { result: r.data } : {}) } }
  } finally {
    budget.stop()
  }
}
