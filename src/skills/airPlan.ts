// Getting air under water (pure, unit-tested). Pax drowned in the frozen lake by its home while
// prepare_trip walked it to the pantry: the old swim-up only jumped straight up, which does
// nothing under ice or a roof. The air reflex (brains/reflexes.ts, action `air` in skills/air.ts)
// and travel's swim-up ask `airPlan` every tick for the cheapest way to a breath:
//   - up: the column above the head is water up to air;
//   - break: a breakable block (ice, a stone roof) within reach above the head, then up. Ice over
//     water turns to water when broken, so the scan goes on above it; any other block leaves an
//     air pocket the head can rise into, unless water beside it flows in;
//   - swim: the nearest water cell with air above (a hole, the edge of the ice), or an air pocket,
//     within `radius` blocks through water (breadth-first, the body needs two cells);
//   - none: nothing found (unloaded chunks, a sealed tank of unbreakable blocks).
// Cost is in estimated milliseconds; protected blocks are never broken.

export interface V { x: number, y: number, z: number }

export type AirKind = 'air' | 'water' | 'solid' | 'unknown'

export interface AirCell {
  kind: AirKind
  name?: string
  /** Solid only: may be broken (not bedrock, not protected, the bot may dig). */
  breakable?: boolean
  /** Solid only: inside a protected area (never broken; noted in the reason). */
  protected?: boolean
  /** Solid only: estimated time to break it from here, in ms. */
  digMs?: number
}

export interface AirInputs {
  /** The block the eyes are in. */
  head: V
  cell (p: V): AirCell
  /** Horizontal search radius for an opening. Default 8. */
  radius?: number
  /** How far up to look. Default 24. */
  maxUp?: number
  /** Blocks above the head that can be reached to break. Default 4. */
  reachUp?: number
  /** Most blocks broken in a row above the head. Default 2. */
  maxBreak?: number
}

export type AirPlan =
  | { act: 'up', to: V, cost: number, why: string }
  | { act: 'break', block: V, name: string, cost: number, why: string }
  | { act: 'swim', to: V, next: V, dist: number, cost: number, why: string }
  | { act: 'none', cost: number, why: string }

/** Rough times: swimming up one block, across one block. */
export const SWIM_UP_MS = 350
export const SWIM_ACROSS_MS = 500

const key = (p: V) => `${p.x},${p.y},${p.z}`
const add = (p: V, x: number, y: number, z: number): V => ({ x: p.x + x, y: p.y + y, z: p.z + z })
const SIDES: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]]

/** Ice turns into water when broken over water (no silk touch); packed and blue ice don't. */
export const meltsToWater = (name: string | undefined) => name === 'ice'
export const isIce = (name: string | undefined) => !!name && /^(ice|packed_ice|blue_ice|frosted_ice)$/.test(name)

/** Would a broken block at `p` fill with water (water beside it or above it)? */
function floods (inp: AirInputs, p: V): boolean {
  if (inp.cell(add(p, 0, 1, 0)).kind === 'water') return true
  return SIDES.some(([dx, dz]) => inp.cell(add(p, dx, 0, dz)).kind === 'water')
}

/** Straight up from the head, breaking what's in reach. Null when the column doesn't lead to air. */
function column (inp: AirInputs): AirPlan | null {
  const maxUp = inp.maxUp ?? 24
  const reachUp = inp.reachUp ?? 4
  const maxBreak = inp.maxBreak ?? 2
  let cost = 0
  let first: { block: V, name: string } | null = null
  const broken: string[] = []
  let blockedBy: string | null = null
  for (let dy = 1; dy <= maxUp; dy++) {
    const p = add(inp.head, 0, dy, 0)
    const c = inp.cell(p)
    if (c.kind === 'air') {
      if (!first) return { act: 'up', to: p, cost, why: dy === 1 ? 'air right above' : `open water up to ${p.y}` }
      return { act: 'break', block: first.block, name: first.name, cost, why: `break ${broken.join(', ')} above, then up to ${p.y}` }
    }
    if (c.kind === 'water') { cost += SWIM_UP_MS; continue }
    if (c.kind === 'unknown') return null
    // solid
    if (c.protected) { blockedBy = `${c.name ?? 'a block'} above is protected`; break }
    if (!c.breakable || dy > reachUp || broken.length >= maxBreak) { blockedBy = `${c.name ?? 'a block'} above can't be broken`; break }
    if (!first) first = { block: p, name: c.name ?? 'block' }
    broken.push(c.name ?? 'block')
    cost += (c.digMs ?? 1000) + SWIM_UP_MS
    // ice becomes water: keep going up; anything else leaves air unless water flows in
    if (!meltsToWater(c.name) && !floods(inp, p)) {
      return { act: 'break', block: first.block, name: first.name, cost, why: `break ${broken.join(', ')} above for an air pocket` }
    }
  }
  return blockedBy ? { act: 'none', cost: Infinity, why: blockedBy } : null
}

