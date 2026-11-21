// Optional LLM summary of a day's rollup: one short paragraph, written into the rollup file.
// Off unless journal.summarize is configured. The model only sees the rollup numbers (no chat
// text, no prompts), and gets no tools.
import type { LlmProvider } from '../../llm/types.ts'
import type { DayRollup } from './rollup.ts'
import type { SummarizeConfig } from './types.ts'

export const SUMMARY_SYSTEM = 'You summarise a Minecraft bot\'s day from its event rollup. Write one short paragraph ' +
  '(at most 3 sentences) in plain past tense: what it mostly did, deaths (where and why), what it gained or lost, ' +
  'who it met, anything that went wrong repeatedly. Use only facts from the data. No preamble, no lists.'

/** The rollup trimmed to what a summary needs (hourly sections dropped). */
export function summaryInput (r: DayRollup): string {
  const t = r.totals
  return JSON.stringify({
    date: r.date,
    bot: r.bot,
    onlineMinutes: Math.round(t.onlineMs / 60_000),
    counts: t.counts,
    deaths: t.deaths.map(d => ({ time: new Date(d.ts).toTimeString().slice(0, 5), at: d.pos, dim: d.dim, cause: d.message ?? d.cause, lost: d.lost })),
    kills: t.kills,
    damageTaken: t.damage,
    itemsNet: t.items.net,
    blocks: t.blocks,
    places: t.places.slice(0, 5),
    players: t.players,
    advancements: t.advancements,
    actions: { total: t.actions.total, failed: t.actions.failed, topFailures: t.actions.topFailures },
    activeHours: Object.keys(r.hours)
  })
}

const NO_TOOLS = { list: () => [], call: async () => ({ ok: false, text: 'no tools' }) }

export async function summarizeRollup (r: DayRollup, provider: LlmProvider, opts: { maxChars?: number, timeoutMs?: number, signal?: AbortSignal } = {}): Promise<string> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort('timeout'), opts.timeoutMs ?? 120_000)
  const onAbort = () => ctl.abort('aborted')
  opts.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const res = await provider.run({
      system: SUMMARY_SYSTEM,
      userMessage: `Rollup:\n${summaryInput(r)}`,
      tools: NO_TOOLS,
      maxTurns: 1,
      timeoutMs: opts.timeoutMs ?? 120_000,
      signal: ctl.signal
    })
    const text = res.text.replace(/\s+/g, ' ').trim()
    const max = opts.maxChars ?? 600
    return text.length > max ? text.slice(0, max - 1) + '…' : text
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onAbort)
  }
}

/** Builds the provider lazily so the LLM layer is only loaded when summaries are on. */
export async function providerFor (cfg: SummarizeConfig): Promise<LlmProvider> {
  const { createProvider } = await import('../../llm/providers/index.ts')
  return createProvider(cfg.provider, cfg.options)
}
