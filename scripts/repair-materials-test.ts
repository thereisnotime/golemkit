// Live test of the material sources and floor holes: a test bot (MatTest, no brains, digging off)
// with a base set far from everything (settings projects.base, nothing built). The director
// (ClaudeTest, an op) puts a chest with cobblestone inside the base (the bot only knows it is its
// chest, not what is in it) and digs a hole two deep in the floor surface. The bot runs
// gather_materials for cobblestone (it must take it from the chest and say why digging was
// skipped), then check_base (the hole must be listed) and secure_base (the hole must be filled).
//   node scripts/repair-materials-test.ts [--start x,z]
//   node scripts/repair-materials-test.ts --cleanup      finish the clean-up of a broken run
// Nothing changes the time or gamerules. Every block the director changed and every block that
// changed near the bot is put back afterwards; dropped items are killed, the bot cleared.
// Wrap it in the bench lock: flock .worktrees/.bench.lock node scripts/repair-materials-test.ts
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Agent, defineVariant, serverFromEnv } from '../src/core/index.ts'
import { standardSkills, extendedSkills, navigation, setHome } from '../src/skills/index.ts'
import { addOwnChest } from '../src/skills/containers.ts'
import { KEEP_AWAY, TEST_AREAS, tooClose } from './survival-stats.ts'

