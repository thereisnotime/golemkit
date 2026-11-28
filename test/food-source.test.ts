// Food sources in the cold: the source registry, repairing or moving a bad farm, the base's
// farm plot without a bucket, and the bot's own builds near a farm site.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chooseFoodSource, foodSourceSettings, foodSourceText, noteSourceRun, FOOD_SOURCE_DEFAULTS, type FoodSourceWorld } from '../src/skills/foodSourcePlan.ts'
import { planFarmRepair, farmRepairSettings, type FarmRepairInput } from '../src/skills/farmRepairPlan.ts'
import {
  planPlotFarm, hydrated, torchLight, growthChance, choosePlotWater, plotSeedNeed, plantableCells, plotFarmSettings, PLOT_FARM_DEFAULTS,
  type PlotCell, type PlotFarmInput, type PlotWaterInput
} from '../src/skills/plotFarmPlan.ts'
import { ownWorkTest, siteProblem, type SiteCandidate } from '../src/skills/foodPlan.ts'
import { farmSiteVerdict, type FarmSiteCell } from '../src/skills/needPlan.ts'
import { planFarmWork } from '../src/skills/farmPlan.ts'
import { nextFarmTask, type FarmState } from '../src/adapters/minecraft-java/behaviors/farm.ts'

const world = (x: Partial<FoodSourceWorld> = {}): FoodSourceWorld => ({
  now: 1_000_000, farms: [], badFarm: null, badFarmMode: 'auto', canDig: true, canPlace: true, seeds: 3, chestSeeds: 0, grass: false,
  plot: null, rod: false, canMakeRod: false, water: false, breed: false, hunt: 0, forage: 0, stock: 20, failed: {}, ...x
})
const S = FOOD_SOURCE_DEFAULTS

test('food sources: the first one that fits, with why the ones before it were skipped', () => {
  // the cold lake shore: a bad farm, 3 seeds, no grass, a plot in the base
  const pax = world({ badFarm: { name: 'farm:1', reason: '46 of 80 cells are water or ice', tries: 0, gaveUp: false }, plot: { known: true, used: false } })
  const c = chooseFoodSource(pax, S)
  assert.equal(c.active, 'repair')
  assert.equal(c.run, true)
  // repair gave up, the field farm failed a moment ago: the plot
  const after = chooseFoodSource({ ...pax, badFarm: { ...pax.badFarm!, gaveUp: true, tries: 2 }, failed: { farm: { until: pax.now + 30 * 60_000, reason: 'no flat grass next to water' } } }, S)
  assert.equal(after.active, 'plot')
  assert.deepEqual(after.skipped.map(s => s.name), ['repair', 'farm'])
  assert.match(foodSourceText(after), /food source: plot .*skipped repair: gave up on farm:1 after 2 repairs.*farm: failed 30m ago: no flat grass/)
  // too few seeds for a field farm and no grass: skipped with the reason
  const few = chooseFoodSource(world({ plot: { known: true, used: false } }), S)
  assert.equal(few.active, 'plot')
  assert.match(few.skipped.find(s => s.name === 'farm')!.reason, /3 seeds and no grass near \(8 to start\)/)
})

test('food sources: a farm it has wins in its place; stock sources only run while food is low', () => {
  const plot = world({ farms: [{ name: 'farm:2', kind: 'plot' }], plot: { known: true, used: true } })
  const c = chooseFoodSource(plot, { ...S, sources: ['plot', 'farm'] })
  assert.equal(c.active, 'plot'); assert.equal(c.have, 'farm:2'); assert.equal(c.run, false)
  // field farm first in the order while only the plot exists: try a field farm too
  assert.equal(chooseFoodSource({ ...plot, seeds: 10 }, S).active, 'farm')
  const fish = world({ canDig: false, rod: true, water: true })
  const full = chooseFoodSource(fish, S)
  assert.equal(full.active, 'fish'); assert.equal(full.run, false, '20 food items: enough')
  assert.equal(chooseFoodSource({ ...fish, stock: 4 }, S).run, true)
  assert.equal(chooseFoodSource(world({ canDig: false, canMakeRod: true, water: false, hunt: 3 }), S).active, 'animals')
  assert.equal(chooseFoodSource(world(), { ...S, sources: [] }).active, null)
  assert.equal(chooseFoodSource(world({ forage: 2, canDig: false }), { ...S, sources: ['fish', 'forage'] }).active, 'forage')
})

