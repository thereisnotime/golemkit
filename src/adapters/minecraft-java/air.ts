// Getting air under water: reads the blocks around the head for the pure planner
// (skills/airPlan.ts) and carries the plan out, re-planning every tick: swim straight up, break
// ice or a roof above the head, or swim to the nearest opening. Used by the `air` reflex action
// (skills/air.ts) and by travel's swim-up (helpers.ts).
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { checkAborted } from '../../core/action.ts'
import { airPlan, airDone, isIce, waterStepCost, type AirCell, type AirPlan, type V } from '../../skills/airPlan.ts'

const WATERY = /^(water|bubble_column|kelp|kelp_plant|seagrass|tall_seagrass)$/

/** Eyes in water or a bubble column (below the water's surface in that block, as the server sees it). */
export function headInWater (bot: Bot): boolean {
  const e = bot.entity
  if (!e) return false
  const eye = e.position.offset(0, (e as { eyeHeight?: number }).eyeHeight ?? 1.62, 0)
  const b = bot.blockAt(eye) as any
  if (!b) return false
  if (b.name !== 'water') return WATERY.test(b.name) || b.getProperties?.().waterlogged === true
  // a water block is full only under more water; a source is 8/9 high, flowing water less
  if (bot.blockAt(b.position.offset(0, 1, 0))?.name === 'water') return true
  const level = Number(b.getProperties?.().level ?? 0)
  const height = level >= 8 ? 1 : (8 - level) / 9
  return eye.y < b.position.y + height
}

// ---- the bot's own air ----
// mineflayer (4.39 entities.js) copies the air_supply of EVERY entity whose metadata changes into
// bot.oxygenLevel, not just the bot's own. A mob dipping in and out of water near the bot (Pax's
// farm at night) overwrote Pax's air: the reflex saw high air while Pax drowned and fired 8 points
// late, and `air` read "got air" from someone else and swam off with none. trackOwnAir keeps the
// bot's own value from its own metadata and puts it back after every entity_metadata packet.

const ownAir = new WeakMap<Bot, number>()

/** Air (0..20) in an entity_metadata packet for `myId`, or null (another entity, or no air in it). */
export function ownAirFrom (packet: { entityId?: number, metadata?: Array<{ key: number, value: unknown }> }, myId: number | undefined, airKey: number): number | null {
  if (myId === undefined || packet?.entityId !== myId || !Array.isArray(packet.metadata)) return null
  const m = packet.metadata.find(x => x?.key === airKey)
  return m && typeof m.value === 'number' ? Math.round(m.value / 15) : null
}

/** The metadata index of air_supply for players in this registry (1 since 1.9). */
function airKeyOf (bot: Bot): number {
  const keys = (bot.registry as { entitiesByName?: Record<string, { metadataKeys?: string[] }> } | undefined)?.entitiesByName?.player?.metadataKeys
  const i = keys ? keys.indexOf('air_supply') : -1
  return i >= 0 ? i : 1
}

/**
 * Tracks the bot's own air and keeps bot.oxygenLevel honest (see above). Call once per session,
 * after mineflayer's plugins are loaded (its listener runs first, this one fixes it up after).
 */
export function trackOwnAir (bot: Bot): () => void {
  const client = (bot as unknown as { _client: { on: Function, off?: Function, removeListener?: Function } })._client
  const key = airKeyOf(bot)
  ownAir.delete(bot)
  const onMeta = (packet: { entityId?: number, metadata?: Array<{ key: number, value: unknown }> }) => {
    const mine = ownAirFrom(packet, bot.entity?.id, key)
    if (mine !== null) ownAir.set(bot, mine)
    // not sent yet: the server only sends air once it differs from full
    ;(bot as { oxygenLevel?: number }).oxygenLevel = ownAir.get(bot) ?? 20
  }
  // a new life (or dimension) starts with full air, and the server says nothing until it drops
  const onRespawn = () => { ownAir.delete(bot); (bot as { oxygenLevel?: number }).oxygenLevel = 20 }
  client.on('entity_metadata', onMeta)
  bot.on('respawn', onRespawn)
  bot.on('death', onRespawn)
  return () => {
    ;(client.off ?? client.removeListener)?.call(client, 'entity_metadata', onMeta)
    bot.off('respawn', onRespawn)
    bot.off('death', onRespawn)
  }
}

