// Pure planning for keep_spawn_bed: where the respawn point is (from server messages and
// where the bot comes back after dying), where to put a bed near home, what to do next to get
// one (inventory, own chests, craft from wool and planks, shear or hunt sheep, search rings),
// and how long to stay in bed at night while other players are still up. No Mineflayer here;
// the skill (bed.ts) and the behaviour feed it plain data. Unit-tested in test/bed-plan.test.ts.
import { nextRing, recordSearch, type SearchRecord } from './foodPlan.ts'
import { plankTopUp, samePlanks } from './toolkit.ts'

export interface Pos { x: number, y: number, z: number }
export type Facing = 'north' | 'south' | 'east' | 'west'

/** Wool colours in the order of the sheep's wool metadata (low 4 bits). */
export const WOOL_COLOURS = [
  'white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray',
  'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'
] as const

/** Default search rings around home for sheep, smallest first. */
export const SHEEP_RINGS = [64, 128, 250] as const
/** An empty sheep ring is not searched again for this long. */
export const SHEEP_RING_MEMORY_MS = 30 * 60_000
/** Respawning this close to the bed counts as respawning at the bed. */
export const RESPAWN_NEAR_BED = 4

const BED_RE = /^(?:[a-z0-9_]+:)?([a-z_]+)_bed$/
const WOOL_RE = /^(?:[a-z0-9_]+:)?([a-z_]+)_wool$/

export const isBedItem = (name: string): boolean => BED_RE.test(name)

// ------------------------------------------------------------------ the spawn point

export interface SpawnRecord {
  /** unknown: never seen; set: the server took a bed as respawn point; lost: it isn't any more. */
  status: 'unknown' | 'set' | 'lost'
  /** The bed (foot or head, whichever was clicked) the respawn point is at. */
  bed?: Pos
  dim?: string
  /** When the status last changed (epoch ms). */
  at?: number
  /** How it was learned: message, click, slept, respawn. */
  how?: string
  /** Why it is lost. */
  reason?: string
}

/** What a server message about beds and sleeping means. */
export type BedMessage =
  | { kind: 'set_spawn' }
  | { kind: 'no_sleep' }
  | { kind: 'not_safe' }
  | { kind: 'too_far' }
  | { kind: 'obstructed' }
  | { kind: 'occupied' }
  | { kind: 'spawn_not_valid' }
  | { kind: 'players_sleeping', sleeping: number, needed: number }
  | { kind: 'skipping_night' }
  | { kind: 'not_possible' }

/**
 * Reads a bed or sleep message (1.21.1 English texts, or the bare translation keys when the
 * client has no language data). Null for anything else.
 */
export function parseBedMessage (text: string): BedMessage | null {
  const t = text.trim()
  if (/^Respawn point set$|block\.minecraft\.set_spawn/.test(t)) return { kind: 'set_spawn' }
  if (/^You can sleep only at night or during thunderstorms|block\.minecraft\.bed\.no_sleep/.test(t)) return { kind: 'no_sleep' }
  if (/^You may not rest now; there are monsters nearby|block\.minecraft\.bed\.not_safe/.test(t)) return { kind: 'not_safe' }
  if (/^You may not rest now; the bed is too far away|block\.minecraft\.bed\.too_far_away/.test(t)) return { kind: 'too_far' }
  if (/^This bed is obstructed|block\.minecraft\.bed\.obstructed/.test(t)) return { kind: 'obstructed' }
  if (/^This bed is occupied|block\.minecraft\.bed\.occupied/.test(t)) return { kind: 'occupied' }
  if (/^You have no home bed or charged respawn anchor|block\.minecraft\.spawn\.not_valid/.test(t)) return { kind: 'spawn_not_valid' }
  if (/^Sleeping through this night|sleep\.skipping_night/.test(t)) return { kind: 'skipping_night' }
  if (/^No amount of rest can pass this night|sleep\.not_possible/.test(t)) return { kind: 'not_possible' }
  const m = /^(\d+)\/(\d+) players sleeping/.exec(t)
  if (m) return { kind: 'players_sleeping', sleeping: Number(m[1]), needed: Number(m[2]) }
  return null
}

/**
 * What a bed click answered. In 1.21.1 the server sets the respawn point before it checks the
 * time and monsters (ServerPlayer.startSleepInBed), so "only at night" and "monsters nearby"
 * mean the point is set; "too far", "obstructed" and "occupied" mean it is not.
 */
