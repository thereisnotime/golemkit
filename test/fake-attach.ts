// Puts a fake Mineflayer bot (fake-world.ts) behind an agent, as if it had spawned. The only
// place tests reach into how the agent holds its game client.
import type { Agent } from '../src/core/index.ts'

export function attachFakeBot (agent: Agent, bot: unknown): void {
  ;(agent as any)._bot = bot
}