/** The bot's own air, 0..20 (trackOwnAir), else what mineflayer says. */
export const oxygen = (bot: Bot): number => ownAir.get(bot) ?? (bot as { oxygenLevel?: number }).oxygenLevel ?? 20

export interface AirOptions {
  /** May break blocks (agent.canDig). Default: the pathfinder's canDig. */
  canDig?: boolean
  /** Positions never broken (protected areas). Default: the pathfinder's break exclusions. */
  isProtected? (p: V): boolean
  /** Give up after this long. Default 30 s. */
  maxMs?: number
  log? (msg: string): void
}

const movementsOf = (bot: Bot) => (bot.pathfinder as unknown as { movements?: { canDig?: boolean, exclusionAreasBreak?: Array<(b: unknown) => number> } } | undefined)?.movements

function bestTool (bot: Bot, block: any): any {
  try { return (bot.pathfinder as any)?.bestHarvestTool?.(block) ?? null } catch { return null }
}

function digMs (bot: Bot, block: any, onGround: boolean): number {
  try {
    const tool = bestTool(bot, block)
    const head = bot.inventory.slots[5]
    const ench = [...(tool?.enchants ?? []), ...((head as any)?.enchants ?? [])]
    return block.digTime(tool?.type ?? null, false, true, !onGround, ench, bot.entity.effects)
  } catch { return 5000 }
}

/** The cells around the bot as the planner sees them. */
export function airCells (bot: Bot, o: AirOptions = {}): (p: V) => AirCell {
  const mv = movementsOf(bot)
  const canDig = o.canDig ?? mv?.canDig ?? true
  const prot = o.isProtected ?? ((p: V) => (mv?.exclusionAreasBreak ?? []).some(f => { try { return f({ position: p }) > 0 } catch { return false } }))
  const onGround = !!bot.entity?.onGround
  const cache = new Map<string, AirCell>()
  return (p: V) => {
    const k = `${p.x},${p.y},${p.z}`
    const hit = cache.get(k)
    if (hit) return hit
    const b = bot.blockAt(new Vec3(p.x, p.y, p.z)) as any
    let c: AirCell
    if (!b) c = { kind: 'unknown' }
    else if (WATERY.test(b.name) || b.getProperties?.().waterlogged === true) c = { kind: 'water', name: b.name }
    else if (b.boundingBox !== 'block' && b.name !== 'lava') c = { kind: 'air', name: b.name }
    else {
      const isProt = prot(p)
      c = { kind: 'solid', name: b.name, protected: isProt, breakable: canDig && !isProt && b.diggable !== false && b.hardness !== null && b.hardness >= 0 && b.name !== 'lava', digMs: digMs(bot, b, onGround) }
    }
    cache.set(k, c)
    return c
  }
}

export function planAir (bot: Bot, o: AirOptions = {}): AirPlan {
  const e = bot.entity
  const eye = e.position.offset(0, (e as { eyeHeight?: number }).eyeHeight ?? 1.62, 0).floored()
  return airPlan({ head: { x: eye.x, y: eye.y, z: eye.z }, cell: airCells(bot, o) })
}

const tick = (bot: Bot) => new Promise<void>(resolve => {
  const t = setTimeout(resolve, 100)
  bot.once('physicsTick', () => { clearTimeout(t); resolve() })
})

function steer (bot: Bot, to: { x: number, z: number }, near = 0.2): boolean {
  const p = bot.entity.position
  const dx = to.x + 0.5 - p.x
  const dz = to.z + 0.5 - p.z
  if (Math.hypot(dx, dz) < near) { bot.setControlState('forward', false); return false }
  // mineflayer yaw: 0 faces -z, turning toward -x
  const yaw = Math.atan2(-dx, -dz)
  void bot.look(yaw, Math.PI / 4, true)
  bot.setControlState('forward', true)
  return true
}

export interface AirResult {
  ok: boolean
  /** What it did, for the log and the journal ("broke 1 ice above, surfaced"). */
  summary: string
  broke: string[]
}

/**
 * Gets the bot its air back: re-plans every tick until the air is at 18 or more (30 s at most).
 * Leaves the bot where it got air (at the surface, in a hole in the ice or in an air pocket).
 */
