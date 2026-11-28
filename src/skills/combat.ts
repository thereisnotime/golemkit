import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import type { ActionContext } from '../core/index.ts'
import { defineSkill, defineAction, z, noParams, ok, fail, goals, fmtPos, gotoTimed, playerEntity, nearestHostile, isHostile, FLYING, sleep, checkAborted, reachMovements } from '../core/index.ts'
import { vec } from './world.ts'
import { inDangerZone, wayThroughDanger } from './food-danger.ts'
import { reachEffort, digIntoLiquid, SCAFFOLD_BLOCKS } from './reachPlan.ts'
import { pickupNearby } from './pickup.ts'
import { isRangedMob, weaponFlags, type WeaponFlags } from './weapons.ts'
import { fightTarget, eyeReach, lineOfSight, creeperFuseLit, eatNow, fightFood, meleeNear, type FightResult } from './fight.ts'
import { rankTargets, attackRefusal, LEFT_MOB_MS, type ThreatInfo } from './tactics.ts'
import { fillerBlock } from './survival.ts'
import { getHome } from './navigation.ts'
import { gearUp, wornArmorPoints } from './gear.ts'
import { rangedDefense, installRangedWatch } from './ranged.ts'
import { installShieldWatch } from './fight.ts'
import { findChokepoint, wantChokepoint } from './techniques.ts'
import { waterBucket } from './clutch.ts'
import { defendPlayer, notePlayerHit, installGazeGuard } from './defense.ts'
import { PVP_ACTION_DEFS, installPvp } from './pvp-actions.ts'
import { escorting } from './bodyguard.ts'
import { runInline, escapeFight, escapeInputs, ROUTE_RUNNERS } from './escape.ts'
import { retreatOf, threatsAround, clearLeaving, noteRetreat } from './retreat.ts'
import { engageDecision, planEscape, ESCAPE_ROUTES, OUTRUN_US, type RetreatSettings } from './retreatPlan.ts'
const WEAPONS = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword',
  'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe']

export async function equipBestWeapon (bot: Bot): Promise<void> {
  for (const name of WEAPONS) {
    const item = bot.inventory.items().find(i => i.name === name)
    if (item) {
      if (bot.heldItem?.name !== name) await bot.equip(item, 'hand').catch(() => {})
      return
    }
  }
}

/**
 * Fights one target until it dies, escapes or the signal aborts (fight.ts has the loop): swings on
 * the weapon's real cooldown, jumps for critical hits, keeps spacing and strafes, shoots flyers
 * and archers with a bow, blocks arrows with a shield. True when it died. Flags: settings.combat
 * (live via !config_set combat.*). fightTarget() returns why it stopped.
 */
export async function fight (bot: Bot, target: Entity, signal: AbortSignal, maxMs = 20000, flags: WeaponFlags = { adaptive: true, ranged: true, shield: true }): Promise<boolean> {
  return (await fightTarget(bot, target, signal, { maxMs, flags })).killed
}

// ---- who to fight ----

/** Mobs that hit us recently (id -> time), so neutral mobs (endermen, piglins, wolves) are fought only then. */
const attackers = new WeakMap<Bot, Map<number, number>>()
const ATTACKER_MS = 15_000

export function recentAttacker (bot: Bot, id: number): boolean {
  const t = attackers.get(bot)?.get(id)
  return !!t && Date.now() - t < ATTACKER_MS
}

function noteAttacker (bot: Bot): void {
  // the nearest living non-player within melee range when we got hurt
  const e = bot.nearestEntity(x => x !== bot.entity && x.type !== 'player' && x.type !== 'object' && x.type !== 'orb' &&
    x.position.distanceTo(bot.entity.position) < 4.5)
  if (!e) return
  let m = attackers.get(bot)
  if (!m) attackers.set(bot, m = new Map())
  m.set(e.id, Date.now())
}

/**
 * Why an entity must not be attacked, or null when it may: never players, villagers, golems,
 * pets (owner or tamed flag), named mobs; neutral mobs only while they're attacking us (or,
 * with `attacking`, someone we protect). The rule itself is tactics.attackRefusal().
 */
export function combatRefusal (bot: Bot, e: Entity, attacking = false): string | null {
  const name = e.name ?? ''
  const keys = (bot.registry as any).entitiesByName?.[name]?.metadataKeys as string[] | undefined
  const md = (e as any).metadata as unknown[] | undefined
  const at = (key: string, fallback: number) => { const i = keys?.indexOf(key) ?? -1; return md?.[i >= 0 ? i : fallback] }
  const custom = at('custom_name', 2)
  return attackRefusal({
    name,
    player: e.type === 'player' || !!(e as any).username,
    named: custom !== undefined && custom !== null && custom !== '',
    owned: !!at('owneruuid', -1),
    hostile: isHostile(e),
    attacking: attacking || recentAttacker(bot, e.id)
  })
}

