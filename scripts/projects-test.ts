// Live test of base projects: a fresh test bot (BuildTest, no LLM) with home set in an empty
// spot far from everything builds a base from scratch on its own (the outpost blueprint by
// default: walls with an ok from its owner, a reserved farm plot, stone floor, lighting, a chest
// row, a workshop, corner posts), driven only by the idle chore base_project.
//   node scripts/projects-test.ts [--start x,z] [--minutes 40] [--template outpost] [--ask-above 60]
//   node scripts/projects-test.ts --cleanup      finish the clean-up of a broken run
// DIRECTOR (ClaudeTest, an op) sets up and cleans up: survival mode, a kit, the bot teleported to
// the start with its spawnpoint there; BuildBoss, the bot's owner for the run, is parked in
// spectator above it and answers by whisper: "approve <project>" when asked, "projects" and
// "plan fortress" at the start, "pause building" / "resume building" once. Nothing changes the time
// or gamerules. Every block that changed within 7 blocks of the bot while it ran is recorded with
// what was there first, and the clean-up puts those back (placed blocks, dug terrain, mined
// stone), kills dropped items there, clears the bot and resets its spawnpoint.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Agent, defineVariant, serverFromEnv, type BotDefinition } from '../src/core/index.ts'
import { standardSkills, extendedSkills, navigation, setHome } from '../src/skills/index.ts'
import { reflexes, behaviorsBrain, intentsBrain } from '../src/brains/index.ts'
import { KEEP_AWAY, tooClose } from './survival-stats.ts'

