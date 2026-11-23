// PvP modes beyond self-defence (policy in pvp.ts, fight technique in pvp-fight.ts):
//   !pvp [off|defend|revenge|targets|all]   mode (no word: status); "off" is the kill switch
//   !attack_player Bob / !spare_player Bob / !hunt_player Bob   the target list (combat.targets)
//   !pvp_list                                 mode, targets, grudges (revenge) and hunts
// pvp_engage (internal) is what the reflexes start when an allowed player comes in range.
// Only owners change any of it (an LLM or NPC brain can't start PvP); anyone may make it more
// peaceful: !pvp off, !pvp to a lower mode (defend when it was revenge), !spare_player, "stop attacking".
// The bot whispers mode changes to the owners online and says nothing in public unless
// combat.taunts is on. Grudges and hunts are kept in storage (pvp.revenge, pvp.hunts).
import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import type { Agent, ActionContext } from '../core/index.ts'
import { defineAction, z, ok, fail, goals, gotoTimed, sleep, checkAborted, ActionAbortedError, parseDeathMessage } from '../core/index.ts'
import {
  pvpSettings, pvpMode, aggressive, aggression, addRevenge, pruneRevenge, revengeKill, revengeWorthy, pickPvpTarget,
  duelOdds, engageCheck, spared, modeLine, deescalates, tauntLine, minutesLeft, PVP_MODES,
  type PvpMode, type RevengeEntry, type Fighter, type AggroWhy, type Candidate, type PvpSettings
} from './pvp.ts'
import { reengage } from './pvp-tactics.ts'
import { fightPlayer, healthOf, heldOf, offhandOf } from './pvp-fight.ts'
import { fightTarget, eatNow, fightFood, lineOfSight } from './fight.ts'
import { weaponFlags, bestMeleeDamage } from './weapons.ts'
import { wornArmorPoints } from './gear.ts'
import { armorScore } from './tactics.ts'

const REVENGE_KEY = 'pvp.revenge'
const HUNTS_KEY = 'pvp.hunts'
/** Actions that are a fight with a player (the kill switch ends them). */
export const PVP_ACTIONS = new Set(['pvp_engage', 'hunt_player', 'defend_player'])

export function pvpConfig (agent: Agent): PvpSettings {
  return pvpSettings(agent.settings.combat as Record<string, unknown> | undefined)
}

// ---- storage ----

export function revengeList (agent: Agent): RevengeEntry[] {
  const raw = agent.storage.get<RevengeEntry[]>(REVENGE_KEY, [])
  const c = pvpConfig(agent)
  const list = pruneRevenge(Array.isArray(raw) ? raw : [], Date.now(), agent.owners, c.friends)
  if (list.length !== raw.length) agent.storage.set(REVENGE_KEY, list)
  return list
}
function saveRevenge (agent: Agent, list: RevengeEntry[]): void { agent.storage.set(REVENGE_KEY, list) }

export function huntList (agent: Agent): string[] {
  const h = agent.storage.get<string[]>(HUNTS_KEY, [])
  return Array.isArray(h) ? h : []
}
function setHunts (agent: Agent, list: string[]): void { agent.storage.set(HUNTS_KEY, list) }

/** Records an offence against the bot, an owner or the guarded player (revenge/targets/all only). */
export function noteOffence (agent: Agent, player: string, why: 'killed' | 'attacked', victim: string, guarded?: string | null): boolean {
  const c = pvpConfig(agent)
  if (!revengeWorthy({ mode: c.mode, victim, self: agent.username, owners: agent.owners, guarded })) return false
  const before = revengeList(agent)
  const list = addRevenge(before, { player, why, victim, now: Date.now(), minutes: c.revengeMinutes, owners: agent.owners, friends: c.friends, self: agent.username })
  const fresh = !before.some(e => e.player.toLowerCase() === player.toLowerCase())
  saveRevenge(agent, list)
  if (fresh && list.length > before.length) {
    agent.log.info(`grudge: ${player} ${why} ${victim}`)
    tellOwners(agent, `remembering ${player}: ${why} ${victim === 'me' ? 'me' : victim} (${c.revengeMinutes} min or ${c.revengeKills} kill${c.revengeKills === 1 ? '' : 's'})`)
  }
  return true
}

