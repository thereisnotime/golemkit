// The dodge layer: Mineflayer glue around dodgePlan.ts. A per-bot watch notes what the planners
// need (melee mobs' swings and the hits they land, archers drawing a bow or holding a charged
// crossbow, projectiles in flight moved forward with their own physics), and dodgeLayer() gives
// the fight loop one call per tick (tick) plus the creeper leap. It only moves the bot: when to
// fight, flee or heal stays with fight.ts / tactics.ts.
import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import { sleep, checkAborted, isHostile, FLYING, createLogger } from '../core/index.ts'
import { isRangedMob } from './weapons.ts'
import {
  planDodge, DODGE_TECHNIQUES, landingProblem, cellOf, unit, yawOf, advanceProjectile, meleeCooldownMs, PROJECTILE_PHYSICS, BOW_USERS, TICK_MS,
  type DodgeSettings, type DodgeView, type DodgeIntent, type ProjectileView, type ArcherView, type AttackerView, type V2, type Cell
} from './dodgePlan.ts'

const EYE = 1.62
/** How long after an arrow dodge a projectile hit still counts against it. */
const DODGE_JUDGE_MS = 1200
/** Projectiles older than this are taken to be lying in the ground. */
const PROJECTILE_MAX_MS = 3000

export interface DodgeStats {
  /** Leaps of any kind (arrows, draws, melee, creepers). */
  dodges: number
  /** Leaps against an arrow or a draw. */
  arrowDodges: number
  /** Of those, the ones not followed by a projectile hit within 1.2 s. */
  arrowsDodged: number
  /** Projectile hits taken. */
  arrowHits: number
  /** Times it stepped back before a melee mob's swing (no leap needed). */
  meleeSteps: number
  creeperLeaps: number
}

interface Tracked { pos: { x: number, y: number, z: number }, vel: { x: number, y: number, z: number }, at: number, born: number, owner?: number }

interface Watch {
  swings: Map<number, number>
  drawStart: Map<number, number>
  charging: Map<number, boolean>
  chargedAt: Map<number, number>
  projectiles: Map<number, Tracked>
  stats: DodgeStats
  /** Arrow dodges waiting to be judged: time of the leap. */
  pending: number[]
  lastProjectileHit: number
  handled: Set<string>
  lastSides: number[]
  lastLeap: number
}

const watches = new WeakMap<Bot, Watch>()

/** Cumulative dodge counters for this bot session (benches read these). */
export function dodgeStats (bot: Bot): DodgeStats {
  return { ...watchOf(bot).stats }
}

function watchOf (bot: Bot): Watch {
  let w = watches.get(bot)
  if (w) return w
  w = {
    swings: new Map(), drawStart: new Map(), charging: new Map(), chargedAt: new Map(), projectiles: new Map(),
    stats: { dodges: 0, arrowDodges: 0, arrowsDodged: 0, arrowHits: 0, meleeSteps: 0, creeperLeaps: 0 },
    pending: [], lastProjectileHit: 0, handled: new Set(), lastSides: [], lastLeap: 0
  }
  watches.set(bot, w)
  install(bot, w)
  return w
}

const meleeMob = (e: Entity) => isHostile(e) && !FLYING.has(e.name ?? '') && !isRangedMob(e.name) && e.name !== 'creeper'

