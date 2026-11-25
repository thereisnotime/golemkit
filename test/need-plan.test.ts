// Minecraft answers for the needs layer: gear and supplies urgency, farm site verdicts, farm
// names, sites near a bad farm, spares to craft; and the farm site check over a fake world.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gearUrgency, ironWanted, suppliesUrgency, farmSiteVerdict, nextFarmName, nearBadSite, spareCraft, type FarmSiteCell } from '../src/skills/needPlan.ts'
import { scoreSite, type SiteCandidate } from '../src/skills/foodPlan.ts'
import { farmCells } from '../src/adapters/minecraft-java/needs/sites.ts'

test('gear: stone tools without armour is urgent enough to search, iron everything is not', () => {
  const stone = { stone_pickaxe: 1, stone_sword: 1, stone_axe: 1, stone_shovel: 1 }
  const g = gearUrgency({ held: stone, upTo: 'iron', armour: true })
  assert.ok(g.urgency >= 0.5)
  assert.ok(g.missing.includes('a iron pickaxe'))
  assert.ok(g.missing.some(m => /iron helmet, chestplate, leggings, boots/.test(m)))
  const iron = { iron_pickaxe: 1, iron_sword: 1, iron_axe: 1, iron_helmet: 1, iron_chestplate: 1, iron_leggings: 1, iron_boots: 1 }
  assert.equal(gearUrgency({ held: iron, upTo: 'iron', armour: true }).urgency, 0)
  assert.equal(gearUrgency({ held: {}, upTo: 'iron', armour: false }).urgency, 0.8)
  assert.equal(gearUrgency({ held: { ...stone, iron_pickaxe: 1, iron_sword: 1, iron_axe: 1 }, upTo: 'iron', armour: false }).urgency, 0)
  assert.equal(gearUrgency({ held: { ...iron, iron_boots: 0 }, upTo: 'iron', armour: true }).urgency, 0.375)
  assert.equal(ironWanted({ held: stone, upTo: 'iron', armour: true }), 3 + 2 + 3 + 1 + 24)
})

test('supplies: wood, a low pantry and a farm short of seeds', () => {
  const base = { wood: 20, woodKeep: 16, storedFood: 20, lowFood: 8, seeds: 10, hasFarm: true }
  assert.equal(suppliesUrgency(base).urgency, 0)
  assert.equal(suppliesUrgency({ ...base, wood: 0 }).urgency, 0.6)
  assert.equal(suppliesUrgency({ ...base, wood: 5 }).urgency, 0.4)
  assert.equal(suppliesUrgency({ ...base, storedFood: 3 }).urgency, 0.5)
  assert.equal(suppliesUrgency({ ...base, storedFood: null }).urgency, 0, 'unknown pantry is not low')
  assert.equal(suppliesUrgency({ ...base, seeds: 2 }).urgency, 0.3)
})

const square = (fill: (dx: number, dz: number) => FarmSiteCell, size = 9): Record<string, FarmSiteCell> => {
  const h = (size - 1) / 2
  const out: Record<string, FarmSiteCell> = {}
  for (let dx = -h; dx <= h; dx++) for (let dz = -h; dz <= h; dz++) out[`${dx},${dz}`] = dx === 0 && dz === 0 ? 'water' : fill(dx, dz)
  return out
}

test('farm site verdict: under a frozen lake, a dry dead field, a growing farm', () => {
  const frozen = farmSiteVerdict(square((dx) => dx < 3 ? 'ice' : 'water'))
  assert.equal(frozen.ok, false)
  assert.equal(!frozen.ok && frozen.fault, 'flooded')
  assert.match(!frozen.ok ? frozen.reason : '', /80 of 80 cells are water or ice/)
  const partly = square((dx, dz) => dx >= 2 ? 'ice' : 'farmland')
  partly['0,0'] = 'ice'
  assert.equal(farmSiteVerdict(partly).ok, false, 'the water froze and a quarter is wet')
  const stone = farmSiteVerdict(square(() => 'other'))
  assert.equal(!stone.ok && stone.fault, 'no_work')
  assert.equal(farmSiteVerdict(square(() => 'farmland')).ok, true)
  assert.equal(farmSiteVerdict(square((dx) => dx === 4 ? 'water' : 'tillable')).ok, true, 'a wet edge is fine')
})