/** The bot killed `player`: counts against their grudge (forgiven after combat.revengeKills). */
export function noteKill (agent: Agent, player: string): void {
  const c = pvpConfig(agent)
  const r = revengeKill(revengeList(agent), player, c.revengeKills)
  saveRevenge(agent, r.list)
  if (r.forgiven) tellOwners(agent, `${player} is forgiven`)
  if (c.taunts) agent.say(tauntLine(Date.now() / 1000))
}

// ---- owners ----

const lastBy = new WeakMap<Agent, string>()

/** Whispers every owner online (never public). */
export function tellOwners (agent: Agent, text: string): void {
  if (!agent.inSession) return
  const online = agent.adapter.players?.() ?? []
  for (const p of online) if (agent.isOwner(p) && p !== agent.username) agent.whisper(p, text)
}

/** Owners only (and the system, for tests and benchmarks): brains can't start PvP. */
function ownerOnly (ctx: ActionContext): string | null {
  if (ctx.caller.kind === 'player') return ctx.agent.isOwner(ctx.caller.name) ? null : 'only my owners can change who I fight'
  if (ctx.caller.kind === 'system') return null
  return 'only an owner can change who I fight'
}
const byOf = (ctx: ActionContext) => ctx.caller.kind === 'player' ? ctx.caller.name : ctx.caller.kind

function setMode (agent: Agent, mode: PvpMode, by: string): boolean {
  if (pvpConfig(agent).mode === mode) return false
  lastBy.set(agent, by)
  agent.setToggle('combat.pvp', mode)
  return true
}

/**
 * The kill switch ("pax stop", "!pvp off"): ends every fight with a player and every hunt, and an
 * aggressive mode drops to off (defend stays, it only answers attacks). Returns a summary.
 */
