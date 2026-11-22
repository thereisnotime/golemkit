// Bodyguard skill: protect (stay with a player and fight what threatens them) and feed_player
// (toss food to a hurt player). The decisions are pure and tested (guard-plan.ts); this file
// reads the world into them and runs the fight loop (fight.ts) against the chosen target.
// The bodyguard behaviour (brains/behaviors/library/bodyguard.ts) arms it; reflexes and
// stay_safe read escorting() so they don't pull the bot away from the player.
import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import type { Agent } from '../core/index.ts'
import { defineSkill, defineAction, z, ok, fail, goals, isHostile, FLYING, sleep, checkAborted, ActionAbortedError } from '../core/index.ts'
import { fightTarget, creeperFuseLit, eatNow } from './fight.ts'
import { combatRefusal, recentAttacker } from './combat.ts'
import { weaponFlags, hasRanged, readyShield, isRangedMob } from './weapons.ts'
import { rankGuardThreats, guardSpot, blockSpot, feedDecision, motion, facingTowards, shouldRetarget, inLineOfFire, velocityOf, etaToPlayer, interceptPoint, pullPlan, type GuardThreat, type Sample, type FoodItem, type V3 } from './guard-plan.ts'
import { gearPlan, hasGearUpgrade, equipGear } from './gear.ts'

const EYE = 1.62
const HURT_MS = 8000
const BAD_FOOD = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'suspicious_stew', 'chorus_fruit'])

// ---- escort state: who the bodyguard is with right now ----

interface Escort { player: string, at: number, lastSeen: (V3 & { dimension?: string }) | null }
const escorts = new WeakMap<object, Escort>()

/** Marks that the bot is guarding `player` (called every tick by the bodyguard behaviour while the player is online). */
export function setEscort (agent: object, player: string, seenAt?: V3, dimension?: string): void {
  const prev = escorts.get(agent)
  escorts.set(agent, {
    player,
    at: Date.now(),
    lastSeen: seenAt ? { x: seenAt.x, y: seenAt.y, z: seenAt.z, dimension } : (prev?.player === player ? prev.lastSeen : null)
  })
}

/** The player the bot is guarding, while the bodyguard behaviour is armed and they are online (fresh within 5 s), else null. */
export function escorting (agent: object): string | null {
  const e = escorts.get(agent)
  return e && Date.now() - e.at < 5000 ? e.player : null
}

/** Where the bodyguard last saw `player` (default: whoever it guarded last), if it did. */
export function lastSeen (agent: object, player?: string): (V3 & { dimension?: string }) | null {
  const e = escorts.get(agent)
  if (!e) return null
  return !player || e.player.toLowerCase() === player.toLowerCase() ? e.lastSeen : null
}

// ---- who hurt whom (damage events carry the source; arrows report the shooter) ----

interface HurtLog { players: Map<string, number>, attackers: Map<number, number>, mine: Map<number, number>, lastFed: Map<string, number> }
const logs = new WeakMap<Bot, HurtLog>()
function hurtLog (bot: Bot): HurtLog {
  let l = logs.get(bot)
  if (!l) logs.set(bot, l = { players: new Map(), attackers: new Map(), mine: new Map(), lastFed: new Map() })
  return l
}

/** Notes a hurt player and who did it: the damage source, else the nearest mob within 4 blocks of them. */
export function noteHurt (bot: Bot, entity: Entity | undefined, source: Entity | undefined): void {
  if (!entity) return
  if (entity === bot.entity) {
    // the bot's own attackers by damage source: an archer far off isn't caught by combat.ts's 4.5-block guess
    if (source && source.type !== 'player') hurtLog(bot).mine.set(source.id, Date.now())
    return
  }
  if (entity.type !== 'player') return
  const name = (entity as any).username as string | undefined
  if (!name) return
  const l = hurtLog(bot)
  l.players.set(name, Date.now())
  let by = source && source.type !== 'player' ? source : undefined
  if (!by) {
    by = bot.nearestEntity(e => e !== bot.entity && e.type !== 'player' && e.type !== 'object' && e.type !== 'orb' &&
      e.position.distanceTo(entity.position) < 4) ?? undefined
  }
  if (by) l.attackers.set(by.id, Date.now())
}

