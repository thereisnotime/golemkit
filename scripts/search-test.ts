// Live test of find_target, bring_item and fetch_drops on a real server.
//   node scripts/search-test.ts where                         where the bot and the tester are
//   node scripts/search-test.ts walk 205 165 234 333          both walk to each x/z in turn (the tester stops a few blocks off)
//   node scripts/search-test.ts run 'find_target {"target":"iron"}' 'bring_item {"item":"bread","count":2}'
//                                                              runs actions as if the tester asked, one after the other
//   node scripts/search-test.ts tidy                          drops what the tester was given and lists the bot's own chests
// The bot is SEARCH_BOT (default FindTest), owned by SEARCH_TESTER (default FindTester), who
// stands next to it and receives what it brings. Data lives in data/search-test.
import { Agent, defineVariant, serverFromEnv, PRIORITY, fmtPos, type ActionResult } from '../src/core/index.ts'
import { standardSkills, extendedSkills, navigation, ownChests } from '../src/skills/index.ts'
import { reflexes } from '../src/brains/index.ts'

const [mode = 'where', ...args] = process.argv.slice(2)
const BOT = process.env.SEARCH_BOT || 'FindTest'
const TESTER = process.env.SEARCH_TESTER || 'FindTester'
const DATA = process.env.SEARCH_DATA_DIR || 'data/search-test'
const server = serverFromEnv()
const t0 = Date.now()
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`)
const pause = (ms: number) => new Promise(r => setTimeout(r, ms))

const variant = defineVariant({ name: 'search-test', skills: [...standardSkills(), navigation(), ...extendedSkills()], brains: [reflexes()] })
const testerVariant = defineVariant({ name: 'search-tester', skills: [...standardSkills(), navigation()], brains: [] })

/** Starts an agent and waits for its first session; the server kicks under load, so retry. */
async function connect (agent: Agent): Promise<void> {
  for (let i = 0; i < 5; i++) {
    const ready = new Promise<boolean>(resolve => {
      const t = setTimeout(() => resolve(false), 90_000)
      agent.once('session', () => { clearTimeout(t); setTimeout(() => resolve(true), 4000) })
    })
    if (i === 0) void agent.start()
    if (await ready) return
    log(`${agent.username}: no session yet, waiting (try ${i + 1})`)
  }
  throw new Error(`${agent.username} never got a session`)
}

function state (a: Agent): string {
  const b = a.bot
  const inv = b.inventory.items().map(i => `${i.count} ${i.name}`).join(', ') || 'empty'
  return `${a.username} at ${fmtPos(b.entity.position)} health ${Math.round(b.health)} food ${b.food} time ${b.time.timeOfDay} | ${inv}`
}

async function act (agent: Agent, name: string, params: Record<string, unknown>, asPlayer = true): Promise<ActionResult> {
  const t = Date.now()
  const r = await agent.act(name, params, { caller: asPlayer ? { kind: 'player', name: TESTER } : { kind: 'system', name: 'search-test' }, priority: PRIORITY.player })
  log(`${r.ok ? 'OK  ' : 'FAIL'} ${agent.username} ${name} ${JSON.stringify(params)} (${((Date.now() - t) / 1000).toFixed(1)}s): ${r.message}`)
  return r
}

async function both (): Promise<{ bot: Agent, tester: Agent }> {
  const bot = new Agent(variant, server, { username: BOT, dataDir: DATA, canDig: true, owners: [TESTER] })
  const tester = new Agent(testerVariant, server, { username: TESTER, dataDir: `${DATA}-tester` })
  bot.on('chatOut', (m: { to?: string, message: string }) => log(`bot says${m.to ? ` to ${m.to}` : ''}> ${m.message}`))
  // reflexes, and long-running actions resumed after a reflex preempted them (their result never reaches act())
  bot.on('actionEnd', (info: any, r: ActionResult) => {
    if (info.caller?.kind === 'reflex') log(`reflex ${info.name}: ${r.message}`)
    else if (info.resumed || /^(find_target|bring_item|fetch_drops)$/.test(info.name)) log(`ended ${info.name}${info.resumed ? ' (resumed)' : ''}: ${r.ok ? 'OK' : 'FAIL'} ${r.message}`)
  })
  await connect(bot)
  await connect(tester)
  // an idle bot left standing in water sinks and drowns (FindTest did at a goto target): keep heads up
  for (const a of [bot, tester]) {
    setInterval(() => {
      try {
        const b = a.bot
        if (!a.currentAction || a === tester) b.setControlState('jump', !!(b.entity as any)?.isInWater)
      } catch {}
    }, 500).unref()
  }
  return { bot, tester }
}

async function stop (...agents: Agent[]): Promise<void> {
  for (const a of agents) { try { a.storage.flush() } catch {} ; await a.stop().catch(() => {}) }
}

/** Walks the tester to within a few blocks of the bot. */
async function joinUp (bot: Agent, tester: Agent): Promise<void> {
  const p = bot.bot.entity.position
  if (tester.bot.entity.position.distanceTo(p) < 6) return
  await act(tester, 'goto', { x: Math.floor(p.x) + 3, z: Math.floor(p.z) + 2 }, false)
}

async function main (): Promise<void> {
  const { bot, tester } = await both()
  try {
    log(state(bot))
    log(state(tester))
    if (mode === 'walk') {
      // waypoints: x z [x z ...], walked in order (a detour round a lake the straight line drowns in)
      const pts = args.map(Number)
      for (let k = 0; k + 1 < pts.length; k += 2) {
        const x = pts[k]!
        const z = pts[k + 1]!
        await Promise.all([
          (async () => { for (let i = 0; i < 10; i++) { while (bot.currentAction) await pause(2000); if ((await act(bot, 'goto', { x, z }, false)).ok) break; await pause(3000) } })(),
          (async () => { for (let i = 0; i < 6; i++) { if ((await act(tester, 'goto', { x: x + 4, z: z + 3 }, false)).ok) break; await pause(3000) } })()
        ])
      }
      log(state(bot))
      log(state(tester))
    } else if (mode === 'run') {
      // scouting is by day: wait for the morning (up to 10 min) unless told not to
      const night = () => { const t = bot.bot.time.timeOfDay; return t >= 12_542 && t <= 23_459 }
      if (process.env.SEARCH_NO_WAIT !== 'true' && night()) {
        log(`night (time ${bot.bot.time.timeOfDay}), waiting for the morning`)
        const until = Date.now() + 10 * 60_000
        while (night() && Date.now() < until) await pause(5000)
      }
      await joinUp(bot, tester)
      for (const spec of args) {
        const i = spec.indexOf(' ')
        const name = i < 0 ? spec : spec.slice(0, i)
        const params = i < 0 ? {} : JSON.parse(spec.slice(i + 1))
        for (let i = 0; i < 4; i++) {
          while (bot.currentAction) await pause(1000)
          await joinUp(bot, tester)
          const r = await act(bot, name, params)
          if (!/^busy/.test(r.message)) break
          await pause(3000)
        }
        while (bot.currentAction) await pause(1000) // a preempted long action resumes on its own
        log(state(bot))
        log(state(tester))
      }
    } else if (mode === 'tidy') {
      log(`own chests: ${JSON.stringify(ownChests(bot))}`)
      log(`places: ${JSON.stringify(bot.storage.get('places', {}))}`)
    }
  } finally {
    await stop(bot, tester)
  }
}

main().then(() => process.exit(0), e => { console.error(e); process.exit(1) })
