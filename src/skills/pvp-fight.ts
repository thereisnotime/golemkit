// The PvP fight loop: one player, ticking every 50 ms. Decisions come from pvp-tactics.ts (pure,
// tested) and the shared ones in tactics.ts / techniques.ts; this file reads the enemy (held
// items, raised shield, drawn bow, last swing, velocity, health) and turns the decisions into
// control states:
//   approach sprinting and strafing (zig-zag against a drawn bow), bow at range with lead
//   -> hits on full charge, jump crits, W-tap sprint hits when knockback pays (enemy at a
//      ledge, we're losing); the axe against shield carriers (a raised shield gets hit at once,
//      which disables it 5 s), the sword otherwise
//   -> keep ~3 blocks while charging, circle, step back inside 2.4, shield up in reach while our
//      hit charges and when an arrow is coming, down to hit
//   -> totem into the offhand and golden apples at 10 health, retreat to heal when losing with
//      nothing to heal with (the caller re-engages), food when they're far
//   -> never with a drop or lava behind (sidestep), give up past the chase limit, out of sight
//      too long, or after a pearl out of range.
import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import { goals, sleep, checkAborted } from '../core/index.ts'
import { equipForTarget, hasRanged, shootAt, readyShield, type WeaponFlags } from './weapons.ts'
import { attackCooldownMs, swingDecision, MELEE_REACH } from './tactics.ts'
import { hitStyle, SPRINT_LEAD_MS, type HitStyle } from './techniques.ts'
import { incoming, PROJECTILES } from './ranged-plan.ts'
import { chaseVerdict } from './pvp.ts'
import {
  trackVelocity, teleported, predict, enemyReadyIn, shieldCovers, pvpWeapon, pvpShield, pvpMove, pvpKnockback, edgeStep,
  pvpRange, pvpSustain, SHIELD_DISABLE_MS, STRAFE_FLIP_MS, type V3
} from './pvp-tactics.ts'
import {
  eyeReach, safeStep, headroom, inLiquid, lineOfSight, clearMoves, eatAppleInFight, eatNow, shieldDisabled, aimPoint,
  type FightResult, type FightEnd
} from './fight.ts'
import { bestFood } from './survival.ts'

export interface PvpFightResult extends FightResult {
  /** Axe hits on a raised shield, arrows shot, totem swaps. */
  shieldBreaks: number, shots: number, totems: number
}

export interface PvpFightOptions {
  maxMs?: number
  flags: WeaponFlags
  /** Give up this many blocks from where the fight started / out of sight this long. */
  chase: number
  lostSec: number
  /** The duel odds right now (pvp.duelOdds), for the retreat rule. */
  odds?: () => number
  /** combat.totem */
  totem?: boolean
}

const GOLDEN = /^(enchanted_)?golden_apple$/
const lastApple = new WeakMap<Bot, number>()

// ---- reading a player entity ----

/** LivingEntity flags (metadata 8): bit 1 = using an item, bit 2 = with the offhand. */
function handState (e: Entity): { using: boolean, offhand: boolean } {
  const f = (e as any).metadata?.[8]
  const n = typeof f === 'number' ? f : 0
  return { using: (n & 1) !== 0, offhand: (n & 2) !== 0 }
}
export function heldOf (e: Entity): string | null { return (e as any).heldItem?.name ?? (e as any).equipment?.[0]?.name ?? null }
export function offhandOf (e: Entity): string | null { return (e as any).equipment?.[1]?.name ?? null }
/** The item the player is using right now (shield up, bow drawn), or null. */
export function usingItem (e: Entity): string | null {
  const h = handState(e)
  if (!h.using) return null
  return h.offhand ? offhandOf(e) : heldOf(e)
}
/** Health from metadata 9 (sent for players too); 20 when unknown. */
export function healthOf (e: Entity): number {
  const h = (e as any).metadata?.[9]
  return typeof h === 'number' && h > 0 ? h : 20
}