/** Everything worth fighting around the bot, most threatening first (tactics.rankTargets). */
const left = new WeakMap<Bot, Map<number, number>>()
/** Mobs a fight left lately (entity id -> until), for the proactive defend reflex (tactics.ts stillLeft). */
export function leftMobs (bot: Bot): Map<number, number> {
  let m = left.get(bot)
  if (!m) { m = new Map(); left.set(bot, m) }
  const now = Date.now()
  for (const [k, v] of m) if (v <= now) m.delete(k)
  return m
}

export function threats (bot: Bot, radius = 24): Entity[] {
  const me = bot.entity.position
  const list: (ThreatInfo & { e: Entity })[] = []
  for (const e of Object.values(bot.entities)) {
    if (e === bot.entity || !e.position) continue
    const d = e.position.distanceTo(me)
    if (d > radius) continue
    if (combatRefusal(bot, e)) continue
    const hp = ((e as any).metadata as unknown[] | undefined)?.[9]
    if (typeof hp === 'number' && hp <= 0) continue // dying (the body stays ~1 s)
    const ground = !FLYING.has(e.name ?? '') && !isRangedMob(e.name)
    if (ground && d > 8 && !recentAttacker(bot, e.id)) continue // melee mobs far away aren't a fight yet
    if (FLYING.has(e.name ?? '') && d > 20) continue
    list.push({ id: e.id, name: e.name ?? '', dist: d, los: isRangedMob(e.name) ? lineOfSight(bot, e) : true, fuseLit: e.name === 'creeper' && creeperFuseLit(e), attacking: recentAttacker(bot, e.id), e })
  }
  return rankTargets(list).map(t => t.e)
}

/** Animals a hunt couldn't get to (up a cliff, behind water...): skipped by later hunts for 5 minutes. */
const unreachable = new WeakMap<Bot, Map<number, number>>()
/** Animals hunt gave up on (couldn't reach or kill) in the last 5 minutes, per bot. */
export function unreachableAnimals (bot: Bot): { has: (id: number) => boolean, add: (id: number) => void } {
  let m = unreachable.get(bot)
  if (!m) unreachable.set(bot, m = new Map())
  const map = m
  return {
    has: id => { const t = map.get(id); if (t && t > Date.now()) return true; map.delete(id); return false },
    add: id => { map.set(id, Date.now() + 5 * 60_000) }
  }
}

const attack = defineAction({
  name: 'attack',
  description: 'Fight the most dangerous hostile mob nearby, or a specific entity by id. Never attacks players, villagers, golems, pets or named mobs.',
  params: z.object({
    entityId: z.number().optional().describe('entity id; default the most dangerous hostile mob nearby'),
    radius: z.number().default(16).describe('how far to look for a target, in blocks')
  }),
  async run ({ bot, agent, signal }, { entityId, radius }) {
    const target = entityId !== undefined ? bot.entities[entityId] : threats(bot, radius)[0] ?? nearestHostile(bot, bot.entity.position, radius)
    if (!target) return fail('no target nearby')
    const why = combatRefusal(bot, target)
    if (why && !(why === 'not hostile' && entityId !== undefined && HUNTABLE.includes(target.name as any))) return fail(`won't attack ${target.name ?? 'that'}: ${why}`)
    const r = await fightTarget(bot, target, signal, { maxMs: 20000, flags: weaponFlags(agent) })
    return r.killed ? ok(`killed ${target.name} (${r.hits} hits, ${r.crits} crits)`) : ok(`stopped fighting ${target.name}: ${r.reason ?? r.end}`)
  }
})

const guard = defineAction({
  name: 'guard',
  description: 'Stay near a player and kill hostile mobs that come close to them, until stopped.',
  params: z.object({
    player: z.string().optional().describe('player to protect; defaults to the requesting player'),
    radius: z.number().default(12)
  }),
  longRunning: true,
  async run ({ bot, signal, player: caller }, { player, radius }) {
    const who = player ?? caller
    if (!who) return fail('guard whom?')
    while (!signal.aborted) {
      const owner = playerEntity(bot, who)
      const center = owner?.position ?? bot.entity.position
      const mob = nearestHostile(bot, center, radius)
      if (mob) {
        await fight(bot, mob, signal)
      } else if (owner && bot.entity.position.distanceTo(owner.position) > 4) {
        bot.pathfinder.setGoal(new goals.GoalFollow(owner, 3), true)
      }
      await sleep(500, signal).catch(() => {})
    }
    bot.pathfinder.setGoal(null)
    return ok(`stopped guarding ${who}`)
  }
})

