// The Mineflayer half of humanize (core/humanize.ts has the timing and styling): standing
// still while "typing", and idle glances.
import type { Bot } from 'mineflayer'

const MOVE_KEYS = ['forward', 'back', 'left', 'right', 'jump', 'sprint'] as const

/**
 * Holds the bot still (and optionally facing a point) for `ms`, without touching the
 * pathfinder's goal, so a running goto/follow just carries on afterwards.
 */
export async function holdStill (bot: Bot, ms: number, face?: { x: number, y: number, z: number }): Promise<void> {
  const origSet = bot.setControlState.bind(bot)
  const origLook = bot.look.bind(bot)
  for (const k of MOVE_KEYS) origSet(k, false)
  ;(bot as any).setControlState = (control: string, state: boolean) => {
    if ((MOVE_KEYS as readonly string[]).includes(control)) return origSet(control as any, false)
    return origSet(control as any, state)
  }
  if (face) {
    try { await bot.lookAt(face as any, false) } catch {}
    ;(bot as any).look = async () => {}
  }
  try {
    await new Promise(r => setTimeout(r, ms))
  } finally {
    ;(bot as any).setControlState = origSet
    ;(bot as any).look = origLook
  }
}

/** An idle glance: at a player within 10 blocks (60%), else a random turn, never up at an enderman. */
export function fidget (bot: Bot): void {
  const near = bot.nearestEntity(e => e.type === 'player' && e.position.distanceTo(bot.entity.position) < 10)
  if (near && Math.random() < 0.6) void bot.lookAt(near.position.offset(0, near.height ?? 1.6, 0)).catch(() => {})
  else void bot.look(bot.entity.yaw + (Math.random() - 0.5) * 1.6, bot.nearestEntity(e => e.name === 'enderman' && e.position.distanceTo(bot.entity.position) < 48) ? -0.7 : (Math.random() - 0.5) * 0.6) // never a random glance at an enderman.catch(() => {})
}
