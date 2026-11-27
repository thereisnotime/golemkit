// Mineflayer glue for the retreat rule (retreatPlan.ts): reads the threats, armour and
// difficulty off the bot and asks the planner whether to leave. fight.ts calls retreatCheck()
// every tick of a fight; the reflexes call it to start defend early. escape.ts runs the routes.
import type { Bot } from 'mineflayer'
import type { Agent } from '../core/index.ts'
import { isHostile, FLYING } from '../core/index.ts'
import { incomingDamage, retreatDecision, armourDefence, retreatSettings, type RetreatSettings, type Risk, type Threat, type Difficulty } from './retreatPlan.ts'
import { shouldDisengageToHeal } from './tactics.ts'
import { isRangedMob } from './weapons.ts'
import { lineOfSight } from './fight.ts'
import { bestFood } from './survival.ts'

export function retreatOf (agent: Agent): RetreatSettings {
  return retreatSettings((agent.settings as { retreat?: unknown }).retreat)
}

/** Hostiles within 16 blocks as the planner sees them (ranged ones with their line of sight). */
export function threatsAround (bot: Bot, r = 16): (Threat & { id: number, ranged: boolean, flying: boolean, pos: { x: number, y: number, z: number } })[] {
  const me = bot.entity.position
  const out: (Threat & { id: number, ranged: boolean, flying: boolean, pos: { x: number, y: number, z: number } })[] = []
  for (const e of Object.values(bot.entities)) {
    if (e === bot.entity || !e.position || !isHostile(e)) continue
    const hp = ((e as any).metadata as unknown[] | undefined)?.[9]
    if (typeof hp === 'number' && hp <= 0) continue
    const dist = e.position.distanceTo(me)
    if (dist > r) continue
    const ranged = isRangedMob(e.name)
    out.push({ id: e.id, name: e.name ?? '', dist, ranged, flying: FLYING.has(e.name ?? ''), los: ranged ? lineOfSight(bot, e) : true, pos: e.position })
  }
  return out
}

const ARMOUR_SLOTS = [5, 6, 7, 8]

export function defenceOf (bot: Bot): { points: number, toughness: number, shield: boolean } {
  const worn = ARMOUR_SLOTS.map(i => bot.inventory.slots[i]?.name)
  return { ...armourDefence(worn), shield: bot.inventory.slots[45]?.name === 'shield' }
}

export function difficultyOf (bot: Bot): Difficulty | null {
  const d = (bot.game as any)?.difficulty
  return d === 'peaceful' || d === 'easy' || d === 'normal' || d === 'hard' ? d : null
}

export function riskNow (bot: Bot, s: RetreatSettings): Risk {
  return incomingDamage({ threats: threatsAround(bot), defence: defenceOf(bot), difficulty: difficultyOf(bot), hits: s.hits, shieldBlocks: s.shieldBlocks })
}

// ---- leaving, with memory (hysteresis across fights) ----

const leavingUntil = new WeakMap<Bot, number>()
/** How long "leaving" is remembered after the last time the rule fired. */
const LEAVING_MS = 90_000

export function leaving (bot: Bot): boolean {
  return (leavingUntil.get(bot) ?? 0) > Date.now()
}
export function clearLeaving (bot: Bot): void { leavingUntil.delete(bot) }

/**
 * Why the bot should leave the fight now, or null. With settings.retreat.enabled off it is the
 * old rule (combat.disengageToHeal at 4 health when backing off heals). Remembers that it is
 * leaving, so the next check (and the next fight) uses the hysteresis bar.
 */
export function retreatCheck (bot: Bot, s: RetreatSettings | undefined, disengageToHeal = true): string | null {
  const apple = bot.inventory.items().some(i => /^(enchanted_)?golden_apple$/.test(i.name))
  if (!s || !s.enabled) {
    return shouldDisengageToHeal({ enabled: disengageToHeal, health: bot.health, food: bot.food, hasFood: !!bestFood(bot), hasGoldenApple: apple })
      ? `health ${Math.ceil(bot.health)}`
      : null
  }
  if (!disengageToHeal) return null
  const d = retreatDecision({ health: bot.health, risk: riskNow(bot, s), leaving: leaving(bot), settings: s })
  if (d.leave) leavingUntil.set(bot, Date.now() + LEAVING_MS)
  else if (leaving(bot) && bot.health >= s.returnAbove) clearLeaving(bot)
  return d.why
}

// ---- what happened, for status, logs and the bench ----

export interface RetreatEvent { at: number, why: string, route: string | null, ok: boolean, detail: string }
const history = new WeakMap<Bot, RetreatEvent[]>()

export function noteRetreat (bot: Bot, e: RetreatEvent): void {
  let h = history.get(bot)
  if (!h) history.set(bot, h = [])
  h.push(e)
  if (h.length > 200) h.shift()
}

/** The escapes this bot made since it connected (oldest first). */
export function retreatHistory (bot: Bot): readonly RetreatEvent[] {
  return history.get(bot) ?? []
}
