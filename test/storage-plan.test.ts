// Home storage: chest roles, what deposit_when_full keeps and where it goes (storagePlan.ts),
// taking seeds, iron and gear out of its chests, the bed planner looking into unopened chests,
// and protected zones that need a real second refusal (core/protection.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  depositKeep, depositable, planDeposit, slotsUsed, roleAccepts, planChestSpot, chestSpotProblem, chestTakes, gearWant, ironStillNeeded,
  type DepositChest
} from '../src/skills/storagePlan.ts'
import { parseChestRoles, parseChestList } from '../src/skills/searchPlan.ts'
import { upgradeTakes } from '../src/skills/progression.ts'
import { farmChore, type ChoreWorld } from '../src/skills/foodPlan.ts'
import { nextBedStep, type BedWorld, type CellAt } from '../src/skills/bedPlan.ts'
import { refusalVerdict, ProtectedAreas, CONFIRM_GAP_MS } from '../src/core/protection.ts'

const FOOD = new Set(['bread', 'cooked_beef', 'apple', 'carrot', 'potato'])
const isFood = (n: string) => FOOD.has(n)
const stackSize = (n: string) => /snowball|egg|ender_pearl/.test(n) ? 16 : /(_pickaxe|_sword|shield|_bed)$/.test(n) ? 1 : 64

// ------------------------------------------------------------------ chest roles

test('storage.chests: plain positions stay valid, roles optional, first one the pantry', () => {
  const r = parseChestRoles([[559, 69, -47], [561, 69, -47]])
  assert.deepEqual(r, [{ x: 559, y: 69, z: -47, role: 'pantry' }, { x: 561, y: 69, z: -47, role: 'storage' }])
  const mixed = parseChestRoles([{ at: [1, 64, 1], role: 'gear' }, '2 64 2', { at: '3 64 3', role: 'Storage' }, { x: 4, y: 64, z: 4 }, { at: [5, 64], role: 'pantry' }, { at: [6, 64, 6], role: 'bogus' }])
  assert.deepEqual(mixed.map(c => c.role), ['gear', 'storage', 'storage', 'storage', 'storage'])
  assert.deepEqual(mixed.map(c => c.x), [1, 2, 3, 4, 6], 'a bad position is skipped')
  assert.deepEqual(parseChestList([{ at: [1, 64, 1], role: 'gear' }, [2, 64, 2]]), [{ x: 1, y: 64, z: 1 }, { x: 2, y: 64, z: 2 }])
  assert.deepEqual(parseChestRoles([{ at: [9, 64, 9], role: 'pantry' }, { at: [8, 64, 8], role: 'pantry' }]).map(c => c.role), ['pantry', 'pantry'])
  assert.deepEqual(parseChestRoles('nope'), [])
})

test('roleAccepts: the pantry takes food only, a gear chest gear only, storage anything', () => {
  assert.equal(roleAccepts('pantry', 'bread', isFood), true)
  assert.equal(roleAccepts('pantry', 'snowball', isFood), false)
  assert.equal(roleAccepts('gear', 'iron_ingot', isFood), true)
  assert.equal(roleAccepts('gear', 'red_bed', isFood), true)
  assert.equal(roleAccepts('gear', 'dirt', isFood), false)
  assert.equal(roleAccepts('storage', 'dirt', isFood), true)
})

// ------------------------------------------------------------------ what it keeps

test('depositKeep: tools, armour, food, bed, shield, farm seeds, iron while tools are to make', () => {
  const inv = {
    iron_pickaxe: 1, stone_sword: 1, shield: 1, red_bed: 1, bread: 20, wheat_seeds: 50, iron_ingot: 9, raw_iron: 2, coal: 30,
    snowball: 96, gunpowder: 1, lead: 2, oak_sapling: 3, spruce_log: 20, spruce_planks: 40, cobblestone: 100, dirt: 30, torch: 10
  }
  const store = depositable(inv, { isFood, iron: true })
  assert.deepEqual(store, { wheat_seeds: 18, snowball: 96, gunpowder: 1, lead: 2, oak_sapling: 3, spruce_log: 12, spruce_planks: 24, cobblestone: 84, dirt: 30 })
  const done = depositable(inv, { isFood, iron: false })
  assert.equal(done.iron_ingot, 9, 'tools done: iron may go')
  assert.equal(done.coal, 14, 'a stack of coal stays for torches')
  assert.equal(depositKeep(inv, { isFood }).red_bed, Infinity)
  assert.equal(depositable({ dirt: 5 }, { isFood, keep: ['dirt'] }).dirt, undefined, 'keep list')
  assert.equal(depositable({ arrow: 20, bow: 1 }, { isFood }).arrow, undefined, 'arrows with a bow')
  assert.equal(depositable({ arrow: 20 }, { isFood }).arrow, 20)
})

