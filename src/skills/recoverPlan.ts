// Getting the bot's own things back after a death (pure). Vanilla drops everything where the bot
// died and the items despawn 6000 ticks (5 minutes) later; lava and the void destroy them. The
// recover_drops behaviour asks recoverDecision right after the respawn whether a trip is worth it
// and safe enough (go / wait / skip), the recover_items action asks tripCheck on the way whether to
// give up, and recoveryReport writes the line for the owner. Tests: test/recover-plan.test.ts.
import { gearScore, type GearView } from './ranged-plan.ts'
import { DESPAWN_MS } from './searchPlan.ts'

export { DESPAWN_MS }

export interface Pos3 { x: number, y: number, z: number }
export interface LostItem { name: string, count: number }

/** What the bot knew at the moment it died. */
export interface DeathSite {
  /** Epoch ms of the death event. */
  diedAt: number
  pos: Pos3 | null
  dimension?: string
  /** Report category: slain, shot, explosion, fall, lava, fire, drowning, void... */
  kind: string
  /** Killer from the death message ("Skeleton", "Steve"). */
  killer?: string
  /** Damage sources in the last seconds, newest first. */
  recentDamage: string[]
  /** Hostiles within 8 blocks at the death, by type with counts (skeleton: 3). */
  hostiles: Record<string, number>
  /** What it carried just before (armour and offhand included). */
  lost: LostItem[]
  /** It was night when it died. */
  night?: boolean
  /** The death spot had open sky (sky light), so undead burn there by day. Unknown = assume not. */
  openSky?: boolean
}

/** The bot after the respawn. */
export interface RecoverWorld {
  now: number
  here: Pos3
  dimension?: string
  gear: GearView
  night: boolean
  /** Items in the inventory now (after a death without keepInventory: 0). */
  carried: number
  /** Hostiles seen near the death spot now, when it is within tracking range; null when unknown. */
  liveHostiles?: Record<string, number> | null
  /** Water blocks above the death spot (from the floor up); null when the chunk isn't loaded. */
  waterAbove?: number | null
  /** Players online (to tell a player killer from a mob). */
  players?: string[]
  /** Lowest block y of the dimension; below it is the void. Default -64. */
  minY?: number
}

export interface RecoverOptions {
  /** Farthest death spot worth a trip, straight line. Default 400. */
  maxDistance?: number
  /** Travel speed in blocks/s used for the estimate (walking is 4.3, sprinting 5.6). Default 4.3. */
  speed?: number
  /** Paths are longer than the straight line by this factor. Default 1.3. */
  pathFactor?: number
  /** Time to keep in hand on arrival for picking up, seconds. Default 30. */
  marginSeconds?: number
  /** Despawn time in ms. Default 5 minutes. */
  despawnMs?: number
  /** At night with gear under nightGear, only spots this close. Default 48. */
  nightMaxDistance?: number
  /** Gear score (ranged-plan gearScore: 15 naked at full health, about 72 in iron with a shield) that makes night trips fine. Default 40. */
  nightGear?: number
  /** Threat points (a zombie 1, a skeleton 1.5, a witch 2) that are fine with any gear. Default 1. */
  freeThreat?: number
  /** Gear score needed per threat point above that, on top of 15. Default 12 (3 skeletons need 69: iron, a shield and a sword). */
  gearPerThreat?: number
  /** Never go back where a player killed it. Default true. */
  avoidPlayerKillers?: boolean
  /** More water than this above the spot: too deep to dive for. Default 8. */
  maxWaterDepth?: number
  /** Give up on the way at or below this health. Default 8. */
  giveUpHealth?: number
}

export const RECOVER_DEFAULTS: Required<RecoverOptions> = {
  maxDistance: 400,
  speed: 4.3,
  pathFactor: 1.3,
  marginSeconds: 30,
  despawnMs: DESPAWN_MS,
  nightMaxDistance: 48,
  nightGear: 40,
  freeThreat: 1,
  gearPerThreat: 12,
  avoidPlayerKillers: true,
  maxWaterDepth: 8,
  giveUpHealth: 8
}

