// Mobs shooting at the bot, for every bot (bodyguard or not). The decisions are pure and tested
// (ranged-plan.ts); this file reads the world into them:
//   - a per-bot watch (installed by the combat skill) notes projectiles flying at the bot, the
//     shooter named in damage events, and who owns each arrow;
//   - rangedSituation() lists the shooters around (line of sight within 24), the patrol size and
//     whether the bot is under fire;
//   - ranged_defense (reflexes and stay_safe run it) answers by health and gear: shoot back, shield
//     up and close in, take cover behind a block (and eat there), or back out of range.
import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import { defineAction, z, ok, fail, goals, isHostile, sleep, checkAborted } from '../core/index.ts'
import { fightTarget, lineOfSight, eatNow, fightFood } from './fight.ts'
import { combatRefusal } from './combat.ts'
import { weaponFlags, hasRanged, readyShield } from './weapons.ts'
import { wornArmorPoints } from './gear.ts'
import { facingTowards } from './guard-plan.ts'
import { isShooter, incoming, patrolCount, rangedResponse, activeShooters, findCover, retreatPoint, canEatUnderFire, shooterRange, PROJECTILES, type ShooterView, type RangedDecision, type V3 } from './ranged-plan.ts'

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
}
const watches = new WeakMap<Bot, Watch>()
function watchOf (bot: Bot): Watch {
  let w = watches.get(bot)
  if (!w) watches.set(bot, w = { owners: new Map(), shotBy: new Map(), incomingAt: 0, hurtAt: 0, judged: new Set(), samples: new Map(), listeners: new Set() })
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
  const empty: RangedSituation = { shooters: [], active: [], patrol: 0, incoming: false, hurt: false, underFire: false, aimed: false }
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
  return {
    shooters,
    active,
    patrol: patrolCount(mobs, me, radius),
    incoming: inc,
    hurt,
    underFire: inc || hurt || shooters.some(s => s.hurtMe),
    aimed: shooters.some(s => s.los && s.facing && s.dist <= shooterRange(s.name))
  }
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
    maxSeconds: z.number().min(5).max(120).default(45).describe('give up after this long')
  }),
  internal: true,
  async run ({ bot, agent, signal, log }, p) {
    const flags = weaponFlags(agent)
    const until = Date.now() + p.maxSeconds * 1000
    const done: string[] = []
    let kills = 0
    let ate = 0
    let quietSince = 0
    let hideUntil = 0 // after a failed charge or a heal stop, hide for a while
    const badCover = new Set<string>() // spots that turned out to be in sight after all
    let last = ''
    const note = (d: RangedDecision) => {
      const k = `${d.act}:${d.why}`
      if (k !== last) { last = k; log.info(`ranged: ${d.act} (${d.why})`); if (!done.includes(d.act)) done.push(d.act) }
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
        // a melee mob in our face goes first (a vindicator with the patrol, a zombie)
        const face = bot.nearestEntity(e => isHostile(e) && !isShooter(e.name, (e as any).heldItem?.name) && e.position.distanceTo(bot.entity.position) <= 3 && !combatRefusal(bot, e))
        if (face) { await fightTarget(bot, face, signal, { maxMs: 6000, flags: { ...flags, maxChase: 4 } }); continue }
        const shield = !!bot.inventory.items().find(i => i.name === 'shield') || bot.inventory.slots[45]?.name === 'shield'
        const melee = bot.inventory.items().some(i => /_(sword|axe)$/.test(i.name))
        const hide = p.cover ? 'asked to take cover' : Date.now() < hideUntil ? 'the last fight went badly' : undefined
        const cover = coverFor(bot, s.active.map(x => x.e), 8, badCover)
        const d = rangedResponse({
          health: bot.health,
          hide,
          armor: wornArmorPoints(bot),
          bow: !!hasRanged(bot),
          shield,
          melee,
          shooters: s.active,
          patrol: s.patrol,
          coverNear: !!cover,
          useBow: flags.ranged,
          useShield: flags.shield
        })
        if (!d) { await sleep(200, signal); continue }
        note(d)
        const target = s.active.find(x => x.id === d.target)?.e ?? s.active[0]!.e

        if (d.act === 'shoot' || d.act === 'shield_close' || d.act === 'charge') {
          if (d.act === 'shield_close') await readyShield(bot)
          const r = await fightTarget(bot, target, signal, { maxMs: 12_000, flags: { ...flags, ranged: d.act === 'shoot' ? flags.ranged : false } })
          if (r.killed) { kills++; continue }
          if (r.end === 'heal' || r.end === 'outnumbered' || r.end === 'gave_up') hideUntil = Date.now() + 15_000
          continue
        }

        if (d.act === 'cover' && cover) {
          const goal = new goals.GoalBlock(Math.floor(cover.x), cover.y, Math.floor(cover.z))
          const got = await walk(bot, goal, signal, 8000, () => bot.health <= 0)
          if (!got) { hideUntil = Date.now() + 5000; continue }
          // behind cover: eat, raise the shield if one of them comes round, fight what walks up
          const hold = Date.now() + 15_000
          const spotKey = `${Math.floor(cover.x)},${cover.y},${Math.floor(cover.z)}`
          let held = 0
          while (Date.now() < hold) {
            checkAborted(signal)
            const h = rangedSituation(bot)
            const close = h.shooters.find(x => x.dist <= 4)
            if (close) { await fightTarget(bot, close.e, signal, { maxMs: 6000, flags: { ...flags, maxChase: 4 } }); break }
            const exposed = h.active.some(x => x.los)
            if (exposed) {
              // seen at once: the block doesn't cover us after all (the sight lines differ a little); never this spot again
              if (held === 0) badCover.add(spotKey)
              break
            }
            held++
            if (canEatUnderFire({ health: bot.health, food: bot.food, hasFood: !!fightFood(bot), exposed, incoming: h.incoming })) {
              if (await eatNow(bot, signal)) { ate++; continue }
            }
            // healthy again and they lost sight of us: done hiding
            if (!h.underFire && bot.health >= 16 && !p.cover) break
            if (!h.shooters.length) break
            await sleep(300, signal)
          }
          continue
        }

        // back off: straight away from them, out of range
        const pts = s.active.map(x => x.e.position)
        const far = Math.max(...s.active.map(x => shooterRange(x.name))) + 6
        const away = retreatPoint(bot.entity.position, pts, Math.min(28, far))
        const goal = new goals.GoalNear(away.x, away.y, away.z, 3)
        const mv = (bot.pathfinder as any).movements
        if (mv) mv.allowSprinting = true
        await walk(bot, goal, signal, 10_000, () => {
          const n = rangedSituation(bot)
          return !n.active.length && !n.incoming
        })
        done.includes('retreat') || done.push('retreat')
      }
    } finally {
      bot.pathfinder.setGoal(null)
      try { bot.deactivateItem() } catch {}
    }
    const what = [kills ? `killed ${kills}` : '', ...done.map(a => a === 'shoot' ? 'shot back' : a === 'shield_close' ? 'closed in behind the shield' : a === 'charge' ? 'charged' : a === 'cover' ? 'took cover' : 'backed out of range'), ate ? `ate ${ate}x` : ''].filter(Boolean)
    if (!what.length) return ok('nothing shooting at me')
    return ok(what.join(', '))
  }
})
