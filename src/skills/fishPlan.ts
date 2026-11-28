// Fishing, the pure part: whether it has or can get a rod (carried, in a chest, crafted from what
// it carries or takes from its chests). Pax starved by its fortress in a snowy biome with string in
// its chests and open water 25 blocks away, because the rod check only looked at the inventory.
// The fish action (foodSources.ts) reads the world and casts.

export type RodStep = 'have' | 'craft' | 'withdraw' | 'none'

export interface RodInput {
  /** Items carried, by name. */
  inv: Record<string, number>
  /** Items in containers it may take from, by name. */
  stored: Record<string, number>
  /** craft is available (a rod needs a crafting table; craft puts one down). */
  canCraft: boolean
}

const PLANKS = /_planks$/
const LOGS = /_(log|stem|wood|hyphae)$/
const sum = (r: Record<string, number>, test: (k: string) => boolean) => Object.entries(r).filter(([k]) => test(k)).reduce((n, [, v]) => n + v, 0)

/**
 * How it gets a rod: carries one, crafts one from what it carries (3 sticks, 2 string; planks and
 * logs make sticks), takes the missing string, sticks or a rod from a container first, or can't.
 * `take` lists what to withdraw for 'withdraw'.
 */
export function rodPlan (r: RodInput): { step: RodStep, take: Record<string, number>, reason: string } {
  if ((r.inv.fishing_rod ?? 0) > 0) return { step: 'have', take: {}, reason: 'carries a fishing rod' }
  if ((r.stored.fishing_rod ?? 0) > 0) return { step: 'withdraw', take: { fishing_rod: 1 }, reason: 'a fishing rod in a chest' }
  if (!r.canCraft) return { step: 'none', take: {}, reason: 'no rod and no crafting' }
  const string = r.inv.string ?? 0
  // sticks it has or can make: 2 planks make 4 sticks
  const sticks = (r.inv.stick ?? 0) + Math.floor(sum(r.inv, k => PLANKS.test(k)) / 2) * 4 + sum(r.inv, k => LOGS.test(k)) * 8
  const take: Record<string, number> = {}
  if (string < 2) {
    if ((r.stored.string ?? 0) < 2 - string) return { step: 'none', take: {}, reason: `no rod: ${string} string carried, ${r.stored.string ?? 0} in chests, 2 needed` }
    take.string = 2 - string
  }
  if (sticks < 3) {
    const storedSticks = (r.stored.stick ?? 0) + Math.floor(sum(r.stored, k => PLANKS.test(k)) / 2) * 4
    if (sticks + storedSticks < 3) return { step: 'none', take: {}, reason: 'no rod: no sticks or planks for one' }
    if ((r.stored.stick ?? 0) >= 3 - sticks) take.stick = 3 - sticks
    else { const plank = Object.keys(r.stored).find(k => PLANKS.test(k) && (r.stored[k] ?? 0) >= 2); if (plank) take[plank] = 2 }
  }
  return Object.keys(take).length
    ? { step: 'withdraw', take, reason: `takes ${Object.entries(take).map(([k, n]) => `${n} ${k}`).join(', ')} from a chest for a rod` }
    : { step: 'craft', take: {}, reason: 'crafts a rod from string and sticks' }
}
