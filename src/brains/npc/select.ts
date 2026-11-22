// Pure behaviour selection with hysteresis. No I/O, so it is unit-tested directly.

export interface Scored {
  name: string
  score: number
}

export interface Running {
  name: string
  startedAt: number
}

export interface SelectOptions {
  /** A challenger must beat the running behaviour's score by this much. Default 10. */
  switchMargin?: number
  /** Minimum time a behaviour runs before a non-urgent challenger may interrupt it. Default 3000. */
  minRunMs?: number
  /** Scores at or above this interrupt regardless of minRunMs (danger). Default 80. */
  urgentScore?: number
  /** A run that drops out ("no longer applies") sooner than this counts as a flip. Default 10000. */
  flipRunMs?: number
  /** First pause after repeated flips; doubles per further flip. Default 5000. */
  flipCooldownMs?: number
  /** Ceiling for the flip pause. Default 60000. */
  maxFlipCooldownMs?: number
}

export type Decision =
  | { kind: 'idle' }
  | { kind: 'keep', name: string }
  | { kind: 'start', name: string, score: number }
  | { kind: 'switch', from: string, name: string, score: number, reason: string }
  | { kind: 'stop', name: string, reason: string }

/** Highest positive score; ties go to the earlier entry (declaration order). */
export function best (scores: Scored[]): Scored | null {
  let top: Scored | null = null
  for (const s of scores) {
    if (!(s.score > 0)) continue
    if (!top || s.score > top.score) top = s
  }
  return top
}

/**
 * Decides what to do given fresh scores and what is running.
 * - nothing running: start the best positive score, if any
 * - running behaviour dropped to 0: switch to the best, or stop
 * - otherwise switch only when a challenger beats it by switchMargin, and either the
 *   running one has had minRunMs or the challenger is urgent
 */
export function decide (scores: Scored[], running: Running | null, now: number, opts: SelectOptions = {}): Decision {
  const margin = opts.switchMargin ?? 10
  const minRunMs = opts.minRunMs ?? 3000
  const urgent = opts.urgentScore ?? 80
  const top = best(scores)

  if (!running) return top ? { kind: 'start', name: top.name, score: top.score } : { kind: 'idle' }

  const cur = scores.find(s => s.name === running.name)?.score ?? 0
  if (!(cur > 0)) {
    return top
      ? { kind: 'switch', from: running.name, name: top.name, score: top.score, reason: `${running.name} no longer applies` }
      : { kind: 'stop', name: running.name, reason: 'no longer applies' }
  }
  if (!top || top.name === running.name) return { kind: 'keep', name: running.name }
  if (top.score < cur + margin) return { kind: 'keep', name: running.name }
  const ranLongEnough = now - running.startedAt >= minRunMs
  if (!ranLongEnough && top.score < urgent) return { kind: 'keep', name: running.name }
  return {
    kind: 'switch',
    from: running.name,
    name: top.name,
    score: top.score,
    reason: `${top.name} ${Math.round(top.score)} > ${running.name} ${Math.round(cur)}`
  }
}

/** Failure back-off: base * 2^(failures-1), capped. */
export function failureCooldown (failures: number, baseMs: number, maxMs: number): number {
  if (failures <= 0) return 0
  return Math.min(maxMs, baseMs * 2 ** (failures - 1))
}

/**
 * Flip back-off: a behaviour that keeps starting and then dropping out within a few seconds
 * (its condition flickers at the edge of a threshold) waits before it may start again. The
 * first flip is free, then base * 2^(flips-2), capped. Urgent scores ignore it (see controller).
 */
export function flipCooldown (flips: number, baseMs = 5000, maxMs = 60_000): number {
  if (flips <= 1) return 0
  return Math.min(maxMs, baseMs * 2 ** (flips - 2))
}

/** Whether a run that ended "no longer applies" after `ranMs` counts as a flip. */
export function isFlip (ranMs: number, opts: SelectOptions = {}): boolean {
  return ranMs < (opts.flipRunMs ?? 10_000)
}