export function killSwitch (agent: Agent, by: string, forceOff = false): string {
  const hunts = huntList(agent).length
  setHunts(agent, [])
  const n = agent.cancelActions(i => PVP_ACTIONS.has(i.name), 'pvp stop')
  const mode = pvpConfig(agent).mode
  const off = (forceOff || aggressive(mode)) && setMode(agent, 'off', by)
  return [off ? 'PvP off' : '', n ? `ended ${n} fight${n === 1 ? '' : 's'}` : '', hunts ? `cleared ${hunts} hunt${hunts === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ')
}

// ---- reading fighters ----

function armorOf (items: (string | null | undefined)[]): number {
  return Math.min(20, items.reduce<number>((n, it) => n + (it ? armorScore({ name: it })?.score ?? 0 : 0), 0))
}

export function fighterOf (bot: Bot, e?: Entity): Fighter {
  if (!e) {
    const names = bot.inventory.items().map(i => i.name)
    return {
      health: bot.health, armor: wornArmorPoints(bot), damage: bestMeleeDamage(names), speed: 1.6,
      shield: bot.inventory.slots[45]?.name === 'shield' || names.includes('shield'),
      totem: names.includes('totem_of_undying') || bot.inventory.slots[45]?.name === 'totem_of_undying',
      apples: bot.inventory.items().filter(i => /golden_apple$/.test(i.name)).reduce((n, i) => n + i.count, 0)
    }
  }
  const eq = ((e as any).equipment ?? []) as ({ name: string } | undefined)[]
  const held = heldOf(e)
  // we only see what they hold: assume at least a stone sword's worth
  return {
    health: healthOf(e), armor: armorOf([eq[2]?.name, eq[3]?.name, eq[4]?.name, eq[5]?.name]),
    damage: Math.max(5, bestMeleeDamage(held ? [held] : [])), speed: 1.6,
    shield: offhandOf(e) === 'shield', totem: offhandOf(e) === 'totem_of_undying'
  }
}

export function playerOdds (bot: Bot, e: Entity): number { return duelOdds(fighterOf(bot), fighterOf(bot, e)) }

/** Inside a learned protected area or the world spawn's protection. */
export function inProtected (agent: Agent, bot: Bot, p: { x: number, y: number, z: number }): boolean {
  if (agent.protectedAreas?.isProtected(p)) return true
  const sp = (bot as any).spawnPoint
  const r = Number((agent.settings.world as { spawnProtection?: number } | undefined)?.spawnProtection ?? 16)
  return !!sp && Math.max(Math.abs(sp.x - p.x), Math.abs(sp.z - p.z)) <= r
}

const gm = (bot: Bot, name: string) => (bot.players[name] as any)?.gamemode

/** Why the bot may attack `player` now (null: it may not). */
export function mayAttack (agent: Agent, bot: Bot, player: string): { attack: true, why: AggroWhy } | { attack: false, why: string } {
  const c = pvpConfig(agent)
  const e = bot.players[player]?.entity
  const g = gm(bot, player)
  return aggression({
    mode: c.mode, player, self: agent.username, owners: agent.owners, friends: c.friends, targets: c.targets, revenge: revengeList(agent),
    now: Date.now(), invulnerable: g === 1 || g === 3, inProtected: e ? inProtected(agent, bot, e.position) : false, spareProtected: c.spareProtected
  })
}

const cooling = new WeakMap<Agent, Map<string, number>>()
function cool (agent: Agent, player: string, ms = 60_000): void {
  let m = cooling.get(agent)
  if (!m) cooling.set(agent, m = new Map())
  m.set(player.toLowerCase(), Date.now() + ms)
}
const skipNote = new Map<string, number>()

/** The player the reflexes should engage now, if any (mode, lists, range, sight, odds). */
export function pvpCandidate (agent: Agent, bot: Bot): Candidate | null {
  const c = pvpConfig(agent)
  if (!aggressive(c.mode) || !bot.entity) return null
  const list: Candidate[] = []
  for (const [name, p] of Object.entries(bot.players)) {
    if (name === bot.username || !p.entity) continue
    const dist = p.entity.position.distanceTo(bot.entity.position)
    if (dist > c.engage) continue
    const a = mayAttack(agent, bot, name)
    if (!a.attack) continue
    list.push({ player: name, dist, why: a.why, visible: lineOfSight(bot, p.entity) })
  }
  const now = Date.now()
  const m = cooling.get(agent) ?? new Map<string, number>()
  const cold = new Set([...m].filter(([, until]) => until > now).map(([k]) => k))
  const pick = pickPvpTarget(list, c.engage, cold)
  if (!pick) return null
  const odds = playerOdds(bot, bot.players[pick.player]!.entity)
  const no = engageCheck({ why: pick.why, odds, minOdds: c.minOdds, revengeIgnoresOdds: c.revengeIgnoresOdds })
  if (no) {
    const k = `${agent.username}:${pick.player}`
    if ((skipNote.get(k) ?? 0) < now) { skipNote.set(k, now + 120_000); agent.log.info(`not engaging ${pick.player}: ${no}`) }
    cool(agent, pick.player, 30_000)
    return null
  }
  return pick
}

// ---- the engagement ----

/** Abort controller tied to `signal`, aborted early when `check` returns a reason. */
function watched (signal: AbortSignal, check: () => string | null): { signal: AbortSignal, stop: () => void, why: () => string | null } {
  const ctl = new AbortController()
  let why: string | null = null
  const onAbort = () => ctl.abort(signal.reason)
  signal.addEventListener('abort', onAbort, { once: true })
  const timer = setInterval(() => { const w = check(); if (w) { why = w; ctl.abort('pvp stop') } }, 200)
  return { signal: ctl.signal, stop: () => { clearInterval(timer); signal.removeEventListener('abort', onAbort) }, why: () => why }
}

export interface EngageResult { killed: boolean, hits: number, crits: number, why: string, extra?: Record<string, number> }

/**
 * Fights `player` while the policy allows it (`allowed` re-checked every 200 ms): the PvP loop
 * with combat.pvpTactics, else the mob loop. Backs off to heal when told to and comes back.
 */
export async function engagePlayer (ctx: ActionContext, player: string, allowed: () => string | null, maxMs = 180_000): Promise<EngageResult> {
  const { bot, agent, signal } = ctx
  const b = bot as Bot
  const c = pvpConfig(agent)
  const flags = { ...weaponFlags(agent), maxChase: c.chase }
  const totem = (agent.settings.combat as { totem?: boolean } | undefined)?.totem !== false
  const out: EngageResult = { killed: false, hits: 0, crits: 0, why: '' }
  const until = Date.now() + maxMs
  while (Date.now() < until) {
    checkAborted(signal)
    const target = b.players[player]?.entity
    if (!target) { out.why = 'out of sight'; break }
    const no = allowed()
    if (no) { out.why = no; break }
    const sub = watched(signal, allowed)
    let r
    try {
      r = c.tactics
        ? await fightPlayer(b, target, sub.signal, { flags, chase: c.chase, lostSec: c.lostSec, odds: () => playerOdds(b, target), totem, maxMs: 60_000 })
        : await fightTarget(b, target, sub.signal, { maxMs: 30_000, flags, tactical: true })
    } catch (e) {
      if (signal.aborted || !(e instanceof ActionAbortedError)) throw e
      out.why = sub.why() ?? 'stopped'
      r = null
    } finally { sub.stop() }
    if (!r) break
    out.hits += r.hits
    out.crits += r.crits
    const ex = out.extra ??= {}
    for (const k of ['sprints', 'blocks', 'apples', 'shieldBreaks', 'shots', 'totems'] as const) {
      const v = (r as unknown as Record<string, number | undefined>)[k]
      if (v) ex[k] = (ex[k] ?? 0) + v
    }
    if (b.health <= 0) { out.why = 'died'; break }
    if (r.end === 'killed') { out.killed = true; out.why = 'killed'; break }
    if (r.end === 'heal') {
      // step off, eat, and come back once healed (or when they follow us anyway)
      const t0 = Date.now()
      b.pathfinder.setGoal(new goals.GoalInvert(new goals.GoalFollow(target, 14)), true)
      try {
        while (Date.now() - t0 < 15_000) {
          checkAborted(signal)
          if (fightFood(b) && (target.position.distanceTo(b.entity.position) > 6 || b.health <= 4)) await eatNow(b, signal)
          if (reengage({ health: b.health, enemyHealth: healthOf(target) })) break
          await sleep(300, signal)
        }
      } finally { b.pathfinder.setGoal(null) }
      continue
    }
    if (r.end === 'timeout') continue
    out.why = r.reason ?? r.end
    cool(agent, player)
    break
  }
  if (out.killed) noteKill(agent, player)
  return out
}

const fmtEngage = (player: string, r: EngageResult) => `${r.killed ? `killed ${player}` : `stopped fighting ${player}: ${r.why || 'time up'}`}${r.hits ? ` (${r.hits} hits, ${r.crits} crits${Object.entries(r.extra ?? {}).map(([k, v]) => `, ${v} ${k}`).join('')})` : ''}`

const realName = (bot: Bot, name: string) => Object.keys(bot.players ?? {}).find(n => n.toLowerCase() === name.toLowerCase()) ?? name

export const pvpEngage = defineAction({
  name: 'pvp_engage',
  capabilities: ['move', 'combat'],
  description: 'Attack a player the PvP mode allows (revenge, targets or all; never owners, friends, creative players). Started by the reflexes.',
  params: z.object({ player: z.string() }),
  internal: true,
  async run (ctx, { player }) {
    const name = realName(ctx.bot as Bot, player)
    const check = () => { const a = mayAttack(ctx.agent, ctx.bot as Bot, name); return a.attack ? null : a.why }
    const no = check()
    if (no) return fail(`won't attack ${name}: ${no}`)
    const r = await engagePlayer(ctx, name, check)
    return ok(fmtEngage(name, r), r)
  }
})

