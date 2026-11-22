// Watches digs for the server's refusals (spawn protection, claims): a refused break comes
// back as the old block within a moment. The agent then records a protected area
// (core/protection.ts) and the adapter re-plans around it.
import type { Bot } from 'mineflayer'

const REFUSAL_WINDOW_MS = 800

/**
 * Watches this session's digs for refusals. `onRefused` gets the block position; the agent
 * records the zone and re-plans.
 */
export function watchRefusedDigs (bot: Bot, onRefused: (pos: { x: number, y: number, z: number }) => void): () => void {
  const recent = new Map<string, number>()
  // what each dug block was: a refusal restores that same block, while a different block
  // there right after is our own next placement (a creative build digs and places within
  // 200 ms, which used to count as a refusal and fenced off the build site)
  const broken = new Map<string, string>()
  // Right after (re)connecting the server resends state and can roll back late digs: ignore.
  const quietUntil = Date.now() + 10_000
  const key = (p: { x: number, y: number, z: number }) => `${p.x},${p.y},${p.z}`
  const onDug = (block: { position: { x: number, y: number, z: number } }) => {
    recent.set(key(block.position), Date.now())
  }
  const onUpdate = (old: { name?: string, type?: number } | null, now: { type?: number, position?: { x: number, y: number, z: number } } | null) => {
    if (old && now?.position && now.type === 0 && old.type !== 0 && old.name) broken.set(key(now.position), old.name)
  }
  const onChange = (packet: any) => {
    const l = packet?.location
    if (!l) return
    const t = recent.get(key(l))
    if (!t) return
    recent.delete(key(l))
    const name = bot.registry.blocksByStateId[packet.type]?.name
    const was = broken.get(key(l))
    broken.delete(key(l))
    if (Date.now() < quietUntil) return
    if (was && name && name !== was) return // something else placed there, not the old block back
    if (Date.now() - t < REFUSAL_WINDOW_MS && packet.type !== 0 && name !== 'air' && name !== 'cave_air') onRefused(l)
  }
  bot.on('diggingCompleted', onDug)
  bot.on('blockUpdate', onUpdate as any)
  // mineflayer drops diggingCompleted listeners when the bot dies: re-attach on respawn.
  const reattach = () => { bot.off('diggingCompleted', onDug); bot.on('diggingCompleted', onDug) }
  bot.on('respawn', reattach)
  bot._client.on('block_change', onChange)
  const prune = setInterval(() => { const now = Date.now(); for (const [k, t] of recent) if (now - t > 5000) { recent.delete(k); broken.delete(k) } if (broken.size > 1000) broken.clear() }, 5000)
  return () => {
    bot.off('diggingCompleted', onDug)
    bot.off('blockUpdate', onUpdate as any)
    bot.off('respawn', reattach)
    bot._client.removeListener('block_change', onChange)
    clearInterval(prune)
  }
}
