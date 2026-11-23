import type { Bot } from 'mineflayer'
import type { Block } from 'prismarine-block'
import type { Item } from 'prismarine-item'
import { defineSkill, defineAction, z, ok, fail, goals, fmtPos, itemName, checkAborted, sleep, travel, type Agent, type ActionResult } from '../core/index.ts'
import { vec, reachBlock, within, gotoWithin } from './world.ts'
import { parseChestList } from './searchPlan.ts'
import { woodToTake, woodValue } from './treePlan.ts'
import {
  ContainerBook, memorySettings, scopeKey, posKey, parseKey, freshness, observeContents, chestPartner, chestHalves,
  fmtDiff, fmtAge, changeKind, chooseGrumble, whereIs, checkDue, pantryLow, fmtWhere,
  type ContainerEntry, type GrumbleKind, type MemorySettings, type Freshness, type WhereHit
} from './containerPlan.ts'

const SEARCH = 32
const SETTLE_MS = 150
export const CONTAINER_RE = /^(chest|trapped_chest|barrel|.*shulker_box)$/

const TOOL_RE = /(_pickaxe|_axe|_shovel|_hoe|_sword|_helmet|_chestplate|_leggings|_boots)$|^(shears|bow|crossbow|trident|shield|fishing_rod|flint_and_steel|mace|elytra|totem_of_undying)$/

export function isToolOrArmor (name: string): boolean {
  return TOOL_RE.test(name)
}

/**
 * Which inventory items a deposit moves. item="all" moves everything except tools, armour,
 * food (when keepEssentials) and anything named in keep.
 */
export function selectDeposits<T extends { name: string }> (items: T[], opts: { item: string, keep?: string[], keepEssentials?: boolean, isFood?: (name: string) => boolean }): T[] {
  const keep = new Set(opts.keep ?? [])
  return items.filter(i => {
    if (keep.has(i.name)) return false
    if (opts.item !== 'all') return i.name === opts.item
    if (opts.keepEssentials === false) return true
    return !isToolOrArmor(i.name) && !opts.isFood?.(i.name)
  })
}

/** Summarises a list of items as {name: count}. */
export function tally (items: { name: string, count: number }[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const i of items) out[i.name] = (out[i.name] ?? 0) + i.count
  return out
}

export function fmtTally (t: Record<string, number>): string {
  const e = Object.entries(t)
  return e.length ? e.map(([n, c]) => `${c}x ${n}`).join(', ') : 'empty'
}

// ------------------------------------------------------------------ container memory
// What the bot saw inside containers, per server and dimension (containerPlan.ts). With
// settings.inventoryMemory.enabled it lives in agent.storage (survives restarts) and is kept
// right as players change things: journal events, block updates in view, a grumble when its
// own chest is raided. Off: a plain in-memory map per agent, as it always was.

const memBooks = new WeakMap<Agent, ContainerBook>()
const diskBooks = new WeakMap<Agent, ContainerBook>()
const GRUMBLED_KEY = 'containers.grumbled'
/** At most one grumble about any container this often. */
const GRUMBLE_GAP_MS = 10 * 60_000

type AgentLike = Agent & { storage?: Agent['storage'] }

/** settings.inventoryMemory with the defaults (off unless the profile turns it on). */
export function memoryOptions (agent: Agent): MemorySettings {
  return memorySettings((agent.settings as { inventoryMemory?: unknown } | undefined)?.inventoryMemory)
}

/** The book in use: storage-backed when memory is on (in-memory entries carried over once), in-memory otherwise. */
function book (agent: Agent, create = true): ContainerBook | null {
  const storage = (agent as AgentLike).storage
  if (memoryOptions(agent).enabled && storage) {
    let d = diskBooks.get(agent)
    if (!d) {
      d = new ContainerBook(storage)
      diskBooks.set(agent, d)
      const m = memBooks.get(agent)
      if (m) for (const sc of m.scopes()) for (const { pos, entry } of m.list(sc)) if (!d.has(sc, pos)) d.put(sc, pos, entry)
    }
    return d
  }
  let m = memBooks.get(agent)
  if (!m && create) { m = new ContainerBook(); memBooks.set(agent, m) }
  return m ?? null
}

function clientOf (agent: Agent): Bot | null {
  try { return (agent as unknown as { bot?: Bot }).bot ?? null } catch { return null }
}

/** Memory scope: this server and the dimension the bot is in. */
function scopeOf (agent: Agent, bot?: Bot | null): string {
  const s = (agent as { server?: { host?: string, port?: number } }).server
  const b = bot ?? clientOf(agent)
  return scopeKey(s?.host ? `${s.host}:${s.port ?? 25565}` : 'local', b?.game?.dimension)
}

/** The position a container is remembered under (a double chest by its lower half) and the other half. */
function halvesOf (block: Block): { key: Pos, alt: Pos | null } {
  const p = { x: block.position.x, y: block.position.y, z: block.position.z }
  if (!/chest$/.test(block.name)) return { key: p, alt: null }
  let props: Record<string, unknown> = {}
  try { props = (block as unknown as { getProperties (): Record<string, unknown> }).getProperties() } catch {}
  return chestHalves(p, chestPartner(p, props.facing, props.type))
}