test('ironStillNeeded: until iron tools (and armour) are all there', () => {
  assert.equal(ironStillNeeded({ stone_pickaxe: 1 }), true)
  const tools = { iron_pickaxe: 1, iron_sword: 1, diamond_axe: 1, iron_shovel: 1 }
  assert.equal(ironStillNeeded(tools), false)
  assert.equal(ironStillNeeded(tools, true), true, 'armour still to make')
  assert.equal(ironStillNeeded({ ...tools, iron_helmet: 1, iron_chestplate: 1, diamond_leggings: 1, iron_boots: 1 }, true), false)
  assert.equal(ironStillNeeded({ ...tools, leather_helmet: 1, iron_chestplate: 1, iron_leggings: 1, iron_boots: 1 }, true), true, 'leather is not iron')
})

// ------------------------------------------------------------------ where it goes

const pantryFull: Record<string, number> = {
  bread: 240, cooked_beef: 18, spruce_log: 9, wheat_seeds: 35, snowball: 96, spruce_planks: 2, gunpowder: 1, spruce_sapling: 1, lead: 2,
  gravel: 10, charcoal: 1, arrow: 2, bone: 3, wheat: 1, glass_bottle: 2, redstone: 6, stick: 3, dirt: 2, cobblestone: 27
}
const chest = (over: Partial<DepositChest>): DepositChest => ({ x: 0, y: 64, z: 0, role: 'storage', own: false, contents: {}, distance: 5, ...over })

test('planDeposit: never the pantry for non-food (the live case: pantry full of snowballs)', () => {
  assert.equal(slotsUsed(pantryFull, stackSize), 27)
  const pantry = chest({ x: 559, z: -47, role: 'pantry', contents: { bread: 10 } })
  const second = chest({ x: 561, z: -47, role: 'storage', contents: { red_bed: 1, shield: 1, iron_ingot: 9 } })
  const p = planDeposit({ snowball: 16, dirt: 20 }, [pantry, second], { isFood, stackSize })
  assert.equal(p.do, 'deposit')
  assert.deepEqual(p.do === 'deposit' && p.at, { x: 561, y: 64, z: -47 })
  // only a pantry with room: no deposit there, a new chest instead
  assert.equal(planDeposit({ snowball: 16 }, [pantry], { isFood, stackSize, canPlace: true }).do, 'place')
  assert.equal(planDeposit({ snowball: 16 }, [pantry], { isFood, stackSize }).do, 'nothing')
  // food may go to the pantry
  const f = planDeposit({ bread: 5 }, [pantry, second], { isFood, stackSize })
  assert.deepEqual(f.do === 'deposit' && f.at, { x: 559, y: 64, z: -47 })
})

