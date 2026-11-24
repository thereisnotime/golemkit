// Live test of home storage (storage.chests roles, deposit_when_full, seeds, iron and gear from
// chests, the bed in a chest it never opened) on a real server, with an op account as director.
//   node scripts/home-storage-test.ts <x> <z>
// HOME_BOT (default HomeTest) goes to x/z (300+ blocks from spawn, the fortress, the village and
// online players) and sets home there. DIRECTOR (default ClaudeTest, an op) logs in only for short
// bursts of commands and:
//   1. sets three configured chests: the pantry (5 bread, 35 wheat seeds), a storage chest full of
//      cobblestone and a gear chest (red bed, shield, 9 iron ingots) the bot never looked into;
//   2. keep_spawn_bed: looks into the gear chest, takes the bed, places it by home;
//   3. gather_seeds (digging off): takes the seeds from the pantry;
//   4. upgrade_tools with stone tools: takes the iron and the shield from the gear chest, crafts;
//   5. deposit_when_full with junk in the inventory: nothing non-food into the pantry, the storage
//      chest is full, so it places a chest of its own and stores there.
// Only /tp, /spreadplayers, /gamemode, /setblock, /give, /clear and /kill of items near the spot;
// never gamerules or time. Every block changed near home is set back at the end.
import { Agent, defineVariant, serverFromEnv, PRIORITY, fmtPos, type ActionResult } from '../src/core/index.ts'
import { standardSkills, extendedSkills, navigation } from '../src/skills/index.ts'
import { reflexes, behaviorsBrain } from '../src/brains/index.ts'
import { knownContainers, ownChests } from '../src/skills/containers.ts'

