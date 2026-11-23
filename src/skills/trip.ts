// Minecraft wiring for trips (the planner and the shared trip context are game-agnostic, in
// core/trip.ts): what the bot carries and how much daylight is left, the pantry top-up and
// weapon before leaving (prepare_trip), the budget timer that says turn back, and the walk home.
//
// Behaviours wrap their trips with tripRun (adapter behaviours/trip.ts), which calls
// prepare_trip through ctx.act; actions that leave home on their own (chop_tree past 64 blocks,
// upgrade_tools going for ore) use actionTrip from inside the action.
import type { Bot } from 'mineflayer'
import {
  defineAction, z, ok, fail, fmtPos, itemName, travel, checkAborted,
  tripSettings, planTripPrep, tripNotReadyText, tripStart, turnBackReason, beginTrip, activeTrip, endTrip, TripTurnBackError, DAYLIGHT_MS,
  type Agent, type ActionContext, type ActionResult, type Caller, type Logger,
  type TripSettings, type TripKind, type TripKit, type TripSample, type TripPrep, type Trip
} from '../core/index.ts'
import { takeFoodFromOwnChests, knownContainers, ownChests, configuredChests } from './containers.ts'
import { getHome, sameDimension } from './navigation.ts'

const BAD_FOOD = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'suspicious_stew', 'chorus_fruit'])
const WEAPON = /(_sword|_axe)$|^(trident|mace)$/
/** Own chests further than this are not walked to for the top-up (keep_fed's pantry range). */
export const PANTRY_RANGE = 160
/** How often the budget is checked on a trip. */
const CHECK_MS = 2000

/** Food points of an item, 0 for non-food and food that hurts. */
export function foodPoints (bot: Bot, name: string): number {
  if (BAD_FOOD.has(name)) return 0
  const f = (bot.registry as any).foodsByName?.[name]
  return f ? Math.max(1, f.foodPoints ?? 1) : 0
}

/** settings.trips for this bot. */
export function tripConfig (agent: Agent): TripSettings {
  return tripSettings((agent.settings as { trips?: unknown } | undefined)?.trips)
}

/** Whether a call from `caller` gets trip preparation and a budget: not owner orders, unless trips.ownerOrders. */
export function tripApplies (agent: Agent, caller: Caller | undefined, s = tripConfig(agent)): boolean {
  if (!s.enabled) return false
  return caller?.kind !== 'player' || s.ownerOrders
}

/** Milliseconds of daylight left now (0 at night), from the world time. */
export function daylightMs (bot: Bot): number {
  const t = bot.time?.timeOfDay
  if (typeof t !== 'number') return DAYLIGHT_MS
  if (t >= 12_542 && t <= 23_459) return 0
  const ticks = t > 23_459 ? 24_000 - t + 12_542 : 12_542 - t
  return ticks * 50
}

/** The body now, for the budget. */
export function tripSample (bot: Bot, agent: Agent): TripSample {
  let carried = 0
  let items = 0
  for (const i of bot.inventory?.items() ?? []) {
    const p = foodPoints(bot, itemName(i))
    if (p) { carried += p * i.count; items += i.count }
  }
  const home = getHome(agent)
  const pos = bot.entity?.position
  const distanceHome = home && pos && sameDimension(bot, home) ? Math.hypot(home.x - pos.x, home.z - pos.z) : null
  const storm = ((bot as { thunderState?: number }).thunderState ?? 0) > 0
  return { bar: typeof bot.food === 'number' ? bot.food : 20, carried, items, distanceHome, daylightMs: daylightMs(bot), ...(storm ? { storm } : {}) }
}

/** Food items in own and configured chests within range, from what the bot saw inside them (unseen chests count as unknown). */
function pantryFood (bot: Bot, agent: Agent): { items: number, unseen: number } {
  const pos = bot.entity.position
  const own = [...ownChests(agent), ...configuredChests(agent)]
    .filter((p, i, a) => a.findIndex(q => q.x === p.x && q.y === p.y && q.z === p.z) === i)
    .filter(p => Math.hypot(p.x - pos.x, p.y - pos.y, p.z - pos.z) <= PANTRY_RANGE)
  const seen = knownContainers(agent)
  let items = 0
  let unseen = 0
  for (const p of own) {
    const c = seen.find(k => k.x === p.x && k.y === p.y && k.z === p.z)
    if (!c) { unseen++; continue }
    for (const [n, v] of Object.entries(c.contents)) if (foodPoints(bot, n)) items += v
  }
  return { items, unseen }
}

