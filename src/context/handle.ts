// One context pack per agent, shared by the LLM brain (prompt, skills, MEMORY.md) and the
// hooks brain (hooks.yaml). Resolves the directories from settings, reloads on file changes
// (debounced) and registers the `context_status` action.
//
//   variant: settings.contextDefaults: 'variants/companion.context'    (optional defaults)
//   profile: context: profiles/pax  (or the sibling dir profiles/pax/, found automatically)
//            -> settings.context, an absolute path or list, or { dirs, memoryFile, caps, watch }
import { watch, type FSWatcher } from 'node:fs'
import type { Agent, Logger } from '../core/index.ts'
import { defineAction, noParams, ok, fail } from '../core/index.ts'
import { NOTES_KEY, type Note } from '../llm/memory.ts'
import type { PromptContext } from '../llm/prompt.ts'
import { layoutPack, loadContextPack, type ContextCaps, type ContextPack, type ContextPackOptions, type Layout } from './pack.ts'

export interface ContextSettings {
  dirs: string[]
  memoryFile?: string | false
  caps?: Partial<ContextCaps>
  /** Reload on file changes. Default true. */
  watch?: boolean
}

type AgentLike = Pick<Agent, 'settings' | 'log' | 'storage' | 'actionCatalog'> & Partial<Pick<Agent, 'getAction' | 'registerAction'>>

const asList = (v: unknown): string[] => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/** Reads context settings from agent.settings (variant defaults first, then the profile). Null when there is no pack. */
export function contextSettings (settings: Record<string, unknown>): ContextSettings | null {
  const defaults = asList(settings.contextDefaults)
  const c = settings.context
  if (c === false) return null
  let dirs = [...defaults]
  let extra: Omit<ContextSettings, 'dirs'> = {}
  if (typeof c === 'string' || Array.isArray(c)) dirs.push(...asList(c))
  else if (c && typeof c === 'object') {
    const o = c as Record<string, unknown>
    dirs.push(...asList(o.dirs ?? o.dir))
    extra = {
      ...(o.memoryFile !== undefined ? { memoryFile: o.memoryFile as string | false } : {}),
      ...(o.caps ? { caps: o.caps as Partial<ContextCaps> } : {}),
      ...(o.watch !== undefined ? { watch: !!o.watch } : {})
    }
  }
  dirs = [...new Set(dirs)]
  return dirs.length ? { dirs, ...extra } : null
}

export class ContextHandle {
  readonly settings: ContextSettings
  pack: ContextPack
  private layoutCache: Layout | null = null
  private memoryStamp = ''
  private readonly log: Logger
  private readonly opts: ContextPackOptions
  private readonly listeners = new Set<(pack: ContextPack) => void>()
  private watchers: FSWatcher[] = []
  private timer: NodeJS.Timeout | null = null
  private readonly catalog: () => string[]

  constructor (settings: ContextSettings, log: Logger, catalog: () => string[] = () => [], extra: ContextPackOptions = {}) {
    this.settings = settings
    this.log = log
    this.catalog = catalog
    this.opts = { caps: settings.caps, memoryFile: settings.memoryFile, ...extra }
    this.pack = this.load()
  }

  private load (): ContextPack {
    const catalog = this.catalog()
    const pack = loadContextPack(this.settings.dirs, { ...this.opts, ...(catalog.length ? { catalog } : {}) })
    for (const f of pack.files) this.log.debug(`loaded ${f.section}: ${f.file}`, { section: f.section, file: f.file, chars: f.chars, tokens: f.tokens, truncated: f.truncated || undefined })
    for (const w of pack.warnings) this.log.warn(w)
    const lay = layoutPack(pack)
    this.log.debug(`context pack: ${pack.files.length} files, ${pack.skills.length} skills, ${pack.hooks.length} hooks, ~${Math.ceil(lay.totalChars / 4)} prompt tokens`, {
      dirs: pack.dirs, sections: lay.sections.map(s => `${s.name}:${s.tokens}`).join(' '), memory: pack.memory?.path
    })
    return pack
  }

  reload (): void {
    try {
      this.pack = this.load()
      this.layoutCache = null
      for (const l of this.listeners) l(this.pack)
      this.log.info('context pack reloaded', { files: this.pack.files.length, skills: this.pack.skills.length, hooks: this.pack.hooks.length })
    } catch (e) {
      this.log.warn(`context reload failed, keeping the previous pack: ${(e as Error).message}`)
    }
  }

