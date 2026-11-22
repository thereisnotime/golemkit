// Controlled mob-wave benchmark for the bodyguard behaviour: how often a player standing still
// gets hit with the bodyguard armed, with follow_owner only, and with no bot at all.
//   node scripts/guard-bench.ts [x z] [--minutes 4] [--repeats 2] [--phases guard,follow,none]
//        [--seed 1] [--sword stone|iron] [--armour] [--tester-food 8] [--interval 30] [--cap 8]
//        [--time day|night] [--phantoms] [--tag run] [--scout] [--force]
// DIRECTOR (default ClaudeTest, an op) runs everything with commands: before every phase it sets
// the time, kills leftover tagged mobs, fills explosion holes in the arena floor, resets both
// players to full health and hunger, gives the same gear (GUARD_BOT: a sword, a shield, 16 bread,
// iron armour with --armour; GUARD_TESTER: bread only) and teleports them to the spot, the bot 3
// blocks east of the tester. It then summons a fixed, seeded schedule of tagged waves 8-14 blocks
// around the tester (2 zombies, a skeleton with a bow, a spider; a creeper every other wave; a
// phantom every third with --phantoms), one every --interval seconds while fewer than --cap mobs
// are alive. The tester stands still (no self-defence, eats). Phases: guard (bodyguard armed for
// the tester), follow (follow_owner only), none (the bot is offline: the baseline). The phase
// order flips on every repeat. A tester death is counted, the mobs alive are killed and the
// tester is reset on the spot. --time day (default) keeps natural spawns out; zombies and
// skeletons wear leather helmets so they don't burn, and spiders don't pick targets in daylight.
// --scout only checks the spot (flat, dry, solid) and robin's distance. Results append to
// data/guard-bench/results.jsonl; a summary table goes to stdout.
import { appendFileSync, mkdirSync } from 'node:fs'
import { Agent, defineVariant, serverFromEnv, PRIORITY, fmtPos, type ActionResult } from '../src/core/index.ts'
import { standardSkills, extendedSkills, navigation, pickup } from '../src/skills/index.ts'
import { reflexes, behaviorsBrain } from '../src/brains/index.ts'

// ---- arguments ----

const argv = process.argv.slice(2)
const flag = (name: string) => argv.includes(`--${name}`)
const opt = (name: string, def: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def }
const BOOL_FLAGS = ['--armour', '--phantoms', '--scout', '--force']
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && !BOOL_FLAGS.includes(argv[i - 1])))
const X = Number(positional[0] ?? 1250)
const Z = Number(positional[1] ?? 445)
const MINUTES = Number(opt('minutes', '4'))
const REPEATS = Number(opt('repeats', '2'))
const PHASES = opt('phases', 'guard,follow,none').split(',') as Phase[]
const SEED = Number(opt('seed', '1'))
const SWORD = opt('sword', 'iron')
const ARMOUR = flag('armour')
const TESTER_FOOD = Number(opt('tester-food', '8'))
const INTERVAL_S = Number(opt('interval', '30'))
const CAP = Number(opt('cap', '8'))
const TIME = opt('time', 'day')
const PHANTOMS = flag('phantoms')
const RUN_TAG = opt('tag', 'run')

