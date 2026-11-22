// Live test of materials + building on a real server, far from spawn.
//   node scripts/build-test.ts direct 760 45 [y]    gather_materials -> build (BUILD_TEMPLATE, default small_house; no LLM)
//                                                   BUILD_CLEAR_INV=true drops the inventory first (at spawn, before walking off)
//   node scripts/build-test.ts llm 760 45           a tester asks the LLM bot "build a small house here" (BUILD_PROMPT)
//   node scripts/build-test.ts inspect 760 45       prints the last build layer by layer as read back from the world
//   node scripts/build-test.ts remove 760 45        breaks what the last run built (BUILD_DATA_DIR=data/build-test-llm for the llm run)
//   node scripts/build-test.ts clear x1 y1 z1 x2 y2 z2   breaks every player-made block in a box (leftover test blocks)
// The bot is BUILD_BOT (default BuildTest), the tester BUILD_TESTER (default BuildTester). Both
// walk to x/z first. Reflexes stay on so night mobs don't end the run. The llm mode uses the
// pax profile's provider settings with its own login dir (.auth/buildtest).
import { Agent, defineVariant, serverFromEnv, PRIORITY, configureLogging, loggingFromEnv, type ActionResult } from '../src/core/index.ts'
import { standardSkills, extendedSkills } from '../src/skills/index.ts'
import { reflexes, behaviorsBrain } from '../src/brains/index.ts'
import { loadProfile, mergeOptions } from '../src/core/profile.ts'
import companion from '../variants/companion.ts'
import { llmRuntime } from '../src/brains/llm.ts'
import { loadBlueprints, rotate, placeCells, bounds, isNaturalBlock, type Facing } from '../src/skills/blueprint.ts'

