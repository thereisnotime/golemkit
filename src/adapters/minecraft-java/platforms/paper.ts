// Paper (and Spigot) servers speak the vanilla protocol; plugins only add commands and chat.
// WorldEdit, when installed, is detected by the worldedit skill through the command list.
import type { ServerPlatform } from '../platform.ts'

export function paperPlatform (): ServerPlatform {
  return { name: 'paper', capabilities: [] }
}
