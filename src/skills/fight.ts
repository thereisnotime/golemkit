// The melee/ranged fight loop. Decisions come from tactics.ts (pure, tested); this file turns them
// into control states, ticking every 50 ms:
//   approach (pathfinder far away, direct steering close by, zig-zag/shield against archers)
//   -> swing on the weapon's real cooldown, jump for a crit, sprint into the first hit
//   -> keep spacing and strafe between swings, step back after a hit
//   -> stop when it dies, escapes, the chase gets too long or too dangerous, or the bot should
//      disengage (outnumbered, or losing: retreat.ts); the caller decides what to do next.
import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import { goals, FLYING, isHostile, sleep, checkAborted } from '../core/index.ts'
import { equipForTarget, hasRanged, shootAt, readyShield, isRangedMob, meleeDamage, DEFAULT_MAX_CHASE, type WeaponFlags } from './weapons.ts'
import { attackCooldownMs, swingDecision, spacing, chaseRefusal, outnumbered, shouldEatInLull, creeperMove, MELEE_REACH } from './tactics.ts'
import { hitStyle, sweepWorth, wantKnockback, shieldAgainstMelee, creeperEscape, goldenAppleNow, rangedUseless, SPRINT_LEAD_MS, CREEPER_FUSE_MS, LEAP_GAIN, type HitStyle } from './techniques.ts'
import { dodgeLayer } from './dodge.ts'
import { DODGE_DEFAULTS } from './dodgePlan.ts'
import { bestFood } from './survival.ts'
import { retreatCheck } from './retreat.ts'

export type FightEnd = 'killed' | 'escaped' | 'timeout' | 'gave_up' | 'heal' | 'outnumbered' | 'retarget'
export interface FightResult {
  end: FightEnd, killed: boolean, reason?: string, hits: number, crits: number
  /** Technique counters: sprint (W-tap) hits, sweep hits, shield raises against melee, golden apples eaten, creeper blasts blocked. */
  sprints?: number, sweeps?: number, blocks?: number, apples?: number, creeperBlocks?: number
  /** Dodge layer (dodge.ts): leaps of any kind, and arrows or shots dodged (no projectile hit right after the leap). */
  dodges?: number, arrowsDodged?: number
}

// ---- shield cooldown: an axe hit on a raised shield disables it (set_cooldown for the shield item) ----

const shieldDown = new WeakMap<Bot, number>()
/** Watches set_cooldown packets for the shield item; returns the remover. */
export function installShieldWatch (bot: Bot): () => void {
  const id = (bot.registry as any).itemsByName?.shield?.id
  const onCooldown = (p: { itemID: number, cooldownTicks: number }) => {
    if (p.itemID === id) shieldDown.set(bot, Date.now() + p.cooldownTicks * 50)
  }
  bot._client.on('set_cooldown', onCooldown as any)
  return () => { bot._client.removeListener('set_cooldown', onCooldown as any) }
}
/** The bot's shield is disabled right now (hit by an axe while blocking). */
export function shieldDisabled (bot: Bot): boolean {
  return (shieldDown.get(bot) ?? 0) > Date.now()
}

/** Ground mobs within r of an entity other than itself (who a sweep would also hit). */
function bunchedAround (bot: Bot, t: Entity, r = 1.5): number {
  let n = 0
  for (const e of Object.values(bot.entities)) {
    if (e === t || e === bot.entity || !isHostile(e) || FLYING.has(e.name ?? '')) continue
    if (e.position.distanceTo(t.position) <= r) n++
  }
  return n
}

const EYE = 1.62
const LIQUID = /^(water|lava|bubble_column)$/
const DANGER = /^(lava|fire|soul_fire|magma_block|campfire|soul_campfire|sweet_berry_bush|cactus|powder_snow|wither_rose)$/

