// Blocks the pathfinder must never dig through on its way somewhere. Pathfinder only protects
// chests (and unbreakable blocks) by default, so with canDig on, Pax walked home through its own
// bed next to the home point, picked the bed up, put it back and lost its respawn point over and
// over. Explicit digs (dig, clear_area, ...) are not affected: this only stops tunnelling.
import type { Bot } from 'mineflayer'

const EXACT = new Set([
  'chest', 'trapped_chest', 'ender_chest', 'barrel', 'furnace', 'blast_furnace', 'smoker',
  'crafting_table', 'smithing_table', 'anvil', 'chipped_anvil', 'damaged_anvil', 'enchanting_table',
  'brewing_stand', 'hopper', 'dispenser', 'dropper', 'lectern', 'jukebox', 'beacon', 'respawn_anchor',
  'farmland', 'composter', 'cauldron', 'water_cauldron', 'lava_cauldron', 'bell', 'loom',
  'cartography_table', 'fletching_table', 'grindstone', 'stonecutter', 'torch', 'wall_torch',
  'soul_torch', 'soul_wall_torch', 'lantern', 'soul_lantern', 'glass', 'glass_pane', 'spawner',
])
const SUFFIX = ['_bed', '_shulker_box', '_door', '_trapdoor', '_fence_gate', '_sign', '_banner', '_stained_glass', '_stained_glass_pane']

/** True for blocks a player would be upset to see a bot tunnel through: beds, storage, workstations, doors, lights, farmland. */
export function keepWhenPathing (name: string): boolean {
  return EXACT.has(name) || name === 'shulker_box' || SUFFIX.some(s => name.endsWith(s))
}

/** Adds every such block in the registry to the pathfinder's never-break set. */
export function protectFromPathing (bot: Bot, moves: { blocksCantBreak: Set<number> }): number {
  let n = 0
  for (const b of Object.values(bot.registry.blocksByName) as { id: number, name: string }[]) {
    if (keepWhenPathing(b.name)) { moves.blocksCantBreak.add(b.id); n++ }
  }
  return n
}
