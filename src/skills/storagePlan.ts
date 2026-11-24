// Where things go and where they come from at home (pure, unit tested in test/storage-plan.test.ts):
//  - depositKeep: what deposit_when_full never stores (tools, armour, food, the bed, a shield,
//    seeds for its farm, iron and fuel while tools or armour are still to make, a small crafting reserve);
//  - planDeposit: which of its chests takes what (the pantry only food, its own placed chests
//    first, then configured storage, gear chests only gear), or "place a new chest" when all are full;
//  - planChestSpot: where a new chest of its own goes near home (a free spot outside, off paths,
//    away from doors, other chests and the farm, not in a protected area);
//  - chestTakes: what to take out of its chests for a want list (seeds, iron, a shield).
// containers.ts reads the world into these and does the walking and the window work.
import type { CellAt } from './bedPlan.ts'
import type { ChestRole } from './searchPlan.ts'

export interface Pos { x: number, y: number, z: number }

const isBedItem = (name: string): boolean => /_bed$/.test(name)

const TOOL_RE = /(_pickaxe|_axe|_shovel|_hoe|_sword|_helmet|_chestplate|_leggings|_boots)$|^(shears|bow|crossbow|trident|shield|fishing_rod|flint_and_steel|mace|elytra|totem_of_undying)$/

export function isToolOrArmor (name: string): boolean {
  return TOOL_RE.test(name)
}

const SEED_RE = /_seeds$/
const LOG_RE = /(_log|_wood|_stem|_hyphae)$/
/** Gear and what gear is made of: what a gear chest takes. */
const GEAR_RE = /^(iron_ingot|gold_ingot|diamond|netherite_ingot|netherite_scrap|raw_iron|raw_gold|emerald|leather|string|arrow|spectral_arrow|ender_pearl)$/

export function isGearItem (name: string): boolean {
  return isToolOrArmor(name) || isBedItem(name) || GEAR_RE.test(name)
}

// ------------------------------------------------------------------ what it keeps

export interface DepositNeeds {
  isFood: (name: string) => boolean
  /** Seeds of each kind kept for its farm. Default 32. */
  seeds?: number
  /** Tools or armour still to make: iron (ingots, raw iron) and fuel stay with it. */
  iron?: boolean
  /** Item names never stored. */
  keep?: readonly string[]
}

/** Small stocks kept for crafting on the spot (a pickaxe, a crafting table, torches, a furnace). */
export const CRAFT_RESERVE: Record<string, number> = {
  stick: 16, cobblestone: 16, cobbled_deepslate: 16, coal: 16, charcoal: 16, torch: 64,
  crafting_table: 1, furnace: 1, bucket: 1, water_bucket: 1, chest: 2
}
const LOGS_KEPT = 8
const PLANKS_KEPT = 16

/**
 * How many of each held item deposit_when_full keeps (Infinity: all of them). Tools, armour,
 * shields, beds, food, items in `keep` and arrows (with a bow) always; seeds up to `seeds` per kind;
 * iron and fuel while tools or armour are to make; a few logs, planks, sticks, cobblestone, coal,
 * a crafting table and torches. Pure.
 */
export function depositKeep (inv: Record<string, number>, n: DepositNeeds): Record<string, number> {
  const keep = new Set(n.keep ?? [])
  const bow = (inv.bow ?? 0) + (inv.crossbow ?? 0) > 0
  const out: Record<string, number> = {}
  for (const [name, count] of Object.entries(inv)) {
    if (count <= 0) continue
    let k = 0
    if (keep.has(name) || isToolOrArmor(name) || isBedItem(name) || n.isFood(name)) k = Infinity
    else if (/arrow$/.test(name) && bow) k = Infinity
    else if (SEED_RE.test(name)) k = n.seeds ?? 32
    else if (n.iron && /^(iron_ingot|raw_iron|iron_block|raw_iron_block|iron_nugget)$/.test(name)) k = Infinity
    else if (n.iron && /^(coal|charcoal)$/.test(name)) k = Infinity
    else if (CRAFT_RESERVE[name] !== undefined) k = CRAFT_RESERVE[name]!
    else if (LOG_RE.test(name) && !name.startsWith('stripped_')) k = LOGS_KEPT
    else if (name.endsWith('_planks')) k = PLANKS_KEPT
    if (k > 0) out[name] = Math.min(k, count) === count ? Infinity : k
  }
  return out
}

