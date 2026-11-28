// Mobs shooting at the bot, for every bot (bodyguard or not). The decisions are pure and tested
// (ranged-plan.ts); this file reads the world into them:
//   - a per-bot watch (installed by the combat skill) notes projectiles flying at the bot, the
//     shooter named in damage events, and who owns each arrow;
//   - rangedSituation() lists the shooters around (line of sight within 24), the patrol size and
//     whether the bot is under fire;
//   - ranged_defense (reflexes and stay_safe run it) answers by health and gear: shoot back, shield
//     up and close in, take cover behind a block (and eat there), build cover on open ground, or
//     back out of range (at most RETREAT_CAP blocks from where the shooting started). Under heavy
//     fire (outnumbered with poor gear, or low health) only quick cover or a quick wall counts;
//     otherwise it gets out of sight (up to FLEE_CAP, towards home when that is away from them),
//     leaves a cover spot that gets it hit, and blocks arrows with a shield on the way when it has one;
//   - every shooter and patrol it deals with is remembered as a danger zone (core/danger.ts) for a
//     few minutes, so scouting and chopping don't walk back into it.
import { enchantsOf } from './enchants.ts'
import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import { defineAction, z, ok, fail, goals, isHostile, sleep, checkAborted, dangerMemory, fmtPos, type Agent } from '../core/index.ts'
import { fightTarget, lineOfSight, eatNow, fightFood, meleeNear } from './fight.ts'
import { escapeFight } from './escape.ts'
import { retreatCheck } from './retreat.ts'
import { combatRefusal } from './combat.ts'
import { weaponFlags, hasRanged, readyShield, bestMeleeDamage, blockWithShield } from './weapons.ts'
import { getHome, sameDimension } from './navigation.ts'
import { wornArmorPoints } from './gear.ts'
import { facingTowards } from './guard-plan.ts'
import type { Block } from 'prismarine-block'
import { isFiller, pillarUp } from './survival.ts'
import { placeAt, isReplaceable, digBlock } from './world.ts'
import { equipFor, toolKindFor, bestToolIn } from './toolkit.ts'
import { dodgeLayer } from './dodge.ts'
import { DODGE_DEFAULTS } from './dodgePlan.ts'
import {
  isShooter, incoming, patrolCount, rangedResponse, activeShooters, findCover, cappedRetreat, canEatUnderFire, shooterRange,
  hideMs, stillHiding, leaveCover, planWall, heavyFire, shieldWhileFleeing, gearOf, ILLAGERS, PROJECTILES, RETREAT_CAP, FLEE_CAP,
  coverCell, pickCoverBlock, feetCellY, digInRefusal, digInSeconds, holdDecision,
  type ShooterView, type RangedDecision, type RangedAct, type V3, type WallPlan, type GearView
} from './ranged-plan.ts'

const EYE = 1.62
/** How long a projectile hit or an incoming arrow keeps the bot "under fire". */
const FIRE_MS = 6000
/** Shooters further than this are ignored. */
export const RANGED_RADIUS = 24

interface Watch {
  /** Projectile entity id -> owner entity id (spawn packet data). */
  owners: Map<number, number>
  /** Shooter id -> last time it hurt the bot or shot at it. */
  shotBy: Map<number, number>
  /** Last time a projectile was on course for the bot. */
  incomingAt: number
  /** Last time the bot was hurt by a projectile or a shooter. */
  hurtAt: number
  /** Projectile ids already judged. */
  judged: Set<number>
  /** Projectile id -> last position sample, to get a velocity when the packets don't carry one. */
  samples: Map<number, { x: number, y: number, z: number, at: number }>
  listeners: Set<() => void>
  /** Where the bot was when the current spell of shooting started (the retreat cap is measured from here). */
  origin: V3 | null
  /** When ranged_defense last ended. */
  lastEnd: number
}
const watches = new WeakMap<Bot, Watch>()
function watchOf (bot: Bot): Watch {
  let w = watches.get(bot)
  if (!w) watches.set(bot, w = { owners: new Map(), shotBy: new Map(), incomingAt: 0, hurtAt: 0, judged: new Set(), samples: new Map(), listeners: new Set(), origin: null, lastEnd: 0 })
  return w
}

/** Calls `fn` whenever a projectile is found on course for the bot or the bot is hurt from range. Returns the unsubscribe. */
export function onRangedAlarm (bot: Bot, fn: () => void): () => void {
  const w = watchOf(bot)
  w.listeners.add(fn)
  return () => { w.listeners.delete(fn) }
}

const shooterOf = (bot: Bot, id: number | undefined): Entity | undefined => {
  if (id === undefined) return undefined
  const e = bot.entities[id]
  return e && e.type !== 'player' ? e : undefined
}

/** Whether a projectile entity is coming at the bot; notes it (and its shooter) if so. */
function judgeProjectile (bot: Bot, w: Watch, e: Entity, vel: V3): boolean {
  if (!bot.entity) return false
  const ownerId = w.owners.get(e.id)
  const owner = ownerId !== undefined ? bot.entities[ownerId] : undefined
  if (owner === bot.entity || owner?.type === 'player') return false // ours, or a player's (not a mob fight)
  const hit = incoming({ name: e.name, pos: e.position, vel }, bot.entity.position)
  if (!hit) return false
  w.incomingAt = Date.now()
  const shooter = owner ?? nearestShooterBehind(bot, e.position, vel)
  if (shooter) w.shotBy.set(shooter.id, Date.now())
  for (const fn of w.listeners) { try { fn() } catch {} }
  return true
}

