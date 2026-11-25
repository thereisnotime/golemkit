// Opt-in memory log: GOLEM_MEMLOG=<seconds> logs process.memoryUsage() every N seconds, with
// swap, the RSS of child processes (LLM CLIs) and cheap per-agent counts (the adapter's world state,
// storage size, journal buffer, chat queue) to tell where the memory goes. Off unless the
// variable is set; nothing runs then. Heap snapshots: start with
// NODE_OPTIONS=--heapsnapshot-signal=SIGUSR2 and `kill -USR2 <pid>` (docs/guide/deployment.md#memory).
import { readFileSync, readdirSync } from 'node:fs'
import type { Logger } from './log.ts'

/** Seconds between samples from GOLEM_MEMLOG, or null when off (unset, 0, not a number). Minimum 5. */
export function memlogInterval (value: string | undefined): number | null {
  if (value == null || value.trim() === '') return null
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.max(5, Math.round(n))
}

export interface MemSample {
  rss: number
  heapUsed: number
  heapTotal: number
  external: number
  arrayBuffers: number
  /** Bytes of this process swapped out (Linux); RSS leaves them out. */
  swap?: number
  /** RSS of child processes (and theirs), bytes; null where /proc is missing. */
  children?: { count: number, rss: number } | null
}

const MB = 1024 * 1024
const mb = (n: number): string => `${Math.round(n / MB)}M`

/**
 * One log line: `rss 812M heap 310/402M ext 95M ab 80M other 315M kids 1/350M`. `other` is RSS
 * outside the JS heap and external memory: code, native allocations (malloc), thread stacks.
 */
export function formatMemSample (s: MemSample): string {
  const other = Math.max(0, s.rss - s.heapTotal - s.external)
  const parts = [`rss ${mb(s.rss)}`, `heap ${Math.round(s.heapUsed / MB)}/${mb(s.heapTotal)}`, `ext ${mb(s.external)}`, `ab ${mb(s.arrayBuffers)}`, `other ${mb(other)}`]
  if (s.swap) parts.push(`swap ${mb(s.swap)}`)
  if (s.children) parts.push(`kids ${s.children.count}/${mb(s.children.rss)}`)
  return parts.join(' ')
}

/** `name k=v k=v`, numbers only, in insertion order. */
export function formatCounts (name: string, counts: Record<string, number>): string {
  return `${name} ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ')}`
}

/** VmRSS (or another kB field, e.g. VmSwap) in bytes from a /proc/<pid>/status text, or 0. */
export function parseVmRss (status: string, field = 'VmRSS'): number {
  const m = new RegExp(`^${field}:\\s+(\\d+)\\s+kB`, 'm').exec(status)
  return m ? Number(m[1]) * 1024 : 0
}

function ownSwap (): number {
  try { return parseVmRss(readFileSync('/proc/self/status', 'utf8'), 'VmSwap') } catch { return 0 }
}

/** Descendants of `pid` with their summed RSS (Linux /proc); null elsewhere. */
export function childrenRss (pid = process.pid): { count: number, rss: number } | null {
  const kids = (p: number): number[] => {
    const out: number[] = []
    try {
      for (const t of readdirSync(`/proc/${p}/task`)) {
        const txt = readFileSync(`/proc/${p}/task/${t}/children`, 'utf8').trim()
        if (txt) for (const c of txt.split(/\s+/)) out.push(Number(c))
      }
    } catch {}
    return out
  }
  try { readdirSync(`/proc/${pid}/task`) } catch { return null }
  let count = 0
  let rss = 0
  const todo = kids(pid)
  while (todo.length) {
    const c = todo.pop()!
    count++
    try { rss += parseVmRss(readFileSync(`/proc/${c}/status`, 'utf8')) } catch {}
    todo.push(...kids(c))
  }
  return { count, rss }
}

export interface MemLogSource {
  name: string
  counts: () => Record<string, number>
}

/** Starts the sampler; returns a stop function. Sources are read on every sample. */
export function startMemLog (opts: { intervalS: number, log: Logger, sources: () => MemLogSource[] }): () => void {
  const tick = (): void => {
    const u = process.memoryUsage()
    opts.log.info(formatMemSample({ ...u, swap: ownSwap(), children: childrenRss() }))
    for (const s of opts.sources()) {
      try { opts.log.info(formatCounts(s.name, s.counts())) } catch (e) { opts.log.warn(`${s.name}: ${(e as Error).message}`) }
    }
  }
  const t = setInterval(tick, opts.intervalS * 1000)
  t.unref()
  setTimeout(tick, 1000).unref()
  return () => clearInterval(t)
}