export function clickOutcome (kind: BedMessage['kind']): { set: boolean, retry?: 'closer', why: string } | null {
  switch (kind) {
    case 'set_spawn': return { set: true, why: 'respawn point set' }
    case 'no_sleep': return { set: true, why: 'respawn point set (too early to sleep)' }
    case 'not_safe': return { set: true, why: 'respawn point set (monsters nearby, could not sleep)' }
    case 'too_far': return { set: false, retry: 'closer', why: 'the bed is too far away' }
    case 'obstructed': return { set: false, why: 'the bed is obstructed' }
    case 'occupied': return { set: false, why: 'the bed is occupied' }
    default: return null
  }
}

const dist = (a: Pos, b: Pos) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const flat = (a: { x: number, z: number }, b: { x: number, z: number }) => Math.hypot(a.x - b.x, a.z - b.z)
const sameDim = (a?: string, b?: string) => !a || !b || a.replace(/^minecraft:/, '') === b.replace(/^minecraft:/, '')

export function noteSpawnSet (bed: Pos, dim: string | undefined, now: number, how: string): SpawnRecord {
  return { status: 'set', bed: { x: bed.x, y: bed.y, z: bed.z }, ...(dim ? { dim } : {}), at: now, how }
}

export function noteSpawnLost (rec: SpawnRecord, now: number, reason: string): SpawnRecord {
  return { ...rec, status: 'lost', at: now, reason }
}

/**
 * Where the bot came back after dying says whether the respawn point held: next to the bed
 * means it did (confirmed), anywhere else means it is gone (the bed was broken or blocked, or
 * it was never set).
 */
export function noteRespawn (rec: SpawnRecord, pos: Pos, dim: string | undefined, now: number, near = RESPAWN_NEAR_BED): SpawnRecord {
  if (rec.bed && sameDim(rec.dim, dim) && dist(pos, rec.bed) <= near) return { ...rec, status: 'set', at: now, how: 'respawn', reason: undefined }
  const where = `${Math.round(pos.x)} ${Math.round(pos.y)} ${Math.round(pos.z)}`
  const reason = rec.bed
    ? `respawned at ${where}, ${Math.round(flat(pos, rec.bed))} blocks from the bed`
    : `respawned at ${where} with no bed set`
  return { ...rec, status: 'lost', at: now, how: 'respawn', reason }
}

/** The respawn point is a bed within `range` of home (same dimension). */
export function spawnAtHome (rec: SpawnRecord, home: (Pos & { dimension?: string }) | null | undefined, range: number): boolean {
  return !!home && rec.status === 'set' && !!rec.bed && sameDim(rec.dim, home.dimension) && flat(rec.bed, home) <= range && Math.abs(rec.bed.y - home.y) <= 6
}

/** Beds work in dimensions with a day cycle; in the Nether and the End they explode. */
export function bedsWorkIn (dim: string | undefined): boolean {
  return !dim || !/(nether|the_end|(^|:)end)$/.test(dim)
}

// ------------------------------------------------------------------ where to put the bed

/** What the spot planner needs to know about one block. */
export interface BedCell {
  name: string
  /** A full block to stand (and put a bed) on. */
  solid: boolean
  /** Air or something replaceable (grass, snow layer); never liquid. */
  free: boolean
}

/** Block lookup; null when not loaded. */
export type CellAt = (x: number, y: number, z: number) => BedCell | null

export interface BedSpot {
  /** Where the bed's foot goes (the cell to place at). */
  foot: Pos
  /** The bed's head cell, one step along `facing`. */
  head: Pos
  facing: Facing
  score: number
}

export interface BedSpotOptions {
  /** How far from the centre to look, horizontally. Default 6. */
  range?: number
  /** Up and down from the centre's y. Default 2. */
  dy?: number
  /** Cells that are off limits (protected areas, danger zones). */
  avoid?: (p: Pos) => boolean
}

export const FACING_VEC: Record<Facing, { x: number, z: number }> = {
  north: { x: 0, z: -1 },
  south: { x: 0, z: 1 },
  east: { x: 1, z: 0 },
  west: { x: -1, z: 0 }
}
const FACINGS: Facing[] = ['north', 'east', 'south', 'west']

/** Doors, gates and trapdoors: a bed must not stand in front of one. */
const PASSAGE = /_door$|fence_gate$|_trapdoor$/
/** Blocks that should keep their front free (opening a chest needs air above it). */
const KEEP_CLEAR = /chest$|barrel$|furnace$|smoker$|crafting_table$|_bed$|ladder$/