/** The shooter a projectile most likely came from, when the spawn packet didn't say: the nearest one roughly up-range. */
function nearestShooterBehind (bot: Bot, pos: V3, vel: V3): Entity | undefined {
  const vl = Math.hypot(vel.x, vel.z) || 1
  let best: Entity | undefined
  let bestD = Infinity
  for (const e of Object.values(bot.entities)) {
    if (!e.position || !isShooter(e.name, (e as any).heldItem?.name)) continue
    const dx = e.position.x - pos.x
    const dz = e.position.z - pos.z
    const d = Math.hypot(dx, dz)
    if (d > 32) continue
    if ((dx * vel.x + dz * vel.z) / (vl * (d || 1)) > -0.7) continue // not behind the arrow
    if (d < bestD) { bestD = d; best = e }
  }
  return best
}

/** Installs the watch for one bot session. Returns the clean-up. */
export function installRangedWatch (bot: Bot): () => void {
  const w = watchOf(bot)
  const client = (bot as any)._client
  const onSpawnPacket = (p: any) => {
    // projectiles carry their owner's entity id in the spawn data (0 = none)
    if (typeof p?.objectData === 'number' && p.objectData > 0) w.owners.set(p.entityId, p.objectData)
  }
  const onSpawn = (e: Entity) => {
    if (!PROJECTILES[e.name ?? '']) return
    const v = e.velocity
    if (v && Math.hypot(v.x, v.y, v.z) > 0.15 && judgeProjectile(bot, w, e, v)) w.judged.add(e.id)
  }
  const onGone = (e: Entity) => { w.owners.delete(e.id); w.judged.delete(e.id); w.samples.delete(e.id) }
  const onHurt = (e: Entity, source?: Entity) => {
    if (e !== bot.entity) return
    const src = source && source.type !== 'player' ? source : undefined
    if (src && (isShooter(src.name, (src as any).heldItem?.name) || src.type === 'projectile')) {
      w.hurtAt = Date.now()
      w.shotBy.set(src.id, Date.now())
      for (const fn of w.listeners) { try { fn() } catch {} }
    }
  }
  // arrows in flight: velocity from position samples (relative-move packets don't update it)
  const timer = setInterval(() => {
    if (!bot.entity) return
    const me = bot.entity.position
    const now = Date.now()
    for (const e of Object.values(bot.entities)) {
      if (!PROJECTILES[e.name ?? ''] || !e.position || w.judged.has(e.id)) continue
      if (e.position.distanceTo(me) > 40) continue
      const prev = w.samples.get(e.id)
      w.samples.set(e.id, { x: e.position.x, y: e.position.y, z: e.position.z, at: now })
      if (!prev || now - prev.at < 40) continue
      const ticks = (now - prev.at) / 50
      const vel = { x: (e.position.x - prev.x) / ticks, y: (e.position.y - prev.y) / ticks, z: (e.position.z - prev.z) / ticks }
      if (judgeProjectile(bot, w, e, vel)) w.judged.add(e.id)
    }
  }, 100)
  client?.on('spawn_entity', onSpawnPacket)
  bot.on('entitySpawn', onSpawn)
  bot.on('entityGone', onGone)
  bot.on('entityHurt', onHurt as any)
  return () => {
    clearInterval(timer)
    client?.off('spawn_entity', onSpawnPacket)
    bot.off('entitySpawn', onSpawn)
    bot.off('entityGone', onGone)
    bot.off('entityHurt', onHurt as any)
  }
}

/** Notes a health drop the damage event didn't explain (it can go missing): blamed on a shooter with a line to the bot, if any. */
export function noteUnexplainedHit (bot: Bot): boolean {
  const s = rangedSituation(bot)
  const near = s.shooters.find(x => x.los && x.dist <= shooterRange(x.name) + 4)
  if (!near) return false
  const w = watchOf(bot)
  w.hurtAt = Date.now()
  w.shotBy.set(near.id, Date.now())
  return true
}

export type ShooterEntry = ShooterView & { e: Entity, facing: boolean }

export interface RangedSituation {
  /** Shooters within RANGED_RADIUS (with or without a line to the bot), nearest first. */
  shooters: ShooterEntry[]
  /** Those with a line to the bot or that just shot it. */
  active: ShooterEntry[]
  /** Pillager-patrol mobs within RANGED_RADIUS. */
  patrol: number
  /** The middle of those patrol mobs, or null when there are none. */
  patrolAt: V3 | null
  /** A projectile was on course for the bot in the last few seconds. */
  incoming: boolean
  /** Hurt from range in the last few seconds. */
  hurt: boolean
  /** Being shot at: incoming, hurt, or a shooter that shot at it recently. */
  underFire: boolean
  /** A shooter within its range with a line to the bot and looking at it: about to shoot. */
  aimed: boolean
}

