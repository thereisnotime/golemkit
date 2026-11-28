// The bot's own drops after a death. setup() keeps a snapshot of what it carries (the server
// empties the inventory just before the death event, so the last full snapshot is what it lost)
// and records each death: where, the dimension, the hostiles around, day or night, open sky. The
// cause comes from the agent's death report (deathCause). recover_items walks back, picks the
// things up, puts the armour and weapon back on and says what came back; the recover_drops
// behaviour runs it right after a respawn. Decisions are pure in recoverPlan.ts.
import type { Bot } from 'mineflayer'
import { defineSkill, defineAction, z, ok, fail, travel, isHostile, checkAborted, fmtPos, itemName, type Agent, type ActionResult } from '../core/index.ts'
import { pickupNearby, droppedItemName, unreachableDrop } from './pickup.ts'
import { vec } from './world.ts'
import { equipGear } from './gear.ts'
import { equipBestWeapon } from './combat.ts'
import { gearNow } from './ranged.ts'
import {
  recoverDecision, tripCheck, recoveryReport, RECOVER_DEFAULTS,
  type DeathSite, type LostItem, type RecoverWorld, type RecoverOptions, type RecoverDecision, type Pos3
} from './recoverPlan.ts'

export interface OwnDeath extends DeathSite {
  id: number
  /** Set once a trip finished or was ruled out: one recovery per death. */
  handled?: string
  /** Trips started (one cut short by a fight or a danger may be picked up again). */
  attempts?: number
}

interface RecoverState {
  snapshot: { items: LostItem[], at: number, emptySince: number | null }
  deaths: OwnDeath[]
  nextId: number
}

const states = new WeakMap<Agent, RecoverState>()
/** Longest pickup round at the spot: drops it can't reach in this time stay behind. */
const PICKUP_MS = 90_000
const GEAR = /_(sword|axe|pickaxe|shovel|hoe|helmet|chestplate|leggings|boots)$|^(shield|bow|crossbow|trident|totem_of_undying)$/

function state (agent: Agent): RecoverState {
  let s = states.get(agent)
  if (!s) { s = { snapshot: { items: [], at: 0, emptySince: null }, deaths: [], nextId: 1 }; states.set(agent, s) }
  return s
}

/** Everything carried: armour (slots 5-8), the main inventory and hotbar (9-44), the offhand (45). */
export function carriedMap (bot: Bot): Record<string, number> {
  const out: Record<string, number> = {}
  const slots = bot.inventory?.slots ?? []
  for (let i = 5; i <= 45; i++) {
    const it = slots[i]
    if (it) out[itemName(it)] = (out[itemName(it)] ?? 0) + it.count
  }
  return out
}