const add = (p: Pos, x: number, y: number, z: number): Pos => ({ x: p.x + x, y: p.y + y, z: p.z + z })
const same = (a: Pos, b: Pos) => a.x === b.x && a.y === b.y && a.z === b.z

/** A cell the bot can stand in: free, free above, solid below. */
function walkable (at: CellAt, p: Pos): boolean {
  const c = at(p.x, p.y, p.z)
  const up = at(p.x, p.y + 1, p.z)
  const down = at(p.x, p.y - 1, p.z)
  return !!c?.free && !!up?.free && !!down?.solid
}

/**
 * Why a bed can't go with its foot at `foot` facing `facing`, or null when it can: both cells
 * free with a full block under them and room above, nothing off limits, not in front of a door,
 * gate or trapdoor, not on top of or right beside a chest's front, not plugging a one-wide
 * passage, and a spot next to it to stand on and click from.
 */
export function bedSpotProblem (at: CellAt, foot: Pos, facing: Facing, o: { avoid?: (p: Pos) => boolean, keepFree?: Pos[] } = {}): string | null {
  const v = FACING_VEC[facing]
  const head = add(foot, v.x, 0, v.z)
  const cells = [foot, head]
  for (const c of cells) {
    if (o.keepFree?.some(k => same(k, c))) return 'keeps the home spot free'
    const b = at(c.x, c.y, c.z)
    if (!b) return 'not loaded'
    if (!b.free) return `${b.name} is in the way`
    if (!at(c.x, c.y - 1, c.z)?.solid) return 'no floor'
    if (!at(c.x, c.y + 1, c.z)?.free) return 'no headroom'
    if (o.avoid?.(c)) return 'off limits (protected area or danger zone)'
  }
  for (const c of cells) {
    for (const f of FACINGS) {
      const n = add(c, FACING_VEC[f].x, 0, FACING_VEC[f].z)
      for (const dy of [0, 1]) {
        const b = at(n.x, n.y + dy, n.z)
        if (b && PASSAGE.test(b.name)) return `in front of a ${b.name}`
      }
      const low = at(n.x, n.y, n.z)
      if (low && KEEP_CLEAR.test(low.name)) return `right next to a ${low.name}`
    }
    const below = at(c.x, c.y - 1, c.z)
    if (below && KEEP_CLEAR.test(below.name)) return `on top of a ${below.name}`
    // a one-wide passage: walkable on two opposite sides (the bed's other half counts as the way on), walls on the other two
    const open = (f: Facing) => { const n = add(c, FACING_VEC[f].x, 0, FACING_VEC[f].z); return cells.some(x => same(x, n)) || walkable(at, n) }
    const wall = (f: Facing) => { const n = add(c, FACING_VEC[f].x, 0, FACING_VEC[f].z); return !cells.some(x => same(x, n)) && !at(n.x, n.y, n.z)?.free }
    if ((open('north') && open('south') && wall('east') && wall('west')) || (open('east') && open('west') && wall('north') && wall('south'))) return 'would block a passage'
  }
  const stand = cells.some(c => FACINGS.some(f => {
    const n = add(c, FACING_VEC[f].x, 0, FACING_VEC[f].z)
    return !cells.some(x => same(x, n)) && walkable(at, n)
  }))
  if (!stand) return 'nowhere to stand next to it'
  return null
}

/**
 * The best place for a bed near `center` (home): the free spot nearest to it (same floor
 * first), headboard against a wall when there is a choice. The centre cell itself stays free
 * so go_home still has somewhere to stand. Null when nothing within range works.
 */
export function planBedSpot (center: Pos, at: CellAt, o: BedSpotOptions = {}): BedSpot | null {
  const range = o.range ?? 6
  const dyMax = o.dy ?? 2
  const c = { x: Math.floor(center.x), y: Math.floor(center.y), z: Math.floor(center.z) }
  let best: BedSpot | null = null
  for (let dx = -range; dx <= range; dx++) {
    for (let dz = -range; dz <= range; dz++) {
      if (Math.hypot(dx, dz) > range + 0.5) continue
      for (let dy = -dyMax; dy <= dyMax; dy++) {
        const foot = add(c, dx, dy, dz)
        for (const facing of FACINGS) {
          const v = FACING_VEC[facing]
          const head = add(foot, v.x, 0, v.z)
          const d = Math.max(Math.hypot(dx, dz), 1) + Math.hypot(head.x - c.x, head.z - c.z) * 0.25
          let score = d + Math.abs(dy) * 2
          if (best && score - 0.5 >= best.score) continue
          if (bedSpotProblem(at, foot, facing, { avoid: o.avoid, keepFree: [c] })) continue
          const behind = at(head.x + v.x, head.y, head.z + v.z)
          if (behind && !behind.free) score -= 0.5 // headboard against a wall
          if (!best || score < best.score) best = { foot, head, facing, score }
        }
      }
    }
  }
  return best
}

