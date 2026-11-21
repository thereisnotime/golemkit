// Live test of the blueprint library on a real server, away from spawn (no LLM):
//   node scripts/library-test.ts run 700 120     design a kiosk, build it, capture it, build the copy next to it,
//                                                import blueprints/import/well.schem and build it, check the policy
//   node scripts/library-test.ts clean            breaks everything the last run built (recorded in its storage)
// The bot is LIB_BOT (default LibTest), its owner LIB_TESTER (default LibTester), who joins too
// so the "ask" policy sees an owner online. Data goes to data/library-test.
import { Agent, defineVariant, serverFromEnv, PRIORITY, configureLogging, loggingFromEnv, type ActionResult } from '../src/core/index.ts'
import { standardSkills, extendedSkills } from '../src/skills/index.ts'
import { reflexes, behaviorsBrain } from '../src/brains/index.ts'
import { rotate, placeCells, bounds, isNaturalBlock, type Facing, type Pos } from '../src/skills/blueprint.ts'
import { loadLibrary, libraryDirs } from '../src/skills/blueprint-library.ts'

const [mode = 'run', xs = '700', zs = '120'] = process.argv.slice(2)
const X = Number(xs)
const Z = Number(zs)
const BOT = process.env.LIB_BOT || 'LibTest'
const TESTER = process.env.LIB_TESTER || 'LibTester'
const DATA = 'data/library-test'
const server = serverFromEnv()
configureLogging(loggingFromEnv())
const t0 = Date.now()
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`)

interface Built { template: string, origin: Pos, facing: Facing }

const KIOSK = `
name: lib_kiosk
description: Test kiosk, a 3x3 cobblestone booth with a plank counter and a stair roof
facing: south
roles:
  wall: { default: cobblestone }
  counter: { default: oak_planks, accept: "_planks$" }
  roof: { default: oak_stairs, accept: "_stairs$" }
palette: { "#": wall, c: counter, ".": air }
layers:
  - ["###", "###", "###"]
  - ["#.#", "#.#", "#c#"]
  - ["#.#", "#.#", "#.#"]
  - ["vvv", "###", "^^^"]