/** Breadth-first through water to the nearest cell with air above it (or an air pocket). */
function swim (inp: AirInputs): AirPlan | null {
  const radius = inp.radius ?? 8
  const maxUp = inp.maxUp ?? 24
  const start = inp.head
  const fits = (p: V) => {
    const k = inp.cell(p).kind
    return k === 'water' || k === 'air'
  }
  const prev = new Map<string, V | null>([[key(start), null]])
  const dist = new Map<string, number>([[key(start), 0]])
  const queue: V[] = [start]
  for (let i = 0; i < queue.length; i++) {
    const p = queue[i]!
    const d = dist.get(key(p))!
    if (p !== start && inp.cell(p).kind === 'air') {
      // first step from the start along the path
      let step = p
      while (prev.get(key(step)) && key(prev.get(key(step))!) !== key(start)) step = prev.get(key(step))!
      return { act: 'swim', to: p, next: step, dist: d, cost: d * SWIM_ACROSS_MS, why: `air ${d} blocks away at ${p.x} ${p.y} ${p.z}` }
    }
    const moves: V[] = [add(p, 0, 1, 0), add(p, 0, -1, 0), ...SIDES.map(([dx, dz]) => add(p, dx, 0, dz))]
    for (const q of moves) {
      const k = key(q)
      if (dist.has(k)) continue
      if (Math.abs(q.x - start.x) > radius || Math.abs(q.z - start.z) > radius || q.y > start.y + maxUp || q.y < start.y - 4) continue
      if (!fits(q)) continue
      // the body: moving sideways or down the feet need room too (the head leads, feet one below)
      if (q.y <= p.y && !fits(add(q, 0, -1, 0))) continue
      dist.set(k, d + 1)
      prev.set(k, p)
      queue.push(q)
    }
  }
  return null
}

/** The cheapest way to a breath from where the head is. */
export function airPlan (inp: AirInputs): AirPlan {
  const up = column(inp)
  if (up && up.act === 'up') return up
  const across = swim(inp)
  const opts = [up, across].filter((o): o is AirPlan => !!o && o.act !== 'none')
  opts.sort((a, b) => a.cost - b.cost)
  if (opts[0]) {
    const best = opts[0]
    // say why the column wasn't used when swimming instead
    if (best.act === 'swim' && up?.act === 'none') return { ...best, why: `${up.why}; ${best.why}` }
    return best
  }
  return { act: 'none', cost: Infinity, why: up?.why ?? 'no air within reach' }
}

// ---- when to go for air ----

export interface AirSettings {
  enabled: boolean
  /** Go for air at or below this (of 20). */
  below: number
}

export const AIR_BELOW = 10
/** Air counts as back at this (of 20). */
export const AIR_DONE = 18

export function airSettings (r: { air?: boolean, airBelow?: number } | undefined): AirSettings {
  const below = typeof r?.airBelow === 'number' && r.airBelow >= 0 && r.airBelow <= 20 ? r.airBelow : AIR_BELOW
  return { enabled: r?.air !== false, below }
}

/** The threshold to use: earlier the lower the health (drowning does 2 a second). */
export function airThreshold (below: number, health: number): number {
  if (below <= 0) return 0
  if (health <= 6) return Math.min(19, below + 6)
  if (health <= 12) return Math.min(19, below + 3)
  return below
}

export interface AirTrigger {
  settings: AirSettings
  /** Eyes in water (or a bubble column). */
  headInWater: boolean
  /** 0..20. */
  oxygen: number
  health: number
}

/** Should the air reflex start? Null: no; otherwise why. */
export function airTrigger (t: AirTrigger): string | null {
  if (!t.settings.enabled || !t.headInWater || t.health <= 0) return null
  const at = airThreshold(t.settings.below, t.health)
  if (t.oxygen > at) return null
  return `air ${t.oxygen}/20${at !== t.settings.below ? ` (health ${Math.round(t.health)}, going at ${at})` : ''}`
}

/** Has the bot got its air back? */
export function airDone (oxygen: number, headInWater: boolean): boolean {
  return oxygen >= AIR_DONE || (!headInWater && oxygen >= AIR_DONE - 2)
}

// ---- keeping the pathfinder out of it ----

/** Extra pathfinder cost per water block with ice over it (the bot can't come up there). */
export const UNDER_ICE_COST = 30
/** ...with any other solid lid over it (flooded caves, under a dock). */
export const UNDER_ROOF_COST = 10
/** ...fully under water (water above water): the air runs out there. */
export const SUBMERGED_COST = 2
/** Liquid cost the pathfinder starts with (its default is 1): a dry path wins when there is one. */
export const LIQUID_COST = 3

/**
 * Step cost for a water block the path goes through, from the cells above it (`above(1)` is the
 * one right above). Ice within 4 blocks above makes it very expensive, a roof expensive, deep water a bit.
 */
export function waterStepCost (above: (dy: number) => AirCell): number {
  let submerged = false
  for (let dy = 1; dy <= 4; dy++) {
    const c = above(dy)
    if (c.kind === 'water') { if (dy === 1) submerged = true; continue }
    if (c.kind === 'solid') return isIce(c.name) ? UNDER_ICE_COST : UNDER_ROOF_COST
    break
  }
  return submerged ? SUBMERGED_COST : 0
}