// ------------------------------------------------------------------ what to do next

/** Wool counts per colour. */
export function woolByColour (inv: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(inv)) {
    const m = WOOL_RE.exec(k)
    if (m && v > 0 && (WOOL_COLOURS as readonly string[]).includes(m[1]!)) out[m[1]!] = (out[m[1]!] ?? 0) + v
  }
  return out
}

/** The colour with the most wool (white on ties), or null with no wool at all. */
export function bestWool (inv: Record<string, number>): { colour: string, count: number } | null {
  let best: { colour: string, count: number } | null = null
  for (const [colour, count] of Object.entries(woolByColour(inv))) {
    if (!best || count > best.count || (count === best.count && colour === 'white')) best = { colour, count }
  }
  return best
}

export interface OwnChest extends Pos { contents: Record<string, number> }

export interface BedWorld {
  now: number
  home: (Pos & { dimension?: string }) | null
  /** The bot is in home's dimension. */
  inHomeDim: boolean
  spawn: SpawnRecord
  /** The block at spawn.bed: a bed, gone, or not loaded. */
  spawnBed: 'bed' | 'gone' | 'unknown'
  /** A bed of its own near home that is still there (or not loaded), nearest first. */
  ownBed: Pos | null
  inv: Record<string, number>
  /** Its own chests near home with what it last saw in them. */
  chests: readonly OwnChest[]
  /** Unsheared adult sheep in sight that it may shear. */
  shearable: number
  /** Unsheared adult sheep in sight that it may kill (herd spared). */
  huntable: number
  night: boolean
  searches: readonly SearchRecord[]
  /** Actions it has. */
  can: { craft: boolean, hunt: boolean, shear: boolean, search: boolean, withdraw: boolean, place: boolean, use: boolean }
}

export interface BedStepOptions {
  /** How close to home the bed must be to count. Default 8. */
  homeRange?: number
  rings?: readonly number[]
  ringMemoryMs?: number
}

export type BedStep =
  | { do: 'use', bed: Pos, why: string }
  | { do: 'place', item: string, why: string }
  | { do: 'withdraw', item: string, count: number, from: Pos, why: string }
  | { do: 'craft', item: string, count: number, why: string }
  | { do: 'shear', why: string }
  | { do: 'hunt', count: number, why: string }
  | { do: 'search', radius: number, covered: number, why: string }
  /** Nothing it can do right now; back off. `need: 'wood'` asks chop_wood_loop for wood. */
  | { do: 'stuck', why: string, need?: 'wood', retryInMs?: number }

/** Whether the job is done: the respawn point is a bed at home that is still there. */
export function spawnDone (w: Pick<BedWorld, 'home' | 'spawn' | 'spawnBed'>, homeRange = 8): boolean {
  return spawnAtHome(w.spawn, w.home, homeRange) && w.spawnBed !== 'gone'
}

/**
 * The next step towards a respawn point at home, or null when it is already there. In order:
 * click a bed of its own near home, place a bed from the inventory, take one from its chests,
 * craft one (3 wool of one colour + 3 planks of one kind, planks from logs first), take wool
 * from its chests, shear sheep (shears made from 2 iron), hunt sheep, search rings for sheep
 * by day. "stuck" carries the reason to back off with.
 */