const samePos = (a: Pos, b: Pos) => a.x === b.x && a.y === b.y && a.z === b.z

/** Its own (placed) or a configured chest, by either half. */
function isMine (agent: Agent, p: Pos, alt?: Pos | null): boolean {
  return [...ownChests(agent), ...configuredChests(agent)].some(c => samePos(c, p) || (!!alt && samePos(c, alt)))
}

function isFoodName (bot: Bot | null, name: string): boolean {
  const foods = (bot?.registry as { foodsByName?: Record<string, unknown> } | undefined)?.foodsByName ?? {}
  return !!foods[name]
}

/** "pantry at 559 69 -47", "my chest at ...", "chest at ...". */
function labelOf (agent: Agent, bot: Bot | null, p: Pos, e: ContainerEntry): string {
  const alt = e.alt ? parseKey(e.alt) : null
  const configured = configuredChests(agent).some(c => samePos(c, p) || (!!alt && samePos(c, alt)))
  const food = Object.keys(e.contents ?? {}).some(n => isFoodName(bot, n))
  const what = configured ? (food ? 'pantry' : 'storage chest') : ownChests(agent).some(c => samePos(c, p) || (!!alt && samePos(c, alt))) ? 'my chest' : e.block.replace(/_/g, ' ')
  return `${what} at ${posKey(p)}`
}

function journal (agent: Agent, bot: Bot | null, type: string, data: Record<string, unknown>, pos: Pos): void {
  try { agent.journal?.record(type, data, { pos, ...(bot?.game?.dimension ? { dim: bot.game.dimension } : {}) }) } catch {}
}

/**
 * Grumbles once, in character, when its own or configured chest is raided, moved or broken
 * (settings.inventoryMemory.grumble): per container at most every grumbleHours, any container at
 * most every 10 minutes, to the owners online by whisper (nobody online: nothing) or in public
 * chat with grumbleTo: say. Goes through agent.whisper/say, so the chat rate limits apply.
 */
function grumble (agent: Agent, at: Pos, kind: GrumbleKind, vars: { item?: string, what?: string }, now = Date.now()): string | null {
  const o = memoryOptions(agent)
  const storage = (agent as AgentLike).storage
  if (!o.grumble || !storage) return null
  const last = storage.get<Record<string, { at: number, line: string }>>(GRUMBLED_KEY, {})
  const lastAny = Math.max(0, ...Object.values(last).map(v => v.at))
  if (now - lastAny < GRUMBLE_GAP_MS) return null
  const k = posKey(at)
  const line = chooseGrumble(kind, vars, { enabled: true, lastAt: last[k]?.at, everyMs: o.grumbleHours * 3_600_000, now, lastLine: last[k]?.line })
  if (!line) return null
  if (o.grumbleTo === 'say') agent.say(line)
  else {
    let online: string[] = []
    try { online = agent.adapter?.players?.() ?? [] } catch {}
    const owners = online.filter(n => agent.owners.includes(n.toLowerCase()))
    if (!owners.length) return null
    for (const n of owners) agent.whisper(n, line)
  }
  const keep = Object.fromEntries(Object.entries(last).filter(([, v]) => now - v.at < 24 * 3_600_000))
  storage.set(GRUMBLED_KEY, { ...keep, [k]: { at: now, line } })
  return line
}

/**
 * The bot just opened a container: overwrite the entry with what is really there. With memory
 * on, a difference from what it remembered (somebody took or added things) is journalled as
 * container_changed, and its own chest raided makes it grumble. Call before the bot moves items.
 */
export function opened (agent: Agent, bot: Bot, block: Block, items: Item[], now = Date.now()): Record<string, number> {
  const contents = tally(items.map(i => ({ name: itemName(i), count: i.count })))
  const { key, alt } = halvesOf(block)
  const sc = scopeOf(agent, bot)
  const b = book(agent)!
  const prev = b.get(sc, key)?.entry ?? null
  const { entry, diff } = observeContents(prev, block.name, contents, now, alt ? posKey(alt) : undefined)
  b.put(sc, key, entry)
  if (!memoryOptions(agent).enabled || !diff || !prev?.contents || prev.doubt) return contents
  const label = labelOf(agent, bot, key, entry)
  const text = `${label}: ${fmtDiff(diff)} since ${fmtAge(now - prev.at).replace(/ ago$/, '')} ago`.replace('since just now ago', 'just now')
  agent.log.info(`container changed: ${text}`)
  const mine = isMine(agent, key, alt)
  journal(agent, bot, 'container_changed', { block: block.name, label, gone: diff.gone, added: diff.added, since: prev.at, ...(mine ? { own: true } : {}), text }, key)
  const ck = changeKind(prev.contents, contents, diff)
  if (mine && ck) grumble(agent, key, ck.kind, { item: ck.item, what: ck.what }, now)
  return contents
}

