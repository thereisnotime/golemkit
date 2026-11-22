// The Mineflayer bot is this adapter's game client: ctx.bot in actions, `bot` in skill and
// brain hooks and agent.bot are typed as GameClient, which resolves to Bot through this.
import type { Bot } from 'mineflayer'

declare module '../../core/adapter.ts' {
  interface GameClients {
    'minecraft-java': Bot
  }
}

export type { Bot }
