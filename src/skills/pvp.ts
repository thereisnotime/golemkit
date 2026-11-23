// PvP policy (pure, unit-tested). combat.pvp picks how far the bot goes against players:
//   off      never fights a player (the framework default)
//   defend   fights back a player who hits it or the player it guards, stops when they stop or run
//   revenge  defend, plus it remembers players who killed or attacked the bot, an owner or the
//            guarded player, and attacks them on sight for combat.revengeMinutes or
//            combat.revengeKills kills, then forgives them
//   targets  attacks the players on combat.targets (owner commands: attack / stop attacking /
//            hunt), plus revenge entries
//   all      attacks every player in range, plus everything above
// Whatever the mode, owners, combat.friends and players in creative or spectator are never
// fought; with combat.spareProtected (default on) neither are players inside a protected area in
// the aggressive modes. Odds and chase rules below; fight technique is in pvp-tactics.ts.

export type PvpMode = 'off' | 'defend' | 'revenge' | 'targets' | 'all'
export const PVP_MODES: readonly PvpMode[] = ['off', 'defend', 'revenge', 'targets', 'all']

/** How long after the last hit a player still counts as attacking. */
export const PVP_CALM_MS = 5000
/** A player this far away (and not coming back) has fled (defend). */
export const PVP_FLED = 10

export function pvpMode (raw: unknown): PvpMode {
  return PVP_MODES.includes(raw as PvpMode) ? raw as PvpMode : 'off'
}

/** Modes in which the bot starts fights (revenge, targets, all). */
export function aggressive (mode: PvpMode): boolean {
  return mode === 'revenge' || mode === 'targets' || mode === 'all'
}

/** True when going from one mode to the other makes the bot more peaceful (all > targets > revenge > defend > off). */
export function deescalates (from: PvpMode, to: PvpMode): boolean {
  return PVP_MODES.indexOf(to) < PVP_MODES.indexOf(from)
}

// ---- settings ----

export interface PvpSettings {
  mode: PvpMode
  friends: string[]
  targets: string[]
  /** Revenge lasts this long (minutes). */
  revengeMinutes: number
  /** ...or until the bot killed them this many times. */
  revengeKills: number
  /** Start fights only with players within this many blocks. */
  engage: number
  /** Give up a chase this many blocks from where the fight started. */
  chase: number
  /** Give up after this many seconds without seeing the target. */
  lostSec: number
  /** Leave players in protected areas (spawn protection, claims) alone in the aggressive modes. */
  spareProtected: boolean
  /** Public lines when it engages and wins (default off). */
  taunts: boolean
  /** Odds (their time to kill us / ours to kill them) needed to start a fight in targets/all. */
  minOdds: number
  /** Revenge fights ignore the odds. */
  revengeIgnoresOdds: boolean
  /** The PvP tactics (pvp-tactics.ts); off = the plain mob fight loop. */
  tactics: boolean
  /** Hunts give up after this many minutes. */
  huntMinutes: number
}

const num = (v: unknown, d: number, lo: number, hi: number) => typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d
const names = (v: unknown): string[] => Array.isArray(v) ? v.map(String).filter(Boolean) : typeof v === 'string' && v ? v.split(',').map(s => s.trim()).filter(Boolean) : []

/** Reads settings.combat (profile plus live overrides) with the defaults. */
export function pvpSettings (combat: Record<string, unknown> | undefined): PvpSettings {
  const c = combat ?? {}
  return {
    mode: pvpMode(c.pvp),
    friends: names(c.friends),
    targets: names(c.targets),
    revengeMinutes: num(c.revengeMinutes, 30, 0, 24 * 60),
    revengeKills: num(c.revengeKills, 1, 1, 100),
    engage: num(c.pvpEngage, 16, 2, 64),
    chase: num(c.pvpChase, 48, 4, 256),
    lostSec: num(c.pvpLostSec, 30, 1, 600),
    spareProtected: c.spareProtected !== false,
    taunts: c.taunts === true,
    minOdds: num(c.pvpMinOdds, 0.7, 0, 10),
    revengeIgnoresOdds: c.revengeIgnoresOdds === true,
    tactics: c.pvpTactics !== false,
    huntMinutes: num(c.huntMinutes, 10, 1, 120)
  }
}

