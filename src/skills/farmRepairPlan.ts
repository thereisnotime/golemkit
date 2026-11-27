// What to do about one of its farms that site health marked bad: repair it where it is, move it
// (a new farm elsewhere, away from this one), or leave it to the owners. Pure, unit-tested in
// test/food-source.test.ts; foodSources.ts reads the farm and does the work.
//
// Repairs it knows without a bucket:
// - thaw: the middle water froze. Break the ice (it turns back into a source: there is water or
//   ground under it) and keep it open with a block over it or a torch (coldFarmPlan.ts).
// - fill: cells that were field and are now water or ice at ground level (a flood, the lake
//   creeping in). A block placed into water replaces it, so a dirt block in each turns it back
//   into ground to till. Ice is broken first (it becomes water), then filled.
// Water standing over the field (flowing in from somewhere above) has a source it can't see
// from the plot; filling the ground doesn't help, so a farm mostly under that is moved.
import type { FarmSiteCell } from './needPlan.ts'
import { MIN_DRY_CELLS } from './needPlan.ts'

export type BadFarmMode = 'auto' | 'repair' | 'relocate' | 'off'

export interface FarmRepairInput {
  /** The farm square as the site check reads it ("dx,dz" from the water). */
  cells: Record<string, FarmSiteCell>
  /** Cells that were land when it was made; missing on older farms. */
  land?: readonly string[]
  /** Cells whose water or ice is over the ground, not in it (keys). */
  over?: readonly string[]
  mode: BadFarmMode
  /** farming.iceWater: may break ice for water. */
  iceWater: boolean
  /** Has a way to keep the thawed water open (coldFarmPlan protectionFor said ok), or it does not freeze. */
  canKeepOpen: boolean
  /** Blocks it can fill with: dirt (and other cheap blocks) carried and in its chests. */
  blocks: number
  /** May dig ground for more fill. */
  canDig: boolean
  canPlace: boolean
  /** A water bucket (or a bucket and water near): the water can be put back when it is gone. */
  bucket: boolean
  /** Most cells it fills in one repair (farming.repairMaxBlocks). */
  maxBlocks: number
  /** Repairs tried on this farm so far, and how many it may try (farming.repairTries). */
  tries: number
  maxTries: number
}

export interface FarmRepairPlan {
  decision: 'repair' | 'restore' | 'relocate' | 'leave'
  thaw: boolean
  /** Put the water back in the middle with a bucket. */
  rewater: boolean
  /** Cells to fill with a block, then till (keys). */
  fill: string[]
  reason: string
}

const DRY = new Set<FarmSiteCell>(['farmland', 'tillable'])

/**
 * Repair or move. In auto it repairs when the repair is small (at most maxBlocks fills, the ice
 * can be broken and kept open, the water is there or a bucket brings it) and moves otherwise;
 * repair never moves (leaves it after maxTries), relocate never repairs, off does neither.
 * A farm that reads fine now (a false alarm, or a player fixed it) is restored.
 */
export function planFarmRepair (p: FarmRepairInput): FarmRepairPlan {
  const out = (decision: FarmRepairPlan['decision'], reason: string, x: Partial<FarmRepairPlan> = {}): FarmRepairPlan =>
    ({ decision, thaw: false, rewater: false, fill: [], reason, ...x })
  if (p.mode === 'off') return out('leave', 'farming.badFarm is off: left for the owners')

  const centre = p.cells['0,0']
  const keys = p.land?.length ? p.land.filter(k => k !== '0,0' && k in p.cells) : null
  const field = Object.keys(p.cells).filter(k => k !== '0,0' && (!keys || keys.includes(k)))
  const over = new Set(p.over ?? [])
  const dry = field.filter(k => DRY.has(p.cells[k]!)).length
  // only cells known to have been land are filled: on an older farm the wet side may be the lake
  const flooded = keys ? field.filter(k => (p.cells[k] === 'water' || p.cells[k] === 'ice') && !over.has(k)) : []
  const fromAbove = field.filter(k => over.has(k)).length
  const thaw = centre === 'ice'
  const gone = centre !== 'water' && centre !== 'ice'

  if (!thaw && !gone && !flooded.length && dry >= MIN_DRY_CELLS && fromAbove * 2 < field.length) {
    return out('restore', `it reads fine now (${dry} dry cells, water in the middle)`)
  }
  if (p.mode === 'relocate') return out('relocate', 'farming.badFarm is relocate: a new farm elsewhere')

  const problems: string[] = []
  if (thaw && !p.iceWater) problems.push('the water froze and farming.iceWater is off')
  else if (thaw && !p.canKeepOpen) problems.push('the water froze and I have nothing to keep it open after breaking the ice')
  if (gone && !(p.bucket && p.canPlace)) problems.push('the water in the middle is gone and I have no bucket')
  if (fromAbove * 2 >= field.length) problems.push(`water runs over ${fromAbove} of ${field.length} cells from somewhere above`)
  if (flooded.length > p.maxBlocks) problems.push(`${flooded.length} flooded cells, more than farming.repairMaxBlocks (${p.maxBlocks})`)
  if (flooded.length && !p.canPlace) problems.push('placing is off, so I can\'t fill the flooded cells')
  if (flooded.length && p.blocks < flooded.length && !p.canDig) problems.push(`${flooded.length} flooded cells and only ${p.blocks} blocks to fill them`)
  if (dry + flooded.length < MIN_DRY_CELLS) problems.push(`only ${dry + flooded.length} cells would be field again`)
  if (p.tries >= p.maxTries) problems.push(`tried ${p.tries} repairs already (farming.repairTries ${p.maxTries})`)

  if (problems.length) {
    const why = problems.join('; ')
    return p.mode === 'repair' ? out('leave', `${why}; farming.badFarm is repair, so I leave it`) : out('relocate', `${why}: a new farm elsewhere`)
  }
  const parts = [
    ...(thaw ? ['break the frozen water and keep it open'] : []),
    ...(gone ? ['put the water back with the bucket'] : []),
    ...(flooded.length ? [`fill ${flooded.length} flooded cells with dirt`] : [])
  ]
  return out('repair', parts.join(', ') || 'nothing to repair', { thaw, rewater: gone, fill: flooded })
}

export interface FarmRepairSettings {
  badFarm: BadFarmMode
  repairMaxBlocks: number
  repairTries: number
}

export const FARM_REPAIR_DEFAULTS: FarmRepairSettings = { badFarm: 'auto', repairMaxBlocks: 16, repairTries: 2 }

/** settings.farming's repair knobs with defaults. */
export function farmRepairSettings (raw: unknown): FarmRepairSettings {
  const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const m = o.badFarm
  const num = (v: unknown, d: number, lo: number, hi: number) => typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : d
  return {
    badFarm: m === 'auto' || m === 'repair' || m === 'relocate' || m === 'off' ? m : raw === false ? 'relocate' : FARM_REPAIR_DEFAULTS.badFarm,
    repairMaxBlocks: num(o.repairMaxBlocks, FARM_REPAIR_DEFAULTS.repairMaxBlocks, 0, 80),
    repairTries: num(o.repairTries, FARM_REPAIR_DEFAULTS.repairTries, 0, 20)
  }
}