/** Back away from a mob for a few seconds (pathfinder), until `dist` blocks or `ms` run out. */
async function backOff (bot: Bot, mob: Entity, signal: AbortSignal, dist: number, ms: number): Promise<void> {
  bot.pathfinder.setGoal(new goals.GoalInvert(new goals.GoalFollow(mob, dist)), true)
  try {
    const until = Date.now() + ms
    while (Date.now() < until && (mob as any).isValid !== false && bot.entity.position.distanceTo(mob.position) < dist) await sleep(200, signal)
  } finally { bot.pathfinder.setGoal(null) }
}

/**
 * Outnumbered (3+ melee mobs close, under half health): a 2-block pillar puts us above zombie
 * reach while we can still hit their heads; otherwise home if it is close, otherwise back off.
 */
async function escapeCrowd (ctx: ActionContext): Promise<string> {
  const { bot, agent, signal } = ctx
  const flags = weaponFlags(agent)
  if (agent.settings.canPlace !== false && fillerBlock(bot) && agent.getAction('pillar') && !agent.protectedAreas.isProtected(bot.entity.position)) {
    const r = await runInline(ctx, 'pillar', { height: 2 }).catch(() => null)
    if (r?.ok) {
      // fight from the top: swing at whatever comes into reach, eat when it's quiet
      const until = Date.now() + 60_000
      while (Date.now() < until && meleeNear(bot, 8) >= 2) {
        checkAborted(signal)
        const near = threats(bot, 6).find(e => eyeReach(bot, e) <= 3)
        if (near) await fightTarget(bot, near, signal, { maxMs: 1500, flags: { ...flags, strafe: false, maxChase: 0.5 }, tactical: false })
        else if (bot.health <= 10 && fightFood(bot)) await eatNow(bot, signal)
        else await sleep(250, signal)
      }
      return 'pillared up out of reach'
    }
  }
  const home = getHome(agent)
  if (home && Math.hypot(home.x - bot.entity.position.x, home.z - bot.entity.position.z) < 48) {
    const r = await runInline(ctx, 'go_home', { range: 2 }).catch(() => null)
    if (r?.ok) return 'ran home'
  }
  const r = await runInline(ctx, 'retreat', { distance: 20 }).catch(() => null)
  return r?.ok ? 'backed off' : 'tried to back off'
}

/**
 * Where the current run of reflex fights started. defend runs again and again while mobs keep
 * coming; measuring the chase from each run's own start let the bot drift 30 blocks down a hill
 * (seen live). The anchor stays until 20 s pass without a fight.
 */
const anchors = new WeakMap<Bot, { pos: any, until: number }>()
function fightAnchor (bot: Bot): any {
  const a = anchors.get(bot)
  if (a && Date.now() < a.until) return a.pos
  const pos = bot.entity.position.clone()
  anchors.set(bot, { pos, until: Date.now() + 20_000 })
  return pos
}
/** Moves the fight's anchor to where the bot is now (home after it went home). */
function reanchor (bot: Bot): any {
  const pos = bot.entity.position.clone()
  anchors.set(bot, { pos, until: Date.now() + 20_000 })
  return pos
}
function touchAnchor (bot: Bot): void {
  const a = anchors.get(bot)
  if (a) a.until = Date.now() + 20_000
}

/** Feet, head free and solid floor: a cell the bot can stand in. */
function standable (bot: Bot, p: any): boolean {
  const feet = bot.blockAt(p)
  const head = bot.blockAt(p.offset(0, 1, 0))
  const floor = bot.blockAt(p.offset(0, -1, 0))
  if (!feet || !head || !floor) return false
  if (feet.boundingBox !== 'empty' || head.boundingBox !== 'empty' || /water|lava|fire/.test(feet.name)) return false
  return floor.boundingBox === 'block'
}

/**
 * combat.chokepoints: 3+ melee mobs coming and health to fight with: walk to a 1-wide gap
 * (techniques.findChokepoint) within 6 blocks and fight from it without strafing, so they reach
 * the bot one at a time. Null when it doesn't apply or there is no such gap.
 */
