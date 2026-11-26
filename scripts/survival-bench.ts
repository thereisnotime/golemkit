// Survival benchmark: a fresh test bot with a real profile's behaviours (Pax's by default, no LLM
// brain) left alone far from everything for N in-game days, and what happened to it measured.
//   node scripts/survival-bench.ts [--days 1] [--scenario forest|ice] [--start x,z] [--kit none|stone|iron]
//        [--repeats 1] [--profile pax] [--llm] [--tag run] [--terrain-note "text"] [--seed 1] [--spread 0]
//        [--stuck 5] [--minutes M] [--force] [--bad-farm]
//   node scripts/survival-bench.ts --survey "x,z x,z ..."           read-only look at candidate starts
//   node scripts/survival-bench.ts --compare <tagA> <tagB>     before/after table from results.jsonl
//   node scripts/survival-bench.ts --summary [tag]              table of past runs
//   node scripts/survival-bench.ts --cleanup                    finish the clean-up of a broken run
//
// DIRECTOR (default ClaudeTest, an op) only does the setup and the clean-up, and is offline in
// between (it waits while another script has the account online). It checks the start is 300+
// blocks from the world spawn, the fortress, the village and every online player, finds the
// surface near the start (the scenario's, or --start), measures the terrain there (biome, natural
// trees within 32, grass, nearest water, animals; written to the result as `terrain` and
// `terrainNote`), then with the bot online but brainless: survival mode, clears its
// inventory, full health and food, teleports it there, sets its spawnpoint there (deaths respawn
// at the start, not at world spawn), and gives --kit. SurviveOwner, a second test account, is the
// bot's owner for the run: parked in spectator mode 40 blocks above the start, so help asks and
// whispers reach it instead of public chat or the real owner. The bot then runs with a fresh data dir
// (no remembered places, trees or chests), home set at the start, for --days x 20 real minutes.
// Nothing changes the time or gamerules: the in-game time at start and end is recorded.
// Afterwards the director removes the blocks the bot placed (exact positions, noted as it placed
// them, only where that block is still there), kills dropped items at the start, at the death
// spots and at those blocks, clears the bot, puts its spawnpoint back to world spawn and disconnects.
// --bad-farm seeds the bot's memory with a farm (farm:1) on the ground under the start, so the ice
// scenario starts with a farm that is frozen over: site health should mark it bad and the bot should
// start a new one elsewhere (needs-and-idle). --kit stone with no ore in sight measures the gear search.
// One JSON line per run goes to data/survival-bench/results.jsonl, a table to stdout.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Agent, defineVariant, serverFromEnv, fmtPos, type ActionResult, type BotDefinition } from '../src/core/index.ts'
import { loadProfile } from '../src/core/profile.ts'
import { standardSkills, extendedSkills, navigation, modsSkill, setHome } from '../src/skills/index.ts'
import { isNaturalLeaves } from '../src/skills/woodcutting.ts'
import { farmWaterSurvey } from '../src/skills/food.ts'
import { heldCounts } from '../src/skills/gear.ts'
import { reflexes, behaviorsBrain, commandBrain } from '../src/brains/index.ts'
import {
  KEEP_AWAY, SCENARIOS, TEST_AREAS, aliveSeconds, countTrees, terrainNote, type Terrain, compareTable, gathered, isFoodName, parseResults, pathLength, startFor, stuckLoops, summaryTable,
  testSettings, tierName, tooClose, toolTier, vitals, type PosSample, type VitalSample
} from './survival-stats.ts'

// ---- arguments ----

const argv = process.argv.slice(2)
const flag = (name: string) => argv.includes(`--${name}`)
const opt = (name: string, def: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : def }
const DAYS = Number(opt('days', '1'))
const MINUTES = Number(opt('minutes', String(DAYS * 20)))
const SCENARIO = opt('scenario', argv.includes('--start') ? 'custom' : 'forest')
if (SCENARIO !== 'custom' && !SCENARIOS[SCENARIO]) throw new Error(`no scenario ${SCENARIO} (${Object.keys(SCENARIOS).join(', ')})`)
const [SX, SZ] = (argv.includes('--start') ? opt('start', '').split(',').map(Number) : SCENARIOS[SCENARIO]!.start) as [number, number]
const KIT = opt('kit', 'none') as 'none' | 'stone' | 'iron'
const REPEATS = Number(opt('repeats', '1'))
const PROFILE = opt('profile', 'pax')
const LLM = flag('llm')
const RUN_TAG = opt('tag', 'run')
const NOTE = opt('terrain-note', '')
const SEED = Number(opt('seed', '1'))
const SPREAD = Number(opt('spread', '0'))
const STUCK = Number(opt('stuck', '5'))
const BAD_FARM = flag('bad-farm')

