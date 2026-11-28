// Food sources: the ways a bot can keep itself in food for the long run, as a small ordered
// registry. farm_setup asks chooseFoodSource which one to use; the first source in the order
// (settings.food.sources) that the area and the bot allow wins, and the status says why the
// ones before it were skipped. Pure, unit-tested in test/food-source.test.ts. The Minecraft
// glue (sensing, running each source) is in foodSources.ts.
//
// Two kinds:
// - lasting sources (repair, farm, plot) are set up once and then kept: a farm is tended,
//   harvested and replanted by farm_setup; setting one up runs when the bot has none.
// - stock sources (animals, fish, forage) run a session each time the food it carries (and keeps
//   in its chests) drops below food.stock.

export type FoodSourceName = 'repair' | 'farm' | 'plot' | 'animals' | 'fish' | 'forage'
export const FOOD_SOURCE_NAMES: readonly FoodSourceName[] = ['repair', 'farm', 'plot', 'animals', 'fish', 'forage']

export interface FoodSourceWorld {
  now: number
  /** Its own healthy farms; kind plot = the base's reserved plot. */
  farms: readonly { name: string, kind: 'field' | 'plot' }[]
  /** Its own farm that site health marked bad and that is not given up on, nearest first. */
  badFarm: { name: string, reason: string, tries: number, gaveUp: boolean } | null
  badFarmMode: 'auto' | 'repair' | 'relocate' | 'off'
  canDig: boolean
  canPlace: boolean
  /** Plantable seeds carried, in its chests, and grass near to break for more. */
  seeds: number
  chestSeeds: number
  grass: boolean
  /** The base's reserved farm plot (base projects: farm_plot): known and in this dimension. */
  plot: { known: boolean, used: boolean, grow?: boolean } | null
  /** Fishing: a rod, or string and sticks (or planks) to make one; open water or ice it may break near. */
  rod: boolean
  canMakeRod: boolean
  water: boolean
  /** Animals near home: a breeding pair with food for it, adults it may hunt. */
  breed: boolean
  hunt: number
  /** Ripe berries, or kelp it can smelt, in range. */
  forage: number
  /** Food items carried plus those in its chests near home, and the stock it wants. */
  stock: number
  /** A source that failed recently: left alone until `until`. */
  failed: Partial<Record<FoodSourceName, { until: number, reason: string }>>
}

export interface FoodSourceVerdict { ok: boolean, reason: string }

export interface FoodSourceDef {
  name: FoodSourceName
  kind: 'lasting' | 'stock'
  title: string
  /** Whether it can be used here now, and why (not). */
  assess (w: FoodSourceWorld, s: FoodSourceSettings): FoodSourceVerdict
  /** A lasting source that already stands (its farm exists): nothing to set up. */
  have? (w: FoodSourceWorld): string | null
  /** A standing source that has more to set up (the base's plot grew past its farm), and why. */
  extend? (w: FoodSourceWorld): string | null
}

const seedsText = (w: FoodSourceWorld) => `${w.seeds} seeds${w.chestSeeds ? `, ${w.chestSeeds} in my chests` : ''}`
const enoughSeeds = (w: FoodSourceWorld, s: FoodSourceSettings) => w.seeds + w.chestSeeds >= s.minSeeds || w.grass

