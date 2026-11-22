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

/**
 * Expands `${NAME}` and `${NAME:-default}` from the environment (after loading `.env`), so
 * profiles can keep personal values (owner names, token locations) out of the repo.
 */
export function expandEnv (text: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env === process.env) loadDotEnvOnce()
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name: string, def?: string) => env[name] || def || '')
}

/** An environment variable (after loading `.env`), or the default: for variants and scripts. */
export function envOr (name: string, def = ''): string {
  loadDotEnvOnce()
  return process.env[name] || def
}

/** Defaults for a server running on this machine; set MC_HOST etc. in `.env` for anything else. */
export const DEFAULT_SERVER: ServerConfig = { host: 'localhost', port: 25565, auth: 'offline', version: '1.21.1' }

let envFileTried = false
/** Loads `.env` from the working directory once, if it exists and the process wasn't started with it. */
export function loadDotEnvOnce (): void {
  if (envFileTried) return
  envFileTried = true
  try { process.loadEnvFile('.env') } catch { /* no .env: defaults apply */ }
}

export function serverFromEnv (env: NodeJS.ProcessEnv = process.env): ServerConfig {
  if (env === process.env && !env.MC_HOST) loadDotEnvOnce()
  return {
    host: env.MC_HOST || DEFAULT_SERVER.host,
    port: Number(env.MC_PORT || DEFAULT_SERVER.port),
    auth: (env.MC_AUTH as ServerConfig['auth']) || DEFAULT_SERVER.auth,
    version: env.MC_VERSION || DEFAULT_SERVER.version
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
