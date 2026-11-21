// Instruction intake: which chat lines are owner instructions to rewrite the program.
// An instruction is a whisper, or a public line that mentions the bot, starting with one of
// the prefixes ("learn:", "change:", "teach:"). Non-owners are always ignored; the caller
// checks agent.isOwner before anything reaches the LLM.

export interface IntakeOptions {
  /** Default ['learn:', 'change:', 'teach:']. Case-insensitive. */
  prefixes?: string[]
  /** Public chat must mention the bot (username or an alias). Default true. Whispers never need it. */
  requireMention?: boolean
  /** Extra names the bot answers to. */
  aliases?: string[]
}

export const DEFAULT_PREFIXES = ['learn:', 'change:', 'teach:']

/** Strips a leading "Name," / "@Name" / "hey Name" mention. Returns null when the line doesn't address the bot. */
export function stripMention (message: string, names: string[]): string | null {
  const m = message.trim()
  for (const n of names) {
    const re = new RegExp(`^(?:hey\\s+)?@?${escape(n)}\\b[\\s,:!-]*`, 'i')
    if (re.test(m)) return m.replace(re, '')
  }
  return null
}

function escape (s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The instruction text, or null if this line isn't one (wrong prefix, no mention, empty). Owner check is separate. */
export function parseInstruction (msg: { message: string, whisper: boolean }, botName: string, opts: IntakeOptions = {}): string | null {
  const names = [botName, ...(opts.aliases ?? [])]
  let body: string | null = msg.message.trim()
  if (!msg.whisper) {
    const stripped = stripMention(body, names)
    if (stripped === null && (opts.requireMention ?? true)) return null
    body = stripped ?? body
  } else {
    body = stripMention(body, names) ?? body
  }
  const lower = body.toLowerCase()
  const prefix = (opts.prefixes ?? DEFAULT_PREFIXES).find(p => lower.startsWith(p.toLowerCase()))
  if (!prefix) return null
  const text = body.slice(prefix.length).trim()
  return text.length >= 3 ? text.slice(0, 600) : null
}

/** yes / no answers to a pending proposal. */
export function parseAnswer (message: string, botName: string): 'yes' | 'no' | null {
  const body = (stripMention(message, [botName]) ?? message).trim().toLowerCase().replace(/[.!]+$/, '')
  if (/^(yes|y|yeah|yep|sure|ok|okay|do it|go ahead)$/.test(body)) return 'yes'
  if (/^(no|n|nope|nah|don't|dont|leave it)$/.test(body)) return 'no'
  return null
}

/** Whole-word, case-insensitive phrase match (no regex from program data). */
export function chatMatches (message: string, phrases: string[]): boolean {
  const norm = ` ${message.toLowerCase().replace(/[^a-z0-9_]+/g, ' ').trim()} `
  return phrases.some(p => {
    const q = p.toLowerCase().replace(/[^a-z0-9_]+/g, ' ').trim()
    return q.length > 0 && norm.includes(` ${q} `)
  })
}