`

async function step (agent: Agent, name: string, params: Record<string, unknown> = {}, player = TESTER): Promise<ActionResult> {
  for (let attempt = 0; ; attempt++) {
    const t = Date.now()
    const r = await agent.act(name, params, { caller: { kind: 'player', name: player }, priority: PRIORITY.player })
      .catch(e => ({ ok: false, message: (e as Error).message }) as ActionResult)
    log(`${r.ok ? 'OK  ' : 'FAIL'} ${name} ${JSON.stringify(params).slice(0, 160)} (${((Date.now() - t) / 1000).toFixed(1)}s): ${r.message}`)
    if (r.ok || attempt >= 4) return r
    if (/^(preempted|busy)/.test(r.message)) {
      while (agent.currentAction) await new Promise(res => setTimeout(res, 2000))
      await new Promise(res => setTimeout(res, 3000))
      continue
    }
    if (!/session ended|not connected|disconnected|timed out/.test(r.message)) return r
    log(`connection lost during ${name}, waiting for the reconnect`)
    await new Promise<void>(resolve => { const to = setTimeout(resolve, 180_000); agent.once('session', () => { clearTimeout(to); setTimeout(resolve, 5000) }) })
  }
}

const once = (agent: Agent) => new Promise<void>(resolve => agent.once('session', () => setTimeout(resolve, 4000)))

function makeBot (): Agent {
  const bot = new Agent(defineVariant({ name: 'library-test', skills: [...standardSkills(), ...extendedSkills()], brains: [reflexes(), behaviorsBrain({ defaults: { keep_fed: true, stay_safe: true } })] }), server, {
    username: BOT, dataDir: DATA, canDig: true, owners: [TESTER]
  })
  bot.on('session', b => { b.pathfinder.thinkTimeout = 15_000 })
  return bot
}

async function gotoSurface (agent: Agent, x: number, z: number): Promise<void> {
  const moves = agent.bot.pathfinder?.movements as { canDig?: boolean } | undefined
  for (let i = 0; i < 4; i++) {
    if (moves) moves.canDig = false
    const r = await step(agent, 'goto', { x, z })
    if (moves) moves.canDig = true
    if (r.ok) break
  }
}

/** The box a build covers, from the blueprint it used. */
function boxOf (bot: Agent, b: Built) {
  const bp = loadLibrary(libraryDirs(bot)).blueprints.get(b.template)
  if (!bp) return null
  const turned = rotate(bp, b.facing)
  return { box: bounds(turned, b.origin), cells: placeCells(turned, b.origin) }
}

/** build, called again while it reports that a re-run resumes (ran out mid-way, a block was unreachable). */
async function buildResuming (bot: Agent, params: Record<string, unknown>): Promise<ActionResult> {
  let r = await step(bot, 'build', params)
  for (let i = 0; i < 3 && !r.ok && /resumes it|can't start/.test(r.message); i++) {
    // out of something the area around the site doesn't have: look further, then build again
    if (/out of|can't start/.test(r.message)) await step(bot, 'gather_materials', { template: params.template, radius: 64 })
    r = await step(bot, 'build', params)
  }
  return r
}

function record (bot: Agent, r: ActionResult, template: string): Built | null {
  const d = r.data as { origin?: Pos, facing?: Facing } | undefined
  if (!d?.origin || !d.facing) return null
  const b = { template, origin: d.origin, facing: d.facing }
  const same = (x: Built) => x.template === b.template && x.origin.x === b.origin.x && x.origin.y === b.origin.y && x.origin.z === b.origin.z
  bot.storage.set('built', [...bot.storage.get<Built[]>('built', []).filter(x => !same(x)), b])
  bot.storage.flush()
  return b
}

async function run (): Promise<void> {
  const bot = makeBot()
  const tester = new Agent(defineVariant({ name: 'tester', skills: standardSkills(), brains: [] }), server, { username: TESTER, dataDir: 'data/library-tester' })
  void bot.start()
  await once(bot)
  void tester.start()
  await once(tester)
  log(`${BOT} at ${JSON.stringify(bot.observe().position)}, game mode ${bot.bot.game.gameMode}`)
  await gotoSurface(bot, X, Z)

  // a failed earlier run may have left a build half done: record it so clean finds it
  const active = bot.storage.get<{ template: string, origin: Pos, facing: Facing } | undefined>('build.active')
  if (active) record(bot, { ok: false, message: '', data: active }, active.template)

  // 1. a design from "the model", checked and saved to the learned library
  const bad = await step(bot, 'blueprint_design', { yaml: KIOSK.replace('default: cobblestone', 'default: cobble') })
  if (bad.ok) throw new Error('a bad block name passed the design checks')
  await step(bot, 'blueprint_design', { yaml: KIOSK, tags: ['decoration', 'test'], overwrite: true })

  // 2. build it, 3. capture what was built, 4. build the copy somewhere else
  // LIB_KIOSK_AT="x y z facing" finishes a kiosk an earlier run left half built
  const [kx, ky, kz, kf] = (process.env.LIB_KIOSK_AT || '').split(/\s+/)
  const at = kx ? { x: Number(kx), y: Number(ky), z: Number(kz), facing: kf || 'south' } : {}
  const a = await buildResuming(bot, { template: 'lib_kiosk', gather: true, path: false, ...at })
  // "already complete" carries no data: the coordinates we passed say where it is
  const builtA = record(bot, a.data ? a : { ...a, data: kx ? { origin: { x: Number(kx), y: Number(ky), z: Number(kz) }, facing: kf || 'south' } : undefined }, 'lib_kiosk')
  if (builtA) {
    const { box } = boxOf(bot, builtA)!
    await step(bot, 'blueprint_capture', { name: 'lib_kiosk_copy', x1: box.min.x, y1: box.min.y, z1: box.min.z, x2: box.max.x, y2: box.max.y, z2: box.max.z, overwrite: true })
    await step(bot, 'blueprint_show', { name: 'lib_kiosk_copy' })
    await gotoSurface(bot, X + 14, Z)
    const b = await buildResuming(bot, { template: 'lib_kiosk_copy', gather: true, path: false })
    const builtB = record(bot, b, 'lib_kiosk_copy')
    if (builtB) await step(bot, 'build_plan', { template: 'lib_kiosk_copy', x: builtB.origin.x, y: builtB.origin.y, z: builtB.origin.z, facing: builtB.facing })
  }

  // 5. import a schematic from the import folder and build it
  await step(bot, 'blueprint_import', { file: 'well.schem', tags: ['decoration'], overwrite: true })
  await step(bot, 'build_plan', { template: 'well', preview: true })
  if (process.env.LIB_BUILD_WELL !== 'false') {
    await gotoSurface(bot, X + 28, Z)
    const w = await buildResuming(bot, { template: 'well', gather: true, path: false })
    if (w.data) record(bot, w, 'well')
  }

  // 6. the policy, with the owner online
  await step(bot, 'blueprint_search', { text: 'kiosk' })
  bot.setToggle('building', 'ask')
  await step(bot, 'blueprint_pick', { text: 'a small house' })
  bot.setToggle('building', 'creative')
  await step(bot, 'blueprint_pick', { text: 'a small house' })
  bot.resetToggle('building')
  await step(bot, 'blueprint_pick', { text: 'a small house' })
  await step(bot, 'blueprint_list', { library: 'learned' })
  bot.storage.flush()
  await tester.stop()
  await bot.stop()
}

/** Breaks the planned cells of every recorded build, top down; natural blocks and logs stay. */
async function clean (): Promise<void> {
  const bot = makeBot()
  void bot.start()
  await once(bot)
  const built = bot.storage.get<Built[]>('built', [])
  let total = 0
  for (const b of built) {
    const plan = boxOf(bot, b)
    if (!plan) { log(`no blueprint ${b.template} any more, skipping ${JSON.stringify(b.origin)}`); continue }
    await gotoSurface(bot, plan.box.max.x + 3, b.origin.z)
    // the door's top half and anything else that drops with its block comes off with it
    const cells = plan.cells.filter(c => c.role !== 'air').sort((p, q) => q.y - p.y)
    for (const c of cells) {
      const bl = bot.bot.blockAt(bot.bot.entity.position.clone().set(c.x, c.y, c.z))
      if (!bl || bl.name === 'air' || isNaturalBlock(bl.name) || /_log$|water|lava/.test(bl.name)) continue
      const r = await step(bot, 'break_block', { x: c.x, y: c.y, z: c.z, force: true })
      if (r.ok) total++
    }
    // dips filled with cobblestone under the floor (dirt fills pass for terrain)
    for (let y = b.origin.y - 1; y >= b.origin.y - 2; y--) {
      for (let x = plan.box.min.x; x <= plan.box.max.x; x++) {
        for (let z = plan.box.min.z; z <= plan.box.max.z; z++) {
          const bl = bot.bot.blockAt(bot.bot.entity.position.clone().set(x, y, z))
          if (bl?.name !== 'cobblestone') continue
          const r = await step(bot, 'break_block', { x, y, z, force: true })
          if (r.ok) total++
        }
      }
    }
    await step(bot, 'pickup_items', { radius: 10 })
  }
  bot.storage.set('built', [])
  bot.storage.flush()
  log(`removed ${total} blocks from ${built.length} builds`)
  await bot.stop()
}

setTimeout(() => { console.error('timeout'); process.exit(2) }, Number(process.env.LIB_TEST_TIMEOUT_MS || 45 * 60_000)).unref()
const MODES: Record<string, () => Promise<void>> = { run, clean }
;(MODES[mode] ?? run)().then(() => process.exit(0), e => { console.error(e); process.exit(1) })
