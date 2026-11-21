// Live test of materials + building on a real server, far from spawn.
//   node scripts/build-test.ts direct 760 45 [y]    empty inventory -> gather_materials -> build hut (no LLM)
//   node scripts/build-test.ts llm 760 45           a tester asks the LLM bot "build a small house here"
//   node scripts/build-test.ts remove 760 45        breaks what the last run built (BUILD_DATA_DIR=data/build-test-llm for the llm run)
// The bot is BUILD_BOT (default BuildTest), the tester BUILD_TESTER (default BuildTester). Both
// walk to x/z first. Reflexes stay on so night mobs don't end the run. The llm mode uses the
// pax profile's provider settings with its own login dir (.auth/buildtest).
import { Agent, defineVariant, serverFromEnv, PRIORITY, type ActionResult } from '../src/core/index.ts'
import { standardSkills, extendedSkills } from '../src/skills/index.ts'
import { reflexes } from '../src/brains/index.ts'
import { loadProfile, mergeOptions } from '../src/core/profile.ts'
import companion from '../variants/companion.ts'
import { llmRuntime } from '../src/brains/llm.ts'

const [mode = 'direct', xs = '760', zs = '45', ys] = process.argv.slice(2)
const X = Number(xs)
const Z = Number(zs)
/** Optional surface y of the target: travel without y can end up tunnelling. */
const Y = ys === undefined ? undefined : Number(ys)
const BOT = process.env.BUILD_BOT || 'BuildTest'
const TESTER = process.env.BUILD_TESTER || 'BuildTester'
const server = serverFromEnv()
const t0 = Date.now()
const secs = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`
const log = (m: string) => console.log(`[${secs()}] ${m}`)

async function step (agent: Agent, name: string, params: Record<string, unknown> = {}): Promise<ActionResult> {
  const t = Date.now()
  // player priority, so reflexes (eat, fight back) can still step in
  const r = await agent.act(name, params, { caller: { kind: 'system', name: 'build-test' }, priority: PRIORITY.player })
  log(`${r.ok ? 'OK  ' : 'FAIL'} ${name} ${JSON.stringify(params)} (${((Date.now() - t) / 1000).toFixed(1)}s): ${r.message}`)
  return r
}

const once = (agent: Agent) => new Promise<void>(resolve => agent.once('session', () => setTimeout(resolve, 4000)))

async function waitForDay (agent: Agent): Promise<void> {
  const night = () => { const t = agent.bot.time.timeOfDay; return t > 12500 && t < 23200 }
  if (!night() || process.env.BUILD_NO_WAIT === 'true') return
  log(`night (time ${agent.bot.time.timeOfDay}), waiting up to 8 min for morning`)
  const until = Date.now() + 8 * 60_000
  while (night() && Date.now() < until) await new Promise(r => setTimeout(r, 5000))
}

/** Walks to x/z on the surface (travel without y may end in a tunnel or a cave). */
async function gotoSurface (agent: Agent, x: number, z: number): Promise<void> {
  // A reflex (fleeing a mob, eating) preempts the trip; wait for it and set off again.
  for (let i = 0; i < 6; i++) {
    const r = await step(agent, 'goto', Y === undefined ? { x, z } : { x, y: Y, z })
    if (!/^(preempted|busy|died)/.test(r.message)) break
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
  const bot = new Agent(defineVariant({ name: 'build-test', skills: [...standardSkills(), ...extendedSkills()], brains: [reflexes()] }), server, {
    username: BOT, dataDir: 'data/build-test', canDig: true, owners: [TESTER]
  })
  void bot.start()
  await once(bot)
  log(`spawned at ${JSON.stringify(bot.observe().position)}, inventory ${JSON.stringify(bot.observe().inventory)}`)
  if (process.env.BUILD_CLEAR_INV === 'true') await step(bot, 'drop', { item: 'all' })
  await waitForDay(bot)
  await gotoSurface(bot, X, Z)
  await step(bot, 'build_plan', { template: 'hut' })
  const g = await step(bot, 'gather_materials', { template: 'hut' })
  if (!g.ok) log('gather incomplete, building with what there is')
  await gotoSurface(bot, X, Z)
  const b = await step(bot, 'build', { template: 'hut' })
  if (b.data) bot.storage.set('lastBuild', b.data)
  await step(bot, 'inventory')
  log(`total ${secs()}`)
  bot.storage.flush()
  await bot.stop()
}

async function remove (): Promise<void> {
  const bot = new Agent(defineVariant({ name: 'build-test', skills: [...standardSkills(), ...extendedSkills()], brains: [reflexes()] }), server, {
    username: BOT, dataDir: process.env.BUILD_DATA_DIR || 'data/build-test', canDig: true
  })
  void bot.start()
  await once(bot)
  const last = bot.storage.get<{ origin: { x: number, y: number, z: number } } | undefined>('lastBuild')
  if (!last) { log('no lastBuild recorded'); await bot.stop(); return }
  const o = last.origin
  await step(bot, 'goto', { x: o.x + 4, z: o.z })
  // top down: roof, walls, floor of a 5x5x4 hut centred on origin
  for (let y = o.y + 3; y >= o.y; y--) {
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
      const b = bot.bot.blockAt(bot.bot.entity.position.clone().set(o.x + dx, y, o.z + dz))
      if (b && /(_planks|_door|torch|glass)/.test(b.name)) await step(bot, 'break_block', { x: o.x + dx, y, z: o.z + dz, force: false })
    }
  }
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
    // Pax's provider and budget, but not its persona or context pack (those obey robin only).
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
  bot.on('actionEnd', (info, r) => { if (info.name === 'build' && r.data) { bot.storage.set('lastBuild', r.data); bot.storage.flush() } })
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
  await step(bot, 'build_plan', { template: 'hut' })
  await bot.stop()
}

const run = mode === 'llm' ? llm : mode === 'remove' ? remove : mode === 'scout' ? scout : direct
run().then(() => process.exit(0), e => { console.error(e); process.exit(1) })