test('food source settings and the failure memory', () => {
  assert.deepEqual(foodSourceSettings(undefined).sources, ['repair', 'farm', 'plot', 'animals', 'fish', 'forage'])
  assert.deepEqual(foodSourceSettings({ sources: 'fish, plot, nonsense' }).sources, ['fish', 'plot'])
  assert.deepEqual(foodSourceSettings(false).sources, [])
  assert.equal(foodSourceSettings({}, { plot: false }).plot, false)
  const f = noteSourceRun({}, 'farm', false, 'no site', 0, { retryMinutes: 60 })
  assert.equal(f.farm?.until, 3_600_000)
  assert.deepEqual(noteSourceRun(f, 'farm', true, 'ok', 1, { retryMinutes: 60 }), {})
})

const square = (fill: (dx: number, dz: number) => FarmSiteCell, centre: FarmSiteCell = 'water', size = 9): Record<string, FarmSiteCell> => {
  const h = (size - 1) / 2
  const out: Record<string, FarmSiteCell> = {}
  for (let dx = -h; dx <= h; dx++) for (let dz = -h; dz <= h; dz++) out[`${dx},${dz}`] = dx === 0 && dz === 0 ? centre : fill(dx, dz)
  return out
}
const landOf = (c: Record<string, FarmSiteCell>, pred: (dx: number, dz: number) => boolean) => Object.keys(c).filter(k => { const [x, z] = k.split(',').map(Number); return pred(x!, z!) })
const repair = (x: Partial<FarmRepairInput>): FarmRepairInput => ({
  cells: {}, mode: 'auto', iceWater: true, canKeepOpen: true, blocks: 20, canDig: true, canPlace: true, bucket: false, maxBlocks: 16, tries: 0, maxTries: 2, ...x
})

test('bad farm: an older shore farm with the lake beside it was a false alarm and comes back', () => {
  // farm:1: no land list, the lake on one side (46 wet of 80), 34 dry cells
  const shore = square((dx, dz) => dx >= 0 && !(dx === 0 && dz < -3) ? 'ice' : 'farmland')
  const v = farmSiteVerdict(shore)
  assert.equal(v.ok, true, 'judged on the dry field')
  assert.equal(planFarmRepair(repair({ cells: shore })).decision, 'restore')
})

test('bad farm: frozen middle is thawed, a small flood filled, a big one moved (or left in repair mode)', () => {
  const land = landOf(square(() => 'farmland'), dx => dx < 0)
  const frozen = square((dx) => dx < 0 ? 'farmland' : 'ice', 'ice')
  const t = planFarmRepair(repair({ cells: frozen, land }))
  assert.equal(t.decision, 'repair'); assert.equal(t.thaw, true); assert.deepEqual(t.fill, [])
  assert.equal(planFarmRepair(repair({ cells: frozen, land, iceWater: false })).decision, 'relocate')
  assert.equal(planFarmRepair(repair({ cells: frozen, land, canKeepOpen: false, mode: 'repair' })).decision, 'leave')
  // the lake crept 1 column in: 9 cells to fill
  const crept = square((dx) => dx < -1 ? 'farmland' : dx === -1 ? 'water' : 'ice')
  const f = planFarmRepair(repair({ cells: crept, land }))
  assert.equal(f.decision, 'repair'); assert.equal(f.fill.length, 9)
  assert.equal(planFarmRepair(repair({ cells: crept, land, maxBlocks: 4 })).decision, 'relocate')
  assert.equal(planFarmRepair(repair({ cells: crept, land, blocks: 2, canDig: false })).decision, 'relocate')
  // water running over most of the field from above: filling the ground can't fix it
  const over = landOf(crept, dx => dx < 0)
  assert.match(planFarmRepair(repair({ cells: square(() => 'water'), land, over })).reason, /from somewhere above/)
  assert.equal(planFarmRepair(repair({ cells: frozen, land, tries: 2 })).decision, 'relocate')
  assert.equal(planFarmRepair(repair({ cells: frozen, land, mode: 'relocate' })).decision, 'relocate')
  assert.equal(planFarmRepair(repair({ cells: frozen, land, mode: 'off' })).decision, 'leave')
  assert.equal(planFarmRepair(repair({ cells: square(() => 'farmland', 'other'), land })).decision, 'relocate', 'water gone, no bucket')
  assert.equal(planFarmRepair(repair({ cells: square(() => 'farmland', 'other'), land, bucket: true })).rewater, true)
  assert.deepEqual(farmRepairSettings(undefined), { badFarm: 'auto', repairMaxBlocks: 16, repairTries: 2 })
  assert.equal(farmRepairSettings({ badFarm: 'repair', repairMaxBlocks: 500 }).repairMaxBlocks, 80)
})