  onReload (fn: (pack: ContextPack) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** The system prompt part. Cached until a reload or a MEMORY.md change, so it is byte-stable between turns. */
  promptContext (): PromptContext {
    const stamp = this.pack.memory ? this.pack.memory.text() : ''
    if (!this.layoutCache || stamp !== this.memoryStamp) {
      this.layoutCache = layoutPack(this.pack)
      this.memoryStamp = stamp
    }
    return this.layoutCache.context
  }

  layout (): Layout {
    this.promptContext()
    return this.layoutCache!
  }

  /** Moves agent.storage notes into a new MEMORY.md once. Storage keeps its copy as a backup. */
  migrateNotes (storage: AgentLike['storage']): number {
    const mem = this.pack.memory
    if (!mem || mem.exists || storage.get(`${NOTES_KEY}.migratedTo`)) return 0
    const notes = storage.get<Note[]>(NOTES_KEY, [])
    const n = mem.migrate(notes)
    if (n) {
      storage.set(`${NOTES_KEY}.migratedTo`, mem.path)
      this.log.info(`migrated ${n} notes from storage to ${mem.path}`, { notes: n, file: mem.path })
    }
    return n
  }

  /** Watches the pack directories and reloads (debounced) on changes. */
  watch (debounceMs = 400): void {
    if (this.watchers.length || this.settings.watch === false) return
    for (const d of this.pack.dirs) {
      try {
        const w = watch(d, { recursive: true }, (_ev, file) => {
          if (file && /\.tmp$/.test(String(file))) return
          if (this.timer) clearTimeout(this.timer)
          this.timer = setTimeout(() => { this.timer = null; this.reload() }, debounceMs)
          this.timer.unref()
        })
        w.unref()
        this.watchers.push(w)
      } catch (e) {
        this.log.debug(`can't watch ${d}: ${(e as Error).message}`)
      }
    }
  }

  dispose (): void {
    for (const w of this.watchers) w.close()
    this.watchers = []
    if (this.timer) clearTimeout(this.timer)
  }

  status (): Record<string, unknown> {
    const lay = this.layout()
    return {
      dirs: this.pack.dirs,
      files: this.pack.files.map(f => ({ section: f.section, file: f.file, chars: f.chars, tokens: f.tokens, ...(f.truncated ? { truncated: f.truncated } : {}) })),
      promptTokens: Math.ceil(lay.totalChars / 4),
      sections: lay.sections,
      skills: this.pack.skills.map(s => s.name),
      hooks: this.pack.hooks.map(h => `${h.id} (${h.on})`),
      memory: this.pack.memory ? { file: this.pack.memory.path, notes: this.pack.memory.size, inPrompt: lay.context.memoryInPrompt } : null,
      warnings: this.pack.warnings
    }
  }

  /** One line for chat. */
  summary (): string {
    const lay = this.layout()
    const files = this.pack.files.filter(f => f.section !== 'skills').map(f => `${f.file.split('/').pop()} ${f.tokens ? `~${f.tokens}t` : ''}`.trim())
    return `context: ${files.join(', ') || 'no files'}; ${this.pack.skills.length} skills, ${this.pack.hooks.length} hooks, ` +
      `${this.pack.memory?.size ?? 0} memory notes, ~${Math.ceil(lay.totalChars / 4)} prompt tokens` +
      (this.pack.warnings.length ? `; ${this.pack.warnings.length} warnings` : '')
  }
}

// ------------------------------------------------------------------ per agent

const handles = new WeakMap<object, ContextHandle | null>()
type BusFn = (reason: string) => void
const budgetListeners = new WeakMap<object, Set<BusFn>>()

/** The agent's context pack, loaded on first use (null when no context is configured). */
export function contextFor (agent: AgentLike): ContextHandle | null {
  if (handles.has(agent)) return handles.get(agent) ?? null
  const settings = contextSettings(agent.settings)
  if (!settings) { handles.set(agent, null); return null }
  const log = agent.log.child('context')
  const h = new ContextHandle(settings, log, () => agent.actionCatalog().map(a => a.name))
  handles.set(agent, h)
  h.migrateNotes(agent.storage)
  h.watch()
  if (agent.getAction && agent.registerAction && !agent.getAction(contextStatusAction.name)) agent.registerAction(contextStatusAction)
  return h
}

export function disposeContext (agent: object): void {
  handles.get(agent)?.dispose()
  handles.delete(agent)
}

/** The LLM brain reports a budget pause; the hooks brain listens (llmBudgetExhausted). */
export function onLlmBudgetExhausted (agent: object, fn: BusFn): () => void {
  const set = budgetListeners.get(agent) ?? new Set<BusFn>()
  budgetListeners.set(agent, set)
  set.add(fn)
  return () => set.delete(fn)
}

export function emitLlmBudgetExhausted (agent: object, reason: string): void {
  for (const fn of budgetListeners.get(agent) ?? []) fn(reason)
}

export const contextStatusAction = defineAction({
  name: 'context_status',
  description: 'Show the loaded context pack: files and their sizes, prompt tokens, skills, hooks and memory notes.',
  params: noParams,
  exclusive: false,
  run: ({ agent }) => {
    const h = contextFor(agent)
    if (!h) return fail('no context pack configured')
    return ok(h.summary(), h.status())
  }
})
