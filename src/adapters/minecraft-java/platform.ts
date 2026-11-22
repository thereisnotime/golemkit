// Server platforms inside the Minecraft Java adapter: what differs between a vanilla, a Paper
// and a NeoForge server is the login handshake, registries and packets a vanilla client can't
// parse. The adapter runs one platform per agent (ServerConfig.platform, default neoforge).
import type { Bot } from 'mineflayer'
import type { Capability } from '../../core/adapter.ts'
import type { ServerConfig } from '../../core/definition.ts'
import type { Logger } from '../../core/log.ts'

export type PlatformName = 'vanilla' | 'paper' | 'neoforge'

export interface PlatformContext {
  server: ServerConfig
  settings: Record<string, unknown>
  /** The platform's logger ("<username>/neoforge" for NeoForge). */
  log: Logger
  /** Ends the session; 'learned' reconnects right away (the handshake learned something). */
  end (reason: 'learned' | 'ended', detail?: string): void
}

export interface ServerPlatform {
  readonly name: PlatformName
  /** Capabilities the platform adds on top of the adapter's (NeoForge: 'mods'). */
  readonly capabilities: readonly Capability[]
  /** Process-wide setup, once per agent start (packet parser patches). */
  install? (ctx: Omit<PlatformContext, 'end'>): void
  /** Text after "connecting to host:port (auth)" in the log. */
  describe? (): string
  /** Hooks a fresh client before it logs in (handshakes, registry sync). */
  attach? (bot: Bot, ctx: PlatformContext): void
  /** Right after the play-state login packet: registry fixes for modded content. */
  onLogin? (bot: Bot, ctx: PlatformContext): void
}