// ---- owner commands ----

export const pvpCommand = defineAction({
  name: 'pvp',
  description: 'PvP mode (owners only; anyone may turn it off or lower it): off (never fight players; also ends every fight and hunt) | defend (only fight back) | revenge (also go after whoever killed or attacked us) | ' +
    'targets (attack players on the target list) | all (attack every player in range except owners and friends). No mode: show the mode, targets and grudges.',
  params: z.object({ mode: z.enum(PVP_MODES as [PvpMode, ...PvpMode[]]).optional() }),
  exclusive: false,
  anyone: true,
  run (ctx, { mode }) {
    if (!mode) return ownerOnly(ctx) ? fail('only my owners can see who I fight') : ok(statusLine(ctx.agent))
    if (mode === 'off') return ok(killSwitch(ctx.agent, byOf(ctx), true) || 'PvP was already off')
    // anyone may lower the mode; raising it is for owners
    const denied = deescalates(pvpConfig(ctx.agent).mode, pvpMode(mode)) ? null : ownerOnly(ctx)
    if (denied) return fail(denied)
    const changed = setMode(ctx.agent, pvpMode(mode), byOf(ctx))
    if (!aggressive(mode)) { ctx.agent.cancelActions(i => i.name === 'pvp_engage' || i.name === 'hunt_player', 'pvp mode'); setHunts(ctx.agent, []) }
    return ok(changed ? `PvP ${mode}` : `PvP was already ${mode}`)
  }
})