/** What deposit_when_full stores: everything held above depositKeep. Pure. */
export function depositable (inv: Record<string, number>, n: DepositNeeds): Record<string, number> {
  const keep = depositKeep(inv, n)
  const out: Record<string, number> = {}
  for (const [name, count] of Object.entries(inv)) {
    const k = keep[name] ?? 0
    if (k === Infinity) continue
    if (count - k > 0) out[name] = count - k
  }
  return out
}

// ------------------------------------------------------------------ which chest

export interface DepositChest extends Pos {
  role: ChestRole
  /** Placed by the bot (its own storage) rather than listed in the profile. */
  own: boolean
  /** What it last saw inside; null when it never looked. */
  contents: Record<string, number> | null
  /** A double chest (54 slots). */
  double?: boolean
  /** Inside a protected area: left alone. */
  protected?: boolean
  /** Blocks from the bot. */
  distance: number
}

export type DepositPlan =
  | { do: 'deposit', at: Pos, items: Record<string, number>, why: string }
  | { do: 'place', items: Record<string, number>, why: string }
  | { do: 'nothing', why: string }

export interface DepositPlanOptions {
  isFood: (name: string) => boolean
  /** Items per stack (64, 16 for snowballs and eggs, 1 for tools). */
  stackSize: (name: string) => number
  /** It may put down a chest of its own near home. */
  canPlace?: boolean
}

/** Slots `contents` take up. Pure. */
export function slotsUsed (contents: Record<string, number>, stackSize: (name: string) => number): number {
  return Object.entries(contents).reduce((n, [k, v]) => n + Math.ceil(v / Math.max(1, stackSize(k))), 0)
}

/** Whether a chest of this role takes the item. The pantry takes food only, a gear chest gear only. */
export function roleAccepts (role: ChestRole, name: string, isFood: (name: string) => boolean): boolean {
  if (role === 'pantry') return isFood(name)
  if (role === 'gear') return isGearItem(name)
  return true
}

/** How many of `name` (n of them) fit, with `free` empty slots and what is already there. */
function fits (contents: Record<string, number>, free: number, name: string, n: number, stack: number): { take: number, slots: number } {
  const have = contents[name] ?? 0
  const partial = have % stack ? stack - (have % stack) : 0
  const take = Math.min(n, partial + free * stack)
  return { take, slots: Math.max(0, Math.ceil((take - partial) / stack)) }
}

/**
 * Which chest takes what of `items`: food to the pantry, gear to a gear chest, the rest to its
 * own placed chests first (ones already holding that item first), then configured storage
 * chests; never the pantry for anything but food, never a protected chest. One chest per plan
 * (the behaviour plans again after each deposit). Chests it never looked into count as having
 * room, after the known ones. Nothing fits anywhere: place a new chest (canPlace). Pure.
 */
