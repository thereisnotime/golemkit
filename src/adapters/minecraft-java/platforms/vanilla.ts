// Vanilla servers: nothing beyond what Mineflayer does.
import type { ServerPlatform } from '../platform.ts'

export function vanillaPlatform (): ServerPlatform {
  return { name: 'vanilla', capabilities: [] }
}
