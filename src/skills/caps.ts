// Caps over a hole: a closed trapdoor, a bottom slab or a plain block where a mine's stairs cut
// through the ground near the base (settings baseSafety.capWith). Placing one, taking one off for
// a trip down and putting it back. Shared by base safety (baseSafety.ts) and the staircase mine
// (stairMine.ts); no planning here (baseSafetyPlan.ts decides where).
import type { Bot } from 'mineflayer'
import type { Pos } from './blueprint.ts'
import { checkAborted, type CapKind } from '../core/index.ts'
import { vec, digBlock } from './world.ts'
import { placeBlockState, reachToDig, NotPlaceableYet } from './placement.ts'
import { equipFor } from './toolkit.ts'
import { fillerBlock } from './survival.ts'
import { itemName } from '../core/index.ts'

export type PlacedCap = Exclude<CapKind, 'light' | 'none'>

const CAP_ITEM: Record<PlacedCap, RegExp> = { trapdoor: /_trapdoor$/, slab: /_slab$/, block: /^$/ }

/** The item it would cap with now: the kind asked for, else a filler block (always better than an open hole). */
export function capItem (bot: Bot, kind: PlacedCap): { item: string, kind: PlacedCap } | null {
  if (kind !== 'block') {
    const it = bot.inventory.items().find(i => CAP_ITEM[kind].test(itemName(i)) && !/iron_trapdoor/.test(itemName(i)))
    if (it) return { item: itemName(it), kind }
  }
  const f = fillerBlock(bot)
  return f ? { item: f, kind: 'block' } : null
}

/** Whether the block there is a cap (what capItem puts down, or any solid block). */
export function isCapBlock (name: string | undefined, solid: boolean): boolean {
  return !!name && (solid || /_trapdoor$|_slab$/.test(name))
}

const stateFor = (kind: PlacedCap): Record<string, string> | undefined =>
  kind === 'trapdoor' ? { half: 'bottom', open: 'false' } : kind === 'slab' ? { type: 'bottom' } : undefined

/** Puts one cap down. Throws when it can't (nothing to place against, out of reach). */
export async function placeCap (bot: Bot, pos: Pos, item: string, kind: PlacedCap, signal: AbortSignal): Promise<void> {
  const v = vec(bot, pos.x, pos.y, pos.z)
  const here = bot.blockAt(v)
  if (here && isCapBlock(here.name, here.boundingBox === 'block')) return
  try {
    await placeBlockState(bot, item, v, stateFor(kind), signal, { canDig: false })
  } catch (e) {
    checkAborted(signal)
    // no side to hang a trapdoor or slab on in that state: put it in plain
    if (e instanceof NotPlaceableYet) { await placeBlockState(bot, item, v, undefined, signal, { canDig: false }); return }
    throw e
  }
}

/** Takes the caps off (for a trip down): digs each cap block still there. Returns how many it took off. */
export async function takeCapsOff (bot: Bot, cells: readonly Pos[], signal: AbortSignal): Promise<number> {
  let n = 0
  for (const p of cells) {
    checkAborted(signal)
    const b = bot.blockAt(vec(bot, p.x, p.y, p.z))
    if (!b || !isCapBlock(b.name, b.boundingBox === 'block')) continue
    // a wooden trapdoor is a hatch: opened, not broken (iron ones need redstone, those are dug)
    if (/_trapdoor$/.test(b.name) && !/^iron_/.test(b.name)) {
      try {
        if ((b.getProperties() as { open?: unknown }).open !== true) { await reachToDig(bot, b.position, signal); await bot.activateBlock(b); n++ }
      } catch (e) { checkAborted(signal) }
      continue
    }
    try {
      await reachToDig(bot, b.position, signal)
      await equipFor(bot, b)
      await digBlock(bot, b, signal)
      n++
    } catch (e) { checkAborted(signal) }
  }
  return n
}
