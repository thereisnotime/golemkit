// Context pack: a directory of markdown/yaml files that shape an LLM bot. Nothing here does
// anything unless it is loaded: this module reads the files, caps them and lays them out
// into the system prompt (via PromptContext), and hands skills and hooks to the tools and
// the hooks brain.
//
//   AGENTS.md (or RULES.md)  operational rules           -> top of the system prompt
//   IDENTITY.md              name/role/persona            -> replaces the persona line
//   SOUL.md                  tone, behavioural style      -> after the framework rules
//   USER.md                  the owner(s), preferences
//   skills/                  procedures (index only)      -> read_skill loads the body
//   MEMORY.md                long-term notes              -> last (changes most often)
//   hooks.yaml               deterministic event rules    -> hooks brain, not the prompt
//
// Several directories can be stacked (variant defaults first, then the profile): for each
// markdown file the last directory that has it wins, skills merge by name (last wins), hooks
// are concatenated with later ids replacing earlier ones.
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { PromptContext } from '../llm/prompt.ts'
import { estimateTokens } from '../llm/usage.ts'
import { MemoryFile } from './memoryFile.ts'
import { loadSkills, skillIndex, validateSkills, type Skill } from './skills.ts'
import { parseHooks, type Hook } from './hooks.ts'

export type SectionName = 'rules' | 'identity' | 'soul' | 'user' | 'skills' | 'memory'

/** Character caps per section and for the whole pack (about 4 chars per token). */
export interface ContextCaps {
  rules: number
  identity: number
  soul: number
  user: number
  skills: number
  memory: number
  total: number
}

export const DEFAULT_CAPS: ContextCaps = {
  rules: 4000,
  identity: 1500,
  soul: 1500,
  user: 1500,
  skills: 1500,
  memory: 3000,
  total: 12000
}

/** File names per section, first match wins within one directory. */
export const SECTION_FILES: Record<Exclude<SectionName, 'skills' | 'memory'>, string[]> = {
  rules: ['AGENTS.md', 'RULES.md'],
  identity: ['IDENTITY.md'],
  soul: ['SOUL.md'],
  user: ['USER.md']
}

/** Prompt order. Rules and identity are placed by buildSystemPrompt; the rest follow the framework rules. */
export const LAYOUT: SectionName[] = ['rules', 'identity', 'soul', 'user', 'skills', 'memory']
const TITLES: Record<SectionName, string> = { rules: 'Operational rules', identity: 'Identity', soul: 'Tone and style', user: 'About the people you work for', skills: 'Skills', memory: 'Memory (MEMORY.md)' }
/** When the total cap is exceeded, cut in this order (most volatile / least important first). */
const CUT_ORDER: SectionName[] = ['memory', 'skills', 'soul', 'user', 'identity', 'rules']

export interface LoadedFile {
  section: SectionName | 'hooks'
  file: string
  chars: number
  tokens: number
  /** Characters cut by caps. */
  truncated: number
}

export interface ContextPackOptions {
  caps?: Partial<ContextCaps>
  /** Action names, to validate skills and hooks. */
  catalog?: string[]
  /** File or section names to leave out ("AGENTS.md", "skills", "hooks.yaml", "MEMORY.md", ...). Used by the A/B eval. */
  exclude?: string[]
  /** MEMORY.md location; default <last dir>/MEMORY.md. false = no memory file. */
  memoryFile?: string | false
}

export interface ContextPack {
  dirs: string[]
  files: LoadedFile[]
  /** Capped text per section (memory is read live from the MemoryFile on each prompt build). */
  text: Partial<Record<Exclude<SectionName, 'skills' | 'memory'>, string>>
  skills: Skill[]
  hooks: Hook[]
  memory: MemoryFile | null
  caps: ContextCaps
  warnings: string[]
  excluded: string[]
}

function isExcluded (exclude: string[], section: string, file?: string): boolean {
  const x = exclude.map(e => e.toLowerCase())
  return x.includes(section.toLowerCase()) || (!!file && x.includes(file.toLowerCase()))
}