const [xs = '1100', zs = '400'] = process.argv.slice(2)
const X = Number(xs)
const Z = Number(zs)
const BOT = process.env.HOME_BOT || 'HomeTest'
const DIRECTOR = process.env.DIRECTOR || 'ClaudeTest'
const DATA = process.env.HOME_DATA_DIR || 'data/home-storage-test'
const KEEP_AWAY = [{ name: 'spawn', x: 545, z: 45 }, { name: 'fortress', x: 560, z: -43 }, { name: 'village', x: -2770, z: 1090 }]
const server = serverFromEnv()
const t0 = Date.now()
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`)
const pause = (ms: number) => new Promise(r => setTimeout(r, ms))
type P = { x: number, y: number, z: number }

const variant = defineVariant({
  name: 'home-storage-test',
  skills: [...standardSkills(), navigation(), ...extendedSkills()],
  brains: [reflexes({ retreatBelow: 0, waterFightAbove: 0 }), behaviorsBrain({ defaults: {} })]
})

async function connect (agent: Agent): Promise<void> {
  const ready = new Promise<void>(resolve => agent.once('session', () => setTimeout(resolve, 4000)))
  void agent.start()
  await ready
}
const live = (a: Agent) => { try { return !!a.bot?.entity && a.bot.health > 0 } catch { return false } }
const inv = (a: Agent) => { const o: Record<string, number> = {}; for (const i of a.bot.inventory.items()) o[i.name] = (o[i.name] ?? 0) + i.count; return o }

async function main (): Promise<void> {
  const near = KEEP_AWAY.find(p => Math.hypot(p.x - X, p.z - Z) < 300)
  if (near) { log(`${X} ${Z} is within 300 blocks of the ${near.name}; pick another spot`); return }
  let chests: { pantry: P, storage: P, gear: P } | null = null
  const settings = () => ({
    inventoryMemory: { enabled: true, indexOwn: true, refreshMinutes: 600, radius: 32 },
    ...(chests ? { storage: { chests: [{ at: [chests.pantry.x, chests.pantry.y, chests.pantry.z], role: 'pantry' }, [chests.storage.x, chests.storage.y, chests.storage.z], { at: [chests.gear.x, chests.gear.y, chests.gear.z], role: 'gear' }] } } : {})
  })
  const make = () => new Agent(variant, server, { username: BOT, dataDir: DATA, canDig: false, owners: [DIRECTOR], settings: settings() })
  let bot = make()

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
  const hook = (a: Agent) => {
    a.on('actionEnd', (info: any, r: ActionResult) => { if (info.caller?.name !== 'home-test') log(`${r.ok ? 'done' : 'FAIL'} ${info.name} (${info.caller.kind}:${info.caller.name}): ${r.message}`) })
  }
  const step = async (name: string, params: Record<string, unknown> = {}) => {
    const r = await bot.act(name, params, { caller: { kind: 'system', name: 'home-test' }, priority: PRIORITY.player })
    log(`${r.ok ? 'OK  ' : 'FAIL'} ${name} ${JSON.stringify(params)}: ${r.message}`)
    return r
  }
  const disarmAll = async () => { for (const name of ['stay_safe', 'keep_fed', 'collect_drops', 'check_storage', 'deposit_when_full', 'keep_spawn_bed']) await step('behavior_disarm', { name }).catch(() => null) }
  const results: string[] = []
  const where = () => bot.bot.entity.position
  const atSpot = () => Math.hypot(where().x - X, where().z - Z) < 40
  // every block near home before the test, to put back what changed
  const before = new Map<string, string>()
  let homeAt: P | null = null
  const snapshot = (c: P) => {
    for (let dx = -10; dx <= 10; dx++) for (let dz = -10; dz <= 10; dz++) for (let dy = -3; dy <= 4; dy++) {
      const b = bot.bot.blockAt(bot.bot.entity.position.clone().set(c.x + dx, c.y + dy, c.z + dz))
      before.set(`${c.x + dx} ${c.y + dy} ${c.z + dz}`, b?.name ?? 'unloaded')
    }
  }
  const restoreList = (): [string, string, string][] => {
    const out: [string, string, string][] = []
    for (const [k, was] of before) {
      const [x, y, z] = k.split(' ').map(Number)
      const now = bot.bot.blockAt(bot.bot.entity.position.clone().set(x!, y!, z!))?.name ?? 'unloaded'
      // only what the test or the bot put down
      if (now !== was && was !== 'unloaded' && /chest|_bed$|torch|crafting_table|furnace/.test(now)) out.push([k, was, now])
    }
    return out
  }
  const waitFor = async (what: string, ms: number, check: () => boolean) => {
    for (let until = Date.now() + ms; Date.now() < until; await pause(2000)) if (check()) return true
    log(`timed out waiting for ${what}`)
    return false
  }

  hook(bot)
  await connect(bot)
  while (!live(bot)) await pause(1000)
  await disarmAll()
  const players = Object.values(bot.bot.players).filter(p => p.username !== BOT && p.username !== DIRECTOR)
  const close = players.filter(p => p.entity && Math.hypot(p.entity.position.x - X, p.entity.position.z - Z) < 300)
  log(`online: ${players.map(p => p.username).join(', ') || 'nobody else'}; time ${bot.bot.time.timeOfDay}`)
  if (close.length) { log(`players near the test spot (${close.map(p => p.username).join(', ')}); stopping`); await bot.stop(); return }

  try {
    await cmd(`/gamemode survival ${BOT}`)
    await cmd(`/clear ${BOT}`)
    await cmd(`/spreadplayers ${X} ${Z} 0 1 false ${BOT}`)
    await pause(4000)
    if (!atSpot()) throw new Error(`bot is at ${fmtPos(where())}, not near ${X} ${Z}; stopping`)
    await step('set_home')
    const f = where().floored()
    homeAt = { x: f.x, y: f.y, z: f.z }
    snapshot(homeAt)
    const at = (x: number, y: number, z: number) => bot.bot.blockAt(f.clone().set(x, y, z))
    const free = (x: number, y: number, z: number) => /^(air|short_grass|grass|fern|snow)$/.test(at(x, y, z)?.name ?? '-') && at(x, y - 1, z)?.boundingBox === 'block' && /^(air|snow)$/.test(at(x, y + 1, z)?.name ?? '-')
    const cands = [[3, 0], [3, 3], [3, -3], [-3, 0], [-3, 3], [-3, -3], [0, 3], [0, -3]].map(([dx, dz]) => ({ x: f.x + dx!, y: f.y, z: f.z + dz! })).filter(p => free(p.x, p.y, p.z))
    if (cands.length < 3) throw new Error(`only ${cands.length} free spots for chests by ${fmtPos(f)}`)
    chests = { pantry: cands[0]!, storage: cands[1]!, gear: cands[2]! }
    log(`home ${fmtPos(f)}; pantry ${fmtPos(chests.pantry)}, storage ${fmtPos(chests.storage)}, gear ${fmtPos(chests.gear)}`)
    const items = (list: [string, number][]) => `{Items:[${list.map(([id, n], i) => `{Slot:${i}b,id:"minecraft:${id}",count:${n}}`).join(',')}]}`
    const set = (p: P, nbt: string) => cmd(`/setblock ${p.x} ${p.y} ${p.z} minecraft:chest${nbt}`)
    await set(chests.pantry, items([['bread', 5], ['wheat_seeds', 35]]))
    await set(chests.storage, '')
    // the command line is too short for 27 stacks in one /setblock
    for (let i = 0; i < 27; i++) await cmd(`/item replace block ${chests.storage.x} ${chests.storage.y} ${chests.storage.z} container.${i} with minecraft:cobblestone 64`)
    await set(chests.gear, items([['red_bed', 1], ['shield', 1], ['iron_ingot', 9]]))
    // the configured chests: a new agent with the settings
    await bot.stop()
    bot = make()
    hook(bot)
    await connect(bot)
    while (!live(bot)) await pause(1000)
    await disarmAll()
    if (!atSpot()) throw new Error(`bot is at ${fmtPos(where())} after the restart; stopping`)
    // the pantry and the storage chest are known, the gear chest is not
    let r = await step('check_chests', { x: chests.pantry.x, y: chests.pantry.y, z: chests.pantry.z })
    r = await step('check_chests', { x: chests.storage.x, y: chests.storage.y, z: chests.storage.z })
    log(`known: ${knownContainers(bot, { includeUnknown: true }).map(c => `${fmtPos(c)} ${c.freshness}`).join('; ')}`)

    log('--- 2: keep_spawn_bed looks into the gear chest and fetches the bed')
    await step('behavior_arm', { name: 'keep_spawn_bed', options: { ask: false, graceSeconds: 2 } })
    await waitFor('a bed placed by home', 90_000, () => restoreList().some(([, , now]) => /_bed$/.test(now)))
    await step('behavior_disarm', { name: 'keep_spawn_bed' })
    const bed = restoreList().filter(([, , now]) => /_bed$/.test(now)).map(([k]) => k)
    const gearSeen = knownContainers(bot).find(c => c.x === chests!.gear.x && c.z === chests!.gear.z)
    results.push(`2 bed: placed at ${bed.join(', ') || 'nowhere'}; gear chest now ${gearSeen ? JSON.stringify(gearSeen.contents) : 'still unknown'}`)

    log('--- 3: gather_seeds takes seeds from the pantry (digging off)')
    const s0 = inv(bot).wheat_seeds ?? 0
    r = await step('gather_seeds', { count: 20 })
    results.push(`3 seeds: ${s0} -> ${inv(bot).wheat_seeds ?? 0}: ${r.message}`)

    log('--- 4: upgrade_tools with stone tools takes iron and the shield')
    for (const [id, n] of [['stone_pickaxe', 1], ['stone_sword', 1], ['stone_axe', 1], ['stone_shovel', 1], ['stick', 16], ['crafting_table', 1], ['bread', 8]] as [string, number][]) await cmd(`/give ${BOT} minecraft:${id} ${n}`)
    await pause(1500)
    r = await step('upgrade_tools', { up_to: 'iron', prospect: false })
    await pause(12_000) // gear_up from the reflexes
    const off = bot.bot.inventory.slots[45]?.name
    results.push(`4 tools: ${r.message}; offhand ${off ?? 'empty'}; iron items ${Object.keys(inv(bot)).filter(k => k.startsWith('iron_')).join(', ') || 'none'}`)

    log('--- 5: deposit_when_full with junk: never the pantry, a new chest of its own')
    for (const [id, n] of [['snowball', 96], ['dirt', 320], ['gunpowder', 1], ['lead', 2], ['oak_sapling', 3], ['wheat_seeds', 40], ['spruce_planks', 40]] as [string, number][]) await cmd(`/give ${BOT} minecraft:${id} ${n}`)
    await pause(1500)
    const own0 = ownChests(bot).length
    await step('behavior_arm', { name: 'deposit_when_full', options: { threshold: 0.3 } })
    await waitFor('the junk stored', 120_000, () => !(inv(bot).snowball ?? 0) && !(inv(bot).dirt ?? 0))
    await step('behavior_disarm', { name: 'deposit_when_full' })
    await step('check_chests', { all: true, max: 6 })
    const k = knownContainers(bot)
    const pantry = k.find(c => c.x === chests!.pantry.x && c.z === chests!.pantry.z)
    const mine = ownChests(bot).slice(own0).map(p => `${fmtPos(p)}: ${JSON.stringify(k.find(c => c.x === p.x && c.y === p.y && c.z === p.z)?.contents ?? {})}`)
    results.push(`5 deposit: pantry ${JSON.stringify(pantry?.contents)}; new own chests ${mine.join('; ') || 'none'}; left with ${JSON.stringify(inv(bot))}`)
  } catch (e) {
    log(`stopped: ${(e as Error).message}`)
    results.push(`stopped: ${(e as Error).message}`)
  } finally {
    await disarmAll().catch(() => {})
    try {
      // beds first (their other half drops otherwise), then the rest
      const changed = restoreList().sort((a, b) => Number(/_bed$/.test(b[2])) - Number(/_bed$/.test(a[2])))
      for (const [k, was, now] of changed) {
        await cmd(`/setblock ${k} minecraft:${was}`).catch(() => {})
        log(`set ${k} back from ${now} to ${was}`)
      }
      const left = restoreList()
      if (left.length) log(`still changed: ${left.map(([k, w, n]) => `${k} ${w}->${n}`).join('; ')}`)
    } catch (e) { log(`restore failed: ${(e as Error).message}`) }
    if (homeAt) await cmd(`/execute positioned ${homeAt.x} ${homeAt.y} ${homeAt.z} run kill @e[type=item,distance=..16]`).catch(() => {})
    await cmd(`/clear ${BOT}`).catch(() => {})
    await release()
    await bot.stop().catch(() => {})
  }
  console.log('\nRESULTS')
  for (const r of results) console.log(`- ${r}`)
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