const plot = (fill: (dx: number, dz: number) => Partial<PlotCell> = () => ({}), size = 3): PlotCell[] => {
  const h = (size - 1) / 2
  const out: PlotCell[] = []
  for (let dx = -h; dx <= h; dx++) for (let dz = -h; dz <= h; dz++) out.push({ dx, dz, ground: 'tillable', above: 'air', sky: 15, block: 0, ...fill(dx, dz) })
  return out
}
const pin = (x: Partial<PlotFarmInput>): PlotFarmInput => ({
  size: 3, cells: plot(), water: [], iceItems: 0, plainBreak: true, freezes: true, torches: 4, dirt: 0, seeds: 8, torchSpots: [{ dx: -2, dz: 0 }, { dx: 2, dz: 0 }, { dx: 0, dz: 2 }], mode: 'auto', swap: true, ...x
})

test('the 1.21.1 farm rules the plot planner uses', () => {
  assert.equal(hydrated({ dx: 4, dz: -4 }, [{ dx: 0, dy: 0, dz: 0 }]), true)
  assert.equal(hydrated({ dx: 5, dz: 0 }, [{ dx: 0, dy: 0, dz: 0 }]), false)
  assert.equal(hydrated({ dx: 0, dz: 0 }, [{ dx: 1, dy: 1, dz: 0 }]), true, 'water one above counts')
  assert.equal(hydrated({ dx: 0, dz: 0 }, [{ dx: 1, dy: -1, dz: 0 }]), false, 'water below does not')
  assert.equal(torchLight({ dx: 1, dz: 1 }, [[0, 0]]), 12)
  assert.equal(growthChance(true), 1 / 3)
  assert.equal(growthChance(false), 1 / 7)
})

test('farm plot: dry with a torch in the middle, water in reach, carried ice, a dark roofed plot', () => {
  const dry = planPlotFarm(pin({}))
  assert.equal(dry.ok, true); assert.equal(dry.water, 'none'); assert.equal(dry.centre, 'torch'); assert.equal(dry.growth, 'dry')
  assert.equal(dry.till.length, 8); assert.deepEqual(dry.torches[0], [0, 0])
  assert.equal(planPlotFarm(pin({ seeds: 3 })).till.length, 3, 'only as many cells as seeds: bare dry farmland turns back')
  const near = planPlotFarm(pin({ water: [{ dx: 3, dy: 0, dz: 0 }] }))
  assert.equal(near.water, 'near'); assert.equal(near.centre, 'crop'); assert.equal(near.till.length, 8, 'the middle is planted too')
  const ice = planPlotFarm(pin({ iceItems: 1 }))
  assert.equal(ice.water, 'ice'); assert.equal(ice.centre, 'water')
  assert.ok(ice.torches.length >= 1, 'a ring torch keeps the water open under the sky')
  assert.equal(planPlotFarm(pin({ iceItems: 1, torches: 0 })).ok, false)
  assert.equal(planPlotFarm(pin({ iceItems: 1, torches: 0, freezes: false })).ok, true, 'roofed: never freezes')
  assert.equal(planPlotFarm(pin({ mode: 'water' })).ok, false)
  assert.equal(planPlotFarm(pin({ mode: 'dry', iceItems: 1 })).water, 'none')
  // a roof over it: no sky light, block light 0: torches until light 9 everywhere
  const dark = planPlotFarm(pin({ cells: plot(() => ({ sky: 0, block: 0 })), water: [{ dx: 3, dy: 0, dz: 0 }] }))
  assert.equal(dark.ok, true); assert.ok((dark.minLight ?? 0) >= 9)
  assert.equal(planPlotFarm(pin({ cells: plot(() => ({ sky: 0, block: 1 })), water: [{ dx: 3, dy: 0, dz: 0 }], torches: 0 })).ok, false)
})

