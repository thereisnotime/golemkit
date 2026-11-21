// Journal actions: ask the bot what happened (recall_events, last_death, history) and go back
// to where it died (goto_death). Recording itself is in core and works without this skill;
// the skill also adds a "recent events" line to observe() when a context pack is active.
import type { Agent } from '../core/index.ts'
import {
  defineSkill, defineAction, z, noParams, ok, fail, travel, fmtEvent, fmtCounts, fleetQuery, parseRange, ago,
  JOURNAL_TYPES, type DeathView, type JournalEvent, type JournalQuery
} from '../core/index.ts'
import { contextSettings } from '../context/handle.ts'
import { pickupNearby } from './pickup.ts'

const fmtPos = (p?: { x: number, y: number, z: number }) => p ? `${p.x} ${p.y} ${p.z}` : 'unknown position'
const dimLabel = (d?: string) => d && !/overworld/.test(d) ? ` in the ${d.replace(/^minecraft:/, '').replace(/^the_/, '')}` : ''

// Friendly aliases for type filters.
const TYPE_ALIASES: Record<string, string[]> = {
  deaths: ['death'], death: ['death'], chat: ['chat_in', 'chat_out', 'whisper'], items: ['item_gained', 'item_lost'],
  blocks: ['block_broken', 'block_placed'], players: ['player_seen', 'player_joined', 'player_left'],
  actions: ['action'], places: ['place_visited'], combat: ['damage', 'kill', 'death'], llm: ['llm_turn'],
  connections: ['connect', 'disconnect'], food: ['food_spot', 'farm_started']
}

export function resolveTypes (spec: string | undefined): string[] | undefined {
  if (!spec) return undefined
  const out = new Set<string>()
  for (const t of spec.toLowerCase().split(/[\s,]+/).filter(Boolean)) {
    for (const x of TYPE_ALIASES[t] ?? [t]) out.add(x)
  }
  return out.size ? [...out] : undefined
}

/** Compact list for chat / tool results: newest last, "; " separated, capped. */
export function fmtEventList (events: JournalEvent[], now = Date.now(), maxChars = 600): string {
  const lines = events.map(e => fmtEvent(e, now))
  let out = lines.join('; ')
  let dropped = 0
  while (out.length > maxChars && lines.length > 1) { lines.shift(); dropped++; out = lines.join('; ') }
  return dropped ? `(${dropped} older not shown) ${out}` : out
}

export function fmtDeath (d: DeathView, now = Date.now()): string {
  const cause = d.message ?? (d.killer ? `${d.cause} by ${d.killer}` : d.cause ?? 'unknown cause')
  let s = `died ${ago(d.ts, now)} at ${fmtPos(d.pos)}${dimLabel(d.dim)}: ${cause}`
  if (d.action) s += `, while doing ${d.action}`
  if (d.keptInventory) s += '. Kept the inventory (keepInventory), nothing lost'
  else if (d.lostCount) {
    s += `. Lost ${fmtCounts(d.lost, 6)}`
    s += d.itemsMayRemain
      ? `. Died ${Math.round((now - d.ts) / 1000)}s ago, the drops may still be there for about ${Math.max(0, Math.round((5 * 60_000 - (now - d.ts)) / 1000))}s (goto_death)`
      : '. Over 5 minutes ago, the drops have despawned if the chunk stayed loaded'
  } else s += '. Carried nothing'
  return s
}

const recallEvents = defineAction({
  name: 'recall_events',
  description: 'What happened: recent journal events (deaths, damage, kills, items, chat, actions, players, places...). Filter by type, time, place, player or text.',
  params: z.object({
    type: z.string().optional().describe(`event types, comma separated: ${JOURNAL_TYPES.filter(t => t !== 'journal_dropped').join(', ')}; or deaths, chat, items, blocks, players, combat, connections`),
    since: z.string().optional().describe('how far back: 30m, 1h, 2d, today, yesterday, a date (YYYY-MM-DD); default 24h'),
    player: z.string().optional().describe('only events involving this player'),
    near: z.string().optional().describe('only events near "x y z" or "x z", optionally with a radius as 4th number (default 32)'),
    text: z.string().optional().describe('only events whose details contain this text'),
    limit: z.number().int().min(1).max(50).default(10),
    fleet: z.boolean().default(false).describe('include the other bots on this server')
  }),
  exclusive: false,
  aliases: ['events', 'journal'],
  run: ({ agent }, p) => {
    const range = parseRange(p.since ?? '24h')
    if (p.since && !range) return fail(`don't understand since="${p.since}" (try 1h, today, yesterday, 2026-11-20)`)
    let near: JournalQuery['near']
    if (p.near) {
      const n = p.near.trim().split(/[\s,]+/).map(Number)
      if (n.some(Number.isNaN) || n.length < 2) return fail('near needs "x y z" or "x z" (and optionally a radius)')
      near = n.length === 2 ? { x: n[0], z: n[1], r: 32 } : n.length === 3 ? { x: n[0], y: n[1], z: n[2], r: 32 } : { x: n[0], y: n[1], z: n[2], r: n[3] }
    }
    const q: JournalQuery = {
      types: resolveTypes(p.type), since: range?.since, until: range?.until, near,
      ...(p.player ? { player: p.player } : {}), ...(p.text ? { text: p.text } : {}), limit: p.limit
    }
    if (!agent.journal.enabled) return fail('the journal is off for this bot')
    const events = p.fleet ? fleetQuery(agent, q) : agent.journal.query(q)
    if (!events.length) return ok(`nothing recorded ${range?.label ?? 'in the last 24h'}${p.type ? ` for ${p.type}` : ''}`)
    return ok(fmtEventList(events), events)
  }
})