export const FOOD_SOURCES: readonly FoodSourceDef[] = [
  {
    name: 'repair',
    kind: 'lasting',
    title: 'repair a bad farm',
    assess (w) {
      if (!w.badFarm) return { ok: false, reason: 'no bad farm' }
      if (w.badFarmMode === 'off' || w.badFarmMode === 'relocate') return { ok: false, reason: `farming.badFarm is ${w.badFarmMode}` }
      if (w.badFarm.gaveUp) return { ok: false, reason: w.badFarm.tries ? `gave up on ${w.badFarm.name} after ${w.badFarm.tries} repairs` : `${w.badFarm.name} is not worth repairing` }
      if (!w.canDig && !w.canPlace) return { ok: false, reason: 'digging and placing are off' }
      return { ok: true, reason: `${w.badFarm.name} is bad (${w.badFarm.reason}): look at repairing it` }
    }
  },
  {
    name: 'farm',
    kind: 'lasting',
    title: 'a crop farm by water',
    have: w => w.farms.find(f => f.kind === 'field')?.name ?? null,
    assess (w, s) {
      if (!w.canDig) return { ok: false, reason: 'digging is off' }
      if (w.badFarm && !w.badFarm.gaveUp && w.badFarmMode === 'repair') return { ok: false, reason: `farming.badFarm is repair: ${w.badFarm.name} is repaired, not replaced` }
      if (w.badFarm && w.badFarmMode === 'off') return { ok: false, reason: `${w.badFarm.name} is bad and farming.badFarm is off` }
      if (!enoughSeeds(w, s)) return { ok: false, reason: `${seedsText(w)} and no grass near (${s.minSeeds} to start)` }
      return { ok: true, reason: `${seedsText(w)}: find flat ground by water` }
    }
  },
  {
    name: 'plot',
    kind: 'lasting',
    title: 'the base\'s farm plot',
    have: w => w.farms.find(f => f.kind === 'plot')?.name ?? null,
    extend: w => w.plot?.grow && w.canDig ? 'the plot grew: extend the farm onto it' : null,
    assess (w, s) {
      if (!s.plot) return { ok: false, reason: 'farming.plot is off' }
      if (!w.plot?.known) return { ok: false, reason: 'no farm plot kept in the base (base project farm_plot)' }
      if (w.plot.used) return { ok: false, reason: 'the plot is in use' }
      if (!w.canDig) return { ok: false, reason: 'digging is off' }
      if (w.seeds + w.chestSeeds < 1 && !w.grass) return { ok: false, reason: 'no seeds and no grass near' }
      return { ok: true, reason: `a plot inside the base, ${seedsText(w)}` }
    }
  },
  {
    name: 'animals',
    kind: 'stock',
    title: 'animals near home',
    assess (w) {
      if (w.breed) return { ok: true, reason: 'a breeding pair and food for it near home' }
      if (w.hunt > 0) return { ok: true, reason: `${w.hunt} animals near home beyond the breeders` }
      return { ok: false, reason: 'no animals near home to breed or hunt' }
    }
  },
  {
    name: 'fish',
    kind: 'stock',
    title: 'fishing',
    assess (w) {
      if (!w.rod && !w.canMakeRod) return { ok: false, reason: 'no fishing rod and no 2 string and 3 sticks to make one' }
      if (!w.water) return { ok: false, reason: 'no open water (or ice to break a hole in) near home' }
      return { ok: true, reason: `${w.rod ? 'a rod' : 'string and sticks for a rod'} and water near home` }
    }
  },
  {
    name: 'forage',
    kind: 'stock',
    title: 'berries and kelp',
    assess (w) {
      return w.forage > 0 ? { ok: true, reason: `${w.forage} ripe berry bushes or kelp near` } : { ok: false, reason: 'no ripe berries or kelp near' }
    }
  }
]

export interface FoodSourceSettings {
  /** Which sources, in order of preference. A name left out is never used. */
  sources: FoodSourceName[]
  /** Stock sources run while carried plus stored food items are below this. */
  stock: number
  /** A source that failed is left alone for this long. */
  retryMinutes: number
  /** Seeds (carried and in chests) to start a field farm without grass near. */
  minSeeds: number
  /** Use the base's reserved farm plot (farming.plot). */
  plot: boolean
}

export const FOOD_SOURCE_DEFAULTS: FoodSourceSettings = {
  sources: ['repair', 'farm', 'plot', 'animals', 'fish', 'forage'],
  stock: 12,
  retryMinutes: 60,
  minSeeds: 8,
  plot: true
}

