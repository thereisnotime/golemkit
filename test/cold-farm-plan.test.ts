// Farming on cold ground without a bucket: the 1.21.1 ice and freezing rules, how the water is
// kept open, the steps at a frozen shore, and the site check of a shore farm.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  iceMakesWater, waterFreezes, torchLightAt, coverItem, protectionFor, iceSourceOk, planColdWater, sideCell,
  farmingSettings, NO_FREEZE_LIGHT, MELT_LIGHT
} from '../src/skills/coldFarmPlan.ts'
import { farmSiteVerdict, type FarmSiteCell } from '../src/skills/needPlan.ts'
import { scoreSite, type SiteCandidate } from '../src/skills/foodPlan.ts'

test('ice becomes water when broken over water or ground, not over air, with silk touch or in the Nether', () => {
  assert.equal(iceMakesWater({ below: 'water', belowSolid: false }), true, 'a frozen lake')
  assert.equal(iceMakesWater({ below: 'dirt', belowSolid: true }), true, 'ice on the ground')
  assert.equal(iceMakesWater({ below: 'air', belowSolid: false }), false)
  assert.equal(iceMakesWater({ below: 'water', belowSolid: false, nether: true }), false)
  assert.equal(iceMakesWater({ below: 'water', belowSolid: false, silkTouch: true }), false, 'silk touch drops the ice block')
})

test('water freezes only cold, under the sky, dark and at an edge; a cover or a torch close by stops it', () => {
  assert.equal(waterFreezes({ cold: true, covered: false, blockLight: 0 }), true)
  assert.equal(waterFreezes({ cold: false, covered: false, blockLight: 0 }), false)
  assert.equal(waterFreezes({ cold: true, covered: true, blockLight: 0 }), false, 'a block over it')
  assert.equal(waterFreezes({ cold: true, covered: false, blockLight: torchLightAt(2) }), false, 'a torch on the shore cell next to it: light 12')
  assert.equal(waterFreezes({ cold: true, covered: false, blockLight: torchLightAt(5) }), true, 'light 9 is not enough')
  assert.equal(waterFreezes({ cold: true, covered: false, blockLight: 0, surroundedByWater: true }), false)
  assert.equal(NO_FREEZE_LIGHT, 10)
  assert.ok(torchLightAt(1) > MELT_LIGHT && torchLightAt(3) <= MELT_LIGHT, 'a torch melts ice one or two blocks away, not three')
})

test('cover blocks: cheap ones first, two needed, planks as a last resort', () => {
  assert.equal(coverItem({ cobblestone: 5, dirt: 2 }), 'dirt')
  assert.equal(coverItem({ dirt: 1, cobblestone: 3 }), 'cobblestone')
  assert.equal(coverItem({ spruce_planks: 4 }), 'spruce_planks')
  assert.equal(coverItem({ spruce_log: 9, torch: 3 }), null)
})

test('protection: cover first in auto, torch when that is all, honest reasons when neither', () => {
  const base = { freezes: true, mode: 'auto' as const, cover: 'dirt', torches: 0, side: true }
  assert.equal(protectionFor(base).how, 'cover')
  assert.equal(protectionFor({ ...base, cover: null, torches: 2 }).how, 'torch')
  assert.equal(protectionFor({ ...base, mode: 'torch', torches: 2 }).how, 'torch')
  const none = protectionFor({ ...base, cover: null })
  assert.equal(none.ok, false)
  assert.match(none.reason, /freeze again/)
  assert.equal(protectionFor({ ...base, freezes: false, cover: null }).ok, true, 'warm water needs nothing')
  assert.equal(protectionFor({ ...base, mode: 'off' }).ok, false)
  assert.equal(protectionFor({ ...base, side: false }).ok, false)
})

test('ice sources: open above (snow is fine), not under a roof, water or ground below', () => {
  const c = { x: 0, y: 62, z: 0, above: 'snow', below: 'water', belowSolid: false, sky: 15 }
  assert.equal(iceSourceOk(c), true)
  assert.equal(iceSourceOk({ ...c, above: 'stone' }), false)
  assert.equal(iceSourceOk({ ...c, sky: 4 }), false)
  assert.equal(iceSourceOk({ ...c, sky: null }), true, 'no light data: trust the block above')
  assert.equal(iceSourceOk({ ...c, below: 'air' }), false)
})