const lastDeath = defineAction({
  name: 'last_death',
  description: 'Where and when the bot last died, what killed it, what it lost, and whether the drops may still be there.',
  params: noParams,
  exclusive: false,
  aliases: ['death', 'where_died'],
  run: ({ agent }) => {
    const d = agent.journal.lastDeath()
    if (!d) return ok(agent.journal.enabled ? 'no death recorded' : 'the journal is off for this bot, no deaths recorded')
    return ok(fmtDeath(d), d)
  }
})

const history = defineAction({
  name: 'history',
  description: 'Summary of a period from the journal rollups: online time, deaths, actions and failures, items, places, players. Period: today, yesterday, a date, 3h, or an hour range like 10-12.',
  params: z.object({ period: z.string().default('today').describe('today | yesterday | YYYY-MM-DD | 1h, 6h | 10-12 (hours today)') }),
  exclusive: false,
  aliases: ['summary'],
  run: ({ agent }, { period }) => {
    const s = agent.journal.summary(period)
    if (!s) return fail(`don't understand period="${period}" (try today, yesterday, 3h, 10-12)`)
    return ok(s.text, s.section)
  }
})

const gotoDeath = defineAction({
  name: 'goto_death',
  description: 'Walk back to where the bot last died to pick up its dropped items (they despawn 5 minutes after death).',
  params: z.object({ pickup: z.boolean().default(true).describe('pick up dropped items there') }),
  longRunning: true,
  async run ({ agent, bot, signal }, { pickup }) {
    const d = agent.journal.lastDeath()
    if (!d?.pos) return fail('no death with a position recorded')
    if (d.dim && bot.game.dimension !== d.dim) return fail(`died in ${d.dim}, I'm in ${bot.game.dimension}`)
    const note = d.itemsMayRemain ? '' : ' (the drops are probably gone by now)'
    // Died there (or very near) more than once in the last 10 minutes: it's a trap (mobs in a cave,
    // lava...). Don't walk back into it; the items aren't worth another death.
    const recent = agent.journal.query({ types: ['death'], since: Date.now() - 10 * 60_000, limit: 0 })
      .filter(e => e.pos && Math.hypot(e.pos.x - d.pos!.x, e.pos.y - d.pos!.y, e.pos.z - d.pos!.z) < 12)
    if (recent.length >= 2) {
      return fail(`died ${recent.length} times near ${fmtPos(d.pos)} in the last 10 minutes (${d.message ?? d.cause ?? 'unknown cause'}); not going back there. Re-make what I lost instead`)
    }
    if (!d.itemsMayRemain) return fail(`the drops at ${fmtPos(d.pos)} are probably gone by now (over 5 minutes); not worth the trip`)
    try {
      await travel(bot, d.pos, signal, { range: 2 })
    } catch (e) {
      if (signal.aborted) throw e
      return fail(`couldn't get to my death spot ${fmtPos(d.pos)}: ${(e as Error).message}`)
    }
    if (!pickup) return ok(`at my death spot ${fmtPos(d.pos)}${note}`)
    const got = await pickupNearby(bot, signal, { radius: 10, maxMs: 30_000 })
    return ok(`at my death spot ${fmtPos(d.pos)}, picked up ${got} item${got === 1 ? '' : 's'}${got ? '' : note}`)
  }
})

/** The "recent events" line for observe(): only with a context pack and journal.observe on. */
export function recentEventsObservation (agent: Pick<Agent, 'settings' | 'journal'>): Record<string, unknown> {
  if (!agent.journal.enabled || !agent.journal.config.observe || !contextSettings(agent.settings)) return {}
  const line = agent.journal.notableLine()
  return line ? { recentEvents: line } : {}
}

export const journal = () => defineSkill({
  name: 'journal',
  description: 'What happened to the bot: events, deaths, daily summaries, going back for dropped items.',
  actions: [recallEvents, lastDeath, history, gotoDeath],
  observe: (agent) => recentEventsObservation(agent)
})