/** After the bot moved items itself: the new contents, no report. */
function remember (agent: Agent, bot: Bot, block: Block, items: Item[], now = Date.now()): Record<string, number> {
  const contents = tally(items.map(i => ({ name: itemName(i), count: i.count })))
  const { key, alt } = halvesOf(block)
  book(agent)!.put(scopeOf(agent, bot), key, { block: block.name, contents, at: now, verifiedAt: now, ...(alt ? { alt: posKey(alt) } : {}) })
  return contents
}

/**
 * A remembered container is not there any more (it arrived and found `found`, or saw the block
 * change in view): the entry goes, with memory on a container_gone event with what it last held,
 * a nearby container it doesn't know is noted (moved?), and its own chest gone makes it grumble.
 * One half of a double chest broken keeps the other half, its contents in doubt.
 */
export function containerGone (agent: Agent, bot: Bot, p: Pos, found: string | null, how: 'arrived' | 'in view', now = Date.now()): void {
  const b = book(agent, false)
  if (!b) return
  const sc = scopeOf(agent, bot)
  const g = b.get(sc, p)
  if (!g) return
  const on = memoryOptions(agent).enabled
  const halves = [g.pos, ...(g.entry.alt ? [parseKey(g.entry.alt)] : [])]
  const other = halves.find(h => !samePos(h, p))
  if (other) {
    const ob = bot.blockAt(vec(bot, other.x, other.y, other.z))
    if (ob && CONTAINER_RE.test(ob.name)) {
      b.put(sc, other, { ...g.entry, block: ob.name, alt: undefined, doubt: true, verifiedAt: now })
      if (on && g.entry.contents) {
        const label = labelOf(agent, bot, other, g.entry)
        journal(agent, bot, 'container_changed', { block: g.entry.block, label, gone: {}, added: {}, since: g.entry.at, note: 'half of the double chest broken', text: `${label}: half of the double chest broken` }, other)
      }
      return
    }
  }
  b.drop(sc, p)
  if (!on || !g.entry.contents) return
  const label = labelOf(agent, bot, g.pos, g.entry)
  // moved? a container close by it knows nothing about
  const ids = Object.values(bot.registry.blocksByName).filter(x => CONTAINER_RE.test(x.name)).map(x => x.id)
  let moved: Pos | null = null
  try {
    moved = bot.findBlocks({ matching: ids, maxDistance: 32, count: 32, point: vec(bot, g.pos.x, g.pos.y, g.pos.z) } as any)
      .map(v => ({ x: v.x, y: v.y, z: v.z }))
      .filter(v => Math.hypot(v.x - g.pos.x, v.y - g.pos.y, v.z - g.pos.z) <= 6 && !b.has(sc, v))[0] ?? null
  } catch {}
  if (moved) {
    const mb = bot.blockAt(vec(bot, moved.x, moved.y, moved.z))
    if (mb) {
      const h = halvesOf(mb)
      b.put(sc, h.key, { block: mb.name, contents: null, at: 0, verifiedAt: now, note: `near where the ${label} was`, ...(h.alt ? { alt: posKey(h.alt) } : {}) })
      moved = h.key
    }
  }
  const mine = isMine(agent, g.pos, other)
  const text = `${label} ${found ? `is ${found.replace(/_/g, ' ')} now` : 'is gone'}; it held ${fmtTally(g.entry.contents)} (seen ${fmtAge(now - g.entry.at)})${moved ? `; a container I don't know is at ${posKey(moved)}` : ''}`
  agent.log.info(`container gone: ${text}`)
  journal(agent, bot, 'container_gone', {
    block: g.entry.block, label, found, how, held: g.entry.contents, since: g.entry.at, ...(mine ? { own: true } : {}), ...(moved ? { movedTo: moved } : {}), text
  }, g.pos)
  if (mine) {
    // a chest it placed and that is gone is not its own any more
    const st = (agent as AgentLike).storage
    if (st) {
      const own = ownChests(agent)
      const left = own.filter(c => !halves.some(h => samePos(h, c)))
      if (left.length !== own.length) st.set(OWN_CHESTS_KEY, left)
    }
    grumble(agent, g.pos, moved ? 'moved' : 'gone', {}, now)
  }
}

/** A container it has not looked into (placed in view, or by home): remembered without contents, never opened for that. */
function noteSeen (agent: Agent, bot: Bot, block: Block, note: string, now = Date.now()): void {
  const b = book(agent)!
  const sc = scopeOf(agent, bot)
  const { key, alt } = halvesOf(block)
  if (b.has(sc, key) || (alt && b.has(sc, alt))) return
  b.put(sc, key, { block: block.name, contents: null, at: 0, verifiedAt: now, note, ...(alt ? { alt: posKey(alt) } : {}) })
}