export function planDeposit (items: Record<string, number>, chests: readonly DepositChest[], o: DepositPlanOptions): DepositPlan {
  const names = Object.keys(items).filter(k => (items[k] ?? 0) > 0)
  if (!names.length) return { do: 'nothing', why: 'nothing to store' }
  const usable = chests.filter(c => !c.protected)
  // preference: lower is better
  const rank = (c: DepositChest, name: string): number => {
    const food = o.isFood(name)
    if (c.role === 'pantry') return food ? 0 : Infinity
    if (c.role === 'gear') return isGearItem(name) ? 0 : Infinity
    return (c.own ? 1 : 2) + (food ? 1 : 0)
  }
  const room = (c: DepositChest) => (c.double ? 54 : 27) - (c.contents ? slotsUsed(c.contents, o.stackSize) : 0)
  let best: { c: DepositChest, items: Record<string, number>, score: number } | null = null
  for (const c of usable) {
    if (!names.some(n => rank(c, n) < Infinity)) continue
    const contents = { ...(c.contents ?? {}) }
    let free = room(c)
    const take: Record<string, number> = {}
    let score = 0
    // items it already holds first: they merge into partial stacks
    for (const n of [...names].sort((a, b) => Number((contents[b] ?? 0) > 0) - Number((contents[a] ?? 0) > 0))) {
      const r = rank(c, n)
      if (r === Infinity) continue
      const f = fits(contents, free, n, items[n]!, Math.max(1, o.stackSize(n)))
      if (f.take <= 0) continue
      take[n] = f.take
      free -= f.slots
      contents[n] = (contents[n] ?? 0) + f.take
      // better rank and same items held weigh more; unknown contents a bit less than known room
      score += f.take * (10 - r * 2 + ((c.contents?.[n] ?? 0) > 0 ? 1 : 0))
    }
    if (!Object.keys(take).length) continue
    score = score * (c.contents ? 1 : 0.8) - c.distance * 0.01
    if (!best || score > best.score) best = { c, items: take, score }
  }
  if (best) {
    const what = best.c.role === 'pantry' ? 'the pantry' : best.c.role === 'gear' ? 'the gear chest' : best.c.own ? 'my chest' : 'the storage chest'
    return { do: 'deposit', at: { x: best.c.x, y: best.c.y, z: best.c.z }, items: best.items, why: `${what} at ${best.c.x} ${best.c.y} ${best.c.z}${best.c.contents ? '' : ' (not looked inside yet)'}` }
  }
  if (o.canPlace) {
    const why = usable.length ? 'my chests are full (the pantry only takes food)' : 'no chest of my own near home'
    return { do: 'place', items, why }
  }
  return { do: 'nothing', why: usable.length ? 'my chests are full and I may not place a new one' : 'no chest of my own and I may not place one' }
}

// ------------------------------------------------------------------ where a new chest goes

export interface ChestSpotOptions {
  /** How far from home to look. Default 6. */
  range?: number
  /** Up and down from home's y. Default 2. */
  dy?: number
  /** Cells that are off limits (protected areas, danger zones, the farm). */
  avoid?: (p: Pos) => boolean
}

export interface ChestSpot { at: Pos, stand: Pos, score: number, indoors: boolean }

const PASSAGE = /_door$|fence_gate$|_trapdoor$/
const CONTAINER = /chest$|barrel$|shulker_box$/
const KEEP_CLEAR = /furnace$|smoker$|crafting_table$|_bed$|ladder$|enchanting_table$|anvil$/
const NO_FLOOR = /^(dirt_path|farmland|grass_path)$|_carpet$|_slab$|_stairs$/
const FACES: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]]

const add = (p: Pos, x: number, y: number, z: number): Pos => ({ x: p.x + x, y: p.y + y, z: p.z + z })

function walkable (at: CellAt, p: Pos): boolean {
  return !!at(p.x, p.y, p.z)?.free && !!at(p.x, p.y + 1, p.z)?.free && !!at(p.x, p.y - 1, p.z)?.solid
}

/** A roof within 8 blocks above: inside a building (the owner's room, most likely). */
function roofed (at: CellAt, p: Pos): boolean {
  for (let dy = 2; dy <= 8; dy++) {
    const c = at(p.x, p.y + dy, p.z)
    if (c && !c.free) return true
  }
  return false
}

/**
 * Why a chest can't go at `p`, or null when it can: a free cell with a full block under it and
 * air above (a chest needs it to open), nothing off limits, not on a path, farmland, slab or
 * stairs, not beside a door, gate or trapdoor, not beside another chest (it would join it), a
 * furnace, table or bed, not plugging a one-wide passage, and somewhere to stand next to it. Pure.
 */