async function holdChokepoint (ctx: ActionContext, flags: WeaponFlags, force = false): Promise<string | null> {
  const { bot, agent, signal } = ctx
  const enabled = ((agent.settings.combat ?? {}) as { chokepoints?: boolean }).chokepoints !== false
  // force: retreat.avoidOpen sends it to a gap against fewer mobs too (no armour at night, say)
  if (!(force ? enabled : wantChokepoint({ enabled, meleeNear: meleeNear(bot, 8), health: bot.health }))) return null
  const me = bot.entity.position.floored()
  const mobs = threats(bot, 12).filter(e => !FLYING.has(e.name ?? '') && !isRangedMob(e.name) && e.name !== 'creeper')
  if (mobs.length < (force ? 1 : 3)) return null
  const toward = { x: mobs.reduce((a, e) => a + e.position.x, 0) / mobs.length - me.x, z: mobs.reduce((a, e) => a + e.position.z, 0) / mobs.length - me.z }
  const spot = findChokepoint((dx, dz) => standable(bot, me.offset(dx, 0, dz)), toward, 6)
  if (!spot) return null
  if (spot.dx !== 0 || spot.dz !== 0) {
    try { await gotoTimed(bot, new goals.GoalBlock(me.x + spot.dx, me.y, me.z + spot.dz), signal, 5000) } catch { checkAborted(signal); return null }
  }
  const until = Date.now() + 45_000
  let kills = 0
  while (Date.now() < until && meleeNear(bot, 8) >= 1 && bot.health > 6) {
    checkAborted(signal)
    const near = threats(bot, 5).find(e => eyeReach(bot, e) <= 3)
    if (near) {
      const r = await fightTarget(bot, near, signal, { maxMs: 2000, flags: { ...flags, strafe: false, maxChase: 1 } })
      if (r.killed) kills++
      if (r.end === 'heal' || r.end === 'outnumbered') break
    } else {
      const m = threats(bot, 10)[0]
      if (!m) break
      await bot.lookAt(m.position.offset(0, (m.height ?? 1.8) * 0.8, 0), true).catch(() => {})
      await sleep(150, signal)
    }
  }
  return `held a chokepoint (${kills} killed there)`
}

const isNight = (bot: Bot) => { const t = bot.time.timeOfDay; return t >= 12_500 && t <= 23_500 }

/** An owner within 16 blocks with a hostile within 6 of them. */
function ownerThreatened (ctx: ActionContext): boolean {
  const { bot, agent } = ctx
  for (const name of agent.owners) {
    const p = playerEntity(bot, name)
    if (!p || p.position.distanceTo(bot.entity.position) > 16) continue
    if (bot.nearestEntity(e => isHostile(e) && e.position.distanceTo(p.position) <= 6)) return true
  }
  return false
}

/**
 * retreat.avoidOpen: poorly placed for a fight in the open (engageDecision: no armour, night,
 * outnumbered): go home or fight from a chokepoint instead (retreat.avoidRoutes, in order).
 * Null when it takes the fight where it stands.
 */
async function avoidOpenFight (ctx: ActionContext, s: RetreatSettings, flags: WeaponFlags): Promise<{ note: string, home: boolean } | null> {
  const { bot, log } = ctx
  const close = threatsAround(bot, 8).filter(t => !t.ranged && !t.flying && t.name !== 'creeper')
  const d = engageDecision({
    armour: wornArmorPoints(bot), night: isNight(bot), meleeNear: close.length, ownerThreatened: ownerThreatened(ctx),
    allFaster: close.length > 0 && close.every(t => OUTRUN_US.has(t.name)), settings: s
  })
  if (d.fight) return null
  for (const id of s.avoidRoutes) {
    if (id === 'home') {
      const plan = planEscape(escapeInputs(ctx, s), ['home'], ESCAPE_ROUTES)
      if (!plan.usable.length) { log.debug(`retreat: not fighting in the open (${d.why}), home: ${plan.skipped[0]?.why}`); continue }
      const r = await ROUTE_RUNNERS.home(ctx, s)
      if (r.ok) {
        const note = `didn't fight in the open (${d.why}), went ${r.where}`
        log.info(`retreat: ${note}`)
        ctx.agent.status?.noteEvent?.(note)
        noteRetreat(bot, { at: Date.now(), why: `avoid: ${d.why}`, route: 'home', ok: true, detail: note })
        return { note, home: true }
      }
    } else if (id === 'chokepoint') {
      const held = await holdChokepoint(ctx, flags, true)
      if (held) {
        const note = `didn't fight in the open (${d.why}), ${held}`
        log.info(`retreat: ${note}`)
        noteRetreat(bot, { at: Date.now(), why: `avoid: ${d.why}`, route: 'chokepoint', ok: true, detail: note })
        return { note, home: false }
      }
    }
  }
  return null
}