function targetsOf (agent: Agent): string[] { return pvpConfig(agent).targets }
function setTargets (agent: Agent, list: string[]): void {
  if (list.length) agent.setToggle('combat.targets', list.join(','))
  else agent.resetToggle('combat.targets')
}
/** Adds a target; switches off/defend/revenge to targets. Returns a refusal or a note. */
function addTarget (ctx: ActionContext, player: string): { error: string } | { note: string } {
  const c = pvpConfig(ctx.agent)
  const no = spared(player, ctx.agent.owners, c.friends)
  if (no) return { error: `${player} is ${no}: never` }
  if (player.toLowerCase() === ctx.agent.username.toLowerCase()) return { error: "that's me" }
  const list = targetsOf(ctx.agent)
  if (!list.some(t => t.toLowerCase() === player.toLowerCase())) setTargets(ctx.agent, [...list, player])
  const switched = c.mode !== 'targets' && c.mode !== 'all' && setMode(ctx.agent, 'targets', byOf(ctx))
  return { note: switched ? ' (PvP mode now targets)' : '' }
}

export const attackPlayer = defineAction({
  name: 'attack_player',
  description: 'Put a player on the PvP target list (owners only): attacked on sight from now on (switches PvP to targets mode if needed). Never owners or friends.',
  params: z.object({ player: z.string().min(1) }),
  exclusive: false,
  run (ctx, { player }) {
    const denied = ownerOnly(ctx)
    if (denied) return fail(denied)
    const name = realName(ctx.bot as Bot, player)
    const r = addTarget(ctx, name)
    if ('error' in r) return fail(r.error)
    return ok(`${name} is a target${r.note}`)
  }
})

export const sparePlayer = defineAction({
  name: 'spare_player',
  description: 'Take a player off the PvP target list and forgive any grudge against them, ending a fight or hunt with them.',
  params: z.object({ player: z.string().min(1) }),
  exclusive: false,
  anyone: true,
  run (ctx, { player }) {
    // anyone may make the bot more peaceful
    const n = player.toLowerCase()
    const t = targetsOf(ctx.agent)
    const r = revengeList(ctx.agent)
    const h = huntList(ctx.agent)
    const was = t.some(x => x.toLowerCase() === n) || r.some(x => x.player.toLowerCase() === n) || h.some(x => x.toLowerCase() === n)
    setTargets(ctx.agent, t.filter(x => x.toLowerCase() !== n))
    saveRevenge(ctx.agent, r.filter(x => x.player.toLowerCase() !== n))
    setHunts(ctx.agent, h.filter(x => x.toLowerCase() !== n))
    const ended = ctx.agent.cancelActions(i => PVP_ACTIONS.has(i.name) && String((i.params as { player?: string })?.player ?? '').toLowerCase() === n, 'spared')
    return ok(was || ended ? `leaving ${player} alone${ended ? ' (fight ended)' : ''}` : `${player} wasn't a target`)
  }
})