export function chestSpotProblem (at: CellAt, p: Pos, o: { avoid?: (p: Pos) => boolean, keepFree?: Pos[] } = {}): string | null {
  if (o.keepFree?.some(k => k.x === p.x && k.y === p.y && k.z === p.z)) return 'keeps the home spot free'
  const c = at(p.x, p.y, p.z)
  if (!c) return 'not loaded'
  if (!c.free) return `${c.name} is in the way`
  const below = at(p.x, p.y - 1, p.z)
  if (!below?.solid) return 'no floor'
  if (NO_FLOOR.test(below.name)) return `on ${below.name}`
  if (CONTAINER.test(below.name)) return `on top of a ${below.name}`
  if (!at(p.x, p.y + 1, p.z)?.free) return 'no air above to open it'
  if (o.avoid?.(p)) return 'off limits (protected area, danger zone or the farm)'
  for (const [dx, dz] of FACES) {
    for (const dy of [-1, 0, 1]) {
      const n = at(p.x + dx, p.y + dy, p.z + dz)
      if (n && PASSAGE.test(n.name)) return `beside a ${n.name}`
    }
    const n = at(p.x + dx, p.y, p.z + dz)
    if (n && CONTAINER.test(n.name)) return `right next to a ${n.name}`
    if (n && KEEP_CLEAR.test(n.name)) return `right next to a ${n.name}`
    const nb = at(p.x + dx, p.y - 1, p.z + dz)
    if (nb && /^(dirt_path|grass_path|farmland)$/.test(nb.name)) return `beside the ${nb.name}`
  }
  const open = (dx: number, dz: number) => walkable(at, add(p, dx, 0, dz))
  const wall = (dx: number, dz: number) => !at(p.x + dx, p.y, p.z + dz)?.free
  if ((open(0, -1) && open(0, 1) && wall(1, 0) && wall(-1, 0)) || (open(1, 0) && open(-1, 0) && wall(0, 1) && wall(0, -1))) return 'would block a passage'
  if (!FACES.some(([dx, dz]) => open(dx, dz))) return 'nowhere to stand next to it'
  return null
}

/**
 * The best spot for a new chest of its own near `center` (home): outside first (a spot with a
 * roof over it is most likely the owner's room, used only when nothing outside works), against
 * a wall when there is a choice, the nearest one. The home cell stays free. Null when nothing
 * within range works. Pure.
 */
export function planChestSpot (center: Pos, at: CellAt, o: ChestSpotOptions = {}): ChestSpot | null {
  const range = o.range ?? 6
  const dyMax = o.dy ?? 2
  const c = { x: Math.floor(center.x), y: Math.floor(center.y), z: Math.floor(center.z) }
  let best: ChestSpot | null = null
  for (let dx = -range; dx <= range; dx++) {
    for (let dz = -range; dz <= range; dz++) {
      const d = Math.hypot(dx, dz)
      if (d > range + 0.5 || d < 1.5) continue
      for (let dy = -dyMax; dy <= dyMax; dy++) {
        const p = add(c, dx, dy, dz)
        if (chestSpotProblem(at, p, { avoid: o.avoid, keepFree: [c] })) continue
        const indoors = roofed(at, p)
        let score = d + Math.abs(dy) * 2 + (indoors ? 100 : 0)
        if (FACES.some(([fx, fz]) => at(p.x + fx, p.y, p.z + fz)?.solid)) score -= 1 // against a wall
        if (best && score >= best.score) continue
        const [sx, sz] = FACES.find(([fx, fz]) => walkable(at, add(p, fx, 0, fz)))!
        best = { at: p, stand: add(p, sx, 0, sz), score, indoors }
      }
    }
  }
  return best
}

// ------------------------------------------------------------------ taking things out