/** A remembered container whose block changed in view: gone, or a double chest formed or split. */
export function blockChanged (agent: Agent, bot: Bot, oldBlock: Block | null, newBlock: Block, now = Date.now()): void {
  const b = book(agent, false)
  if (!b) return
  const sc = scopeOf(agent, bot)
  const p = { x: newBlock.position.x, y: newBlock.position.y, z: newBlock.position.z }
  const g = b.get(sc, p)
  if (g) {
    if (!CONTAINER_RE.test(newBlock.name) || newBlock.name !== g.entry.block) { containerGone(agent, bot, p, newBlock.name, 'in view', now); return }
    const h = halvesOf(newBlock)
    const alt = h.alt ? posKey(h.alt) : undefined
    if (posKey(h.key) !== g.key || alt !== g.entry.alt) {
      b.drop(sc, g.pos)
      b.put(sc, h.key, { ...g.entry, alt, doubt: true, verifiedAt: now })
    }
    return
  }
  if (CONTAINER_RE.test(newBlock.name) && !(oldBlock && CONTAINER_RE.test(oldBlock.name))) noteSeen(agent, bot, newBlock, 'placed in view', now)
}

/** A chunk came into view: remembered containers in it that are gone are dropped without walking there. */
export function chunkLoaded (agent: Agent, bot: Bot, cx: number, cz: number, now = Date.now()): void {
  const b = book(agent, false)
  if (!b) return
  const sc = scopeOf(agent, bot)
  for (const { pos, entry } of b.list(sc)) {
    if (Math.floor(pos.x / 16) !== cx || Math.floor(pos.z / 16) !== cz) continue
    const block = bot.blockAt(vec(bot, pos.x, pos.y, pos.z))
    if (!block) continue
    if (!CONTAINER_RE.test(block.name) || block.name !== entry.block) containerGone(agent, bot, pos, block.name, 'in view', now)
    else if (now - entry.verifiedAt > 10 * 60_000) b.update(sc, pos, { verifiedAt: now })
  }
}

export interface KnownContainer extends Pos {
  block: string
  contents: Record<string, number>
  /** When it looked inside (0: never, contents unknown). */
  at: number
  /** When the block was last seen in place. */
  verifiedAt: number
  ageMs: number
  /** fresh: a fact; hint: older than maxAgeHours or in doubt, re-check before relying on it; unknown: never looked inside. */
  freshness: Freshness
  /** The other half of a double chest. */
  alt?: Pos
}

/**
 * Containers the bot remembers looking into, with what it saw and how long ago (newest first).
 * With memory on this includes what it saw before a restart; `freshness` tells facts from hints.
 * `includeUnknown` adds containers it saw but never opened (contents {}).
 */
export function knownContainers (agent: Agent, opts: { includeUnknown?: boolean, now?: number } = {}): KnownContainer[] {
  const b = book(agent, false)
  if (!b) return []
  const now = opts.now ?? Date.now()
  const maxAge = memoryOptions(agent).maxAgeHours * 3_600_000
  return b.list(scopeOf(agent)).filter(r => opts.includeUnknown || r.entry.contents).map(({ pos, entry }) => ({
    ...pos,
    block: entry.block,
    contents: entry.contents ?? {},
    at: entry.at,
    verifiedAt: entry.verifiedAt,
    ageMs: now - entry.at,
    freshness: freshness(entry, now, maxAge),
    ...(entry.alt ? { alt: parseKey(entry.alt) } : {})
  })).sort((a, b) => b.at - a.at)
}

/** Whether a remembered container is the one at `p` (either half of a double chest). */
export function sameContainer (c: Pos & { alt?: Pos }, p: Pos): boolean {
  return samePos(c, p) || (!!c.alt && samePos(c.alt, p))
}

/** The remembered container at `p` (either half), if any. */
export function knownAt (list: KnownContainer[], p: Pos): KnownContainer | undefined {
  return list.find(c => sameContainer(c, p))
}

/** Remembered containers holding `item` (exact names first), for "where is my iron". */
export function whereStored (agent: Agent, item: string, now = Date.now()): WhereHit[] {
  const b = book(agent, false)
  if (!b) return []
  const bot = clientOf(agent)
  const from = bot?.entity?.position
  return whereIs(b.list(scopeOf(agent, bot)), item, now, memoryOptions(agent).maxAgeHours * 3_600_000, from ? { x: from.x, y: from.y, z: from.z } : undefined)
}

function findContainer (bot: Bot, at?: { x?: number, y?: number, z?: number }, agent?: Agent): Block | string {
  if (at && at.x !== undefined && at.y !== undefined && at.z !== undefined) {
    const b = bot.blockAt(vec(bot, at.x, at.y, at.z))
    if (!b) return `${at.x} ${at.y} ${at.z} is not loaded`
    if (!CONTAINER_RE.test(b.name)) {
      if (agent) containerGone(agent, bot, { x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) }, b.name, 'arrived')
      return `no container at ${at.x} ${at.y} ${at.z} (found ${b.name})`
    }
    return b
  }
  const ids = Object.values(bot.registry.blocksByName).filter(b => CONTAINER_RE.test(b.name)).map(b => b.id)
  return bot.findBlock({ matching: ids, maxDistance: SEARCH }) ?? `no chest or barrel within ${SEARCH} blocks`
}

/**
 * Walks into reach and opens the container. If the server doesn't answer (seen when the bot
 * stands where it can't see the front of the chest), steps to a spot with line of sight and
 * tries once more.
 */
