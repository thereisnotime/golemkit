// LLM memory: a short-term ring buffer of recent events (chat, action results, hurt, joins)
// and long-term notes the model writes with `remember` and reads with `recall`, kept in
// agent.storage so they survive restarts.
import type { Storage } from '../core/index.ts'

export interface MemoryEvent {
  at: number
  kind: 'chat' | 'whisper' | 'self' | 'action' | 'event'
  from?: string
  text: string
}

export interface Note {
  at: number
  text: string
  /** Who the note is about or came from, when known. */
  about?: string
  /** Set by stores that dedup (MEMORY.md): what remember() did. */
  status?: 'added' | 'updated' | 'duplicate'
}

/**
 * Where long-term notes live. Default: agent.storage (`llm.notes`). A context pack swaps in
 * its MEMORY.md (src/context/memoryFile.ts), which then is the authoritative copy.
 */
export interface NoteStore {
  list (): Note[]
  add (text: string, about?: string): Note
  forget (match: string): number
}

export const NOTES_KEY = 'llm.notes'
const SUMMARY_KEY = 'llm.summary'

export interface MemoryOptions {
  /** Recent events kept verbatim. Default 40. */
  shortTermSize?: number
  /** Long-term notes kept (oldest dropped). Default 200. */
  maxNotes?: number
  /** Max characters per note. Default 300. */
  maxNoteChars?: number
  /** Long-term note backend; default agent.storage. */
  store?: NoteStore
}

export class Memory {
  private events: MemoryEvent[] = []
  private readonly size: number
  private readonly maxNotes: number
  private readonly maxNoteChars: number
  private readonly storage: Storage
  private readonly store: NoteStore | null

  constructor (storage: Storage, opts: MemoryOptions = {}) {
    this.storage = storage
    this.size = opts.shortTermSize ?? 40
    this.maxNotes = opts.maxNotes ?? 200
    this.maxNoteChars = opts.maxNoteChars ?? 300
    this.store = opts.store ?? null
  }

  /** True when notes go to a NoteStore (MEMORY.md) instead of agent.storage. */
  get external (): boolean {
    return this.store !== null
  }

  // -------------------------------------------------------------- short term

  push (e: Omit<MemoryEvent, 'at'> & { at?: number }): void {
    this.events.push({ at: e.at ?? Date.now(), kind: e.kind, from: e.from, text: e.text.slice(0, 400) })
    if (this.events.length > this.size) this.rollUp(this.events.splice(0, this.events.length - this.size))
  }

  recent (n = this.size, kinds?: MemoryEvent['kind'][]): MemoryEvent[] {
    const list = kinds ? this.events.filter(e => kinds.includes(e.kind)) : this.events
    return list.slice(-n)
  }

  /**
   * Old events are folded into a cheap rolling summary (who talked, how much, which actions
   * ran) instead of calling the model to summarise. Kept in storage so it survives restarts.
   */
  get summary (): string {
    return this.storage.get<string>(SUMMARY_KEY, '')
  }

  private rollUp (old: MemoryEvent[]): void {
    const speakers = new Map<string, number>()
    const actions = new Map<string, number>()
    for (const e of old) {
      if ((e.kind === 'chat' || e.kind === 'whisper') && e.from) speakers.set(e.from, (speakers.get(e.from) ?? 0) + 1)
      if (e.kind === 'action') {
        const name = e.text.split(/[\s:]/)[0] ?? 'action'
        actions.set(name, (actions.get(name) ?? 0) + 1)
      }
    }
    const parts: string[] = []
    if (speakers.size) parts.push(`talked with ${[...speakers].map(([p, n]) => `${p} (${n})`).join(', ')}`)
    if (actions.size) parts.push(`did ${[...actions].map(([a, n]) => `${a} x${n}`).join(', ')}`)
    if (!parts.length) return
    const line = `${new Date(old[0]!.at).toISOString().slice(0, 16)}: ${parts.join('; ')}`
    const lines = [...this.summary.split('\n').filter(Boolean), line].slice(-10)
    this.storage.set(SUMMARY_KEY, lines.join('\n'))
  }

  // -------------------------------------------------------------- long term

  notes (): Note[] {
    if (this.store) return this.store.list()
    return this.storage.get<Note[]>(NOTES_KEY, [])
  }

  remember (text: string, about?: string): Note {
    if (this.store) return this.store.add(text.trim().slice(0, this.maxNoteChars), about)
    const note: Note = { at: Date.now(), text: text.trim().slice(0, this.maxNoteChars) }
    if (about) note.about = about
    const notes = [...this.notes(), note].slice(-this.maxNotes)
    this.storage.set(NOTES_KEY, notes)
    return note
  }

  /** Notes matching any word of the query (case-insensitive), best matches first; latest notes without a query. */
  recall (query?: string, limit = 8): Note[] {
    const notes = this.notes()
    const words = (query ?? '').toLowerCase().split(/\W+/).filter(w => w.length > 1)
    if (!words.length) return notes.slice(-limit)
    return notes
      .map((n, i) => {
        const hay = `${n.text} ${n.about ?? ''}`.toLowerCase()
        return { n, i, score: words.filter(w => hay.includes(w)).length }
      })
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score || b.i - a.i)
      .slice(0, limit)
      .map(x => x.n)
  }

  forget (match: string): number {
    if (this.store) return this.store.forget(match)
    const before = this.notes()
    const kept = before.filter(n => !n.text.toLowerCase().includes(match.toLowerCase()))
    this.storage.set(NOTES_KEY, kept)
    return before.length - kept.length
  }
}

export function fmtEvent (e: MemoryEvent): string {
  const t = new Date(e.at).toISOString().slice(11, 19)
  switch (e.kind) {
    case 'chat': return `${t} <${e.from}> ${e.text}`
    case 'whisper': return `${t} (whisper) <${e.from}> ${e.text}`
    case 'self': return `${t} <you> ${e.text}`
    case 'action': return `${t} [action] ${e.text}`
    default: return `${t} [event] ${e.text}`
  }
}