/** Last known position of a player: in sight, or noted while they were (this session). */
const seen = new WeakMap<Agent, Map<string, { pos: { x: number, y: number, z: number }, at: number }>>()
export function lastKnown (agent: Agent, bot: Bot, player: string): { x: number, y: number, z: number, at: number } | null {
  const e = bot.players[player]?.entity
  if (e) return { x: e.position.x, y: e.position.y, z: e.position.z, at: Date.now() }
  const s = seen.get(agent)?.get(player.toLowerCase())
  return s ? { ...s.pos, at: s.at } : null
}

export const huntPlayer = defineAction({
  name: 'hunt_player',
  capabilities: ['move', 'combat'],
  description: 'Hunt a player down (owners only): put them on the target list, go where they were last seen and fight them. Gives up after combat.huntMinutes; "stop" or "pvp off" ends it.',
  params: z.object({ player: z.string().min(1) }),
  longRunning: true,
  async run (ctx, { player }) {
    const denied = ownerOnly(ctx)
    if (denied) return fail(denied)
    const { agent, signal } = ctx
    const bot = ctx.bot as Bot
    const name = realName(bot, player)
    const r = addTarget(ctx, name)
    if ('error' in r) return fail(r.error)
    if (!huntList(agent).some(h => h.toLowerCase() === name.toLowerCase())) setHunts(agent, [...huntList(agent), name])
    const c = pvpConfig(agent)
    const until = Date.now() + c.huntMinutes * 60_000
    const check = () => { const a = mayAttack(agent, bot, name); return a.attack ? null : a.why }
    let total: EngageResult = { killed: false, hits: 0, crits: 0, why: '' }
    let unknownSince = 0
    try {
      while (Date.now() < until) {
        checkAborted(signal)
        if (!huntList(agent).some(h => h.toLowerCase() === name.toLowerCase())) return ok(`stopped hunting ${name}`)
        const no = check()
        if (no) return fail(`stopped hunting ${name}: ${no}`)
        const e = bot.players[name]?.entity
        if (e && e.position.distanceTo(bot.entity.position) <= Math.max(16, c.engage)) {
          const res = await engagePlayer(ctx, name, check)
          total = { killed: res.killed, hits: total.hits + res.hits, crits: total.crits + res.crits, why: res.why }
          if (res.killed) return ok(`hunted down ${name}${total.hits ? ` (${total.hits} hits)` : ''}`, total)
          await sleep(500, signal)
          continue
        }
        const at = lastKnown(agent, bot, name) ?? (agent.adapter.playerPosition?.(name) ?? null)
        if (!at) {
          if (!bot.players[name]) return fail(`${name} is offline`)
          if (!unknownSince) unknownSince = Date.now()
          if (Date.now() - unknownSince > 30_000) return fail(`don't know where ${name} is`)
          await sleep(2000, signal)
          continue
        }
        unknownSince = 0
        try { await gotoTimed(bot, new goals.GoalNear(at.x, at.y, at.z, 6), signal, 20_000) } catch (e) { if (signal.aborted) throw e }
        if (!bot.players[name]?.entity && bot.entity.position.distanceTo(bot.entity.position.clone().set(at.x, at.y, at.z)) < 8) {
          // nobody where they were: wait a moment for them to show up
          await sleep(1500, signal)
          if (!bot.players[name]?.entity) seen.get(agent)?.delete(name.toLowerCase())
        }
      }
      return ok(`gave up hunting ${name} after ${c.huntMinutes} min${total.hits ? ` (${total.hits} hits)` : ''}`)
    } finally {
      setHunts(agent, huntList(agent).filter(h => h.toLowerCase() !== name.toLowerCase()))
    }
  }
})

