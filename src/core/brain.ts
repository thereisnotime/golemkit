// A brain decides what the bot does: chat commands (player assistant), an NPC loop, an
// LLM loop, reflexes. Several brains run at once; they compete for the body through
// action priorities (see PRIORITY in action.ts).
import type { Bot } from 'mineflayer'
import type { Agent } from './agent.ts'

export interface BrainDef {
  name: string
  /** Called once when the agent starts. */
  start? (agent: Agent): void | Promise<void>
  /** Called on every new session after spawn. Return a cleanup function if needed. */
  session? (agent: Agent, bot: Bot): void | (() => void)
  /** Called when the agent stops. */
  stop? (agent: Agent): void | Promise<void>
  /** Extra fields for agent.observe() (like a skill's observe), e.g. the LLM brain's usage. */
  observe? (agent: Agent, bot: Bot): Record<string, unknown>
}

export function defineBrain (def: BrainDef): BrainDef {
  return def
}