test('planDeposit: its own placed chests first, then configured storage; gear chests only gear; full ones skipped', () => {
  const own = chest({ x: 10, own: true, contents: { dirt: 3 }, distance: 20 })
  const cfg = chest({ x: 20, distance: 2 })
  const p = planDeposit({ dirt: 30, gravel: 5 }, [cfg, own], { isFood, stackSize })
  assert.equal(p.do === 'deposit' && p.at.x, 10, 'own chest though further')
  const full = Object.fromEntries(Array.from({ length: 27 }, (_, i) => [`item_${i}`, 64]))
  const ownFull = chest({ x: 10, own: true, contents: full })
  assert.equal(planDeposit({ dirt: 30 }, [ownFull, cfg], { isFood, stackSize }).do === 'deposit', true)
  const q = planDeposit({ dirt: 30 }, [ownFull, cfg], { isFood, stackSize })
  assert.equal(q.do === 'deposit' && q.at.x, 20)
  // a full chest still takes what tops up a partial stack
  const almost = chest({ x: 30, own: true, contents: { ...Object.fromEntries(Array.from({ length: 26 }, (_, i) => [`item_${i}`, 64])), dirt: 10 } })
  const r = planDeposit({ dirt: 100 }, [almost], { isFood, stackSize })
  assert.deepEqual(r.do === 'deposit' && r.items, { dirt: 54 })
  // gear chest: iron yes, dirt no
  const gear = chest({ x: 40, role: 'gear' })
  const g = planDeposit({ iron_ingot: 5, dirt: 5 }, [gear], { isFood, stackSize, canPlace: true })
  assert.deepEqual(g.do === 'deposit' && g.items, { iron_ingot: 5 })
  assert.equal(planDeposit({ dirt: 5 }, [gear], { isFood, stackSize, canPlace: true }).do, 'place')
  // protected chests are left alone
  assert.equal(planDeposit({ dirt: 5 }, [chest({ protected: true })], { isFood, stackSize, canPlace: true }).do, 'place')
  // never looked inside: counts as room, after known ones
  const unknown = chest({ x: 50, own: true, contents: null, distance: 1 })
  const known = chest({ x: 60, own: true, contents: {}, distance: 30 })
  const u = planDeposit({ dirt: 5 }, [unknown, known], { isFood, stackSize })
  assert.equal(u.do === 'deposit' && u.at.x, 60)
  assert.equal(planDeposit({}, [known], { isFood, stackSize }).do, 'nothing')
})

// ------------------------------------------------------------------ a new chest near home

function world (extra: Record<string, string> = {}): CellAt {
  return (x, y, z) => {
    const name = extra[`${x} ${y} ${z}`] ?? (y <= 67 ? 'stone' : 'air')
    const free = name === 'air' || name === 'short_grass'
    const solid = !free && !/door|gate|trapdoor|_bed$|chest|torch/.test(name)
    return { name, solid, free }
  }
}
const home = { x: 560, y: 68, z: -46 }

test('planChestSpot: near home, never on the home spot, outside before inside', () => {
  const s = planChestSpot(home, world())!
  assert.ok(s)
  assert.ok(!(s.at.x === 560 && s.at.z === -46))
  assert.equal(s.at.y, 68)
  assert.equal(s.indoors, false)
  // a roof over everything within 3 blocks of home: the chest goes outside it
  const roof: Record<string, string> = {}
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) roof[`${560 + dx} 72 ${-46 + dz}`] = 'oak_planks'
  const out = planChestSpot(home, world(roof))!
  assert.equal(out.indoors, false)
  assert.ok(Math.max(Math.abs(out.at.x - 560), Math.abs(out.at.z + 46)) > 3)
  // roofed everywhere: inside is the last resort
  const sky: Record<string, string> = {}
  for (let dx = -8; dx <= 8; dx++) for (let dz = -8; dz <= 8; dz++) sky[`${560 + dx} 72 ${-46 + dz}`] = 'oak_planks'
  assert.equal(planChestSpot(home, world(sky))!.indoors, true)
  assert.equal(planChestSpot(home, world(), { avoid: () => true }), null)
})

test('chestSpotProblem: paths, doors, other chests, farmland, passages', () => {
  const p = { x: 10, y: 68, z: 10 }
  assert.equal(chestSpotProblem(world(), p), null)
  assert.match(chestSpotProblem(world({ '10 67 10': 'dirt_path' }), p)!, /dirt_path/)
  assert.match(chestSpotProblem(world({ '11 67 10': 'dirt_path' }), p)!, /beside the dirt_path/)
  assert.match(chestSpotProblem(world({ '11 68 10': 'oak_door' }), p)!, /oak_door/)
  assert.match(chestSpotProblem(world({ '11 68 10': 'chest' }), p)!, /chest/)
  assert.match(chestSpotProblem(world({ '10 67 10': 'farmland' }), p)!, /farmland/)
  assert.equal(chestSpotProblem(world({ '10 69 10': 'stone' }), p), 'no air above to open it')
  const walls: Record<string, string> = {}
  for (let z = 0; z <= 20; z++) for (const x of [9, 11]) for (const y of [68, 69]) walls[`${x} ${y} ${z}`] = 'stone'
  assert.equal(chestSpotProblem(world(walls), p), 'would block a passage')
  assert.match(chestSpotProblem(world(), p, { avoid: () => true })!, /off limits/)
})

// ------------------------------------------------------------------ taking things out