async function openAt (bot: Bot, block: Block, signal: AbortSignal) {
  await reachBlock(bot, block.position, signal)
  try {
    return await bot.openContainer(block)
  } catch (e) {
    checkAborted(signal)
    await gotoWithin(bot, new goals.GoalLookAtBlock(block.position, bot.world, { reach: 3 }), signal, 15_000).catch(() => {})
    checkAborted(signal)
    try {
      return await bot.openContainer(block)
    } catch {
      throw new Error(`couldn't open the ${block.name} at ${fmtPos(block.position)}`)
    }
  }
}

// ------------------------------------------------------------------ own chests

export const OWN_CHESTS_KEY = 'search.ownChests'
interface Pos { x: number, y: number, z: number }

/** Chests and barrels this bot put down (remembered in storage). */
export function ownChests (agent: Agent): Pos[] {
  return (agent as { storage?: Agent['storage'] }).storage?.get<Pos[]>(OWN_CHESTS_KEY, []) ?? []
}

/** Chests listed in the profile (storage.chests). */
export function configuredChests (agent: Agent): Pos[] {
  const s = (agent.settings as { storage?: { chests?: unknown } } | undefined)?.storage
  return parseChestList(s?.chests)
}

/**
 * Takes wood (logs first, then planks of one kind) out of the bot's own chests within `range`
 * until it holds `want` more plank units: own and configured chests, those known to hold wood
 * first, skipping ones it saw empty of wood and ones in protected areas. Returns what it took.
 */
export async function takeWoodFromOwnChests (ctx: { bot: Bot, agent: Agent, signal: AbortSignal }, want: number, range = 48): Promise<{ took: Record<string, number>, units: number, notes: string[] }> {
  return takeFromOwnChests(ctx, want, range, woodValue, woodToTake)
}

/**
 * Takes food (best food points first) out of the bot's own and configured chests within `range`
 * until it carries `want` more items: the pantry top-up before a trip (skills/trip.ts).
 */
export async function takeFoodFromOwnChests (ctx: { bot: Bot, agent: Agent, signal: AbortSignal }, want: number, range: number, points: (name: string) => number): Promise<{ took: Record<string, number>, units: number, notes: string[] }> {
  return takeFromOwnChests(ctx, want, range, n => points(n) > 0 ? 1 : 0, (contents, left) => foodToTake(contents, left, points))
}

/** Which food to take from a chest's contents for `want` items: the most food points per item first. Pure. */
export function foodToTake (contents: Record<string, number>, want: number, points: (name: string) => number): Record<string, number> {
  const out: Record<string, number> = {}
  let left = want
  for (const [name, n] of Object.entries(contents).filter(([k]) => points(k) > 0).sort((a, b) => points(b[0]) - points(a[0]))) {
    if (left <= 0) break
    const take = Math.min(n, left)
    out[name] = take
    left -= take
  }
  return out
}

/**
 * Takes items out of the bot's own chests (placed by it or listed in settings.storage.chests)
 * within `range` until it holds `want` more units (value per item), chests known to hold some
 * first, skipping ones seen without any and ones in protected areas. Returns what it took.
 */
async function takeFromOwnChests (
  ctx: { bot: Bot, agent: Agent, signal: AbortSignal }, want: number, range: number,
  value: (name: string) => number, toTake: (contents: Record<string, number>, left: number) => Record<string, number>
): Promise<{ took: Record<string, number>, units: number, notes: string[] }> {
  const { bot, agent, signal } = ctx
  const here = bot.entity.position
  const seenList = knownContainers(agent)
  const own = [...ownChests(agent), ...configuredChests(agent)]
    .filter((p, i, a) => a.findIndex(q => q.x === p.x && q.y === p.y && q.z === p.z) === i)
    .filter(p => Math.hypot(p.x - here.x, p.y - here.y, p.z - here.z) <= range && !agent.protectedAreas?.isProtected?.(p as any))
    .map(p => {
      const s = knownAt(seenList, p)
      const n = s ? Object.entries(s.contents).reduce((n, [k, v]) => n + value(k) * v, 0) : null
      // an old sighting without any is only a hint: still worth a look
      const has = s && s.freshness !== 'fresh' && !n ? null : n
      return { p, has }
    })
    .filter(c => c.has === null || c.has > 0)
    .sort((a, b) => (b.has ?? 0.5) - (a.has ?? 0.5))
  const took: Record<string, number> = {}
  const notes: string[] = []
  let units = 0
  for (const c of own.slice(0, 4)) {
    if (units >= want) break
    checkAborted(signal)
    const block = bot.blockAt(vec(bot, c.p.x, c.p.y, c.p.z))
    if (!block || !CONTAINER_RE.test(block.name)) {
      if (Math.hypot(c.p.x - here.x, c.p.z - here.z) > 32) {
        try { await travel(bot, c.p, signal, { range: 3 }) } catch (e) { checkAborted(signal); notes.push(`chest ${fmtPos(c.p)}: ${(e as Error).message}`); continue }
      }
      const again = bot.blockAt(vec(bot, c.p.x, c.p.y, c.p.z))
      if (!again || !CONTAINER_RE.test(again.name)) {
        if (again) containerGone(agent, bot, c.p, again.name, 'arrived')
        notes.push(`no chest at ${fmtPos(c.p)} any more`)
        continue
      }
    }
    const b = bot.blockAt(vec(bot, c.p.x, c.p.y, c.p.z))!
    let win
    try { win = await openAt(bot, b, signal) } catch (e) { checkAborted(signal); notes.push((e as Error).message); continue }
    try {
      const contents = opened(agent, bot, b, win.containerItems())
      const plan = toTake(contents, want - units)
      for (const [name, n] of Object.entries(plan)) {
        checkAborted(signal)
        const item = win.containerItems().find(i => itemName(i) === name)
        if (!item) continue
        const before = win.containerCount(item.type, null)
        try { await win.withdraw(item.type, null, n) } catch {}
        await sleep(SETTLE_MS, signal)
        const moved = before - win.containerCount(item.type, null)
        if (moved > 0) { took[name] = (took[name] ?? 0) + moved; units += moved * value(name) }
        if (moved < n) break
      }
      remember(agent, bot, b, win.containerItems())
    } finally {
      win.close()
    }
  }
  return { took, units, notes }
}