/** What shoots at the bot right now. */
export function rangedSituation (bot: Bot, radius = RANGED_RADIUS): RangedSituation {
  const w = watchOf(bot)
  const now = Date.now()
  const me = bot.entity?.position
  const empty: RangedSituation = { shooters: [], active: [], patrol: 0, patrolAt: null, incoming: false, hurt: false, underFire: false, aimed: false }
  if (!me) return empty
  const shooters: ShooterEntry[] = []
  const mobs: { name: string, pos: V3 }[] = []
  for (const e of Object.values(bot.entities)) {
    if (e === bot.entity || !e.position || e.type === 'player' || e.type === 'object' || e.type === 'orb' || e.type === 'projectile') continue
    const d = e.position.distanceTo(me)
    if (d > radius) continue
    const hp = ((e as any).metadata as unknown[] | undefined)?.[9]
    if (typeof hp === 'number' && hp <= 0) continue
    mobs.push({ name: e.name ?? '', pos: e.position })
    if (!isShooter(e.name, (e as any).heldItem?.name) || !isHostile(e) || combatRefusal(bot, e)) continue
    const shot = now - (w.shotBy.get(e.id) ?? 0) < FIRE_MS * 1.5
    shooters.push({ id: e.id, name: e.name ?? 'mob', dist: d, los: lineOfSight(bot, e), hurtMe: shot, e, facing: facingTowards((e as any).headYaw ?? e.yaw, e.position, me, 0.7) })
  }
  shooters.sort((a, b) => a.dist - b.dist)
  const active = activeShooters(shooters, radius)
  const inc = now - w.incomingAt < FIRE_MS
  const hurt = now - w.hurtAt < FIRE_MS
  const ill = mobs.filter(m => ILLAGERS.has(m.name))
  return {
    shooters,
    active,
    patrol: patrolCount(mobs, me, radius),
    patrolAt: ill.length ? { x: ill.reduce((n, m) => n + m.pos.x, 0) / ill.length, y: ill.reduce((n, m) => n + m.pos.y, 0) / ill.length, z: ill.reduce((n, m) => n + m.pos.z, 0) / ill.length } : null,
    incoming: inc,
    hurt,
    underFire: inc || hurt || shooters.some(s => s.hurtMe),
    aimed: shooters.some(s => s.los && s.facing && s.dist <= shooterRange(s.name))
  }
}

/**
 * The bot's gear as gearScore reads it: armour worn, a shield (in the off hand or carried), its
 * best melee weapon, a bow or crossbow with arrows, and health. combat.ranged / combat.shield off
 * count as not having them. keep_fed reads it to decide whether a far scouting trip is worth it.
 */
export function gearNow (bot: Bot, agent?: Agent): GearView {
  const items = bot.inventory?.items?.() ?? []
  const flags = agent ? weaponFlags(agent) : { ranged: true, shield: true }
  return gearOf({
    health: typeof bot.health === 'number' ? bot.health : 20,
    armor: bot.inventory?.slots ? wornArmorPoints(bot) : 0,
    shield: items.some(i => i.name === 'shield') || bot.inventory?.slots?.[45]?.name === 'shield',
    bow: items.some(i => i.name === 'bow' || i.name === 'crossbow'),
    arrows: items.filter(i => /arrow$/.test(i.name)).reduce((n, i) => n + i.count, 0),
    melee: items.some(i => /_(sword|axe)$/.test(i.name)),
    weaponDamage: bestMeleeDamage(items.map(i => i.name)),
    useBow: flags.ranged,
    useShield: flags.shield
  })
}

// ---- cover ----

const LIQUID = /^(water|lava|bubble_column)$/
const BAD_FLOOR = /^(lava|fire|soul_fire|magma_block|campfire|soul_campfire|cactus|sweet_berry_bush|powder_snow)$/

/** The nearest spot with a block between it and every active shooter, read from the world. */
export function coverFor (bot: Bot, shooters: readonly Entity[], radius = 8, skip: ReadonlySet<string> = new Set()): (V3 & { cost: number }) | null {
  const me = bot.entity.position
  const at = (x: number, y: number, z: number) => bot.blockAt(me.clone().set(x, y, z))
  const solid = (x: number, y: number, z: number) => at(x, y, z)?.boundingBox === 'block'
  const free = (x: number, y: number, z: number) => { const b = at(x, y, z); return !!b && b.boundingBox === 'empty' && !LIQUID.test(b.name) }
  const standable = (x: number, y: number, z: number) => {
    if (skip.has(`${x},${y},${z}`)) return false
    const floor = at(x, y - 1, z)
    return !!floor && floor.boundingBox === 'block' && !BAD_FLOOR.test(floor.name) && free(x, y, z) && free(x, y + 1, z)
  }
  return findCover({
    bot: me,
    shooters: shooters.map(s => ({ x: s.position.x, y: s.position.y + (s.height ?? 1.8) * 0.85, z: s.position.z })),
    solid,
    standable,
    radius
  })
}

// ---- building cover ----

const shooterEyes = (shooters: readonly Entity[]) => shooters.map(s => ({ x: s.position.x, y: s.position.y + (s.height ?? 1.8) * 0.85, z: s.position.z }))

/** Snow layers in a block (1 for anything else). */
const layersOf = (b: Block | null | undefined): number => {
  if (b?.name !== 'snow') return 1
  const l = Number((b.getProperties?.() as { layers?: number } | undefined)?.layers)
  return Number.isFinite(l) && l > 0 ? l : 1
}

