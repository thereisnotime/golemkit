// Live test of recover_drops on a real server, with an op account as the director.
//   node scripts/recover-test.ts <x> <z> [scenarios]   scenarios: basic,far,danger (default all)
// RECOVER_BOT (default RecoverTest) goes to x/z (300+ blocks from spawn, the fortress, the village
// and online players), sets home and its spawnpoint there. DIRECTOR (default ClaudeTest, an op)
// gives a kit, the bot walks out, the director /kills it (logging in only for short bursts of commands, once it is offline) and watches what recover_drops does after the respawn:
//   basic   dies 60 blocks out with a kit: goes back, picks up, re-equips, comes home, reports
//   far     maxDistance 40, dies 60 out: skips and says why
//   danger  dies 36 blocks out next to 3 skeletons: waits; the director kills them, then it goes
// Only /tp, /spreadplayers (the first placement), /spawnpoint, /give, /clear, /kill, /summon (tagged mobs) and /effect;
// never gamerules. Everything summoned and every item left near the spots is killed at the end.
import { Agent, defineVariant, serverFromEnv, PRIORITY, fmtPos, type ActionResult } from '../src/core/index.ts'
import { standardSkills, extendedSkills, navigation } from '../src/skills/index.ts'
import { reflexes, behaviorsBrain } from '../src/brains/index.ts'
import { lastOwnDeath } from '../src/skills/recover.ts'