export type RecoverDecision =
  | { do: 'go', why: string, etaMs: number, leftMs: number, distance: number }
  | { do: 'wait', why: string, retryMs: number }
  /** gone: the drops can't be had at all (lava, void, despawned, another dimension, nothing lost); otherwise force could still try. */
  | { do: 'skip', why: string, gone?: boolean }

/** Threat points per mob type; unlisted hostiles count 1.5. */
const THREAT: Record<string, number> = {
  zombie: 1, zombie_villager: 1, husk: 1, drowned: 1.5, skeleton: 1.5, stray: 1.5, bogged: 1.5,
  spider: 1, cave_spider: 1.5, creeper: 1.5, witch: 2, pillager: 1.5, vindicator: 2.5, enderman: 2,
  slime: 0.5, magma_cube: 1, blaze: 2, wither_skeleton: 2.5, zombified_piglin: 1, piglin: 1, piglin_brute: 4,
  hoglin: 2.5, zoglin: 2.5, ghast: 2, phantom: 1, silverfish: 0.5, endermite: 0.5, guardian: 2, vex: 1.5, breeze: 2
}
/** Never worth walking back into, whatever the gear. */
const DEADLY = new Set(['warden', 'ravager', 'evoker', 'elder_guardian', 'wither', 'ender_dragon'])
/** Burn in daylight under open sky. */
const UNDEAD_BURN = new Set(['zombie', 'zombie_villager', 'skeleton', 'stray', 'phantom', 'drowned'])

/** "Cave Spider" / "cave_spider" -> "cave_spider". */
export function mobKey (name: string): string {
  return name.trim().toLowerCase().replace(/^minecraft:/, '').replace(/\s+/g, '_')
}