/** The filler to build cover with: cobblestone or dirt before logs and planks (pickCoverBlock). */
export function coverBlock (bot: Bot): string | null {
  return pickCoverBlock(bot.inventory.items().filter(i => isFiller(i.name)).map(i => ({ name: i.name, count: i.count })))
}

/**
 * Where to put blocks for cover where the bot stands (planWall), or null: needs block placing
 * allowed (settings.canPlace), a filler block in the inventory (cobblestone, dirt, planks, logs...)
 * and cells outside protected areas. Snow layers, grass and ferns are cells it places into, never
 * blocks it places against; deeper snow (2+ layers) only when it may dig it out first. `feet`
 * plans from another spot (the bottom of a hole it is about to dig), `gone` is a cell taken as
 * empty there.
 */
export function coverWallFor (bot: Bot, agent: Agent, shooters: readonly Entity[], opts: { feet?: V3, gone?: V3, maxPillar?: number, maxBlocks?: number } = {}): (WallPlan & { block: string }) | null {
  if ((agent.settings as { canPlace?: boolean } | undefined)?.canPlace === false) return null
  const block = coverBlock(bot)
  if (!block) return null
  const me = bot.entity.position
  const isGone = (x: number, y: number, z: number) => !!opts.gone && opts.gone.x === x && opts.gone.y === y && opts.gone.z === z
  const at = (x: number, y: number, z: number) => bot.blockAt(me.clone().set(x, y, z))
  const solid = (x: number, y: number, z: number) => !isGone(x, y, z) && at(x, y, z)?.boundingBox === 'block'
  const placeable = (x: number, y: number, z: number) => {
    if (isGone(x, y, z)) return false
    const b = at(x, y, z)
    if (!b || agent.protectedAreas?.isProtected({ x, y, z })) return false
    return !!coverCell({ name: b.name, replaceable: isReplaceable(b.name), layers: layersOf(b), canDig: agent.canDig })
  }
  const count = bot.inventory.items().filter(i => i.name === block).reduce((n, i) => n + i.count, 0)
  const feet = opts.feet ?? { x: me.x, y: feetCellY(me.y), z: me.z }
  const plan = planWall({ bot: feet, shooters: shooterEyes(shooters), solid, placeable, maxBlocks: Math.min(opts.maxBlocks ?? 6, count), maxPillar: opts.maxPillar })
  return plan ? { ...plan, block } : null
}

/** Stops walking and waits (briefly) until it stands still on the ground, so a plan made now still fits. */
async function settle (bot: Bot, signal: AbortSignal, ms = 800): Promise<void> {
  bot.pathfinder.setGoal(null)
  bot.clearControlStates()
  const until = Date.now() + ms
  while (Date.now() < until) {
    const v = bot.entity.velocity
    if (bot.entity.onGround && Math.hypot(v.x, v.z) < 0.03) return
    await sleep(50, signal)
  }
}

/** Digs deep snow (2+ layers) out of a cell so a block can go there; true when the cell takes a block now. */
async function clearSnow (bot: Bot, agent: Agent, x: number, y: number, z: number, signal: AbortSignal): Promise<boolean> {
  const b = bot.blockAt(bot.entity.position.clone().set(x, y, z))
  if (!b || b.name !== 'snow' || layersOf(b) <= 1) return true
  if (!agent.canDig || agent.protectedAreas?.isProtected({ x, y, z })) return false
  await equipFor(bot, b)
  await digBlock(bot, b, signal)
  return isReplaceable(bot.blockAt(b.position)?.name)
}

/**
 * Places a wall plan's blocks (pillar first). Returns how many went in and, when it stopped early,
 * why. It has to be standing still where the plan was made (the caller settles and plans again).
 */
async function buildWall (bot: Bot, agent: Agent, plan: WallPlan & { block: string }, signal: AbortSignal): Promise<{ placed: number, why?: string }> {
  bot.pathfinder.setGoal(null)
  bot.clearControlStates()
  let placed = 0
  if (plan.pillar) {
    const f = plan.blocks[0]!
    if (!await clearSnow(bot, agent, f.x, f.y, f.z, signal)) return { placed, why: 'deep snow under the feet' }
    let why = ''
    const up = await pillarUp(bot, signal, plan.block, plan.pillar, w => { why = w })
    placed += up
    if (up < plan.pillar) return { placed, why: why || 'the pillar stopped' }
  }
  for (const c of plan.blocks.slice(plan.pillar)) {
    checkAborted(signal)
    try {
      if (!await clearSnow(bot, agent, c.x, c.y, c.z, signal)) return { placed, why: `deep snow at ${c.x} ${c.y} ${c.z}` }
      await placeAt(bot, plan.block, bot.entity.position.clone().set(c.x, c.y, c.z), signal)
      placed++
    } catch (e) {
      checkAborted(signal)
      return { placed, why: `${c.x} ${c.y} ${c.z}: ${(e as Error).message}` }
    }
  }
  return { placed }
}

// ---- digging in ----

