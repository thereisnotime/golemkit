// MEMORY.md: the bot's long-term notes as a markdown file a human can read and edit. When a
// context pack is active this file is the authoritative note store (the `remember` tool
// writes here, `recall` and the system prompt read from here). agent.storage `llm.notes` is
// only read once, to migrate old notes into a new MEMORY.md.
//
// Format: one fact per bullet line ("- [about] text"). Headings and other lines are kept as
// they are. Bullets under a heading containing "pinned" are never deduped away or trimmed.
// New notes go at the end of the "## Notes" section (or the end of the file).
//
// Size control is deterministic, no model call: near-duplicates update the existing line in
// place, and when the file is over its caps the oldest unpinned notes about the same topic are
// merged into one line, then the oldest unpinned notes are dropped.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Note, NoteStore } from '../llm/memory.ts'

export interface MemoryFileOptions {
  /** Max bullet entries kept. Default 80. */
  maxEntries?: number
  /** Max characters of the whole file. Default 6000. */
  maxChars?: number
  /** Max characters per note. Default 300. */
  maxNoteChars?: number
  /** Word-overlap ratio (Jaccard) at which a new note replaces an old one about the same thing. Default 0.7. */
  similarity?: number
}

interface Line {
  raw: string
  /** Set for bullet lines. */
  note?: { text: string, about?: string, pinned: boolean }
}

export const MEMORY_TEMPLATE = `# Memory

Facts the bot keeps between sessions. Edit freely: one fact per line starting with "- ",
optionally "- [topic] fact". Lines under "## Pinned" are never trimmed. The bot's remember
tool adds lines under "## Notes", merges near-duplicates and trims the oldest when the file
gets too long.

## Pinned

## Notes
`

const BULLET = /^\s*[-*]\s+(?:\[([^\]]{1,40})\]\s*)?(.+?)\s*$/

export function normalize (s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim()
}

function words (s: string): Set<string> {
  return new Set(normalize(s).split(' ').filter(w => w.length > 1))
}

export function jaccard (a: string, b: string): number {
  const A = words(a)
  const B = words(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const w of A) if (B.has(w)) inter++
  return inter / (A.size + B.size - inter)
}

export class MemoryFile implements NoteStore {
  readonly path: string
  private readonly opts: Required<MemoryFileOptions>
  private lines: Line[] = []
  private mtime = -1
  /** Notes merged or dropped by the last trim (for logs). */
  lastTrim = { merged: 0, dropped: 0 }

  constructor (path: string, opts: MemoryFileOptions = {}) {
    this.path = path
    this.opts = {
      maxEntries: opts.maxEntries ?? 80,
      maxChars: opts.maxChars ?? 6000,
      maxNoteChars: opts.maxNoteChars ?? 300,
      similarity: opts.similarity ?? 0.7
    }
  }

  get exists (): boolean {
    return existsSync(this.path)
  }

  /** Re-reads the file when it changed on disk (hand edits). */
  private load (): void {
    let m = -2
    try { m = statSync(this.path).mtimeMs } catch {}
    if (m === this.mtime) return
    this.mtime = m
    let text = ''
    try { text = readFileSync(this.path, 'utf8') } catch {}
    this.lines = parse(text)
  }

