// Material tiers of tools, weapons and armour, one table for everyone that compares gear
// (toolkit, progression, needs, start_over packing). Pure. Golden counts as wooden: it breaks
// almost at once; chainmail sits between leather and iron.

/** Rank of a material prefix: wooden, golden and leather 1 .. netherite 5. */
export const TIER_RANK: Readonly<Record<string, number>> = { wooden: 1, golden: 1, leather: 1, stone: 2, chainmail: 2, iron: 3, diamond: 4, netherite: 5 }

/** The tier rank of an item by its material prefix ("iron_sword" -> 3, "minecraft:diamond_boots" -> 4), or null without one. */
export function itemTierRank (name: string): number | null {
  const m = /^(?:[a-z0-9_]+:)?([a-z]+)_/.exec(name)
  return (m && TIER_RANK[m[1]!]) ?? null
}
