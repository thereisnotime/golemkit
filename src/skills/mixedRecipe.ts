// Recipes that take any member of a group (vanilla item tags: any planks for a chest, crafting
// table, sticks or wooden tools; cobblestone, blackstone or cobbled deepslate for a furnace or stone
// tools) and the mix of them. minecraft-data lists one recipe per member ("8 cherry_planks",
// "8 spruce_planks", ...), so mineflayer never finds a recipe for 4 spruce + 4 oak, and Pax failed
// to make a chest with "need 8 cherry_planks" while carrying other wood. The server matches by tag
// and takes the mix, so a recipe with a mixed grid crafts fine.
//
// How a tag slot is recognised, from the data alone (no list of tags to keep up): variants of one
// recipe with the same result and the same shape, where a slot holds different items across the
// variants. A recipe that needs one exact wood (oak_stairs, oak_boat) has a single variant, so it
// never mixes. Pure, no bot.

export interface RecipeItemLike { id: number, metadata?: number | null, count: number }
export interface RecipeLike {
  inShape?: RecipeItemLike[][] | null
  ingredients?: RecipeItemLike[] | null
  delta: { id: number, metadata?: number | null, count: number }[]
  result: RecipeItemLike
  requiresTable: boolean
}

/** One slot group: the slots that take any of `alts` (one item each). */
export interface SlotGroup { alts: number[], slots: number }

/** Flattened slots of a recipe: grid cells left to right, top to bottom, then shapeless ingredients. */
function slotsOf (r: RecipeLike): RecipeItemLike[] {
  return [...(r.inShape ?? []).flat(), ...(r.ingredients ?? [])]
}

function shapeKey (r: RecipeLike): string {
  const grid = (r.inShape ?? []).map(row => row.map(c => (c.id === -1 ? '.' : '#')).join('')).join('/')
  return `${r.result.id}:${r.result.count}:${r.requiresTable ? 't' : 'i'}:${grid}:${(r.ingredients ?? []).length}`
}

/**
 * The variants of one shape, with per-slot alternatives. Null when there is nothing to mix (one
 * variant, or no slot that varies). Groups are the biggest set of variants sharing a shape.
 */
export function tagShape (variants: readonly RecipeLike[]): { template: RecipeLike, alts: number[][] } | null {
  const byShape = new Map<string, RecipeLike[]>()
  for (const v of variants) {
    const k = shapeKey(v)
    byShape.set(k, [...(byShape.get(k) ?? []), v])
  }
  const group = [...byShape.values()].sort((a, b) => b.length - a.length)[0]
  if (!group || group.length < 2) return null
  const template = group[0]!
  const n = slotsOf(template).length
  const alts: number[][] = []
  for (let i = 0; i < n; i++) {
    const ids = new Set<number>()
    for (const v of group) { const s = slotsOf(v)[i]; if (s && s.id !== -1) ids.add(s.id) }
    alts.push([...ids])
  }
  return alts.some(a => a.length > 1) ? { template, alts } : null
}

/** What a mixed grid needs: fixed items by id, and groups of interchangeable ones. */
export function needsOf (alts: readonly number[][]): { fixed: Map<number, number>, groups: SlotGroup[] } {
  const fixed = new Map<number, number>()
  const groups = new Map<string, SlotGroup>()
  for (const a of alts) {
    if (!a.length) continue
    if (a.length === 1) { fixed.set(a[0]!, (fixed.get(a[0]!) ?? 0) + 1); continue }
    const k = [...a].sort((x, y) => x - y).join(',')
    const g = groups.get(k) ?? { alts: [...a], slots: 0 }
    g.slots++
    groups.set(k, g)
  }
  return { fixed, groups: [...groups.values()] }
}

export interface MixPlan {
  /** The item for each flattened slot (-1: empty), or null when it can't be filled. */
  fill: number[] | null
  /** Short per group (items still needed of any of its alternatives), when fill is null. */
  short: { alts: number[], need: number }[]
}

/**
 * Fills a tag shape from what it holds: fixed slots first, then each group from the members it
 * holds most of (so it uses up big stacks, not the last few of a kind). Pure.
 */
export function planMix (alts: readonly number[][], have: (id: number) => number): MixPlan {
  const left = new Map<number, number>()
  const take = (id: number): boolean => {
    const n = left.has(id) ? left.get(id)! : have(id)
    if (n <= 0) return false
    left.set(id, n - 1)
    return true
  }
  const { fixed } = needsOf(alts)
  const short = new Map<string, { alts: number[], need: number }>()
  let ok = true
  for (const [id, n] of fixed) for (let i = 0; i < n; i++) if (!take(id)) ok = false
  const fill: number[] = []
  for (const a of alts) {
    if (!a.length) { fill.push(-1); continue }
    if (a.length === 1) { fill.push(a[0]!); continue }
    const pick = [...a].sort((x, y) => (left.has(y) ? left.get(y)! : have(y)) - (left.has(x) ? left.get(x)! : have(x)))[0]!
    if (take(pick)) { fill.push(pick); continue }
    ok = false
    fill.push(-1)
    const k = [...a].sort((x, y) => x - y).join(',')
    const s = short.get(k) ?? { alts: [...a], need: 0 }
    s.need++
    short.set(k, s)
  }
  return ok ? { fill, short: [] } : { fill: null, short: [...short.values()] }
}

/**
 * A recipe with the mixed grid filled in: same shape, table need and result as the template, the
 * delta recomputed from the fill. Keeps the template's prototype so it is handed to bot.craft
 * like any other recipe.
 */
export function mixedRecipe<T extends RecipeLike> (template: T, fill: readonly number[]): T {
  let i = 0
  const cell = (c: RecipeItemLike): RecipeItemLike => {
    const id = fill[i++]!
    return c.id === -1 || id === -1 ? { ...c, id: -1 } : { id, metadata: null, count: 1 }
  }
  const inShape = template.inShape ? template.inShape.map(row => row.map(cell)) : template.inShape
  const ingredients = template.ingredients ? template.ingredients.map(cell) : template.ingredients
  const use = new Map<number, number>()
  for (const c of [...(inShape ?? []).flat(), ...(ingredients ?? [])]) if (c.id !== -1) use.set(c.id, (use.get(c.id) ?? 0) + 1)
  // anything the template gives back besides the result (buckets) stays in the delta
  const extra = template.delta.filter(d => d.count > 0 && d.id !== template.result.id)
  const delta = [...[...use].map(([id, n]) => ({ id, metadata: null, count: -n })), ...extra, { id: template.result.id, metadata: template.result.metadata ?? null, count: template.result.count }]
  return Object.assign(Object.create(Object.getPrototypeOf(template)), template, { inShape, ingredients, delta }) as T
}

/** A runnable mixed recipe from the variants, or what is short. */
export function mixFor<T extends RecipeLike> (variants: readonly T[], have: (id: number) => number): { recipe: T | null, short: { alts: number[], need: number }[] } {
  const t = tagShape(variants)
  if (!t) return { recipe: null, short: [] }
  const p = planMix(t.alts, have)
  return p.fill ? { recipe: mixedRecipe(t.template as T, p.fill), short: [] } : { recipe: null, short: p.short }
}
