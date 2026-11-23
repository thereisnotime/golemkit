// Live test of container memory (settings.inventoryMemory) on a real server, with an op account
// as the director.
//   node scripts/chest-memory-test.ts <x> <z>
// CHEST_BOT (default ChestTest) goes to x/z (300+ blocks from spawn, the fortress, the village and
// online players) and sets home there. DIRECTOR (default ClaudeTest, an op, and the test bot's
// owner) logs in only for short bursts of commands once it is offline, and:
//   1. puts a chest with 18 bread next to the bot (the bot's configured pantry); check_chests looks inside
//   2. the bot restarts: the entry is still there (where_stored answers with position and age)
//   3. /data modify takes 12 bread: check_chests journals container_changed and grumbles to the owner
//   4. the chest is removed in view: container_gone, without walking there
//   5. a chest again, looked into, then moved 2 blocks: container_gone with movedTo, the new one unknown
//   6. pantry low: check_chests reports it; by day the check_storage behaviour tells the owner
// Only /tp, /spreadplayers, /gamemode, /setblock, /data modify, /clear and /kill of items near the
// spot; never gamerules or time. Every block placed is set back to air at the end.
import { Agent, defineVariant, serverFromEnv, PRIORITY, fmtPos, type ActionResult } from '../src/core/index.ts'
import { standardSkills, extendedSkills, navigation } from '../src/skills/index.ts'
import { reflexes, behaviorsBrain } from '../src/brains/index.ts'
import { knownContainers } from '../src/skills/containers.ts'