function statusLine (agent: Agent): string {
  const c = pvpConfig(agent)
  const now = Date.now()
  const grudges = revengeList(agent).map(e => `${e.player} (${e.why} ${e.victim}, ${minutesLeft(e.until, now)} min${e.kills ? `, ${e.kills} kills` : ''})`)
  const hunts = huntList(agent)
  return `PvP ${c.mode}; targets: ${c.targets.join(', ') || 'none'}; grudges: ${grudges.join(', ') || 'none'}; hunting: ${hunts.join(', ') || 'nobody'}`
}

export const pvpList = defineAction({
  name: 'pvp_list',
  description: 'Show the PvP mode, the target list, grudges (revenge: who, why, minutes left) and hunts.',
  params: z.object({}),
  exclusive: false,
  aliases: ['grudges'],
  run: ({ agent }) => ok(statusLine(agent))
})

export const PVP_ACTION_DEFS = [pvpEngage, pvpCommand, attackPlayer, sparePlayer, huntPlayer, pvpList]

// ---- session wiring ----

/**
 * Per session: grudges from death messages and hits, kill counts, last-seen positions for hunts,
 * and the owner whisper on every mode change (which also ends fights the new mode doesn't allow).
 * `guarded` names the player the bot guards, if any. Returns the clean-up.
 */
export function installPvp (agent: Agent, bot: Bot, guarded: () => string | null): () => void {
  const pos = new Map<string, { pos: { x: number, y: number, z: number }, at: number }>()
  seen.set(agent, pos)
  const tick = setInterval(() => {
    for (const [name, p] of Object.entries(bot.players ?? {})) {
      if (name === bot.username || !p.entity) continue
      pos.set(name.toLowerCase(), { pos: { x: p.entity.position.x, y: p.entity.position.y, z: p.entity.position.z }, at: Date.now() })
    }
  }, 2000)
  tick.unref?.()
  const onMessage = (text: string) => {
    try {
      const d = parseDeathMessage(text)
      if (!d?.killer) return
      const killer = Object.keys(bot.players).find(n => n === d.killer)
      if (d.killer === bot.username) {
        const c = pvpConfig(agent)
        if (revengeList(agent).some(e => e.player.toLowerCase() === d.victim.toLowerCase()) || c.targets.some(t => t.toLowerCase() === d.victim.toLowerCase())) noteKill(agent, d.victim)
        return
      }
      if (!killer) return // a mob
      const victim = d.victim === bot.username ? 'me' : d.victim
      noteOffence(agent, killer, 'killed', victim, guarded())
    } catch {}
  }
  const onHurt = (e: Entity, source?: Entity) => {
    try {
      if (!source || source.type !== 'player' || source === bot.entity) return
      const by = (source as any).username as string | undefined
      const victim = e === bot.entity ? 'me' : (e as any).username as string | undefined
      if (!by || !victim) return
      noteOffence(agent, by, 'attacked', victim, guarded())
    } catch {}
  }
  let mode = pvpConfig(agent).mode
  const onSettings = (key: string) => {
    if (key !== 'combat.pvp' && key !== '*' && !key.startsWith('combat')) return
    const now = pvpConfig(agent).mode
    if (now === mode) return
    const prev = mode
    mode = now
    const by = lastBy.get(agent) ?? null
    lastBy.delete(agent)
    agent.log.info(`pvp mode ${prev} -> ${now}${by ? ` by ${by}` : ''}`)
    tellOwners(agent, modeLine(now, by))
    if (!aggressive(now)) {
      setHunts(agent, [])
      agent.cancelActions(i => i.name === 'pvp_engage' || i.name === 'hunt_player' || (now === 'off' && i.name === 'defend_player'), 'pvp mode')
    }
  }
  bot.on('messagestr', onMessage)
  bot.on('entityHurt', onHurt as any)
  agent.on('settingsChanged', onSettings)
  return () => {
    clearInterval(tick)
    bot.off('messagestr', onMessage)
    bot.off('entityHurt', onHurt as any)
    agent.off('settingsChanged', onSettings)
  }
}
