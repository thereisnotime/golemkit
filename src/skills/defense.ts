// Player-facing defence and gaze discipline, wired by the combat skill:
//   - who hit whom among players (damage events carry the source), for combat.pvp defend
//   - defend_player: fight back against a player who attacked the bot (or the player it guards)
//     and stop when they stop or run (policy in pvp.ts)
//   - the enderman gaze guard (combat.endermanGaze): bot.look never points at an enderman's eyes
//     unless that enderman is already fighting the bot
import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import type { Agent } from '../core/index.ts'
import { defineAction, z, ok, fail, goals, sleep, checkAborted, ActionAbortedError } from '../core/index.ts'
import { fightTarget, eatNow, fightFood } from './fight.ts'
import { weaponFlags } from './weapons.ts'
import { pvpDecision, pvpRefusal, pvpMode, PVP_CALM_MS } from './pvp.ts'
import { avertGaze } from './techniques.ts'

// ---- player aggression log ----

interface Aggro { at: number, victim: string }
const aggro = new WeakMap<Bot, Map<string, Aggro>>()

/** Notes a player hitting another entity: `victim` is 'me' for the bot, else a username. */
export function notePlayerHit (bot: Bot, entity: Entity | undefined, source: Entity | undefined): void {
  if (!entity || !source || source.type !== 'player' || source === bot.entity) return
  const by = (source as any).username as string | undefined
  if (!by) return
  const victim = entity === bot.entity ? 'me' : (entity as any).username as string | undefined
  if (!victim) return
  let m = aggro.get(bot)
  if (!m) aggro.set(bot, m = new Map())
  m.set(by.toLowerCase(), { at: Date.now(), victim })
}

/**
 * ms since `player` last hit the bot or one of `protect` (the player it guards). Infinity when
 * never (or not within the log).
 */
export function sinceHit (bot: Bot, player: string, protect: readonly string[] = []): number {
  const a = aggro.get(bot)?.get(player.toLowerCase())
  if (!a) return Infinity
  const ok = a.victim === 'me' || protect.some(p => p.toLowerCase() === a.victim.toLowerCase())
  return ok ? Date.now() - a.at : Infinity
}

export function pvpSettings (agent: Agent): { mode: ReturnType<typeof pvpMode>, friends: string[] } {
  const c = (agent.settings.combat ?? {}) as { pvp?: unknown, friends?: unknown }
  return { mode: pvpMode(c.pvp), friends: Array.isArray(c.friends) ? c.friends.map(String) : [] }
}

/** Whether the bot may fight `player` back right now (combat.pvp defend, not an owner or friend). */
export function pvpAllowed (agent: Agent, bot: Bot, player: string): string | null {
  const { mode, friends } = pvpSettings(agent)
  const gm = (bot.players[player] as any)?.gamemode
  return pvpRefusal({ mode, player, owners: agent.owners, friends, invulnerable: gm === 1 || gm === 3 })
}

/** Abort controller tied to `signal`, aborted early when `check` returns a reason. */
function watched (signal: AbortSignal, check: () => string | null): { signal: AbortSignal, stop: () => void, why: () => string | null } {
  const ctl = new AbortController()
  let why: string | null = null
  const onAbort = () => ctl.abort(signal.reason)
  signal.addEventListener('abort', onAbort, { once: true })
  const timer = setInterval(() => { const w = check(); if (w) { why = w; ctl.abort('pvp stop') } }, 200)
  return { signal: ctl.signal, stop: () => { clearInterval(timer); signal.removeEventListener('abort', onAbort) }, why: () => why }
}

export const defendPlayer = defineAction({
  name: 'defend_player',
  capabilities: ['move', 'combat'],
  description: 'Fight back against a player who attacked this bot (or the player it guards), only with combat.pvp set to defend; ' +
    'stops as soon as they stop attacking or run. Never owners or friends, and never starts a fight (used by reflexes).',
  params: z.object({
    player: z.string().describe('the attacking player'),
    protect: z.string().optional().describe('the player the bot guards, whose attackers count too')
  }),
  internal: true,
  async run ({ bot, agent, signal }, { player, protect }) {
    const no = pvpAllowed(agent, bot, player)
    if (no) return fail(`won't fight ${player}: ${no}`)
    const guarded = protect ? [protect] : []
    if (sinceHit(bot, player, guarded) > PVP_CALM_MS) return fail(`${player} isn't attacking`)
    const flags = { ...weaponFlags(agent), ranged: false, maxChase: 8 } // no shots at someone backing off
    let hits = 0
    let why = ''
    const until = Date.now() + 120_000
    while (Date.now() < until) {
      checkAborted(signal)
      const target = bot.players[player]?.entity
      if (!target) { why = 'out of sight'; break }
      const state = () => {
        const t = bot.players[player]?.entity
        const { mode, friends } = pvpSettings(agent)
        const gm = (bot.players[player] as any)?.gamemode
        return pvpDecision({
          mode, player, owners: agent.owners, friends, invulnerable: gm === 1 || gm === 3,
          sinceHitMs: sinceHit(bot, player, guarded),
          dist: t ? t.position.distanceTo(bot.entity.position) : Infinity
        })
      }
      const d = state()
      if (d.act === 'stop') { why = d.why; break }
      const sub = watched(signal, () => { const s = state(); return s.act === 'stop' ? s.why : null })
      let r
      try {
        r = await fightTarget(bot, target, sub.signal, { maxMs: 30_000, flags, tactical: true })
      } catch (e) {
        if (signal.aborted || !(e instanceof ActionAbortedError)) throw e
        why = sub.why() ?? 'stopped'
        r = null
      } finally { sub.stop() }
      if (!r) break
      hits += r.hits
      if (bot.health <= 0) return fail(`died fighting ${player}`)
      if (r.end === 'heal') {
        // step off and eat; they may stop meanwhile
        bot.pathfinder.setGoal(new goals.GoalInvert(new goals.GoalFollow(target, 8)), true)
        await sleep(2500, signal).finally(() => bot.pathfinder.setGoal(null))
        if (fightFood(bot)) await eatNow(bot, signal)
        continue
      }
      if (r.end === 'retarget') { why = r.reason ?? 'something else came up'; break }
      if (r.end !== 'timeout') { why = r.reason ?? r.end; break }
    }
    return ok(`stopped fighting ${player}: ${why || 'time up'}${hits ? ` (${hits} hits)` : ''}`)
  }
})

// ---- enderman gaze ----

/**
 * Wraps bot.look so the gaze never meets an enderman's eyes (it turns hostile when looked at)
 * unless the enderman is in `fighting` (already hostile). Returns the remover.
 */
export function installGazeGuard (bot: Bot, enabled: () => boolean, fighting: (id: number) => boolean): () => void {
  const orig = bot.look
  const guarded = async (yaw: number, pitch: number, force?: boolean) => {
    try {
      if (enabled() && bot.entity && bot.inventory.slots[5]?.name !== 'carved_pumpkin') {
        const me = bot.entity.position
        const ends: { x: number, y: number, z: number }[] = []
        for (const e of Object.values(bot.entities)) {
          if (e.name !== 'enderman' || fighting(e.id)) continue
          if (e.position.distanceTo(me) > 64) continue
          ends.push(e.position)
        }
        if (ends.length) {
          const eye = { x: me.x, y: me.y + 1.62, z: me.z }
          const p = avertGaze(eye, yaw, pitch, ends)
          if (p !== null) pitch = p
        }
      }
    } catch {}
    return orig.call(bot, yaw, pitch, force)
  }
  bot.look = guarded as any
  return () => { if (bot.look === (guarded as any)) bot.look = orig }
}
