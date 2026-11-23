// Container memory (settings.inventoryMemory): what the bot saw inside chests, barrels and
// shulker boxes, kept per server and dimension in agent.storage so it survives restarts.
// Pure parts only: settings, the book of entries, diffs, age classes, double chest halves,
// the pantry-low check, "where is X" answers and the grumble lines. The Minecraft wiring
// (opening containers, block updates, journal, chat) is in containers.ts and the check_storage
// behaviour. Tests: test/container-memory.test.ts.
//
// The world is shared: players take things, move and break chests. An entry younger than
// maxAgeHours is a fact; an older one (or one marked `doubt`) is a hint, good for choosing which
// chest to try first, and re-checked on the spot before anything relies on it.

export interface MemorySettings {
  /** Persist container memory and keep it right (journal, world events). Default false: in memory only, as before. */
  enabled: boolean
  /** Entries older than this are hints, not facts. Default 24. */
  maxAgeHours: number
  /** check_storage looks into its own and configured chests not seen for this long. Default 60. */
  refreshMinutes: number
  /** Periodic check of its own and configured chests near home (check_storage). Default false. */
  indexOwn: boolean
  /** Chests within this many blocks of home are checked. Default 48. */
  radius: number
  /** Report the pantry low below this many food items (0 = never). Default 8. */
  lowFood: number
  /** Grumble once in chat when its own or configured chest is emptied, moved or broken by someone else. Default false. */
  grumble: boolean
  /** owners: whisper the owners online (nobody online: nothing) | say: public chat. Default owners. */
  grumbleTo: 'owners' | 'say'
  /** At most one grumble per container this often. Default 3. */
  grumbleHours: number
}

export const MEMORY_DEFAULTS: MemorySettings = {
  enabled: false,
  maxAgeHours: 24,
  refreshMinutes: 60,
  indexOwn: false,
  radius: 48,
  lowFood: 8,
  grumble: false,
  grumbleTo: 'owners',
  grumbleHours: 3
}

/** settings.inventoryMemory (true/false or options) over the defaults; bad values fall back. */
export function memorySettings (raw: unknown): MemorySettings {
  if (raw === true) return { ...MEMORY_DEFAULTS, enabled: true }
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  const out: MemorySettings = { ...MEMORY_DEFAULTS }
  for (const k of Object.keys(MEMORY_DEFAULTS) as (keyof MemorySettings)[]) {
    const v = o[k]
    if (v === undefined || typeof v !== typeof MEMORY_DEFAULTS[k]) continue
    if (typeof v === 'number' && (!Number.isFinite(v) || v < 0)) continue
    (out as unknown as Record<string, unknown>)[k] = v
  }
  if (out.grumbleTo !== 'say') out.grumbleTo = 'owners'
  if (out.maxAgeHours <= 0) out.maxAgeHours = MEMORY_DEFAULTS.maxAgeHours
  if (out.refreshMinutes < 1) out.refreshMinutes = 1
  return out
}

// ------------------------------------------------------------------ entries

export interface Pos { x: number, y: number, z: number }

export interface ContainerEntry {
  /** Block name (chest, barrel, white_shulker_box, ...). */
  block: string
  /** What was inside when last opened; null = seen from outside only (contents unknown). */
  contents: Record<string, number> | null
  /** When the contents were seen (0 when never). */
  at: number
  /** When the block was last seen in place. */
  verifiedAt: number
  /** The other half of a double chest ("x y z"); the entry is keyed by the lower half. */
  alt?: string
  /** Something changed that makes the contents doubtful (half of the double chest broken, a second half added). */
  doubt?: boolean
  /** Why it is remembered without contents ("placed in view", "near where my chest was"). */
  note?: string
}

export const posKey = (p: Pos): string => `${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}`

export function parseKey (k: string): Pos {
  const [x, y, z] = k.split(' ').map(Number) as [number, number, number]
  return { x, y, z }
}

/** Memory is per server and dimension: "host:port|minecraft:overworld". */
export const scopeKey = (server: string, dim: string | undefined): string => `${server}|${dim ?? 'minecraft:overworld'}`

export type Freshness = 'fresh' | 'hint' | 'unknown'

/** fresh: seen inside within maxAge; hint: older or doubtful; unknown: never seen inside. */
export function freshness (e: Pick<ContainerEntry, 'contents' | 'at' | 'doubt'>, now: number, maxAgeMs: number): Freshness {
  if (!e.contents) return 'unknown'
  if (e.doubt || now - e.at > maxAgeMs) return 'hint'
  return 'fresh'
}

