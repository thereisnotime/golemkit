// PvP policy (pure, unit-tested). Bots never start fights with players. combat.pvp (default
// 'off') can be set to 'defend': the bot then fights back against a player who hits it, or who
// hits the player it is guarding, with the same fight loop as against mobs, and stops as soon as
// that player stops attacking or runs. Owners and the names in combat.friends are never fought.

export type PvpMode = 'off' | 'defend'

/** How long after the last hit a player still counts as attacking. */
export const PVP_CALM_MS = 5000
/** A player this far away (and not coming back) has fled. */
export const PVP_FLED = 10

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

/** Why the bot must not fight this player (null: it may defend itself against them). */
export function pvpRefusal (s: Pick<PvpState, 'mode' | 'player' | 'owners' | 'friends' | 'invulnerable'>): string | null {
  if (s.mode !== 'defend') return 'combat.pvp is off'
  const n = s.player.toLowerCase()
  if (s.owners.includes(n)) return 'an owner'
  if (s.friends.some(f => f.toLowerCase() === n)) return 'a friend'
  if (s.invulnerable) return 'in creative or spectator'
  return null
}

/** Start or keep fighting back ('fight'), or stop ('stop', with why). */
export function pvpDecision (s: PvpState): { act: 'fight' } | { act: 'stop', why: string } {
  const no = pvpRefusal(s)
  if (no) return { act: 'stop', why: no }
  if (s.sinceHitMs > PVP_CALM_MS) return { act: 'stop', why: 'stopped attacking' }
  if (s.dist > PVP_FLED) return { act: 'stop', why: 'ran off' }
  return { act: 'fight' }
}

export function pvpMode (raw: unknown): PvpMode {
  return raw === 'defend' ? 'defend' : 'off'
}