/** What the bot has for the pre-trip check. `pantryItems` counts an unseen own chest as worth a look. */
export function tripKit (bot: Bot, agent: Agent, s: TripSettings): TripKit {
  const inv = bot.inventory?.items() ?? []
  const foodItems = inv.reduce((n, i) => n + (foodPoints(bot, itemName(i)) ? i.count : 0), 0)
  const pantry = pantryFood(bot, agent)
  return {
    foodItems,
    pantryItems: pantry.items + (pantry.unseen ? s.food : 0),
    weapon: inv.some(i => WEAPON.test(itemName(i))) || WEAPON.test(bot.heldItem ? itemName(bot.heldItem) : ''),
    health: typeof bot.health === 'number' ? bot.health : 20,
    bar: typeof bot.food === 'number' ? bot.food : 20
  }
}

export interface TripSpec {
  /** What for, short: "scouting for food", "trees 250 blocks out". */
  purpose: string
  kind: TripKind
  /** Planned one-way distance from home, when known. */
  distance?: number
  /** Checks the caller lifts. */
  waive?: ('weapon' | 'food' | 'health')[]
}

/** The best weapon carried, in the hand. */
async function holdWeapon (bot: Bot): Promise<string | null> {
  const held = bot.heldItem ? itemName(bot.heldItem) : ''
  const best = (bot.inventory?.items() ?? []).filter(i => WEAPON.test(itemName(i)))
    .sort((a, b) => rank(itemName(b)) - rank(itemName(a)))[0]
  if (!best) return WEAPON.test(held) ? held : null
  if (held === itemName(best) || (WEAPON.test(held) && rank(held) >= rank(itemName(best)))) return held
  await bot.equip(best, 'hand').catch(() => {})
  return itemName(best)
}
const TIERS = ['wooden', 'golden', 'stone', 'iron', 'diamond', 'netherite']
function rank (name: string): number {
  return (name.endsWith('_sword') ? 10 : 0) + Math.max(0, TIERS.indexOf(name.split('_')[0] ?? ''))
}

/**
 * The pre-trip check, run inside an action (it opens chests and walks): tops up food from the
 * pantry and own chests to trips.food items, holds the best weapon, then checks again. Fails
 * with what is missing when it shouldn't go; ok (data.prep) when it may.
 */
export async function prepareTrip (ctx: Pick<ActionContext, 'bot' | 'agent' | 'signal' | 'log'>, spec: TripSpec, s = tripConfig(ctx.agent)): Promise<ActionResult> {
  const { bot, agent, signal, log } = ctx
  let plan = planTripPrep(tripKit(bot, agent, s), s, spec.kind, spec.waive)
  const notes: string[] = []
  if (plan.topUp > 0) {
    const r = await takeFoodFromOwnChests({ bot, agent, signal }, plan.topUp, PANTRY_RANGE, n => foodPoints(bot, n))
      .catch(e => { checkAborted(signal); return { took: {}, units: 0, notes: [(e as Error).message] } })
    if (r.units) notes.push(`took ${Object.entries(r.took).map(([k, v]) => `${v} ${k}`).join(', ')} from my chest`)
    if (r.notes.length) log.debug('trip top-up', { notes: r.notes })
  }
  const held = await holdWeapon(bot)
  if (held) notes.push(`holding ${held}`)
  // again, with what it carries now (the pantry has been looked into)
  plan = planTripPrep({ ...tripKit(bot, agent, s), pantryItems: 0 }, s, spec.kind, spec.waive)
  if (!plan.go) {
    log.info('not leaving on a trip', { purpose: spec.purpose, missing: plan.missing })
    return fail(`${tripNotReadyText(plan, spec.purpose)}${notes.length ? ` (${notes.join('; ')})` : ''}`, { notReady: true, trip: true, missing: plan.missing })
  }
  const starving = plan.starving ? ` (starving, so going anyway: ${plan.missing.join(', ')})` : ''
  return ok(`ready for ${spec.purpose}${notes.length ? `: ${notes.join('; ')}` : ''}${starving}`, { prep: plan })
}

/** The budget for a trip that just started: a timer checks it and turns the trip back. */
export function startBudget (bot: Bot, agent: Agent, spec: TripSpec, s: TripSettings, prep: Pick<TripPrep, 'starving'> | null, log?: Logger): { trip: Trip, stop (): void } {
  const start = tripStart(tripSample(bot, agent), !!prep?.starving, spec.distance, DAYLIGHT_MS, s.speed)
  const trip = beginTrip(bot, { purpose: spec.purpose, kind: spec.kind, settings: s, start })
  log?.debug('trip started', { purpose: spec.purpose, reserve: start.reserve, dark: start.dark, starving: start.starving })
  const timer = setInterval(() => {
    if (trip.turnBack || trip.returning) return
    try {
      const why = turnBackReason(trip.start, tripSample(bot, agent), s)
      if (why) { log?.info('trip: turning back', { purpose: spec.purpose, why }); trip.turn(why) }
    } catch {}
  }, CHECK_MS)
  return { trip, stop: () => { clearInterval(timer); endTrip(bot, trip) } }
}

