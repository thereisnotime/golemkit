// Reflex arbitration (pure, unit-tested). Every reflex runs at the same priority, and an equal
// priority replaces the running action, so without a referee the reflexes took the body from each
// other every 0.2 to 2 s (seen live: underground with skeletons and a spider, ranged_defense ->
// climb_out -> defend -> ranged_defense ... and the bot died without finishing any of them). The
// reflexes brain asks `mayReplace` before starting one while another reflex holds the body:
//   - a reflex that just started keeps the body for HOLD_MS (1.5 s) unless health dropped sharply
//   - getting away (climb_out, retreat) is not interrupted by a fight unless a melee mob is
//     adjacent, and not by ranged_defense at all
//   - ranged_defense is not interrupted by defend for a mob more than 3 blocks away
//   - water_bucket (a lethal fall or fire) always goes first, even during the hold
//   - bunker and the PvP actions follow the same hold as the rest
// Nothing here is about which reflex to pick; the brain still decides that.

/** Reflex actions the arbiter referees (others, e.g. a player's command, are not its business). */
export const REFEREED = new Set(['climb_out', 'retreat', 'ranged_defense', 'defend', 'bunker', 'eat', 'pvp_engage', 'defend_player', 'water_bucket'])

/** A reflex keeps the body at least this long once started. */
export const HOLD_MS = 1500
/** ...unless health dropped by this much since it started. */
export const SHARP_DROP = 4

const ESCAPES = new Set(['climb_out', 'retreat'])

export interface ArbiterState {
  /** The running action (null: idle) and whether a reflex started it. */
  current: string | null
  currentIsReflex: boolean
  /** ms since that reflex started. */
  sinceStartMs: number
  /** Health lost since it started. */
  healthDrop: number
  /** The reflex that wants the body. */
  next: string
  /** Distance to the nearest melee hostile (Infinity: none). */
  meleeDist: number
}

/** May `next` take the body from the running reflex? Null: yes; otherwise why not. */
export function mayReplace (s: ArbiterState): string | null {
  if (!s.current || !s.currentIsReflex || !REFEREED.has(s.current)) return null
  if (s.current === s.next) return 'already running'
  if (s.next === 'water_bucket') return null // a lethal fall or fire: always
  const sharp = s.healthDrop >= SHARP_DROP
  if (s.sinceStartMs < HOLD_MS && !sharp) return `${s.current} just started`
  if (ESCAPES.has(s.current)) {
    if (s.next === 'ranged_defense') return `${s.current} gets away from archers too`
    if ((s.next === 'defend' || s.next === 'pvp_engage') && s.meleeDist > 2) return `${s.current}: nothing adjacent`
  }
  if (s.current === 'ranged_defense' && s.next === 'defend' && s.meleeDist > 3) return 'ranged_defense: no melee mob within 3'
  return null
}