const coords = {
  x: z.number().optional().describe('container x; omit all three to use the nearest chest/barrel'),
  y: z.number().optional(),
  z: z.number().optional()
}

const isFoodFn = (bot: Bot) => {
  const foods = (bot.registry as any).foodsByName ?? {}
  return (name: string) => !!foods[name]
}

const deposit = defineAction({
  name: 'deposit',
  description: 'Put items into the nearest chest/barrel (or the one at x y z). item="all" stores everything except tools, armour, food and anything in keep.',
  params: z.object({
    item: z.string().default('all').describe('item name, or "all"'),
    count: z.number().int().positive().optional().describe('how many; default all of them'),
    keep: z.array(z.string()).optional().describe('item names never to store'),
    ...coords
  }),
  aliases: ['store'],
  async run ({ bot, agent, signal, log }, p): Promise<ActionResult> {
    const items = selectDeposits(bot.inventory.items().map(i => ({ name: itemName(i), type: i.type, count: i.count })), {
      item: p.item, keep: p.keep, isFood: isFoodFn(bot)
    })
    if (!items.length) return fail(p.item === 'all' ? 'nothing to store' : `no ${p.item}`)
    const block = findContainer(bot, p, agent)
    if (typeof block === 'string') return fail(block)
    const win = await openAt(bot, block, signal)
    const stored: Record<string, number> = {}
    let full = false
    const failed: string[] = []
    try {
      opened(agent, bot, block, win.containerItems())
      const byType = new Map<number, { name: string, count: number }>()
      for (const i of items) {
        const e = byType.get(i.type) ?? { name: i.name, count: 0 }
        e.count += i.count
        byType.set(i.type, e)
      }
      let left = p.count ?? Infinity
      for (const [type, e] of byType) {
        checkAborted(signal)
        if (left <= 0) break
        const n = Math.min(e.count, left)
        const before = win.containerCount(type, null)
        let err: Error | null = null
        try {
          await win.deposit(type, null, n)
        } catch (x) {
          err = x as Error
        }
        await sleep(SETTLE_MS, signal)
        // count what actually arrived in the container, the deposit may be partial
        const moved = win.containerCount(type, null) - before
        if (moved > 0) { stored[e.name] = moved; left -= moved }
        if (err) {
          log.debug('deposit failed', { item: e.name, error: err.message })
          if (win.firstEmptyContainerSlot() === null) { full = true; break }
          failed.push(e.name)
        }
      }
      remember(agent, bot, block, win.containerItems())
    } finally {
      win.close()
    }
    const what = fmtTally(stored)
    const skipped = failed.length ? `, couldn't move ${failed.join(', ')}` : ''
    if (what === 'empty') return fail(full ? 'that container is full' : `stored nothing${skipped}`)
    return ok(`stored ${what} in ${block.name} at ${fmtPos(block.position)}${full ? ' (it is full now)' : ''}${skipped}`, stored)
  }
})

export const withdraw = defineAction({
  name: 'withdraw',
  description: 'Take items out of the nearest chest/barrel (or the one at x y z).',
  params: z.object({
    item: z.string().describe('item name, or "all" to empty the container'),
    count: z.number().int().positive().optional().describe('how many; default all of that item'),
    ...coords
  }),
  aliases: ['take'],
  async run ({ bot, agent, signal }, p): Promise<ActionResult> {
    const block = findContainer(bot, p, agent)
    if (typeof block === 'string') return fail(block)
    const win = await openAt(bot, block, signal)
    const got: Record<string, number> = {}
    try {
      opened(agent, bot, block, win.containerItems())
      const inside = win.containerItems().filter(i => p.item === 'all' || itemName(i) === p.item)
      if (!inside.length) {
        return fail(`no ${p.item === 'all' ? 'items' : p.item} in that ${block.name}`)
      }
      const byType = new Map<number, { name: string, count: number }>()
      for (const i of inside) {
        const e = byType.get(i.type) ?? { name: itemName(i), count: 0 }
        e.count += i.count
        byType.set(i.type, e)
      }
      let left = p.count ?? Infinity
      for (const [type, e] of byType) {
        checkAborted(signal)
        if (left <= 0) break
        const n = Math.min(e.count, left)
        const before = win.containerCount(type, null)
        try {
          await win.withdraw(type, null, n)
        } catch {}
        await sleep(SETTLE_MS, signal)
        const moved = before - win.containerCount(type, null)
        if (moved > 0) { got[e.name] = moved; left -= moved }
        if (moved < n) break // inventory full
      }
      remember(agent, bot, block, win.containerItems())
    } finally {
      win.close()
    }
    const what = fmtTally(got)
    if (what === 'empty') return fail('took nothing (inventory full?)')
    return ok(`took ${what}`, got)
  }
})