type Phase = 'guard' | 'follow' | 'none'
const BOT = process.env.GUARD_BOT || 'GuardTest'
const TESTER = process.env.GUARD_TESTER || 'GuardTester'
const DIRECTOR = process.env.DIRECTOR || 'ClaudeTest'
const DATA = process.env.GUARD_BENCH_DIR || 'data/guard-bench'
const TAG = 'guardbench'
const WAVE_MOBS = new Set(['zombie', 'skeleton', 'spider', 'creeper', 'phantom'])
const KEEP_AWAY: [string, number, number][] = [['spawn', 545, 45], ['village', -2770, 1090], ['fortress', 560, -43]]
const server = serverFromEnv()
const t0 = Date.now()
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`)
const pause = (ms: number) => new Promise(r => setTimeout(r, ms))

// ---- the wave schedule (seeded, the same in every phase) ----

function mulberry32 (a: number): () => number {
  return () => {
    a |= 0; a = a + 0x6D2B79F5 | 0
    let t = Math.imul(a ^ a >>> 15, 1 | a)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

interface Spawn { mob: string, dx: number, dz: number }
export function waveSchedule (seed: number, count: number, phantoms: boolean): Spawn[][] {
  const rnd = mulberry32(seed)
  const out: Spawn[][] = []
  for (let w = 0; w < count; w++) {
    const mobs = ['zombie', 'zombie', 'skeleton', 'spider']
    if (w % 2 === 1) mobs.push('creeper')
    if (phantoms && w % 3 === 2) mobs.push('phantom')
    out.push(mobs.map(mob => {
      const a = rnd() * Math.PI * 2
      const r = 8 + rnd() * 6
      return { mob, dx: Math.round(Math.cos(a) * r * 10) / 10, dz: Math.round(Math.sin(a) * r * 10) / 10 }
    }))
  }
  return out
}

function summonNbt (mob: string): string {
  const helmet = '{},{},{},{id:"minecraft:leather_helmet",count:1}'
  // NBT on /summon skips the random spawn setup: no babies, no random gear, and no bow unless given
  if (mob === 'zombie') return `{Tags:["${TAG}"],PersistenceRequired:1b,ArmorItems:[${helmet}]}`
  if (mob === 'skeleton') return `{Tags:["${TAG}"],PersistenceRequired:1b,ArmorItems:[${helmet}],HandItems:[{id:"minecraft:bow",count:1},{}]}`
  return `{Tags:["${TAG}"],PersistenceRequired:1b}`
}

// ---- agents ----

const botVariant = defineVariant({
  name: 'guard-bench',
  skills: [...standardSkills(), navigation(), ...extendedSkills()],
  brains: [reflexes(), behaviorsBrain({ defaults: { stay_safe: { shelterUnprepared: false } }, autoHome: false })]
})
const testerVariant = defineVariant({
  name: 'guard-bench-tester',
  skills: [...standardSkills(), navigation(), pickup()],
  brains: [reflexes({ selfDefense: false, autoEat: true })]
})

const sys = { kind: 'system', name: 'guard-bench' } as const
async function step (agent: Agent, name: string, params: Record<string, unknown> = {}): Promise<ActionResult> {
  const r = await agent.act(name, params, { caller: sys, priority: PRIORITY.player })
  log(`${agent.username}: ${r.ok ? 'OK  ' : 'FAIL'} ${name} ${JSON.stringify(params)}: ${r.message}`)
  return r
}

/** Connects, retrying kicks (duplicate_login while someone else uses the account) and timeouts. */
async function connect (agent: Agent): Promise<void> {
  for (let i = 1; i <= 10; i++) {
    const ready = new Promise<boolean>(resolve => {
      const to = setTimeout(() => resolve(false), 60_000)
      agent.once('session', () => { clearTimeout(to); setTimeout(() => resolve(true), 4000) })
    })
    void agent.start().catch(() => {})
    if (await ready) return
    log(`${agent.username}: no session yet (try ${i}), retrying in 30 s`)
    await agent.stop().catch(() => {})
    await pause(30_000)
  }
  throw new Error(`${agent.username} could not connect`)
}

const live = (a: Agent) => { try { return !!a.bot?.entity } catch { return false } }
async function waitLive (a: Agent, ms = 60_000): Promise<boolean> {
  const until = Date.now() + ms
  while (!live(a) && Date.now() < until) await pause(500)
  return live(a)
}

function state (a: Agent): string {
  if (!live(a)) return 'offline'
  const b = a.bot
  const cur = a.currentAction ? `${a.currentAction.name} (${a.currentAction.caller.kind}:${a.currentAction.caller.name})` : 'idle'
  return `at ${fmtPos(b.entity.position)} hp ${Math.round(b.health)} food ${b.food} | ${cur} | held ${b.heldItem?.name ?? '-'} off ${b.inventory.slots[45]?.name ?? '-'}`
}

// ---- per-phase stats ----

interface Stats {
  hits: number, damage: number, testerDeaths: number, botDeaths: number, kills: Record<string, number>,
  explosionsNear: number, explosions: number, warnings: number, feeds: number, said: string[],
  waves: { at: number, mobs: number, firstHitMs: number | null }[], summoned: number, hitBy: Record<string, number>
}
const fresh = (): Stats => ({ hits: 0, damage: 0, testerDeaths: 0, botDeaths: 0, kills: {}, explosionsNear: 0, explosions: 0, warnings: 0, feeds: 0, said: [], waves: [], summoned: 0, hitBy: {} })

const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }

async function main (): Promise<void> {
  mkdirSync(DATA, { recursive: true })
  for (const [name, x, z] of KEEP_AWAY) {
    const d = Math.hypot(X - x, Z - z)
    if (d < 300) throw new Error(`the spot is ${Math.round(d)} blocks from the ${name}; pick one 300+ away`)
  }
  const dir = new Agent(defineVariant({ name: 'director', skills: standardSkills(), brains: [] }), server, { username: DIRECTOR, dataDir: `${DATA}/director` })
  const cmd = async (c: string) => { const ok = await dir.command(c); if (!ok) log(`command refused: ${c}`); await pause(250) }
  // server replies to the director (for /data get)
  const replies: string[] = []
  dir.on('session', () => {
    dir.bot.on('messagestr', (m: string) => {
      replies.push(m)
      if (replies.length > 50) replies.shift()
      if (/^Killed|^No entity|Unknown|Incorrect|Expected|Could not|^Unable|filled|^No blocks/i.test(m)) log(`server: ${m}`)
    })
  })

  await connect(dir)
  await waitLive(dir)
  log(`director: ${state(dir)}`)

  // where is robin? /data get prints "<name> has the following entity data: [x, y, z]"
  const robinDistance = async (): Promise<number | null> => {
    replies.length = 0
    await cmd('/data get entity robin Pos')
    for (let i = 0; i < 20; i++) {
      const line = replies.find(r => /robin has the following entity data|No entity was found|not found/i.test(r))
      if (line) {
        const m = /\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/.exec(line)
        if (!m) return null // offline
        return Math.hypot(Number(m[1]) - X, Number(m[3]) - Z)
      }
      await pause(250)
    }
    log('no answer to /data get robin; assuming offline')
    return null
  }
  const checkRobin = async () => {
    const d = await robinDistance()
    log(`robin: ${d === null ? 'offline' : `${Math.round(d)} blocks away`}`)
    if (d !== null && d < 200) throw new Error(`robin is ${Math.round(d)} blocks from the spot: aborting`)
  }
  await checkRobin()

  // ---- the spot: flat, dry, solid ----
  await cmd(`/gamemode creative ${DIRECTOR}`)
  await cmd(`/tp ${DIRECTOR} ${X + 0.5} 140 ${Z + 0.5}`)
  await pause(1500)
  try { (dir.bot as any).creative?.startFlying() } catch {}
  await pause(4000)
  const surface = (x: number, z: number): { y: number, name: string } | null => {
    for (let y = 130; y > -64; y--) {
      const b = dir.bot.blockAt(dir.bot.entity.position.clone().set(x, y, z))
      if (!b) return null
      if (b.boundingBox === 'block' || /water|lava/.test(b.name)) return { y, name: b.name }
    }
    return null
  }
  let heights: number[] = []
  const odd: string[] = []
  for (let tries = 0; tries < 10; tries++) {
    heights = []
    odd.length = 0
    for (let dx = -16; dx <= 16; dx++) {
      for (let dz = -16; dz <= 16; dz++) {
        const s = surface(X + dx, Z + dz)
        if (!s) continue
        heights.push(s.y)
        if (/water|lava|leaves|log/.test(s.name)) odd.push(`${s.name}@${dx},${dz}`)
      }
    }
    if (heights.length === 33 * 33) break
    await pause(2000) // chunks still loading
  }
  if (heights.length < 33 * 33) throw new Error(`couldn't read the arena (${heights.length} columns loaded)`)
  const counts = new Map<number, number>()
  for (const h of heights) counts.set(h, (counts.get(h) ?? 0) + 1)
  const G = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0] // the floor: the most common surface height
  const off = heights.filter(h => Math.abs(h - G) > 1).length
  log(`arena ${X} ${Z}: floor y ${G}, ${Math.round(counts.get(G)! / heights.length * 100)}% at floor level, ${off} columns off by 2+, heights ${Math.min(...heights)}..${Math.max(...heights)}${odd.length ? `, odd: ${odd.slice(0, 12).join(' ')}` : ''}`)
  // holes into caves inside the 14-block ring: look for air 1-6 below the floor
  let holes = 0
  for (let dx = -14; dx <= 14; dx++) for (let dz = -14; dz <= 14; dz++) for (let dy = 1; dy <= 6; dy++) { const b = dir.bot.blockAt(dir.bot.entity.position.clone().set(X + dx, G - dy, Z + dz)); if (b && /air$/.test(b.name)) holes++ }
  log(`air pockets 1-6 below the floor within 14: ${holes}`)
  const fair = odd.filter(o => /water|lava/.test(o)).length === 0 && off <= 20
  if (!fair && !flag('force')) throw new Error('the spot is not flat and dry enough (use --force to run anyway)')
  if (flag('scout')) { await dir.stop(); return }
  // out of the arena (creative: mobs ignore it), close enough to keep the chunks loaded
  const park = surface(X + 24, Z)
  await cmd(`/tp ${DIRECTOR} ${X + 24.5} ${(park?.y ?? G) + 1} ${Z + 0.5}`)

  // ---- bot and tester ----
  const bot = new Agent(botVariant, server, { username: BOT, dataDir: `${DATA}/agents`, canDig: true, owners: [TESTER] })
  const tester = new Agent(testerVariant, server, { username: TESTER, dataDir: `${DATA}/agents`, canDig: true })
  let st = fresh()
  let measuring = false
  let testerDied = false
  let botDied = false
  const spot = { x: X + 0.5, y: G + 1, z: Z + 0.5 }
  const toSpot = (p: { x: number, y: number, z: number }) => Math.hypot(p.x - spot.x, p.z - spot.z)
  let spotV: any = null // the spot as a Vec3, once the tester is in
  const lastWave = () => st.waves[st.waves.length - 1]

  bot.on('actionEnd', (info: any, r: ActionResult) => {
    if (info.caller?.name === 'guard-bench' || info.name === 'npc_interrupt') return
    if (measuring) log(`bot ${r.ok ? 'done' : 'FAIL'} ${info.name} (${info.caller.kind}:${info.caller.name}): ${r.message}`)
  })
  tester.on('session', () => {
    const b = tester.bot
    // a hit: damage with a source entity, or with a hostile within 5 (not hunger, not falls)
    b.on('entityHurt', (e: any, source: any) => {
      if (e !== b.entity || !measuring) return
      const near = Object.values(b.entities).filter((x: any) => x !== b.entity && x.position && x.type !== 'object' && x.type !== 'orb' && x.type !== 'player' && x.position.distanceTo(b.entity.position) < 8)
        .map((x: any) => `${x.name}@${x.position.distanceTo(b.entity.position).toFixed(1)}`).join(' ')
      const mobClose = Object.values(b.entities).some((x: any) => x !== b.entity && x.type === 'hostile' && x.position?.distanceTo(b.entity.position) < 5)
      if (!source && !mobClose) { log(`tester hurt without a mob (food ${b.food})`); return }
      st.hits++
      const by = source?.name ?? 'near'
      st.hitBy[by] = (st.hitBy[by] ?? 0) + 1
      const w = lastWave()
      if (w && w.firstHitMs === null) w.firstHitMs = Date.now() - w.at
      log(`TESTER HIT by ${source?.name ?? '?'} hp ${Math.round(b.health)} near: ${near || '-'} | bot: ${state(bot)}`)
    })
    let last = b.health
    b.on('health', () => {
      if (b.health < last && measuring) st.damage += last - b.health
      last = b.health
    })
    b.on('death', () => { if (measuring) { st.testerDeaths++; testerDied = true } log('TESTER DIED') })
    b.on('chat', (user: string, msg: string) => { if (user === BOT && measuring) { st.warnings++; st.said.push(msg); log(`CHAT <${user}> ${msg}`) } })
    b.on('whisper', (user: string, msg: string) => { if (user === BOT && measuring) { if (/tossed you|^here,/.test(msg)) st.feeds++; st.said.push(`(w) ${msg}`); log(`WHISPER <${user}> ${msg}`) } })
    // creeper (or any) explosions: within 6 of the tester, and anywhere in the arena
    ;(b as any)._client.on('explosion', (p: any) => {
      if (!measuring || !b.entity) return
      const d = Math.hypot(p.x - b.entity.position.x, p.y - b.entity.position.y, p.z - b.entity.position.z)
      if (toSpot(p) < 30) st.explosions++
      if (d <= 6) st.explosionsNear++
      log(`EXPLOSION ${d.toFixed(1)} from the tester`)
    })
  })
  bot.on('session', () => {
    const b = bot.bot
    const hitAt = new Map<number, number>()
    const orig = b.attack.bind(b)
    ;(b as any).attack = (e: any) => { hitAt.set(e.id, Date.now()); return orig(e) }
    b.on('entityDead', (e: any) => {
      const t = hitAt.get(e.id)
      if (measuring && t && Date.now() - t < 4000 && e !== b.entity && e.type !== 'player') { st.kills[e.name] = (st.kills[e.name] ?? 0) + 1; log(`KILL ${e.name}`) }
    })
    b.on('death', () => { if (measuring) { st.botDeaths++; botDied = true } log('BOT DIED') })
  })

  const killTagged = async () => {
    await cmd(`/kill @e[tag=${TAG}]`)
    await cmd(`/execute positioned ${spot.x} ${spot.y} ${spot.z} run kill @e[type=item,distance=..40]`)
    await cmd(`/execute positioned ${spot.x} ${spot.y} ${spot.z} run kill @e[type=arrow,distance=..40]`)
    await cmd(`/execute positioned ${spot.x} ${spot.y} ${spot.z} run kill @e[type=experience_orb,distance=..40]`)
  }
  const heal = async (p: string) => {
    await cmd(`/effect clear ${p}`)
    await cmd(`/effect give ${p} minecraft:instant_health 1 10`)
    await cmd(`/effect give ${p} minecraft:saturation 5 10`)
  }
  const gearBot = async () => {
    await cmd(`/clear ${BOT}`)
    await cmd(`/give ${BOT} minecraft:${SWORD}_sword 1`)
    await cmd(`/give ${BOT} minecraft:shield 1`)
    await cmd(`/give ${BOT} minecraft:bread 16`)
    if (ARMOUR) for (const p of ['helmet', 'chestplate', 'leggings', 'boots']) await cmd(`/give ${BOT} minecraft:iron_${p} 1`)
    await heal(BOT)
  }
  const gearTester = async () => {
    await cmd(`/clear ${TESTER}`)
    if (TESTER_FOOD > 0) await cmd(`/give ${TESTER} minecraft:bread ${TESTER_FOOD}`)
    await heal(TESTER)
  }
  // the tester faces north (yaw 180 in commands) so "behind you" warnings mean the same every phase
  const placeTester = () => cmd(`/tp ${TESTER} ${spot.x} ${spot.y} ${spot.z} 180 0`)
  const placeBot = () => cmd(`/tp ${BOT} ${spot.x + 3} ${spot.y} ${spot.z} 90 0`)
  const repairFloor = async () => {
    // creeper holes: fill air under the floor level with dirt, and remove pillars the bot left
    await cmd(`/fill ${X - 16} ${G - 4} ${Z - 16} ${X + 16} ${G} ${Z + 16} minecraft:dirt replace minecraft:air`)
    await cmd(`/fill ${X - 16} ${G + 1} ${Z - 16} ${X + 16} ${G + 8} ${Z + 16} minecraft:air replace minecraft:dirt`)
    await cmd(`/fill ${X - 16} ${G + 1} ${Z - 16} ${X + 16} ${G + 8} ${Z + 16} minecraft:air replace minecraft:cobblestone`)
    await cmd(`/fill ${X - 16} ${G + 1} ${Z - 16} ${X + 16} ${G + 3} ${Z + 16} minecraft:air replace minecraft:fire`)
  }
  const disarmAll = async () => {
    if (!live(bot)) return
    for (const name of ['bodyguard', 'follow_owner']) await step(bot, 'behavior_disarm', { name }).catch(() => null)
  }

  await connect(tester)
  await connect(bot)
  await waitLive(bot)
  await waitLive(tester)
  spotV = tester.bot.entity.position.clone().set(spot.x, spot.y, spot.z)
  await disarmAll()
  await cmd(`/gamemode survival ${BOT}`)
  await cmd(`/gamemode survival ${TESTER}`)
  log(`difficulty ${(tester.bot.game as any).difficulty ?? '?'}`)

  const schedule = waveSchedule(SEED, Math.ceil(MINUTES * 60 / INTERVAL_S) + 4, PHANTOMS)
  const results: any[] = []

  for (let rep = 0; rep < REPEATS; rep++) {
    const order = rep % 2 === 0 ? PHASES : [...PHASES].reverse()
    for (const phase of order) {
      // ---- reset ----
      await checkRobin()
      log(`== repeat ${rep + 1}, phase ${phase}: resetting`)
      measuring = false
      await cmd(`/time set ${TIME === 'night' ? 14000 : 1000}`)
      await killTagged()
      await repairFloor()
      if (phase === 'none') {
        if (live(bot)) { await disarmAll(); await cmd(`/clear ${BOT}`); await pause(1500) }
        await bot.stop().catch(() => {})
      } else if (!live(bot)) {
        await connect(bot)
        await waitLive(bot)
        await cmd(`/gamemode survival ${BOT}`)
      }
      if (!live(tester)) { await connect(tester); await waitLive(tester) }
      await gearTester()
      await placeTester()
      if (phase !== 'none') {
        await disarmAll()
        await gearBot()
        await placeBot()
      }
      await pause(4000) // land, put the gear on
      await killTagged()
      await heal(TESTER)
      if (phase !== 'none') {
        await heal(BOT)
        const r = await step(bot, 'behavior_arm', { name: phase === 'guard' ? 'bodyguard' : 'follow_owner', options: { player: TESTER } })
        if (!r.ok) throw new Error(`couldn't arm ${phase}: ${r.message}`)
      }
      await pause(2000)
      log(`tester ${state(tester)}`)
      const around = Object.values(tester.bot.entities).filter((e: any) => e.type !== 'player' && e.type !== 'object' && e.type !== 'orb' && e.position && e.position.distanceTo(spotV) < 32).map((e: any) => e.name)
      if (around.length) log(`already around the spot (untagged or not yet gone): ${around.join(' ')}`)
      if (phase !== 'none') log(`bot ${state(bot)}`)

      // ---- measure ----
      st = fresh()
      testerDied = false
      botDied = false
      measuring = true
      const start = Date.now()
      const until = start + MINUTES * 60_000
      let next = 0
      let lastLog = 0
      log(`measuring ${phase} for ${MINUTES} min`)
      while (Date.now() < until) {
        try {
          await pause(1000)
          if (!live(dir)) continue
          if (testerDied) {
            // count it, clear the mobs that did it, reset the tester on the spot
            testerDied = false
            await waitLive(tester)
            await pause(2500)
            await cmd(`/kill @e[tag=${TAG}]`)
            await gearTester()
            await placeTester()
            continue
          }
          if (botDied && phase !== 'none') {
            botDied = false
            await waitLive(bot)
            await pause(2500)
            await gearBot()
            await placeBot()
            continue
          }
          if (!live(tester)) continue
          const tp = tester.bot.entity.position
          const alive = Object.values(tester.bot.entities).filter((e: any) => WAVE_MOBS.has(e.name) && e.position && e.position.distanceTo(spotV) < 32).length // 3D: cave mobs below don't count
          const due = start + 5000 + next * INTERVAL_S * 1000
          if (Date.now() >= due && alive < CAP && next < schedule.length) {
            const wave = schedule[next++]
            st.waves.push({ at: Date.now(), mobs: wave.length, firstHitMs: null })
            for (const s of wave) {
              const sx = spot.x + s.dx
              const sz = spot.z + s.dz
              const sy = s.mob === 'phantom' ? spot.y + 12 : spot.y
              await cmd(`/summon minecraft:${s.mob} ${sx.toFixed(1)} ${sy} ${sz.toFixed(1)} ${summonNbt(s.mob)}`)
            }
            st.summoned += wave.length
            log(`wave ${next}: ${wave.map(s => s.mob).join(', ')} (${alive} alive)`)
          }
          // knocked off the spot: walk back (a respawn is teleported above)
          if (toSpot(tp) > 3 && !tester.currentAction) void step(tester, 'goto', { x: Math.floor(spot.x), y: spot.y, z: Math.floor(spot.z) })
          if (Date.now() - lastLog > 15_000) {
            lastLog = Date.now()
            log(`status: hits ${st.hits} deaths ${st.testerDeaths} alive ${alive} | tester hp ${Math.round(tester.bot.health)} food ${tester.bot.food} | bot ${phase === 'none' ? '-' : state(bot)}`)
          }
        } catch (e) { log(`loop: ${(e as Error).message}`) }
      }
      measuring = false
      const firsts = st.waves.map(w => w.firstHitMs).filter((x): x is number => x !== null)
      const result = {
        tag: RUN_TAG,
        phase,
        repeat: rep + 1,
        at: new Date().toISOString(),
        spot: [X, G + 1, Z],
        minutes: MINUTES,
        seed: SEED,
        time: TIME,
        sword: SWORD,
        armour: ARMOUR,
        waves: st.waves.length,
        summoned: st.summoned,
        testerHits: st.hits,
        testerDamage: Math.round(st.damage),
        testerDeaths: st.testerDeaths,
        hitBy: st.hitBy,
        botDeaths: st.botDeaths,
        kills: st.kills,
        killCount: Object.values(st.kills).reduce((a, b) => a + b, 0),
        explosionsNearTester: st.explosionsNear,
        explosions: st.explosions,
        wavesWithHit: firsts.length,
        firstHitMedianS: firsts.length ? Math.round(median(firsts)! / 100) / 10 : null,
        warnings: st.warnings,
        feeds: st.feeds,
        said: st.said.slice(0, 15)
      }
      log(`RESULT ${JSON.stringify(result)}`)
      appendFileSync(`${DATA}/results.jsonl`, JSON.stringify(result) + '\n')
      results.push(result)
      await disarmAll()
      await killTagged()
    }
  }

  // ---- summary ----
  printSummary(results)

  // ---- clean up ----
  await killTagged()
  await repairFloor()
  if (live(bot)) await disarmAll()
  await cmd(`/clear ${BOT}`)
  await cmd(`/clear ${TESTER}`)
  await cmd(`/effect clear ${BOT}`)
  await cmd(`/effect clear ${TESTER}`)
  await pause(1500)
  await bot.stop().catch(() => {})
  await tester.stop().catch(() => {})
  await dir.stop().catch(() => {})
}

