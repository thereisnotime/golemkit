// Short text for chat and LLM tool results.
import type { JournalEvent, Pos } from './types.ts'
import type { DayRollup, RollupSection } from './rollup.ts'
import type { Counts } from './aggregate.ts'
import { ago, clock } from './time.ts'

export const fmtP = (p?: Pos) => p ? `${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}` : '?'
const dimShort = (d?: string) => d ? d.replace(/^minecraft:/, '').replace(/^the_/, '') : ''

export function fmtCounts (c: Counts | undefined, max = 6): string {
  const e = Object.entries(c ?? {}).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]) || a[0].localeCompare(b[0]))
  if (!e.length) return 'nothing'
  const shown = e.slice(0, max).map(([k, n]) => `${n}x ${k}`)
  return shown.join(', ') + (e.length > max ? ` +${e.length - max} more` : '')
}

const cut = (s: unknown, n = 60) => {
  const t = String(s ?? '')
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

/** One line per event, e.g. "14:02 death at 10 64 -5: slain by Zombie (lost 12 items)". */
export function fmtEvent (e: JournalEvent, now = Date.now()): string {
  const d = e.data ?? {}
  const at = e.pos ? ` at ${fmtP(e.pos)}${e.dim && !/overworld/.test(e.dim) ? ` (${dimShort(e.dim)})` : ''}` : ''
  const when = now - e.ts < 86_400_000 ? clock(e.ts) : new Date(e.ts).toISOString().slice(5, 16).replace('T', ' ')
  const who = e.bot ? `[${e.bot}] ` : ''
  let body: string
  switch (e.type) {
    case 'death': body = `died${at}: ${d.message ? cut(d.message, 80) : d.cause ?? 'unknown cause'}${d.lostCount ? ` (lost ${d.lostCount} items)` : ''}`; break
    case 'respawn': body = `respawned${at}${d.keptInventory ? ', kept inventory' : ''}`; break
    case 'damage': body = `took ${d.amount} damage from ${d.source}${d.hits > 1 ? ` (${d.hits} hits)` : ''}, health ${d.healthAfter}`; break
    case 'kill': body = `killed ${d.entity}${at}`; break
    case 'item_gained': body = `got ${fmtCounts(d.items, 4)}${d.action ? ` (${d.action})` : ''}`; break
    case 'item_lost': body = `lost ${fmtCounts(d.items, 4)}${d.action ? ` (${d.action})` : ''}`; break
    case 'block_broken': body = `broke ${fmtCounts(d.blocks, 4)}${at}`; break
    case 'block_placed': body = `placed ${fmtCounts(d.blocks, 4)}${at}`; break
    case 'chat_in': body = `<${d.from}> ${cut(d.message)}`; break
    case 'chat_out': body = `said: ${cut(d.message)}`; break
    case 'whisper': body = d.dir === 'out' ? `whispered to ${d.to}: ${cut(d.message)}` : `${d.from} whispered: ${cut(d.message)}`; break
    case 'action': body = `${d.name} ${d.ok ? 'ok' : 'failed'}${d.message ? `: ${cut(d.message)}` : ''} (${d.caller}, ${Math.round((d.ms ?? 0) / 100) / 10}s)`; break
    case 'goal': body = `goal ${d.status ?? ''} ${cut(d.goal ?? d.text ?? '')}`.replace(/\s+/g, ' '); break
    case 'player_seen': body = `saw ${d.player}${at}`; break
    case 'player_joined': body = `${d.player} joined`; break
    case 'player_left': body = `${d.player} left`; break
    case 'place_visited': body = `arrived ${d.place ? `at ${d.place} ` : ''}${at.trim()}`; break
    case 'advancement': body = `${d.self === false ? `${d.player} got` : 'got'} advancement [${d.advancement}]`; break
    case 'protected_area': body = `server refused digging${at}`; break
    case 'food_spot': body = `found ${d.kind === 'animals' ? `animals (${(d.animals ?? []).join(', ')})` : String(d.kind ?? 'food').replace('_', ' ')}${at}`; break
    case 'farm_started': body = `started ${d.name ?? 'a farm'} (${d.size}x${d.size} ${d.crop ?? 'crops'})${at}`; break
    case 'found': body = `found ${d.what ?? d.target ?? 'it'}${d.count > 1 ? ` (${d.count})` : ''}${at}${d.how ? `, ${cut(d.how, 60)}` : ''}`; break
    case 'connect': body = `connected${at}`; break
    case 'disconnect': body = `disconnected: ${cut(d.reason, 80)}`; break
    case 'llm_turn': body = `LLM turn ${d.trigger ? `(${d.trigger}) ` : ''}${d.inputTokens}/${d.outputTokens} tokens${d.ok === false ? ', failed' : ''}`; break
    case 'journal_dropped': body = `(${d.count} ${d.type} events not recorded, over the per-minute cap)`; break
    case 'rollup': body = `day summary ${d.date}: ${d.text}`; break
    default: body = `${e.type} ${cut(JSON.stringify(d), 80)}`
  }
  return `${who}${when} ${body}`.replace(/\s+/g, ' ').trim()
}

/** "+12 oak_log, -3 bread". */
export function fmtNet (c: Counts, max = 5): string {
  const e = Object.entries(c).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]) || a[0].localeCompare(b[0]))
  const shown = e.slice(0, max).map(([k, n]) => `${n > 0 ? '+' : ''}${n} ${k}`)
  return shown.join(', ') + (e.length > max ? ` +${e.length - max} more` : '')
}