const defend = defineAction({
  name: 'defend',
  description: 'Fight back against the hostile mobs around, most dangerous first (used by reflexes).',
  params: noParams,
  internal: true,
  async run (ctx) {
    const { bot, agent, signal } = ctx
    const flags = weaponFlags(agent)
    const rs = retreatOf(agent)
    const maxChase = flags.maxChase ?? 16
    let origin = fightAnchor(bot)
    let escapes = 0
    let avoided = !rs.enabled
    const skip = new Set<number>()
    const killed: string[] = []
    const notes: string[] = []
    let heals = 0
    let hits = 0
    let crits = 0
    let choked = false
    const extra = { sprints: 0, sweeps: 0, blocks: 0, apples: 0, creeperBlocks: 0, dodges: 0, arrowsDodged: 0 }
    const until = Date.now() + 60_000
    while (Date.now() < until) {
      checkAborted(signal)
      const mob = threats(bot, 24).find(e => !skip.has(e.id) && e.position.distanceTo(origin) <= maxChase + 12)
      if (!mob) break
      if (!avoided) {
        avoided = true
        const a = await avoidOpenFight(ctx, rs, flags)
        if (a) {
          notes.push(a.note)
          if (a.home) { origin = reanchor(bot); continue }
          choked = true
          continue
        }
      }
      if (!choked) {
        const held = await holdChokepoint(ctx, flags)
        if (held) { choked = true; notes.push(held); continue }
      }
      const drift = bot.entity.position.distanceTo(origin)
      const long = FLYING.has(mob.name ?? '') || isRangedMob(mob.name)
      const r: FightResult = await fightTarget(bot, mob, signal, { maxMs: long ? 25000 : 12000, flags: { ...flags, maxChase: Math.max(3, maxChase - drift) } })
      hits += r.hits
      crits += r.crits
      for (const k of Object.keys(extra) as (keyof typeof extra)[]) extra[k] += r[k] ?? 0
      if (bot.health <= 0) return fail(`died fighting ${mob.name}`)
      if (r.killed) { killed.push(mob.name ?? 'mob'); continue }
      if ((r.end === 'heal' || r.end === 'outnumbered') && rs.enabled && escapes < rs.maxEscapes) {
        // losing (retreat.ts): leave by the first route that works, heal, maybe come back
        escapes++
        const e = await escapeFight(ctx, r.reason ?? r.end, rs)
        notes.push(e.note)
        if (e.ok) {
          if (e.anchorHere) origin = reanchor(bot)
          else if (e.comeBack && bot.health >= rs.returnAbove && bot.entity.position.distanceTo(origin) > maxChase / 2) {
            // sprinted or dug in away from it: walk back first, or the chase limit (maxChase - drift) stops the next fight at once
            try { await gotoTimed(bot, new goals.GoalNear(origin.x, origin.y, origin.z, 3), signal, 15_000) } catch { checkAborted(signal) }
          }
          if (!e.comeBack) break
          if (bot.health >= rs.returnAbove) clearLeaving(bot)
          choked = false
          continue
        }
        // nowhere to go: the old back-off-and-eat below, then fight where it stands
      }
      if (r.end === 'heal' && heals < 3) {
        // standing ground doesn't mean dying: step back, eat (or let regeneration work), come back
        heals++
        await backOff(bot, mob, signal, 10, 5000)
        const ate = await eatNow(bot, signal)
        if (ate && bot.health <= 8 && fightFood(bot)) await eatNow(bot, signal)
        if (!ate) {
          const until = Date.now() + 5000
          while (Date.now() < until && bot.health <= 8 && bot.health > 0 && mob.position.distanceTo(bot.entity.position) > 4) await sleep(250, signal)
        }
        notes.push(ate ? 'backed off to eat' : `backed off to heal (health ${Math.ceil(bot.health)})`)
        continue
      }
      if (r.end === 'outnumbered') { notes.push(await escapeCrowd(ctx)); break }
      if (r.end === 'retarget') continue // something worse came close: threats() puts it first
      skip.add(mob.id)
      if (r.end === 'gave_up' && isRangedMob(mob.name) && (mob as any).isValid !== false) {
        // couldn't get to the archer: get out of its line of fire instead of standing there
        await backOff(bot, mob, signal, 20, 4000)
        notes.push(`couldn't reach the ${mob.name} (${r.reason}); backed out of its line of fire`)
      } else if (r.reason) { notes.push(`left the ${mob.name}: ${r.reason}`); leftMobs(bot).set(mob.id, Date.now() + LEFT_MOB_MS) }
    }
    touchAnchor(bot)
    // pulled too far from where the fighting started (shelter, home, the job): walk back
    if (bot.health > 0 && bot.entity.position.distanceTo(origin) > maxChase && !threats(bot, 5).length) {
      try {
        await gotoTimed(bot, new goals.GoalNear(origin.x, origin.y, origin.z, 2), signal, 20_000)
        notes.push('walked back to where the fight started')
      } catch { checkAborted(signal) }
    }
    if (!killed.length && !notes.length) return fail('nothing to fight')
    const k = killed.length ? `killed ${[...new Set(killed)].map(n => `${killed.filter(x => x === n).length} ${n}`).join(', ')}` : 'killed nothing'
    const tech = [extra.sprints && `${extra.sprints} sprint hits`, extra.sweeps && `${extra.sweeps} sweeps`, extra.blocks && `${extra.blocks} shield blocks`,
      extra.creeperBlocks && `${extra.creeperBlocks} creeper blasts blocked`, extra.apples && `${extra.apples} golden apples`,
      extra.dodges && `${extra.dodges} dodges`, extra.arrowsDodged && `${extra.arrowsDodged} arrows dodged`].filter(Boolean)
    return ok([k + (hits ? ` (${[`${hits} hits`, `${crits} crits`, ...tech].join(', ')})` : ''), ...notes].join('; '))
  }
})

