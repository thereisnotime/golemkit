// A skill groups related actions plus optional per-session setup (event hooks, plugins)
// and an observe() hook that contributes to the bot's world snapshot.
import type { GameClient, Capability } from './adapter.ts'
import type { ActionDef } from './action.ts'
import type { Agent } from './agent.ts'

export interface SkillDef {
  name: string
  description?: string
  actions?: ActionDef<any>[]
  /** Capabilities its actions need unless an action says otherwise (ActionDef.capabilities). */
  capabilities?: Capability[]
  /** Mineflayer plugins this skill needs; loaded once per session before setup(). */
  plugins?: ((bot: GameClient, options: any) => void)[]
  /** Called on every new session after spawn. Return a cleanup function if needed. */
  setup? (agent: Agent, bot: GameClient): void | (() => void)
  /** Adds JSON-friendly facts to Agent.observe() (used by LLM brains and debugging). */
  observe? (agent: Agent, bot: GameClient): Record<string, unknown>
  /** Short lines for the status view (status.json `notes`, `golem status`): what this skill is stuck on, say. Cheap: no world scans. */
  status? (agent: Agent): string[]
}

export function defineSkill (def: SkillDef): SkillDef {
  return def
}