export function fmtDuration (ms: number): string {
  const m = Math.round(ms / 60_000)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`
}

/** A few sentences about a rollup section. */
export function fmtSection (s: RollupSection, label: string, now = Date.now()): string {
  if (!s.events) return `${label}: nothing recorded`
  const parts: string[] = []
  if (s.onlineMs) parts.push(`online ${fmtDuration(s.onlineMs)}`)
  if (s.deaths.length) {
    const last = s.deaths.at(-1)!
    parts.push(`${s.deaths.length} death${s.deaths.length > 1 ? 's' : ''} (last ${ago(last.ts, now)} at ${fmtP(last.pos)}: ${last.message ?? last.cause ?? '?'})`)
  }
  if (s.actions.total) {
    let a = `${s.actions.total} actions, ${s.actions.failed} failed`
    const f = s.actions.topFailures[0]
    if (f) a += ` (most: ${f.action} "${cut(f.message, 40)}" x${f.count})`
    parts.push(a)
  }
  const net = Object.keys(s.items.net).length ? `items net ${fmtNet(s.items.net)}` : ''
  if (net) parts.push(net)
  const broken = Object.values(s.blocks.broken).reduce((a, b) => a + b, 0)
  const placed = Object.values(s.blocks.placed).reduce((a, b) => a + b, 0)
  if (broken || placed) parts.push(`blocks ${broken} broken, ${placed} placed`)
  if (Object.keys(s.kills).length) parts.push(`killed ${fmtCounts(s.kills, 4)}`)
  if (s.damage.taken) parts.push(`took ${s.damage.taken} damage`)
  if (s.players.length) parts.push(`met ${s.players.slice(0, 6).join(', ')}${s.players.length > 6 ? ` +${s.players.length - 6}` : ''}`)
  if (s.places.length) parts.push(`places: ${s.places.slice(0, 3).map(p => p.name ? `${p.name} (${p.x} ${p.z})` : `${p.x} ${p.y} ${p.z}`).join('; ')}`)
  if (s.advancements.length) parts.push(`advancements: ${s.advancements.slice(0, 3).join(', ')}`)
  if (s.chat.in + s.chat.out + s.chat.whispers) parts.push(`chat ${s.chat.in} in, ${s.chat.out} out`)
  if (s.llm.turns) parts.push(`LLM ${s.llm.turns} turns, ${s.llm.inputTokens + s.llm.outputTokens} tokens`)
  return `${label}: ${parts.join('; ')}`
}

export function fmtRollup (r: DayRollup, label = r.date, now = Date.now()): string {
  const base = fmtSection(r.totals, label, now)
  return r.summary ? `${base}. Summary: ${r.summary}` : base
}
