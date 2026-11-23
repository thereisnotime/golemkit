// Live test of keep_spawn_bed on a real server.
//   node scripts/bed-test.ts run 950 -300 [minutes]   walk to x/z (300+ blocks from spawn, the fortress and the village),
//                                                     set home there, arm keep_fed until fed, then keep_spawn_bed (asking off)
//                                                     with chop_wood_loop, and watch until the respawn point is set at home
//   node scripts/bed-test.ts remove                   break the beds, crafting tables and furnaces the last run put down
//   node scripts/bed-test.ts report                   the respawn record and the blocks the last run put down
// The bot is BED_BOT (default BedTest); data lives in data/bed-test. It never runs gamerule or op commands.
import { Agent, defineVariant, serverFromEnv, PRIORITY, fmtPos, type ActionResult } from '../src/core/index.ts'
import { standardSkills, extendedSkills, navigation } from '../src/skills/index.ts'
import { reflexes, behaviorsBrain } from '../src/brains/index.ts'
import { getSpawn, ownBeds } from '../src/skills/bed.ts'
import { spawnAtHome } from '../src/skills/bedPlan.ts'
import { getHome } from '../src/skills/navigation.ts'

const [mode = 'run', xs = '950', zs = '-300', mins = '40'] = process.argv.slice(2)
const X = Number(xs)
const Z = Number(zs)
const BOT = process.env.BED_BOT || 'BedTest'
const DATA = process.env.BED_DATA_DIR || 'data/bed-test'
const PLACED_KEY = 'bedtest.placed'
const KEEP_AWAY = [{ name: 'spawn', x: 545, z: 45 }, { name: 'fortress', x: 560, z: -43 }, { name: 'village', x: -2770, z: 1090 }]
const t0 = Date.now()
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`)
const pause = (ms: number) => new Promise(r => setTimeout(r, ms))

const variant = defineVariant({
  name: 'bed-test',
  skills: [...standardSkills(), navigation(), ...extendedSkills()],
  brains: [reflexes(), behaviorsBrain({ defaults: {} })]
})

async function step (agent: Agent, name: string, params: Record<string, unknown> = {}): Promise<ActionResult> {
  const t = Date.now()
  const r = await agent.act(name, params, { caller: { kind: 'system', name: 'bed-test' }, priority: PRIORITY.player })
  log(`${r.ok ? 'OK  ' : 'FAIL'} ${name} ${JSON.stringify(params)} (${((Date.now() - t) / 1000).toFixed(1)}s): ${r.message}`)
  return r
}

async function connect (agent: Agent): Promise<void> {
  const ready = new Promise<void>(resolve => agent.once('session', () => setTimeout(resolve, 4000)))
  void agent.start()
  await ready
}

function state (a: Agent): string {
  const b = a.bot
  const cur = a.currentAction ? `${a.currentAction.name} (${a.currentAction.caller.kind}:${a.currentAction.caller.name})` : 'idle'
  const inv = b.inventory.items().map(i => `${i.count} ${i.name}`).join(', ') || 'empty'
  return `at ${fmtPos(b.entity.position)} food ${b.food} health ${Math.round(b.health)} time ${b.time.timeOfDay} | ${cur} | ${inv}`
}

function newAgent (): Agent {
  const a = new Agent(variant, serverFromEnv(), { username: BOT, dataDir: DATA, canDig: true, owners: [] })
  a.on('actionEnd', (info: any, r: ActionResult) => { if (info.caller?.name !== 'bed-test') log(`${r.ok ? 'done' : 'FAIL'} ${info.name} (${info.caller.kind}:${info.caller.name}): ${r.message}`) })
  return a
}

/** Records beds, crafting tables, furnaces and chests that appear near home while the test runs, for `remove`. */
function watchPlaced (a: Agent): void {
  a.bot.on('blockUpdate', (old: any, now: any) => {
    const home = getHome(a)
    if (!home || !now || !/(_bed|crafting_table|furnace|chest|torch)$/.test(now.name) || (old && old.name === now.name)) return
    if (Math.hypot(now.position.x - home.x, now.position.z - home.z) > 24) return
    const list = a.storage.get<{ x: number, y: number, z: number, name: string }[]>(PLACED_KEY, [])
    if (list.some(p => p.x === now.position.x && p.y === now.position.y && p.z === now.position.z)) return
    a.storage.set(PLACED_KEY, [...list, { x: now.position.x, y: now.position.y, z: now.position.z, name: now.name }])
    log(`appeared near home: ${now.name} at ${fmtPos(now.position)}`)
  })
}

async function run (): Promise<void> {
  const near = KEEP_AWAY.find(p => Math.hypot(p.x - X, p.z - Z) < 300)
  if (near) { log(`${X} ${Z} is within 300 blocks of the ${near.name}; pick another spot`); return }
  const a = newAgent()
  await connect(a)
  for (const name of ['keep_spawn_bed', 'chop_wood_loop', 'keep_fed', 'stay_safe']) await step(a, 'behavior_disarm', { name }).catch(() => null)
  const others = Object.values(a.bot.players).filter(p => p.username !== BOT && p.entity && Math.hypot(p.entity.position.x - X, p.entity.position.z - Z) < 300)
  if (others.length) { log(`players near the test spot (${others.map(p => p.username).join(', ')}); stopping`); await a.stop(); return }
  log(`spawned: ${state(a)}; online: ${Object.keys(a.bot.players).filter(n => n !== BOT).join(', ') || 'nobody'}`)
  const far = () => Math.hypot(a.bot.entity.position.x - X, a.bot.entity.position.z - Z)
  for (let i = 0; i < 12 && far() > 12; i++) {
    while (a.currentAction) await pause(2000)
    if (!(await step(a, 'goto', { x: X, z: Z })).ok) await pause(3000)
  }
  if (far() > 24) { log(`never got to ${X} ${Z} (${Math.round(far())} away)`); await a.stop(); return }
  if (!getHome(a) || Math.hypot(getHome(a)!.x - X, getHome(a)!.z - Z) > 24) await step(a, 'set_home')
  watchPlaced(a)
  log(`start: ${state(a)}; spawn record ${JSON.stringify(getSpawn(a))}`)
  // fed first (the walk out costs food), then the bed; stay_safe stays off (its night walks home fight chop_wood_loop)
  await step(a, 'behavior_arm', { name: 'keep_fed', options: {} })
  const fedBy = Date.now() + 10 * 60_000
  while (a.bot.food < 14 && Date.now() < fedBy) { await pause(15_000); log(state(a)) }
  await step(a, 'behavior_arm', { name: 'chop_wood_loop', options: { keep: 2 } })
  await step(a, 'behavior_arm', { name: 'keep_spawn_bed', options: { ask: false, graceSeconds: 8 } })
  const until = Date.now() + Number(mins) * 60_000
  while (Date.now() < until) {
    await pause(15_000)
    log(state(a))
    if (spawnAtHome(getSpawn(a), getHome(a), 8)) { log(`respawn point at home: ${JSON.stringify(getSpawn(a))}`); break }
  }
  await step(a, 'behavior_disarm', { name: 'keep_spawn_bed' })
  log(`own beds: ${JSON.stringify(ownBeds(a))}`)
  log(`placed: ${JSON.stringify(a.storage.get(PLACED_KEY, []))}`)
  a.storage.flush()
  await a.stop()
}

async function remove (): Promise<void> {
  const a = newAgent()
  await connect(a)
  for (const name of ['keep_spawn_bed', 'chop_wood_loop', 'keep_fed', 'stay_safe']) await step(a, 'behavior_disarm', { name }).catch(() => null)
  const list = a.storage.get<{ x: number, y: number, z: number, name: string }[]>(PLACED_KEY, [])
  const beds = ownBeds(a).map(b => ({ ...b, name: 'bed' }))
  for (const p of [...beds, ...list]) {
    const home = getHome(a)
    if (home && Math.hypot(a.bot.entity.position.x - p.x, a.bot.entity.position.z - p.z) > 6) await step(a, 'goto', { x: p.x + 1, y: p.y, z: p.z + 1 })
    const b = a.bot.blockAt(a.bot.entity.position.clone().set(p.x, p.y, p.z))
    if (!b || !(b.name === p.name || (p.name === 'bed' && /_bed$/.test(b.name)) || (/_bed$/.test(p.name) && /_bed$/.test(b.name)))) { log(`skip ${p.name} at ${p.x} ${p.y} ${p.z}: now ${b?.name}`); continue }
    await step(a, 'break_block', { x: p.x, y: p.y, z: p.z, force: true })
  }
  await step(a, 'pickup_items', {}).catch(() => null)
  a.storage.set(PLACED_KEY, [])
  a.storage.flush()
  await a.stop()
}

async function report (): Promise<void> {
  const a = newAgent()
  console.log(JSON.stringify({ spawn: getSpawn(a), home: getHome(a), ownBeds: ownBeds(a), placed: a.storage.get(PLACED_KEY, []) }, null, 2))
}

const modes: Record<string, () => Promise<void>> = { run, remove, report }
if (!modes[mode]) { console.error(`unknown mode ${mode}: run | remove | report`); process.exit(1) }
modes[mode]!().then(() => process.exit(0), e => { console.error(e); process.exit(1) })