/** Distance from the bot's eyes to the closest point of the target's hitbox (what the server checks). */
export function eyeReach (bot: Bot, t: Entity): number {
  const e = bot.entity.position
  const ex = e.x
  const ey = e.y + EYE
  const ez = e.z
  const w = (t.width ?? 0.6) / 2
  const h = t.height ?? 1.8
  const cx = Math.max(t.position.x - w, Math.min(ex, t.position.x + w))
  const cy = Math.max(t.position.y, Math.min(ey, t.position.y + h))
  const cz = Math.max(t.position.z - w, Math.min(ez, t.position.z + w))
  return Math.hypot(cx - ex, cy - ey, cz - ez)
}

const hDist = (a: { x: number, z: number }, b: { x: number, z: number }) => Math.hypot(a.x - b.x, a.z - b.z)

type Dir = 'forward' | 'back' | 'left' | 'right'

/** Is a step in this direction (relative to where the bot faces) onto safe ground? No liquid, no fire, no drop over 2. */
export function safeStep (bot: Bot, dir: Dir, dist = 1): boolean {
  const y = bot.entity.yaw
  const f = { x: -Math.sin(y), z: -Math.cos(y) }
  const v = dir === 'forward' ? f : dir === 'back' ? { x: -f.x, z: -f.z } : dir === 'left' ? { x: f.z, z: -f.x } : { x: -f.z, z: f.x }
  const p = bot.entity.position.offset(v.x * dist, 0, v.z * dist).floored()
  const feet = bot.blockAt(p)
  const head = bot.blockAt(p.offset(0, 1, 0))
  if (!feet || !head) return false
  if (LIQUID.test(feet.name) || DANGER.test(feet.name) || LIQUID.test(head.name)) return false
  if (feet.boundingBox === 'block') return bot.blockAt(p.offset(0, 2, 0))?.boundingBox === 'empty' && head.boundingBox === 'empty' // a step up
  for (let dy = 1; dy <= 3; dy++) {
    const b = bot.blockAt(p.offset(0, -dy, 0))
    if (!b) return false
    if (LIQUID.test(b.name) || DANGER.test(b.name)) return false
    if (b.boundingBox === 'block') return dy <= 2 // dropping 1 is fine, 2 is a small fall
  }
  return false // cliff
}

export function headroom (bot: Bot): boolean {
  const p = bot.entity.position.floored()
  return bot.blockAt(p.offset(0, 2, 0))?.boundingBox === 'empty'
}

export function inLiquid (bot: Bot, pos = bot.entity.position): boolean {
  const b = bot.blockAt(pos.floored())
  return !!b && LIQUID.test(b.name)
}

/** Underground darkness: no sky light and little block light. */
function dark (bot: Bot, pos: any): boolean {
  const b = bot.blockAt(pos.floored().offset(0, 1, 0)) as any
  if (!b) return false
  return (b.skyLight ?? 15) === 0 && (b.light ?? 15) < 6
}

/** Height of the drop between the bot's feet and the ground under the target (positive = the target is lower). */
function dropTo (bot: Bot, t: Entity): number {
  return bot.entity.position.y - t.position.y
}

/** Clear line of sight from the bot's eyes to the target's centre (blocks only). */
export function lineOfSight (bot: Bot, t: Entity): boolean {
  try {
    const from = bot.entity.position.offset(0, EYE, 0)
    const to = t.position.offset(0, (t.height ?? 1.8) * 0.8, 0)
    const d = to.minus(from)
    const len = d.norm()
    const hit = (bot.world as any).raycast(from, d.normalize(), len)
    return !hit
  } catch { return true }
}

/** Creeper fuse state: metadata "swell direction" is 1 while it is about to explode. */
export function creeperFuseLit (e: Entity): boolean {
  const md = (e as any).metadata as unknown[] | undefined
  return !!md && (md[16] === 1 || md[18] === true) // 1.21 creeper: 16 = state (-1 idle, 1 fusing), 17 = charged, 18 = ignited (flint and steel)
}

