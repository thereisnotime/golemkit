// Skills: reusable procedures written as markdown, loaded with progressive disclosure. Only
// each skill's name and one-line description go into the system prompt; the model calls
// read_skill to get the full procedure when it needs it (list_skills repeats the index).
//
//   skills/<name>/SKILL.md   or   skills/<name>.md
//   ---
//   name: gather-wood
//   description: Get logs and planks away from spawn.
//   actions: [goto, chop_tree, craft]     # optional; checked against the action catalog
//   ---
//   1. ...
//
// A skill is text for the model. Nothing in it is executed.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { expandEnv } from '../core/definition.ts'
import YAML from 'yaml'
import { z } from 'zod'
import type { ExtraTool } from '../llm/tools.ts'

export interface Skill {
  name: string
  description: string
  /** Action names the skill says it uses (frontmatter `actions`). */
  actions: string[]
  body: string
  file: string
  chars: number
  /** Frontmatter that didn't parse (the skill still loads, with fallbacks). */
  error?: string
}

export function parseFrontmatter (text: string): { meta: Record<string, unknown>, body: string, error?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!m) return { meta: {}, body: text }
  let meta: Record<string, unknown> = {}
  try {
    const parsed = YAML.parse(m[1]!)
    if (parsed && typeof parsed === 'object') meta = parsed as Record<string, unknown>
  } catch (e) {
    return { meta, body: m[2]!, error: (e as Error).message.split('\n')[0] }
  }
  return { meta, body: m[2]! }
}

const slug = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

export function parseSkill (text: string, file: string, fallbackName: string): Skill {
  const { meta, body, error } = parseFrontmatter(text)
  const name = slug(typeof meta.name === 'string' && meta.name ? meta.name : fallbackName) || slug(fallbackName)
  let description = typeof meta.description === 'string' ? meta.description.trim() : ''
  if (!description) description = body.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#')) ?? ''
  const actions = Array.isArray(meta.actions) ? meta.actions.filter((a): a is string => typeof a === 'string') : []
  return { name, description: description.replace(/\s+/g, ' ').slice(0, 200), actions, body: body.trim(), file, chars: text.length, ...(error ? { error } : {}) }
}

/** Reads skills/<name>/SKILL.md and skills/<name>.md from a directory. */
export function loadSkills (dir: string): Skill[] {
  if (!existsSync(dir)) return []
  const out: Skill[] = []
  for (const entry of readdirSync(dir).sort()) {
    const p = join(dir, entry)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) {
      const f = ['SKILL.md', 'skill.md'].map(n => join(p, n)).find(existsSync)
      if (f) out.push(parseSkill(expandEnv(readFileSync(f, 'utf8')), f, entry))
    } else if (entry.endsWith('.md')) {
      out.push(parseSkill(expandEnv(readFileSync(p, 'utf8')), p, basename(entry, '.md')))
    }
  }
  return out
}

/** LLM built-in tools (src/llm/tools.ts) a skill may name besides catalog actions. */
export const BUILTIN_TOOLS = ['observe', 'reply', 'say', 'whisper', 'recent_chat', 'remember', 'recall', 'list_skills', 'read_skill', 'set_goal', 'update_goal', 'complete_goal', 'abandon_goal', 'goal_status']

/** Warnings for skill actions that aren't in the bot's catalog (or built-in tools). */
export function validateSkills (skills: Skill[], catalog: string[]): string[] {
  const known = new Set([...catalog, ...BUILTIN_TOOLS])
  const warnings: string[] = []
  for (const s of skills) {
    if (s.error) warnings.push(`skill ${s.name}: frontmatter is not valid YAML (${s.error}); quote values that contain ": "`)
    const unknown = s.actions.filter(a => !known.has(a))
    if (unknown.length) warnings.push(`skill ${s.name}: unknown action${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')}`)
  }
  return warnings
}

export function skillIndex (skills: Skill[]): string {
  if (!skills.length) return ''
  return 'Procedures you can load with read_skill(name) before doing a task they cover. Read the skill first instead of improvising.\n' +
    skills.map(s => `- ${s.name}: ${s.description}`).join('\n')
}

/** list_skills / read_skill tools over a live skill list (re-read on every call, so hot reloads apply). */
export function skillTools (skills: () => Skill[], maxBodyChars = 6000): ExtraTool[] {
  return [
    {
      name: 'list_skills',
      description: 'List the procedures (skills) you can load with read_skill: name and what each is for.',
      schema: z.object({}),
      run: () => {
        const list = skills()
        return { ok: true, text: list.length ? list.map(s => `- ${s.name}: ${s.description}`).join('\n') : '(no skills)' }
      }
    },
    {
      name: 'read_skill',
      description: 'Load the full step-by-step procedure of a skill by name (see the skill index in your instructions). Read it before doing a task it covers.',
      schema: z.object({ name: z.string().min(1).describe('skill name from the index') }),
      run: ({ name }: { name: string }) => {
        const list = skills()
        const s = list.find(k => k.name === slug(name)) ?? list.find(k => k.name.includes(slug(name)))
        if (!s) return { ok: false, text: `no skill "${name}". Available: ${list.map(k => k.name).join(', ') || 'none'}` }
        const body = s.body.length > maxBodyChars ? s.body.slice(0, maxBodyChars) + '\n...(truncated)' : s.body
        return { ok: true, text: `# ${s.name}\n${s.description}\n\n${body}` }
      }
    }
  ]
}