export async function getAir (bot: Bot, signal: AbortSignal, o: AirOptions = {}): Promise<AirResult> {
  try { bot.pathfinder.setGoal(null) } catch {}
  bot.clearControlStates()
  // a furnace or crafting table left open (smelting when the air ran out): close it first
  closeWindow(bot, o.log)
  const broke: string[] = []
  const did = new Set<string>()
  let last = ''
  const until = Date.now() + (o.maxMs ?? 30_000)
  const roof = roofName(bot)
  try {
    while (Date.now() < until) {
      checkAborted(signal)
      if (!bot.entity || bot.health <= 0) break
      const inWater = headInWater(bot)
      if (airDone(oxygen(bot), inWater)) break
      if (!inWater) {
        // breathing: hold position at the surface (keep swimming up) until the air is back
        bot.setControlState('jump', true)
        bot.setControlState('forward', false)
        await tick(bot)
        continue
      }
      const plan = planAir(bot, o)
      const said = describePlan(plan)
      if (said !== last) { o.log?.(`air ${oxygen(bot)}/20 at ${fmtV(bot.entity.position)}: ${said}`); last = said }
      if (plan.act === 'up' || plan.act === 'none') {
        did.add(plan.act === 'up' ? 'swam up' : 'swam up blind')
        bot.setControlState('jump', true)
        if (plan.act === 'up') steer(bot, plan.to)
        else bot.setControlState('forward', false)
        await tick(bot)
        continue
      }
      if (plan.act === 'swim') {
        did.add('swam to an opening')
        bot.setControlState('jump', plan.next.y >= Math.floor(bot.entity.position.y + 1.62))
        steer(bot, plan.next, 0.05)
        await tick(bot)
        continue
      }
      // break the block above: centred under it, pinned against it (a dig in water off the ground is 25x slower,
      // but sinking out of reach is worse); from the floor when the floor is close and the block stays in reach
      const target = bot.blockAt(new Vec3(plan.block.x, plan.block.y, plan.block.z))
      if (!target) { await tick(bot); continue }
      if (steer(bot, plan.block, 0.25)) { bot.setControlState('jump', true); await tick(bot); continue }
      bot.setControlState('forward', false)
      const feet = bot.entity.position.floored()
      const floor = [1, 2].map(d => bot.blockAt(feet.offset(0, -d, 0))).findIndex(b => !!b && b.boundingBox === 'block')
      const fromFloor = floor >= 0 && plan.block.y + 0.5 - (feet.y - floor + 1.62) <= 4.2
      bot.setControlState('jump', !fromFloor)
      const settle = Date.now() + (fromFloor ? 1500 : 400)
      while (Date.now() < settle && (fromFloor ? !bot.entity.onGround : true)) { checkAborted(signal); await tick(bot) }
      const tool = bestTool(bot, target)
      if (tool && bot.heldItem?.type !== tool.type) await bot.equip(tool, 'hand').catch(() => {})
      const onAbort = () => { try { bot.stopDigging() } catch {} }
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        await bot.dig(target, true)
        broke.push(plan.name)
        o.log?.(`air: broke ${plan.name} at ${plan.block.x} ${plan.block.y} ${plan.block.z}`)
      } catch (e) {
        checkAborted(signal)
        o.log?.(`air: could not break ${plan.name}: ${(e as Error).message}`)
        await tick(bot)
      } finally {
        signal.removeEventListener('abort', onAbort)
      }
      bot.setControlState('jump', true)
    }
  } finally {
    bot.clearControlStates()
  }
  const okNow = airDone(oxygen(bot), headInWater(bot))
  const parts: string[] = []
  if (broke.length) parts.push(`broke ${summarise(broke)} above`)
  for (const d of did) if (!(broke.length && d === 'swam up')) parts.push(d)
  parts.push(okNow ? 'got air' : `still short of air (${oxygen(bot)}/20)`)
  const where = roof ? (isIce(roof) ? 'under ice' : `under ${roof}`) : 'under water'
  return { ok: okNow, summary: `out of air ${where}: ${parts.join(', ')}`, broke }
}

const fmtV = (p: { x: number, y: number, z: number }) => `${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}`