const [mode = 'direct', xs = '760', zs = '45', ys] = process.argv.slice(2)
const X = Number(xs)
const Z = Number(zs)
/** Optional surface y of the target: travel without y can end up tunnelling. */
const Y = ys === undefined ? undefined : Number(ys)
const TEMPLATE = process.env.BUILD_TEMPLATE || 'small_house'
/** BUILD_AT="x y z facing": build exactly there (finish or repair an earlier build). */
const AT = (() => {
  const [x, y, z, facing] = (process.env.BUILD_AT || '').split(/\s+/)
  return x ? { x: Number(x), y: Number(y), z: Number(z), ...(facing ? { facing } : {}) } : {}
})()
const BOT = process.env.BUILD_BOT || 'BuildTest'
const TESTER = process.env.BUILD_TESTER || 'BuildTester'
const server = serverFromEnv()
configureLogging(loggingFromEnv())
const t0 = Date.now()
const secs = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`
const log = (m: string) => console.log(`[${secs()}] ${m}`)

async function step (agent: Agent, name: string, params: Record<string, unknown> = {}): Promise<ActionResult> {
  // The server can drop the bot under load (disconnect.timeout, EPIPE): wait for the reconnect and run the step again.
  for (let attempt = 0; ; attempt++) {
    const t = Date.now()
    // player priority, so reflexes (eat, fight back) can still step in
    const r = await agent.act(name, params, { caller: { kind: 'system', name: 'build-test' }, priority: PRIORITY.player })
      .catch(e => ({ ok: false, message: (e as Error).message }) as ActionResult)
    log(`${r.ok ? 'OK  ' : 'FAIL'} ${name} ${JSON.stringify(params)} (${((Date.now() - t) / 1000).toFixed(1)}s): ${r.message}`)
    if (r.ok || attempt >= 4) return r
    const far = X !== undefined && Math.hypot(agent.bot.entity.position.x - X, agent.bot.entity.position.z - Z) > 60
    if (/^(preempted|busy)/.test(r.message) && name !== 'goto' && !far) {
      // a reflex (fight, flee, eat) took over: let it finish and carry on
      log(`${name} was interrupted, waiting for the reflex to finish (attempt ${attempt + 1})`)
      while (agent.currentAction) await new Promise(res => setTimeout(res, 2000))
      await new Promise(res => setTimeout(res, 3000))
      continue
    }
    if (!/session ended|not connected|disconnected|timed out/.test(r.message)) return r
    log(`connection lost during ${name}, waiting for the reconnect (attempt ${attempt + 1})`)
    disconnects++
    await new Promise<void>(resolve => { const to = setTimeout(resolve, 180_000); agent.once('session', () => { clearTimeout(to); setTimeout(resolve, 5000) }) })
  }
}
let disconnects = 0

const once = (agent: Agent) => new Promise<void>(resolve => agent.once('session', () => setTimeout(resolve, 4000)))

async function waitForDay (agent: Agent): Promise<void> {
  const night = () => { const t = agent.bot.time.timeOfDay; return t > 12500 && t < 23200 }
  if (!night() || process.env.BUILD_NO_WAIT === 'true') return
  log(`night (time ${agent.bot.time.timeOfDay}), waiting up to 10 min for morning`)
  const until = Date.now() + 10 * 60_000
  while (night() && Date.now() < until) await new Promise(r => setTimeout(r, 5000))
}

/** Walks to x/z on the surface (travel without y may end in a tunnel or a cave). */
async function gotoSurface (agent: Agent, x: number, z: number): Promise<void> {
  // A reflex (fleeing a mob, eating) preempts the trip; wait for it and set off again.
  // Travel without digging (BUILD_TRAVEL_DIG=true allows it after 3 tries): a digging bot tunnels,
  // has drowned in lava this way, and once dug its way out of the house it was inspecting.
  const moves = agent.bot.pathfinder?.movements as { canDig?: boolean } | undefined
  for (let i = 0; i < 6; i++) {
    if (moves) moves.canDig = process.env.BUILD_TRAVEL_DIG === 'true' && i >= 3
    const r = await step(agent, 'goto', Y === undefined ? { x, z } : { x, y: Y, z })
    if (moves) moves.canDig = true
    if (r.ok) break
    if (!/^(preempted|busy|died|stuck|took too long)/.test(r.message)) break
    while (agent.currentAction) await new Promise(res => setTimeout(res, 2000))
    await new Promise(res => setTimeout(res, 3000))
  }
  const b = agent.bot
  let top: number | null = null
  for (let y = 319; y > -64; y--) {
    const n = b.blockAt(b.entity.position.clone().set(x, y, z))?.name
    if (n && !/^(air|cave_air|void_air|short_grass|tall_grass|fern|snow)$/.test(n) && !n.endsWith('_leaves')) { top = y; break }
  }
  if (top !== null && Math.abs(b.entity.position.y - (top + 1)) > 2) await step(agent, 'goto', { x, y: top + 1, z })
  const logs = Object.values(b.registry.blocksByName).filter(d => /_log$/.test(d.name) && !d.name.startsWith('stripped')).map(d => d.id)
  log(`at ${JSON.stringify(agent.observe().position)}, surface ${top}, ${b.findBlocks({ matching: logs, maxDistance: 32, count: 500 }).length} logs within 32`)
}

async function direct (): Promise<void> {
  // keep_fed and stay_safe (eat, pillar up when surrounded): test bots died to mobs and starvation otherwise
  const bot = new Agent(defineVariant({ name: 'build-test', skills: [...standardSkills(), ...extendedSkills()], brains: [reflexes(), behaviorsBrain({ defaults: { keep_fed: true, stay_safe: true } })] }), server, {
    username: BOT, dataDir: 'data/build-test', canDig: true, owners: [TESTER]
  })
  // this server shares a busy machine: give the pathfinder longer to think than its 5 s default
  bot.on('session', b => { b.pathfinder.thinkTimeout = 15_000 })
  void bot.start()
  await once(bot)
  log(`spawned at ${JSON.stringify(bot.observe().position)}, inventory ${JSON.stringify(bot.observe().inventory)}`)
  if (process.env.BUILD_CLEAR_INV === 'true') await step(bot, 'drop', { item: 'all' })
  await waitForDay(bot)
  await gotoSurface(bot, X, Z)
  await step(bot, 'build_plan', { template: TEMPLATE })
  const tg = Date.now()
  // a death (mobs, a fall while chopping) loses the inventory: walk back and gather again.
  // BUILD_SKIP_GATHER=true goes straight to build (it gathers whatever is still missing itself).
  const tries = process.env.BUILD_SKIP_GATHER === 'true' ? 0 : Number(process.env.BUILD_GATHER_TRIES || 3)
  for (let i = 0; i < tries; i++) {
    if (i) { await waitForDay(bot); await gotoSurface(bot, X, Z) }
    const g = await step(bot, 'gather_materials', { template: TEMPLATE, radius: Number(process.env.BUILD_RADIUS || 32) })
    if (g.ok) break
    log('gather incomplete' + (i < tries - 1 ? ', trying again' : ', building with what there is'))
  }
  const gatherSecs = Math.round((Date.now() - tg) / 1000)
  await gotoSurface(bot, X, Z)
  const tb = Date.now()
  const b = await step(bot, 'build', { template: TEMPLATE, gather: true, ...AT })
  if (b.data) { bot.storage.set('lastBuild', { ...(b.data as object), template: TEMPLATE }); bot.storage.flush() }
  await step(bot, 'inventory')
  log(`gather ${gatherSecs}s, build ${Math.round((Date.now() - tb) / 1000)}s, total ${secs()}, ${disconnects} disconnects`)
  if (b.data) printBuild(bot, TEMPLATE, (b.data as LastBuild).origin, (b.data as LastBuild).facing)
  bot.storage.flush()
  await bot.stop()
}

interface LastBuild { origin: { x: number, y: number, z: number }, facing: Facing, template?: string }

/** One character per block, for reading a build back as text. */
function glyph (name: string, props: Record<string, unknown>): string {
  if (name === 'air' || name === 'cave_air') return '.'
  if (/_stairs$/.test(name)) return ({ north: '^', south: 'v', west: '<', east: '>' } as Record<string, string>)[String(props.facing)] ?? 'S'
  if (/_slab$/.test(name)) return props.type === 'top' ? 'T' : 's'
  if (/_log$|_wood$/.test(name)) return props.axis === 'y' ? '|' : props.axis === 'x' ? '-' : ':'
  if (/_planks$/.test(name)) return '#'
  if (/_trapdoor$/.test(name)) return 'h'
  if (/_door$/.test(name)) return 'D'
  if (/glass/.test(name)) return 'W'
  if (/_fence$/.test(name)) return 'f'
  if (/torch$|lantern$/.test(name)) return 't'
  if (/_bed$/.test(name)) return 'B'
  if (name === 'chest') return 'C'
  if (name === 'crafting_table') return 'K'
  if (name === 'furnace') return 'U'
  if (name === 'ladder') return 'H'
  if (/cobble|stone_bricks/.test(name)) return 'c'
  if (/carpet$/.test(name)) return 'r'
  if (name === 'dirt_path') return '_'
  return isNaturalBlock(name) ? ' ' : '?'
}

/** Prints the build's box layer by layer as it stands in the world (rows north to south). */
function printBuild (agent: Agent, template: string, origin: LastBuild['origin'], facing: Facing): void {
  const bp = loadBlueprints().blueprints.get(template)
  if (!bp) return
  const box = bounds(rotate(bp, facing), origin)
  const b = agent.bot
  const out: string[] = [`${template} at ${origin.x} ${origin.y} ${origin.z} facing ${facing}, x ${box.min.x}..${box.max.x}, z ${box.min.z}..${box.max.z} (north is up)`]
  for (let y = box.min.y - 1; y <= box.max.y; y++) {
    out.push(`y=${y}${y === box.min.y - 1 ? ' (ground)' : ''}:`)
    for (let z = box.min.z - 1; z <= box.max.z + 3; z++) {
      let row = ''
      for (let x = box.min.x - 1; x <= box.max.x + 1; x++) {
        const bl = b.blockAt(b.entity.position.clone().set(x, y, z))
        row += bl ? glyph(bl.name, bl.getProperties() as Record<string, unknown>) : '?'
      }
      out.push(`  ${row}`)
    }
  }
  console.log(out.join('\n'))
}

function testAgent (dataDir = process.env.BUILD_DATA_DIR || 'data/build-test'): Agent {
  return new Agent(defineVariant({ name: 'build-test', skills: [...standardSkills(), ...extendedSkills()], brains: [reflexes()] }), server, {
    username: BOT, dataDir, canDig: true
  })
}

/** Breaks every player-made block in a box, top down. */
async function clearBox (bot: Agent, a: { x: number, y: number, z: number }, c: { x: number, y: number, z: number }, keep: (name: string) => boolean = isNaturalBlock): Promise<number> {
  let n = 0
  for (let y = Math.max(a.y, c.y); y >= Math.min(a.y, c.y); y--) {
    for (let x = Math.min(a.x, c.x); x <= Math.max(a.x, c.x); x++) {
      for (let z = Math.min(a.z, c.z); z <= Math.max(a.z, c.z); z++) {
        const bl = bot.bot.blockAt(bot.bot.entity.position.clone().set(x, y, z))
        if (!bl || bl.name === 'air' || bl.name === 'water' || bl.name === 'lava' || keep(bl.name) || /_log$|_leaves$/.test(bl.name)) continue
        const r = await step(bot, 'break_block', { x, y, z, force: true })
        if (r.ok) n++
      }
    }
  }
  return n
}

async function remove (): Promise<void> {
  const bot = testAgent()
  void bot.start()
  await once(bot)
  // BUILD_REMOVE="template x y z facing" removes that build instead of the last one recorded
  const [rt, rx, ry, rz, rf] = (process.env.BUILD_REMOVE || '').split(/\s+/)
  const last = rt ? { template: rt, origin: { x: Number(rx), y: Number(ry), z: Number(rz) }, facing: rf as Facing } : bot.storage.get<LastBuild | undefined>('lastBuild')
  if (!last) { log('no lastBuild recorded'); await bot.stop(); return }
  const o = last.origin
  const bp = loadBlueprints().blueprints.get(last.template ?? 'hut')!
  const turned = rotate(bp, last.facing ?? bp.facing)
  const box = bounds(turned, o)
  await gotoSurface(bot, box.max.x + 3, o.z)
  // only the planned cells, top down, so nearby terrain and trees stay
  const cells = placeCells(turned, o).filter(c => c.role !== 'air').sort((a, b) => b.y - a.y)
  let n = 0
  for (const c of cells) {
    const bl = bot.bot.blockAt(bot.bot.entity.position.clone().set(c.x, c.y, c.z))
    if (!bl || bl.name === 'air' || isNaturalBlock(bl.name)) continue
    const r = await step(bot, 'break_block', { x: c.x, y: c.y, z: c.z, force: true })
    if (r.ok) n++
  }
  // a dirt path and filled dips stay (they're terrain); torches dropped on the ground get picked up
  await step(bot, 'pickup_items', { radius: 12 })
  log(`removed ${n} blocks of the ${last.template ?? 'hut'} at ${o.x} ${o.y} ${o.z}`)
  if (!rt) bot.storage.delete('lastBuild')
  bot.storage.flush()
  await bot.stop()
}

async function inspect (): Promise<void> {
  const bot = testAgent()
  void bot.start()
  await once(bot)
  const last = bot.storage.get<LastBuild | undefined>('lastBuild')
  if (!last) { log('no lastBuild recorded'); await bot.stop(); return }
  await gotoSurface(bot, last.origin.x + 8, last.origin.z)
  printBuild(bot, last.template ?? 'hut', last.origin, last.facing)
  await bot.stop()
}

async function clear (): Promise<void> {
  const [x1, y1, z1, x2, y2, z2] = process.argv.slice(3).map(Number)
  const bot = testAgent()
  void bot.start()
  await once(bot)
  await gotoSurface(bot, x1!, z1! + 3)
  const n = await clearBox(bot, { x: x1!, y: y1!, z: z1! }, { x: x2!, y: y2!, z: z2! })
  await step(bot, 'pickup_items', { radius: 8 })
  log(`cleared ${n} blocks`)
  await bot.stop()
}

async function llm (): Promise<void> {
  const profile = loadProfile('pax')
  if (!profile) throw new Error('profiles/pax.yaml missing')
  const opts = mergeOptions(profile.options, {
    username: BOT,
    owners: [TESTER],
    canDig: true,
    dataDir: 'data/build-test-llm',
    // Pax's provider and budget, but not its persona or context pack (those obey Robin only).
    persona: `${BOT}, a capable, independent helper. Your master is ${TESTER}: when they ask for something, just do it, ` +
      'pick the details yourself and keep going until it is done. Report briefly when something is finished or truly blocked.',
    settings: { context: false, llm: { login: '.auth/buildtest', aliases: ['buildtest', 'builder'] } }
  })
  const bot = new Agent(companion, server, opts)
  const tester = new Agent(defineVariant({ name: 'tester', skills: standardSkills(), brains: [] }), server, { username: TESTER, dataDir: 'data/build-tester' })
  tester.on('chat', m => { if (m.from === BOT) log(`chat> ${m.whisper ? '(whisper) ' : ''}<${m.from}> ${m.message}`) })
  void bot.start()
  void tester.start()
  await Promise.all([once(bot), once(tester)])
  await Promise.all([gotoSurface(bot, X, Z), gotoSurface(tester, X + 3, Z + 3)])
  await waitForDay(bot)
  const rt = llmRuntime(bot)!
  // Remember where the LLM built, for `remove` (BUILD_DATA_DIR=data/build-test-llm).
  bot.on('actionEnd', (info, r) => {
    if (info.name !== 'build' || !r.data) return
    const tpl = (info.params as { template?: string } | undefined)?.template ?? 'small_house'
    bot.storage.set('lastBuild', { ...(r.data as object), template: tpl })
    bot.storage.flush()
    log(`build ended: ${r.message}`)
  })
  bot.on('actionEnd', (info, r) => { if (info.name !== 'build') log(`action ${info.name}: ${r.ok ? 'ok' : 'FAIL'} ${r.message.slice(0, 300)}`) })
  log(`asking: ${process.env.BUILD_PROMPT || `${BOT}, build a small house here`}`)
  tester.say(process.env.BUILD_PROMPT || `${BOT}, build a small house here`)
  const limitMs = Number(process.env.BUILD_LLM_MS || 20 * 60_000)
  const until = Date.now() + limitMs
  while (Date.now() < until) {
    await new Promise(r => setTimeout(r, 5000))
    const g = rt.goals.active
    if (!g && rt.goals.history().length && !rt.isBusy && !bot.currentAction) break
    if (g?.paused) { log(`goal paused: ${g.paused}`); break }
  }
  const s = rt.snapshot()
  log(`goal: ${JSON.stringify(rt.goals.active ?? rt.goals.history().at(-1))}`)
  log(`llm session: ${s.session.turns} turns, ${s.session.inputTokens} in / ${s.session.outputTokens} out, cached ${s.session.cacheReadTokens}, est $${s.session.costUsd.toFixed(3)}`)
  for (const r of rt.reports) log(`turn ${r.trigger.kind}${r.trigger.kind === 'goal' ? `:${r.trigger.reason}` : ''}: ${r.calls.map(c => `${c.name}${c.ok ? '' : '!'}`).join(' ')}${r.error ? ` error=${r.error}` : ''}`)
  rt.goals.abandon('test over')
  bot.storage.flush()
  await bot.stop()
  await tester.stop()
}

setTimeout(() => { console.error('timeout'); process.exit(2) }, Number(process.env.BUILD_TEST_TIMEOUT_MS || 40 * 60_000)).unref()
async function scout (): Promise<void> {
  const bot = new Agent(defineVariant({ name: 'build-test', skills: [...standardSkills(), ...extendedSkills()], brains: [reflexes()] }), server, {
    username: BOT, dataDir: 'data/build-test', canDig: true
  })
  void bot.start()
  await once(bot)
  await gotoSurface(bot, X, Z)
  await step(bot, 'build_plan', { template: TEMPLATE, preview: true })
  await bot.stop()
}

const MODES: Record<string, () => Promise<void>> = { llm, remove, scout, inspect, clear, direct }
const run = MODES[mode] ?? direct
run().then(() => process.exit(0), e => { console.error(e); process.exit(1) })