const retreat = defineAction({
  name: 'retreat',
  description: 'Back off from nearby hostile mobs (used by reflexes at low health).',
  params: z.object({ distance: z.number().min(6).max(32).default(18) }),
  internal: true,
  async run ({ bot, signal }, { distance }) {
    const mob = nearestHostile(bot, bot.entity.position, distance)
    if (!mob) return ok('nothing to back off from')
    bot.pathfinder.setGoal(new goals.GoalInvert(new goals.GoalFollow(mob, distance)), true)
    try {
      const until = Date.now() + 12_000
      while (Date.now() < until) {
        checkAborted(signal)
        if (!(mob as any).isValid || bot.entity.position.distanceTo(mob.position) >= distance) break
        await sleep(400, signal)
      }
    } finally {
      bot.pathfinder.setGoal(null)
    }
    const d = Math.round(bot.entity.position.distanceTo(mob.position))
    return d >= distance - 2 ? ok(`backed off from ${mob.name}`) : fail(`couldn't get away from ${mob.name} (${d} blocks)`)
  }
})

/** Passive animals the bot may hunt for food. Pets, horses, villagers etc. are never on it. */
export const HUNTABLE = ['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom'] as const

/** The parts of an entity the hunt filter looks at (a mineflayer Entity has all of them). */
export interface HuntCandidate {
  id: number
  name?: string
  type?: string
  username?: string
  metadata?: unknown[]
  /** mineflayer stores a leash holder (attach_entity) here. */
  vehicle?: unknown
}

function meta (e: HuntCandidate, keys: string[] | undefined, key: string, fallback: number): unknown {
  const i = keys?.indexOf(key) ?? -1
  return e.metadata?.[i >= 0 ? i : fallback]
}

/**
 * Why an entity must not be hunted, or null when it may. Only listed passive animals; never
 * players, villagers, pets (anything with an owner or the tamed flag), named (name tag) or
 * leashed animals, and babies (they drop nothing).
 */
export function huntRefusal (e: HuntCandidate, opts: { animals?: readonly string[], metadataKeys?: string[], babies?: boolean } = {}): string | null {
  const animals = opts.animals ?? HUNTABLE
  if (e.type === 'player' || e.username) return 'player'
  const name = e.name ?? ''
  if (!animals.includes(name) || !(HUNTABLE as readonly string[]).includes(name)) return 'not a huntable animal'
  if (e.type && e.type !== 'animal') return 'not an animal'
  const keys = opts.metadataKeys
  const customName = meta(e, keys, 'custom_name', 2)
  if (customName !== undefined && customName !== null && customName !== '') return 'named'
  if (e.vehicle) return 'leashed'
  const owner = meta(e, keys, 'owneruuid', -1)
  if (owner) return 'tamed'
  const flags = keys?.includes('flags') ? meta(e, keys, 'flags', -1) : undefined
  if (typeof flags === 'number' && (flags & 0x04)) return 'tamed'
  if (!opts.babies && meta(e, keys, 'baby', 16) === true) return 'baby'
  return null
}

/**
 * How many of each kind may be hunted so that at least `keepAtLeast` adults stay (a
 * sustainable herd). `adults` counts huntable adults by animal name.
 */
export function herdSurplus (adults: Record<string, number>, keepAtLeast: number): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, n] of Object.entries(adults)) out[k] = Math.max(0, n - Math.max(0, keepAtLeast))
  return out
}

/** True if a fence or fence gate is within `r` blocks: animals there are probably someone's farm. */
export function inPen (bot: Bot, e: Entity, r = 3): boolean {
  const base = e.position.floored()
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        const b = bot.blockAt(base.offset(dx, dy, dz))
        if (b && /(_fence|_fence_gate|_wall)$/.test(b.name)) return true
      }
    }
  }
  return false
}

const SCAFFOLD = new Set<string>(SCAFFOLD_BLOCKS)
const scaffoldCount = (bot: Bot) => bot.inventory.items().filter(i => SCAFFOLD.has(i.name)).reduce((n, i) => n + i.count, 0)

/**
 * One more go at an animal the pathfinder couldn't get to on foot: bridge and pillar with blocks
 * from the inventory and dig through or down, within reachEffort's budget (16 blocks, 45 s),
 * never in protected areas or danger zones and never digging into water or lava. Says what it did.
 */