test("Pax's frozen shore: no bucket, no torches, dirt in its chests: take two, cover the ice, break it", () => {
  const p = planColdWater({ centre: 'ice', freezes: true, mode: 'auto', inv: { spruce_log: 20, stone_pickaxe: 1 }, stored: { dirt: 30, cobblestone: 38 }, torches: 0, side: true, iceWater: true })
  assert.equal(p.ok, true)
  assert.deepEqual(p.steps, ['take_blocks', 'cover', 'break_ice'], 'the cover goes on the ice, then the ice is broken under it')
  const carried = planColdWater({ centre: 'ice', freezes: true, mode: 'auto', inv: { cobblestone: 9 }, torches: 0, side: true, iceWater: true })
  assert.deepEqual(carried.steps, ['cover', 'break_ice'])
  const torch = planColdWater({ centre: 'ice', freezes: true, mode: 'auto', inv: {}, stored: { dirt: 30 }, torches: 4, side: true, iceWater: true })
  assert.deepEqual(torch.steps, ['break_ice', 'torch'], 'a torch it carries beats a walk to the chests')
  const open = planColdWater({ centre: 'water', freezes: true, mode: 'auto', inv: { dirt: 2 }, torches: 0, side: true, iceWater: true })
  assert.deepEqual(open.steps, ['cover'], 'open water in the cold: just keep it open')
  assert.equal(planColdWater({ centre: 'ice', freezes: true, mode: 'auto', inv: {}, stored: {}, torches: 0, side: true, iceWater: true }).ok, false)
  assert.deepEqual(planColdWater({ centre: 'ice', freezes: true, mode: 'auto', inv: {}, stored: {}, torches: 0, side: true, iceWater: true, canDigBlocks: true }).steps, ['dig_blocks', 'cover', 'break_ice'], 'nothing anywhere: dig two dirt beside the plot')
  assert.match(planColdWater({ centre: 'ice', freezes: true, mode: 'auto', inv: { dirt: 2 }, torches: 0, side: true, iceWater: false }).reason, /iceWater is off/)
})

test('side cell: a shore neighbour of the water, not the lake', () => {
  assert.deepEqual(sideCell({ '0,1': 'water', '0,-1': 'tillable', '1,0': 'tillable' }), [0, -1])
  assert.equal(sideCell({ '0,1': 'water', '0,-1': 'water', '1,0': 'other', '-1,0': 'water' }), null)
})

test('farming settings: defaults, false, bad values', () => {
  assert.deepEqual(farmingSettings(undefined), { iceWater: true, protectWater: 'auto' })
  assert.deepEqual(farmingSettings(false), { iceWater: false, protectWater: 'off' })
  assert.deepEqual(farmingSettings({ iceWater: false, protectWater: 'torch' }), { iceWater: false, protectWater: 'torch' })
  assert.equal(farmingSettings({ protectWater: 'lava' }).protectWater, 'auto')
})

// a 9x9 shore farm: the lake (dx >= 0) is ice, the shore side land
const shore = (land: FarmSiteCell, lake: FarmSiteCell, centre: FarmSiteCell = 'water') => {
  const out: Record<string, FarmSiteCell> = {}
  for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) out[`${dx},${dz}`] = dx === 0 && dz === 0 ? centre : dx >= 0 ? lake : land
  return out
}
const landKeys = Object.keys(shore('tillable', 'ice')).filter(k => Number(k.split(',')[0]) < 0)

test('a shore farm is judged on its own land: the lake beside it is not a flood, a frozen centre is', () => {
  assert.equal(farmSiteVerdict(shore('farmland', 'ice')).ok, true, 'without the land list a shore farm is judged on the dry field left (36 farmland)')
  assert.equal(farmSiteVerdict(shore('water', 'ice')).ok, false, 'without the land list and no dry field: flooded')
  assert.equal(farmSiteVerdict(shore('farmland', 'ice'), landKeys).ok, true)
  const frozen = farmSiteVerdict(shore('farmland', 'ice', 'ice'), landKeys)
  assert.equal(frozen.ok, false)
  assert.match(frozen.ok ? '' : frozen.reason, /froze/)
  const flooded = farmSiteVerdict(shore('water', 'ice'), landKeys)
  assert.equal(flooded.ok, false)
})

test('a frozen-shore site scores once the ice counts as water (siteAt iceAsWater), builds still rule it out', () => {
  const cells: Record<string, 'tillable' | 'water'> = {}
  for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) cells[`${dx},${dz}`] = dx >= 0 && !(dx === 0 && dz !== 0) ? 'water' : 'tillable'
  const site: SiteCandidate = { water: { x: 0, y: 62, z: 0 }, cells, around: ['water', 'water'], distance: 30 }
  assert.ok(scoreSite(site) !== null)
  assert.equal(scoreSite({ ...site, around: ['build'] }), null)
  assert.equal(scoreSite({ ...site, around: ['hazard'] }), null, 'lava or powder snow still rule it out')
})