/** "just now", "5 min ago", "2 h ago", "3 days ago". */
export function fmtAge (ms: number): string {
  const m = Math.round(Math.max(0, ms) / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} h ago`
  return `${Math.round(h / 24)} days ago`
}

export interface ContentsDiff { gone: Record<string, number>, added: Record<string, number> }

/** What went missing and what turned up between two looks inside. */
export function diffContents (before: Record<string, number>, after: Record<string, number>): ContentsDiff {
  const gone: Record<string, number> = {}
  const added: Record<string, number> = {}
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const d = (after[k] ?? 0) - (before[k] ?? 0)
    if (d < 0) gone[k] = -d
    else if (d > 0) added[k] = d
  }
  return { gone, added }
}

export const diffEmpty = (d: ContentsDiff): boolean => !Object.keys(d.gone).length && !Object.keys(d.added).length

const total = (c: Record<string, number>): number => Object.values(c).reduce((n, v) => n + v, 0)

function fmtCounts (c: Record<string, number>, max = 4): string {
  const e = Object.entries(c).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  return e.slice(0, max).map(([k, n]) => `${n} ${k}`).join(', ') + (e.length > max ? ` +${e.length - max} more` : '')
}

/** "12 bread gone, 3 apple added". */
export function fmtDiff (d: ContentsDiff): string {
  const parts: string[] = []
  if (Object.keys(d.gone).length) parts.push(`${fmtCounts(d.gone)} gone`)
  if (Object.keys(d.added).length) parts.push(`${fmtCounts(d.added)} added`)
  return parts.join(', ') || 'no change'
}

// ------------------------------------------------------------------ double chests

const CW: Record<string, string> = { north: 'east', east: 'south', south: 'west', west: 'north' }
const CCW: Record<string, string> = { north: 'west', west: 'south', south: 'east', east: 'north' }
const STEP: Record<string, [number, number]> = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }

/**
 * The other half of a double chest from the block state (ChestBlock.getConnectedDirection:
 * a left half connects clockwise of its facing, a right half counter-clockwise). Null for a single chest.
 */
export function chestPartner (p: Pos, facing: unknown, type: unknown): Pos | null {
  if (typeof facing !== 'string' || !STEP[facing] || (type !== 'left' && type !== 'right')) return null
  const dir = type === 'left' ? CW[facing]! : CCW[facing]!
  const [dx, dz] = STEP[dir]!
  return { x: p.x + dx, y: p.y, z: p.z + dz }
}

/** The half a double chest is keyed by (lowest x, then z), and the other one. */
export function chestHalves (p: Pos, partner: Pos | null): { key: Pos, alt: Pos | null } {
  if (!partner) return { key: p, alt: null }
  const pFirst = p.x < partner.x || (p.x === partner.x && p.z < partner.z)
  return pFirst ? { key: p, alt: partner } : { key: partner, alt: p }
}

// ------------------------------------------------------------------ the book

/** The bit of agent.storage the book needs (core/storage.ts). */
export interface KV {
  get<T> (key: string, fallback: T): T
  set (key: string, value: unknown): void
}

export const MEMORY_KEY = 'containers.memory'
/** Entries kept per scope; the ones not seen for longest go first. */
export const MAX_ENTRIES = 256
/** Of those, entries without contents (seen from outside only). */
export const MAX_UNKNOWN = 64

type Scopes = Record<string, Record<string, ContainerEntry>>

class MemoryKV implements KV {
  private data: Record<string, unknown> = {}
  get<T> (key: string, fallback: T): T { return (key in this.data ? this.data[key] : fallback) as T }
  set (key: string, value: unknown): void { this.data[key] = value }
}

/**
 * Container entries per scope (server + dimension), keyed "x y z" (a double chest by its lower
 * half, found by either). Backed by agent.storage when memory is on, by a plain map otherwise.
 */
export class ContainerBook {
  private readonly kv: KV
  private readonly key: string
  private alias: Map<string, Map<string, string>> | null = null

  constructor (kv?: KV | null, key = MEMORY_KEY) {
    this.kv = kv ?? new MemoryKV()
    this.key = key
  }

  private all (): Scopes { return this.kv.get<Scopes>(this.key, {}) }

  private save (s: Scopes): void {
    this.kv.set(this.key, s)
    this.alias = null
  }

  /** "x y z" of either half -> the key the entry is stored under. */
  private resolve (scope: string, k: string): string | null {
    const s = this.all()[scope]
    if (!s) return null
    if (s[k]) return k
    if (!this.alias) {
      this.alias = new Map()
      for (const [sc, entries] of Object.entries(this.all())) {
        const m = new Map<string, string>()
        for (const [ek, e] of Object.entries(entries)) if (e.alt) m.set(e.alt, ek)
        this.alias.set(sc, m)
      }
    }
    return this.alias.get(scope)?.get(k) ?? null
  }

  get (scope: string, p: Pos): { pos: Pos, key: string, entry: ContainerEntry } | null {
    const k = this.resolve(scope, posKey(p))
    if (!k) return null
    const entry = this.all()[scope]![k]!
    return { pos: parseKey(k), key: k, entry }
  }

  has (scope: string, p: Pos): boolean {
    return this.resolve(scope, posKey(p)) !== null
  }

  /** Writes the entry under `p` (the key half); drops entries stored under either half. */
  put (scope: string, p: Pos, entry: ContainerEntry): void {
    const all = { ...this.all() }
    const s = { ...(all[scope] ?? {}) }
    const k = posKey(p)
    for (const half of [k, entry.alt].filter((h): h is string => !!h)) {
      const old = this.resolve(scope, half)
      if (old && old !== k) delete s[old]
    }
    s[k] = stripUndefined(entry)
    all[scope] = prune(s)
    this.save(all)
  }

  /** Changes fields of an existing entry. */
  update (scope: string, p: Pos, patch: Partial<ContainerEntry>): void {
    const g = this.get(scope, p)
    if (!g) return
    const all = { ...this.all() }
    all[scope] = { ...all[scope], [g.key]: stripUndefined({ ...g.entry, ...patch }) }
    this.save(all)
  }

  drop (scope: string, p: Pos): ContainerEntry | null {
    const g = this.get(scope, p)
    if (!g) return null
    const all = { ...this.all() }
    const s = { ...all[scope] }
    delete s[g.key]
    all[scope] = s
    this.save(all)
    return g.entry
  }

  list (scope: string): { pos: Pos, entry: ContainerEntry }[] {
    return Object.entries(this.all()[scope] ?? {}).map(([k, entry]) => ({ pos: parseKey(k), entry }))
  }

  /** Every scope, for moving the in-memory entries over when memory is switched on. */
  scopes (): string[] { return Object.keys(this.all()) }
}

function stripUndefined (e: ContainerEntry): ContainerEntry {
  const out = { ...e }
  for (const k of Object.keys(out) as (keyof ContainerEntry)[]) if (out[k] === undefined) delete out[k]
  return out
}

/** Keeps at most MAX_ENTRIES (MAX_UNKNOWN without contents), dropping the least recently seen. */
export function prune (s: Record<string, ContainerEntry>): Record<string, ContainerEntry> {
  const seen = (e: ContainerEntry) => Math.max(e.at, e.verifiedAt)
  const entries = Object.entries(s)
  const unknown = entries.filter(([, e]) => !e.contents).sort((a, b) => seen(b[1]) - seen(a[1]))
  const drop = new Set(unknown.slice(MAX_UNKNOWN).map(([k]) => k))
  const kept = entries.filter(([k]) => !drop.has(k)).sort((a, b) => seen(b[1]) - seen(a[1])).slice(0, MAX_ENTRIES)
  if (kept.length === entries.length) return s
  return Object.fromEntries(kept)
}

/** Merges what was seen inside into the entry; returns the new entry and what changed since the last look. */
export function observeContents (prev: ContainerEntry | null, block: string, contents: Record<string, number>, now: number, alt?: string): { entry: ContainerEntry, diff: ContentsDiff | null } {
  const entry: ContainerEntry = { block, contents, at: now, verifiedAt: now, ...(alt ? { alt } : {}) }
  if (!prev?.contents || prev.block !== block) return { entry, diff: null }
  const diff = diffContents(prev.contents, contents)
  return { entry, diff: diffEmpty(diff) ? null : diff }
}

/** Own or configured chests that check_storage should look into: none seen inside within `refreshMs`, nearest first. */
export function checkDue (chests: Pos[], lookup: (p: Pos) => ContainerEntry | null, now: number, refreshMs: number, from: Pos): Pos[] {
  return chests
    .filter(p => {
      const e = lookup(p)
      return !e || !e.contents || e.doubt || now - e.at >= refreshMs
    })
    .sort((a, b) => Math.hypot(a.x - from.x, a.z - from.z) - Math.hypot(b.x - from.x, b.z - from.z))
}

// ------------------------------------------------------------------ pantry low

/** "6 bread, 2 apple left" when the food in the pantry is below `threshold` items, else null. */
export function pantryLow (contents: Record<string, number>[], isFood: (name: string) => boolean, threshold: number): { items: number, text: string } | null {
  if (threshold <= 0 || !contents.length) return null
  const food: Record<string, number> = {}
  for (const c of contents) for (const [k, v] of Object.entries(c)) if (isFood(k)) food[k] = (food[k] ?? 0) + v
  const items = total(food)
  if (items >= threshold) return null
  return { items, text: items ? `pantry low: ${fmtCounts(food, 3)} left` : 'pantry low: no food left' }
}

// ------------------------------------------------------------------ where is X

export interface WhereHit { pos: Pos, block: string, item: string, count: number, ageMs: number, fresh: boolean }

/** Item names that answer a question about `query` ("iron" -> iron_ingot, raw_iron, iron_ore, ...); exact first. */
export function itemMatches (query: string, name: string): 0 | 1 | 2 {
  const q = query.toLowerCase().replace(/^minecraft:/, '').trim().replace(/\s+/g, '_').replace(/s$/, '')
  const n = name.toLowerCase().replace(/^minecraft:/, '')
  if (n === q || n === `${q}s`) return 2
  const qt = q.split('_').filter(Boolean)
  const nt = n.split('_')
  return qt.length && qt.every(t => nt.includes(t) || nt.includes(`${t}s`)) ? 1 : 0
}

/** Where the bot remembers `item`: containers holding it, exact names first, then fresh, then more, then nearer. */
export function whereIs (entries: { pos: Pos, entry: ContainerEntry }[], item: string, now: number, maxAgeMs: number, from?: Pos): WhereHit[] {
  const hits: (WhereHit & { rank: number })[] = []
  for (const { pos, entry } of entries) {
    if (!entry.contents) continue
    const fresh = freshness(entry, now, maxAgeMs) === 'fresh'
    for (const [name, count] of Object.entries(entry.contents)) {
      const rank = itemMatches(item, name)
      if (rank && count > 0) hits.push({ pos, block: entry.block, item: name, count, ageMs: now - entry.at, fresh, rank })
    }
  }
  const d = (p: Pos) => from ? Math.hypot(p.x - from.x, p.y - from.y, p.z - from.z) : 0
  const best = Math.max(0, ...hits.map(h => h.rank))
  return hits.filter(h => h.rank === best)
    .sort((a, b) => Number(b.fresh) - Number(a.fresh) || b.count - a.count || d(a.pos) - d(b.pos))
    .map(({ rank: _r, ...h }) => h)
}

/** "12 iron_ingot in the chest at 559 69 -47, seen 2 h ago (maybe gone since)". */
export function fmtWhere (hits: WhereHit[], max = 3): string {
  return hits.slice(0, max).map(h => `${h.count} ${h.item} in the ${h.block.replace(/_/g, ' ')} at ${posKey(h.pos)}, seen ${fmtAge(h.ageMs)}${h.fresh ? '' : ' (may have changed)'}`).join('; ') +
    (hits.length > max ? `; +${hits.length - max} more` : '')
}

// ------------------------------------------------------------------ grumbling

export type GrumbleKind = 'taken' | 'emptied' | 'gone' | 'moved'

/** Short, mild lines; {item} and {what} are filled in. No profanity. */
export const GRUMBLES: Record<GrumbleKind, string[]> = {
  taken: ['who took my {item}?!', 'hey, someone took my {item}', '{what} missing from my chest... hmm', 'my {item}! where did it go?'],
  emptied: ['who emptied my chest?!', 'someone cleaned out my chest... rude', 'my chest is empty. who did this?'],
  gone: ['my chest is gone... rude', 'who broke my chest?!', 'hey, where did my chest go?'],
  moved: ['who moved my chest?', 'my chest wandered off a few blocks', 'someone moved my chest. why?']
}

/**
 * Whether to grumble about a container change and with which line. Not when off, not more than
 * once per container per `everyMs`, and not about things added (only taken, emptied, moved, gone).
 */
export function chooseGrumble (
  kind: GrumbleKind, vars: { item?: string, what?: string }, opts: { enabled: boolean, lastAt?: number, everyMs: number, now: number, lastLine?: string, rand?: () => number }
): string | null {
  if (!opts.enabled) return null
  if (opts.lastAt !== undefined && opts.now - opts.lastAt < opts.everyMs) return null
  const lines = GRUMBLES[kind].filter(l => (vars.item || !l.includes('{item}')) && (vars.what || !l.includes('{what}')))
  const pool = lines.length > 1 && opts.lastLine ? lines.filter(l => fill(l, vars) !== opts.lastLine) : lines
  if (!pool.length) return null
  const r = opts.rand ?? Math.random
  return fill(pool[Math.min(pool.length - 1, Math.floor(r() * pool.length))]!, vars)
}

const fill = (l: string, v: { item?: string, what?: string }) => l.replace('{item}', (v.item ?? '').replace(/_/g, ' ')).replace('{what}', v.what ?? '')

/** What a change looks like from the owner's side: taken (some gone), emptied (all gone), or nothing to grumble about. */
export function changeKind (before: Record<string, number>, after: Record<string, number>, d: ContentsDiff): { kind: 'taken' | 'emptied', item: string, what: string } | null {
  const gone = Object.entries(d.gone).sort((a, b) => b[1] - a[1])
  if (!gone.length) return null
  const emptied = total(after) === 0 && total(before) > 0
  return { kind: emptied ? 'emptied' : 'taken', item: gone[0]![0], what: fmtCounts(d.gone, 2).replace(/_/g, ' ') }
}
