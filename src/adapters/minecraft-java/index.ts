// The Minecraft Java adapter: Mineflayer behind the GameAdapter interface, with NeoForge,
// vanilla and Paper as server platforms. Skills (src/skills/) and the stock behaviours build on
// what this exports; src/core/index.ts re-exports the parts variants and scripts used before.
import './types.ts'
export { MinecraftJavaAdapter, minecraftJava } from './adapter.ts'
export type { ServerPlatform, PlatformName, PlatformContext } from './platform.ts'
export { platformFor, neoforgePlatform, vanillaPlatform, paperPlatform, PLATFORMS } from './platforms/index.ts'
export * from './helpers.ts'
export { isModdedBlock, MODDED_BLOCK, solidifyUnknownBlocks } from './modded.ts'
export { watchRefusedDigs } from './refusals.ts'
export { holdStill, fidget } from './humanize.ts'
export { inDanger } from './danger.ts'
export { JournalCapture, inventoryCounts } from './journal-capture.ts'
export { reflexes, type ReflexOptions } from './brains/reflexes.ts'
export type { Bot } from './types.ts'