/** A drop of 4+ or lava/fire just beyond `to` as seen from `from` (where knockback would send it). */
export function hazardBeyond (bot: Bot, from: V3, to: V3, dist = 1.5): boolean {
  const dx = to.x - from.x
  const dz = to.z - from.z
  const l = Math.hypot(dx, dz) || 1
  const p = bot.entity.position.clone().set(Math.floor(to.x + dx / l * dist), Math.floor(to.y), Math.floor(to.z + dz / l * dist))
  for (let dy = 0; dy <= 4; dy++) {
    const b = bot.blockAt(p.offset(0, -dy, 0))
    if (!b) return false
    if (/^(lava|fire|soul_fire|magma_block)$/.test(b.name)) return true
    if (b.boundingBox === 'block') return false
    if (b.name === 'water') return false
  }
  return true
}

/**
 * Fights one player until one of us dies, they escape, or a give-up rule fires. 'heal' means
 * back off and heal (the caller decides when to come back).
 */
export async function fightPlayer (bot: Bot, target: Entity, signal: AbortSignal, o: PvpFightOptions): Promise<PvpFightResult> {
  const flags = o.flags
  const maxMs = o.maxMs ?? 60_000
  const start = Date.now()
  const origin = bot.entity.position.clone()
  const res: PvpFightResult = { end: 'timeout', killed: false, hits: 0, crits: 0, sprints: 0, sweeps: 0, blocks: 0, apples: 0, creeperBlocks: 0, shieldBreaks: 0, shots: 0, totems: 0 }

  let lastSwing = Date.now() - 2000
  let held: string | null = bot.heldItem?.name ?? null
  let firstHit = true
  let style: HitStyle = 'crit'
  let shieldUp = false
  let mode: 'path' | 'manual' | 'still' = 'still'
  let strafeDir: 'left' | 'right' = Math.random() < 0.5 ? 'left' : 'right'
  let strafeFlip = Date.now() + STRAFE_FLIP_MS
  let seenAt = Date.now()
  let vel: V3 = { x: 0, y: 0, z: 0 }
  let lastPos = { x: target.position.x, y: target.position.y, z: target.position.z, t: Date.now() }
  let jump = 0
  let enemySwing = 0
  let enemyShieldDownUntil = 0
  let lastEat = 0
  let died = false
  const arrows = new Map<number, { x: number, y: number, z: number, at: number }>()
  const onDead = (e: Entity) => { if (e.id === target.id) died = true }
  const onSwing = (e: Entity) => { if (e.id === target.id) enemySwing = Date.now() }
  bot.on('entityDead', onDead)
  bot.on('entitySwingArm', onSwing)

  const finish = (end: FightEnd, reason?: string): PvpFightResult => {
    res.end = end
    res.killed = end === 'killed'
    if (reason) res.reason = reason
    return res
  }
  const stopPath = () => { if (mode === 'path') { bot.pathfinder.setGoal(null); mode = 'still' } }
  const press = (dir: 'forward' | 'back' | 'left' | 'right' | null, sprint = false) => {
    for (const d of ['forward', 'back', 'left', 'right'] as const) bot.setControlState(d, d === dir && safeStep(bot, d))
    bot.setControlState('sprint', sprint && dir === 'forward')
  }
  const lowerShield = () => { if (shieldUp) { try { bot.deactivateItem() } catch {} shieldUp = false } }
  const raiseShield = async () => {
    if (shieldUp) return true
    if (flags.shield === false || shieldDisabled(bot) || !await readyShield(bot)) return false
    bot.setControlState('sprint', false)
    bot.activateItem(true)
    shieldUp = true
    res.blocks!++
    return true
  }
  const hasShield = () => bot.inventory.slots[45]?.name === 'shield'
  const item = (re: RegExp) => bot.inventory.items().filter(i => re.test(i.name)).sort((a, b) => rank(b.name) - rank(a.name))[0]
  const equipNamed = async (it: any) => {
    if (!it || bot.heldItem?.name === it.name) return
    await bot.equip(it, 'hand').catch(() => {})
    lastSwing = Date.now() // switching resets the charge
  }
  /** Arrows (or tridents) on course for us, from samples of their positions. */
  const arrowIncoming = (): boolean => {
    const now = Date.now()
    const me = bot.entity.position
    let hit = false
    for (const e of Object.values(bot.entities)) {
      if (!PROJECTILES[e.name ?? ''] || !e.position || e.position.distanceTo(me) > 40) continue
      const prev = arrows.get(e.id)
      arrows.set(e.id, { x: e.position.x, y: e.position.y, z: e.position.z, at: now })
      if (!prev || now - prev.at < 40) continue
      const t = (now - prev.at) / 50
      const v = { x: (e.position.x - prev.x) / t, y: (e.position.y - prev.y) / t, z: (e.position.z - prev.z) / t }
      const c = incoming({ name: e.name, pos: e.position, vel: v }, me, { horizon: 12 })
      if (c && c.miss < 0.8) hit = true
    }
    return hit
  }

  try {
    while (true) {
      checkAborted(signal)
      if (died) return finish('killed')
      if ((target as any).isValid === false) return finish('escaped', 'out of sight')
      if (Date.now() - start > maxMs) return finish('timeout')
      if (bot.health <= 0) return finish('gave_up', 'died')
      const now = Date.now()
      const me = bot.entity.position
      const tp = target.position
      const dist = me.distanceTo(tp)
      const hd = Math.hypot(me.x - tp.x, me.z - tp.z)
      const reach = eyeReach(bot, target)
      const los = lineOfSight(bot, target)
      if (los) seenAt = now
      // enemy velocity (and pearls) from position samples
      const dt = (now - lastPos.t) / 50
      if (dt >= 1) {
        jump = teleported(lastPos, tp) ? Math.hypot(tp.x - lastPos.x, tp.z - lastPos.z) : 0
        vel = trackVelocity(vel, lastPos, tp, dt)
        lastPos = { x: tp.x, y: tp.y, z: tp.z, t: now }
      }
      const why = chaseVerdict({ fromStart: me.distanceTo(origin), dist, chase: o.chase, outOfSightMs: now - seenAt, lostSec: o.lostSec, jump })
      if (why) return finish('gave_up', why)

      const enemyHeld = heldOf(target)
      const using = usingItem(target)
      const enemyBlocking = using === 'shield'
      const enemyDrawing = !!using && /^(bow|crossbow)$/.test(using)
      const enemyHealth = healthOf(target)
      const odds = o.odds?.() ?? 1

      // ---- sustain ----
      const apple = bot.inventory.items().some(i => GOLDEN.test(i.name))
      const totemItem = bot.inventory.items().find(i => i.name === 'totem_of_undying')
      const sustain = pvpSustain({
        health: bot.health, enemyDist: dist, hasTotem: !!totemItem && o.totem !== false, totemInOffhand: bot.inventory.slots[45]?.name === 'totem_of_undying',
        hasApple: apple && flags.goldenApple !== false, sinceAppleMs: now - (lastApple.get(bot) ?? 0),
        hasFood: !!bestFood(bot), food: bot.food, odds
      })
      if (sustain === 'totem' && totemItem) {
        lowerShield()
        await bot.equip(totemItem, 'off-hand').catch(() => {})
        res.totems++
        continue
      }
      if (sustain === 'apple') {
        lowerShield()
        stopPath()
        clearMoves(bot)
        lastApple.set(bot, now)
        if (await eatAppleInFight(bot, target, signal)) res.apples!++
        lastSwing = Date.now()
        continue
      }
      if (sustain === 'retreat' && flags.disengageToHeal !== false) return finish('heal', `health ${Math.ceil(bot.health)}`)
      if (sustain === 'eat' && now - lastEat > 4000) {
        lastEat = now
        lowerShield()
        stopPath()
        clearMoves(bot)
        await eatNow(bot, signal)
        lastSwing = Date.now()
        continue
      }

      // ---- bow at range ----
      const r = flags.ranged !== false ? hasRanged(bot) : null
      const arrowsLeft = r ? bot.inventory.items().filter(i => /arrow$/.test(i.name)).reduce((n, i) => n + i.count, 0) : 0
      const closing = -(vel.x * (tp.x - me.x) + vel.z * (tp.z - me.z)) / (hd || 1) * 20
      if (los && pvpRange({ dist, bow: !!r, arrows: arrowsLeft, enemyBlocking, closing }) === 'bow') {
        lowerShield()
        stopPath()
        clearMoves(bot)
        if (await shootAt(bot, target, signal)) res.shots++
        lastSwing = Date.now()
        continue
      }

      // ---- weapon: axe against a raised shield, sword otherwise (swapped on the way in) ----
      const sword = item(/_sword$/)
      const axe = item(/_axe$/)
      const facingUs = shieldCovers(target.yaw, tp, me)
      const want = pvpWeapon({ sword: !!sword, axe: !!axe, enemyShield: offhandOf(target) === 'shield' || heldOf(target) === 'shield', enemyBlocking })
      if (flags.adaptive !== false && want) await equipNamed(want === 'axe' ? axe : sword)
      else if (!want) await equipForTarget(bot, target, flags)
      held = bot.heldItem?.name ?? null
      const cdLeft = attackCooldownMs(held) - (Date.now() - lastSwing)
      const aimAt = predict(tp, vel, 2)

      // ---- shield ----
      const myShield = hasShield() || bot.inventory.items().some(i => i.name === 'shield')
      const shieldCall = pvpShield({ hasShield: myShield, disabled: shieldDisabled(bot), dist: hd, myCdLeftMs: cdLeft, arrowIncoming: arrowIncoming(), enemyDrawing })

      // ---------- out of reach: approach ----------
      if (reach > MELEE_REACH) {
        const direct = hd <= 12 && Math.abs(tp.y - me.y) < 1.5 && los
        if (!direct) {
          lowerShield()
          if (mode !== 'path') {
            clearMoves(bot)
            const mv = (bot.pathfinder as any).movements
            if (mv) mv.allowSprinting = true
            bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true)
            mode = 'path'
          }
          await sleep(100, signal)
          continue
        }
        stopPath()
        mode = 'manual'
        await bot.lookAt(bot.entity.position.clone().set(aimAt.x, tp.y + 1.5, aimAt.z), true).catch(() => {})
        if (shieldCall === 'raise' && await raiseShield()) {
          press('forward')
        } else {
          lowerShield()
          const mv = pvpMove({ hd, myCdLeftMs: cdLeft, enemyReadyInMs: enemyReadyIn(now - enemySwing, enemyHeld), enemyDrawing, behind: enemyHealth - bot.health, shield: myShield && !shieldDisabled(bot) })
          if (now > strafeFlip) { strafeDir = strafeDir === 'left' ? 'right' : 'left'; strafeFlip = now + (enemyDrawing ? 350 : STRAFE_FLIP_MS) + Math.random() * 300 }
          press(mv.dir === 'back' ? 'back' : 'forward', mv.sprint)
          if (mv.strafe) bot.setControlState(strafeDir, safeStep(bot, strafeDir))
          if (tp.y - me.y > 0.6 && bot.entity.onGround) { bot.setControlState('jump', true); setTimeout(() => bot.setControlState('jump', false), 60) }
        }
        await sleep(50, signal)
        continue
      }

      // ---------- in reach ----------
      stopPath()
      mode = 'manual'
      await bot.lookAt(aimPoint(bot, target), true).catch(() => {})
      const enemyEdge = hazardBeyond(bot, me, tp)
      const canCrit = flags.crits !== false && !inLiquid(bot) && headroom(bot)
      if (bot.entity.onGround) {
        style = hitStyle({
          canCrit, sweep: false, sweepWorth: false, sprintReset: flags.sprintReset !== false,
          wantKnockback: pvpKnockback({ enemyEdge, health: bot.health, enemyHealth })
        })
      }
      // an axe in hand against their raised shield: hit now, charged or not (any axe hit disables it)
      const breakShield = enemyBlocking && facingUs && !!held?.endsWith('_axe') && enemyShieldDownUntil < now
      const decision = breakShield ? 'swing' : swingDecision({
        cooldownLeftMs: cdLeft, reach, onGround: bot.entity.onGround, velY: bot.entity.velocity.y, inLiquid: inLiquid(bot),
        headroom: headroom(bot), crits: canCrit && style === 'crit', firstHit: firstHit && flags.crits !== false
      })
      const sprinting = style === 'sprint' && decision !== 'jump' && cdLeft <= SPRINT_LEAD_MS && bot.entity.onGround
      if (sprinting && !bot.getControlState('sprint')) {
        lowerShield()
        bot.setControlState('forward', safeStep(bot, 'forward'))
        bot.setControlState('sprint', true)
      }
      if (decision === 'sprint_hit' || decision === 'swing') {
        lowerShield()
        const sprintHit = decision === 'sprint_hit' || (style === 'sprint' && bot.getControlState('sprint'))
        if (!sprintHit) bot.setControlState('sprint', false)
        else { bot.setControlState('forward', true); bot.setControlState('sprint', true) }
        const crit = decision === 'swing' && !sprintHit && !bot.entity.onGround && bot.entity.velocity.y < 0
        bot.attack(target)
        lastSwing = Date.now()
        res.hits++
        if (crit) res.crits++
        else if (sprintHit) res.sprints!++
        if (breakShield) { res.shieldBreaks++; enemyShieldDownUntil = Date.now() + SHIELD_DISABLE_MS }
        firstHit = false
        bot.setControlState('sprint', false)
      } else if (decision === 'jump') {
        lowerShield()
        bot.setControlState('sprint', false)
        bot.setControlState('jump', true)
        setTimeout(() => bot.setControlState('jump', false), 60)
      } else if (!sprinting) {
        if (shieldCall === 'raise') await raiseShield()
        else lowerShield()
      }

      if (!sprinting) {
        // never with a drop or lava behind us: sidestep first
        const edge = edgeStep({ backSafe: safeStep(bot, 'back', 1) && safeStep(bot, 'back', 2), leftSafe: safeStep(bot, 'left'), rightSafe: safeStep(bot, 'right') })
        if (edge) press(edge)
        else {
          const mv = pvpMove({ hd, myCdLeftMs: cdLeft, enemyReadyInMs: enemyReadyIn(now - enemySwing, enemyHeld), enemyDrawing, behind: enemyHealth - bot.health, shield: myShield && !shieldDisabled(bot) })
          // a raised shield facing us and no axe: work round to its side
          const flank = enemyBlocking && facingUs && !axe
          if (now > strafeFlip && !flank) { strafeDir = strafeDir === 'left' ? 'right' : 'left'; strafeFlip = now + STRAFE_FLIP_MS + Math.random() * 400 }
          if (!safeStep(bot, strafeDir)) strafeDir = strafeDir === 'left' ? 'right' : 'left'
          if (mv.dir === 'strafe' || flank) press(strafeDir)
          else {
            press(mv.dir, mv.sprint && !shieldUp)
            if (mv.strafe) bot.setControlState(strafeDir, safeStep(bot, strafeDir))
          }
        }
      }
      await sleep(50, signal)
    }
  } finally {
    bot.off('entityDead', onDead)
    bot.off('entitySwingArm', onSwing)
    lowerShield()
    clearMoves(bot)
    bot.pathfinder.setGoal(null)
  }
}

const TIER = ['wooden', 'golden', 'stone', 'iron', 'diamond', 'netherite']
function rank (n: string): number { return TIER.findIndex(t => n.startsWith(t + '_')) }