export function nextBedStep (w: BedWorld, o: BedStepOptions = {}): BedStep | null {
  const homeRange = o.homeRange ?? 8
  if (!w.home) return { do: 'stuck', why: 'no home set (set_home)' }
  if (!bedsWorkIn(w.home.dimension)) return { do: 'stuck', why: `home is in ${w.home.dimension}, where beds explode` }
  if (spawnDone(w, homeRange)) return null
  if (!w.inHomeDim) return { do: 'stuck', why: 'not in the same dimension as home' }
  if (w.ownBed && w.can.use) return { do: 'use', bed: w.ownBed, why: 'my bed near home is not my respawn point yet' }
  const bedItem = Object.keys(w.inv).find(k => isBedItem(k) && (w.inv[k] ?? 0) > 0)
  if (bedItem) return w.can.place ? { do: 'place', item: bedItem, why: `placing my ${bedItem} near home` } : { do: 'stuck', why: 'I may not place blocks' }
  if (w.can.withdraw) {
    for (const c of w.chests) {
      const item = Object.keys(c.contents).find(k => isBedItem(k) && (c.contents[k] ?? 0) > 0)
      if (item) return { do: 'withdraw', item, count: 1, from: { x: c.x, y: c.y, z: c.z }, why: `a ${item} in my chest` }
    }
  }
  if (!w.can.craft) return { do: 'stuck', why: 'no bed and I can\'t craft one' }
  const wool = bestWool(w.inv)
  if (wool && wool.count >= 3) {
    if (samePlanks(w.inv).count >= 3) return { do: 'craft', item: `${wool.colour}_bed`, count: 1, why: `3 ${wool.colour} wool and planks: crafting a bed` }
    const top = plankTopUp(w.inv, 3)
    if (top && top !== 'enough' && (w.inv[top.planks] ?? 0) + top.runs * 4 >= 3) return { do: 'craft', item: top.planks, count: (w.inv[top.planks] ?? 0) + top.runs * 4, why: 'planks for the bed' }
    return { do: 'stuck', why: 'I have the wool for a bed but no wood for 3 planks', need: 'wood' }
  }
  // wool in its chests that makes 3 of one colour together with what it carries
  if (w.can.withdraw) {
    const have = woolByColour(w.inv)
    let pick: { item: string, count: number, from: Pos } | null = null
    for (const c of w.chests) {
      for (const [colour, n] of Object.entries(woolByColour(c.contents))) {
        const want = 3 - (have[colour] ?? 0)
        if (n >= want && (!pick || want < pick.count)) pick = { item: `${colour}_wool`, count: want, from: { x: c.x, y: c.y, z: c.z } }
      }
    }
    if (pick) return { do: 'withdraw', ...pick, why: `${pick.item} in my chest` }
  }
  const need = 3 - (wool?.count ?? 0)
  const shears = (w.inv.shears ?? 0) > 0
  if (shears && w.shearable > 0 && w.can.shear) return { do: 'shear', why: `need ${need} more wool, shearing sheep` }
  if (!shears && (w.inv.iron_ingot ?? 0) >= 2 && w.shearable > 0 && w.can.shear) return { do: 'craft', item: 'shears', count: 1, why: 'shears to get wool' }
  if (w.huntable > 0 && w.can.hunt) return { do: 'hunt', count: Math.min(need, 3, w.huntable), why: `need ${need} more wool, hunting sheep` }
  if (w.night) return { do: 'stuck', why: 'it is night; I look for sheep by day' }
  const rings = [...(o.rings?.length ? o.rings : SHEEP_RINGS)].sort((a, b) => a - b)
  const memory = o.ringMemoryMs ?? SHEEP_RING_MEMORY_MS
  if (w.can.search) {
    const ring = nextRing(w.searches, rings, w.now, memory)
    if (ring) return { do: 'search', radius: ring.radius, covered: ring.covered, why: ring.covered ? `no sheep within ${ring.covered}, looking ${ring.radius} out` : `looking for sheep ${ring.radius} out` }
  }
  const empty = w.searches.filter(s => !s.found && w.now - s.at < memory)
  const retryInMs = empty.length ? Math.max(0, Math.min(...empty.map(s => s.at + memory - w.now))) : undefined
  return { do: 'stuck', why: `no sheep found within ${rings[rings.length - 1]}`, ...(retryInMs !== undefined ? { retryInMs } : {}) }
}

/** Records a sheep search (keeps a dozen). */
export function recordSheepSearch (searches: readonly SearchRecord[], radius: number, found: boolean, now: number): SearchRecord[] {
  return recordSearch(searches, { radius, at: now, found }, SHEEP_RING_MEMORY_MS * 3)
}

// ------------------------------------------------------------------ staying in bed at night

export interface SleepPlayer {
  name: string
  /** Seen lying in a bed. */
  sleeping?: boolean
  /** Its entity is in sight, so it is in the bot's dimension. */
  seen?: boolean
  spectator?: boolean
  /** Known to be away from keyboard. */
  afk?: boolean
}

export interface SleepAskOptions {
  /** How long to stay in bed waiting for the others. Default 12 s. */
  graceMs: number
  /** Ask the others to go to bed. */
  ask: boolean
  /** Between asks. Default 5 s. */
  intervalMs: number
  /** Asks per night, the first one included. Default 3. */
  maxAsks: number
  /** The server's playersSleepingPercentage, used until the server reports a count. Default 100. */
  percentage: number
  /** Players never asked (other bots, for one). */
  ignore: readonly string[]
}

