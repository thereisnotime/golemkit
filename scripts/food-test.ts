// Live test of food self-sufficiency (keep_fed scouting, start_farm, farm_setup) on a real server.
//   node scripts/food-test.ts run 760 45 [minutes]   walk to x/z, empty the inventory, set home, arm keep_fed + farm_setup, watch
//   node scripts/food-test.ts farm 800 -40           walk to x/z and run start_farm there directly (no behaviours)
//   node scripts/food-test.ts tend [seeds]           go to the farm the last run made, gather seeds, run tend_farm and show the plot
//   node scripts/food-test.ts report                  farms and food spots the last run remembered
//   node scripts/food-test.ts remove                  break the crops, fences and torches of the farms the last run made
// The bot is FOOD_BOT (default FoodTest), owned by FOOD_TESTER (default FoodTester), who joins
// and stands by. The bot can't be made hungry without ops, so keep_fed is armed with below=20:
// it starts as soon as the walk out has cost a point of food. Data lives in data/food-test.
// The ladder's decisions are debug lines ("keep_fed ladder: rung=..."): run with MC_LOG_LEVEL=debug
// MC_LOG_DIR=logs to get them in logs/FoodTest.log.
import { Agent, defineVariant, serverFromEnv, PRIORITY, fmtPos, type ActionResult } from '../src/core/index.ts'
import { standardSkills, extendedSkills, navigation } from '../src/skills/index.ts'
import { reflexes, behaviorsBrain } from '../src/brains/index.ts'
import { getFarms, getFoodSpots } from '../src/skills/food.ts'