/** Ground melee hostiles within r (what outnumbering counts). */
export function meleeNear (bot: Bot, r = 6): number {
  let n = 0
  for (const e of Object.values(bot.entities)) {
    if (e === bot.entity || !isHostile(e) || FLYING.has(e.name ?? '') || isRangedMob(e.name) || e.name === 'creeper') continue
    if (e.position.distanceTo(bot.entity.position) <= r) n++
  }
  return n
}

const GOLDEN = /^(enchanted_)?golden_apple$/
const lastApple = new WeakMap<Bot, number>()

/** Eats a golden apple now, backing away from `from` while it does (combat.goldenApple). */
export async function eatAppleInFight (bot: Bot, from: Entity, signal: AbortSignal): Promise<boolean> {
  const apple = bot.inventory.items().find(i => i.name === 'enchanted_golden_apple') ?? bot.inventory.items().find(i => GOLDEN.test(i.name))
  if (!apple) return false
  lastApple.set(bot, Date.now())
  checkAborted(signal)
  try {
    await bot.equip(apple, 'hand')
    await bot.lookAt(from.position.offset(0, (from.height ?? 1.8) * 0.8, 0), true).catch(() => {})
    if (safeStep(bot, 'back')) bot.setControlState('back', true)
    await bot.consume()
    return true
  } catch { return false } finally { bot.setControlState('back', false) }
}

/** Food for a fight: a golden apple when hurt, otherwise the best normal food (if hungry enough to eat). */
export function fightFood (bot: Bot): any {
  const apple = bot.inventory.items().find(i => GOLDEN.test(i.name))
  if (apple && bot.health <= 10) return apple
  return bot.food < 20 ? bestFood(bot) : (apple ?? null)
}

/** Eats one item now (holds still for the 1.6 s). True when the hunger bar or health changed. */
export async function eatNow (bot: Bot, signal: AbortSignal): Promise<boolean> {
  const food = fightFood(bot)
  if (!food) return false
  checkAborted(signal)
  try {
    await bot.equip(food, 'hand')
    await bot.consume()
    return true
  } catch { return false }
}

export function clearMoves (bot: Bot): void {
  for (const c of ['forward', 'back', 'left', 'right', 'sprint', 'jump', 'sneak'] as const) bot.setControlState(c, false)
}

export interface FightOptions {
  maxMs?: number
  flags?: WeaponFlags
  /** Only melee/ranged decisions: no outnumbered/heal stops (hunting animals). Default: true for hostiles. */
  tactical?: boolean
  /** Checked before every shot: true holds fire (a bodyguard's player in the line of fire) and the loop closes in instead. */
  holdFire?: (target: Entity) => boolean
  /** Stop (end 'retarget', reason 'tagged') after this many hits: a bodyguard pulling a mob off its player. */
  stopAfterHits?: number
}

/**
 * Fights one target until it dies, escapes or something says stop. See the file header for the
 * loop; FightResult.end tells the caller why it ended.
 */