async function reachAnimal (ctx: ActionContext, target: Entity): Promise<{ killed: boolean, note: string }> {
  const { bot, agent, signal, log } = ctx
  const name = target.name ?? 'animal'
  const p = target.position
  const me = bot.entity.position
  const at = (x: number, y: number, z: number) => bot.blockAt(vec(bot, Math.floor(x), Math.floor(y), Math.floor(z)))?.name
  const feet = [at(p.x, p.y, p.z), at(p.x, p.y - 1, p.z)]
  const liquidAt = feet.includes('lava') ? 'lava' as const : feet.includes('water') ? 'water' as const : null
  const decision = reachEffort({
    canDig: agent.canDig,
    canPlace: (agent.settings as { canPlace?: boolean } | undefined)?.canPlace !== false,
    scaffold: scaffoldCount(bot),
    distance: p.distanceTo(me),
    dy: p.y - me.y,
    protectedTarget: !!agent.protectedAreas?.isProtected(p),
    dangerTarget: inDangerZone(agent, p) || wayThroughDanger(agent, me, p),
    liquidAt
  })
  if (!decision.ok) return { killed: false, note: `the ${name} at ${fmtPos(p)}: ${decision.reason}` }
  log.debug('hunt: out of reach on foot, trying harder', { animal: name, at: fmtPos(p), how: decision.how })
  const before = scaffoldCount(bot)
  let dug = 0
  const onDig = () => { dug++ }
  bot.on('diggingCompleted', onDig)
  const restore = reachMovements(bot, {
    ...decision.budget,
    scaffold: SCAFFOLD_BLOCKS,
    forbidden: q => !!agent.protectedAreas?.isProtected(q) || inDangerZone(agent, q),
    avoidStep: q => inDangerZone(agent, q),
    unsafeBreak: q => digIntoLiquid([at(q.x, q.y - 1, q.z), at(q.x, q.y - 2, q.z)])
  })
  let why = ''
  let killed = false
  try {
    const until = Date.now() + decision.budget.ms
    const t = target.position
    try { await gotoTimed(bot, new goals.GoalNear(t.x, t.y, t.z, 2), signal, decision.budget.ms) } catch (e) { checkAborted(signal); why = (e as Error).message }
    if ((target as any).isValid !== false && bot.entities[target.id]) killed = await fight(bot, target, signal, Math.max(8000, until - Date.now()))
    else if (!why) why = 'it was gone'
    if (!killed && !why) why = 'still out of reach'
  } finally {
    restore()
    bot.off('diggingCompleted', onDig)
  }
  const placed = Math.max(0, before - scaffoldCount(bot))
  const did = [placed ? `placed ${placed} block${placed === 1 ? '' : 's'}` : '', dug ? `dug ${dug}` : ''].filter(Boolean).join(', ') || 'nothing placed or dug'
  return killed
    ? { killed, note: `reached the ${name} at ${fmtPos(p)} (${did})` }
    : { killed, note: `the ${name} at ${fmtPos(p)}: out of reach even with ${decision.how} (${did}; ${why})` }
}