function install (bot: Bot, w: Watch): void {
  const client = (bot as any)._client
  const owners = new Map<number, number>()
  client?.on('spawn_entity', (p: any) => { if (typeof p?.objectData === 'number' && p.objectData > 0) owners.set(p.entityId, p.objectData) })
  client?.on('entity_velocity', (p: any) => {
    const t = w.projectiles.get(p.entityId)
    if (t && p.velocity) { t.vel = { x: p.velocity.x / 8000, y: p.velocity.y / 8000, z: p.velocity.z / 8000 } }
  })
  bot.on('entitySpawn', (e: Entity) => {
    if (!PROJECTILE_PHYSICS[e.name ?? ''] || !e.position) return
    const now = Date.now()
    const owner = owners.get(e.id)
    w.projectiles.set(e.id, { pos: e.position.clone(), vel: e.velocity.clone(), at: now, born: now, owner })
    // a pillager that shot has an empty crossbow again
    if (owner !== undefined) w.chargedAt.delete(owner)
  })
  bot.on('entityMoved', (e: Entity) => {
    const t = w.projectiles.get(e.id)
    if (!t) return
    const now = Date.now()
    const adv = advanceProjectile({ id: e.id, name: e.name ?? 'arrow', pos: t.pos, vel: t.vel }, (now - t.at) / TICK_MS)
    t.pos = e.position.clone()
    t.vel = adv.vel
    t.at = now
  })
  bot.on('entityGone', (e: Entity) => {
    w.projectiles.delete(e.id); w.swings.delete(e.id); w.drawStart.delete(e.id); w.charging.delete(e.id); w.chargedAt.delete(e.id); owners.delete(e.id)
  })
  bot.on('entitySwingArm', (e: Entity) => {
    if (e !== bot.entity && bot.entity && meleeMob(e) && e.position.distanceTo(bot.entity.position) < 5) w.swings.set(e.id, Date.now())
  })
  bot.on('entityUpdate', (e: Entity) => {
    const md = (e as any).metadata as unknown[] | undefined
    if (!md) return
    if (BOW_USERS.has(e.name ?? '')) {
      const active = typeof md[8] === 'number' && ((md[8] as number) & 1) === 1
      if (active && !w.drawStart.has(e.id)) w.drawStart.set(e.id, Date.now())
      else if (!active) w.drawStart.delete(e.id)
    } else if (e.name === 'pillager') {
      const charging = md[17] === true
      const was = w.charging.get(e.id) ?? false
      if (was && !charging) w.chargedAt.set(e.id, Date.now())
      if (charging) w.chargedAt.delete(e.id)
      w.charging.set(e.id, charging)
    }
  })
  bot.on('entityHurt', ((e: Entity, source?: Entity) => {
    if (e !== bot.entity) return
    const now = Date.now()
    const me = bot.entity.position
    const projectile = source && (PROJECTILE_PHYSICS[source.name ?? ''] || source.type === 'projectile' || (isRangedMob(source.name) && source.position.distanceTo(me) > 3))
    if (projectile) { w.lastProjectileHit = now; w.stats.arrowHits++; return }
    // a melee hit: the attacker's cooldown starts now (unless its swing was already seen)
    const by = source && meleeMob(source) ? source : bot.nearestEntity(x => meleeMob(x) && x.position.distanceTo(me) < 3.5)
    if (by && now - (w.swings.get(by.id) ?? 0) > 250) w.swings.set(by.id, now)
  }) as any)
}

/** Whole-block cell at integer coordinates. */
function lookCell (bot: Bot): (x: number, y: number, z: number) => Cell {
  const p = bot.entity.position.clone()
  return (x, y, z) => {
    const b = bot.blockAt(p.set(x, y, z))
    return b ? cellOf(b.name, b.boundingBox === 'block') : 'unknown'
  }
}

function los (bot: Bot, e: Entity): boolean {
  try {
    const from = bot.entity.position.offset(0, EYE, 0)
    const to = e.position.offset(0, (e.height ?? 1.8) * 0.85, 0)
    const d = to.minus(from)
    return !(bot.world as any).raycast(from, d.normalize(), d.norm())
  } catch { return true }
}

export interface DodgeLayer {
  /**
   * One tick: a leap (done before it returns, 'leapt'), 'back' (step back this tick), 'hold'
   * (don't back off: every close melee mob is recharging) or null (move as usual).
   */
  tick: (target: Entity | null, signal: AbortSignal, opts?: { rangedOnly?: boolean }) => Promise<'leapt' | 'back' | 'hold' | null>
  /** Whether an arrow or draw leap is due now (cheap enough for a walk's stop check): stop walking, then call tick. */
  wants: () => boolean
  /** Sprint-jumps away from a lit creeper. False when no direction is safe (walk instead). */
  creeperLeap: (creeper: Entity, signal: AbortSignal, lit: () => boolean) => Promise<boolean>
  /** Counters since this layer was made. */
  delta: () => DodgeStats
  settings: DodgeSettings
}