export function loadContextPack (dirs: string[], opts: ContextPackOptions = {}): ContextPack {
  const caps = { ...DEFAULT_CAPS, ...opts.caps }
  const exclude = opts.exclude ?? []
  const abs = dirs.map(d => resolve(d))
  const warnings: string[] = []
  const files: LoadedFile[] = []
  const text: ContextPack['text'] = {}
  for (const d of abs) if (!existsSync(d)) warnings.push(`context dir ${d} does not exist`)

  for (const [section, names] of Object.entries(SECTION_FILES) as [keyof typeof SECTION_FILES, string[]][]) {
    let found: { file: string, body: string } | null = null
    for (const d of abs) {
      const name = names.find(n => existsSync(join(d, n)))
      if (name && !isExcluded(exclude, section, name)) found = { file: join(d, name), body: readFileSync(join(d, name), 'utf8') }
    }
    if (!found) continue
    const body = stripComments(found.body).trim()
    const capped = cap(body, caps[section])
    text[section] = capped
    files.push({ section, file: found.file, chars: body.length, tokens: estimateTokens(capped), truncated: body.length - Math.min(body.length, caps[section]) })
  }

  const skillMap = new Map<string, Skill>()
  if (!isExcluded(exclude, 'skills')) for (const d of abs) for (const s of loadSkills(join(d, 'skills'))) skillMap.set(s.name, s)
  const skills = [...skillMap.values()].sort((a, b) => a.name.localeCompare(b.name))
  if (opts.catalog) warnings.push(...validateSkills(skills, opts.catalog))
  for (const s of skills) files.push({ section: 'skills', file: s.file, chars: s.chars, tokens: estimateTokens(`- ${s.name}: ${s.description}`), truncated: 0 })

  const hookMap = new Map<string, Hook>()
  if (!isExcluded(exclude, 'hooks', 'hooks.yaml')) {
    for (const d of abs) {
      const f = ['hooks.yaml', 'hooks.yml'].map(n => join(d, n)).find(existsSync)
      if (!f) continue
      const body = readFileSync(f, 'utf8')
      try {
        const { hooks, warnings: w } = parseHooks(body, opts.catalog)
        warnings.push(...w.map(x => `${f}: ${x}`))
        for (const h of hooks) hookMap.set(h.id, h)
        files.push({ section: 'hooks', file: f, chars: body.length, tokens: 0, truncated: 0 })
      } catch (e) {
        warnings.push(`${f}: invalid, ignored: ${(e as Error).message}`)
      }
    }
  }

  let memory: MemoryFile | null = null
  if (opts.memoryFile !== false && abs.length && !isExcluded(exclude, 'memory', 'MEMORY.md')) {
    memory = new MemoryFile(opts.memoryFile ? resolve(opts.memoryFile) : join(abs[abs.length - 1]!, 'MEMORY.md'), { maxChars: Math.max(caps.memory * 2, 2000) })
    if (memory.exists) files.push({ section: 'memory', file: memory.path, chars: memory.text().length, tokens: estimateTokens(cap(memory.text(), caps.memory)), truncated: Math.max(0, memory.text().length - caps.memory) })
  }

  return { dirs: abs, files, text, skills, hooks: [...hookMap.values()], memory, caps, warnings, excluded: exclude }
}

/** HTML comments are notes for humans editing the file; they don't go to the model. */
function stripComments (s: string): string {
  return s.replace(/<!--[\s\S]*?-->/g, '')
}

export function cap (s: string, max: number): string {
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  const nl = cut.lastIndexOf('\n')
  return (nl > max * 0.7 ? cut.slice(0, nl) : cut) + `\n...(cut: ${s.length - max} more characters)`
}

/** Memory section text: the file without its header/instructions, newest notes kept when capped. */
export function memoryText (mem: MemoryFile | null, max: number): { text: string, complete: boolean } {
  if (!mem) return { text: '', complete: true }
  const notes = mem.list()
  if (!notes.length) return { text: '', complete: true }
  const lines = notes.map(n => `- ${n.about ? `[${n.about}] ` : ''}${n.text}`)
  // Keep the first lines (pinned and oldest facts are on top) until the cap; recall finds the rest.
  const out: string[] = []
  let n = 0
  for (const l of lines) {
    if (n + l.length + 1 > max) break
    out.push(l)
    n += l.length + 1
  }
  const complete = out.length === lines.length
  return { text: out.join('\n') + (complete ? '' : `\n(${lines.length - out.length} more notes: use recall)`), complete }
}

export interface Layout {
  context: PromptContext
  sections: { name: SectionName, chars: number, tokens: number }[]
  totalChars: number
}

/**
 * Builds the PromptContext. Order is fixed (rules, identity, soul, user, skills, memory) so
 * the prompt is stable for caching; memory goes last because it changes the most.
 * Over the total cap, sections are cut memory first, rules last.
 */
export function layoutPack (pack: ContextPack): Layout {
  const caps = pack.caps
  const mem = memoryText(pack.memory, caps.memory)
  const body: Record<SectionName, string> = {
    rules: pack.text.rules ?? '',
    identity: pack.text.identity ?? '',
    soul: pack.text.soul ?? '',
    user: pack.text.user ?? '',
    skills: cap(skillIndex(pack.skills), caps.skills),
    memory: mem.text
  }
  let total = LAYOUT.reduce((n, s) => n + body[s].length, 0)
  let memoryComplete = mem.complete
  for (const s of CUT_ORDER) {
    if (total <= caps.total) break
    const over = total - caps.total
    const keep = Math.max(0, body[s].length - over)
    const before = body[s].length
    // Leave room for the "(cut: ...)" marker so the section really shrinks; tiny leftovers are dropped.
    body[s] = keep >= 80 ? cap(body[s], keep - 40) : ''
    if (s === 'memory' && body[s].length < before) memoryComplete = false
    total = LAYOUT.reduce((n, x) => n + body[x].length, 0)
  }
  const sections = (['soul', 'user', 'skills', 'memory'] as SectionName[]).filter(s => body[s]).map(s => ({ title: TITLES[s], body: body[s] }))
  return {
    context: {
      ...(body.rules ? { rules: body.rules } : {}),
      ...(body.identity ? { identity: body.identity } : {}),
      sections,
      memoryInPrompt: !!pack.memory && memoryComplete
    },
    sections: LAYOUT.filter(s => body[s]).map(s => ({ name: s, chars: body[s].length, tokens: estimateTokens(body[s]) })),
    totalChars: total
  }
}