test('farm plot: stone swapped for dirt only when allowed and with dirt; no seeds, no plot', () => {
  const stone = plot((dx, dz) => dx === 1 ? { ground: 'swap' } : {})
  assert.equal(planPlotFarm(pin({ cells: stone, dirt: 3 })).swap.length, 3)
  assert.equal(planPlotFarm(pin({ cells: stone, dirt: 1 })).swap.length, 1)
  assert.equal(planPlotFarm(pin({ cells: stone, swap: false })).till.length, 5)
  assert.match(planPlotFarm(pin({ cells: plot(() => ({ ground: 'swap' })), dirt: 0 })).reason, /no dirt/)
  assert.match(planPlotFarm(pin({ seeds: 0 })).reason, /no seeds/)
  const lake = planPlotFarm(pin({ cells: plot((dx, dz) => dx === 1 && dz === 1 ? {} : { ground: 'blocked' }).map(c => c.dx === 0 && c.dz === 0 ? { ...c, ground: 'tillable' as const } : c), water: [{ dx: 2, dy: 0, dz: 0 }] }))
  assert.match(lake.reason, /only 2 cells of the plot can hold a crop/, 'a plot mostly on lake ice is not worth it')
  // a centre it must not touch no longer refuses the plot: the other cells are the farm
  assert.equal(planPlotFarm(pin({ cells: plot((dx, dz) => dx === 0 && dz === 0 ? { ground: 'blocked' } : {}) })).ok, true)
})

test('a dry plot farm is tended without water', () => {
  const cells: Record<string, 'bare' | 'dirt' | 'blocked'> = {}
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) cells[`${dx},${dz}`] = dx === 0 && dz === 0 ? 'blocked' : 'dirt'
  const w = planFarmWork({ center: { x: 0, y: 0, z: 0 }, cells }, { targetSize: 3, seeds: 8, seedReserve: 0, dry: true })
  assert.equal(w.extend.length + w.retill.length, 8)
  assert.equal(w.water, null)
  assert.doesNotMatch(w.reason, /water is gone/)
  assert.equal(planFarmWork({ center: { x: 0, y: 0, z: 0 }, cells }, { targetSize: 3, seeds: 8, seedReserve: 0 }).extend.length, 0, 'not dry: no water, nothing hydrated')
})

test('own builds: its torches, blocks, farms and base never count as somebody\'s build', () => {
  const own = ownWorkTest({ blocks: ['1,2,3'], torches: [{ x: 563, y: 63, z: -40 }], farms: [{ x: 561, z: -20, size: 9 }], base: { x: 560, z: -43, radius: 12 }, boxes: [{ min: { x: 100, y: 60, z: 100 }, max: { x: 102, y: 60, z: 102 } }] })
  assert.equal(own({ x: 1, y: 2, z: 3 }), true)
  assert.equal(own({ x: 563, y: 63, z: -40 }), true, 'a torch light_home put by the lake')
  assert.equal(own({ x: 566, y: 63, z: -19 }), true, 'the fence ring of its own (bad) farm')
  assert.equal(own({ x: 570, y: 68, z: -50 }), true, 'its fortress walls')
  assert.equal(own({ x: 101, y: 62, z: 101 }), true)
  assert.equal(own({ x: 600, y: 63, z: -43 }), false)
  const c: SiteCandidate = { water: { x: 0, y: 0, z: 0 }, cells: { '0,0': 'water', '1,0': 'tillable' }, around: ['build'], distance: 0, buildNote: 'oak_fence at 3 0 1' }
  assert.equal(siteProblem(c, { minTillable: 1 }), 'somebody\'s build (oak_fence at 3 0 1)', 'the reason names the block')
})

test('farm_setup runs the chosen food source', () => {
  const base: FarmState = { night: false, hungry: false, hasFarm: false, canSetUp: true, farmDistance: null, ripe: 0, due: false, bake: 0, canBreed: false }
  const opts = { tend: true, tendRange: 128, minRipe: 8, bake: true, breed: true }
  assert.equal(nextFarmTask({ ...base, source: { active: 'plot', run: true, kind: 'lasting' } }, opts), 'source')
  assert.equal(nextFarmTask({ ...base, source: { active: null, run: false, kind: null } }, opts), null)
  assert.equal(nextFarmTask(base, opts), 'setup', 'no registry: the old rule')
  const farm = { ...base, hasFarm: true, farmDistance: 10, ripe: 9 }
  assert.equal(nextFarmTask({ ...farm, source: { active: 'repair', run: true, kind: 'lasting' } }, opts), 'tend', 'ripe crops first')
  assert.equal(nextFarmTask({ ...farm, ripe: 0, source: { active: 'repair', run: true, kind: 'lasting' } }, opts), 'source')
  assert.equal(nextFarmTask({ ...farm, ripe: 0, night: true, source: { active: 'repair', run: true, kind: 'lasting' } }, opts), null)
})