test('farm names never reuse a bad farm\'s, candidates near a bad farm are skipped', () => {
  assert.equal(nextFarmName([]), 'farm:1')
  assert.equal(nextFarmName(['farm:1']), 'farm:2')
  assert.equal(nextFarmName(['farm:2', 'farm:1', 'pond']), 'farm:3')
  const bad = [{ x: 561, z: -20, size: 9 }]
  assert.equal(nearBadSite({ x: 570, z: -20 }, bad), true)
  assert.equal(nearBadSite({ x: 574, z: -20 }, bad), false)
})

test('a site with lava or ice close by is never chosen', () => {
  const cells: SiteCandidate['cells'] = {}
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) cells[`${dx},${dz}`] = dx === 0 && dz === 0 ? 'water' : 'tillable'
  const c: SiteCandidate = { water: { x: 0, y: 63, z: 0 }, cells, around: [], distance: 10 }
  assert.ok(scoreSite(c) !== null)
  assert.equal(scoreSite({ ...c, around: ['hazard'] }), null)
})

test('spares: torches from coal, a second stone pickaxe', () => {
  assert.deepEqual(spareCraft({ coal: 2, stick: 1, torch: 4 }), { item: 'torch', count: 8 })
  assert.equal(spareCraft({ coal: 2, torch: 20, stone_pickaxe: 1 }), null)
  assert.deepEqual(spareCraft({ torch: 20, stone_pickaxe: 1, cobblestone: 5, stick: 4 }), { item: 'stone_pickaxe', count: 1 })
  assert.equal(spareCraft({ torch: 20, stone_pickaxe: 2, cobblestone: 5, stick: 4 }), null)
})

test('farmCells reads water and ice over the field, farmland and dirt', () => {
  const blocks = new Map<string, string>()
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) { blocks.set(`${dx},63,${dz}`, 'farmland'); blocks.set(`${dx},64,${dz}`, 'air') }
  blocks.set('0,63,0', 'water')
  blocks.set('1,64,1', 'ice')
  blocks.set('-1,64,-1', 'water')
  blocks.set('1,63,-1', 'grass_block')
  const pos = (x = 0, y = 0, z = 0): any => ({ x, y, z, clone: () => pos(x, y, z), set: (a: number, b: number, c: number) => pos(a, b, c) })
  const bot = {
    entity: { position: pos() },
    blockAt: (p: { x: number, y: number, z: number }) => { const n = blocks.get(`${p.x},${p.y},${p.z}`); return n ? { name: n } : null }
  }
  const cells = farmCells(bot as any, { x: 0, y: 63, z: 0, size: 3 })!
  assert.equal(cells['1,1'], 'ice')
  assert.equal(cells['-1,-1'], 'water')
  assert.equal(cells['0,0'], 'water')
  assert.equal(cells['1,-1'], 'tillable')
  assert.equal(cells['0,1'], 'farmland')
  assert.equal(farmCells(bot as any, { x: 50, y: 63, z: 0, size: 3 }), null, 'not loaded')
})

test('the Minecraft provider: five needs, unique chores for every mode, four site kinds', async () => {
  const { minecraftNeeds } = await import('../src/adapters/minecraft-java/needs/index.ts')
  const p = minecraftNeeds({ settings: {}, storage: { get: (_k: string, fb: unknown) => fb, set () {} }, getAction: () => undefined } as any)
  assert.deepEqual(p.needs.map(n => n.name), ['safety', 'food', 'gear', 'supplies', 'rest'])
  const names = p.chores.map(c => c.name)
  assert.equal(new Set(names).size, names.length)
  for (const m of ['passive', 'idle', 'active', 'explore']) assert.ok(p.chores.some(c => c.mode === m), m)
  assert.deepEqual(p.sites!.map(s => s.kind), ['farm', 'bed', 'chest', 'home'])
  assert.equal(p.siteFromFailure!('farm_setup', "couldn't get to farm:1: no path", { agent: { storage: { get: () => [{ name: 'farm:1', x: 1, y: 2, z: 3, size: 9 }] } } } as any)?.verdict.ok, false)
})