function hurtPlayerRecently (bot: Bot, id: number): boolean {
  const t = hurtLog(bot).attackers.get(id)
  return !!t && Date.now() - t < HURT_MS
}

/** The player's health from entity metadata, or null when the server doesn't send it. */
export function playerHealth (bot: Bot, e: Entity): number | null {
  const keys = (bot.registry as any).entitiesByName?.player?.metadataKeys as string[] | undefined
  const i = keys?.indexOf('health') ?? -1
  const v = ((e as any).metadata as unknown[] | undefined)?.[i >= 0 ? i : 9]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

// ---- reading threats ----

const samples = new WeakMap<Bot, Map<number, Sample>>()
const velocities = new WeakMap<Bot, Map<number, { x: number, z: number }>>()

/** A mob's horizontal velocity (blocks per second) from playerThreats' samples, or null. */
export function mobVelocity (bot: Bot, id: number): { x: number, z: number } | null {
  return velocities.get(bot)?.get(id) ?? null
}

/** Raycast between two points (blocks only). */
function clearLine (bot: Bot, from: any, to: any): boolean {
  try {
    const d = to.minus(from)
    const len = d.norm()
    if (len < 0.5) return true
    return !(bot.world as any).raycast(from, d.normalize(), len)
  } catch { return true }
}

export type ThreatEntry = GuardThreat & { e: Entity, reason: string, score: number }

/**
 * Mobs threatening `player` (or the bot) within range + 8 of them, ranked by guard-plan. Never
 * includes players, villagers, golems, pets or named mobs; neutral mobs only when they attack.
 * `eta: false` leaves out the reaches-the-player-first ordering (protect with intercept off).
 */
export function playerThreats (bot: Bot, player: Entity, range: number, opts: { eta?: boolean } = {}): ThreatEntry[] {
  let seen = samples.get(bot)
  if (!seen) samples.set(bot, seen = new Map())
  let vels = velocities.get(bot)
  if (!vels) velocities.set(bot, vels = new Map())
  const now = Date.now()
  const pp = player.position
  const eye = pp.offset(0, EYE, 0)
  const list: (GuardThreat & { e: Entity })[] = []
  const alive = new Set<number>()
  for (const e of Object.values(bot.entities)) {
    if (e === bot.entity || e === player || !e.position || e.type === 'player' || e.type === 'object' || e.type === 'orb') continue
    const distPlayer = e.position.distanceTo(pp)
    if (distPlayer > range + 8) continue
    const hurtPlayer = hurtPlayerRecently(bot, e.id)
    if (combatRefusal(bot, e, hurtPlayer)) continue
    const hp = ((e as any).metadata as unknown[] | undefined)?.[9]
    if (typeof hp === 'number' && hp <= 0) continue
    alive.add(e.id)
    const flat = Math.hypot(e.position.x - pp.x, e.position.z - pp.z)
    const cur: Sample = { dist: distPlayer, y: e.position.y, flat, at: now, x: e.position.x, z: e.position.z }
    const prev = seen.get(e.id)
    const m = motion(prev, cur)
    const v = velocityOf(prev, cur)
    if (v) vels.set(e.id, v)
    if (!prev || now - prev.at >= 500) seen.set(e.id, cur)
    const ranged = isRangedMob(e.name)
    list.push({
      id: e.id,
      name: e.name ?? 'mob',
      distPlayer,
      distBot: e.position.distanceTo(bot.entity.position),
      losPlayer: ranged ? clearLine(bot, e.position.offset(0, (e.height ?? 1.8) * 0.85, 0), eye) : true,
      fuseLit: e.name === 'creeper' && creeperFuseLit(e),
      hostile: isHostile(e),
      hurtPlayer,
      hurtBot: recentAttacker(bot, e.id) || Date.now() - (hurtLog(bot).mine.get(e.id) ?? 0) < HURT_MS,
      approaching: m.approaching,
      facing: !FLYING.has(e.name ?? '') && facingTowards((e as any).headYaw ?? e.yaw, e.position, pp),
      diving: FLYING.has(e.name ?? '') && m.descending,
      eta: opts.eta === false ? undefined : etaToPlayer(prev, cur),
      e
    })
  }
  for (const id of seen.keys()) if (!alive.has(id)) { seen.delete(id); vels.delete(id) }
  return rankGuardThreats(list, range)
}

// ---- feeding ----

function foodItems (bot: Bot): (FoodItem & { type: number })[] {
  const foods = (bot.registry as any).foodsByName ?? {}
  const out = new Map<string, FoodItem & { type: number }>()
  for (const i of bot.inventory.items()) {
    if (!foods[i.name] || BAD_FOOD.has(i.name) || /golden_apple$/.test(i.name)) continue
    const f = out.get(i.name)
    if (f) f.count += i.count
    else out.set(i.name, { name: i.name, count: i.count, points: foods[i.name].foodPoints ?? 0, type: i.type })
  }
  return [...out.values()]
}

/** Tosses food at the player if feedDecision says so. Returns what it did, or null when it didn't. */
async function maybeFeed (agent: Agent, bot: Bot, who: string, pl: Entity, o: { keepFood: number, chat: boolean, force?: boolean }, threatClose: boolean, signal: AbortSignal): Promise<string | null> {
  const l = hurtLog(bot)
  const foods = foodItems(bot)
  const health = playerHealth(bot, pl)
  const d = feedDecision({
    playerHealth: o.force && health === null ? 1 : health,
    playerFood: null, // servers don't send other players' hunger
    distance: bot.entity.position.distanceTo(pl.position),
    foods,
    keepForSelf: o.keepFood,
    sinceLastFedMs: o.force ? Infinity : Date.now() - (l.lastFed.get(who) ?? 0),
    threatClose,
    lowHealth: o.force ? 20 : 10
  })
  if ('skip' in d) return null
  const item = foods.find(f => f.name === d.give)!
  checkAborted(signal)
  bot.pathfinder.setGoal(null)
  await bot.lookAt(pl.position.offset(0, 1.2, 0), true).catch(() => {})
  try {
    await bot.toss(item.type, null, d.count)
  } catch (e) {
    return null
  }
  l.lastFed.set(who, Date.now())
  const what = `${d.count} ${d.give.replace(/_/g, ' ')}`
  if (o.chat) agent.whisper(who, o.force ? `here, ${what}` : `you look hurt (${d.why}), tossed you ${what}`)
  return `tossed ${who} ${what} (${d.why})`
}

// ---- protect ----

/** Abort controller tied to the action signal, plus a watcher that aborts it on a condition. */
function subFight (signal: AbortSignal, check: () => string | null): { signal: AbortSignal, stop: () => void, why: () => string | null } {
  const ctl = new AbortController()
  let why: string | null = null
  const onAbort = () => ctl.abort(signal.reason)
  signal.addEventListener('abort', onAbort, { once: true })
  const timer = setInterval(() => {
    const w = check()
    if (w) { why = w; ctl.abort('retarget') }
  }, 200)
  return {
    signal: ctl.signal,
    stop: () => { clearInterval(timer); signal.removeEventListener('abort', onAbort) },
    why: () => why
  }
}

const protect = defineAction({
  name: 'protect',
  description: 'Stay with a player as a bodyguard until stopped: keep close (between them and the nearest danger), kill mobs ' +
    'that threaten them (creepers near them first, archers with a shot at them, diving phantoms, mobs coming for them or ' +
    'that hurt them), block arrows with a shield, and toss them food when they look hurt. Never attacks players, pets, ' +
    'villagers, golems or named mobs; neutral mobs only when they attack.',
  params: z.object({
    player: z.string().optional().describe('player to protect; defaults to the requesting player'),
    distance: z.number().min(1).max(8).default(3).describe('follow distance, blocks'),
    range: z.number().min(6).max(32).default(16).describe('protect this far around them'),
    feed: z.boolean().default(true).describe('toss food when their health is low (needs the server to send player health)'),
    keepFood: z.number().int().min(0).max(64).default(4).describe('food items to keep for itself'),
    chat: z.boolean().default(true).describe('short callouts in chat (fed you, ...)'),
    intercept: z.boolean().default(true).describe('meet a mob walking at the player 6-12 blocks out on its path instead of at the player'),
    pullAggro: z.boolean().default(true).describe('with two or more mobs on the player, hit each once and step off so they follow the bot')
  }),
  longRunning: true,
  async run ({ bot, agent, signal, player: caller, log }, p) {
    const who = p.player ?? caller
    if (!who) return fail('protect whom?')
    const flags = weaponFlags(agent)
    const blockUntil = new Map<number, number>() // archers we couldn't reach: block their shots instead
    let kills = 0
    let fed = 0
    let mode = ''
    const tagged = new Map<number, number>() // mobs the bot hit (they turn on it): id -> when
    let gearAt = 0
    // wear the best armour, shield and weapon it has before escorting, and again after a respawn
    // (the loop checks every few seconds, so gear handed over later goes on too)
    const gearUpNow = async () => {
      gearAt = Date.now()
      try {
        if (hasGearUpgrade(gearPlan(bot))) { const done = await equipGear(bot); if (done.length) log.info(`protect: put on ${done.join(', ')}`) }
      } catch {}
    }
    await gearUpNow()
    const player = () => bot.players[who]?.entity
    const setMode = (m: string) => { if (m !== mode) { mode = m; (m.startsWith('fighting') || m.startsWith('blocking') ? log.info : log.debug)(`protect: ${m}`) } }

    try {
      while (true) {
        checkAborted(signal)
        const pl = player()
        if (!pl) return ok(`lost sight of ${who}${kills ? ` (killed ${kills})` : ''}${fed ? `, fed ${fed}x` : ''}`)
        const ranked = playerThreats(bot, pl, p.range, { eta: p.intercept })
        const top = ranked[0]

        if (top) {
          const t = top.e
          const archer = isRangedMob(t.name)
          // archer we couldn't get to, or one shooting from far: stand in its line of fire behind a shield
          if (archer && top.losPlayer && !(flags.ranged && hasRanged(bot)) && (blockUntil.get(t.id) ?? 0) > Date.now()) {
            const b = blockSpot(pl.position, t.position)
            if (b?.covers && await readyShield(bot)) {
              setMode(`blocking ${t.name}`)
              bot.pathfinder.setGoal(new goals.GoalNear(b.spot.x, b.spot.y, b.spot.z, 0.5), true)
              const until = Date.now() + 1500
              while (Date.now() < until) {
                await bot.lookAt(t.position.offset(0, (t.height ?? 1.8) * 0.85, 0), true).catch(() => {})
                if (!bot.usingHeldItem) bot.activateItem(true)
                await sleep(100, signal)
              }
              bot.deactivateItem()
              continue
            }
          }
          // a flyer: stand by the player and swing when it dives into reach
          if (FLYING.has(t.name ?? '') && bot.entity.position.distanceTo(pl.position) > 4) {
            setMode('closing up for a flyer')
            bot.pathfinder.setGoal(new goals.GoalFollow(pl, 2), true)
            await sleep(250, signal)
            continue
          }
          // pull aggro: two or more mobs on the player, hit each once so they turn on the bot, then step
          // away from the player so they follow
          const now = Date.now()
          for (const [id, at] of tagged) if (now - at > 6000) tagged.delete(id)
          const pull = p.pullAggro ? pullPlan(ranked.map(x => ({ id: x.id, name: x.name, pos: x.e.position, distPlayer: x.distPlayer, hurtPlayer: x.hurtPlayer, approaching: x.approaching })), pl.position, bot.entity.position, new Set(tagged.keys())) : null
          if (pull) {
            const m = ranked.find(x => x.id === pull.id)!.e
            setMode(`pulling ${m.name} off ${who}`)
            let r
            try {
              r = await fightTarget(bot, m, signal, { maxMs: 4000, flags: { ...flags, maxChase: p.range }, stopAfterHits: 1 })
            } catch (e) { if (signal.aborted || !(e instanceof ActionAbortedError)) throw e }
            if (r?.hits) tagged.set(m.id, Date.now())
            if (r?.killed) kills++
            // all of them tagged: walk off the player so they follow
            const rest = pullPlan(ranked.map(x => ({ id: x.id, name: x.name, pos: x.e.position, distPlayer: x.distPlayer, hurtPlayer: x.hurtPlayer, approaching: x.approaching })), pl.position, bot.entity.position, new Set(tagged.keys()))
            if (!rest) {
              bot.pathfinder.setGoal(new goals.GoalNear(pull.spot.x, pull.spot.y, pull.spot.z, 1), true)
              await sleep(1200, signal)
              bot.pathfinder.setGoal(null)
            }
            continue
          }
          // intercept: a mob 6-12 out walking at the player is met on its path, not at the player
          if (p.intercept && top.reason === 'intercept' && t.position.distanceTo(bot.entity.position) > 4) {
            const at = interceptPoint(pl.position, t.position, mobVelocity(bot, t.id), bot.entity.position)
            setMode(`intercepting ${t.name}`)
            bot.pathfinder.setGoal(new goals.GoalNear(at.x, at.y, at.z, 1), true)
            const until = Date.now() + 1500
            while (Date.now() < until && t.position.distanceTo(bot.entity.position) > 4 && (t as any).isValid !== false) await sleep(100, signal)
            bot.pathfinder.setGoal(null)
          }
          setMode(`fighting ${t.name} (${top.reason})`)
          bot.pathfinder.setGoal(null)
          let reranked = Date.now()
          const sub = subFight(signal, () => {
            const q = player()
            if (!q) return 'player gone'
            if (t.position.distanceTo(q.position) > p.range + 6) return 'too far from the player'
            if (bot.entity.position.distanceTo(q.position) > p.range + 8) return 'drifted from the player'
            if (t.name !== 'creeper') {
              const c = bot.nearestEntity(e => e.name === 'creeper' && isHostile(e) && e.position.distanceTo(q.position) <= 6)
              if (c && c.id !== t.id) return 'creeper by the player'
            }
            // something more urgent came up (a zombie hitting the player while we chase an archer)
            if (Date.now() - reranked >= 600) {
              reranked = Date.now()
              const next = shouldRetarget(t.id, playerThreats(bot, q, p.range, { eta: p.intercept }))
              if (next) return 'a more urgent threat'
            }
            return null
          })
          let r
          try {
            // never shoot past or through the player
            const holdFire = (e: Entity) => {
              const q = player()
              return !!q && inLineOfFire(bot.entity.position.offset(0, EYE, 0), e.position.offset(0, (e.height ?? 1.8) * 0.5, 0), q.position)
            }
            r = await fightTarget(bot, t, sub.signal, { maxMs: archer || FLYING.has(t.name ?? '') ? 20_000 : 12_000, flags: { ...flags, maxChase: p.range }, holdFire })
          } catch (e) {
            if (signal.aborted || !(e instanceof ActionAbortedError)) throw e
            r = null // the watcher stopped it: re-rank
          } finally {
            sub.stop()
          }
          if (!r) continue
          if (r.hits) tagged.set(t.id, Date.now())
          if (r.killed) { kills++; continue }
          if (r.end === 'outnumbered') return fail(`outnumbered (${r.reason}); letting the escape rules take over`)
          if (r.end === 'heal') {
            // step behind the player (away from the mob), eat, come back
            const dx = pl.position.x - t.position.x
            const dz = pl.position.z - t.position.z
            const f = Math.hypot(dx, dz) || 1
            bot.pathfinder.setGoal(new goals.GoalNear(pl.position.x + dx / f * 3, pl.position.y, pl.position.z + dz / f * 3, 1), true)
            await sleep(2500, signal)
            bot.pathfinder.setGoal(null)
            await eatNow(bot, signal)
            continue
          }
          if (archer && (r.end === 'gave_up' || r.end === 'timeout')) blockUntil.set(t.id, Date.now() + 20_000)
          await sleep(200, signal)
          continue
        }

        // quiet: gear (after a respawn), feed, then stand between the player and the nearest hostile, or just follow
        if (Date.now() - gearAt > 5000) await gearUpNow()
        if (p.feed) {
          const done = await maybeFeed(agent, bot, who, pl, { keepFood: p.keepFood, chat: p.chat }, false, signal)
          if (done) { fed++; log.info(done) }
        }
        const watch = bot.nearestEntity(e => isHostile(e) && !combatRefusal(bot, e) && e.position.distanceTo(pl.position) <= p.range + 8)
        const spot = watch && !FLYING.has(watch.name ?? '') ? guardSpot(pl.position, watch.position, p.distance) : null
        if (spot) {
          setMode(`between ${who} and ${watch!.name}`)
          bot.pathfinder.setGoal(new goals.GoalNear(spot.x, spot.y, spot.z, 1), true)
        } else {
          setMode(`following ${who}`)
          if (bot.entity.position.distanceTo(pl.position) > p.distance + 0.5) bot.pathfinder.setGoal(new goals.GoalFollow(pl, p.distance), true)
        }
        await sleep(300, signal)
      }
    } finally {
      bot.pathfinder.setGoal(null)
      try { bot.deactivateItem() } catch {}
    }
  }
})

const feedPlayer = defineAction({
  name: 'feed_player',
  capabilities: ['move', 'inventory'],
  description: 'Walk up to a player and toss them food from the inventory (the best food, 1-2 items), keeping some for itself.',
  params: z.object({
    player: z.string().optional().describe('who to feed; defaults to the requesting player'),
    keepFood: z.number().int().min(0).max(64).default(4).describe('food items to keep for itself')
  }),
  async run ({ bot, agent, signal, player: caller }, { player, keepFood }) {
    const who = player ?? caller
    if (!who) return fail('feed whom?')
    const pl = bot.players[who]?.entity
    if (!pl) return fail(`can't see ${who}`)
    if (bot.entity.position.distanceTo(pl.position) > 3.5) {
      bot.pathfinder.setGoal(new goals.GoalFollow(pl, 2), true)
      const until = Date.now() + 15_000
      while (Date.now() < until && bot.entity.position.distanceTo(pl.position) > 3.5) await sleep(250, signal)
      bot.pathfinder.setGoal(null)
    }
    const total = foodItems(bot).reduce((n, f) => n + f.count, 0)
    const r = await maybeFeed(agent, bot, who, pl, { keepFood, chat: false, force: true }, false, signal)
    if (r) return ok(r)
    return fail(total <= keepFood ? `not enough food to share (${total}, keeping ${keepFood})` : `couldn't get close enough to ${who}`)
  }
})

export const guardSkill = () => defineSkill({
  name: 'bodyguard',
  capabilities: ['move', 'combat'],
  description: 'Protecting a player: stay with them, fight what threatens them, block arrows, feed them.',
  actions: [protect, feedPlayer],
  setup: (_agent, bot) => {
    const onHurt = (e: Entity, source?: Entity) => { try { noteHurt(bot, e, source) } catch {} }
    bot.on('entityHurt', onHurt as any)
    return () => { bot.off('entityHurt', onHurt as any) }
  }
})
