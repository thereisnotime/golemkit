// "Humanize": optional player-like timing and habits, for immersive bots. Applies to every
// brain because it lives in the agent's chat queue and action entry point.
//
// profile:
//   humanize: true                       # defaults below
//   humanize: { typoRate: 0.03, lowercase: true }
//   humanize: false                      # off even when llm.immersive is on
// Default: on when settings.llm.immersive is true, off otherwise.

export interface HumanizeOptions {
  /** Random wait before starting to "type" a reply, ms [min, max]. */
  reactionMs: [number, number]
  /** Typing speed, characters per second [min, max]. */
  charsPerSec: [number, number]
  /** Cap on reaction + typing for one line, ms. */
  maxDelayMs: number
  /** Stand still while typing (movement keys held off), then carry on. */
  pauseWhileTyping: boolean
  /** Turn to the person being answered before typing. */
  lookAtSpeaker: boolean
  /** Random pause before starting an action a player or brain asked for, ms [min, max]. */
  actionHesitationMs: [number, number]
  /** Write chat in lower case. */
  lowercase: boolean
  /** Chance per message of one adjacent-key typo, followed by a "*word" correction. 0 = never. */
  typoRate: number
  /** Look around now and then while idle. */
  idleFidget: boolean
}

export const HUMANIZE_DEFAULTS: HumanizeOptions = {
  reactionMs: [700, 2200],
  charsPerSec: [6, 11],
  maxDelayMs: 12_000,
  pauseWhileTyping: true,
  lookAtSpeaker: true,
  actionHesitationMs: [250, 900],
  lowercase: false,
  typoRate: 0,
  idleFidget: true
}

/** Resolves settings.humanize (true / object / false) with the immersive default. */
export function resolveHumanize (settings: Record<string, unknown>): HumanizeOptions | null {
  const raw = settings.humanize
  const immersive = !!(settings.llm as { immersive?: boolean } | undefined)?.immersive
  if (raw === false) return null
  if (raw === undefined || raw === null) return immersive ? { ...HUMANIZE_DEFAULTS } : null
  if (raw === true) return { ...HUMANIZE_DEFAULTS }
  if (typeof raw === 'object') {
    const o = raw as Partial<HumanizeOptions> & { enabled?: boolean }
    if (o.enabled === false) return null
    const { enabled: _enabled, ...rest } = o
    return { ...HUMANIZE_DEFAULTS, ...rest }
  }
  return null
}

export type Rng = () => number

export const between = ([a, b]: [number, number], rnd: Rng = Math.random): number => a + (b - a) * rnd()

/** How long a person would take to start and finish typing this line. */
export function typingDelayMs (text: string, h: HumanizeOptions, opts: { reaction: boolean }, rnd: Rng = Math.random): number {
  const reaction = opts.reaction ? between(h.reactionMs, rnd) : 0
  const typing = (text.length / Math.max(1, between(h.charsPerSec, rnd))) * 1000
  return Math.min(h.maxDelayMs, Math.round(reaction + typing))
}

const NEIGHBOURS: Record<string, string> = {
  a: 'sq', s: 'ad', d: 'sf', f: 'dg', g: 'fh', h: 'gj', j: 'hk', k: 'jl', l: 'k', q: 'w', w: 'qe', e: 'wr',
  r: 'et', t: 'ry', y: 'tu', u: 'yi', i: 'uo', o: 'ip', p: 'o', z: 'x', x: 'zc', c: 'xv', v: 'cb', b: 'vn', n: 'bm', m: 'n'
}

/** Applies casing and maybe one typo. Returns the line to send and an optional correction. */
export function styleLine (text: string, h: HumanizeOptions, rnd: Rng = Math.random): { text: string, correction?: string } {
  let out = h.lowercase ? text.toLowerCase() : text
  if (h.typoRate > 0 && rnd() < h.typoRate) {
    const words = out.split(' ')
    const candidates = words.map((w, i) => ({ w, i })).filter(({ w }) => /^[a-z]{4,}$/i.test(w))
    if (candidates.length) {
      const { w, i } = candidates[Math.floor(rnd() * candidates.length)]!
      const pos = 1 + Math.floor(rnd() * (w.length - 2))
      const ch = w[pos]!.toLowerCase()
      const near = NEIGHBOURS[ch]
      if (near) {
        const typo = w.slice(0, pos) + near[Math.floor(rnd() * near.length)] + w.slice(pos + 1)
        words[i] = typo
        return { text: words.join(' '), correction: `*${h.lowercase ? w.toLowerCase() : w}` }
      }
    }
  }
  return { text: out }
}