export async function fightTarget (bot: Bot, target: Entity, signal: AbortSignal, opts: FightOptions = {}): Promise<FightResult> {
  const flags: WeaponFlags = opts.flags ?? { adaptive: true, ranged: true, shield: true }
  const crits = flags.crits ?? true
  const strafe = flags.strafe ?? true
  const maxChase = flags.maxChase ?? DEFAULT_MAX_CHASE
  const maxMs = opts.maxMs ?? 20_000
  const tactical = opts.tactical ?? isHostile(target)
  const flying = FLYING.has(target.name ?? '')
  const archer = isRangedMob(target.name)
  const start = Date.now()
  const origin = bot.entity.position.clone()
  const res: FightResult = { end: 'timeout', killed: false, hits: 0, crits: 0, sprints: 0, sweeps: 0, blocks: 0, apples: 0, creeperBlocks: 0, dodges: 0, arrowsDodged: 0 }
  // movement during the fight: arrow and draw leaps, melee timing, the creeper leap (combat.dodge.*)
  const dodge = dodgeLayer(bot, flags.dodge ?? DODGE_DEFAULTS)
  const creeperLeap = dodge.settings.enabled && dodge.settings.creeperLeap
  const canShoot = flags.ranged && !rangedUseless(target.name)
  let fuseSince = 0 // when the target creeper's fuse was first seen lit
  let style: HitStyle = 'crit'

  const heldBefore = bot.heldItem?.name ?? null
  let held: string | null = await equipForTarget(bot, target, flags)
  // fresh fight: charged, unless we just switched items (that resets the charge)
  let lastSwing = (bot.heldItem?.name ?? null) !== heldBefore ? Date.now() : Date.now() - 2000
  let lastDist = bot.entity.position.distanceTo(target.position)
  let firstHit = !flying
  let mode = 'still' as 'path' | 'manual' | 'still'
  let strafeDir: 'left' | 'right' = Math.random() < 0.5 ? 'left' : 'right'
  let strafeFlip = Date.now() + 700 + Math.random() * 600
  let backUntil = 0
  let bestDist = Infinity
  let bestAt = Date.now()
  let hazardSince = 0
  let lastEat = 0
  let shieldUp = false
  // a death animation (entity_status 3) for the target: removed without one = exploded or despawned
  let died = false
  const onDead = (e: Entity) => { if (e.id === target.id) died = true }
  bot.on('entityDead', onDead)

  const usePath = () => {
    if (mode === 'path') return
    clearMoves(bot)
    const mv = (bot.pathfinder as any).movements
    if (mv) mv.allowSprinting = true
    bot.pathfinder.setGoal(new goals.GoalFollow(target, 1.5), true)
    mode = 'path'
  }
  const useManual = () => {
    if (mode === 'path') bot.pathfinder.setGoal(null)
    mode = 'manual'
  }
  const press = (dir: Dir | null, sprint = false) => {
    for (const d of ['forward', 'back', 'left', 'right'] as const) bot.setControlState(d, d === dir && safeStep(bot, d))
    bot.setControlState('sprint', sprint && dir === 'forward')
  }
  const lowerShield = () => { if (shieldUp) { try { bot.deactivateItem() } catch {} shieldUp = false } }
  const raiseShield = async (melee = false) => {
    if (shieldUp || (melee ? flags.shieldMelee === false : !flags.shield)) return shieldUp
    if (shieldDisabled(bot) || !await readyShield(bot)) return false
    bot.activateItem(true)
    shieldUp = true
    return true
  }
  const finish = (end: FightEnd, reason?: string): FightResult => {
    res.end = end
    res.killed = end === 'killed'
    if (reason) res.reason = reason
    const d = dodge.delta()
    res.dodges = d.dodges
    res.arrowsDodged = d.arrowsDodged
    return res
  }

  try {
    while (true) {
      checkAborted(signal)
      if (died) return finish('killed') // death animation started: next target, don't wait for the body to go
      if ((target as any).isValid === false) return finish('escaped', lastDist < 16 ? 'gone (exploded or despawned)' : 'out of sight')
      if (Date.now() - start > maxMs) return finish('timeout')
      if (bot.health <= 0) return finish('gave_up', 'died')
      const me = bot.entity.position
      const dist = me.distanceTo(target.position)
      lastDist = dist
      const reach = eyeReach(bot, target)
      const hd = hDist(me, target.position)

      if (tactical) {
        const apple = bot.inventory.items().some(i => GOLDEN.test(i.name))
        if (apple && goldenAppleNow({
          enabled: flags.goldenApple ?? true, health: bot.health, hasGoldenApple: apple, meleeNear: meleeNear(bot, 4),
          litCreeperNear: !!bot.nearestEntity(e => e.name === 'creeper' && creeperFuseLit(e) && e.position.distanceTo(me) < 5),
          sinceLastMs: Date.now() - (lastApple.get(bot) ?? 0)
        })) {
          lowerShield()
          if (mode === 'path') { bot.pathfinder.setGoal(null); mode = 'still' }
          clearMoves(bot)
          if (await eatAppleInFight(bot, target, signal)) res.apples!++
          held = await equipForTarget(bot, target, flags)
          lastSwing = Date.now()
          continue
        }
        const leave = retreatCheck(bot, flags.retreat, flags.disengageToHeal ?? true) // retreat.ts: risk-based, or the old 4-health rule
        if (leave) return finish('heal', leave)
        if (outnumbered({ health: bot.health, meleeNear: meleeNear(bot) })) return finish('outnumbered', `${meleeNear(bot)} mobs close at health ${Math.ceil(bot.health)}`)
        // another creeper fusing close while we fight this one: deal with the lit one first
        if (target.name === 'creeper' && !creeperFuseLit(target)) {
          const lit = bot.nearestEntity(e => e !== target && e.name === 'creeper' && creeperFuseLit(e) && e.position.distanceTo(me) <= 5)
          if (lit) return finish('retarget', 'another creeper fusing')
        }
        // a creeper walking up while we fight something else: it comes first (seen live: blown up in iron armour)
        if (target.name !== 'creeper') {
          const c = bot.nearestEntity(e => e.name === 'creeper' && isHostile(e) && e.position.distanceTo(me) <= 5)
          if (c) return finish('retarget', 'creeper close')
        }
      }

      // A creeper whose fuse is lit (~1.5 s): get away now, finish it after the fizzle.
      const lit = target.name === 'creeper' && creeperFuseLit(target)
      if (!lit) fuseSince = 0
      else if (!fuseSince) fuseSince = Date.now()
      let creeper = target.name === 'creeper' ? creeperMove({ dist, fuseLit: lit, bow: !!(canShoot && hasRanged(bot)), holdFire: opts.holdFire?.(target), leap: creeperLeap }) : null
      if ((creeper === 'back_off' || creeper === 'leap') && flags.shieldMelee !== false && !shieldDisabled(bot) &&
          creeperEscape({ dist, msLeft: CREEPER_FUSE_MS - (Date.now() - fuseSince), shield: bot.inventory.slots[45]?.name === 'shield' || bot.inventory.items().some(i => i.name === 'shield'), gain: creeper === 'leap' ? LEAP_GAIN : undefined }) === 'shield') {
        // too close to outrun the rest of the fuse: face it behind the shield (a blocked blast does no damage)
        if (mode === 'path') { bot.pathfinder.setGoal(null); mode = 'still' }
        clearMoves(bot)
        if (await raiseShield(true)) {
          res.creeperBlocks!++
          const until = Date.now() + 1700
          while (Date.now() < until && (target as any).isValid !== false && creeperFuseLit(target)) {
            await bot.lookAt(target.position.offset(0, 1, 0), true).catch(() => {})
            if (safeStep(bot, 'back')) bot.setControlState('back', true)
            await sleep(50, signal)
          }
          bot.setControlState('back', false)
          lowerShield()
          continue
        }
      }
      if (creeper === 'leap') {
        // sprint-jump away (dodge.ts); walk off with the pathfinder when no direction is safe
        lowerShield()
        if (mode === 'path') { bot.pathfinder.setGoal(null); mode = 'still' }
        clearMoves(bot)
        const before = bot.entity.position.clone()
        if (await dodge.creeperLeap(target, signal, () => creeperFuseLit(target))) { origin.add(bot.entity.position.minus(before)); continue }
        creeper = 'back_off'
      }
      if (creeper === 'back_off') {
        lowerShield()
        clearMoves(bot)
        if (mode === 'path') bot.pathfinder.setGoal(null)
        bot.pathfinder.setGoal(new goals.GoalInvert(new goals.GoalFollow(target, 7)), true)
        mode = 'path'
        await sleep(1500, signal)
        bot.pathfinder.setGoal(null)
        mode = 'still'
        continue
      }

      if (dist > (flying ? 40 : 24)) return finish('escaped', 'too far away')

      // the dodge layer: a leap away from a shot or a swing happens here; 'back' / 'hold' shape the spacing below
      const beforeDodge = bot.entity.position.clone()
      const dodged = tactical ? await dodge.tick(target, signal) : null
      // a dodge is not a chase: maxChase counts from where the fight would be without it
      if (dodged === 'leapt') { origin.add(bot.entity.position.minus(beforeDodge)); mode = 'still'; continue }

      // Chasing: limits on distance from where the fight started and on where we follow it.
      if (!flying && reach > MELEE_REACH) {
        const refusal = chaseRefusal({
          fromStart: me.distanceTo(origin),
          maxChase,
          targetInLiquid: inLiquid(bot, target.position) && !inLiquid(bot),
          dropBelow: dropTo(bot, target),
          targetInDark: dark(bot, target.position),
          botInDark: dark(bot, me)
        })
        if (refusal) {
          if (!hazardSince) hazardSince = Date.now()
          // past maxChase: stop at once; terrain: wait a moment, it may come back out
          if (refusal.startsWith('chased') || Date.now() - hazardSince > 3000) return finish('gave_up', refusal)
          if (mode === 'path') { bot.pathfinder.setGoal(null); mode = 'still' }
          clearMoves(bot)
          await sleep(150, signal)
          continue
        }
        hazardSince = 0
        // Not getting closer (no path up to it, e.g. a skeleton on a ledge): standing still while
        // it shoots us is the worst option. 3 s without 0.5 blocks of progress: stop.
        if (dist < bestDist - 0.5) { bestDist = dist; bestAt = Date.now() } else if (Date.now() - bestAt > 3000 && !(archer && canShoot && hasRanged(bot))) {
          return finish('gave_up', 'no way to get closer')
        }
      } else {
        bestDist = Math.min(bestDist, dist)
        bestAt = Date.now()
      }

      // a lull: nothing close and hunger blocks regeneration
      if (tactical && Date.now() - lastEat > 5000) {
        const nearest = nearestHostileDist(bot)
        if (shouldEatInLull({ health: bot.health, food: bot.food, nearestMob: nearest, hasFood: !!bestFood(bot), hasGoldenApple: bot.inventory.items().some(i => GOLDEN.test(i.name)) })) {
          lastEat = Date.now()
          if (mode === 'path') { bot.pathfinder.setGoal(null); mode = 'still' }
          clearMoves(bot)
          lowerShield()
          await eatNow(bot, signal)
          held = await equipForTarget(bot, target, flags)
          lastSwing = Date.now()
          bestAt = Date.now()
          continue
        }
      }

      // ---------- flyers: hold position, track, swing when they dive, shoot otherwise ----------
      if (flying) {
        if (mode === 'path') { bot.pathfinder.setGoal(null); mode = 'still' }
        await bot.lookAt(target.position.offset(0, target.height * 0.5, 0), true).catch(() => {})
        if (reach <= MELEE_REACH) {
          held = await swapIfNeeded()
          if (Date.now() - lastSwing >= attackCooldownMs(held)) { bot.attack(target); lastSwing = Date.now(); res.hits++ }
          await sleep(50, signal)
        } else if (canShoot && hasRanged(bot) && dist < 32 && Date.now() - lastSwing > 300 && !opts.holdFire?.(target)) {
          await shootAt(bot, target, signal)
          held = await equipForTarget(bot, target, flags)
          lastSwing = Date.now()
        } else {
          await sleep(100, signal)
        }
        continue
      }

      // ---------- out of reach: approach ----------
      if (reach > MELEE_REACH) {
        // spiders on walls: don't climb after them, wait on flat ground for the drop
        if (/spider$/.test(target.name ?? '') && target.position.y - me.y > 1.5 && hd < 4) {
          if (mode === 'path') { bot.pathfinder.setGoal(null); mode = 'still' }
          clearMoves(bot)
          bestAt = Date.now() // waiting on purpose, not stuck
          await bot.lookAt(target.position.offset(0, 0.4, 0), true).catch(() => {})
          await sleep(100, signal)
          continue
        }
        if ((creeper === 'shoot' || (archer && canShoot && hasRanged(bot) && dist > 6 && dist < 32 && !opts.holdFire?.(target)))) {
          lowerShield()
          if (mode === 'path') { bot.pathfinder.setGoal(null); mode = 'still' }
          clearMoves(bot)
          await shootAt(bot, target, signal)
          held = await equipForTarget(bot, target, flags)
          lastSwing = Date.now()
          continue
        }
        const direct = hd <= (archer ? 12 : 6) && Math.abs(target.position.y - me.y) < 1.5 && lineOfSight(bot, target)
        if (!direct) {
          lowerShield()
          usePath()
          await sleep(100, signal)
          continue
        }
        useManual()
        await bot.lookAt(target.position.offset(0, target.height * 0.8, 0), true).catch(() => {})
        if (archer && hd > 4) {
          // close the gap: behind a shield if we have one, else sprint in a zig-zag so arrows miss
          if (await raiseShield()) press('forward')
          else {
            if (Date.now() > strafeFlip) { strafeDir = strafeDir === 'left' ? 'right' : 'left'; strafeFlip = Date.now() + 450 + Math.random() * 300 }
            press('forward', true)
            bot.setControlState(strafeDir, safeStep(bot, strafeDir))
          }
        } else {
          lowerShield()
          press('forward', true) // sprinting into reach makes the first hit a knockback hit
          if (target.position.y - me.y > 0.6 && bot.entity.onGround) { bot.setControlState('jump', true); setTimeout(() => bot.setControlState('jump', false), 60) }
        }
        await sleep(50, signal)
        continue
      }

      // ---------- in reach ----------
      useManual()
      held = await swapIfNeeded()
      const cdLeft = attackCooldownMs(held) - (Date.now() - lastSwing)
      await bot.lookAt(aimPoint(bot, target), true).catch(() => {})
      const near = meleeNear(bot, 4)
      const canCrit = crits && !inLiquid(bot) && headroom(bot) && target.name !== 'creeper'
      // pick the style while on the ground; keep it through a jump so a crit in the air isn't dropped
      if (bot.entity.onGround) {
        style = hitStyle({
          canCrit,
          sweep: flags.sweep ?? true,
          sweepWorth: sweepWorth({ weapon: held, damage: meleeDamage(held), sweepingLevel: sweepingLevel(bot), bunched: bunchedAround(bot, target) }),
          sprintReset: flags.sprintReset ?? true,
          wantKnockback: wantKnockback({ target: target.name ?? '', health: bot.health, meleeNear: near })
        })
      }
      const decision = swingDecision({
        cooldownLeftMs: cdLeft,
        reach,
        onGround: bot.entity.onGround,
        velY: bot.entity.velocity.y,
        inLiquid: inLiquid(bot),
        headroom: headroom(bot),
        crits: crits && style === 'crit',
        firstHit: firstHit && crits,
        hurry: target.name === 'creeper'
      })
      // W-tap: sprint goes on again a tick or two before the charge completes, so the hit carries knockback
      const sprinting = style === 'sprint' && decision !== 'jump' && cdLeft <= SPRINT_LEAD_MS && bot.entity.onGround && dodged !== 'back'
      if (sprinting && !bot.getControlState('sprint')) {
        lowerShield()
        bot.setControlState('forward', safeStep(bot, 'forward'))
        bot.setControlState('sprint', true)
      }
      // a sweep needs a slow ground hit: stop moving the tick before
      if (style === 'sweep' && cdLeft <= 100 && cdLeft > 0) clearMoves(bot)
      if (decision === 'sprint_hit' || decision === 'swing') {
        lowerShield()
        const sprintHit = decision === 'sprint_hit' || (style === 'sprint' && bot.getControlState('sprint'))
        if (!sprintHit) bot.setControlState('sprint', false)
        else { bot.setControlState('forward', true); bot.setControlState('sprint', true) }
        if (style === 'sweep' && decision === 'swing') clearMoves(bot)
        const crit = decision === 'swing' && !sprintHit && !bot.entity.onGround && bot.entity.velocity.y < 0
        bot.attack(target)
        lastSwing = Date.now()
        res.hits++
        if (crit) res.crits++
        else if (sprintHit) res.sprints!++
        else if (style === 'sweep' && held?.endsWith('_sword') && bot.entity.onGround) res.sweeps!++
        firstHit = false
        // let go of sprint right away (the "W" of a W-tap): the server ends the sprint on a knockback hit anyway
        bot.setControlState('sprint', false)
        if (opts.stopAfterHits && res.hits >= opts.stopAfterHits) return finish('retarget', 'tagged')
        if (target.name === 'creeper') {
          // hit and step back: knockback plus distance keeps us out of the blast
          press('back')
          await sleep(700, signal).finally(() => clearMoves(bot))
          continue
        }
        if (strafe && !archer) backUntil = Date.now() + 350 // step out of its swing
      } else if (decision === 'jump') {
        bot.setControlState('sprint', false)
        bot.setControlState('jump', true)
        setTimeout(() => bot.setControlState('jump', false), 60)
      } else if (archer && flags.shield && cdLeft > 200) {
        await raiseShield() // point-blank skeleton: block between swings
      } else if (!sprinting && shieldAgainstMelee({
        enabled: flags.shieldMelee ?? true,
        hasShield: true,
        attacker: target.name ?? '',
        attackerHeld: (target as any).heldItem?.name ?? null,
        dist: hd,
        cooldownLeftMs: cdLeft,
        disabled: shieldDisabled(bot)
      })) {
        if (!shieldUp && await raiseShield(true)) res.blocks!++
      } else if (shieldUp && !archer && cdLeft <= SHIELD_LOWER_MS) lowerShield()

      if (sprinting) {
        // W-tap in progress: keep running into the hit
      } else if (strafe) {
        if (dodged === 'hold') backUntil = 0 // it is recharging: stay in and hit
        if (Date.now() < backUntil || dodged === 'back') press('back')
        else {
          const sp = spacing(hd)
          const s = dodged === 'hold' && sp === 'back' ? 'strafe' : sp
          if (s === 'strafe') {
            if (Date.now() > strafeFlip || !safeStep(bot, strafeDir)) { strafeDir = strafeDir === 'left' ? 'right' : 'left'; strafeFlip = Date.now() + 700 + Math.random() * 700 }
            press(strafeDir)
          } else press(s)
        }
      } else if (decision !== 'sprint_hit') clearMoves(bot)

      await sleep(50, signal)
    }
  } finally {
    bot.off('entityDead', onDead)
    lowerShield()
    clearMoves(bot)
    bot.pathfinder.setGoal(null)
  }

  async function swapIfNeeded (): Promise<string | null> {
    const before = bot.heldItem?.name ?? null
    const now = await equipForTarget(bot, target, flags)
    if ((bot.heldItem?.name ?? null) !== before) lastSwing = Date.now() // switching resets the charge
    return bot.heldItem?.name ?? now
  }
}

/** Shield goes down this long before the charge completes, so the swing isn't held up by it. */
const SHIELD_LOWER_MS = 60

/** Sweeping Edge level of the held item (0 without it). */
function sweepingLevel (bot: Bot): number {
  const e = ((bot.heldItem as any)?.enchants ?? []) as { name: string, lvl: number }[]
  return e.find(x => x.name === 'sweeping_edge' || x.name === 'sweeping')?.lvl ?? 0
}

/** Where to look to hit: the point of its hitbox nearest our eye line, a little inside. */
export function aimPoint (bot: Bot, t: Entity): any {
  const ey = bot.entity.position.y + EYE
  const y = Math.max(t.position.y + 0.2, Math.min(ey, t.position.y + (t.height ?? 1.8) - 0.2))
  return t.position.offset(0, y - t.position.y, 0)
}

function nearestHostileDist (bot: Bot): number {
  const m = bot.nearestEntity(e => isHostile(e))
  return m ? m.position.distanceTo(bot.entity.position) : Infinity
}