export interface TakeChest extends Pos {
  /** What it last saw inside; null when it never looked. */
  contents: Record<string, number> | null
}

/**
 * What to take out of its chests for `want` (name -> count still wanted): from chests known to
 * hold it, nearest-listed first, leaving `reserve` (name -> count) in the chests. Chests it never
 * looked into are listed in `look` (worth opening when the known ones fall short). Pure.
 */
export function chestTakes (want: Record<string, number>, chests: readonly TakeChest[], reserve: Record<string, number> = {}): { take: { at: Pos, items: Record<string, number> }[], short: Record<string, number>, look: Pos[] } {
  const left = { ...want }
  const spare: Record<string, number> = {}
  for (const c of chests) for (const [k, v] of Object.entries(c.contents ?? {})) spare[k] = (spare[k] ?? 0) + v
  // what may leave the chests at all: all of it minus the reserve
  const may: Record<string, number> = {}
  for (const k of Object.keys(left)) may[k] = Math.max(0, (spare[k] ?? 0) - (reserve[k] ?? 0))
  const take: { at: Pos, items: Record<string, number> }[] = []
  for (const c of chests) {
    if (!c.contents) continue
    const items: Record<string, number> = {}
    for (const [k, n] of Object.entries(left)) {
      if (n <= 0) continue
      const t = Math.min(n, c.contents[k] ?? 0, may[k] ?? 0)
      if (t <= 0) continue
      items[k] = t
      left[k] = n - t
      may[k] = (may[k] ?? 0) - t
    }
    if (Object.keys(items).length) take.push({ at: { x: c.x, y: c.y, z: c.z }, items })
  }
  const short = Object.fromEntries(Object.entries(left).filter(([, v]) => v > 0))
  return { take, short, look: Object.keys(short).length ? chests.filter(c => !c.contents).map(c => ({ x: c.x, y: c.y, z: c.z })) : [] }
}

/** Seeds to take from its chests for the farm: the farm's need, wheat seeds first (or the farm's own seed). Pure. */
export function seedWant (wanted: number, seedName = 'wheat_seeds'): Record<string, number> {
  return wanted > 0 ? { [seedName]: Math.ceil(wanted) } : {}
}

/**
 * Gear to take out of its chests: a shield when it has none, and armour pieces for slots it
 * neither wears nor carries (iron or better). `held` counts worn and carried items. Pure.
 */
export function gearWant (held: Record<string, number>, chestHas: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {}
  if (!(held.shield ?? 0) && (chestHas.shield ?? 0) > 0) out.shield = 1
  for (const slot of ['helmet', 'chestplate', 'leggings', 'boots']) {
    if (Object.keys(held).some(k => k.endsWith(`_${slot}`) && (held[k] ?? 0) > 0)) continue
    const pick = ['netherite', 'diamond', 'iron'].map(t => `${t}_${slot}`).find(n => (chestHas[n] ?? 0) > 0)
    if (pick) out[pick] = 1
  }
  return out
}

const IRON_OR_BETTER = /^(iron|diamond|netherite)_/

/**
 * Whether iron still has a use: a pickaxe, sword, axe or shovel below iron, or (with `armour`)
 * an armour slot without an iron-or-better piece. `held` counts worn and carried items. Pure.
 */
export function ironStillNeeded (held: Record<string, number>, armour = false): boolean {
  const has = (re: RegExp) => Object.keys(held).some(k => re.test(k) && (held[k] ?? 0) > 0)
  for (const kind of ['pickaxe', 'sword', 'axe', 'shovel']) {
    if (!has(new RegExp(`^(iron|diamond|netherite)_${kind}$`))) return true
  }
  if (armour) {
    for (const slot of ['helmet', 'chestplate', 'leggings', 'boots']) {
      if (!Object.keys(held).some(k => k.endsWith(`_${slot}`) && IRON_OR_BETTER.test(k) && (held[k] ?? 0) > 0)) return true
    }
  }
  return false
}