const [xs = '1100', zs = '400'] = process.argv.slice(2)
const X = Number(xs)
const Z = Number(zs)
const BOT = process.env.CHEST_BOT || 'ChestTest'
const DIRECTOR = process.env.DIRECTOR || 'ClaudeTest'
const DATA = process.env.CHEST_DATA_DIR || 'data/chest-memory-test'
const KEEP_AWAY = [{ name: 'spawn', x: 545, z: 45 }, { name: 'fortress', x: 560, z: -43 }, { name: 'village', x: -2770, z: 1090 }]
const server = serverFromEnv()
const t0 = Date.now()
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`)
const pause = (ms: number) => new Promise(r => setTimeout(r, ms))

const variant = defineVariant({
  name: 'chest-memory-test',
  skills: [...standardSkills(), navigation(), ...extendedSkills()],
  brains: [reflexes({ retreatBelow: 0, waterFightAbove: 0 }), behaviorsBrain({ defaults: {} })]
})

async function connect (agent: Agent): Promise<void> {
  const ready = new Promise<void>(resolve => agent.once('session', () => setTimeout(resolve, 4000)))
  void agent.start()
  await ready
}

const live = (a: Agent) => { try { return !!a.bot?.entity && a.bot.health > 0 } catch { return false } }

async function main (): Promise<void> {
  const near = KEEP_AWAY.find(p => Math.hypot(p.x - X, p.z - Z) < 300)
  if (near) { log(`${X} ${Z} is within 300 blocks of the ${near.name}; pick another spot`); return }
  let chest = { x: 0, y: 0, z: 0 }
  const settings = (pantry: typeof chest | null) => ({
    inventoryMemory: { enabled: true, indexOwn: true, grumble: true, grumbleTo: 'owners', refreshMinutes: 1, lowFood: 8, radius: 32 },
    ...(pantry ? { storage: { chests: [[pantry.x, pantry.y, pantry.z]] } } : {}),
    askHelp: { enabled: true }
  })
  const make = (pantry: typeof chest | null) => new Agent(variant, server, { username: BOT, dataDir: DATA, canDig: false, owners: [DIRECTOR], settings: settings(pantry) })
  let bot = make(null)

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
    d.bot.on('messagestr', (m: string) => { if (/Unknown|Incorrect|Expected|Could not|Unable|No entity|not loaded|Invalid/i.test(m)) log(`server: ${m}`) })
    d.bot.on('whisper', (from: string, m: string) => { if (from === BOT) log(`${DIRECTOR} got whisper: ${m}`) })
    dir = d
    return d
  }
  const cmd = async (c: string) => {
    if (idle) clearTimeout(idle)
    const d = await director()
    const ok = await d.command(c)
    if (!ok) log(`command refused: ${c}`)
    await pause(600)
    idle = setTimeout(() => { void release() }, 15_000)
  }
  const said: string[] = []
  const events: string[] = []
  const hook = (a: Agent) => {
    a.on('chatOut', (m: { message: string }) => { said.push(m.message); log(`SAID: ${m.message}`) })
    const rec = a.journal.record.bind(a.journal)
    a.journal.record = (type: string, data: Record<string, unknown> = {}, extra = {}) => {
      if (/^container_|^help$/.test(type)) { events.push(`${type}: ${String(data.text ?? data.message ?? '')}`); log(`JOURNAL ${type}: ${JSON.stringify(data)}`) }
      return rec(type, data, extra)
    }
    a.on('actionEnd', (info: any, r: ActionResult) => { if (info.caller?.name !== 'chest-test') log(`${r.ok ? 'done' : 'FAIL'} ${info.name} (${info.caller.kind}:${info.caller.name}): ${r.message}`) })
  }
  const step = async (name: string, params: Record<string, unknown> = {}) => {
    const r = await bot.act(name, params, { caller: { kind: 'system', name: 'chest-test' }, priority: PRIORITY.player })
    log(`${r.ok ? 'OK  ' : 'FAIL'} ${name} ${JSON.stringify(params)}: ${r.message}`)
    return r
  }
  const results: string[] = []
  // what stood there before (air, a snow layer, grass), put back at the end
  const placed = new Map<string, string>()
  const put = async (p: typeof chest, nbt: string) => {
    const k = `${p.x} ${p.y} ${p.z}`
    if (!placed.has(k)) placed.set(k, bot.bot.blockAt(bot.bot.entity.position.clone().set(p.x, p.y, p.z))?.name ?? 'air')
    await cmd(`/setblock ${k} minecraft:chest${nbt}`)
  }
  const clear = async (p: typeof chest) => { await cmd(`/setblock ${p.x} ${p.y} ${p.z} minecraft:air`) }
  const where = () => bot.bot.entity.position
  const atSpot = () => Math.hypot(where().x - X, where().z - Z) < 40

  hook(bot)
  await connect(bot)
  while (!live(bot)) await pause(1000)
  for (const name of ['stay_safe', 'keep_fed', 'collect_drops', 'check_storage']) await step('behavior_disarm', { name }).catch(() => null)
  const players = Object.values(bot.bot.players).filter(p => p.username !== BOT && p.username !== DIRECTOR)
  const close = players.filter(p => p.entity && Math.hypot(p.entity.position.x - X, p.entity.position.z - Z) < 300)
  log(`online: ${players.map(p => p.username).join(', ') || 'nobody else'}; time ${bot.bot.time.timeOfDay}`)
  if (close.length) { log(`players near the test spot (${close.map(p => p.username).join(', ')}); stopping`); await bot.stop(); return }

  try {
    await cmd(`/gamemode survival ${BOT}`)
    await cmd(`/spreadplayers ${X} ${Z} 0 1 false ${BOT}`)
    await pause(3000)
    if (!atSpot()) throw new Error(`bot is at ${fmtPos(where())}, not near ${X} ${Z}; stopping`)
    await step('set_home')
    const f = where().floored()
    // a spot 2 blocks east on the bot's level: air, with solid ground under it
    await pause(3000) // chunks around the spot
    const at = (x: number, y: number, z: number) => bot.bot.blockAt(f.clone().set(x, y, z))
    const free = (x: number, y: number, z: number) => /^(air|short_grass|grass|fern|snow)$/.test(at(x, y, z)?.name ?? '-') && at(x, y - 1, z)?.boundingBox === 'block'
    log(`around ${fmtPos(f)}: ${[[2, 0], [-2, 0], [0, 2], [0, -2]].map(([dx, dz]) => `${at(f.x + dx!, f.y, f.z + dz!)?.name}/${at(f.x + dx!, f.y - 1, f.z + dz!)?.name}`).join(' ')}`)
    const spots = [[2, 0], [-2, 0], [0, 2], [0, -2], [3, 1], [-3, -1]].map(([dx, dz]) => ({ x: f.x + dx!, y: f.y, z: f.z + dz! })).filter(p => free(p.x, p.y, p.z) && free(p.x + 2, p.y, p.z))
    if (!spots.length) throw new Error(`no free spot for a chest by ${fmtPos(f)}`)
    chest = spots[0]!
    log(`bot at ${fmtPos(where())}, chest at ${fmtPos(chest)}`)
    // the pantry is configured: a new agent with the settings (restart 1)
    await bot.stop()
    bot = make(chest)
    hook(bot)
    await connect(bot)
    while (!live(bot)) await pause(1000)
    for (const name of ['stay_safe', 'keep_fed', 'collect_drops', 'check_storage']) await step('behavior_disarm', { name }).catch(() => null)
    if (!atSpot()) throw new Error(`bot is at ${fmtPos(where())} after the restart; stopping`)

    log('--- 1: chest with 18 bread, check_chests looks inside')
    await put(chest, '{Items:[{Slot:0b,id:"minecraft:bread",count:18}]}')
    await pause(1500)
    let r = await step('check_chests', { all: true })
    results.push(`1 look: ${r.message}`)

    log('--- 2: restart, memory still there')
    await bot.stop()
    await pause(2000)
    bot = make(chest)
    hook(bot)
    await connect(bot)
    while (!live(bot)) await pause(1000)
    for (const name of ['stay_safe', 'keep_fed', 'collect_drops', 'check_storage']) await step('behavior_disarm', { name }).catch(() => null)
    const k = knownContainers(bot)
    log(`known after restart: ${JSON.stringify(k)}`)
    r = await step('where_stored', { item: 'bread' })
    results.push(`2 restart: ${k.length} known; where_stored: ${r.message}`)

    log('--- 3: someone takes 12 bread')
    await cmd(`/data modify block ${chest.x} ${chest.y} ${chest.z} Items[0].count set value 6`)
    await pause(1000)
    const nSaid = said.length
    r = await step('check_chests', { all: true })
    await pause(2000)
    results.push(`3 taken: ${r.message}; events: ${events.filter(e => e.startsWith('container_changed')).join(' | ')}; said: ${said.slice(nSaid).join(' | ') || '-'}`)
    if (r.data && (r.data as any).low) results.push(`6 pantry low: ${(r.data as any).low.text}`)

    log('--- 4: the chest is removed in view')
    bot.storage.delete('containers.grumbled') // the 10-minute grumble gap would hide the next one
    let n = events.length
    await clear(chest)
    await pause(2500)
    results.push(`4 broken in view: ${events.slice(n).join(' | ') || 'nothing journalled'}; known ${knownContainers(bot).length}`)

    log('--- 5: chest back, looked into, then moved 2 blocks east')
    await put(chest, '{Items:[{Slot:0b,id:"minecraft:bread",count:4}]}')
    await pause(1500)
    await step('check_chests', { all: true })
    bot.storage.delete('containers.grumbled')
    n = events.length
    const moved = { x: chest.x + 2, y: chest.y, z: chest.z }
    await put(moved, '{Items:[{Slot:0b,id:"minecraft:bread",count:4}]}')
    await clear(chest)
    await pause(2500)
    results.push(`5 moved: ${events.slice(n).join(' | ') || 'nothing journalled'}; unknown entries ${knownContainers(bot, { includeUnknown: true }).filter(c => c.freshness === 'unknown').map(c => fmtPos(c)).join(', ') || 'none'}`)
    const own = await step('check_chests', { all: true })
    results.push(`5 check after the move: ${own.message}`)

    log('--- 6: the behaviour (by day)')
    const t = bot.bot.time.timeOfDay
    if (t < 12542 || t > 23459) {
      await put(chest, '{Items:[{Slot:0b,id:"minecraft:bread",count:5}]}')
      await clear(moved)
      await pause(1500)
      bot.storage.delete('containers.lowReported')
      // memory of the chest is gone (moved away): the behaviour sees it as due
      n = events.length
      // the director stays online while the behaviour runs, so the owner whisper has someone to go to
      await director()
      if (idle) { clearTimeout(idle); idle = null }
      await step('behavior_arm', { name: 'check_storage', options: { max: 2 } })
      for (let until = Date.now() + 60_000; Date.now() < until && !events.slice(n).some(e => e.startsWith('help')); await pause(2000)) {}
      await step('behavior_disarm', { name: 'check_storage' })
      results.push(`6 behaviour: ${events.slice(n).join(' | ') || 'nothing journalled'}`)
    } else results.push(`6 behaviour: skipped, night (time ${t})`)
  } catch (e) {
    log(`stopped: ${(e as Error).message}`)
    results.push(`stopped: ${(e as Error).message}`)
  } finally {
    for (const [p, was] of placed) {
      await cmd(`/setblock ${p} minecraft:${/^(air|snow|short_grass|fern)$/.test(was) ? was : 'air'}`).catch(() => {})
      log(`set ${p} back to ${was}`)
    }
    if (chest.x) await cmd(`/execute positioned ${chest.x} ${chest.y} ${chest.z} run kill @e[type=item,distance=..12]`).catch(() => {})
    await cmd(`/clear ${BOT}`).catch(() => {})
    await release()
    await bot.stop().catch(() => {})
  }
  console.log('\nRESULTS')
  for (const r of results) console.log(`- ${r}`)
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
