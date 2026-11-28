// Off the death screen: mineflayer asks to respawn once on the death event, and only when its
// isAlive flag says so. A bot that logs in dead (health 0 at login) or whose one ask got lost sat
// on the death screen with nothing running. This watcher reads health from login on, asks again
// every few seconds while dead (core/respawnPlan.ts decides) and reconnects as a last resort.
import type { Bot } from 'mineflayer'
import { respawnDecision, respawnObserve, respawnSettings, RESPAWN_INITIAL, type RespawnState } from '../../core/respawnPlan.ts'
import type { Logger } from '../../core/log.ts'

export interface RespawnWatchOptions {
  log: Logger
  settings: () => unknown
  /** Ends the session so the agent reconnects. */
  reconnect: (why: string) => void
  tickMs?: number
  now?: () => number
}

/** Sends the respawn request whatever mineflayer's isAlive flag says (it may still read true). */
export function requestRespawn (bot: Bot): void {
  const b = bot as Bot & { supportFeature: (f: string) => boolean, _client: { write: (n: string, p: unknown) => void } }
  b._client.write('client_command', b.supportFeature('respawnIsPayload') ? { payload: 0 } : { actionId: 0 })
}

/** Starts watching; returns the stop function. Call right after createBot (before login). */
export function watchRespawn (bot: Bot, opts: RespawnWatchOptions): () => void {
  const now = opts.now ?? Date.now
  let s: RespawnState = RESPAWN_INITIAL
  let first = true
  let stopped = false
  const tick = () => {
    if (stopped) return
    const d = respawnDecision(s, now(), respawnSettings(opts.settings()))
    if (d.action === 'respawn') {
      const atLogin = first && s.tries === 0
      opts.log.info(atLogin
        ? `dead at login (health ${s.health}), respawning`
        : `dead (health ${s.health}), respawning${d.attempt > 1 ? ` (try ${d.attempt})` : ''}`)
      s = { ...s, tries: s.tries + 1, lastTry: now() }
      try { requestRespawn(bot) } catch (e) { opts.log.warn(`respawn request failed: ${(e as Error).message}`) }
    } else if (d.action === 'reconnect') {
      opts.log.warn(`still dead after ${s.tries} respawn requests, reconnecting`)
      stop()
      opts.reconnect('stuck on the death screen')
    }
  }
  const onHealth = (packet: { health?: number }) => {
    const h = typeof packet?.health === 'number' ? packet.health : null
    const wasDead = s.deadSince !== null
    s = respawnObserve(s, h, now())
    if (wasDead && s.deadSince === null) opts.log.info(`respawned (health ${h})`)
    if (h !== null && h > 0) first = false
    tick()
  }
  const client = (bot as unknown as { _client: { on: (e: string, f: (p: any) => void) => void, off: (e: string, f: (p: any) => void) => void } })._client
  // after mineflayer's own listener: it sends its one ask first; ours goes when it didn't (isAlive)
  client.on('update_health', onHealth)
  const timer = setInterval(tick, opts.tickMs ?? 1000)
  ;(timer as { unref?: () => void }).unref?.()
  const stop = () => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
    client.off('update_health', onHealth)
  }
  bot.once('end', stop)
  return stop
}