const listContainer = defineAction({
  name: 'list_container',
  description: 'Say what is inside the nearest chest/barrel (or the one at x y z). Looks inside if it is within reach and the bot is idle, otherwise reports what it saw last time.',
  params: z.object(coords),
  exclusive: false,
  aliases: ['chest'],
  async run ({ bot, agent }, p): Promise<ActionResult> {
    const block = findContainer(bot, p, agent)
    if (typeof block === 'string') return fail(block)
    const where = `${block.name} at ${fmtPos(block.position)}`
    // only open it when nothing else is using the body or a window
    if (within(bot, block.position) && !agent.currentAction && !bot.currentWindow) {
      const win = await bot.openContainer(block).catch(() => null)
      if (win) {
        try {
          const contents = opened(agent, bot, block, win.containerItems())
          return ok(`${where}: ${fmtTally(contents)}`, contents)
        } finally {
          win.close()
        }
      }
    }
    const mem = knownAt(knownContainers(agent), block.position)
    if (!mem) return fail(`I can't look inside the ${where} from here and haven't seen inside it yet`)
    const note = mem.freshness === 'fresh' ? '' : ', may have changed since'
    return ok(`${where} (seen ${fmtAge(mem.ageMs)}${note}): ${fmtTally(mem.contents)}`, mem.contents)
  }
})

// ------------------------------------------------------------------ periodic check, where is X

const attempted = new WeakMap<Agent, Map<string, number>>()

/** Home (set_home) in this dimension, else null. */
function homeOf (agent: Agent, bot: Bot): Pos | null {
  const h = (agent as AgentLike).storage?.get<(Pos & { dimension?: string }) | undefined>('home')
  if (!h || (h.dimension && bot.game?.dimension && h.dimension !== bot.game.dimension)) return null
  return h
}

/**
 * Its own and configured chests within `radius` of home (or of the bot without a home) that it
 * has not looked into for refreshMinutes, nearest first; ones it tried within that time and ones
 * in protected areas are left out.
 */
export function storageDue (agent: Agent, bot: Bot, radius: number, now = Date.now(), all = false): Pos[] {
  if (!bot.entity) return []
  const o = memoryOptions(agent)
  const center = homeOf(agent, bot) ?? bot.entity.position
  const known = knownContainers(agent, { now })
  const tried = attempted.get(agent)
  const refreshMs = all ? 0 : o.refreshMinutes * 60_000
  const chests = [...ownChests(agent), ...configuredChests(agent)]
    .filter((p, i, a) => a.findIndex(q => samePos(p, q) || (!!knownAt(known, q) && knownAt(known, q) === knownAt(known, p))) === i)
    .filter(p => Math.hypot(p.x - center.x, p.z - center.z) <= radius && !agent.protectedAreas?.isProtected?.(p as any))
    .filter(p => all || now - (tried?.get(posKey(p)) ?? 0) >= refreshMs)
  const lookup = (p: Pos): ContainerEntry | null => {
    const k = knownAt(known, p)
    return k ? { block: k.block, contents: k.contents, at: k.at, verifiedAt: k.verifiedAt, ...(k.freshness === 'hint' && k.ageMs < o.maxAgeHours * 3_600_000 ? { doubt: true } : {}) } : null
  }
  const me = bot.entity.position
  return checkDue(chests, lookup, now, refreshMs, { x: me.x, y: me.y, z: me.z })
}

/** Food in the pantry (configured chests, else its own ones) within `radius` of home, from fresh memory: "pantry low: ..." or null. */
export function pantryReport (agent: Agent, bot: Bot, radius: number, now = Date.now()): { items: number, text: string } | null {
  const o = memoryOptions(agent)
  const center = homeOf(agent, bot) ?? bot.entity?.position
  if (!center) return null
  const known = knownContainers(agent, { now })
  const pantry = configuredChests(agent).length ? configuredChests(agent) : ownChests(agent)
  const seen = pantry
    .filter(p => Math.hypot(p.x - center.x, p.z - center.z) <= radius)
    .map(p => knownAt(known, p))
    .filter((c): c is KnownContainer => !!c && c.freshness === 'fresh')
    .filter((c, i, a) => a.indexOf(c) === i)
  return pantryLow(seen.map(c => c.contents), n => isFoodName(bot, n), o.lowFood)
}