/** How long digging a block takes with the best tool it carries (ms), or null when it can't be dug. */
function digMsFor (bot: Bot, b: Block): number | null {
  if (b.diggable === false) return null
  const items = bot.inventory.items()
  const kind = toolKindFor(b as any)
  const name = kind ? bestToolIn(items.map(i => i.name), kind) : null
  const tool = name ? items.find(i => i.name === name) : bot.heldItem
  try {
    const ms = b.digTime(tool?.type ?? null, bot.game?.gameMode === 'creative', false, false, enchantsOf(tool), [])
    return Number.isFinite(ms) ? ms : null
  } catch { return null }
}

export interface DigIn { floor: Block, seconds: number, wall: (WallPlan & { block: string }) | null }

/**
 * Digging in where it stands: the block under its feet comes out and it stands in the hole, with
 * the blocks around the hole (if any) that it still needs against the shooters (coverWallFor from
 * the bottom of the hole). Null when digging is off, the floor is unsafe or protected
 * (digInRefusal), or the hole wouldn't cover it.
 */
export function digInFor (bot: Bot, agent: Agent, shooters: readonly Entity[]): DigIn | null {
  if (!bot.entity.onGround) return null
  const me = bot.entity.position
  const fy = feetCellY(me.y)
  const at = (dx: number, y: number, dz: number) => bot.blockAt(me.clone().set(Math.floor(me.x) + dx, y, Math.floor(me.z) + dz))
  const floor = at(0, fy - 1, 0)
  const below = at(0, fy - 2, 0)
  if (!floor) return null
  const refusal = digInRefusal({
    canDig: agent.canDig,
    floor: floor.name,
    floorSolid: floor.boundingBox === 'block',
    below: below?.name,
    belowSolid: below?.boundingBox === 'block',
    sides: [at(1, fy - 1, 0), at(-1, fy - 1, 0), at(0, fy - 1, 1), at(0, fy - 1, -1)].map(b => b?.name),
    feet: at(0, fy, 0)?.name,
    digMs: digMsFor(bot, floor),
    protected: !!agent.protectedAreas?.isProtected(floor.position)
  })
  if (refusal) return null
  const feet = { x: Math.floor(me.x) + 0.5, y: fy - 1, z: Math.floor(me.z) + 0.5 }
  const gone = { x: floor.position.x, y: floor.position.y, z: floor.position.z }
  const wall = coverWallFor(bot, agent, shooters, { feet, gone, maxPillar: 0, maxBlocks: 4 })
  if (!wall) {
    // no blocks to place: only when the hole alone covers head and chest
    const solid = (x: number, y: number, z: number) => !(x === gone.x && y === gone.y && z === gone.z) && bot.blockAt(me.clone().set(x, y, z))?.boundingBox === 'block'
    const bare = planWall({ bot: feet, shooters: shooterEyes(shooters), solid, placeable: () => false, maxPillar: 0 })
    if (!bare || bare.blocks.length) return null
  }
  return { floor, seconds: digInSeconds(digMsFor(bot, floor) ?? 0, wall?.blocks.length ?? 0), wall: wall && wall.blocks.length ? wall : null }
}

/** Notes the shooters (and the patrol) around as danger zones for the bot's other jobs. */
function rememberShooters (agent: Agent, s: RangedSituation): void {
  const mem = dangerMemory(agent)
  for (const x of s.active) {
    const p = x.e.position
    mem.remember({ x: p.x, y: p.y, z: p.z, kind: x.name, radius: shooterRange(x.name) + 8 })
  }
  if (s.patrol >= 3 && s.patrolAt) mem.remember({ ...s.patrolAt, kind: 'patrol', radius: 32, count: s.patrol })
}

// ---- the action ----

/** Pathfinder walk that can be watched: resolves on arrival, timeout or `stop()` turning true. */
async function walk (bot: Bot, goal: any, signal: AbortSignal, ms: number, stop: () => boolean): Promise<boolean> {
  bot.pathfinder.setGoal(goal, true)
  try {
    const until = Date.now() + ms
    while (Date.now() < until) {
      checkAborted(signal)
      if (goal.isEnd?.(bot.entity.position.floored())) return true
      if (stop()) return false
      await sleep(150, signal)
    }
    return false
  } finally { bot.pathfinder.setGoal(null) }
}