/** settings.food (+ farming.plot) with defaults; unknown source names are dropped. */
export function foodSourceSettings (food: unknown, farming?: unknown): FoodSourceSettings {
  const o = food && typeof food === 'object' ? food as Record<string, unknown> : {}
  const f = farming && typeof farming === 'object' ? farming as Record<string, unknown> : {}
  const list = Array.isArray(o.sources) ? o.sources : typeof o.sources === 'string' ? o.sources.split(',').map(x => x.trim()) : null
  const sources = list ? [...new Set(list.filter((x): x is FoodSourceName => FOOD_SOURCE_NAMES.includes(x as FoodSourceName)))] : [...FOOD_SOURCE_DEFAULTS.sources]
  const num = (v: unknown, d: number, lo: number, hi: number) => typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d
  return {
    sources: food === false ? [] : sources,
    stock: num(o.stock, FOOD_SOURCE_DEFAULTS.stock, 0, 256),
    retryMinutes: num(o.retryMinutes, FOOD_SOURCE_DEFAULTS.retryMinutes, 0, 1440),
    minSeeds: num(o.minSeeds, FOOD_SOURCE_DEFAULTS.minSeeds, 1, 64),
    plot: farming === false ? false : typeof f.plot === 'boolean' ? f.plot : FOOD_SOURCE_DEFAULTS.plot
  }
}

export interface FoodSourceChoice {
  /** The source in use, or null when none fits. */
  active: FoodSourceName | null
  kind: 'lasting' | 'stock' | null
  /** It already stands (a farm of that kind exists): keep it up instead of setting one up. */
  have: string | null
  /** Run it now: a lasting source to set up, or a stock source while the stock is low. */
  run: boolean
  reason: string
  /** The sources before it in the order, and why each was skipped. */
  skipped: { name: FoodSourceName, reason: string }[]
}

/**
 * The food source to use. Lasting sources that already stand win in their place in the order
 * (a farm it has comes before setting up a later one); a source that failed recently is skipped
 * until its pause ends. Stock sources only run while the stock is below food.stock.
 */
export function chooseFoodSource (w: FoodSourceWorld, s: FoodSourceSettings, defs: readonly FoodSourceDef[] = FOOD_SOURCES): FoodSourceChoice {
  const skipped: FoodSourceChoice['skipped'] = []
  for (const name of s.sources) {
    const def = defs.find(d => d.name === name)
    if (!def) continue
    const have = def.have?.(w) ?? null
    const f = w.failed[name]
    if (have) {
      const more = def.extend?.(w) ?? null
      if (more && !(f && f.until > w.now)) return { active: name, kind: def.kind, have, run: true, reason: `${have} (${def.title}): ${more}`, skipped }
      return { active: name, kind: def.kind, have, run: false, reason: `${have} (${def.title}) is my food supply`, skipped }
    }
    if (f && f.until > w.now) { skipped.push({ name, reason: `failed ${Math.max(1, Math.round((w.now - (f.until - s.retryMinutes * 60_000)) / 60_000))}m ago: ${f.reason}` }); continue }
    const v = def.assess(w, s)
    if (!v.ok) { skipped.push({ name, reason: v.reason }); continue }
    const low = w.stock < s.stock
    const run = def.kind === 'lasting' || low
    const reason = def.kind === 'stock' && !low ? `${v.reason}; ${w.stock} food items, enough for now (food.stock ${s.stock})` : v.reason
    return { active: name, kind: def.kind, have: null, run, reason, skipped }
  }
  return { active: null, kind: null, have: null, run: false, reason: s.sources.length ? 'no food source fits here' : 'food.sources is empty', skipped }
}

/** One line for status and chat: "food source: plot (a plot inside the base...); skipped farm: ..., repair: ...". */
export function foodSourceText (c: FoodSourceChoice): string {
  const head = c.active ? `food source: ${c.active} (${c.reason})` : `no food source: ${c.reason}`
  const skip = c.skipped.filter(x => !/^no bad farm$/.test(x.reason))
  return skip.length ? `${head}; skipped ${skip.map(x => `${x.name}: ${x.reason}`).join('; ')}` : head
}

/** The failure memory after a source's run. */
export function noteSourceRun (failed: FoodSourceWorld['failed'], name: FoodSourceName, ok: boolean, reason: string, now: number, s: Pick<FoodSourceSettings, 'retryMinutes'>): FoodSourceWorld['failed'] {
  const next = { ...failed }
  if (ok) delete next[name]
  else next[name] = { until: now + s.retryMinutes * 60_000, reason: reason.slice(0, 160) }
  return next
}