// ---- who is off limits ----

const lc = (s: string) => s.toLowerCase()
const listed = (list: readonly string[], name: string) => list.some(f => lc(f) === lc(name))

/** Never fought in any mode: owners and friends. */
export function spared (player: string, owners: readonly string[], friends: readonly string[]): string | null {
  if (listed(owners, player)) return 'an owner'
  if (listed(friends, player)) return 'a friend'
  return null
}

export interface PvpState {
  mode: PvpMode
  /** The attacker's username. */
  player: string
  /** The bot's owners (lower case). */
  owners: readonly string[]
  /** combat.friends (any case). */
  friends: readonly string[]
  /** ms since the player last hit the bot or the guarded player (Infinity: never). */
  sinceHitMs: number
  /** Distance from the bot, blocks. */
  dist: number
  /** The player is in creative or spectator (can't be hurt; pointless and rude). */
  invulnerable?: boolean
}

/** Why the bot must not fight this player back (null: it may defend itself against them). Any mode but off defends. */
export function pvpRefusal (s: Pick<PvpState, 'mode' | 'player' | 'owners' | 'friends' | 'invulnerable'>): string | null {
  if (s.mode === 'off') return 'combat.pvp is off'
  const no = spared(s.player, s.owners, s.friends)
  if (no) return no
  if (s.invulnerable) return 'in creative or spectator'
  return null
}

/** Defend: start or keep fighting back ('fight'), or stop ('stop', with why). */
export function pvpDecision (s: PvpState): { act: 'fight' } | { act: 'stop', why: string } {
  const no = pvpRefusal(s)
  if (no) return { act: 'stop', why: no }
  if (s.sinceHitMs > PVP_CALM_MS) return { act: 'stop', why: 'stopped attacking' }
  if (s.dist > PVP_FLED) return { act: 'stop', why: 'ran off' }
  return { act: 'fight' }
}

// ---- revenge ----

export interface RevengeEntry {
  player: string
  /** What they did: killed or attacked whom ('me' for the bot). */
  why: 'killed' | 'attacked'
  victim: string
  /** First and latest offence (ms epoch). */
  since: number
  at: number
  /** Revenge runs out at this time (ms epoch). */
  until: number
  /** Times the bot killed them since. */
  kills: number
}

/**
 * Adds or refreshes a revenge entry. Owners and friends are never recorded; a kill outranks an
 * attack; a repeat offence restarts the clock. Returns the new list (input untouched).
 */
export function addRevenge (list: readonly RevengeEntry[], o: { player: string, why: 'killed' | 'attacked', victim: string, now: number, minutes: number, owners: readonly string[], friends: readonly string[], self?: string }): RevengeEntry[] {
  if (spared(o.player, o.owners, o.friends) || (o.self && lc(o.self) === lc(o.player)) || o.minutes <= 0) return list.slice()
  const until = o.now + o.minutes * 60_000
  const old = list.find(e => lc(e.player) === lc(o.player))
  const rest = list.filter(e => e !== old)
  const why = old?.why === 'killed' || o.why === 'killed' ? 'killed' : 'attacked'
  const victim = o.why === 'killed' || !old ? o.victim : old.victim
  return [...rest, { player: old?.player ?? o.player, why, victim, since: old?.since ?? o.now, at: o.now, until: Math.max(until, old?.until ?? 0), kills: old?.kills ?? 0 }]
}

/** Drops expired entries and the players now on the owner or friends list. */
export function pruneRevenge (list: readonly RevengeEntry[], now: number, owners: readonly string[] = [], friends: readonly string[] = []): RevengeEntry[] {
  return list.filter(e => e.until > now && !spared(e.player, owners, friends))
}

