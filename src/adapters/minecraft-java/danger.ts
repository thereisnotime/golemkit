// The LLM brain's danger check (adapter.inDanger()): an owner's goal doesn't outrank the
// bot's own safety behaviours while this is true.
/** Low health or food, night (or a thunderstorm), or a hostile mob within 12 blocks. */
export function inDanger (bot: any): boolean {
  if (!bot?.entity) return false
  if (bot.health <= 6 || bot.food <= 6) return true
  const t = bot.time?.timeOfDay ?? 0
  if ((bot.thunderState ?? 0) > 0 || (t >= 12_542 && t <= 23_459)) return true
  return Object.values(bot.entities ?? {}).some((e: any) => e?.type === 'hostile' && e.position?.distanceTo(bot.entity.position) < 12)
}
