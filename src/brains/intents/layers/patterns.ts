// patterns layer: the anchored pattern parser (parse.ts) as a pipeline layer. Synchronous, so a
// confident pattern match is acted on without waiting for any other layer.
import { parseIntent, type ParseContext } from '../parse.ts'
import type { IntentLayer, LayerResult } from '../pipeline.ts'

export function patternsLayer (opts: { name?: string } = {}): IntentLayer {
  const name = opts.name ?? 'patterns'
  const classifySync = (text: string, ctx: ParseContext): LayerResult | null => {
    const t0 = performance.now()
    const r = parseIntent(text, ctx)
    return r ? { ...r, layer: name, ms: Math.round((performance.now() - t0) * 10) / 10 } : null
  }
  return { name, kind: 'patterns', classify: classifySync, classifySync }
}