/** "turned back: <why> (<purpose>)". */
export function turnedBackText (trip: Trip, home?: ActionResult): string {
  const tail = !home ? '' : home.ok ? ', back home' : `; ${home.message}`
  return `turned back: ${trip.turnBack} (${trip.purpose})${tail}`
}

/**
 * Whispers an online owner once per trip. With no owner online it only logs: a turn-back is
 * routine (every dusk), not something to say in public chat.
 */
export function reportTurnBack (agent: Agent, bot: Bot, text: string): void {
  try {
    const owner = agent.owners.find(o => bot.players?.[o])
    if (owner) agent.whisper(owner, text)
    else agent.log.info(text)
  } catch {}
}

/**
 * A trip that starts inside an action (chop_tree past 64 blocks, upgrade_tools going for ore):
 * begin() prepares and starts the budget the first time the action leaves home (and returns why
 * not when it shouldn't go), finish() walks home after a turn-back and says so, end() always.
 * Joins a trip a behaviour already started; owner orders get none unless trips.ownerOrders.
 */
export function actionTrip (ctx: ActionContext, spec: TripSpec) {
  const { bot, agent, signal, log } = ctx
  const s = tripConfig(agent)
  const applies = tripApplies(agent, ctx.caller, s)
  let budget: { trip: Trip, stop (): void } | null = null
  let began = false
  return {
    /** Null to go on, else why not. */
    async begin (distance?: number): Promise<string | null> {
      if (began || !applies || activeTrip(bot)) return null
      if (distance !== undefined && distance < s.minDistance) return null
      began = true
      const r = await prepareTrip(ctx, { ...spec, ...(distance !== undefined ? { distance } : {}) }, s)
      if (!r.ok) return r.message
      budget = startBudget(bot, agent, { ...spec, ...(distance !== undefined ? { distance } : {}) }, s, (r.data as { prep?: TripPrep })?.prep ?? null, log)
      return null
    },
    /** The trip this action started (null when it joined one or none). */
    get trip (): Trip | null { return budget?.trip ?? null },
    /** After a turn-back (an error or the budget): walks home and returns the result to report. */
    async finish (r: ActionResult): Promise<ActionResult> {
      const trip = budget?.trip
      if (!trip?.turnBack) return r
      trip.returning = true
      const home = getHome(agent)
      let back: ActionResult = fail('no home set')
      if (home && sameDimension(bot, home)) {
        try { await travel(bot, home, signal, { range: 4 }); back = ok('home') } catch (e) { checkAborted(signal); back = fail(`couldn't get home (${(e as Error).message}), at ${fmtPos(bot.entity.position)}`) }
      }
      const text = turnedBackText(trip, back)
      reportTurnBack(agent, bot, text)
      // what it got before turning back still counts
      if (r.ok) return ok(`${r.message}; ${text}`, r.data)
      return fail(/^turned back/.test(r.message) ? text : `${text} (${r.message})`, { turnedBack: trip.turnBack })
    },
    end (): void { budget?.stop(); budget = null }
  }
}

/** Whether an error is the trip budget's turn-back. */
export const isTurnBack = (e: unknown): e is TripTurnBackError => e instanceof TripTurnBackError

const KINDS = ['food', 'wood', 'wool', 'ore', 'travel'] as const

export const prepareTripAction = defineAction({
  name: 'prepare_trip',
  description: 'Get ready to leave home: take food from my pantry and own chests up to trips.food items, hold my best weapon, ' +
    'and check health. Fails with what is missing (no weapon, too little food, low health) when I should not go; ' +
    'a food trip while starving goes anyway.',
  params: z.object({
    purpose: z.string().max(80).default('a trip').describe('what the trip is for, for the report'),
    kind: z.enum(KINDS).default('travel').describe('food trips may go while starving; the others need the kit'),
    distance: z.number().min(0).max(100_000).optional().describe('planned distance from home, in blocks'),
    waive: z.array(z.enum(['weapon', 'food', 'health'])).default([]).describe('checks to skip for this trip')
  }),
  capabilities: ['move', 'inventory', 'containers'],
  run: (ctx, p) => prepareTrip(ctx, { purpose: p.purpose, kind: p.kind, waive: p.waive, ...(p.distance !== undefined ? { distance: p.distance } : {}) })
})