const [xs = '1250', zs = '800', which = 'basic,far,danger'] = process.argv.slice(2)
const X = Number(xs)
const Z = Number(zs)
const BOT = process.env.RECOVER_BOT || 'RecoverTest'
const DIRECTOR = process.env.DIRECTOR || 'ClaudeTest'
const DATA = process.env.RECOVER_DATA_DIR || 'data/recover-test'
const TAG = 'recovertest'
const KEEP_AWAY = [{ name: 'spawn', x: 545, z: 45 }, { name: 'fortress', x: 560, z: -43 }, { name: 'village', x: -2770, z: 1090 }]
const server = serverFromEnv()
const t0 = Date.now()
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`)
const pause = (ms: number) => new Promise(r => setTimeout(r, ms))

const variant = defineVariant({
  name: 'recover-test',
  skills: [...standardSkills(), navigation(), ...extendedSkills()],
  brains: [reflexes({ retreatBelow: 0, waterFightAbove: 0 }), behaviorsBrain({ defaults: {} })]
})

async function connect (agent: Agent): Promise<void> {
  const ready = new Promise<void>(resolve => agent.once('session', () => setTimeout(resolve, 4000)))
  void agent.start()
  await ready
}

const live = (a: Agent) => { try { return !!a.bot?.entity && a.bot.health > 0 } catch { return false } }

function state (a: Agent): string {
  const b = a.bot
  const cur = a.currentAction ? a.currentAction.name : 'idle'
  const armour = [5, 6, 7, 8].map(i => b.inventory.slots[i]?.name).filter(Boolean).join('+') || 'no armour'
  const n = b.inventory.items().reduce((s, i) => s + i.count, 0)
  return `at ${fmtPos(b.entity.position)} hp ${Math.round(b.health)} | ${cur} | ${armour} | held ${b.heldItem?.name ?? '-'} | ${n} items`
}

async function main (): Promise<void> {
  const near = KEEP_AWAY.find(p => Math.hypot(p.x - X, p.z - Z) < 300)
  if (near) { log(`${X} ${Z} is within 300 blocks of the ${near.name}; pick another spot`); return }
  const bot = new Agent(variant, server, { username: BOT, dataDir: DATA, canDig: false, owners: [DIRECTOR] })
  // The director account is shared with other live scripts (a second login kicks the first): it
  // logs in only for short bursts of commands, once it is offline, and leaves after 15 s idle.
  let dir: Agent | null = null
  let idle: ReturnType<typeof setTimeout> | null = null
  const release = async () => {
    if (idle) clearTimeout(idle)
    idle = null
    const d = dir
    dir = null
    if (d) await d.stop().catch(() => {})
  }
  const director = async (): Promise<Agent> => {
    if (dir) return dir
    for (let said = false, until = Date.now() + 30 * 60_000; bot.bot?.players?.[DIRECTOR]; await pause(10_000)) {
      if (Date.now() > until) throw new Error(`${DIRECTOR} stayed online for 30 min`)
      if (!said) { log(`${DIRECTOR} is online (another script?), waiting for it to leave`); said = true }
    }
    const d = new Agent(defineVariant({ name: 'director', skills: standardSkills(), brains: [] }), server, { username: DIRECTOR, dataDir: `${DATA}-director` })
    await connect(d)
    d.bot.on('messagestr', (m: string) => { if (/Unknown|Incorrect|Expected|Could not|Unable|No entity|not/i.test(m)) log(`server: ${m}`) })
    dir = d
    return d
  }
  const cmd = async (c: string) => {
    if (idle) clearTimeout(idle)
    const d = await director()
    const ok = await d.command(c)
    if (!ok) log(`command refused: ${c}`)
    await pause(500)
    idle = setTimeout(() => { void release() }, 15_000)
  }
  const said: string[] = []
  bot.on('chatOut', (m: { message: string }) => { said.push(m.message); log(`SAID: ${m.message}`) })
  bot.on('actionEnd', (info: any, r: ActionResult) => { if (info.caller?.name !== 'recover-test') log(`${r.ok ? 'done' : 'FAIL'} ${info.name} (${info.caller.kind}:${info.caller.name}): ${r.message}`) })
  const step = async (name: string, params: Record<string, unknown> = {}) => {
    const r = await bot.act(name, params, { caller: { kind: 'system', name: 'recover-test' }, priority: PRIORITY.player })
    log(`${r.ok ? 'OK  ' : 'FAIL'} ${name} ${JSON.stringify(params)}: ${r.message}`)
    return r
  }
  await connect(bot)
  while (!live(bot)) await pause(1000)
  for (const name of ['recover_drops', 'stay_safe', 'keep_fed', 'collect_drops']) await step('behavior_disarm', { name }).catch(() => null)
  const players = Object.values(bot.bot.players).filter(p => p.username !== BOT && p.username !== DIRECTOR)
  const close = players.filter(p => p.entity && Math.hypot(p.entity.position.x - X, p.entity.position.z - Z) < 300)
  log(`online: ${players.map(p => p.username).join(', ') || 'nobody else'}; time ${bot.bot.time.timeOfDay}`)
  if (close.length) { log(`players near the test spot (${close.map(p => p.username).join(', ')}); stopping`); await bot.stop(); return }

  // home on the surface at x/z, the respawn point on it
  await cmd(`/gamemode survival ${BOT}`)
  await cmd(`/spreadplayers ${X} ${Z} 0 1 false ${BOT}`)
  await pause(3000)
  const h = bot.bot.entity.position.floored()
  const home = { x: h.x, y: h.y, z: h.z }
  await cmd(`/spawnpoint ${BOT} ${home.x} ${home.y} ${home.z}`)
  await step('set_home')
  log(`home ${fmtPos(home)}: ${state(bot)}`)

  const kit = async () => {
    await cmd(`/clear ${BOT}`)
    await cmd(`/effect give ${BOT} minecraft:instant_health 1 10`)
    await cmd(`/effect give ${BOT} minecraft:saturation 1 10`)
    await cmd(`/give ${BOT} minecraft:stone_sword 1`)
    await cmd(`/give ${BOT} minecraft:stone_pickaxe 1`)
    for (const p of ['helmet', 'chestplate', 'leggings', 'boots']) await cmd(`/give ${BOT} minecraft:iron_${p} 1`)
    await cmd(`/give ${BOT} minecraft:stick 20`) // nothing placeable: the pathfinder would build with it
    await cmd(`/give ${BOT} minecraft:bread 5`)
    await pause(4000) // reflexes put the armour on
  }
  /** Moves the bot `dx` blocks east of home onto the ground, then the director kills it. */
  const dieAt = async (dx: number, before?: () => Promise<void>) => {
    await step('goto', { x: home.x + dx, z: home.z })
    await pause(2000)
    if (before) await before()
    log(`before death: ${state(bot)}`)
    const spot = bot.bot.entity.position.floored()
    await cmd(`/kill ${BOT}`)
    return spot
  }
  const watch = async (secs: number, done: () => boolean) => {
    const until = Date.now() + secs * 1000
    let last = 0
    while (Date.now() < until && !done()) {
      await pause(2000)
      if (Date.now() - last > 10_000 && live(bot)) { log(state(bot)); last = Date.now() }
    }
  }
  const cleanupAt = async (p: { x: number, y: number, z: number }) => {
    const left = Object.values(bot.bot.entities).filter((e: any) => e.name === 'item' && e.position.distanceTo(p) <= 24)
      .map((e: any) => { try { const it = e.getDroppedItem(); return `${it?.count} ${it?.name} at ${fmtPos(e.position)}` } catch { return 'item' } })
    if (left.length) log(`items left near ${fmtPos(p)}: ${left.join(', ')}`)
    await cmd(`/execute positioned ${p.x} ${p.y} ${p.z} run kill @e[type=item,distance=..24]`)
  }
  const results: string[] = []
  // blocks an earlier run left behind: REMOVE_BLOCKS="x,y,z;x,y,z", only when they are REMOVE_NAME (default cobblestone)
  for (const t of (process.env.REMOVE_BLOCKS ?? '').split(';').filter(Boolean)) {
    const [x, y, z] = t.split(',').map(Number) as [number, number, number]
    const b = bot.bot.blockAt(bot.bot.entity.position.clone().set(x, y, z))
    if (b?.name === (process.env.REMOVE_NAME ?? 'cobblestone')) { await cmd(`/setblock ${x} ${y} ${z} minecraft:air`); log(`removed ${b.name} at ${x} ${y} ${z}`) } else log(`nothing to remove at ${x} ${y} ${z} (${b?.name ?? 'not loaded'})`)
  }
  const isDay = () => { const t = bot.bot.time.timeOfDay; return t < 12542 || t > 23459 }
  // anything the bot puts down (it shouldn't: no digging, nothing placeable) is removed at the end
  const placed: { x: number, y: number, z: number, name: string }[] = []
  bot.bot.on('blockUpdate', (old: any, now: any) => {
    if (!now || !old || !/^(air|cave_air|water)$/.test(old.name) || /^(air|cave_air|water|fire)$/.test(now.name)) return
    if (now.position.distanceTo(bot.bot.entity.position) > 5) return
    placed.push({ x: now.position.x, y: now.position.y, z: now.position.z, name: now.name })
    log(`placed? ${now.name} at ${fmtPos(now.position)}`)
  })
  await cleanupAt(home) // leftovers of an earlier run
  const cobble = bot.bot.registry.blocksByName.cobblestone?.id
  if (cobble !== undefined) {
    const found = bot.bot.findBlocks({ matching: cobble, maxDistance: 80, count: 40 }).filter(p => Math.abs(p.z - home.z) <= 12 && p.x >= home.x - 8 && p.x <= home.x + 70)
    log(`cobblestone along the test path: ${found.map(p => fmtPos(p)).join(', ') || 'none'}`)
  }
  await cmd(`/clear ${BOT}`)

  if (which.includes('basic')) {
    log('--- basic: dies 60 blocks out with a kit')
    // by day: at night a bot without its armour only goes back 48 blocks
    for (let until = Date.now() + 12 * 60_000; !isDay() && Date.now() < until;) { log(`waiting for day (time ${bot.bot.time.timeOfDay})`); await pause(30_000) }
    await step('behavior_arm', { name: 'recover_drops', options: { maxDistance: 400 } })
    await kit()
    const n = said.length
    const spot = await dieAt(60)
    await watch(150, () => said.slice(n).some(m => /got back|got nothing|not going back|lost \d+ items/.test(m)) && !bot.currentAction)
    await watch(40, () => !bot.currentAction)
    log(`after: ${state(bot)}; home ${Math.round(Math.hypot(bot.bot.entity.position.x - home.x, bot.bot.entity.position.z - home.z))} blocks away`)
    results.push(`basic: ${said.slice(n).join(' | ') || 'nothing said'}; ${state(bot)}`)
    await cleanupAt(spot)
  }

  if (which.includes('far')) {
    log('--- far: maxDistance 40, dies 60 out')
    await step('behavior_arm', { name: 'recover_drops', options: { maxDistance: 40 } })
    await kit()
    const n = said.length
    const spot = await dieAt(60)
    await watch(30, () => said.slice(n).length > 0)
    results.push(`far: ${said.slice(n).join(' | ') || 'nothing said'}; death ${JSON.stringify({ handled: lastOwnDeath(bot)?.handled })}`)
    await cleanupAt(spot)
  }

  if (which.includes('danger')) {
    log('--- danger: dies 36 blocks out next to 3 skeletons')
    await step('behavior_arm', { name: 'recover_drops', options: { maxDistance: 400 } })
    await kit()
    const n = said.length
    // helmets so daylight doesn't burn them; NoAI keeps them by the spot
    const spot = await dieAt(36, async () => {
      const p = bot.bot.entity.position
      for (const [dx, dz] of [[3, 0], [-3, 1], [0, -3]]) {
        await cmd(`/summon minecraft:skeleton ${(p.x + dx).toFixed(1)} ${p.y.toFixed(1)} ${(p.z + dz).toFixed(1)} {Tags:["${TAG}"],NoAI:1b,PersistenceRequired:1b,ArmorItems:[{},{},{},{id:"minecraft:leather_helmet",count:1}]}`)
      }
      await pause(1500)
    })
    await pause(15_000)
    const d = lastOwnDeath(bot)
    log(`death record: hostiles ${JSON.stringify(d?.hostiles)}, kind ${d?.kind}, handled ${d?.handled}; current ${bot.currentAction?.name ?? 'idle'}`)
    const waited = !bot.currentAction && !d?.handled
    await cmd(`/kill @e[tag=${TAG}]`)
    log('director killed the skeletons')
    await watch(240, () => said.slice(n).some(m => /got back|got nothing|not going back|lost \d+ items/.test(m)) && !bot.currentAction)
    results.push(`danger: waited while the skeletons were there: ${waited}; ${said.slice(n).join(' | ') || 'nothing said'}; ${state(bot)}`)
    await cleanupAt(spot)
  }

  // cleanup: summoned mobs, items near home, the test bot's kit; the spawnpoint stays at the arena
  await cmd(`/kill @e[tag=${TAG}]`)
  await cleanupAt(home)
  await step('behavior_disarm', { name: 'recover_drops' }).catch(() => null)
  for (const p of placed) { await cmd(`/setblock ${p.x} ${p.y} ${p.z} minecraft:air`); log(`removed ${p.name} at ${p.x} ${p.y} ${p.z}`) }
  await cmd(`/clear ${BOT}`)
  log('RESULTS')
  for (const r of results) log(r)
  bot.storage.flush()
  await release()
  await bot.stop()
}

main().then(() => process.exit(0), e => { console.error(e); process.exit(1) })