const BOT = process.env.SURVIVAL_BOT || 'SurviveTest'
const DIRECTOR = process.env.DIRECTOR || 'ClaudeTest'
/** The bot's owner during the run: online (spectator, above the start) so help asks and whispers go to it, not to public chat. */
const OWNER = process.env.SURVIVAL_OWNER || 'SurviveOwner'
const DATA = process.env.SURVIVAL_BENCH_DIR || 'data/survival-bench'
const RESULTS = join(DATA, 'results.jsonl')
const PENDING = join(DATA, 'pending-cleanup.json')
const TAG = 'survivalbench'
const MIN_FROM_PLAYERS = 300
const server = serverFromEnv()
const t0 = Date.now()
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`)
const pause = (ms: number) => new Promise(r => setTimeout(r, ms))
let stopRequested = false

const KITS: Record<string, string[]> = {
  none: [],
  stone: ['stone_pickaxe', 'stone_axe', 'stone_sword', 'stone_shovel', 'bread 8'],
  iron: ['iron_pickaxe', 'iron_axe', 'iron_sword', 'iron_shovel', 'shield', 'iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots', 'bread 16']
}

// ---- agents ----

const brainless = defineVariant({ name: 'survival-bench-setup', skills: standardSkills(), brains: [] })

async function botDefinition (): Promise<{ def: BotDefinition, settings: Record<string, unknown>, canDig: boolean }> {
  const p = loadProfile(PROFILE, resolve(import.meta.dirname, '..', 'profiles'))
  if (!p) throw new Error(`no profile ${PROFILE}`)
  const settings = testSettings(p.options.settings ?? {}, LLM)
  if (LLM) {
    const file = resolve(import.meta.dirname, '..', 'variants', `${p.profile.variant}.ts`)
    const def = (await import(pathToFileURL(file).href)).default as BotDefinition
    return { def, settings, canDig: p.options.canDig ?? true }
  }
  // the profile's behaviours and settings without the LLM (and without intents or hooks)
  const def = defineVariant({
    name: 'survival-bench',
    skills: [...standardSkills(), navigation(), ...extendedSkills(), modsSkill()],
    brains: [commandBrain({ verbose: false, whisperNeedsPrefix: true }), reflexes(), behaviorsBrain({ defaults: { keep_fed: true, stay_safe: true } })]
  })
  return { def, settings, canDig: p.options.canDig ?? true }
}

async function connect (agent: Agent, minutes = 10): Promise<void> {
  const ready = new Promise<boolean>(res => {
    const to = setTimeout(() => res(false), minutes * 60_000)
    agent.once('session', () => { clearTimeout(to); setTimeout(() => res(true), 3000) })
  })
  void agent.start().catch(() => {})
  if (!await ready) { await agent.stop().catch(() => {}); throw new Error(`${agent.username} could not connect in ${minutes} min`) }
}
const live = (a: Agent | null) => { try { return !!a?.bot?.entity } catch { return false } }

/** The director account is shared with other live scripts: wait until it is offline (seen from `watcher`'s player list). */
async function waitDirectorFree (watcher: Agent, maxMin = 30): Promise<void> {
  const until = Date.now() + maxMin * 60_000
  let said = false
  while (Date.now() < until) {
    if (!watcher.bot?.players?.[DIRECTOR]) {
      // another script may be about to log in too: look again after a random pause
      await pause(2000 + Math.random() * 6000)
      if (!watcher.bot?.players?.[DIRECTOR]) return
    }
    if (!said) { log(`${DIRECTOR} is online (another script?), waiting for it to leave`); said = true }
    await pause(15_000)
  }
  throw new Error(`${DIRECTOR} stayed online for ${maxMin} min`)
}

interface Director { agent: Agent, cmd: (c: string) => Promise<void>, ask: (c: string, re: RegExp) => Promise<string | null>, stop: () => Promise<void> }

async function director (): Promise<Director> {
  const agent = new Agent(defineVariant({ name: 'director', skills: standardSkills(), brains: [] }), server, { username: DIRECTOR, dataDir: join(DATA, 'director') })
  const replies: string[] = []
  agent.on('session', () => {
    agent.bot.on('messagestr', (m: string) => {
      replies.push(m)
      if (replies.length > 100) replies.shift()
      if (/Unknown|Incorrect|Expected|Could not|^Unable/i.test(m)) log(`server: ${m}`)
    })
  })
  let lost = false
  let stopping = false
  agent.on('sessionEnd', reason => { lost = true; if (!stopping) log(`${DIRECTOR} lost its session: ${reason}`) })
  await connect(agent)
  // kicked (someone else logged in as the director): stop here; the pending clean-up stays for the next try
  const cmd = async (c: string) => {
    if (lost) throw new Error(`${DIRECTOR} was disconnected (another login?)`)
    const ok = await agent.command(c); if (!ok) log(`command refused: ${c}`); await pause(250)
  }
  const ask = async (c: string, re: RegExp) => {
    replies.length = 0
    await cmd(c)
    for (let i = 0; i < 24; i++) {
      const hit = replies.find(r => re.test(r))
      if (hit) return hit
      await pause(250)
    }
    return null
  }
  return { agent, cmd, ask, stop: async () => { stopping = true; await agent.stop().catch(() => {}) } }
}

const posRe = /\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/
async function playerPos (d: Director, name: string): Promise<{ x: number, y: number, z: number, dim: string } | null> {
  const line = await d.ask(`/data get entity ${name} Pos`, new RegExp(`${name} has the following entity data|No entity was found`, 'i'))
  const m = line ? posRe.exec(line) : null
  if (!m) return null
  const dimLine = await d.ask(`/data get entity ${name} Dimension`, new RegExp(`${name} has the following entity data`, 'i'))
  const dim = /"([^"]+)"/.exec(dimLine ?? '')?.[1] ?? 'minecraft:overworld'
  return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]), dim }
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

/** A dry, open surface block near x z: solid, not leaves/logs/fluid, with two free blocks above. Director must be there. */
async function findSurface (d: Director, x: number, z: number): Promise<{ x: number, y: number, z: number } | null> {
  const bot = d.agent.bot
  const at = (bx: number, by: number, bz: number) => bot.blockAt(bot.entity.position.clone().set(bx, by, bz))
  const column = (bx: number, bz: number): number | null | 'unloaded' => {
    for (let y = 250; y > -60; y--) {
      const b = at(bx, y, bz)
      if (!b) return 'unloaded'
      if (/water|lava/.test(b.name)) return null
      if (b.boundingBox !== 'block') continue // air, grass, flowers
      if (/leaves|log|_wood|vine|ice/.test(b.name)) return null
      const free = (c: any) => c && c.boundingBox !== 'block' && !/water|lava/.test(c.name)
      return free(at(bx, y + 1, bz)) && free(at(bx, y + 2, bz)) ? y : null
    }
    return null
  }
  for (let tries = 0; tries < 10; tries++) {
    let unloaded = false
    for (let r = 0; r <= 24; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
          const y = column(x + dx, z + dz)
          if (y === 'unloaded') { unloaded = true; continue }
          if (y !== null) return { x: x + dx, y: y + 1, z: z + dz }
        }
      }
    }
    if (!unloaded) return null
    await pause(2000)
  }
  return null
}

const ANIMALS = /^(cow|sheep|pig|chicken|rabbit|horse|donkey|goat|mooshroom|llama|camel)$/
const TREE_RADIUS = 32

/** Biome, natural trees within 32, grass blocks within 32, nearest open water and animals within `far` of the surface spot. Read-only. */
function measureTerrain (d: Director, s: { x: number, y: number, z: number }, far = 160): Terrain {
  const bot = d.agent.bot
  const v = (x: number, y: number, z: number) => bot.entity.position.clone().set(x, y, z)
  const point = v(s.x, s.y, s.z)
  const ids = (re: RegExp) => Object.values(bot.registry.blocksByName).filter((b: any) => re.test(b.name)).map((b: any) => b.id as number)
  const find = (re: RegExp, maxDistance: number, count: number) => bot.findBlocks({ matching: ids(re), maxDistance, count, point } as any)
  // block.biome.name is empty on servers that send their biome registry (prismarine-biome keeps the
  // registry's old array): look the id up in the bot's registry
  const bid = (bot.blockAt(v(s.x, s.y - 1, s.z)) as any)?.biome?.id
  const be = bid === undefined ? null : (bot.registry as any).biomes?.[bid]
  const biome = String(be?.name || '').replace(/^minecraft:/, '') || null
  const logs = find(/^(?!stripped_).+_log$/, TREE_RADIUS, 3000).map(p => {
    let leafy = false
    for (let dx = -1; dx <= 1 && !leafy; dx++) for (let dy = -1; dy <= 1 && !leafy; dy++) for (let dz = -1; dz <= 1 && !leafy; dz++) {
      const b = bot.blockAt(v(p.x + dx, p.y + dy, p.z + dz))
      if (b && isNaturalLeaves(b.name, b.getProperties() as Record<string, unknown>)) leafy = true
    }
    return { x: p.x, y: p.y, z: p.z, leafy }
  })
  const grass = find(/^grass_block$/, TREE_RADIUS, 5000).length
  // open water: a water block with air above, not a cave aquifer far below the start
  const water = find(/^water$/, far, 2000).filter(p => p.y >= s.y - 12 && /air$/.test(bot.blockAt(v(p.x, p.y + 1, p.z))?.name ?? ''))
  const waterAt = water.length ? Math.round(Math.min(...water.map(p => Math.hypot(p.x - s.x, p.z - s.z)))) : null
  const animals: Record<string, number> = {}
  for (const e of Object.values(bot.entities) as any[]) {
    if (!e?.name || !ANIMALS.test(e.name) || Math.hypot(e.position.x - s.x, e.position.z - s.z) > far) continue
    animals[e.name] = (animals[e.name] ?? 0) + 1
  }
  return { biome, trees: countTrees(logs), grass, waterAt, animals }
}

/** --survey: the director (spectator) looks at each candidate start and prints its terrain. Changes nothing in the world. */
async function survey (spots: [number, number][]): Promise<void> {
  const watcher = new Agent(brainless, server, { username: BOT, dataDir: join(DATA, 'watcher') })
  await connect(watcher)
  await waitDirectorFree(watcher)
  const d = await director()
  const from = d.agent.bot.entity.position.clone()
  const mode = d.agent.bot.game.gameMode
  try {
    const players: { name: string, x: number, z: number }[] = []
    for (const name of Object.keys(d.agent.bot.players)) {
      if (name === DIRECTOR || name === BOT || name === OWNER) continue
      const p = await playerPos(d, name)
      if (p && /overworld/.test(p.dim)) players.push({ name, x: p.x, z: p.z })
    }
    log(`players online: ${players.map(p => `${p.name} at ${Math.round(p.x)} ${Math.round(p.z)}`).join(', ') || 'none in the overworld'}`)
    await d.cmd(`/gamemode spectator ${DIRECTOR}`)
    for (const [x, z] of spots) {
      // a read-only look: the bench's own test areas are fine to look at, the rest is kept away from
      const near = [...tooClose(x, z, KEEP_AWAY), ...tooClose(x, z, players.map(p => [p.name, p.x, p.z] as [string, number, number]))]
      if (near.length) { log(`${x} ${z}: skipped, ${near.map(n => `${n.distance} from ${n.name}`).join(', ')}`); continue }
      await d.cmd(`/tp ${DIRECTOR} ${x + 0.5} 180 ${z + 0.5}`)
      await pause(8000)
      const s = await findSurface(d, x, z)
      if (!s) { log(`${x} ${z}: no dry open surface within 24`); continue }
      await pause(2000)
      log(`${x} ${z}: surface ${fmtPos(s)}: ${terrainNote(measureTerrain(d, s), TREE_RADIUS)}`)
      log(`${x} ${z}: farm water within 96: ${farmWaterSurvey(d.agent, d.agent.bot, s)}`)
    }
  } finally {
    await d.cmd(`/tp ${DIRECTOR} ${from.x} ${from.y} ${from.z}`).catch(() => {})
    await d.cmd(`/gamemode ${mode} ${DIRECTOR}`).catch(() => {})
    await pause(1000)
    await watcher.stop().catch(() => {})
    await d.stop()
  }
}

// ---- clean-up ----

interface Pending { bot: string, start: [number, number, number], placed: Record<string, string>, deaths: [number, number, number][], worldSpawn: [number, number, number] | null }
const savePending = (p: Pending) => { mkdirSync(DATA, { recursive: true }); writeFileSync(PENDING, JSON.stringify(p)) }

/** Removes what the bot placed (still there and unchanged), kills drops, clears and resets the bot. Returns what it couldn't clean. */
async function cleanUp (p: Pending): Promise<{ removed: number, gone: number, changed: string[], unloaded: number }> {
  log('clean-up: bot offline-safe, director on')
  const watcher = new Agent(brainless, server, { username: p.bot, dataDir: join(DATA, 'watcher') })
  await connect(watcher)
  await waitDirectorFree(watcher)
  const d = await director()
  let removed = 0; let gone = 0; let unloaded = 0
  const changed: string[] = []
  try {
    await d.cmd(`/gamemode spectator ${DIRECTOR}`)
    // placed blocks, grouped so the director visits each area once
    const groups = new Map<string, [string, string][]>()
    for (const [at, name] of Object.entries(p.placed)) {
      const [x, , z] = at.split(' ').map(Number) as [number, number, number]
      const k = `${Math.floor(x / 32)},${Math.floor(z / 32)}`
      groups.set(k, [...(groups.get(k) ?? []), [at, name]])
    }
    const visits: [number, number, number][] = [p.start, ...p.deaths]
    for (const blocks of groups.values()) {
      const [x, y, z] = blocks[0]![0].split(' ').map(Number) as [number, number, number]
      visits.push([x, y, z])
      await d.cmd(`/tp ${DIRECTOR} ${x + 0.5} ${y + 20} ${z + 0.5}`)
      await pause(3000)
      for (const [at, name] of blocks) {
        const [bx, by, bz] = at.split(' ').map(Number) as [number, number, number]
        const b = d.agent.bot.blockAt(d.agent.bot.entity.position.clone().set(bx, by, bz))
        if (!b) { unloaded++; continue }
        // placed dirt that grew grass is still the bot's block
        if (b.name === name || (name === 'dirt' && /^(grass_block|podzol|mycelium)$/.test(b.name))) {
          await d.cmd(`/execute if block ${at} minecraft:${b.name} run setblock ${at} minecraft:air`); removed++
        } else if (/air$/.test(b.name)) gone++
        else changed.push(`${name}->${b.name}@${at}`)
      }
    }
    // drops: at the start, the death spots and the placed blocks (those blocks' items, the bot's death drops)
    for (const [x, y, z] of visits) {
      await d.cmd(`/tp ${DIRECTOR} ${x + 0.5} ${y + 20} ${z + 0.5}`)
      await pause(1500)
      await d.cmd(`/execute positioned ${x} ${y} ${z} run kill @e[type=item,distance=..24]`)
      await d.cmd(`/execute positioned ${x} ${y} ${z} run kill @e[type=experience_orb,distance=..24]`)
    }
    await d.cmd(`/kill @e[tag=${TAG}]`)
    await d.cmd(`/clear ${p.bot}`)
    await d.cmd(`/effect clear ${p.bot}`)
    if (p.worldSpawn) await d.cmd(`/spawnpoint ${p.bot} ${p.worldSpawn.join(' ')}`)
    await d.cmd(`/gamemode creative ${DIRECTOR}`)
    if (existsSync(PENDING)) rmSync(PENDING)
  } finally {
    await pause(1000)
    await watcher.stop().catch(() => {})
    await d.stop()
  }
  log(`clean-up: removed ${removed} placed blocks, ${gone} already gone, ${changed.length} changed (left), ${unloaded} not loaded`)
  return { removed, gone, changed, unloaded }
}

// ---- one run ----

async function runOnce (rep: number): Promise<Record<string, unknown>> {
  const { x: wantX, z: wantZ } = startFor(SX, SZ, rep, SEED, SPREAD)
  const near = tooClose(wantX, wantZ, KEEP_AWAY)
  if (near.length) throw new Error(`start ${wantX} ${wantZ} is ${near.map(n => `${n.distance} from the ${n.name}`).join(', ')}; pick one ${MIN_FROM_PLAYERS}+ away`)

  // the bot online without brains while it is set up, so it doesn't act before it is at the start
  const watcher = new Agent(brainless, server, { username: BOT, dataDir: join(DATA, 'watcher') })
  await connect(watcher)
  const owner = new Agent(brainless, server, { username: OWNER, dataDir: join(DATA, 'owner') })
  const heard: string[] = []
  owner.on('chat', m => { if (m.from === BOT) { heard.push(m.message); log(`${OWNER} heard${m.whisper ? ' (whisper)' : ''}: ${m.message}`) } })
  await connect(owner)
  await waitDirectorFree(watcher)
  let d = await director()
  let start: { x: number, y: number, z: number }
  let worldSpawn: [number, number, number] | null = null
  let terrain: Terrain | null = null
  try {
    // players: everyone online but the bench accounts must be 300+ blocks from the start
    const players: { name: string, distance: number | null }[] = []
    for (const name of Object.keys(d.agent.bot.players)) {
      if (name === DIRECTOR || name === BOT || name === OWNER) continue
      const p = await playerPos(d, name)
      const distance = p && /overworld/.test(p.dim) ? Math.round(Math.hypot(p.x - wantX, p.z - wantZ)) : null
      players.push({ name, distance })
    }
    log(`players online: ${players.map(p => `${p.name} ${p.distance ?? 'other dimension/unknown'}`).join(', ') || 'none'}`)
    const close = players.filter(p => p.distance !== null && p.distance < MIN_FROM_PLAYERS)
    if (close.length && !flag('force')) throw new Error(`players near the start: ${close.map(p => `${p.name} ${p.distance}`).join(', ')}`)

    const sp = (d.agent.bot as any).spawnPoint as { x: number, y: number, z: number } | undefined
    worldSpawn = sp ? [Math.floor(sp.x), Math.floor(sp.y), Math.floor(sp.z)] : [545, 70, 45]
    await d.cmd(`/gamemode spectator ${DIRECTOR}`)
    await d.cmd(`/tp ${DIRECTOR} ${wantX + 0.5} 200 ${wantZ + 0.5}`)
    await pause(5000)
    const s = await findSurface(d, wantX, wantZ)
    if (!s) throw new Error(`no dry open surface within 24 blocks of ${wantX} ${wantZ}`)
    start = s
    await pause(2000)
    terrain = measureTerrain(d, start)
    log(`start ${fmtPos(start)} (${SCENARIO}): ${terrainNote(terrain, TREE_RADIUS)}`)
    await d.cmd(`/gamemode survival ${BOT}`)
    await d.cmd(`/clear ${BOT}`)
    await d.cmd(`/effect clear ${BOT}`)
    await d.cmd(`/tp ${BOT} ${start.x + 0.5} ${start.y} ${start.z + 0.5}`)
    await d.cmd(`/effect give ${BOT} minecraft:instant_health 1 10`)
    await d.cmd(`/effect give ${BOT} minecraft:saturation 2 10`)
    await d.cmd(`/spawnpoint ${BOT} ${start.x} ${start.y} ${start.z}`)
    for (const k of KITS[KIT] ?? []) { const [item, n] = k.split(' '); await d.cmd(`/give ${BOT} minecraft:${item} ${n ?? 1}`) }
    await d.cmd(`/gamemode spectator ${OWNER}`)
    await d.cmd(`/tp ${OWNER} ${start.x + 0.5} ${start.y + 40} ${start.z + 0.5}`)
    await pause(3000)
    await d.cmd(`/tp ${DIRECTOR} ${start.x + 0.5} ${start.y + 60} ${start.z + 0.5}`)
  } catch (e) {
    await watcher.stop().catch(() => {})
    await owner.stop().catch(() => {})
    throw e
  } finally {
    await d.stop() // offline during the run: the account is shared
  }
  await watcher.stop().catch(() => {})
  await pause(3000)

  const pending: Pending = { bot: BOT, start: [start.x, start.y, start.z], placed: {}, deaths: [], worldSpawn }
  savePending(pending)

  // ---- the bot ----
  const runDir = join(DATA, 'runs', `${new Date().toISOString().replace(/[:.]/g, '-')}-${RUN_TAG}-${rep + 1}`)
  mkdirSync(runDir, { recursive: true })
  const { def, settings, canDig } = await botDefinition()
  const agent = new Agent(def, server, { username: BOT, dataDir: runDir, owners: [OWNER], canDig, settings })
  setHome(agent, { x: start.x, y: start.y, z: start.z })
  if (BAD_FARM) {
    // a remembered farm under the start: on ice it is frozen over from the first check
    agent.storage.set('farms', [{ name: 'farm:1', x: start.x, y: start.y - 1, z: start.z, size: 9, crop: 'wheat', created: Date.now() - 86_400_000, tended: Date.now() - 3_600_000 }])
    log(`seeded farm:1 at ${start.x} ${start.y - 1} ${start.z} (--bad-farm)`)
  }

  const vitalsS: VitalSample[] = []
  const path: PosSample[] = []
  const failures: { action: string, message: string, caller: string }[] = []
  const failuresBy: Record<string, number> = {}
  const deathsAt: number[] = []
  const respawnsAt: number[] = []
  const deathCauses: { cause: string, kind?: string, action?: string, atMin: number, pos?: string }[] = []
  const chatOut: { to?: string, message: string }[] = []
  const playersNear: Record<string, number> = {}
  const series: [number, number, number, number][] = []
  let tierMax = 0
  let life = 0
  let spawnMessage = false
  let minY = start.y
  let measuring = false
  let runStart = 0
  let kicks = 0
  let lastGameTime: { day: number, timeOfDay: number } | null = null
  let maxLagMs = 0

  agent.on('actionEnd', (info, r: ActionResult) => {
    if (!measuring || r.ok) return
    const key = `${info.caller.name}:${info.name}`
    failuresBy[key] = (failuresBy[key] ?? 0) + 1
    failures.push({ action: info.name, message: r.message, caller: info.caller.name })
  })
  agent.on('chatOut', m => { if (measuring) { chatOut.push(m); log(`${m.to ? `whisper to ${m.to}` : 'said'}: ${m.message}`) } })
  agent.on('sessionEnd', reason => { if (measuring) { kicks++; log(`bot disconnected: ${reason}`) } })
  agent.on('serverMessage', text => { if (/respawn point set/i.test(text)) { spawnMessage = true; log('respawn point set') } })
  agent.on('session', () => {
    const b = agent.bot
    b.on('death', () => {
      if (!measuring) return
      const at = Date.now()
      deathsAt.push(at)
      life++
      const p = b.entity?.position?.clone()
      if (p) pending.deaths.push([Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)])
      savePending(pending)
      setTimeout(() => {
        const rpt = agent.lastDeathReport && agent.lastDeathReport.at >= at - 2000 ? agent.lastDeathReport : null
        deathCauses.push({ cause: rpt?.cause ?? 'unknown', ...(rpt?.kind ? { kind: rpt.kind } : {}), ...(rpt?.action ? { action: rpt.action } : {}), atMin: Math.round((at - runStart) / 6000) / 10, ...(p ? { pos: fmtPos(p) } : {}) })
        log(`DIED: ${rpt?.summary ?? 'no report'}`)
      }, 5000)
    })
    b.on('spawn', () => { if (measuring && deathsAt.length > respawnsAt.length) respawnsAt.push(Date.now()) })
    // exact positions of blocks it places: a block appearing within 6 of it, right after it placed or used something
    let usedAt = 0
    for (const fn of ['placeBlock', 'activateBlock', 'activateItem'] as const) {
      const orig = (b as any)[fn]
      ;(b as any)[fn] = function (...args: unknown[]) { usedAt = Date.now(); const out = orig.apply(this, args); Promise.resolve(out).finally(() => { usedAt = Date.now() }).catch(() => {}); return out }
    }
    b.on('blockUpdate', (old: any, now: any) => {
      if (!measuring || !now || !b.entity || Date.now() - usedAt > 1500) return
      if (/air$/.test(now.name) || now.name === 'fire' || (old && !/air$|^short_grass$|^tall_grass$|^snow$|^water$|^fern$/.test(old.name))) return
      if (/^(water|lava)$/.test(now.name) && now.getProperties?.().level !== 0) return
      if (now.position.distanceTo(b.entity.position) > 6) return
      pending.placed[`${now.position.x} ${now.position.y} ${now.position.z}`] = now.name
    })
  })

  await connect(agent)
  for (let i = 0; i < 20 && !live(agent); i++) await pause(500)
  const timeOf = () => { try { return { day: agent.bot.time.day, timeOfDay: agent.bot.time.timeOfDay } } catch { return null } }
  const gameStart = timeOf()
  log(`measuring for ${MINUTES} real min (${DAYS} in-game day${DAYS === 1 ? '' : 's'}); game time ${JSON.stringify(gameStart)}; kit ${KIT}; profile ${PROFILE}${LLM ? ' with LLM' : ''}`)
  runStart = Date.now()
  measuring = true
  const until = runStart + MINUTES * 60_000
  let lastLog = 0
  let lastSeries = 0
  let lastSave = 0
  let tick = Date.now()
  while (Date.now() < until && !stopRequested) {
    await pause(2000)
    maxLagMs = Math.max(maxLagMs, Date.now() - tick - 2000) // event loop stalls (long pathfinding) show here
    tick = Date.now()
    try {
      if (!live(agent)) continue
      const b = agent.bot
      const now = Date.now()
      const alive = b.health > 0
      lastGameTime = timeOf() ?? lastGameTime
      vitalsS.push({ t: (now - runStart) / 1000, food: b.food, health: b.health, alive })
      const p = b.entity.position
      if (alive) { path.push({ x: p.x, z: p.z, life }); minY = Math.min(minY, Math.floor(p.y)) }
      tierMax = Math.max(tierMax, toolTier(b.inventory.items().map((i: any) => i.name)))
      for (const [name, pl] of Object.entries(b.players as Record<string, any>)) {
        if (name === BOT || name === DIRECTOR || name === OWNER || !pl.entity) continue
        const dist = Math.round(pl.entity.position.distanceTo(p))
        playersNear[name] = Math.min(playersNear[name] ?? Infinity, dist)
      }
      if (now - lastSeries >= 60_000) { lastSeries = now; series.push([Math.round((now - runStart) / 60_000), b.food, Math.round(b.health), tierMax]) }
      if (now - lastSave >= 30_000) { lastSave = now; savePending(pending) }
      if (now - lastLog >= 60_000) {
        lastLog = now
        const cur = agent.currentAction ? `${agent.currentAction.name} (${agent.currentAction.caller.name})` : 'idle'
        log(`at ${fmtPos(p)} hp ${Math.round(b.health)} food ${b.food} tier ${tierName(tierMax)} deaths ${deathsAt.length} fails ${failures.length} | ${cur}`)
      }
    } catch (e) { log(`loop: ${(e as Error).message}`) }
  }
  const runEnd = Date.now()
  const gameEnd = timeOf() ?? lastGameTime
  await pause(6000) // a death right at the end gets its report
  measuring = false
  savePending(pending)
  // what it ended with (worn armour and the offhand count) and the mines it dug (gear-progression)
  let endItems: Record<string, number> = {}
  try { endItems = heldCounts(agent.bot) } catch {}
  const mines = agent.storage.get<{ id: string, entrance: { x: number, y: number, z: number }, deepest: number, branches: number, trips: number, got: Record<string, number> }[]>('mines', [])
    .map(m => `${m.id} at ${m.entrance.x} ${m.entrance.y} ${m.entrance.z} to y ${m.deepest}, ${m.branches} branches, ${m.trips} trips, got ${JSON.stringify(m.got)}`)
  await agent.stop().catch(() => {})
  await owner.stop().catch(() => {})
  await pause(3000)

  // the journal: what it gathered, its own death records and placed counts
  const events: any[] = []
  for (const f of agent.journal.rawDays()) events.push(...agent.journal.readDay(f))
  const inRun = events.filter(e => e.ts >= runStart && e.ts <= runEnd + 6000)
  const gains = inRun.filter(e => e.type === 'item_gained').map(e => e.data.items as Record<string, number>)
  const placedJournal = inRun.filter(e => e.type === 'block_placed').reduce((a, e) => a + (e.data.count ?? 0), 0)
  const broken: Record<string, number> = {}
  for (const e of inRun.filter(e => e.type === 'block_broken')) for (const [n, c] of Object.entries(e.data.blocks as Record<string, number>)) broken[n] = (broken[n] ?? 0) + c
  const journalDeaths = inRun.filter(e => e.type === 'death')
  // help asks (npc askHelp, keep_fed when starving): recorded whether or not an owner was online to get them
  // needs-and-idle: sites marked bad or fine again, need searches and the idle chores that ran
  // from the journal over the whole session: the first site checks run before the measuring starts
  const sites = events.filter(e => e.type === 'site').map(e => `${e.data.kind} ${e.data.id} ${e.data.status}${e.data.reason ? `: ${e.data.reason}` : ''}`.slice(0, 160))
  const searches = agent.storage.get<{ need: string, at: number, ok: boolean, message: string }[]>('needs.searches', []).filter(x => x.at >= runStart).map(x => `${x.need} ${x.ok ? 'ok' : 'failed'}: ${x.message}`.slice(0, 200))
  const choresRun = Object.keys(agent.storage.get<Record<string, number>>('needs.choresRun', {}))
  const farmsAtEnd = agent.storage.get<{ name: string, x: number, z: number }[]>('farms', []).map(f => `${f.name} ${f.x} ${f.z}`)
  const helpAsks = inRun.filter(e => e.type === 'help' && e.data.status !== 'sorted').map(e => `${e.data.behavior ?? '?'}: ${e.data.reason ?? e.data.text ?? ''}`.slice(0, 160))
  for (let i = 0; i < deathCauses.length; i++) if (deathCauses[i]!.cause === 'unknown' && journalDeaths[i]?.data.cause) deathCauses[i]!.cause = journalDeaths[i].data.cause

  // spawn point and clean-up (the director comes back)
  let spawnNow: [number, number, number] | null = null
  {
    const w = new Agent(brainless, server, { username: BOT, dataDir: join(DATA, 'watcher') })
    await connect(w)
    await waitDirectorFree(w)
    d = await director()
    try { spawnNow = await spawnOf(d, BOT) } finally { await d.stop(); await w.stop().catch(() => {}) }
    await pause(3000)
  }
  const spawnSet = spawnMessage || (spawnNow !== null && (spawnNow[0] !== start.x || spawnNow[1] !== start.y || spawnNow[2] !== start.z))
  const clean = await cleanUp(pending)

  const v = vitals(vitalsS, (runEnd - runStart) / 1000)
  const loops = stuckLoops(failures, STUCK)
  const whispers = chatOut.filter(m => m.to)
  const result = {
    tag: RUN_TAG, repeat: rep + 1, at: new Date(runStart).toISOString(), start: [start.x, start.y, start.z], profile: PROFILE, llm: LLM, kit: KIT,
    days: DAYS, realMinutes: Math.round((runEnd - runStart) / 6000) / 10, seed: SEED, spread: SPREAD, scenario: SCENARIO,
    terrainNote: NOTE || (terrain ? terrainNote(terrain, TREE_RADIUS) : ''), terrain, gameStart, gameEnd,
    deaths: deathsAt.length, deathCauses, aliveS: aliveSeconds(runStart, runEnd, deathsAt, respawnsAt),
    firstDeathS: deathsAt.length ? Math.round((deathsAt[0]! - runStart) / 1000) : null,
    ...v, toolTierMax: tierMax, toolTier: tierName(tierMax), gathered: gathered(gains, isFoodName), spawnSet, spawnPoint: spawnNow,
    failures: failures.length, failuresBy, stuckLoops: loops,
    distance: Math.round(pathLength(path)), maxFromStart: Math.round(Math.max(0, ...path.map(p => Math.hypot(p.x - start.x, p.z - start.z)))), minY,
    disconnects: kicks, maxLagS: Math.round(maxLagMs / 100) / 10,
    helpAsks: helpAsks.length, helpReasons: helpAsks.slice(0, 10),
    badFarm: BAD_FARM, sites, searches, choresRun, farmsAtEnd, endItems, mines,
    ownerHeard: heard.length,
    whispers: whispers.length, chatLines: chatOut.length - whispers.length, said: chatOut.slice(0, 20).map(m => (m.to ? `(w ${m.to}) ` : '') + m.message),
    playersNear: Object.fromEntries(Object.entries(playersNear).filter(([, dist]) => dist < 200)),
    placed: Object.keys(pending.placed).length, placedJournal, removed: clean.removed, placedGone: clean.gone, notRemoved: clean.changed,
    broken, series, runDir
  }
  appendFileSync(RESULTS, JSON.stringify(result) + '\n')
  log(`RESULT ${JSON.stringify({ ...result, series: undefined })}`)
  const left = [
    clean.changed.length ? `${clean.changed.length} placed blocks changed since (left in place): ${clean.changed.slice(0, 8).join(', ')}` : '',
    clean.unloaded ? `${clean.unloaded} placed blocks not loaded (not checked)` : '',
    Object.keys(broken).length ? `blocks it broke stay broken (felled trees, dug ground): ${Object.entries(broken).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([n, c]) => `${n} ${c}`).join(', ')}` : '',
    placedJournal > Object.keys(pending.placed).length ? `the journal counted ${placedJournal} placed blocks, ${Object.keys(pending.placed).length} positions were noted: ${placedJournal - Object.keys(pending.placed).length} may be left` : ''
  ].filter(Boolean)
  if (left.length) console.log('\nnot cleaned:\n  ' + left.join('\n  '))
  return result
}

async function main (): Promise<void> {
  mkdirSync(DATA, { recursive: true })
  const cmpAt = argv.indexOf('--compare')
  if (cmpAt >= 0) {
    const [a, b] = [argv[cmpAt + 1], argv[cmpAt + 2]]
    if (!a || !b) throw new Error('usage: --compare <tagA> <tagB>')
    const rows = existsSync(RESULTS) ? parseResults(readFileSync(RESULTS, 'utf8')) : []
    console.log(compareTable(rows, a, b))
    return
  }
  if (flag('summary')) {
    const tag = opt('summary', '')
    const rows = (existsSync(RESULTS) ? parseResults(readFileSync(RESULTS, 'utf8')) : []).filter(r => !tag || tag.startsWith('--') || r.tag === tag)
    console.log(summaryTable(rows))
    return
  }
  if (flag('survey')) {
    await survey(opt('survey', '').trim().split(/\s+/).filter(Boolean).map(p => p.split(',').map(Number) as [number, number]))
    return
  }
  if (flag('cleanup')) {
    if (!existsSync(PENDING)) { log('nothing pending'); return }
    await cleanUp(JSON.parse(readFileSync(PENDING, 'utf8')) as Pending)
    return
  }
  if (existsSync(PENDING)) {
    log(`a previous run was not cleaned up (${PENDING}): cleaning it first`)
    await cleanUp(JSON.parse(readFileSync(PENDING, 'utf8')) as Pending)
  }
  process.on('SIGINT', () => { if (stopRequested) process.exit(130); stopRequested = true; log('stopping: finishing this run and cleaning up (Ctrl-C again to quit now)') })
  process.on('SIGTERM', () => { stopRequested = true })
  const results: any[] = []
  for (let rep = 0; rep < REPEATS && !stopRequested; rep++) {
    log(`== run ${rep + 1}/${REPEATS}`)
    try {
      results.push(await runOnce(rep))
    } catch (e) {
      // the bot may have placed blocks before it broke: finish that clean-up, then report the error
      if (existsSync(PENDING)) await cleanUp(JSON.parse(readFileSync(PENDING, 'utf8')) as Pending).catch(err => log(`clean-up: ${(err as Error).message}`))
      throw e
    }
  }
  console.log('\n' + summaryTable(results))
}

if (process.argv[1]?.endsWith('survival-bench.ts')) main().then(() => process.exit(0), e => { console.error(e); process.exit(1) })
