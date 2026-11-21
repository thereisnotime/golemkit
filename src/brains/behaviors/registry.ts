// The behaviour registry: definitions by name, option validation (zod, strict) and parsing of
// chat-style option strings ("radius=8 animals=cow,pig").
import { z } from 'zod'
import type { BehaviorDefinition, BehaviorLevel } from './types.ts'

export type Options = Record<string, unknown>
export type ValidateResult = { ok: true, options: Options } | { ok: false, error: string }

const LEVEL_NAMES = ['idle', 'npc', 'behavior'] as const satisfies readonly BehaviorLevel[]

const COMMON = {
  priority: z.enum(LEVEL_NAMES).optional()
    .describe('idle (10), npc (20) or behavior (35, above the LLM); default depends on the behaviour')
}

export class BehaviorRegistry {
  private readonly defs = new Map<string, BehaviorDefinition<any>>()
  private readonly schemas = new Map<string, z.ZodObject>()

  constructor (defs: BehaviorDefinition<any>[] = []) {
    for (const d of defs) this.register(d)
  }

  register (def: BehaviorDefinition<any>): this {
    if (!/^[a-z][a-z0-9_]*$/.test(def.name)) throw new Error(`behaviour name "${def.name}" must be snake_case`)
    if (this.defs.has(def.name)) throw new Error(`duplicate behaviour "${def.name}"`)
    this.defs.set(def.name, def)
    this.schemas.set(def.name, def.options.extend(COMMON).strict())
    return this
  }

  get (name: string): BehaviorDefinition<any> | undefined {
    return this.defs.get(name)
  }

  has (name: string): boolean {
    return this.defs.has(name)
  }

  list (): BehaviorDefinition<any>[] {
    return [...this.defs.values()]
  }

  names (): string[] {
    return [...this.defs.keys()]
  }

  /** The full options schema (the definition's plus the common `priority`). */
  schema (name: string): z.ZodObject {
    const s = this.schemas.get(name)
    if (!s) throw new Error(`unknown behaviour "${name}"`)
    return s
  }

  /** Validates raw options for a behaviour; defaults are filled in. */
  validate (name: string, raw: unknown = {}): ValidateResult {
    if (!this.defs.has(name)) return { ok: false, error: this.unknown(name) }
    if (raw !== undefined && (typeof raw !== 'object' || raw === null || Array.isArray(raw))) {
      return { ok: false, error: `options for ${name} must be an object (key: value)` }
    }
    const r = this.schema(name).safeParse(raw ?? {})
    if (r.success) return { ok: true, options: r.data as Options }
    const issues = r.error.issues.map(i => {
      const path = i.path.length ? i.path.join('.') : ''
      if (i.code === 'unrecognized_keys') {
        const known = Object.keys(this.schema(name).shape).join(', ')
        return `unknown option${i.keys.length > 1 ? 's' : ''} ${i.keys.join(', ')} (options: ${known})`
      }
      return path ? `${path}: ${i.message}` : i.message
    })
    return { ok: false, error: `bad options for ${name}: ${issues.join('; ')}` }
  }

  /** "unknown behaviour x (known: a, b, c)" with a close match first when there is one. */
  unknown (name: string): string {
    const close = this.names().filter(n => n.includes(name) || name.includes(n) || n.split('_')[0] === name.split('_')[0])
    return `unknown behaviour "${name}"${close.length ? `, did you mean ${close.join(' or ')}?` : ''} (known: ${this.names().join(', ')})`
  }

  /**
   * Turns option input into an object: an object passes through, a string is parsed as JSON
   * ("{...}") or as "key=value" pairs separated by spaces. Values are converted to what the
   * schema wants: numbers, booleans, and comma lists for arrays.
   */
  coerce (name: string, input: unknown): Options | string {
    if (input === undefined || input === null || input === '') return {}
    if (typeof input === 'object' && !Array.isArray(input)) return input as Options
    if (typeof input !== 'string') return `options for ${name} must be an object or "key=value" pairs`
    const text = input.trim()
    if (text.startsWith('{')) {
      try {
        const v = JSON.parse(text)
        return v && typeof v === 'object' && !Array.isArray(v) ? v : `options for ${name} must be a JSON object`
      } catch (e) {
        return `options for ${name} are not valid JSON: ${(e as Error).message}`
      }
    }
    if (!this.defs.has(name)) return this.unknown(name)
    const shape = this.schema(name).shape as Record<string, z.ZodType>
    const out: Options = {}
    for (const part of text.split(/\s+/).filter(Boolean)) {
      const m = /^([a-zA-Z_]\w*)[=:](.*)$/.exec(part)
      if (!m) return `can't read "${part}": write options as key=value, e.g. ${exampleFor(shape)}`
      const [, key, raw] = m as unknown as [string, string, string]
      out[key] = shape[key] ? convert(shape[key]!, raw) : raw
    }
    return out
  }
}

function exampleFor (shape: Record<string, z.ZodType>): string {
  const k = Object.keys(shape).find(k => k !== 'priority') ?? 'priority'
  return `${k}=...`
}

function accepts (schema: z.ZodType, sample: unknown): boolean {
  return schema.safeParse(sample).success
}

function scalar (schema: z.ZodType, raw: string): unknown {
  if (raw.trim() !== '' && !Number.isNaN(Number(raw)) && accepts(schema, Number(raw))) return Number(raw)
  if (/^(true|false|on|off|yes|no)$/i.test(raw) && accepts(schema, true)) return /^(true|on|yes)$/i.test(raw)
  return raw
}

function convert (schema: z.ZodType, raw: string): unknown {
  if (accepts(schema, []) && !accepts(schema, raw)) {
    const items = raw.split(',').map(s => s.trim()).filter(Boolean)
    const el = (schema as any).unwrap?.()?.element ?? (schema as any).element ?? (schema as any)._zod?.def?.innerType?.element
    return el ? items.map(i => scalar(el, i)) : items
  }
  if (accepts(schema, Number(raw)) && !Number.isNaN(Number(raw))) return Number(raw)
  if (/^(true|false|on|off|yes|no)$/i.test(raw) && accepts(schema, true)) return /^(true|on|yes)$/i.test(raw)
  return raw
}