const [mode = 'run', xs = '760', zs = '45', mins = '30'] = process.argv.slice(2)
const X = Number(xs)
const Z = Number(zs)
const BOT = process.env.FOOD_BOT || 'FoodTest'
const TESTER = process.env.FOOD_TESTER || 'FoodTester'
const DATA = process.env.FOOD_DATA_DIR || 'data/food-test'
const server = serverFromEnv()
const t0 = Date.now()
const secs = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`
const log = (m: string) => console.log(`[${secs()}] ${m}`)
const pause = (ms: number) => new Promise(r => setTimeout(r, ms))

const variant = defineVariant({
  name: 'food-test',
  skills: [...standardSkills(), navigation(), ...extendedSkills()],
  // nothing armed until the bot stands where the test starts
  brains: [reflexes(), behaviorsBrain({ defaults: {} })]
})

async function step (agent: Agent, name: string, params: Record<string, unknown> = {}): Promise<ActionResult> {
  const t = Date.now()
  const r = await agent.act(name, params, { caller: { kind: 'system', name: 'food-test' }, priority: PRIORITY.player })
  log(`${r.ok ? 'OK  ' : 'FAIL'} ${name} ${JSON.stringify(params)} (${((Date.now() - t) / 1000).toFixed(1)}s): ${r.message}`)
  return r
}

/** Starts an agent and waits for its first session; retries when the server kicks it (timeouts under load). */
async function connect (agent: Agent): Promise<void> {
  const ready = new Promise<void>(resolve => agent.once('session', () => setTimeout(resolve, 4000)))
  void agent.start()
  await ready
}

async function waitForDay (agent: Agent): Promise<void> {
  const night = () => { const t = agent.bot.time.timeOfDay; return (agent.bot as any).thunderState > 0 || (t > 12500 && t < 23200) }
  if (!night()) return
  log(`night or a storm (time ${agent.bot.time.timeOfDay}), waiting up to 10 min`)
  const until = Date.now() + 10 * 60_000
  while (night() && Date.now() < until) await pause(5000)
}

function state (a: Agent): string {
  const b = a.bot
  const cur = a.currentAction ? `${a.currentAction.name} (${a.currentAction.caller.kind}:${a.currentAction.caller.name})` : 'idle'
  const inv = b.inventory.items().map(i => `${i.count} ${i.name}`).join(', ') || 'empty'
  return `at ${fmtPos(b.entity.position)} food ${b.food} health ${Math.round(b.health)} time ${b.time.timeOfDay} | ${cur} | ${inv}`
}

async function run (): Promise<void> {
  const bot = new Agent(variant, server, { username: BOT, dataDir: DATA, canDig: true, owners: [TESTER] })
  const tester = new Agent(defineVariant({ name: 'tester', skills: standardSkills(), brains: [] }), server, { username: TESTER, dataDir: 'data/food-tester' })
  bot.on('actionEnd', (info: any, r: ActionResult) => {
    if (info.caller?.name === 'food-test') return
    log(`${r.ok ? 'done' : 'FAIL'} ${info.name} (${info.caller.kind}:${info.caller.name}): ${r.message}`)
  })
  bot.on('chat', m => { if (m.from === BOT) log(`chat> ${m.message}`) })
  await connect(bot)
  await connect(tester)
  log(`spawned: ${state(bot)}`)
  // behaviours armed by an earlier run persist; start with none (stay_safe walking home at night kills an unarmed bot)
  for (const name of ['keep_fed', 'farm_setup', 'stay_safe']) await step(bot, 'behavior_disarm', { name }).catch(() => null)
  await waitForDay(bot)
  // reflexes (fighting night mobs) preempt the trip: wait for them and set off again
  const far = () => Math.hypot(bot.bot.entity.position.x - X, bot.bot.entity.position.z - Z)
  for (let i = 0; i < 12 && far() > 12; i++) {
    while (bot.currentAction) await pause(2000)
    const r = await step(bot, 'goto', { x: X, z: Z })
    if (!r.ok) await pause(3000)
  }
  if (far() > 24) { log(`never got to ${X} ${Z} (${Math.round(far())} blocks away), giving up`); await bot.stop(); await tester.stop(); return }
  if (bot.bot.inventory.items().length) await step(bot, 'drop', { item: 'all' })
  await pause(1500)
  // walk off a few blocks so the dropped items are not picked straight back up
  await step(bot, 'goto', { x: X + 6, z: Z + 6 })
  await step(bot, 'set_home')
  log(`start: ${state(bot)}`)
  await step(bot, 'behavior_arm', { name: 'stay_safe', options: { retreatBelow: 6, homeAtNight: true } })
  // the food ladder: search 48 -> 120 -> 250, then keep_fed's own farm fallback (FOOD_FARM_SETUP=true arms farm_setup too)
  await step(bot, 'behavior_arm', { name: 'keep_fed', options: { below: 20, healBelow: 20, until: 20, radius: 48, scout: true, rings: (process.env.FOOD_RINGS ?? '48,120,250').split(',').map(Number) } })
  if (process.env.FOOD_FARM_SETUP === 'true') await step(bot, 'behavior_arm', { name: 'farm_setup', options: { size: 9 } })
  const until = Date.now() + Number(mins) * 60_000
  let farmAt = 0
  while (Date.now() < until) {
    await pause(15_000)
    log(state(bot))
    const farms = getFarms(bot)
    if (farms.length && !farmAt) farmAt = Date.now()
    // done once it has a farm and has eaten, or a few minutes after the farm when it can't find food
    if (farms.length && bot.bot.food >= 19) break
    if (farmAt && Date.now() - farmAt > 6 * 60_000) break
  }
  log(`farms: ${JSON.stringify(getFarms(bot))}`)
  log(`food spots: ${JSON.stringify(getFoodSpots(bot))}`)
  const st = await step(bot, 'behavior_status')
  void st
  bot.storage.flush()
  await bot.stop()
  await tester.stop()
}

async function farm (): Promise<void> {
  const bot = new Agent(variant, server, { username: BOT, dataDir: DATA, canDig: true, owners: [TESTER] })
  bot.on('actionEnd', (info: any, r: ActionResult) => { if (info.caller?.name !== 'food-test') log(`${r.ok ? 'done' : 'FAIL'} ${info.name} (${info.caller.kind}:${info.caller.name}): ${r.message}`) })
  await connect(bot)
  for (const name of ['keep_fed', 'farm_setup', 'stay_safe']) await step(bot, 'behavior_disarm', { name }).catch(() => null)
  await waitForDay(bot)
  const far = () => Math.hypot(bot.bot.entity.position.x - X, bot.bot.entity.position.z - Z)
  for (let i = 0; i < 8 && far() > 12; i++) {
    while (bot.currentAction) await pause(2000)
    if (!(await step(bot, 'goto', { x: X, z: Z })).ok) await pause(3000)
  }
  log(`at the spot: ${state(bot)}`)
  if (process.env.FOOD_EMPTY === 'true' && bot.bot.inventory.items().length) await step(bot, 'drop', { item: 'all' })
  for (let i = 0; i < 3; i++) {
    while (bot.currentAction) await pause(2000)
    const r = await step(bot, 'start_farm', { x: X, z: Z })
    if (r.ok || !/^(preempted|busy|died)/.test(r.message)) break
  }
  log(`farms: ${JSON.stringify(getFarms(bot))}`)
  log(state(bot))
  bot.storage.flush()
  await bot.stop()
}

async function tend (): Promise<void> {
  const bot = new Agent(variant, server, { username: BOT, dataDir: DATA, canDig: true, owners: [TESTER] })
  bot.on('actionEnd', (info: any, r: ActionResult) => { if (info.caller?.name !== 'food-test') log(`${r.ok ? 'done' : 'FAIL'} ${info.name} (${info.caller.kind}:${info.caller.name}): ${r.message}`) })
  await connect(bot)
  for (const name of ['keep_fed', 'farm_setup', 'stay_safe']) await step(bot, 'behavior_disarm', { name }).catch(() => null)
  const f = getFarms(bot)[0]
  if (!f) { log('no farm remembered: run farm first'); await bot.stop(); return }
  await waitForDay(bot)
  await step(bot, 'goto', { x: f.x + 2, y: f.y + 1, z: f.z + 2 })
  const show = () => {
    const rows: string[] = []
    for (let dz = -4; dz <= 4; dz++) {
      let row = ''
      for (let dx = -4; dx <= 4; dx++) {
        const g = bot.bot.blockAt(bot.bot.entity.position.clone().set(f.x + dx, f.y, f.z + dz))
        const a = bot.bot.blockAt(bot.bot.entity.position.clone().set(f.x + dx, f.y + 1, f.z + dz))
        row += !g ? '?' : g.name === 'water' ? '~' : g.name === 'farmland' ? (/wheat|carrots|potatoes|beetroots/.test(a?.name ?? '') ? 'w' : '_') : /dirt|grass_block/.test(g.name) ? '.' : '#'
      }
      rows.push(row)
    }
    log(`plot (~ water, w crop, _ bare farmland, . dirt, # other):\n${rows.join('\n')}`)
  }
  show()
  await step(bot, 'gather_seeds', { count: process.argv[3] ? Number(xs) : 12, radius: 32, maxMinutes: 4 })
  await step(bot, 'tend_farm', { farm: f.name, size: 9 })
  show()
  log(state(bot))
  bot.storage.flush()
  await bot.stop()
}