export const SLEEP_ASK_DEFAULTS: SleepAskOptions = { graceMs: 12_000, ask: true, intervalMs: 5000, maxAsks: 3, percentage: 100, ignore: [] }

export interface SleepAskState {
  startedAt: number
  asks: number
  lastAskAt?: number
  /** The server's last "N/M players sleeping". */
  count?: { sleeping: number, needed: number }
  /** "Sleeping through this night": enough are asleep. */
  skipping?: boolean
  /** "No amount of rest can pass this night" (percentage over 100). */
  impossible?: boolean
}

export type SleepAskStep =
  | { do: 'done', why: string }
  | { do: 'leave', why: string }
  | { do: 'ask', players: string[], first: boolean, missing: number }
  | { do: 'wait', ms: number }

/** Updates the state from a sleep message. */
export function noteSleepMessage (s: SleepAskState, m: BedMessage | null): SleepAskState {
  if (!m) return s
  if (m.kind === 'players_sleeping') return { ...s, count: { sleeping: m.sleeping, needed: m.needed }, skipping: false }
  if (m.kind === 'skipping_night') return { ...s, skipping: true }
  if (m.kind === 'not_possible') return { ...s, impossible: true }
  return s
}

/**
 * While the bot lies in bed at night: wait for the night to skip, ask the players who are
 * still up to go to bed (one ask, then reminders, a few at most), and get up when the grace
 * runs out. Who to ask: players seen awake in this dimension; the unseen ones only when the
 * server's count says more sleepers are needed than are in sight (players in the Nether or
 * the End don't count, and asking them is noise). Spectators, AFK and ignored players never.
 */
export function sleepAskStep (s: SleepAskState, w: { now: number, inBed: boolean, night: boolean, self: string, players: readonly SleepPlayer[] }, o: SleepAskOptions = SLEEP_ASK_DEFAULTS): SleepAskStep {
  if (!w.night) return { do: 'done', why: 'morning' }
  if (!w.inBed) return { do: 'done', why: s.skipping ? 'the night was skipped' : 'out of bed' }
  if (s.impossible) return { do: 'leave', why: 'the server never skips the night (sleeping percentage over 100)' }
  const waited = w.now - s.startedAt
  if (s.skipping) return waited < o.graceMs + 10_000 ? { do: 'wait', ms: 1000 } : { do: 'leave', why: 'the night did not skip after all' }
  if (waited >= o.graceMs) return { do: 'leave', why: `nobody else went to bed in ${Math.round(o.graceMs / 1000)} s` }
  const ignore = new Set(o.ignore.map(n => n.toLowerCase()))
  const others = w.players.filter(p => p.name !== w.self && !p.spectator && !p.afk && !ignore.has(p.name.toLowerCase()))
  const asleep = 1 + others.filter(p => p.sleeping).length
  const missing = s.count
    ? s.count.needed - s.count.sleeping
    : Math.max(1, Math.ceil((others.length + 1) * Math.max(0, o.percentage) / 100)) - asleep
  if (missing <= 0) return { do: 'wait', ms: 1000 }
  const awakeSeen = others.filter(p => p.seen && !p.sleeping).map(p => p.name)
  const unseen = others.filter(p => !p.seen && !p.sleeping).map(p => p.name)
  const targets = missing > awakeSeen.length ? [...awakeSeen, ...unseen] : awakeSeen
  const due = s.lastAskAt === undefined || w.now - s.lastAskAt >= o.intervalMs
  if (o.ask && targets.length && s.asks < o.maxAsks && due) return { do: 'ask', players: targets, first: s.asks === 0, missing }
  return { do: 'wait', ms: Math.min(1000, Math.max(100, o.graceMs - waited)) }
}

/** "A", "A and B", "A, B and C". */
export function nameList (names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

export const DEFAULT_ASK_TEXT = '{players}, could you hop into bed so we can skip the night?'
export const DEFAULT_REMIND_TEXT = 'Still in bed, {players}: {sleeping}/{needed} asleep.'

/** Fills {players}, {sleeping}, {needed} in an ask text. */
export function askText (template: string, players: readonly string[], count?: { sleeping: number, needed: number }): string {
  return template
    .replace(/\{players\}/g, nameList(players))
    .replace(/\{sleeping\}/g, String(count?.sleeping ?? 1))
    .replace(/\{needed\}/g, String(count?.needed ?? players.length + 1))
}