  private save (): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const body = (this.lines.length ? this.lines : parse(MEMORY_TEMPLATE)).map(l => l.raw).join('\n').replace(/\n*$/, '\n')
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, body)
    renameSync(tmp, this.path)
    try { this.mtime = statSync(this.path).mtimeMs } catch {}
  }

  /** The whole file as text (empty if missing). */
  text (): string {
    this.load()
    return this.lines.map(l => l.raw).join('\n').trim()
  }

  list (): Note[] {
    this.load()
    return this.lines.filter(l => l.note).map(l => ({ at: 0, text: l.note!.text, ...(l.note!.about ? { about: l.note!.about } : {}) }))
  }

  get size (): number {
    return this.list().length
  }

  add (text: string, about?: string): Note {
    this.load()
    if (!this.lines.length) this.lines = parse(MEMORY_TEMPLATE)
    const clean = text.replace(/\s+/g, ' ').trim().slice(0, this.opts.maxNoteChars)
    const topic = about?.replace(/[\[\]\n]/g, '').trim().slice(0, 40) || undefined
    const n = normalize(clean)
    const result: Note = { at: Date.now(), text: clean, ...(topic ? { about: topic } : {}) }
    // Exact duplicate (any topic): nothing to do.
    if (this.lines.some(l => l.note && normalize(l.note.text) === n)) return { ...result, status: 'duplicate' }
    // Near duplicate about the same topic: newer wording wins, position is kept.
    const near = this.lines.find(l => {
      if (!l.note || l.note.pinned) return false
      if ((l.note.about ?? '').toLowerCase() !== (topic ?? '').toLowerCase()) return false
      const o = normalize(l.note.text)
      return o.includes(n) || n.includes(o) || jaccard(o, n) >= this.opts.similarity
    })
    if (near) {
      near.note = { text: clean, about: topic, pinned: false }
      near.raw = fmtBullet(clean, topic)
      this.trim()
      this.save()
      return { ...result, status: 'updated' }
    }
    this.lines.splice(this.insertAt(), 0, { raw: fmtBullet(clean, topic), note: { text: clean, about: topic, pinned: false } })
    this.trim()
    this.save()
    return { ...result, status: 'added' }
  }

  forget (match: string): number {
    this.load()
    const m = match.toLowerCase()
    const before = this.lines.length
    this.lines = this.lines.filter(l => !(l.note && !l.note.pinned && l.note.text.toLowerCase().includes(m)))
    const removed = before - this.lines.length
    if (removed) this.save()
    return removed
  }

  /** Writes notes (from agent.storage) into a new file. Returns how many were written. */
  migrate (notes: Note[]): number {
    if (this.exists || !notes.length) return 0
    this.lines = parse(MEMORY_TEMPLATE)
    let n = 0
    for (const note of notes) {
      const r = this.add(note.text, note.about)
      if (r.status !== 'duplicate') n++
    }
    return n
  }

  /** Index after the last line of the "Notes" section, or the end of the file. */
  private insertAt (): number {
    const head = this.lines.findIndex(l => /^#{1,6}\s+notes\b/i.test(l.raw))
    if (head < 0) {
      let end = this.lines.length
      while (end > 0 && !this.lines[end - 1]!.raw.trim()) end--
      return end
    }
    let i = head + 1
    let lastContent = head
    while (i < this.lines.length && !/^#{1,6}\s/.test(this.lines[i]!.raw)) {
      if (this.lines[i]!.raw.trim()) lastContent = i
      i++
    }
    return lastContent + 1
  }

  private chars (): number {
    return this.lines.reduce((n, l) => n + l.raw.length + 1, 0)
  }

  private trim (): void {
    this.lastTrim = { merged: 0, dropped: 0 }
    const over = () => this.lines.filter(l => l.note).length > this.opts.maxEntries || this.chars() > this.opts.maxChars
    // 1) Merge the oldest unpinned notes that share a topic into one line.
    while (over()) {
      // Groups in order of their oldest member, so the oldest topic gets compacted first.
      const unpinned = this.lines.filter(l => l.note && !l.note.pinned && l.note.about)
      const groups = new Map<string, Line[]>()
      for (const l of unpinned) {
        const k = l.note!.about!.toLowerCase()
        groups.set(k, [...(groups.get(k) ?? []), l])
      }
      const group = [...groups.values()].find(g => g.length >= 2)
      if (!group) break
      const [first, second] = group as [Line, Line]
      const merged = `${first.note!.text}; ${second.note!.text}`.slice(0, this.opts.maxNoteChars)
      first.note = { text: merged, about: first.note!.about, pinned: false }
      first.raw = fmtBullet(merged, first.note.about)
      this.lines.splice(this.lines.indexOf(second), 1)
      this.lastTrim.merged++
    }
    // 2) Drop the oldest unpinned notes.
    while (over()) {
      const i = this.lines.findIndex(l => l.note && !l.note.pinned)
      if (i < 0) break
      this.lines.splice(i, 1)
      this.lastTrim.dropped++
    }
  }
}

function fmtBullet (text: string, about?: string): string {
  return `- ${about ? `[${about}] ` : ''}${text}`
}

function parse (text: string): Line[] {
  const out: Line[] = []
  let pinned = false
  let inFence = false
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    if (/^\s*```/.test(raw)) inFence = !inFence
    const heading = /^#{1,6}\s+(.*)$/.exec(raw)
    if (heading && !inFence) pinned = /pinned/i.test(heading[1]!)
    const m = !inFence && !heading ? BULLET.exec(raw) : null
    out.push(m ? { raw, note: { text: m[2]!, about: m[1]?.trim() || undefined, pinned } } : { raw })
  }
  while (out.length && !out[out.length - 1]!.raw.trim()) out.pop()
  return out
}