const argv = process.argv.slice(2)
const opt = (name: string, def: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : def }
const [SX, SZ] = opt('start', '1900,1500').split(',').map(Number) as [number, number]
const MINUTES = Number(opt('minutes', '40'))
const TEMPLATE = opt('template', 'outpost')
const ASK_ABOVE = Number(opt('ask-above', '60'))
const BOT = process.env.PROJECTS_BOT || 'BuildTest'
const OWNER = process.env.PROJECTS_OWNER || 'BuildBoss'
const DIRECTOR = process.env.DIRECTOR || 'ClaudeTest'
const DATA = 'data/projects-test'
const PENDING = join(DATA, 'pending-cleanup.json')
const KIT = ['stone_pickaxe', 'stone_axe', 'stone_shovel', 'stone_sword', 'cobblestone 96', 'spruce_log 12', 'coal 6', 'bread 16']
const server = serverFromEnv()
const t0 = Date.now()
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`)
const pause = (ms: number) => new Promise(r => setTimeout(r, ms))

interface Pending { bot: string, start: { x: number, y: number, z: number }, worldSpawn: [number, number, number] | null, changed: Record<string, string> }

async function connect (agent: Agent, minutes = 10): Promise<void> {
  const ready = new Promise<boolean>(res => {
    const to = setTimeout(() => res(false), minutes * 60_000)
    agent.once('session', () => { clearTimeout(to); setTimeout(() => res(true), 3000) })
  })
  void agent.start().catch(() => {})
  if (!await ready) { await agent.stop().catch(() => {}); throw new Error(`${agent.username} could not connect in ${minutes} min`) }
}

interface Director { agent: Agent, cmd: (c: string) => Promise<void>, ask: (c: string, re: RegExp) => Promise<string | null>, stop: () => Promise<void> }

async function director (): Promise<Director> {
  const agent = new Agent(defineVariant({ name: 'director', skills: standardSkills(), brains: [] }), server, { username: DIRECTOR, dataDir: join(DATA, 'director') })
  const replies: string[] = []
  agent.on('session', () => { agent.bot.on('messagestr', (m: string) => { replies.push(m); if (replies.length > 100) replies.shift() }) })
  await connect(agent)
  const cmd = async (c: string) => { const ok = await agent.command(c); if (!ok) log(`command refused: ${c}`); await pause(250) }
  const ask = async (c: string, re: RegExp) => {
    replies.length = 0
    await cmd(c)
    for (let i = 0; i < 24; i++) { const hit = replies.find(r => re.test(r)); if (hit) return hit; await pause(250) }
    return null
  }
  return { agent, cmd, ask, stop: async () => { await agent.stop().catch(() => {}) } }
}

async function spawnOf (d: Director, name: string): Promise<[number, number, number] | null> {
  const out: number[] = []
  for (const k of ['SpawnX', 'SpawnY', 'SpawnZ']) {
    const line = await d.ask(`/data get entity ${name} ${k}`, new RegExp(`${name} has the following entity data|Found no elements`, 'i'))
    const m = line ? /data: (-?\d+)/.exec(line) : null
    if (!m) return null
    out.push(Number(m[1]))
  }
  return out as [number, number, number]
}

async function findSurface (d: Director, x: number, z: number): Promise<{ x: number, y: number, z: number } | null> {
  const bot = d.agent.bot
  const at = (bx: number, by: number, bz: number) => bot.blockAt(bot.entity.position.clone().set(bx, by, bz))
  for (let tries = 0; tries < 15; tries++) {
    let unloaded = false
    for (let r = 0; r <= 24; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
          let y = 250
          for (; y > -60; y--) {
            const b = at(x + dx, y, z + dz)
            if (!b) { unloaded = true; break }
            if (b.boundingBox === 'block' || /water|lava/.test(b.name)) break
          }
          const b = at(x + dx, y, z + dz)
          if (!b || /water|lava|leaves|log|ice/.test(b.name)) continue
          return { x: x + dx, y: y + 1, z: z + dz }
        }
      }
    }
    if (!unloaded) return null
    await pause(2000)
  }
  return null
}

/** The director account is shared with other live scripts: wait until it is offline. */
async function waitDirectorFree (watcher: Agent, maxMin = 60): Promise<void> {
  const until = Date.now() + maxMin * 60_000
  let said = false
  while (Date.now() < until) {
    if (!watcher.bot?.players?.[DIRECTOR]) {
      await pause(2000 + Math.random() * 6000)
      if (!watcher.bot?.players?.[DIRECTOR]) return
    }
    if (!said) { log(`${DIRECTOR} is online (another script?), waiting for it to leave`); said = true }
    await pause(15_000)
  }
  throw new Error(`${DIRECTOR} stayed online for ${maxMin} min`)
}

function savePending (p: Pending): void { mkdirSync(DATA, { recursive: true }); writeFileSync(PENDING, JSON.stringify(p)) }

async function cleanUp (p: Pending): Promise<void> {
  // the bot online (brainless) for /clear and /spawnpoint, and to wait for the director
  const watcher = new Agent(defineVariant({ name: 'projects-test-cleanup', skills: standardSkills(), brains: [] }), server, { username: p.bot, dataDir: join(DATA, 'watcher') })
  await connect(watcher)
  await waitDirectorFree(watcher)
  const d = await director()
  try {
    await d.cmd(`/gamemode spectator ${DIRECTOR}`)
    const entries = Object.entries(p.changed)
    log(`clean-up: ${entries.length} changed blocks to put back`)
    // by clusters of 32 so the chunks are loaded
    const groups = new Map<string, [number, number, number, string][]>()
    for (const [k, name] of entries) {
      const [x, y, z] = k.split(',').map(Number) as [number, number, number]
      const g = `${Math.floor(x / 32)},${Math.floor(z / 32)}`
      if (!groups.has(g)) groups.set(g, [])
      groups.get(g)!.push([x, y, z, name])
    }
    let restored = 0
    for (const list of groups.values()) {
      const [x0, y0, z0] = list[0]!
      await d.cmd(`/tp ${DIRECTOR} ${x0 + 0.5} ${y0 + 20} ${z0 + 0.5}`)
      await pause(2500)
      // top down for placed blocks (torches fall otherwise), bottom up for refills would also do: top down is fine with setblock
      for (const [x, y, z, name] of list.sort((a, b) => b[1] - a[1])) {
        const now = d.agent.bot.blockAt(d.agent.bot.entity.position.clone().set(x, y, z))?.name
        if (now === name) continue
        await d.cmd(`/setblock ${x} ${y} ${z} minecraft:${name}`)
        restored++
      }
      await d.cmd(`/execute positioned ${x0} ${y0} ${z0} run kill @e[type=item,distance=..40]`)
      await d.cmd(`/execute positioned ${x0} ${y0} ${z0} run kill @e[type=experience_orb,distance=..40]`)
    }
    log(`clean-up: put back ${restored} blocks`)
    await d.cmd(`/clear ${p.bot}`)
    await d.cmd(`/effect clear ${p.bot}`)
    if (p.worldSpawn) await d.cmd(`/spawnpoint ${p.bot} ${p.worldSpawn.join(' ')}`)
    await d.cmd(`/gamemode creative ${DIRECTOR}`)
    rmSync(PENDING, { force: true })
  } finally {
    await d.stop()
    await watcher.stop().catch(() => {})
  }
}

async function run (): Promise<void> {
  if (existsSync(PENDING)) { log('a clean-up is pending from an earlier run: doing it first'); await cleanUp(JSON.parse(readFileSync(PENDING, 'utf8'))) }
  const near = tooClose(SX, SZ, KEEP_AWAY)
  if (near.length) throw new Error(`start ${SX} ${SZ} too close to ${near.map(n => `${n.name} (${n.distance})`).join(', ')}`)
  // the bot's account, brainless, for the setup; and to see whether another script has the director online
  const brainless = defineVariant({ name: 'projects-test-setup', skills: standardSkills(), brains: [] })
  const watcher = new Agent(brainless, server, { username: BOT, dataDir: join(DATA, 'watcher') })
  await connect(watcher)
  await waitDirectorFree(watcher)
  const d = await director()
  const others = Object.values(d.agent.bot.players).filter((pl: any) => ![DIRECTOR, BOT, OWNER].includes(pl.username))
  const worldSpawn = await spawnOf(d, BOT).catch(() => null)
  await d.cmd(`/gamemode spectator ${DIRECTOR}`)
  await d.cmd(`/tp ${DIRECTOR} ${SX + 0.5} 200 ${SZ + 0.5}`)
  await pause(4000)
  for (const pl of others as any[]) {
    const e = pl.entity
    if (e && Math.hypot(e.position.x - SX, e.position.z - SZ) < 300) throw new Error(`${pl.username} is within 300 blocks of the start`)
  }
  const start = await findSurface(d, SX, SZ)
  if (!start) { await d.stop(); throw new Error('no surface at the start') }
  log(`start ${start.x} ${start.y} ${start.z}`)
  const pending: Pending = { bot: BOT, start, worldSpawn, changed: {} }
  savePending(pending)

  // the bot, brainless first for the setup
  const def: BotDefinition = defineVariant({
    name: 'projects-test',
    skills: [...standardSkills(), navigation(), ...extendedSkills()],
    brains: [reflexes(), behaviorsBrain({ defaults: { keep_fed: true, stay_safe: true } }), intentsBrain()]
  })
  const settings = {
    idle: { mode: 'active', chores: { scout_nearby: false, explore: false, top_up_seeds: false, extend_farm: false, top_up_wood: false } },
    projects: { template: TEMPLATE, policy: 'auto', askAbove: ASK_ABOVE, askTimeoutMinutes: 5, onTimeout: 'wait', sessionMinutes: 8, gatherMinutes: 6 },
    intents: { mode: 'fallback' },
    inventoryMemory: { enabled: true, indexOwn: true },
    // keep_fed's farm start (seed trips) is left out so the run measures the projects; Pax has it on
    behaviors: { collect_drops: { radius: 12 }, keep_fed: { startFarm: false } }
  }
  await d.cmd(`/gamemode survival ${BOT}`)
  await d.cmd(`/clear ${BOT}`)
  await d.cmd(`/tp ${BOT} ${start.x + 0.5} ${start.y} ${start.z + 0.5}`)
  await d.cmd(`/effect give ${BOT} minecraft:instant_health 1 10`)
  await d.cmd(`/effect give ${BOT} minecraft:saturation 2 10`)
  await d.cmd(`/spawnpoint ${BOT} ${start.x} ${start.y} ${start.z}`)
  for (const k of KIT) { const [item, n] = k.split(' '); await d.cmd(`/give ${BOT} minecraft:${item} ${n ?? 1}`) }
  await pause(3000)
  await watcher.stop()
  await pause(3000)
  rmSync(join(DATA, 'bot'), { recursive: true, force: true })
  const bot = new Agent(def, server, { username: BOT, owners: [OWNER], dataDir: join(DATA, 'bot'), canDig: true, settings })
  await connect(bot)
  setHome(bot, { x: start.x, y: start.y, z: start.z, dimension: 'overworld' })

  // every block change near the bot, with what was there first
  const watch = (b: any) => {
    b.on('blockUpdate', (old: any, now: any) => {
      if (!old || !now || old.name === now.name) return
      const p = now.position
      if (Math.hypot(p.x - b.entity.position.x, p.y - b.entity.position.y, p.z - b.entity.position.z) > 7) return
      const k = `${p.x},${p.y},${p.z}`
      if (!(k in pending.changed)) { pending.changed[k] = old.name; savePending(pending) }
    })
  }
  watch(bot.bot)
  bot.on('session', b => { watch(b); log('bot reconnected') })

  const owner = new Agent(defineVariant({ name: 'owner', skills: standardSkills(), brains: [] }), server, { username: OWNER, dataDir: join(DATA, 'owner') })
  // listening before it is online: the first proposal comes as soon as it joins
  const said: string[] = []
  owner.on('chat', m => {
    if (m.from !== BOT) return
    said.push(m.message)
    log(`${BOT} -> ${m.whisper ? 'whisper' : 'chat'}: ${m.message}`)
    const ask = /Say "\S+ approve (\w+)"/.exec(m.message)
    if (ask) setTimeout(() => { log(`${OWNER}: approve ${ask[1]}`); owner.whisper(BOT, `approve ${ask[1]}`) }, 8000)
  })
  await connect(owner)
  await d.cmd(`/gamemode spectator ${OWNER}`)
  await d.cmd(`/tp ${OWNER} ${start.x + 0.5} ${start.y + 30} ${start.z + 0.5}`)
  await d.cmd(`/tp ${DIRECTOR} ${start.x + 0.5} ${start.y + 60} ${start.z + 0.5}`)
  await d.stop()

  bot.on('actionStart', i => { if (/work_on_base|light_up|build|gather/.test(i.name)) log(`start ${i.name} ${JSON.stringify(i.params)}`) })
  bot.on('actionEnd', (i, r) => { if (/work_on_base|light_up|project|plan_base/.test(i.name)) log(`end ${i.name}: ${r.ok ? 'ok' : 'FAIL'} ${r.message.slice(0, 400).replace(/\n/g, ' | ')}`) })

  await pause(5000)
  owner.whisper(BOT, 'projects')
  await pause(8000)
  owner.whisper(BOT, 'plan fortress')
  const until = Date.now() + MINUTES * 60_000
  let pausedOnce = false
  let lastLine = ''
  while (Date.now() < until) {
    await pause(15_000)
    const r = await bot.act('projects', {}, { caller: { kind: 'system', name: 'projects-test' }, priority: 0 }).catch(e => ({ ok: false, message: (e as Error).message }))
    const line = r.message.split('\n').slice(1).map(l => l.replace(/^\d+\. (\w+) \([^)]*\)/, '$1')).join('; ')
    if (line !== lastLine) { log(`queue: ${line}`); lastLine = line }
    const done = (n: string) => new RegExp(`${n}[^;]*: done`).test(line)
    if (!pausedOnce && done('walls')) {
      pausedOnce = true
      log(`${OWNER}: pause building`)
      owner.whisper(BOT, 'pause building')
      await pause(45_000)
      log(`${OWNER}: resume building`)
      owner.whisper(BOT, 'resume building')
    }
    if (['walls', 'floor', 'towers', 'lighting', 'storage', 'workshop'].every(done)) { log('all projects done'); break }
    try {
      const tod = bot.bot?.time?.timeOfDay
      if (tod !== undefined && Math.random() < 0.1) log(`time ${tod}, health ${bot.bot.health}, food ${bot.bot.food}, at ${JSON.stringify(bot.observe().position)}`)
    } catch { log('bot not connected') }
  }
  const plan = await bot.act('plan_base', {}, { caller: { kind: 'system', name: 'projects-test' }, priority: 0 }).catch(e => ({ ok: false, message: (e as Error).message }))
  log(`final plan:\n${plan.message}`)
  log(`journal-ish: ${JSON.stringify(bot.storage.get('projects.state'))}`)
  bot.storage.flush()
  await bot.stop().catch(() => {})
  await owner.stop().catch(() => {})
  log(`${Object.keys(pending.changed).length} block changes recorded; cleaning up`)
  await pause(3000)
  await cleanUp(pending)
}

setTimeout(() => { console.error('timeout'); process.exit(2) }, (MINUTES + 25) * 60_000).unref()
const main = argv.includes('--cleanup') ? async () => { if (existsSync(PENDING)) await cleanUp(JSON.parse(readFileSync(PENDING, 'utf8'))) } : run
main().then(() => process.exit(0), e => { console.error(e); process.exit(1) })