test('sensing the food sources on a (fake) bot does not throw, and farm_setup sees the plot', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { Vec3 } = await import('vec3')
  const { Agent, defineVariant } = await import('../src/core/index.ts')
  const { standardSkills, extendedSkills } = await import('../src/skills/index.ts')
  const { fakeBot, WORLDS } = await import('./fake-world.ts')
  const { attachFakeBot } = await import('./fake-attach.ts')
  const { senseFoodSources, foodSourceChoice } = await import('../src/skills/foodSources.ts')
  const { senseFarm } = await import('../src/adapters/minecraft-java/behaviors/farm.ts')
  const agent = new Agent(defineVariant({ name: 'food-test', skills: [...standardSkills(), ...extendedSkills()], brains: [] }), { host: 'x.invalid', port: 25565, auth: 'offline', version: '1.21.1' }, {
    username: 'Cold', owners: ['o'], dataDir: join(mkdtempSync(join(tmpdir(), 'golemkit-food-')), 'cold'), canDig: true
  })
  const bot = fakeBot({ ...WORLDS[Object.keys(WORLDS)[0]!]!, username: 'Cold', position: [0.5, 68, 0.5], gameMode: 'survival', health: 20, food: 20, timeOfDay: 1000, players: [], mobs: [], inventory: [['wheat_seeds', 3]] })
  bot.blockAt = (p: InstanceType<typeof Vec3>) => ({ name: p.y <= 67 ? 'grass_block' : 'air', position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), getProperties: () => ({}), boundingBox: p.y <= 67 ? 'block' : 'empty' })
  attachFakeBot(agent, bot)
  agent.storage.set('home', { x: 0, y: 68, z: 0, dimension: 'overworld' })
  agent.storage.set('projects.spots', { farm_plot: { x0: -1, z0: -1, size: 3, y: 67 } })
  const w = senseFoodSources(agent, bot)
  assert.equal(w.seeds, 3)
  assert.deepEqual(w.plot, { known: true, used: false })
  assert.equal(foodSourceChoice(agent, bot).active, 'plot')
  const s = senseFarm(agent, bot, { sources: true } as never)
  assert.equal(s.source?.active, 'plot')
  assert.equal(s.source?.run, true)
})

test('plot: a blocked centre gets the dry torch, the reason names what is in the way', () => {
  const p = planPlotFarm(pin({ cells: plot((dx, dz) => dx === 0 && dz === 0 ? { ground: 'blocked', name: 'chest' } : {}) }))
  assert.equal(p.ok, true, p.reason)
  assert.ok(p.till.length >= 3)
  const lake = planPlotFarm(pin({ cells: plot((dx, dz) => dx === 1 && dz === 1 ? {} : { ground: 'blocked', name: 'spruce_planks' }) }))
  assert.match(lake.reason, /spruce_planks it must not touch/)
})

// ------------------------------------------------------------------ a bigger plot inside the fortress

const win = (x: Partial<PlotWaterInput>): PlotWaterInput => ({
  size: 7, mode: 'auto', near: false, centreBlocked: false, waterBuckets: 0, storedWaterBuckets: 0, buckets: 0, iron: 0, fillFrom: true, ice: false, ...x
})

test('plot water: a bucket carried or stored, ice, an empty bucket, 3 iron for one, else dry', () => {
  assert.equal(choosePlotWater(win({ near: true, waterBuckets: 1 })).source, 'near')
  assert.equal(choosePlotWater(win({ waterBuckets: 1, ice: true })).source, 'bucket')
  assert.equal(choosePlotWater(win({ storedWaterBuckets: 1, ice: true })).source, 'chest_bucket')
  assert.equal(choosePlotWater(win({ ice: true, buckets: 1, iron: 9 })).source, 'ice')
  assert.equal(choosePlotWater(win({ buckets: 1, iron: 9 })).source, 'fill')
  assert.equal(choosePlotWater(win({ iron: 3 })).source, 'craft')
  // Pax: no bucket, no ice, 2 iron: dry, and the reason says what is missing
  const pax = choosePlotWater(win({ iron: 2 }))
  assert.equal(pax.source, 'none'); assert.match(pax.reason, /no water bucket, no bucket and 2 iron ingots \(3 make one\), no ice/)
  assert.equal(choosePlotWater(win({ iron: 3, fillFrom: false })).source, 'none', 'a bucket is no good without water to fill it')
  assert.match(choosePlotWater(win({ buckets: 1, fillFrom: false })).reason, /no water near home to fill my bucket/)
  assert.equal(choosePlotWater(win({ mode: 'dry', waterBuckets: 1 })).source, 'none')
  assert.equal(choosePlotWater(win({ centreBlocked: true, waterBuckets: 1 })).source, 'none')
  // a 3x3 keeps the old rule: water in reach or ice, never a bucket trip
  assert.equal(choosePlotWater(win({ size: 3, waterBuckets: 1 })).source, 'none')
  assert.equal(choosePlotWater(win({ size: 3, ice: true })).source, 'ice')
})