/** The plan in one line for the debug log: kind, target and why. */
export function describePlan (plan: AirPlan): string {
  switch (plan.act) {
    case 'up': return `up to ${fmtV(plan.to)}: ${plan.why}`
    case 'break': return `break ${plan.name} at ${fmtV(plan.block)}: ${plan.why}`
    case 'swim': return `swim to ${fmtV(plan.to)} via ${fmtV(plan.next)}: ${plan.why}`
    default: return `none: ${plan.why}`
  }
}

/** Closes an open container window (a furnace, a crafting table). True when one was open. */
export function closeWindow (bot: Bot, log?: (msg: string) => void): boolean {
  const w = bot.currentWindow
  if (!w) return false
  try { bot.closeWindow(w) } catch {}
  log?.(`air: closed the ${(w as { type?: string }).type ?? 'open'} window first`)
  return true
}

/** The first solid block within 6 above the head, if any (for the summary). */
function roofName (bot: Bot): string | null {
  const head = bot.entity.position.offset(0, 1.62, 0).floored()
  for (let dy = 1; dy <= 6; dy++) {
    const b = bot.blockAt(head.offset(0, dy, 0))
    if (!b) return null
    if (b.boundingBox === 'block') return b.name
    if (!WATERY.test(b.name)) return null
  }
  return null
}

function summarise (names: string[]): string {
  const n = new Map<string, number>()
  for (const x of names) n.set(x, (n.get(x) ?? 0) + 1)
  return [...n].map(([k, v]) => `${v} ${k}`).join(', ')
}

/**
 * A pathfinder step exclusion (Movements.exclusionAreasStep) that makes water under ice very
 * expensive, under any roof expensive, and deep water a bit more (skills/airPlan.ts waterStepCost).
 */
export function waterStepExclusion (bot: Bot): (block: { name?: string, position: V }) => number {
  return (block) => {
    if (!block?.name || !WATERY.test(block.name)) return 0
    const p = block.position
    return waterStepCost(dy => {
      const b = bot.blockAt(new Vec3(p.x, p.y + dy, p.z)) as any
      if (!b) return { kind: 'unknown' }
      if (WATERY.test(b.name)) return { kind: 'water', name: b.name }
      return b.boundingBox === 'block' ? { kind: 'solid', name: b.name } : { kind: 'air', name: b.name }
    })
  }
}

/**
 * Afloat at the surface: climbs onto a ledge right beside it (the edge of a hole in the ice, the
 * roof around a shaft) by swimming into it with jump held, which the physics turns into the
 * jump out of water. The pathfinder doesn't plan that move. True when it stands on the ledge.
 */
export async function climbOntoLedge (bot: Bot, signal: AbortSignal): Promise<boolean> {
  const feet = bot.entity.position.floored()
  const free = (x: number, y: number, z: number) => {
    const b = bot.blockAt(new Vec3(x, y, z))
    return !!b && b.boundingBox === 'empty' && !WATERY.test(b.name) && b.name !== 'lava'
  }
  let best: { x: number, y: number, z: number } | null = null
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    for (let ly = feet.y; ly <= feet.y + 2; ly++) {
      const g = bot.blockAt(new Vec3(feet.x + dx, ly, feet.z + dz))
      if (!g || g.boundingBox !== 'block' || /lava|magma|campfire|cactus/.test(g.name)) continue
      if (free(feet.x + dx, ly + 1, feet.z + dz) && free(feet.x + dx, ly + 2, feet.z + dz) && (!best || ly < best.y)) best = { x: feet.x + dx, y: ly, z: feet.z + dz }
      break
    }
  }
  if (!best) return false
  try {
    const until = Date.now() + 3000
    while (Date.now() < until) {
      checkAborted(signal)
      const p = bot.entity.position
      if (bot.entity.onGround && p.y >= best.y + 0.99) {
        // on top: a step further in so it doesn't slide back
        steer(bot, best, 0.15)
        await tick(bot)
        await tick(bot)
        return true
      }
      const dx = best.x + 0.5 - p.x
      const dz = best.z + 0.5 - p.z
      void bot.look(Math.atan2(-dx, -dz), 0, true)
      bot.setControlState('forward', true)
      bot.setControlState('jump', true)
      await tick(bot)
    }
    return false
  } finally {
    bot.clearControlStates()
  }
}