const toList = (m: Record<string, number>): LostItem[] => Object.entries(m).map(([name, count]) => ({ name, count }))
const sum = (m: Record<string, number>) => Object.values(m).reduce((a, b) => a + b, 0)
const dist3 = (a: Pos3, b: Pos3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

function isNight (bot: Bot): boolean {
  const t = bot.time?.timeOfDay ?? 0
  return !(t < 12542 || t > 23459)
}

/** Hostiles within `radius` of a point, counted by type. */
function hostileCounts (bot: Bot, at: Pos3, radius: number): Record<string, number> {
  const out: Record<string, number> = {}
  for (const e of Object.values(bot.entities ?? {})) {
    if (e === bot.entity || !isHostile(e) || !e.position) continue
    if (dist3(e.position, at) > radius) continue
    const n = e.name ?? 'mob'
    out[n] = (out[n] ?? 0) + 1
  }
  return out
}

function setup (agent: Agent, bot: Bot): () => void {
  const st = state(agent)
  const snap = () => {
    if (!bot.inventory || !(bot.health > 0)) return
    const m = carriedMap(bot)
    const now = Date.now()
    if (sum(m) > 0) { st.snapshot = { items: toList(m), at: now, emptySince: null }; return }
    // empty: only believe it after a few seconds (the inventory empties just before the death event)
    if (st.snapshot.emptySince === null) st.snapshot.emptySince = now
    else if (now - st.snapshot.emptySince > 3000) st.snapshot = { items: [], at: now, emptySince: st.snapshot.emptySince }
  }
  const timer = setInterval(snap, 1000)
  ;(timer as { unref?: () => void }).unref?.()
  const onHealth = () => { if (bot.health > 0) snap() }
  const onDeath = () => {
    const me = bot.entity
    const p = me?.position
    const pos = p ? { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } : null
    let openSky: boolean | undefined
    try {
      const b = p ? bot.blockAt(p.offset(0, 1, 0)) : null
      if (b && typeof (b as { skyLight?: number }).skyLight === 'number') openSky = (b as { skyLight: number }).skyLight >= 14
    } catch {}
    const lost = Date.now() - st.snapshot.at < 30_000 ? st.snapshot.items : []
    const d: OwnDeath = {
      id: st.nextId++,
      diedAt: Date.now(),
      pos,
      ...(bot.game?.dimension ? { dimension: bot.game.dimension } : {}),
      kind: 'unknown',
      recentDamage: [],
      hostiles: p ? hostileCounts(bot, p, 8) : {},
      lost,
      night: isNight(bot),
      ...(openSky !== undefined ? { openSky } : {})
    }
    st.deaths = [d, ...st.deaths].slice(0, 5)
    st.snapshot = { items: [], at: Date.now(), emptySince: Date.now() }
    agent.log.child('recover').info(`died at ${pos ? fmtPos(pos) : 'unknown'} carrying ${lost.reduce((n, i) => n + i.count, 0)} items`)
  }
  bot.on('health', onHealth)
  bot.on('death', onDeath)
  return () => {
    clearInterval(timer)
    bot.off('health', onHealth)
    bot.off('death', onDeath)
  }
}

/** The last own death within the despawn time, with the cause from the death report once it is there. */
export function lastOwnDeath (agent: Agent, now = Date.now(), maxAgeMs = RECOVER_DEFAULTS.despawnMs): OwnDeath | null {
  const d = states.get(agent)?.deaths[0]
  if (!d || now - d.diedAt > maxAgeMs) return null
  const r = (agent as { lastDeathReport?: Agent['lastDeathReport'] }).lastDeathReport
  if (r && Math.abs(r.at - d.diedAt) < 10_000 && d.kind === 'unknown') {
    d.kind = r.kind
    d.recentDamage = r.recentDamage
    if (r.killer) d.killer = r.killer
    if (!d.pos && r.position) d.pos = { x: Math.floor(r.position.x), y: Math.floor(r.position.y), z: Math.floor(r.position.z) }
  }
  return d
}

/** Whether the cause report for this death is in (or long enough has passed without one). */
export function deathReported (agent: Agent, d: OwnDeath, now = Date.now()): boolean {
  return d.kind !== 'unknown' || now - d.diedAt > 6000
}

export function markHandled (d: OwnDeath, why: string): void {
  if (!d.handled) d.handled = why
}

/** Water blocks from the death spot up; null when the chunk isn't loaded. */
function waterAbove (bot: Bot, at: Pos3): number | null {
  let n = 0
  for (let dy = 0; dy < 40; dy++) {
    let b: ReturnType<Bot['blockAt']> = null
    try { b = bot.blockAt(vec(bot, at.x, at.y + dy, at.z)) } catch { return null }
    if (!b) return dy === 0 ? null : n
    if (b.name !== 'water' && b.name !== 'bubble_column' && !(b as { getProperties?: () => any }).getProperties?.()?.waterlogged) return n
    n++
  }
  return n
}

/** The world as recoverDecision reads it. */
export function senseRecoverWorld (agent: Agent, bot: Bot, d: OwnDeath, now = Date.now()): RecoverWorld {
  const p = bot.entity.position
  const here = { x: p.x, y: p.y, z: p.z }
  const close = !!d.pos && dist3(here, d.pos) <= 48 && (!d.dimension || d.dimension === bot.game?.dimension)
  return {
    now,
    here,
    ...(bot.game?.dimension ? { dimension: bot.game.dimension } : {}),
    gear: gearNow(bot, agent),
    night: isNight(bot),
    carried: sum(carriedMap(bot)),
    liveHostiles: close && d.pos ? hostileCounts(bot, d.pos, 12) : null,
    waterAbove: close && d.pos ? waterAbove(bot, d.pos) : null,
    players: Object.keys(bot.players ?? {}).filter(n => n !== bot.username),
    minY: (bot.game as { minY?: number } | undefined)?.minY ?? -64
  }
}

export function decideRecovery (agent: Agent, bot: Bot, d: OwnDeath, opts: RecoverOptions = {}, now = Date.now()): RecoverDecision {
  return recoverDecision(d, senseRecoverWorld(agent, bot, d, now), opts)
}

/** Walks back, picks up, re-equips. The decision is the caller's (or recover_items' own). */
export async function recoverTrip (agent: Agent, bot: Bot, d: OwnDeath, signal: AbortSignal, opts: RecoverOptions & { radius?: number } = {}): Promise<ActionResult> {
  const at = d.pos
  if (!at) return fail("I don't know where I died")
  const o = { ...RECOVER_DEFAULTS, ...opts }
  const deadline = d.diedAt + o.despawnMs
  const radius = opts.radius ?? 10
  const before = carriedMap(bot)
  const ctl = new AbortController()
  let why: string | undefined
  const check = () => {
    if (ctl.signal.aborted || !bot.entity) return
    const here = bot.entity.position
    const remaining = Math.round(Math.max(0, dist3(here, at) - 2))
    const near = remaining <= 24
    const c = tripCheck({
      now: Date.now(),
      deadline,
      remaining,
      health: bot.health,
      ...(near ? { hostilesHere: hostileCounts(bot, at, 12), gear: gearNow(bot, agent), night: isNight(bot), ...(d.openSky !== undefined ? { openSky: d.openSky } : {}) } : {})
    }, o)
    if (!c.go) { why = c.why; ctl.abort() }
  }
  const timer = setInterval(check, 500)
  const trip = AbortSignal.any([signal, ctl.signal])
  const log = agent.log.child('recover')
  log.info(`going back for ${sum(Object.fromEntries(d.lost.map(i => [i.name, i.count])))} items at ${fmtPos(at)}`)
  try {
    try {
      await travel(bot, at, trip, { range: 2 })
    } catch (e) {
      checkAborted(signal)
      if (!why && dist3(bot.entity.position, at) > radius) why = `couldn't get there: ${(e as Error).message}`
    }
    // its own things first (tools and armour lead the list), then whatever else lies there
    const names = [...new Set(d.lost.map(i => i.name))].sort((a, b) => Number(!GEAR.test(a)) - Number(!GEAR.test(b)))
    const pickupUntil = Math.min(deadline, Date.now() + PICKUP_MS)
    // drops scatter and drift (out of a pit, down a slope, in water): a second round looks further out from the spot
    for (const r of [radius, radius + 8]) {
      for (const item of [...names, undefined]) {
        if (why || Date.now() > pickupUntil) break
        checkAborted(signal)
        if (bot.inventory.emptySlotCount() === 0) break
        const there = bot.nearestEntity(e => e.name === 'item' && dist3(e.position, at) <= r && (!item || droppedItemName(e) === item) && !unreachableDrop(bot, e))
        if (!there) continue
        try {
          const reach = Math.min(32, Math.max(radius, Math.ceil(there.position.distanceTo(bot.entity.position)) + 2))
          await pickupNearby(bot, trip, { radius: reach, ...(item ? { item } : {}), maxMs: Math.max(3000, Math.min(15_000, pickupUntil - Date.now())) })
        } catch { checkAborted(signal) }
      }
    }
  } finally {
    clearInterval(timer)
    if (ctl.signal.aborted) { try { bot.pathfinder?.setGoal(null) } catch {} }
  }
  try { await equipGear(bot) } catch {}
  try { await equipBestWeapon(bot) } catch {}
  const r = recoveryReport(d.lost, before, carriedMap(bot), why)
  log.info(r.text)
  const data = { got: r.got, of: r.of, items: r.items, missing: r.missing, ...(why ? { reason: why } : {}) }
  return r.got > 0 ? ok(r.text, data) : fail(r.text, data)
}

const recoverItems = defineAction({
  name: 'recover_items',
  capabilities: ['move', 'inventory'],
  description: 'After your own death: walk back to where you died, pick up your dropped things before they despawn (5 minutes), ' +
    'put the armour and weapon back on, and say what came back ("got back 23 of 32 items: stone sword, ..."). ' +
    'Refuses when the drops are lost (lava, void, another dimension, too far for the time left) or the spot is too dangerous; force=true goes anyway.',
  params: z.object({
    force: z.boolean().default(false).describe('go even when it looks too dangerous or too far'),
    give_up_health: z.number().min(0).max(19).default(RECOVER_DEFAULTS.giveUpHealth).describe('turn back at or below this health'),
    radius: z.number().min(2).max(24).default(10).describe('pick up drops this close to the spot'),
    max_distance: z.number().min(16).max(2000).optional().describe('farthest death spot worth a trip (default 400)')
  }),
  longRunning: true,
  async run ({ agent, bot, signal }, p): Promise<ActionResult> {
    const d = lastOwnDeath(agent)
    if (!d) return fail('no death of mine in the last 5 minutes')
    const opts: RecoverOptions = p.max_distance ? { maxDistance: p.max_distance } : {}
    const dec = decideRecovery(agent, bot, d, opts)
    if (dec.do !== 'go' && (!p.force || (dec.do === 'skip' && dec.gone))) return fail(`not going back: ${dec.why}`, { decision: dec })
    d.attempts = (d.attempts ?? 0) + 1
    const r = await recoverTrip(agent, bot, d, signal, { ...opts, radius: p.radius, giveUpHealth: p.give_up_health })
    markHandled(d, r.message) // finished (an abort throws and leaves it open for another try)
    return r
  }
})

export const recovery = () => defineSkill({
  name: 'recovery',
  capabilities: ['move', 'inventory'],
  description: 'Getting your own things back after a death (recover_items).',
  actions: [recoverItems],
  setup: setup as (agent: Agent, bot: unknown) => () => void,
  observe: (agent) => {
    const d = lastOwnDeath(agent)
    if (!d || d.handled || !d.pos || !d.lost.length) return {}
    const left = Math.max(0, Math.round((d.diedAt + RECOVER_DEFAULTS.despawnMs - Date.now()) / 1000))
    return { myDrops: `${d.lost.reduce((n, i) => n + i.count, 0)} items at ${fmtPos(d.pos)}${d.dimension ? ` (${d.dimension})` : ''}, despawn in ${left}s; recover_items gets them` }
  }
})