const argv = process.argv.slice(2)
const opt = (name: string, def: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : def }
const [SX, SZ] = opt('start', '2300,-1500').split(',').map(Number) as [number, number]
const MINUTES = 6
const BOT = process.env.MATERIALS_BOT || 'MatTest'
const DIRECTOR = process.env.DIRECTOR || 'ClaudeTest'
const DATA = 'data/repair-materials-test'
const PENDING = join(DATA, 'pending-cleanup.json')
const KIT = ['bread 8']
const server = serverFromEnv()
const t0 = Date.now()
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`)
const pause = (ms: number) => new Promise(r => setTimeout(r, ms))

interface P { x: number, y: number, z: number }
interface Pending { bot: string, worldSpawn: [number, number, number] | null, changed: Record<string, string> }

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
  const cmd = async (c: string) => { const ok = await agent.command(c); if (!ok) log(`command refused: ${c}`); await pause(200) }
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

const blockName = (a: Agent, p: P) => a.bot.blockAt(a.bot.entity.position.clone().set(p.x, p.y, p.z))?.name

/** Flat ground: a block column whose top is solid, natural, not water, with a few blocks of stone/dirt below. */
async function findGround (d: Director, x: number, z: number): Promise<P | null> {
  for (let tries = 0; tries < 15; tries++) {
    let unloaded = false
    for (let r = 0; r <= 32; r += 2) {
      for (let dx = -r; dx <= r; dx += 2) {
        for (let dz = -r; dz <= r; dz += 2) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
          let y = 250
          let name: string | undefined
          for (; y > -60; y--) {
            const b = d.agent.bot.blockAt(d.agent.bot.entity.position.clone().set(x + dx, y, z + dz))
            if (!b) { unloaded = true; break }
            if (/leaves|_log$|snow$/.test(b.name)) continue
            if (b.boundingBox === 'block' || /water|lava|ice/.test(b.name)) { name = b.name; break }
          }
          if (!name || !/^(grass_block|dirt|stone|snow_block|sand|coarse_dirt|podzol|andesite|diorite|granite|gravel|moss_block|mud|clay|terracotta|red_sand|sandstone|deepslate|tuff)$/.test(name)) continue
          return { x: x + dx, y, z: z + dz }
        }
      }
    }
    if (!unloaded) return null
    await pause(2000)
  }
  return null
}

function savePending (p: Pending): void { mkdirSync(DATA, { recursive: true }); writeFileSync(PENDING, JSON.stringify(p)) }

async function cleanUp (p: Pending): Promise<void> {
  const d = await director()
  try {
    await d.cmd(`/gamemode spectator ${DIRECTOR}`)
    const entries = Object.entries(p.changed).map(([k, name]) => { const [x, y, z] = k.split(',').map(Number) as [number, number, number]; return { x, y, z, name } })
    log(`clean-up: ${entries.length} blocks to put back`)
    if (entries.length) {
      const c = entries[0]!
      await d.cmd(`/tp ${DIRECTOR} ${c.x + 0.5} ${c.y + 25} ${c.z + 0.5}`)
      await pause(4000)
    }
    let restored = 0
    // bottom up so nothing hangs in the air while the rest goes back
    for (const e of entries.sort((a, b) => a.y - b.y)) {
      if (blockName(d.agent, e) === e.name) continue
      await d.cmd(`/setblock ${e.x} ${e.y} ${e.z} minecraft:${e.name}`)
      restored++
    }
    if (entries.length) {
      const c = entries[0]!
      await d.cmd(`/execute positioned ${c.x} ${c.y} ${c.z} run kill @e[type=item,distance=..40]`)
    }
    log(`clean-up: put back ${restored} blocks`)
    await d.cmd(`/clear ${p.bot}`)
    if (p.worldSpawn) await d.cmd(`/spawnpoint ${p.bot} ${p.worldSpawn.join(' ')}`)
    await d.cmd(`/gamemode creative ${DIRECTOR}`)
    rmSync(PENDING, { force: true })
  } finally {
    await d.stop()
  }
}

async function run (): Promise<void> {
  if (existsSync(PENDING)) { log('a clean-up is pending from an earlier run: doing it first'); await cleanUp(JSON.parse(readFileSync(PENDING, 'utf8'))) }
  const near = [...tooClose(SX, SZ, KEEP_AWAY), ...tooClose(SX, SZ, TEST_AREAS)]
  if (near.length) throw new Error(`start ${SX} ${SZ} too close to ${near.map(n => `${n.name} (${n.distance})`).join(', ')}`)
  const d = await director()
  const others = Object.values(d.agent.bot.players).filter((pl: any) => ![DIRECTOR, BOT].includes(pl.username))
  await d.cmd(`/gamemode spectator ${DIRECTOR}`)
  await d.cmd(`/tp ${DIRECTOR} ${SX + 0.5} 150 ${SZ + 0.5}`)
  await pause(5000)
  for (const pl of others as any[]) {
    const e = pl.entity
    if (e && Math.hypot(e.position.x - SX, e.position.z - SZ) < 300) { await d.stop(); throw new Error(`${pl.username} is within 300 blocks of the start`) }
  }
  const g = await findGround(d, SX, SZ)
  if (!g) {
    const col: string[] = []
    for (let y = 120; y > 40 && col.length < 4; y--) { const n = blockName(d.agent, { x: SX, y, z: SZ }); if (n && n !== 'air') col.push(`${y}:${n}`) }
    await d.stop()
    throw new Error(`no ground at the start (column: ${col.join(', ') || 'not loaded'}); try another --start`)
  }
  const o = { x: g.x, y: g.y, z: g.z } // the base origin: layer 0 (the floor) at ground level
  log(`base origin ${o.x} ${o.y} ${o.z} (${blockName(d.agent, o)})`)
  await d.cmd(`/tp ${DIRECTOR} ${o.x + 0.5} ${o.y + 25} ${o.z + 0.5}`)
  await pause(4000)

  const chest = { x: o.x - 2, y: o.y + 1, z: o.z - 3 }
  const hole: P[] = [{ x: o.x + 2, y: o.y, z: o.z + 2 }, { x: o.x + 2, y: o.y - 1, z: o.z + 2 }]
  const pending: Pending = { bot: BOT, worldSpawn: await spawnOf(d, BOT).catch(() => null), changed: {} }
  for (const p of [chest, ...hole, { x: chest.x, y: chest.y - 1, z: chest.z }]) { const n = blockName(d.agent, p); if (n) pending.changed[`${p.x},${p.y},${p.z}`] = n }
  savePending(pending)
  // the chest stands on solid ground, the hole goes two deep into the floor surface
  await d.cmd(`/setblock ${chest.x} ${chest.y - 1} ${chest.z} minecraft:stone`)
  await d.cmd(`/setblock ${chest.x} ${chest.y} ${chest.z} minecraft:chest{Items:[{Slot:0b,id:"minecraft:cobblestone",count:64}]}`)
  for (const p of hole) await d.cmd(`/setblock ${p.x} ${p.y} ${p.z} minecraft:air`)
  log(`chest at ${chest.x} ${chest.y} ${chest.z} with 64 cobblestone; hole at ${hole[0]!.x} ${hole[0]!.y} ${hole[0]!.z}, 2 deep`)

  const settings = { projects: { base: { x: o.x, y: o.y, z: o.z, facing: 'north' }, policy: 'off' }, baseSafety: {}, materials: {} }
  rmSync(join(DATA, 'bot'), { recursive: true, force: true })
  const bot = new Agent(defineVariant({ name: 'repair-materials-test', skills: [...standardSkills(), navigation(), ...extendedSkills()], brains: [] }), server, { username: BOT, dataDir: join(DATA, 'bot'), canDig: false, settings })
  await connect(bot)
  await d.cmd(`/gamemode survival ${BOT}`)
  await d.cmd(`/clear ${BOT}`)
  await d.cmd(`/tp ${BOT} ${o.x + 0.5} ${o.y + 1} ${o.z - 1 + 0.5}`)
  await d.cmd(`/spawnpoint ${BOT} ${o.x} ${o.y + 1} ${o.z - 1}`)
  await d.cmd(`/effect give ${BOT} minecraft:instant_health 1 10`)
  for (const k of KIT) { const [item, n] = k.split(' '); await d.cmd(`/give ${BOT} minecraft:${item} ${n ?? 1}`) }
  setHome(bot, { x: o.x, y: o.y + 1, z: o.z - 1, dimension: 'overworld' })
  addOwnChest(bot, chest)
  bot.bot.on('blockUpdate', (old: any, now: any) => {
    if (!old || !now || old.name === now.name) return
    const p = now.position
    if (Math.hypot(p.x - o.x, p.z - o.z) > 20) return
    const k = `${p.x},${p.y},${p.z}`
    if (!(k in pending.changed)) { pending.changed[k] = old.name; savePending(pending) }
  })
  await pause(4000)

  const sys = { caller: { kind: 'system' as const, name: 'repair-materials-test' }, priority: 0 }
  const results: string[] = []
  const t1 = Date.now()
  const g1 = await bot.act('gather_materials', { items: { cobblestone: 20 } }, sys)
  const cobble = bot.bot.inventory.items().filter((i: any) => i.name === 'cobblestone').reduce((a: number, i: any) => a + i.count, 0)
  log(`gather_materials (${Math.round((Date.now() - t1) / 1000)} s): ${g1.ok ? 'ok' : 'FAIL'} ${g1.message}`)
  results.push(`gather: ${g1.ok && cobble >= 20 && /chests gave 20 cobblestone/.test(g1.message) ? 'PASS' : 'FAIL'} (carries ${cobble})`)
  const c1 = await bot.act('check_base', {}, sys)
  log(`check_base: ${c1.ok ? 'ok' : 'FAIL'}\n${c1.message}`)
  results.push(`hole listed: ${/hole in the floor at/.test(c1.message) ? 'PASS' : 'FAIL'}`)
  const t2 = Date.now()
  const fix = await bot.act('secure_base', { minutes: MINUTES }, sys)
  log(`secure_base (${Math.round((Date.now() - t2) / 1000)} s): ${fix.ok ? 'ok' : 'FAIL'} ${fix.message}`)
  await pause(2000)
  const filled = hole.map(p => blockName(bot, p))
  results.push(`hole filled: ${filled.every(n => n && n !== 'air' && n !== 'cave_air') ? 'PASS' : 'FAIL'} (${filled.join(', ')})`)
  log(`status notes: ${JSON.stringify((bot as any).status?.snapshot?.()?.notes ?? null)}`)
  log(`results:\n  ${results.join('\n  ')}`)
  bot.storage.flush()
  await bot.stop().catch(() => {})
  await d.stop()
  await pause(3000)
  await cleanUp(pending)
}

setTimeout(() => { console.error('timeout'); process.exit(2) }, 20 * 60_000).unref()
const main = argv.includes('--cleanup') ? async () => { if (existsSync(PENDING)) await cleanUp(JSON.parse(readFileSync(PENDING, 'utf8'))) } : run
main().then(() => process.exit(0), e => { console.error(e); process.exit(1) })