/** The bot killed `player`: count it, and forgive them after `forgiveAfter` kills. */
export function revengeKill (list: readonly RevengeEntry[], player: string, forgiveAfter: number): { list: RevengeEntry[], forgiven: boolean } {
  const e = list.find(x => lc(x.player) === lc(player))
  if (!e) return { list: list.slice(), forgiven: false }
  const kills = e.kills + 1
  if (kills >= forgiveAfter) return { list: list.filter(x => x !== e), forgiven: true }
  return { list: list.map(x => x === e ? { ...x, kills } : x), forgiven: false }
}

export function activeRevenge (list: readonly RevengeEntry[], player: string, now: number): RevengeEntry | null {
  return list.find(e => lc(e.player) === lc(player) && e.until > now) ?? null
}

/** Should this offence be remembered? Only in revenge/targets/all, and only against the bot, an owner or the guarded player. */
export function revengeWorthy (s: { mode: PvpMode, victim: string, self: string, owners: readonly string[], guarded?: string | null }): boolean {
  if (!aggressive(s.mode)) return false
  const v = lc(s.victim)
  return v === 'me' || v === lc(s.self) || s.owners.some(o => lc(o) === v) || (!!s.guarded && lc(s.guarded) === v)
}

// ---- who to attack ----

export type AggroWhy = 'revenge' | 'target' | 'all'

export interface AggroCheck {
  mode: PvpMode
  player: string
  self: string
  owners: readonly string[]
  friends: readonly string[]
  targets: readonly string[]
  revenge: readonly RevengeEntry[]
  now: number
  invulnerable?: boolean
  /** The player stands in a protected area (spawn protection, a claim). */
  inProtected?: boolean
  spareProtected?: boolean
}

/**
 * Whether the bot may start a fight with this player on sight, and why: a revenge entry, the
 * target list, or mode all. `{ attack: false, why }` for everyone else.
 */
export function aggression (s: AggroCheck): { attack: true, why: AggroWhy } | { attack: false, why: string } {
  if (!aggressive(s.mode)) return { attack: false, why: `combat.pvp is ${s.mode}` }
  if (lc(s.player) === lc(s.self)) return { attack: false, why: 'myself' }
  const no = spared(s.player, s.owners, s.friends)
  if (no) return { attack: false, why: no }
  if (s.invulnerable) return { attack: false, why: 'in creative or spectator' }
  if (s.inProtected && s.spareProtected !== false) return { attack: false, why: 'in a protected area' }
  if (activeRevenge(s.revenge, s.player, s.now)) return { attack: true, why: 'revenge' }
  if ((s.mode === 'targets' || s.mode === 'all') && listed(s.targets, s.player)) return { attack: true, why: 'target' }
  if (s.mode === 'all') return { attack: true, why: 'all' }
  return { attack: false, why: s.mode === 'revenge' ? 'no grudge' : 'not a target' }
}

export interface Candidate { player: string, dist: number, why: AggroWhy, visible: boolean }

/**
 * The next player to engage: within `engage` blocks and in sight (or already close), revenge
 * before targets before everyone else, nearest first. Players the bot recently gave up on
 * (`cooling`) wait their turn.
 */
export function pickPvpTarget (list: readonly Candidate[], engage: number, cooling: ReadonlySet<string> = new Set()): Candidate | null {
  const rank: Record<AggroWhy, number> = { revenge: 0, target: 1, all: 2 }
  const ok = list.filter(c => c.dist <= engage && (c.visible || c.dist <= 4) && !cooling.has(lc(c.player)))
  ok.sort((a, b) => rank[a.why] - rank[b.why] || a.dist - b.dist)
  return ok[0] ?? null
}

// ---- odds ----

export interface Fighter {
  health: number
  /** Absorption hearts (golden apples). */
  absorption?: number
  /** Armour points (0-20) and toughness. */
  armor: number
  toughness?: number
  /** Best melee damage per hit (sword 6/7/8, axe 9/10) and attacks per second. */
  damage: number
  speed: number
  shield?: boolean
  totem?: boolean
  /** Golden apples carried. */
  apples?: number
}