const s = (ms: number) => ms >= 90_000 ? `${Math.round(ms / 60_000)} min` : `${Math.max(0, Math.round(ms / 1000))} s`
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : w.endsWith('s') ? '' : 's'}`

/** Threat points of a set of mobs: weights times counts, undead quartered when they burn (day, open sky). */
export function threatPoints (mobs: Record<string, number>, o: { burning?: boolean } = {}): number {
  let n = 0
  for (const [name, count] of Object.entries(mobs)) {
    const k = mobKey(name)
    if (DEADLY.has(k)) return Infinity
    const w = THREAT[k] ?? 1.5
    n += w * count * (o.burning && UNDEAD_BURN.has(k) ? 0.25 : 1)
  }
  return Math.round(n * 10) / 10
}

/** Gear score needed to walk into this many threat points (0 when they are below freeThreat). */
export function gearForThreat (points: number, o: Pick<RecoverOptions, 'freeThreat' | 'gearPerThreat'> = {}): number {
  const free = o.freeThreat ?? RECOVER_DEFAULTS.freeThreat
  if (points <= free) return 0
  if (!Number.isFinite(points)) return Infinity
  return Math.round(15 + (o.gearPerThreat ?? RECOVER_DEFAULTS.gearPerThreat) * points)
}

/** "3 skeleton, zombie" */
export function describeMobs (mobs: Record<string, number>): string {
  return Object.entries(mobs).filter(([, n]) => n > 0).map(([k, n]) => n > 1 ? `${n} ${mobKey(k)}` : mobKey(k)).join(', ')
}

/** The mobs to expect at the spot: the live view when there is one, else the report (the killer counted once). */
export function expectedMobs (site: DeathSite, live?: Record<string, number> | null, players: string[] = []): Record<string, number> {
  if (live) return { ...live }
  const out: Record<string, number> = {}
  for (const [k, n] of Object.entries(site.hostiles)) out[mobKey(k)] = (out[mobKey(k)] ?? 0) + n
  const killer = site.killer ? mobKey(site.killer) : null
  const isPlayer = !!site.killer && players.some(p => p.toLowerCase() === site.killer!.toLowerCase())
  if (killer && !isPlayer && !out[killer] && (THREAT[killer] !== undefined || DEADLY.has(killer))) out[killer] = 1
  // a creeper that blew the bot up is gone
  if (site.kind === 'explosion' && killer === 'creeper' && out.creeper) out.creeper -= 1
  for (const k of Object.keys(out)) if (out[k]! <= 0) delete out[k]
  return out
}

function total (items: LostItem[]): number {
  return items.reduce((n, i) => n + i.count, 0)
}

/**
 * Whether to go back for the drops now, wait (danger that may pass: night, mobs still there) or
 * give up. Checks, in order: anything lost; kept inventory; where; lava or void; dimension; deep
 * water; distance; time left at walking speed with a margin; a player killer; the mobs there
 * against the gear; night.
 */
export function recoverDecision (site: DeathSite, w: RecoverWorld, opts: RecoverOptions = {}): RecoverDecision {
  const o = { ...RECOVER_DEFAULTS, ...opts }
  const lost = total(site.lost)
  if (!lost) return { do: 'skip', why: 'I had nothing on me', gone: true }
  if (w.carried >= Math.ceil(lost * 0.8)) return { do: 'skip', why: 'I kept my inventory', gone: true }
  const at = site.pos
  if (!at) return { do: 'skip', why: "I don't know where I died", gone: true }
  if (site.kind === 'lava' || site.recentDamage[0] === 'lava') return { do: 'skip', why: 'my things burned in lava', gone: true }
  if (site.kind === 'void' || at.y < (w.minY ?? -64)) return { do: 'skip', why: 'my things fell out of the world', gone: true }
  if (site.dimension && w.dimension && site.dimension !== w.dimension) {
    return { do: 'skip', why: `I died in ${site.dimension.replace(/^minecraft:/, '')} and respawned in ${w.dimension.replace(/^minecraft:/, '')}`, gone: true }
  }
  if (typeof w.waterAbove === 'number' && w.waterAbove > o.maxWaterDepth) return { do: 'skip', why: `my things are ${w.waterAbove} blocks under water` }
  const distance = Math.round(Math.hypot(at.x - w.here.x, at.y - w.here.y, at.z - w.here.z))
  if (distance > o.maxDistance) return { do: 'skip', why: `I died ${distance} blocks away (more than ${o.maxDistance})` }
  const leftMs = Math.max(0, o.despawnMs - (w.now - site.diedAt))
  const etaMs = Math.round(distance * o.pathFactor / o.speed * 1000)
  const marginMs = o.marginSeconds * 1000
  if (leftMs <= 0) return { do: 'skip', why: `my things despawned (died ${s(w.now - site.diedAt)} ago)`, gone: true }
  if (etaMs + marginMs > leftMs) return { do: 'skip', why: `it's ${distance} blocks, about ${s(etaMs)} away, and my things despawn in ${s(leftMs)}` }
  // time to spare for waiting: what's left once the trip and the margin are paid
  const spare = leftMs - etaMs - marginMs
  const waitOr = (why: string): RecoverDecision => spare > 20_000 ? { do: 'wait', why, retryMs: Math.min(15_000, spare - 5000) } : { do: 'skip', why }
  const players = w.players ?? []
  if (o.avoidPlayerKillers && site.killer && players.some(p => p.toLowerCase() === site.killer!.toLowerCase())) {
    return { do: 'skip', why: `${site.killer} killed me there` }
  }
  const score = gearScore(w.gear)
  const mobs = expectedMobs(site, w.liveHostiles, players)
  const burning = !w.night && site.openSky === true
  const points = threatPoints(mobs, { burning }) + (w.night && site.openSky !== false ? 1 : 0)
  if (!Number.isFinite(points)) return { do: 'skip', why: `${describeMobs(mobs)} by my things, not going near that` }
  const need = gearForThreat(points, o)
  if (score < need) {
    const what = describeMobs(mobs) || 'mobs in the dark'
    return waitOr(`${what} by my things and my gear scores ${score} (${need} needed)`)
  }
  if (w.night && score < o.nightGear && distance > o.nightMaxDistance) {
    return waitOr(`night, ${distance} blocks out and my gear scores ${score} (${o.nightGear} for night trips)`)
  }
  return { do: 'go', why: `${distance} blocks, about ${s(etaMs)} away, ${s(leftMs)} before my things despawn`, etaMs, leftMs, distance }
}

