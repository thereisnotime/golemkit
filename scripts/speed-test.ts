// Live speed and accounting test for gathering, away from spawn, with an empty inventory.
//   node scripts/speed-test.ts <x> <z> 'gather_materials {"items":{"cobblestone":64}}' ['upgrade_tools {}' ...]
// The bot is SPEED_BOT (default SpeedTest), owned by SPEED_OWNER (default SpeedTester). It
// empties its inventory (SPEED_KEEP_INV=true keeps it), walks to x/z, runs the steps and prints
// per step: time, blocks broken per minute, logs broken vs. logs that ended up in the
// inventory (as logs, planks, sticks...) and dropped items still lying around.
import { Agent, defineVariant, serverFromEnv, PRIORITY } from '../src/core/index.ts'
import { standardSkills, extendedSkills } from '../src/skills/index.ts'
import { reflexes } from '../src/brains/index.ts'
import { inventoryCounts } from '../src/skills/toolkit.ts'
import { woodBalance } from '../src/skills/efficiency.ts'

const [xs, zs, ...steps] = process.argv.slice(2)
if (xs === undefined || zs === undefined) { console.error('usage: speed-test.ts <x> <z> <step>...'); process.exit(2) }
const BOT = process.env.SPEED_BOT || 'SpeedTest'
const OWNER = process.env.SPEED_OWNER || 'SpeedTester'
const t0 = Date.now()
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`)

const agent = new Agent(defineVariant({ name: 'speed-test', skills: [...standardSkills(), ...extendedSkills()], brains: [reflexes()] }), serverFromEnv(), {
  username: BOT, owners: [OWNER], canDig: true, dataDir: 'data/speed-test'
})
agent.on('actionEnd', (info, r) => { if (info.caller?.kind === 'reflex') log(`reflex ${info.name}: ${r.message}`) })

async function act (name: string, params: Record<string, unknown>) {
  for (let i = 0; i < 4; i++) {
    const r = await agent.act(name, params, { caller: { kind: 'system', name: 'speed-test' }, priority: PRIORITY.player })
    if (!/^(preempted|busy|session ended|died)/.test(r.message)) return r
    while (agent.currentAction) await new Promise(res => setTimeout(res, 2000))
  }
  return { ok: false, message: 'kept being preempted' }
}

agent.once('session', async () => {
  await new Promise(r => setTimeout(r, 4000))
  const bot = agent.bot
  log(`spawned at ${JSON.stringify(agent.observe().position)} mode ${bot.game.gameMode}, inventory ${JSON.stringify(inventoryCounts(bot))}`)
  // night mobs end runs early: wait for morning like build-test does
  const night = () => { const t = bot.time.timeOfDay; return t > 12500 && t < 23200 }
  if (night() && process.env.SPEED_NO_WAIT !== 'true') {
    log(`night (time ${bot.time.timeOfDay}), waiting up to 10 min for morning`)
    const until = Date.now() + 10 * 60_000
    while (night() && Date.now() < until) await new Promise(res => setTimeout(res, 5000))
  }
  // toss right before leaving, or the bot picks it all up again while it waits
  if (process.env.SPEED_KEEP_INV !== 'true') {
    for (const it of bot.inventory.items()) await bot.tossStack(it).catch(() => {})
    log(`emptied inventory: ${JSON.stringify(inventoryCounts(bot))}`)
  }
  const r = await act('goto', { x: Number(xs), z: Number(zs) })
  log(`goto: ${r.message}`)
  // Count what this bot breaks: blocks within reach that turn into air (mostly our own digs).
  const dug: Record<string, number> = {}
  bot.on('blockUpdate', (old: any, now: any) => {
    if (!old || !now || old.name === now.name || !/^(air|cave_air|water)$/.test(now.name) || /^(air|cave_air|water|lava)$/.test(old.name)) return
    if (old.name.endsWith('_leaves') || old.position.distanceTo(bot.entity.position) > 6) return
    dug[old.name] = (dug[old.name] ?? 0) + 1
  })
  for (const step of steps) {
    const space = step.indexOf(' ')
    const name = space < 0 ? step : step.slice(0, space)
    const params = space < 0 ? {} : JSON.parse(step.slice(space + 1))
    for (const k of Object.keys(dug)) delete dug[k]
    const before = inventoryCounts(bot)
    const t = Date.now()
    const res = await act(name, params)
    const mins = (Date.now() - t) / 60_000
    const after = inventoryCounts(bot)
    const broken = Object.values(dug).reduce((a, b) => a + b, 0)
    const drops = Object.values(bot.entities).filter(e => e.name === 'item' && e.position.distanceTo(bot.entity.position) < 24).length
    log(`${res.ok ? 'OK  ' : 'FAIL'} ${name} ${JSON.stringify(params)} (${(mins * 60).toFixed(0)}s): ${res.message}`)
    log(`  broke ${broken} blocks (${(broken / Math.max(mins, 1e-6)).toFixed(1)}/min): ${JSON.stringify(dug)}`)
    log(`  wood: ${JSON.stringify(woodBalance(dug, before, after))}, drops still within 24: ${drops}`)
    log(`  inventory: ${JSON.stringify(after)}`)
  }
  await agent.stop()
  process.exit(0)
})
setTimeout(() => { console.error('timeout'); process.exit(2) }, Number(process.env.SPEED_TEST_TIMEOUT_MS || 30 * 60_000)).unref?.()
void agent.start()