const hunt = defineAction({
  name: 'hunt',
  description: 'Hunt passive animals (cow, pig, sheep, chicken, rabbit, mooshroom) for food and pick up the drops. ' +
    'Never touches pets, named, tamed or leashed animals, babies, villagers or players, and by default leaves fenced animals alone.',
  params: z.object({
    animal: z.enum(HUNTABLE).optional().describe('which animal; default the nearest huntable one'),
    count: z.number().int().min(1).max(8).default(1).describe('how many to kill'),
    radius: z.number().min(4).max(64).default(24).describe('how far to look, in blocks'),
    pens: z.boolean().default(false).describe('also hunt animals inside fences (only your own farm)'),
    keepAtLeast: z.number().int().min(0).max(32).default(0).describe('leave at least this many adults of each kind alive (sustainable herd)'),
    reach: z.boolean().default(true).describe('when an animal is out of reach on foot, bridge, pillar (up to 16 blocks of dirt, cobblestone or planks) or dig to it, never in protected areas or danger zones')
  }),
  async run (ctx, { animal, count, radius, pens, keepAtLeast, reach }) {
    const { bot, agent, signal, log } = ctx
    const animals = animal ? [animal] : HUNTABLE
    const skipped = unreachableAnimals(bot) // shared across hunt runs: keep_fed re-runs hunt every few seconds
    const allowed = (e: any) => {
      const keys = (bot.registry as any).entitiesByName?.[e.name ?? '']?.metadataKeys as string[] | undefined
      if (huntRefusal(e as HuntCandidate, { animals, metadataKeys: keys })) return false
      if (agent.protectedAreas.isProtected(e.position)) return false
      return pens || !inPen(bot, e)
    }
    // with keepAtLeast, count the herd once per kill and spare kinds at the minimum
    const surplus = () => {
      if (!keepAtLeast) return null
      const adults: Record<string, number> = {}
      for (const e of Object.values(bot.entities)) {
        if (e.position && e.position.distanceTo(bot.entity.position) <= radius + 16 && allowed(e)) adults[e.name!] = (adults[e.name!] ?? 0) + 1
      }
      return herdSurplus(adults, keepAtLeast)
    }
    const total = () => bot.inventory.items().reduce((n, i) => n + i.count, 0)
    const before = total()
    let killed = 0
    const names: string[] = []
    let spared = false
    const notes: string[] = []
    while (killed < count) {
      checkAborted(signal)
      const left = surplus()
      const target = bot.nearestEntity(e => {
        if (skipped.has(e.id) || e.position.distanceTo(bot.entity.position) > radius) return false
        if (!allowed(e)) return false
        if (left && !(left[e.name!]! > 0)) { spared = true; return false }
        return true
      })
      if (!target) break
      log.debug('hunting', { animal: target.name, id: target.id })
      // fight() gives up on targets more than 24 blocks away: walk closer first
      if (target.position.distanceTo(bot.entity.position) > 16) {
        const p = target.position
        try { await gotoTimed(bot, new goals.GoalNear(p.x, p.y, p.z, 4), signal, 30_000) } catch { checkAborted(signal) }
      }
      let dead = await fight(bot, target, signal, 25_000)
      if (!dead && reach && (target as any).isValid !== false && bot.entities[target.id]) {
        const r = await reachAnimal(ctx, target)
        dead = r.killed
        notes.push(r.note)
      }
      if (!dead) { skipped.add(target.id); log.debug('hunt: giving up on this one for 5 min', { animal: target.name, at: fmtPos(target.position) }); continue }
      killed++
      names.push(target.name ?? 'animal')
      await sleep(400, signal)
      await pickupNearby(bot, signal, { radius: 6, maxMs: 8000 })
    }
    const why = notes.length ? `; ${notes.join('; ')}` : ''
    if (!killed) {
      if (notes.length) return fail(`couldn't get to the animals within ${radius} blocks (left alone for 5 min)${why}`)
      const left = Object.values(bot.entities).filter(e => e.position && skipped.has(e.id) && e.position.distanceTo(bot.entity.position) <= radius && allowed(e))
      if (left.length) return fail(`no animal I can get to within ${radius} blocks: ${left.length} ${left.length === 1 ? left[0]!.name : 'animals'} I couldn't reach a few minutes ago (trying again later)`)
      return fail(`no animal I may hunt within ${radius} blocks${animal ? ` (${animal})` : ''}${spared ? `, sparing the last ${keepAtLeast} of each kind` : ''}`)
    }
    await sleep(500, signal) // drops can arrive a moment after the last pickup walk
    const picked = Math.max(0, total() - before)
    const tally = [...new Set(names)].map(n => `${names.filter(x => x === n).length} ${n}`).join(', ')
    return ok(`hunted ${tally}, picked up ${picked} item${picked === 1 ? '' : 's'}${why}`)
  }
})

export const combat = () => defineSkill({
  name: 'combat',
  capabilities: ['move', 'combat'],
  description: 'Fighting hostile mobs, guarding players and hunting animals for food.',
  actions: [attack, guard, defend, retreat, hunt, gearUp, rangedDefense, waterBucket, defendPlayer, ...PVP_ACTION_DEFS],
  setup: (agent, bot) => {
    // remember who hit us: neutral mobs are fought only while they attack; players hitting
    // anyone are logged for combat.pvp defend
    const onHurt = (e: Entity, source?: Entity) => {
      if (e === bot.entity) noteAttacker(bot)
      try { notePlayerHit(bot, e, source) } catch {}
    }
    bot.on('entityHurt', onHurt as any)
    // projectiles flying at the bot and hits from range (ranged.ts)
    const unwatch = installRangedWatch(bot)
    // an axe hit on the raised shield disables it for 5 s (fight.ts reads this)
    const unshield = installShieldWatch(bot)
    // never look an enderman in the eyes unless it is already fighting us (combat.endermanGaze)
    const ungaze = installGazeGuard(bot, () => ((agent.settings.combat ?? {}) as { endermanGaze?: boolean }).endermanGaze !== false, id => recentAttacker(bot, id))
    // PvP modes: grudges, kill counts, last-seen positions for hunts, mode-change whispers (pvp-actions.ts)
    const unpvp = installPvp(agent, bot, () => escorting(agent))
    return () => { bot.off('entityHurt', onHurt as any); unwatch(); unshield(); ungaze(); unpvp() }
  },
  observe: (_agent, bot) => {
    const mob = threats(bot, 16)[0] ?? nearestHostile(bot, bot.entity.position, 16)
    return { nearestHostile: mob ? { name: mob.name, distance: Math.round(mob.position.distanceTo(bot.entity.position)) } : null, armour: wornArmorPoints(bot) }
  }
})
