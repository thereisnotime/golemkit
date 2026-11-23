// Death causes for one session: feeds the core DeathCauseTracker from the bot (who hurt it, or
// lava/fire/drowning/starvation/fall when nothing did, the server's death message) and hands the
// report to the adapter, which emits `deathCause`. Installed before the agent's own listeners so
// the action that held the body is still known at the death event.
import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import type { Agent } from '../../core/agent.ts'
import { DeathCauseTracker, type DeathReport } from '../../core/journal/deathReport.ts'
import { parseDeathMessage } from '../../core/journal/deathMessages.ts'
import { isHostile } from './helpers.ts'

function sourceName (e: Entity): string {
  if (e.type === 'player') return e.username ?? 'player'
  return e.name ?? (e.displayName as string | undefined) ?? 'unknown'
}

export function watchDeaths (bot: Bot, agent: Agent, emit: (r: DeathReport) => void): () => void {
  const tracker = new DeathCauseTracker()
  let lastSourceAt = 0
  let health = 20
  let healthBefore = 20
  let airTop: number | null = null
  let landedFrom = 0 // blocks fallen in the last landing
  let landedAt = 0

  const envSource = (): string => {
    const e = bot.entity as any
    if (!e) return 'unknown'
    if (e.isInLava) return 'lava'
    const flags = e.metadata?.[0]
    if (typeof flags === 'number' && flags & 1) return 'fire'
    if (typeof (bot as any).oxygenLevel === 'number' && (bot as any).oxygenLevel <= 0) return 'drowning'
    if (Date.now() - landedAt < 1000 && landedFrom > 3) return 'fall'
    if (bot.food === 0) return 'starvation'
    return 'unknown'
  }

  const onHurt = (e: Entity, source?: Entity) => {
    if (e !== bot.entity) return
    if (source) { lastSourceAt = Date.now(); tracker.hurt(sourceName(source)) } else tracker.hurt(envSource())
  }
  const onHealth = () => {
    const h = bot.health
    if (h < health && h >= 0 && Date.now() - lastSourceAt > 1500) {
      const src = envSource()
      if (src !== 'unknown') tracker.hurt(src)
    }
    if (h > 0) healthBefore = h
    health = h
  }
  const onMove = () => {
    const e = bot.entity as any
    if (!e) return
    const y = e.position.y
    if (e.onGround || e.isInWater || e.onClimbable) {
      if (airTop !== null && airTop - y > 0) { landedFrom = airTop - y; landedAt = Date.now() }
      airTop = null
    } else if (airTop === null || y > airTop) airTop = y
  }
  const onDeath = () => {
    const me = bot.entity
    const nearby = me
      ? [...new Set(Object.values(bot.entities).filter(x => x !== me && isHostile(x) && x.position.distanceTo(me.position) <= 8).map(sourceName))]
      : []
    const p = me?.position
    tracker.died({
      ...(agent.currentAction?.name ? { action: agent.currentAction.name } : {}),
      healthBefore,
      nearby,
      ...(p ? { position: { x: p.x, y: p.y, z: p.z } } : {})
    }, emit)
  }
  const onMessage = (text: string, position: string) => {
    if (position === 'chat') return
    const d = parseDeathMessage(text, bot.username)
    if (d) tracker.serverDeath(d)
  }
  const onSpawn = () => { health = bot.health || 20; healthBefore = health }

  bot.on('entityHurt', onHurt)
  bot.on('health', onHealth)
  bot.on('physicsTick', onMove)
  bot.on('death', onDeath)
  bot.on('messagestr', onMessage)
  bot.on('spawn', onSpawn)
  return () => {
    bot.off('entityHurt', onHurt)
    bot.off('health', onHealth)
    bot.off('physicsTick', onMove)
    bot.off('death', onDeath)
    bot.off('messagestr', onMessage)
    bot.off('spawn', onSpawn)
    tracker.dispose()
  }
}