const checkChests = defineAction({
  name: 'check_chests',
  description: 'Look inside its own chests (ones it placed) and the configured ones (settings.storage.chests) near home that it has not looked into lately, ' +
    'so what it remembers is right again: notes items taken or added, chests moved or broken, and says when the pantry runs low. Never opens anyone else\'s chest.',
  params: z.object({
    radius: z.number().int().min(4).max(256).default(48).describe('chests within this many blocks of home'),
    max: z.number().int().min(1).max(8).default(3).describe('chests to look into this time'),
    all: z.boolean().default(false).describe('also chests it looked into lately')
  }),
  async run ({ bot, agent, signal }, p): Promise<ActionResult> {
    const due = storageDue(agent, bot, p.radius, Date.now(), p.all)
    if (!due.length) {
      const low = pantryReport(agent, bot, p.radius)
      return ok(`every chest near home was checked lately${low ? `; ${low.text}` : ''}`, { checked: [], low })
    }
    let tried = attempted.get(agent)
    if (!tried) attempted.set(agent, tried = new Map())
    const notes: string[] = []
    const checked: string[] = []
    for (const c of due.slice(0, p.max)) {
      checkAborted(signal)
      tried.set(posKey(c), Date.now())
      try {
        if (Math.hypot(c.x - bot.entity.position.x, c.z - bot.entity.position.z) > 32) await travel(bot, c, signal, { range: 3 })
      } catch (e) { checkAborted(signal); notes.push(`${posKey(c)}: ${(e as Error).message}`); continue }
      const block = bot.blockAt(vec(bot, c.x, c.y, c.z))
      if (!block) { notes.push(`${posKey(c)} is not loaded`); continue }
      if (!CONTAINER_RE.test(block.name)) {
        containerGone(agent, bot, c, block.name, 'arrived')
        notes.push(`no chest at ${posKey(c)} any more (${block.name})`)
        continue
      }
      let win
      try { win = await openAt(bot, block, signal) } catch (e) { checkAborted(signal); notes.push((e as Error).message); continue }
      try {
        const contents = opened(agent, bot, block, win.containerItems())
        checked.push(`${posKey(c)}: ${fmtTally(contents)}`)
      } finally {
        win.close()
      }
    }
    const low = pantryReport(agent, bot, p.radius)
    const msg = [checked.length ? `checked ${checked.join('; ')}` : 'checked nothing', ...notes, ...(low ? [low.text] : [])].join('; ')
    return checked.length || !notes.length ? ok(msg, { checked, low }) : fail(msg, { checked, low })
  }
})

const whereStoredAction = defineAction({
  name: 'where_stored',
  description: 'Say where an item is stored, from what the bot remembers seeing in chests and barrels: position and how long ago it looked ' +
    '("12 iron_ingot in the chest at 559 69 -47, seen 2 h ago"). Older sightings are marked as maybe changed. bring_item fetches it from its own chests.',
  params: z.object({ item: z.string().min(1).describe('item name or a word of it, e.g. iron, bread, oak_log') }),
  exclusive: false,
  run ({ agent }, p): ActionResult {
    const item = p.item.toLowerCase().replace(/^(my|the|some|our) /, '').trim()
    const hits = whereStored(agent, item)
    if (!hits.length) return fail(`I don't remember any ${item} in a chest`)
    // bring_item only takes from its own and configured chests
    const fetchable = hits.some(h => isMine(agent, h.pos))
    return ok(fmtWhere(hits), { hits, fetchable })
  }
})

/** Block updates and chunk loads keep the memory right without walking there (memory on only). */
function setupMemory (agent: Agent, bot: Bot): () => void {
  const onUpdate = (oldBlock: Block | null, newBlock: Block | null) => {
    if (!newBlock || !memoryOptions(agent).enabled) return
    try { blockChanged(agent, bot, oldBlock, newBlock) } catch (e) { agent.log.debug(`container memory: ${(e as Error).message}`) }
  }
  const onChunk = (point: { x: number, z: number }) => {
    if (!memoryOptions(agent).enabled) return
    try { chunkLoaded(agent, bot, Math.floor(point.x / 16), Math.floor(point.z / 16)) } catch (e) { agent.log.debug(`container memory: ${(e as Error).message}`) }
  }
  bot.on('blockUpdate', onUpdate as any)
  bot.on('chunkColumnLoad', onChunk as any)
  return () => {
    bot.off('blockUpdate', onUpdate as any)
    bot.off('chunkColumnLoad', onChunk as any)
  }
}

export const containers = () => defineSkill({
  name: 'containers',
  capabilities: ['move', 'containers'],
  description: 'Storing items in and taking them out of chests and barrels.',
  actions: [deposit, withdraw, listContainer, checkChests, whereStoredAction],
  setup: (agent, bot) => setupMemory(agent, bot as Bot),
  observe: (_agent, bot) => {
    const ids = Object.values(bot.registry.blocksByName).filter(b => CONTAINER_RE.test(b.name)).map(b => b.id)
    return { containersNearby: bot.findBlocks({ matching: ids, maxDistance: 16, count: 64 }).length }
  }
})