/** Vanilla armour reduction: damage * (1 - min(20, max(a/5, a - 4d/(t+8))) / 25). */
export function afterArmor (damage: number, armor: number, toughness = 0): number {
  const a = Math.max(0, Math.min(30, armor))
  const red = Math.min(20, Math.max(a / 5, a - 4 * damage / (toughness + 8))) / 25
  return damage * (1 - red)
}

/** Damage per second one fighter deals the other: charged hits, about a third of them crits, a shield halving it. */
export function dps (att: Fighter, def: Fighter): number {
  const per = afterArmor(att.damage * 1.17, def.armor, def.toughness ?? 0)
  // a shield blocks some hits outright (an axe user turns it off for 5 s)
  const shieldFactor = def.shield ? 0.75 : 1
  return per * Math.min(att.speed, 1.6) * shieldFactor
}

/** Hit points to chew through: health, absorption, a totem (another life at 1 + regen), 4 per golden apple (absorption + regen). */
export function effectiveHealth (f: Fighter): number {
  return f.health + (f.absorption ?? 0) + (f.totem ? 8 : 0) + Math.min(4, f.apples ?? 0) * 4
}

/**
 * The bot's odds against `them`: the time they need to kill us over the time we need to kill
 * them. 1 is even, 2 means we win in half the time, under 0.5 means a beating.
 */
export function duelOdds (me: Fighter, them: Fighter): number {
  const mine = effectiveHealth(them) / Math.max(0.05, dps(me, them))
  const theirs = effectiveHealth(me) / Math.max(0.05, dps(them, me))
  return Math.round(theirs / mine * 100) / 100
}

/**
 * Engage? Revenge with combat.revengeIgnoresOdds goes regardless; otherwise the odds must reach
 * minOdds (default 0.7: a fight it might lose is fine, a beating is not).
 */
export function engageCheck (s: { why: AggroWhy, odds: number, minOdds: number, revengeIgnoresOdds: boolean }): string | null {
  if (s.why === 'revenge' && s.revengeIgnoresOdds) return null
  if (s.odds >= s.minOdds) return null
  return `odds ${s.odds} under ${s.minOdds}`
}

// ---- chase ----

/**
 * Keep chasing or give up: past `chase` blocks from where the fight started, out of sight for
 * `lostSec` seconds, or a pearl/teleport (the target jumped `jump` blocks in one tick) that lands
 * past the chase limit.
 */
export function chaseVerdict (s: { fromStart: number, dist: number, chase: number, outOfSightMs: number, lostSec: number, jump?: number }): string | null {
  if (s.fromStart > s.chase) return `chased ${Math.round(s.fromStart)} blocks`
  if (s.outOfSightMs > s.lostSec * 1000) return `out of sight ${Math.round(s.outOfSightMs / 1000)} s`
  if ((s.jump ?? 0) > 8 && s.dist > s.chase / 2) return 'pearled away'
  return null
}

// ---- lines ----

/** Owner whisper for a mode change. */
export function modeLine (mode: PvpMode, by: string | null): string {
  const what: Record<PvpMode, string> = {
    off: 'PvP off: I leave players alone',
    defend: 'PvP defend: I only fight back',
    revenge: 'PvP revenge: I fight back and go after whoever kills or attacks us',
    targets: 'PvP targets: I attack the players on my list (and grudges)',
    all: 'PvP all: I attack every player in range except owners and friends'
  }
  return `${what[mode]}${by ? ` (set by ${by})` : ''}`
}

const TAUNTS = ['gg', 'next time bring armour', 'that was quick', 'ez']
export function tauntLine (seed: number): string {
  return TAUNTS[Math.abs(Math.floor(seed)) % TAUNTS.length]!
}

/** A minute count for lists ("12 min left"). */
export function minutesLeft (until: number, now: number): number {
  return Math.max(0, Math.ceil((until - now) / 60_000))
}