async function report (): Promise<void> {
  const bot = new Agent(variant, server, { username: BOT, dataDir: DATA, canDig: true })
  // read storage without connecting
  log(`farms: ${JSON.stringify(getFarms(bot))}`)
  log(`food spots: ${JSON.stringify(getFoodSpots(bot))}`)
  log(`places: ${JSON.stringify(bot.storage.get('places', {}))}`)
}

async function remove (): Promise<void> {
  const bot = new Agent(variant, server, { username: BOT, dataDir: DATA, canDig: true, owners: [TESTER] })
  await connect(bot)
  await step(bot, 'behavior_reset').catch(() => null)
  for (const name of ['keep_fed', 'farm_setup', 'stay_safe']) await step(bot, 'behavior_disarm', { name }).catch(() => null)
  for (const f of getFarms(bot)) {
    await step(bot, 'goto', { x: f.x + 2, y: f.y + 1, z: f.z + 2 })
    const h = (f.size - 1) / 2 + 1
    for (let dx = -h; dx <= h; dx++) {
      for (let dz = -h; dz <= h; dz++) {
        for (const dy of [1, 2]) {
          const b = bot.bot.blockAt(bot.bot.entity.position.clone().set(f.x + dx, f.y + dy, f.z + dz))
          if (b && /(wheat|carrots|potatoes|beetroots|_fence|torch)$/.test(b.name)) await step(bot, 'break_block', { x: f.x + dx, y: f.y + dy, z: f.z + dz, force: false })
        }
      }
    }
  }
  await bot.stop()
}

const main = mode === 'report' ? report : mode === 'tend' ? tend : mode === 'remove' ? remove : mode === 'farm' ? farm : run
main().then(() => process.exit(0), e => { console.error(e); process.exit(1) })
