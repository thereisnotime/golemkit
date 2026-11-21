// Fleet-wide journal queries: every bot in this process on the same server as `agent`.
import type { Agent } from '../agent.ts'
import type { JournalEvent } from './types.ts'
import type { JournalQuery } from './query.ts'

export function fleetQuery (agent: Agent, q: JournalQuery = {}): JournalEvent[] {
  let agents: Agent[] = [agent]
  try { agents = agent.fleet.onServer(agent.serverName) } catch {}
  const out: JournalEvent[] = []
  for (const a of agents) {
    for (const e of a.journal.query({ ...q, limit: q.limit ?? 50 })) out.push({ ...e, bot: a.username })
  }
  out.sort((a, b) => a.ts - b.ts)
  const limit = q.limit ?? 50
  return limit > 0 && out.length > limit ? out.slice(out.length - limit) : out
}