/** The dodge layer for one fight. All calls are no-ops when settings.enabled is off. */
export function dodgeLayer (bot: Bot, s: DodgeSettings, rnd: () => number = Math.random): DodgeLayer {
  const w = watchOf(bot)
  const log = createLogger(`${bot.username}/dodge`)
  const rangedTechniques = DODGE_TECHNIQUES.filter(t => t.ranged)
  const base = { ...w.stats }
  let stepping = false
  const judge = () => {
    const now = Date.now()
    while (w.pending.length && now - w.pending[0]! > DODGE_JUDGE_MS) {
      const at = w.pending.shift()!
      if (!(w.lastProjectileHit > at && w.lastProjectileHit - at <= DODGE_JUDGE_MS)) w.stats.arrowsDodged++
    }
  }

  const safe = (dir: V2, dist = s.leapDistance) => {
    if (!bot.entity) return false
    return landingProblem(lookCell(bot), bot.entity.position, dir, dist, s.maxDrop) === null
  }
  const crowd = (dir: V2) => {
    const me = bot.entity.position
    const u = unit(dir)
    const lx = me.x + u.x * s.leapDistance * 0.7
    const lz = me.z + u.z * s.leapDistance * 0.7
    let n = 0
    for (const e of Object.values(bot.entities)) {
      if (e === bot.entity || !isHostile(e)) continue
      if (Math.hypot(e.position.x - lx, e.position.z - lz) < 2 && Math.abs(e.position.y - me.y) < 3) n++
    }
    return n
  }

  const view = (): DodgeView => {
    const now = Date.now()
    const me = bot.entity.position
    const projectiles: ProjectileView[] = []
    for (const [id, t] of w.projectiles) {
      if (now - t.born > PROJECTILE_MAX_MS) { w.projectiles.delete(id); continue }
      if (t.owner === bot.entity.id) continue
      const p = advanceProjectile({ id, name: bot.entities[id]?.name ?? 'arrow', pos: t.pos, vel: t.vel }, (now - t.at) / TICK_MS)
      if (Math.hypot(p.pos.x - me.x, p.pos.z - me.z) > 48) continue
      projectiles.push(p)
    }
    const archers: ArcherView[] = []
    const attackers: AttackerView[] = []
    for (const e of Object.values(bot.entities)) {
      if (e === bot.entity || !e.position || !isHostile(e)) continue
      const d = e.position.distanceTo(me)
      if ((BOW_USERS.has(e.name ?? '') || e.name === 'pillager') && d <= Math.max(s.drawRange, 4)) {
        const ds = w.drawStart.get(e.id)
        const ch = w.chargedAt.get(e.id)
        if (ds !== undefined || ch !== undefined) {
          archers.push({ id: e.id, name: e.name!, pos: e.position, dist: d, los: los(bot, e), drawingMs: ds !== undefined ? now - ds : null, chargedMs: ch !== undefined ? now - ch : null })
        }
      } else if (meleeMob(e) && d < 5) {
        const sw = w.swings.get(e.id)
        attackers.push({
          id: e.id, name: e.name ?? '', dx: e.position.x - me.x, dz: e.position.z - me.z, dy: e.position.y - me.y,
          width: e.width ?? 0.6, sinceSwingMs: sw === undefined ? null : now - sw, cooldownMs: meleeCooldownMs(e.name ?? '', s.meleeCooldownMs)
        })
      }
    }
    archers.sort((a, b) => a.dist - b.dist)
    const v = bot.entity.velocity
    return {
      now, body: { pos: me, vel: { x: v.x, y: v.y, z: v.z } }, yaw: bot.entity.yaw, onGround: bot.entity.onGround,
      projectiles, archers, attackers, safe: d => safe(d), crowd, rnd, lastSides: w.lastSides, handled: w.handled
    }
  }

  const leap = async (dir: V2, target: Entity | null, signal: AbortSignal, ms = s.leapMs) => {
    try { bot.pathfinder?.setGoal(null) } catch {}
    for (const c of ['back', 'left', 'right', 'sneak'] as const) bot.setControlState(c, false)
    await bot.look(yawOf(dir), 0, true)
    bot.setControlState('forward', true)
    bot.setControlState('sprint', true)
    const jumped = bot.entity.onGround
    if (jumped) bot.setControlState('jump', true)
    try {
      await sleep(TICK_MS, signal)
      bot.setControlState('jump', false)
      await sleep(Math.max(0, ms - TICK_MS), signal)
    } finally {
      bot.setControlState('jump', false)
      bot.setControlState('forward', false)
      bot.setControlState('sprint', false)
    }
    // snap back to the target before its next swing (and before ours)
    if (target?.position) await bot.lookAt(target.position.offset(0, (target.height ?? 1.8) * 0.8, 0), true).catch(() => {})
  }

  const record = (i: DodgeIntent & { kind: 'leap' }) => {
    w.stats.dodges++
    w.lastLeap = Date.now()
    if (i.key) {
      w.handled.add(i.key)
      if (w.handled.size > 200) w.handled.delete(w.handled.values().next().value!)
    }
    if (i.side >= 0) { w.lastSides.push(i.side); if (w.lastSides.length > 4) w.lastSides.shift() }
    if (i.arrow) { w.stats.arrowDodges++; w.pending.push(Date.now()) }
  }

  return {
    settings: s,
    delta: () => {
      judge()
      const out = { ...w.stats }
      for (const k of Object.keys(out) as (keyof DodgeStats)[]) out[k] -= base[k]
      return out
    },
    wants () {
      if (!s.enabled || !bot.entity || !bot.entity.onGround || Date.now() - w.lastLeap < s.minGapMs) return false
      return planDodge(view(), s, rangedTechniques)?.kind === 'leap'
    },
    async tick (target, signal, opts = {}) {
      judge()
      if (!s.enabled || !bot.entity) return null
      const i = planDodge(view(), s, opts.rangedOnly ? rangedTechniques : DODGE_TECHNIQUES)
      if (i?.kind !== 'back') stepping = false
      if (!i) return null
      if (i.kind === 'hold') return 'hold'
      if (i.kind === 'back') { if (!stepping) w.stats.meleeSteps++; stepping = true; return 'back' }
      if (Date.now() - w.lastLeap < s.minGapMs || !bot.entity.onGround) {
        // a leap needs the ground under it; mid-air or straight after one, a melee threat still steps back
        return i.technique === 'meleeTiming' ? 'back' : null
      }
      checkAborted(signal)
      record(i)
      log.info(`dodge: leap ${i.side === 0 ? 'left' : i.side === 1 ? 'right' : 'away'} (${i.technique}: ${i.reason})`)
      await leap(i.dir, target, signal)
      return 'leapt'
    },
    async creeperLeap (creeper, signal, lit) {
      if (!s.enabled || !s.creeperLeap || !bot.entity) return false
      const start = Date.now()
      let hops = 0
      try { bot.pathfinder?.setGoal(null) } catch {}
      try {
        while (true) {
          checkAborted(signal)
          const elapsed = Date.now() - start
          const me = bot.entity.position
          const d = creeper.position.distanceTo(me)
          const stillLit = (creeper as any).isValid !== false && lit()
          // only as far as the fuse needs (it stops at 7): further and the fight's chase limit ends the fight
          if (elapsed > s.creeperLeapMs || (hops > 0 && (!stillLit || d >= 7.2))) break
          const away = unit({ x: me.x - creeper.position.x, z: me.z - creeper.position.z })
          const turn = (a: number) => ({ x: away.x * Math.cos(a) - away.z * Math.sin(a), z: away.x * Math.sin(a) + away.z * Math.cos(a) })
          const dir = [0, 0.6, -0.6, 1.2, -1.2].map(turn).find(x => safe(x, 2))
          if (!dir) break
          await bot.look(yawOf(dir), 0, true)
          bot.setControlState('forward', true)
          bot.setControlState('sprint', true)
          bot.setControlState('jump', bot.entity.onGround)
          if (bot.entity.onGround) hops++
          await sleep(TICK_MS, signal)
        }
      } finally {
        for (const c of ['forward', 'sprint', 'jump'] as const) bot.setControlState(c, false)
      }
      if (!hops) return false
      log.info(`dodge: sprint-jumped away from a lit creeper (${hops} hops, ${creeper.position.distanceTo(bot.entity.position).toFixed(1)} blocks off)`)
      w.stats.dodges++
      w.stats.creeperLeaps++
      w.lastLeap = Date.now()
      return true
    }
  }
}
