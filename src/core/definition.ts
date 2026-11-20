// Variants (variants/<name>.ts: what kind of bot), instance options (from profiles, fleet
// entries or CLI flags) and server connection settings.
import type { Bot } from 'mineflayer'
import type { SkillDef } from './skill.ts'
import type { BrainDef } from './brain.ts'
import type { Agent } from './agent.ts'

export interface BotDefinition {
  /** Id of the bot type; also the default data directory name. */
  name: string
  description?: string
  /** Minecraft username. Can be overridden per instance (CLI / fleet file). */
  username?: string
  skills: SkillDef[]
  brains: BrainDef[]
  /** Free-form personality / role text. LLM brains put it in their system prompt. */
  persona?: string
  /** Players allowed to command this bot. Empty/undefined = everyone (or MC_OWNERS). */
  owners?: string[]
  /** Let the pathfinder break blocks. Default false. */
  canDig?: boolean
  /** Arbitrary per-bot settings, readable via agent.settings. */
  settings?: Record<string, unknown>
  /** Runs after every spawn, after skills and brains are set up. */
  onSpawn? (agent: Agent, bot: Bot): void
}

/** A variant: a kind of bot (skills + brains + defaults). `defineBot` is the older name. */
export type VariantDefinition = BotDefinition

export function defineVariant (def: VariantDefinition): VariantDefinition {
  return def
}

export const defineBot = defineVariant

export interface ServerConfig {
  host: string
  port: number
  /** 'offline' for offline-mode servers, 'microsoft' for a real account. */
  auth: 'offline' | 'microsoft'
  version: string
}

export function serverFromEnv (env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    host: env.MC_HOST || 'mc.example.com',
    port: Number(env.MC_PORT || 25565),
    auth: (env.MC_AUTH as ServerConfig['auth']) || 'offline',
    version: env.MC_VERSION || '1.21.1'
  }
}

/** Per-instance overrides applied on top of a variant (from a profile, fleet entry or CLI flags). */
export interface InstanceOptions {
  username?: string
  /** Replaces the variant's persona. */
  persona?: string
  owners?: string[]
  canDig?: boolean
  settings?: Record<string, unknown>
  /** Data directory; defaults to data/bots/<username>. */
  dataDir?: string
  reconnectDelayMs?: number
}

export function listFromEnv (v: string | undefined): string[] {
  return (v || '').split(',').map(s => s.trim()).filter(Boolean)
}