test('chestTakes: known chests first, a reserve left behind, unknown ones to look into', () => {
  const chests = [{ x: 1, y: 64, z: 1, contents: { wheat_seeds: 35, bread: 9 } }, { x: 2, y: 64, z: 2, contents: null }]
  const t = chestTakes({ wheat_seeds: 20 }, chests)
  assert.deepEqual(t.take, [{ at: { x: 1, y: 64, z: 1 }, items: { wheat_seeds: 20 } }])
  assert.deepEqual(t.look, [])
  const r = chestTakes({ wheat_seeds: 40 }, chests, { wheat_seeds: 5 })
  assert.deepEqual(r.take[0]!.items, { wheat_seeds: 30 })
  assert.deepEqual(r.short, { wheat_seeds: 10 })
  assert.deepEqual(r.look, [{ x: 2, y: 64, z: 2 }])
})

test('gearWant: a shield when it has none, armour for empty slots (iron or better)', () => {
  assert.deepEqual(gearWant({}, { shield: 1, iron_ingot: 9, red_bed: 1 }), { shield: 1 })
  assert.deepEqual(gearWant({ shield: 1 }, { shield: 1 }), {})
  assert.deepEqual(gearWant({ iron_helmet: 1 }, { iron_helmet: 1, diamond_boots: 1, iron_boots: 1, leather_leggings: 1 }), { diamond_boots: 1 })
})

test('upgradeTakes: iron, then fuel for raw iron, cobblestone below stone, nothing past the target', () => {
  const stone = { stone_pickaxe: 1, stone_sword: 1, stone_axe: 1, stone_shovel: 1 }
  // the live case: 9 ingots in the second chest, stone tools
  assert.deepEqual(upgradeTakes(stone, { iron_ingot: 9, red_bed: 1, shield: 1 }), { iron_ingot: 9 })
  assert.deepEqual(upgradeTakes(stone, { iron_ingot: 20 }), { iron_ingot: 9 }, 'pickaxe 3 + sword 2 + axe 3 + shovel 1')
  assert.deepEqual(upgradeTakes({ ...stone, iron_ingot: 1 }, { iron_ingot: 20 }), { iron_ingot: 8 })
  assert.deepEqual(upgradeTakes(stone, { raw_iron: 4, coal: 5 }), { raw_iron: 4, coal: 1 })
  assert.deepEqual(upgradeTakes({ ...stone, raw_iron: 9 }, { charcoal: 5 }), { charcoal: 2 })
  assert.deepEqual(upgradeTakes({ wooden_pickaxe: 1 }, { cobblestone: 27 }).cobblestone, 9, 'stone pickaxe, sword, axe, shovel')
  assert.deepEqual(upgradeTakes({ wooden_pickaxe: 1 }, { cobblestone: 27, iron_ingot: 9 }, { upTo: 'stone' }), { cobblestone: 9 })
  const iron = { iron_pickaxe: 1, iron_sword: 1, iron_axe: 1, iron_shovel: 1 }
  assert.deepEqual(upgradeTakes(iron, { iron_ingot: 9 }), {}, 'iron tools done, no armour wanted')
  assert.deepEqual(upgradeTakes(iron, { iron_ingot: 9 }, { armour: true }), { iron_ingot: 9 })
  assert.deepEqual(upgradeTakes(iron, { diamond: 20 }, { upTo: 'diamond' }), { diamond: 9 })
  assert.deepEqual(upgradeTakes(iron, { iron_ingot: 9 }, { mining: { ready: false, shieldFirst: true } }), { iron_ingot: 1 }, 'a shield first')
})

// ------------------------------------------------------------------ seeds from chests

const chores: ChoreWorld = {
  food: 18, night: false, danger: false, hasFarm: true, canStartFarm: true, seeds: 1, grass: false, farmDistance: 20,
  farmWork: 0, farmSeedsWanted: 84, farmSize: 9, farmTarget: 9, canBreed: false, now: 1
}
const choreOpts = { growFarm: true, startFarm: true, breed: true, minSeeds: 8, farmAbove: 14, tendRange: 128, seedReserve: 4 }

test('farmChore: seeds in its chests start the seeds chore without grass (the live case: 1 seed, 35 in the pantry)', () => {
  assert.equal(farmChore(chores, choreOpts), null, 'no grass, no chest seeds: nothing')
  const c = farmChore({ ...chores, chestSeeds: 35 }, choreOpts)
  assert.equal(c?.chore, 'seeds')
  assert.match(c!.reason, /35 in my chests/)
  const none = { ...chores, hasFarm: false, farmDistance: null, seeds: 2 }
  assert.equal(farmChore({ ...none, chestSeeds: 10 }, choreOpts)?.chore, 'seeds')
  assert.equal(farmChore({ ...chores, chestSeeds: 35, night: true }, choreOpts), null, 'still not at night')
})