export function printSummary (results: any[]): void {
  const row = (cells: (string | number)[]) => cells.map((c, i) => String(c).padStart(i === 0 ? 7 : 9)).join(' ')
  console.log('\n' + row(['phase', 'run', 'summoned', 'hits', 'damage', 'deaths', 'hits/10mob', 'firstHitS', 'botDeath', 'kills', 'boom@6', 'warns', 'feeds']))
  const phases = [...new Set(results.map(r => r.phase))]
  for (const p of phases) {
    const rs = results.filter(r => r.phase === p)
    for (const r of rs) console.log(row([p, r.repeat, r.summoned, r.testerHits, r.testerDamage, r.testerDeaths, (r.testerHits / Math.max(1, r.summoned) * 10).toFixed(1), r.firstHitMedianS ?? '-', r.botDeaths, r.killCount, r.explosionsNearTester, r.warnings, r.feeds]))
    const m = (k: string) => rs.reduce((a, r) => a + r[k], 0) / rs.length
    const sd = (k: string) => { const mu = m(k); return Math.sqrt(rs.reduce((a, r) => a + (r[k] - mu) ** 2, 0) / Math.max(1, rs.length - 1)) }
    console.log(row([p, 'mean', m('summoned').toFixed(1), `${m('testerHits').toFixed(1)}±${sd('testerHits').toFixed(1)}`, `${m('testerDamage').toFixed(0)}±${sd('testerDamage').toFixed(0)}`, m('testerDeaths').toFixed(1), (rs.reduce((a, r) => a + r.testerHits, 0) / Math.max(1, rs.reduce((a, r) => a + r.summoned, 0)) * 10).toFixed(1), '', m('botDeaths').toFixed(1), m('killCount').toFixed(1), m('explosionsNearTester').toFixed(1), m('warnings').toFixed(1), m('feeds').toFixed(1)]))
  }
}

if (process.argv[1]?.endsWith('guard-bench.ts')) main().then(() => process.exit(0), e => { console.error(e); process.exit(1) })