export interface TripState {
  now: number
  /** When the drops despawn (epoch ms). */
  deadline: number
  /** Blocks left to the spot. */
  remaining: number
  health: number
  /** Mobs near the bot now, when it is close to the spot (live counts). */
  hostilesHere?: Record<string, number>
  gear?: GearView
  night?: boolean
  openSky?: boolean
}

/** On the way: keep going, or why to give up (despawn near, hurt badly, a danger zone it can't handle). */
export function tripCheck (t: TripState, opts: RecoverOptions = {}): { go: true } | { go: false, why: string } {
  const o = { ...RECOVER_DEFAULTS, ...opts }
  if (t.health <= o.giveUpHealth) return { go: false, why: `hurt badly on the way (health ${Math.round(t.health)})` }
  const eta = t.remaining * o.pathFactor / o.speed * 1000
  if (t.now + eta + 5000 > t.deadline) return { go: false, why: `my things despawn before I get there (${t.remaining} blocks left, ${s(t.deadline - t.now)} to go)` }
  if (t.hostilesHere && t.gear) {
    const points = threatPoints(t.hostilesHere, { burning: !t.night && t.openSky === true })
    const need = gearForThreat(points, o)
    const score = gearScore(t.gear)
    if (score < need) return { go: false, why: `too dangerous there: ${describeMobs(t.hostilesHere)} (gear ${score}, ${need} needed)` }
  }
  return { go: true }
}

/** "stone_sword" -> "stone sword". */
const display = (name: string) => name.replace(/^minecraft:/, '').replace(/_/g, ' ')

/**
 * How much of what was lost came back: per item the gain capped at what was lost (things
 * picked up on the way that it never had don't count). Returns the counts and a chat line.
 */
export function recoveryReport (lost: LostItem[], before: Record<string, number>, after: Record<string, number>, why?: string): { got: number, of: number, items: LostItem[], missing: LostItem[], text: string } {
  const of = total(lost)
  const want: Record<string, number> = {}
  for (const i of lost) want[i.name] = (want[i.name] ?? 0) + i.count
  const items: LostItem[] = []
  const missing: LostItem[] = []
  for (const [name, n] of Object.entries(want)) {
    const gain = Math.max(0, (after[name] ?? 0) - (before[name] ?? 0))
    const back = Math.min(n, gain)
    if (back) items.push({ name, count: back })
    if (back < n) missing.push({ name, count: n - back })
  }
  const got = total(items)
  const list = (xs: LostItem[], max = 8) => {
    const shown = xs.slice(0, max).map(i => i.count > 1 ? `${i.count} ${display(i.name)}` : display(i.name))
    return shown.join(', ') + (xs.length > max ? `, +${xs.length - max} more` : '')
  }
  // tools and armour first: they are what matters
  const rank = (i: LostItem) => /_(sword|axe|pickaxe|shovel|hoe|helmet|chestplate|leggings|boots)$|^(shield|bow|crossbow|trident|totem_of_undying)$/.test(i.name) ? 0 : 1
  items.sort((a, b) => rank(a) - rank(b))
  missing.sort((a, b) => rank(a) - rank(b))
  let text: string
  if (!got) text = `got nothing back of ${plural(of, 'item')}${why ? ` (${why})` : ''}`
  else {
    text = `got back ${got} of ${plural(of, 'item')}: ${list(items)}`
    if (missing.length) text += `; still missing ${list(missing, 5)}`
    if (why && got < of) text += ` (${why})`
  }
  return { got, of, items, missing, text }
}
