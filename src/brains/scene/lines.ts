// Line templating and variation. {player}, {me}, {scene}, {role:hauler}, {$var}.
import type { LineProvider, LineRequest } from './types.ts'

export interface TemplateContext {
  scene: string
  me?: string
  player?: string
  cast: Record<string, string>
  vars: Record<string, unknown>
}

export function renderTemplate (text: string, ctx: TemplateContext): string {
  return text.replace(/\{(\$?[a-z_][\w]*)(?::([\w]+))?\}/gi, (whole, key: string, arg?: string) => {
    if (key.startsWith('$')) {
      const v = ctx.vars[key.slice(1)]
      return v === undefined ? whole : String(v)
    }
    switch (key) {
      case 'player': return ctx.player ?? 'friend'
      case 'me': return ctx.me ?? whole
      case 'scene': return ctx.scene
      case 'role': return arg && ctx.cast[arg] ? ctx.cast[arg] : whole
      default: return whole
    }
  })
}

/** Deep-templates string values in action params. */
export function renderParams (params: Record<string, unknown>, ctx: TemplateContext): Record<string, unknown> {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return renderTemplate(v, ctx)
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    return v
  }
  return walk(params) as Record<string, unknown>
}

/** Picks a variant, avoiding an immediate repeat of `last` when there is a choice. */
export function pickVariant (variants: string[], last?: string, rnd: () => number = Math.random): string {
  const pool = variants.length > 1 && last !== undefined ? variants.filter(v => v !== last) : variants
  return pool[Math.floor(rnd() * pool.length)] ?? variants[0]!
}

/** Asks the provider for a line, falling back to the default on error, empty or timeout. */
export async function provideLine (provider: LineProvider | undefined, req: LineRequest, timeoutMs: number): Promise<string> {
  if (!provider) return req.line
  let timer: NodeJS.Timeout | undefined
  try {
    const out = await Promise.race([
      Promise.resolve(provider(req)),
      new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), timeoutMs) })
    ])
    const line = typeof out === 'string' ? out.trim() : ''
    return line ? line.slice(0, 240) : req.line
  } catch {
    return req.line
  } finally {
    clearTimeout(timer)
  }
}

/** Typing delay before a line: proportional to its length, clamped (0 per char turns it off). */
export function typingDelay (line: string, perChar: number): number {
  if (perChar <= 0) return 0
  return Math.max(400, Math.min(2500, line.length * perChar))
}
