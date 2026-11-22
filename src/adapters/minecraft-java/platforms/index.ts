// Picks the server platform: ServerConfig.platform (MC_PLATFORM, a profile's server.platform),
// NeoForge by default, which also works on vanilla servers (it only answers what NeoForge asks).
import type { ServerConfig } from '../../../core/definition.ts'
import type { PlatformName, ServerPlatform } from '../platform.ts'
import { neoforgePlatform } from './neoforge/index.ts'
import { vanillaPlatform } from './vanilla.ts'
import { paperPlatform } from './paper.ts'

export const PLATFORMS: readonly PlatformName[] = ['neoforge', 'vanilla', 'paper']

export function platformFor (server: ServerConfig): ServerPlatform {
  const name = server.platform ?? 'neoforge'
  switch (name) {
    case 'neoforge': return neoforgePlatform(server)
    case 'vanilla': return vanillaPlatform()
    case 'paper': return paperPlatform()
    default: throw new Error(`unknown server platform "${name}" (one of ${PLATFORMS.join(', ')})`)
  }
}

export { neoforgePlatform, vanillaPlatform, paperPlatform }