test('plot farm: a poured bucket wets the plot from the middle', () => {
  const wet = planPlotFarm(pin({ size: 7, cells: plot(() => ({}), 7), bucket: true, seeds: 64, freezes: false }))
  assert.equal(wet.ok, true); assert.equal(wet.water, 'bucket'); assert.equal(wet.centre, 'water'); assert.equal(wet.growth, 'wet')
  assert.equal(wet.till.length, 48)
  assert.ok(!wet.till.some(([dx, dz]) => dx === 0 && dz === 0), 'the middle is the water')
  assert.match(wet.reason, /water from a bucket poured in the middle/)
  // water in reach still wins: no need to pour
  assert.equal(planPlotFarm(pin({ bucket: true, water: [{ dx: 3, dy: 0, dz: 0 }] })).water, 'near')
  // the poured water freezes under the sky in the cold like ice water: a ring torch keeps it open
  assert.ok(planPlotFarm(pin({ bucket: true, freezes: true })).torches.length >= 1)
})

test('plot seeds: what the plot can take, against carried, chests and grass', () => {
  assert.deepEqual(plotSeedNeed({ cells: 48, carried: 7, stored: 10 }), { want: 48, fromChests: 10, fromGrass: 31 })
  assert.deepEqual(plotSeedNeed({ cells: 8, carried: 20, stored: 10 }), { want: 8, fromChests: 0, fromGrass: 0 })
  assert.deepEqual(plotSeedNeed({ cells: 8, carried: 2, stored: 0 }), { want: 8, fromChests: 0, fromGrass: 6 })
  // Pax's grown plot: 7 crops growing on the old 3x3, one bare farmland, a torch in the middle, stone floor around
  const cells = plot((dx, dz) => Math.abs(dx) <= 1 && Math.abs(dz) <= 1
    ? (dx === 0 && dz === 0 ? { ground: 'farmland', above: 'torch' } : { ground: 'farmland', above: dx === 1 && dz === 1 ? 'air' : 'crop' })
    : { ground: 'swap' }, 7)
  assert.equal(plantableCells(cells, false), 41, '40 stone cells and one bare farmland')
  assert.equal(plantableCells(plot(() => ({}), 5), true), 25)
  assert.equal(plantableCells(plot(() => ({}), 5), false), 24)
})

test('plot knobs: plotSize odd 3-11 (default 7), plotMin, plotSeedRadius; bad values fall back', () => {
  assert.deepEqual(plotFarmSettings(undefined), PLOT_FARM_DEFAULTS)
  assert.deepEqual(PLOT_FARM_DEFAULTS, { plotSize: 7, plotMin: 3, plotSeedRadius: 32 })
  assert.equal(plotFarmSettings({ plotSize: 8 }).plotSize, 7, 'even goes one down')
  assert.equal(plotFarmSettings({ plotSize: 99 }).plotSize, 7, 'out of range: the default')
  assert.equal(plotFarmSettings({ plotSize: 'big', plotSeedRadius: 48 }).plotSeedRadius, 48, 'one bad key keeps the others')
  assert.equal(plotFarmSettings({ plotSize: 5, plotMin: 9 }).plotMin, 5, 'plotMin never above plotSize')
  assert.equal(plotFarmSettings(false).plotSize, 7)
})

test('food sources: a plot that grew past its farm gets the farm extended', () => {
  const grown = world({ farms: [{ name: 'farm:2', kind: 'plot' }], plot: { known: true, used: true, grow: true } })
  const c = chooseFoodSource(grown, { ...S, sources: ['plot', 'farm'] })
  assert.equal(c.active, 'plot'); assert.equal(c.have, 'farm:2'); assert.equal(c.run, true)
  assert.match(c.reason, /extend the farm/)
  // failed a moment ago: leave it until the retry
  const failed = chooseFoodSource({ ...grown, failed: { plot: { until: grown.now + 60_000, reason: 'no seeds' } } }, { ...S, sources: ['plot', 'farm'] })
  assert.equal(failed.run, false); assert.equal(failed.have, 'farm:2')
  assert.equal(chooseFoodSource({ ...grown, canDig: false }, { ...S, sources: ['plot'] }).run, false)
})
