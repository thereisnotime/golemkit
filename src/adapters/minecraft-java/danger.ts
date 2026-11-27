// The LLM brain's danger check (adapter.inDanger()): an owner's goal doesn't outrank the
// bot's own safety behaviours while this is true. Also the death-spot path cost.
import { dangerMemory } from '../../core/danger.ts'
import { deathSpotsSettings, DEATH_ZONE_KIND } from '../../core/baseSafety.ts'
/** Low health or food, night (or a thunderstorm), or a hostile mob within 12 blocks. */
export function inDanger (bot: any): boolean {
  if (!bot?.entity) return false
  if (bot.health <= 6 || bot.food <= 6) return true
  const t = bot.time?.timeOfDay ?? 0
  if ((bot.thunderState ?? 0) > 0 || (t >= 12_542 && t <= 23_459)) return true
  return Object.values(bot.entities ?? {}).some((e: any) => e?.type === 'hostile' && e.position?.distanceTo(bot.entity.position) < 12)
}


/**
 * Pathfinder step cost inside a recent death spot (settings.deathSpots.stepCost per block), so
 * paths go around the cave it just died in instead of through it. Not a wall: when the only way
 * is through, it still goes (the cost stays well under the pathfinder's cut-off of 100).
 */
export function deathStepExclusion (agent: { settings: Record<string, unknown> }): (block: { position: { x: number, y: number, z: number } }) => number {
  const mem = dangerMemory(agent)
  return (block) => {
    if (!mem.zones.length || !block?.position) return 0
    const s = deathSpotsSettings(agent.settings.deathSpots)
    if (!s.enabled || s.stepCost <= 0) return 0
    return mem.isInDanger(block.position, 0, DEATH_ZONE_KIND) ? s.stepCost : 0
  }
}