// ------------------------------------------------------------------ the bed in a chest it never opened

test('nextBedStep: at night, a chest by home it never looked into is opened before giving up for the night', () => {
  const w: BedWorld = {
    now: 1, home: { x: 560, y: 68, z: -46, dimension: 'overworld' }, inHomeDim: true, spawn: { status: 'unknown' }, spawnBed: 'unknown', ownBed: null, inv: {},
    chests: [{ x: 559, y: 69, z: -47, contents: { bread: 240, wheat_seeds: 35 } }, { x: 561, y: 69, z: -47, contents: {}, unknown: true }],
    shearable: 0, huntable: 0, night: true, searches: [],
    can: { craft: true, hunt: true, shear: true, search: true, withdraw: true, place: true, use: true }
  }
  assert.deepEqual(nextBedStep(w), { do: 'look', at: { x: 561, y: 69, z: -47 }, why: 'my chest at 561 69 -47 may hold a bed; I haven\'t looked inside yet' })
  // once looked into, the bed is fetched, night or not
  const seen = { ...w, chests: [w.chests[0]!, { x: 561, y: 69, z: -47, contents: { red_bed: 1, shield: 1, iron_ingot: 9 } }] }
  assert.deepEqual(nextBedStep(seen), { do: 'withdraw', item: 'red_bed', count: 1, from: { x: 561, y: 69, z: -47 }, why: 'a red_bed in my chest' })
  // nothing there: only then the sheep wait for day
  const empty = { ...w, chests: [w.chests[0]!, { x: 561, y: 69, z: -47, contents: {} }] }
  assert.equal(nextBedStep(empty)?.do, 'stuck')
})

// ------------------------------------------------------------------ protected zones

test('refusalVerdict: crops never, one lag burst counts once, a second refusal minutes later confirms', () => {
  const at = { x: 561, y: 63, z: -20 }
  assert.equal(refusalVerdict([], at, { crop: true }), 'ignore')
  assert.equal(refusalVerdict([], at, { confirmed: true }), 'zone')
  assert.equal(refusalVerdict([], at, { now: 0 }), 'suspect')
  const first = [{ ...at, t: 0 }]
  assert.equal(refusalVerdict(first, { x: 563, y: 63, z: -19 }, { now: 500 }), 'suspect', 'same rollback burst')
  assert.equal(refusalVerdict(first, { x: 563, y: 63, z: -19 }, { now: CONFIRM_GAP_MS + 1 }), 'zone')
  assert.equal(refusalVerdict(first, { x: 563, y: 63, z: -19 }, { now: 6 * 60_000 }), 'suspect', 'too long after')
  assert.equal(refusalVerdict(first, { x: 600, y: 63, z: -19 }, { now: 60_000 }), 'suspect', 'somewhere else')
})

test('ProtectedAreas: a harvest rollback over the farm makes no zone; two real refusals do', async () => {
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const pa = new ProtectedAreas(join(tmpdir(), `mcb-prot-farm-${process.pid}.json`))
  pa.clear()
  for (let i = 0; i < 5; i++) assert.equal(pa.add({ x: 561 + i, y: 63, z: -20 }, { crop: true, now: i * 10_000 }), false)
  assert.equal(pa.isProtected({ x: 561, y: 63, z: -20 }), false)
  // a lag burst: three refusals within a second
  assert.equal(pa.add({ x: 100, y: 64, z: 100 }, { now: 100_000 }), false)
  assert.equal(pa.add({ x: 101, y: 64, z: 100 }, { now: 100_200 }), false)
  assert.equal(pa.add({ x: 102, y: 64, z: 100 }, { now: 100_400 }), false)
  assert.equal(pa.isProtected({ x: 100, y: 64, z: 100 }), false)
  // refused again a minute later: a zone
  assert.equal(pa.add({ x: 100, y: 64, z: 101 }, { now: 160_000 }), true)
  assert.equal(pa.isProtected({ x: 110, y: 64, z: 110 }), true)
  pa.clear()
})
