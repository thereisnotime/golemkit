// Keys a YAML file sets that its zod schema doesn't declare. zod strips them without a word, so
// a typo ("usrname", "hots") would silently do nothing; profiles and fleets warn about them.

import type { z } from 'zod'

/**
 * Keys in `raw` that `schema` doesn't declare, as dotted paths (`bots[1].usrname`). Arrays and
 * records are looked into per element, passthrough objects only for their declared keys, strict
 * objects not at all (zod fails on those), unions only when exactly one branch is an object.
 */
export function unknownKeys (raw: unknown, schema: z.ZodType, path = ''): string[] {
  if (!raw || typeof raw !== 'object') return []
  const def = (schema as any)._zod.def
  switch (def.type) {
    case 'optional': case 'nullable': case 'default': case 'readonly': case 'prefault':
      return unknownKeys(raw, def.innerType, path)
    case 'pipe':
      return unknownKeys(raw, def.in, path)
    case 'union': {
      const objs = (def.options as z.ZodType[]).filter(o => ['object', 'optional', 'nullable'].includes((o as any)._zod.def.type))
      return objs.length === 1 ? unknownKeys(raw, objs[0]!, path) : []
    }
    case 'array':
      return Array.isArray(raw) ? raw.flatMap((v, i) => unknownKeys(v, def.element, `${path}[${i}]`)) : []
    case 'record':
      return Array.isArray(raw) ? [] : Object.entries(raw).flatMap(([k, v]) => unknownKeys(v, def.valueType, path ? `${path}.${k}` : k))
    case 'object': {
      if (Array.isArray(raw)) return []
      const catchall = def.catchall?._zod.def.type
      if (catchall === 'never') return []   // strict: zod reports unknown keys itself
      const out: string[] = []
      for (const [k, v] of Object.entries(raw)) {
        const key = path ? `${path}.${k}` : k
        if (!(k in def.shape)) { if (!catchall) out.push(key) }   // passthrough objects take any key
        else out.push(...unknownKeys(v, def.shape[k], key))
      }
      return out
    }
    default:
      return []
  }
}