export const rangedDefense = defineAction({
  name: 'ranged_defense',
  description: 'Deal with mobs shooting at the bot (skeletons, strays, bogged, pillagers, witches, blazes, ghasts, drowned with tridents): ' +
    'shoot back with a bow or crossbow, raise a shield and close in, take cover behind a block (and eat there), or back out of range, ' +
    'depending on health, gear and how many there are. Used by the reflexes and stay_safe.',
  params: z.object({
    cover: z.boolean().default(false).describe('hide or back off instead of fighting, whatever the gear'),
    build: z.boolean().default(true).describe('on open ground, place a few blocks (cobblestone, dirt, planks) for cover when there is none to walk to'),
    digIn: z.boolean().default(true).describe('when digging is allowed, dig the block under its feet and stand in the hole (plus a block or two toward the shooters) when that is the quickest way out of sight'),
    commitSeconds: z.number().min(0).max(10).default(2).describe('keep a way of hiding (cover, wall, digging in, backing off) at least this long before switching to another, so it does not flap between them'),
    maxSeconds: z.number().min(5).max(120).default(45).describe('give up after this long')
  }),
  internal: true,
  async run (ctx, p) {
    const { bot, agent, signal, log } = ctx
    let escapes = 0
    const flags = weaponFlags(agent)
    // arrow and draw leaps while walking to cover or backing off (combat.dodge.*); fightTarget has its own
    const dodge = dodgeLayer(bot, flags.dodge ?? DODGE_DEFAULTS)
    let dodgeDue = false
    const dodgeStop = () => { dodgeDue = dodge.wants(); return dodgeDue }
    const w = watchOf(bot)
    const until = Date.now() + p.maxSeconds * 1000
    // the retreat cap counts from where this spell of shooting started (a run that ended a minute ago counts as the same)
    if (!w.origin || Date.now() - w.lastEnd > 60_000) w.origin = { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z }
    const origin = w.origin
    const done: string[] = []
    let kills = 0
    let ate = 0
    let built = 0
    let dug = 0
    let quietSince = 0
    let hideUntil = 0 // after a failed charge or a heal stop, hide for a while (hideMs by health)
    const badCover = new Set<string>() // spots that turned out to be in sight after all
    let buildFailed = 0 // a wall that didn't cover (or couldn't be placed): don't try again at once
    let digFailed = 0 // the same for digging in
    let lastBlock = 0 // last shield block while backing off
    let blocked = 0
    let last = ''
    let lastAt = 0
    let prev: { d: RangedDecision, at: number } | null = null
    // one line per change of plan (and a reminder every 5 s), not one per pass with a new distance in it
    const note = (d: RangedDecision) => {
      if (d.act !== last || Date.now() - lastAt > 5000) { last = d.act; lastAt = Date.now(); log.info(`ranged: ${d.act} (${d.why})`) }
      if (!done.includes(d.act)) done.push(d.act)
    }
    // behind cover (found or built): eat, fight what walks up, leave when healthy and out of sight
    const holdCover = async (spotKey: string): Promise<'left' | 'exposed' | 'fought'> => {
      const t0 = Date.now()
      let held = 0
      let hp = bot.health
      while (true) {
        checkAborted(signal)
        // hurt from range while behind it: the cover doesn't hold (a flank, arrows over the top); never this spot again
        if (bot.health < hp - 1 && Date.now() - w.hurtAt < 1000) {
          badCover.add(spotKey)
          log.debug(`ranged: hit behind cover at health ${Math.ceil(bot.health)}, leaving it`)
          return 'exposed'
        }
        hp = Math.max(hp, bot.health)
        const h = rangedSituation(bot)
        const close = h.shooters.find(x => x.dist <= 4)
        if (close) { await fightTarget(bot, close.e, signal, { maxMs: 6000, flags: { ...flags, maxChase: 4 } }); return 'fought' }
        const seen = h.active.some(x => x.los)
        if (seen) {
          // seen at once: the block doesn't cover us after all (the sight lines differ a little); never this spot again
          if (held === 0) badCover.add(spotKey)
          return 'exposed'
        }
        held++
        if (h.active.length) rememberShooters(agent, h)
        if (canEatUnderFire({ health: bot.health, food: bot.food, hasFood: !!fightFood(bot), exposed: seen, incoming: h.incoming })) {
          if (await eatNow(bot, signal)) { ate++; continue }
        }
        if (leaveCover({ health: bot.health, heldMs: Date.now() - t0, seen, shooters: h.shooters.length, underFire: h.underFire })) {
          log.debug(`ranged: leaving cover after ${Math.round((Date.now() - t0) / 1000)}s at health ${Math.ceil(bot.health)}`)
          return 'left'
        }
        await sleep(300, signal)
      }
    }
    try {
      while (Date.now() < until) {
        checkAborted(signal)
        // every pass yields to the event loop: a fight or walk that ends at once (a spot it already
        // stands on, a target already gone) must not spin here and starve the connection
        await sleep(50, signal)
        if (bot.health <= 0) return fail('died under fire')
        const s = rangedSituation(bot)
        if (!s.active.length && !s.incoming) {
          // nobody has a line to us: eat if it helps, and stop after 2 quiet seconds
          if (!quietSince) quietSince = Date.now()
          if (canEatUnderFire({ health: bot.health, food: bot.food, hasFood: !!fightFood(bot), exposed: false, incoming: false }) && bot.health < 16) {
            if (await eatNow(bot, signal)) { ate++; continue }
          }
          if (Date.now() - quietSince > 2000) break
          await sleep(250, signal)
          continue
        }
        quietSince = 0
        // losing with a melee mob on it as well: cover and walls don't stop a zombie, take an escape route (retreat.ts)
        if (flags.retreat?.enabled && escapes < flags.retreat.maxEscapes && meleeNear(bot, 4) > 0) {
          const why = retreatCheck(bot, flags.retreat, flags.disengageToHeal ?? true)
          if (why) {
            escapes++
            const e = await escapeFight(ctx, why, flags.retreat)
            log.info(`ranged: ${e.note}`)
            if (e.ok) continue
          }
        }
        rememberShooters(agent, s)
        // a melee mob in our face goes first (a vindicator with the patrol, a zombie)
        const face = bot.nearestEntity(e => isHostile(e) && !isShooter(e.name, (e as any).heldItem?.name) && e.position.distanceTo(bot.entity.position) <= 3 && !combatRefusal(bot, e))
        if (face) { await fightTarget(bot, face, signal, { maxMs: 6000, flags: { ...flags, maxChase: 4 } }); continue }
        const items = bot.inventory.items()
        const shield = !!items.find(i => i.name === 'shield') || bot.inventory.slots[45]?.name === 'shield'
        const melee = items.some(i => /_(sword|axe)$/.test(i.name))
        const arrows = items.filter(i => /arrow$/.test(i.name)).reduce((n, i) => n + i.count, 0)
        const seen = s.active.some(x => x.los)
        const hide = p.cover ? 'asked to take cover' : stillHiding({ until: hideUntil, now: Date.now(), health: bot.health, seen }) ? 'the last fight went badly' : undefined
        const ents = s.active.map(x => x.e)
        // cover over distance: the near spots first, then further ones before running off
        let cover = coverFor(bot, ents, 8, badCover)
        const here = bot.entity.position
        const gear = {
          health: bot.health,
          armor: wornArmorPoints(bot),
          bow: !!hasRanged(bot),
          arrows,
          shield,
          melee,
          weaponDamage: bestMeleeDamage(items.map(i => i.name)),
          shooters: s.active,
          patrol: s.patrol,
          useBow: flags.ranged,
          useShield: flags.shield
        }
        // heavy fire: get well out of sight (further than the usual cap); backing off heads home when that is away from them
        const heavy = heavyFire(gear)
        const home = getHome(agent)
        const safe = home && sameDimension(bot, home) ? home : null
        const shotAt = ents.map(e => e.position)
        const away = cappedRetreat(origin, here, shotAt, Math.min(28, Math.max(...s.active.map(x => shooterRange(x.name))) + 6), heavy ? FLEE_CAP : RETREAT_CAP, safe)
        const homeward = !!(away && safe && Math.hypot(safe.x - here.x, safe.z - here.z) >= 6 &&
          Math.hypot(away.x - safe.x, away.z - safe.z) < Math.hypot(here.x - safe.x, here.z - safe.z) - 1)
        // a wall (and a hole) is planned even with cover in reach: under heavy fire a far spot loses to a quick wall
        const wall = p.build && Date.now() > buildFailed && (!cover || heavy) ? coverWallFor(bot, agent, ents) : null
        const dig = p.digIn && agent.canDig && Date.now() > digFailed && (!cover || heavy) ? digInFor(bot, agent, ents) : null
        if (!cover && !wall && !dig) cover = coverFor(bot, ents, 14, badCover)
        const fresh = rangedResponse({
          ...gear,
          hide,
          coverNear: !!cover,
          coverDist: cover ? Math.hypot(cover.x - here.x, cover.z - here.z) + Math.abs(cover.y - here.y) : undefined,
          canBuild: !!wall,
          wallBlocks: wall?.blocks.length,
          wallPillar: wall?.pillar,
          digInSeconds: dig?.seconds,
          canRetreat: !!away,
          home: homeward
        })
        if (!fresh) { await sleep(200, signal); continue }
        const possible = (a: RangedAct) => a === 'cover' ? !!cover : a === 'build' ? !!wall : a === 'dig_in' ? !!dig : a === 'retreat' ? !!away : true
        const d = holdDecision(prev, fresh, Date.now(), possible, p.commitSeconds * 1000)
        if (!prev || prev.d.act !== d.act) prev = { d, at: Date.now() }
        note(d)
        const target = s.active.find(x => x.id === d.target)?.e ?? s.active[0]!.e

        if (d.act === 'shoot' || d.act === 'shield_close' || d.act === 'charge') {
          if (d.act === 'shield_close') await readyShield(bot)
          const r = await fightTarget(bot, target, signal, { maxMs: 12_000, flags: { ...flags, ranged: d.act === 'shoot' ? flags.ranged : false } })
          if (r.killed) {
            kills++
            // the only one there: its zone goes with it
            if (!rangedSituation(bot).active.length) dangerMemory(agent).clearNear(target.position, 8, target.name)
            continue
          }
          // losing with melee mobs on it too (zombies while it charged a skeleton): cover won't help, leave by an escape route
          const rs = flags.retreat
          if ((r.end === 'heal' || r.end === 'outnumbered') && rs?.enabled && escapes < rs.maxEscapes && meleeNear(bot, 4) > 0) {
            escapes++
            const e = await escapeFight(ctx, r.reason ?? r.end, rs)
            log.info(`ranged: ${e.note}`)
            if (e.ok) continue
          }
          if (r.end === 'heal' || r.end === 'outnumbered' || r.end === 'gave_up') hideUntil = Date.now() + hideMs(bot.health)
          continue
        }

        if (d.act === 'cover' && cover) {
          const goal = new goals.GoalBlock(Math.floor(cover.x), cover.y, Math.floor(cover.z))
          dodgeDue = false
          const got = await walk(bot, goal, signal, 8000, () => bot.health <= 0 || dodgeStop())
          if (dodgeDue) { await dodge.tick(target, signal, { rangedOnly: true }); continue }
          if (!got) { hideUntil = Date.now() + hideMs(bot.health); continue }
          await holdCover(`${Math.floor(cover.x)},${cover.y},${Math.floor(cover.z)}`)
          continue
        }

        if (d.act === 'build' && wall) {
          // stand still first (it may still be sliding from a sprint, on ice, or knocked back), then plan again from there
          await settle(bot, signal)
          const plan = coverWallFor(bot, agent, s.active.map(x => x.e))
          if (!plan) { log.info('ranged: no wall fits where it stopped'); buildFailed = Date.now() + 3000; continue }
          const names = [...new Set(s.active.map(x => x.name))].join(' and ')
          log.info(`ranged: building cover at ${fmtPos(bot.entity.position)}: ${plan.blocks.length - plan.pillar} ${plan.block}${plan.pillar ? ` on a ${plan.pillar}-block pillar` : ''} against the ${names}`)
          const r = await buildWall(bot, agent, plan, signal)
          built += r.placed
          if (r.placed < plan.blocks.length) { log.info(`ranged: placed ${r.placed} of ${plan.blocks.length} blocks, giving up on building here (${r.why ?? 'unknown'})`); buildFailed = Date.now() + 10_000; continue }
          const f = bot.entity.position.floored()
          const held = await holdCover(`${f.x},${f.y},${f.z}`)
          if (held === 'exposed') buildFailed = Date.now() + 10_000
          continue
        }

        if (d.act === 'dig_in' && dig) {
          await settle(bot, signal)
          const now = digInFor(bot, agent, s.active.map(x => x.e))
          if (!now) { digFailed = Date.now() + 3000; continue }
          log.info(`ranged: digging in at ${fmtPos(bot.entity.position)}: ${now.floor.name} out from under it${now.wall ? `, then ${now.wall.blocks.length} ${now.wall.block}` : ''}`)
          try {
            await equipFor(bot, now.floor)
            await digBlock(bot, now.floor, signal)
          } catch (e) {
            checkAborted(signal)
            log.info(`ranged: could not dig in (${(e as Error).message})`)
            digFailed = Date.now() + 10_000
            continue
          }
          await sleep(150, signal) // let it start dropping into the hole
          await settle(bot, signal)
          dug++
          // plan the blocks again from the bottom of the hole
          const plan = now.wall ? coverWallFor(bot, agent, s.active.map(x => x.e), { maxPillar: 0, maxBlocks: 4 }) : null
          if (plan && plan.blocks.length) {
            const r = await buildWall(bot, agent, plan, signal)
            built += r.placed
            if (r.placed < plan.blocks.length) log.info(`ranged: placed ${r.placed} of ${plan.blocks.length} blocks around the hole (${r.why ?? 'unknown'})`)
          }
          const f = bot.entity.position.floored()
          const held = await holdCover(`${f.x},${f.y},${f.z}`)
          if (held === 'exposed') digFailed = Date.now() + 10_000
          continue
        }

        // back off: straight away from them, out of range, but not past the cap (with nothing to fight
        // or hide with, a few more blocks beyond it rather than standing in the open)
        const run = away ?? cappedRetreat(origin, here, shotAt, 8, (heavy ? FLEE_CAP : RETREAT_CAP) + 16, safe)
        if (!run) { await sleep(300, signal); continue }
        const goal = new goals.GoalNear(run.x, run.y, run.z, 3)
        const mv = (bot.pathfinder as any).movements
        if (mv) mv.allowSprinting = true
        let block = false
        dodgeDue = false
        await walk(bot, goal, signal, 10_000, () => {
          if (dodgeStop()) return true
          const n = rangedSituation(bot)
          if (!n.active.length && !n.incoming) return true
          // a shield: a moment's block against an arrow on its way (it faces one way, so only when few shoot or it is hurt)
          block = shieldWhileFleeing({ shield, incoming: Date.now() - w.incomingAt < 400, sinceBlockMs: Date.now() - lastBlock, health: bot.health, shooters: n.active.length })
          return block
        })
        if (dodgeDue) await dodge.tick(rangedSituation(bot).active[0]?.e ?? null, signal, { rangedOnly: true })
        if (block) {
          lastBlock = Date.now()
          const near = rangedSituation(bot).active[0]?.e
          if (near) {
            await bot.lookAt(near.position.offset(0, (near.height ?? 1.8) * 0.85, 0), true).catch(() => {})
            if (await blockWithShield(bot, 600)) blocked++
          }
        }
        done.includes('retreat') || done.push('retreat')
      }
    } finally {
      w.lastEnd = Date.now()
      bot.pathfinder.setGoal(null)
      try { bot.deactivateItem() } catch {}
    }
    const what = [kills ? `killed ${kills}` : '', ...done.map(a => a === 'shoot' ? 'shot back' : a === 'shield_close' ? 'closed in behind the shield' : a === 'charge' ? 'charged' : a === 'cover' ? 'took cover' : a === 'build' ? `built cover (${built} blocks)` : a === 'dig_in' ? `dug in${dug > 1 ? ` ${dug}x` : ''}` : 'backed out of range'), blocked ? `blocked ${blocked}x with the shield` : '', ate ? `ate ${ate}x` : '', dodge.delta().dodges ? `dodged ${dodge.delta().dodges}x` : ''].filter(Boolean)
    if (!what.length) return ok('nothing shooting at me')
    return ok(what.join(', '))
  }
})
