// Puts a fake Mineflayer bot (fake-world.ts) behind an agent, as if it had spawned. The only
// place tests reach into how the agent and its Minecraft adapter hold the game client.
import type { Agent } from '../src/core/index.ts'
import { MinecraftJavaAdapter } from '../src/adapters/minecraft-java/adapter.ts'

export function attachFakeBot (agent: Agent, bot: unknown): void {
  const a = agent as any
  a.adapter.bot = bot
  a.adapter.spawned = true
  a.sessionController ??= new AbortController()
}

/**
 * The Minecraft adapter over a fake Mineflayer bot, for fake agents (`{ ..., adapter: minecraftView(bot) }`)
 * whose brains read the game through agent.adapter.
 */
export function minecraftView (bot: unknown): MinecraftJavaAdapter {
  const a = new MinecraftJavaAdapter() as any
  a.bot = bot
  a.spawned = true
  return a
}
