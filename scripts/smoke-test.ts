// Live smoke test: the same short session every time, for before/after comparisons of refactors.
//   node --env-file=.env scripts/smoke-test.ts [x z] [--tag phase0]
// DIRECTOR (default ClaudeTest, an op) checks that the spot is 300+ blocks from spawn, the
// fortress, the village and MC_OWNER, clears and heals both players and teleports them to the
// spot (a spruce forest by default). Then SMOKE_BOT (default GuardTest, owned by SMOKE_TESTER,
// default GuardTester) runs: connect, follow (the tester walks off), chop (chop_tree without
// crafting an axe or replanting, so nothing is placed), find iron (find_target), bring planks
// (bring_item spruce_planks to the tester) and go home. Each step's ok/fail and message is
// printed and appended to data/smoke/results.jsonl; "same results" means the same ok/fail per
// step. Both players get Resistance V for the run (a dark forest spawns mobs and the bot has no
// reflexes here) and respawn at the spot; natural hostiles within 48 are removed before and after.
// At the end both inventories and effects are cleared, the spawn points go back to the world
// spawn and dropped items near the spot are removed.
import { appendFileSync, mkdirSync, rmSync } from 'node:fs'
import { Agent, defineVariant, serverFromEnv, PRIORITY, fmtPos, type ActionResult } from '../src/core/index.ts'
import { standardSkills, extendedSkills, navigation, pickup } from '../src/skills/index.ts'

const argv = process.argv.slice(2)
const opt = (name: string, def: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : def }
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1]!.startsWith('--')))
const X = Number(positional[0] ?? 1250)
const Z = Number(positional[1] ?? -300)
const TAG = opt('tag', 'run')
const BOT = process.env.SMOKE_BOT || 'GuardTest'
const TESTER = process.env.SMOKE_TESTER || 'GuardTester'
const DIRECTOR = process.env.DIRECTOR || 'ClaudeTest'
const AVOID = process.env.MC_OWNER || 'Robin'
const DATA = 'data/smoke'
/** Natural hostiles cleared around the spot before and after the run. */
const HOSTILE = ['zombie', 'skeleton', 'creeper', 'spider', 'stray', 'witch', 'zombie_villager', 'husk', 'drowned', 'phantom', 'slime', 'cave_spider']
const KEEP_AWAY: [string, number, number][] = [['spawn', 545, 45], ['village', -2770, 1090], ['fortress', 560, -43]]
const server = serverFromEnv()
const t0 = Date.now()
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`)
const pause = (ms: number) => new Promise(r => setTimeout(r, ms))

const botVariant = defineVariant({ name: 'smoke-bot', skills: [...standardSkills(), navigation(), ...extendedSkills()], brains: [] })
const testerVariant = defineVariant({ name: 'smoke-tester', skills: [...standardSkills(), navigation(), pickup()], brains: [] })

async function connect (agent: Agent, minutes = 5): Promise<void> {
  const ready = new Promise<boolean>(resolve => {
    const to = setTimeout(() => resolve(false), minutes * 60_000)
    agent.once('session', () => { clearTimeout(to); setTimeout(() => resolve(true), 4000) })
  })
  void agent.start().catch(() => {})
  if (!await ready) { await agent.stop().catch(() => {}); throw new Error(`${agent.username} could not connect in ${minutes} min`) }
}

const live = (a: Agent) => { try { return !!a.bot?.entity } catch { return false } }
const posOf = (a: Agent) => a.bot.entity.position
const dist = (a: Agent, b: Agent) => posOf(a).distanceTo(posOf(b))
const count = (a: Agent, re: RegExp) => a.bot.inventory.items().filter(i => re.test(i.name)).reduce((n, i) => n + i.count, 0)

interface Step { step: string, ok: boolean, message: string, seconds: number, extra?: Record<string, unknown> }

async function main (): Promise<void> {
  for (const [name, x, z] of KEEP_AWAY) {
    const d = Math.hypot(X - x, Z - z)
    if (d < 300) throw new Error(`the spot is ${Math.round(d)} blocks from the ${name}; pick one 300+ away`)
  }
  mkdirSync(DATA, { recursive: true })
  rmSync(`${DATA}/agents`, { recursive: true, force: true }) // fresh memory (places, home) every run
  const dir = new Agent(defineVariant({ name: 'director', skills: [], brains: [] }), server, { username: DIRECTOR, dataDir: `${DATA}/director` })
  const cmd = async (c: string) => { const ok = await dir.command(c); if (!ok) log(`command refused: ${c}`); await pause(300) }
  const replies: string[] = []
  dir.on('serverMessage', m => { replies.push(m); if (replies.length > 50) replies.shift() })
  await connect(dir)

  // the owner must be offline or 300+ away
  replies.length = 0
  await cmd(`/data get entity ${AVOID} Pos`)
  let ownerD: number | null = null
  for (let i = 0; i < 20; i++) {
    const line = replies.find(r => /has the following entity data|No entity was found/i.test(r))
    if (line) { const m = /\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/.exec(line); ownerD = m ? Math.hypot(Number(m[1]) - X, Number(m[3]) - Z) : null; break }
    await pause(250)
  }
  log(`${AVOID}: ${ownerD === null ? 'offline' : `${Math.round(ownerD)} blocks away`}`)
  if (ownerD !== null && ownerD < 300) throw new Error(`${AVOID} is ${Math.round(ownerD)} blocks from the spot`)

  // a standable spot near X Z: solid ground (not leaves or logs) with two air blocks above
  await cmd(`/gamemode creative ${DIRECTOR}`)
  await cmd(`/tp ${DIRECTOR} ${X + 0.5} 150 ${Z + 0.5}`)
  await pause(1500)
  try { (dir.bot as any).creative?.startFlying() } catch {}
  await pause(6000)
  const at = (x: number, y: number, z: number) => dir.bot.blockAt(dir.bot.entity.position.clone().set(x, y, z))
  const ground = (x: number, z: number): number | null => {
    for (let y = 140; y > 40; y--) {
      const b = at(x, y, z)
      if (!b) return null
      if (b.boundingBox !== 'block' && !/water|lava/.test(b.name)) continue
      if (/leaves|_log/.test(b.name)) continue
      if (/water|lava/.test(b.name)) return null
      const free = (n?: string) => n === 'air' || n === 'cave_air' || n === 'short_grass' || n === 'fern'
      return free(at(x, y + 1, z)?.name) && free(at(x, y + 2, z)?.name) ? y : null
    }
    return null
  }
  let spot: { x: number, y: number, z: number } | null = null
  for (let i = 0; i < 10 && !at(X, 60, Z); i++) await pause(2000) // chunks still loading
  for (let r = 0; r <= 12 && !spot; r++) {
    for (let dx = -r; dx <= r && !spot; dx++) {
      for (const dz of [-r, r]) {
        const g = ground(X + dx, Z + dz)
        const g2 = g !== null ? ground(X + dx + 2, Z + dz) : null
        if (g !== null && g2 === g) { spot = { x: X + dx, y: g + 1, z: Z + dz }; break }
      }
    }
  }
  if (!spot) throw new Error('no standable spot near the target')
  log(`spot ${fmtPos(spot)}`)
  await cmd(`/tp ${DIRECTOR} ${spot.x + 0.5} ${spot.y + 12} ${spot.z + 6.5}`)
  // natural hostiles around the spot (a dark forest spawns them by day too)
  const killHostiles = async () => {
    for (const m of HOSTILE) await cmd(`/execute positioned ${spot!.x} ${spot!.y} ${spot!.z} run kill @e[type=minecraft:${m},distance=..48]`)
  }
  await killHostiles()
  const worldSpawn = (dir.bot as any).spawnPoint as { x: number, y: number, z: number } | undefined

  const tester = new Agent(testerVariant, server, { username: TESTER, dataDir: `${DATA}/agents`, canDig: false })
  const bot = new Agent(botVariant, server, { username: BOT, dataDir: `${DATA}/agents`, canDig: true, owners: [TESTER] })
  // straight to the spot on joining (wherever the account logged out), respawning there while the test runs
  const place = (a: Agent, p: string, dx: number) => a.once('session', () => {
    log(`${p} joined at ${fmtPos(posOf(a))}`)
    void cmd(`/tp ${p} ${spot!.x + 0.5 + dx} ${spot!.y} ${spot!.z + 0.5}`).then(() => cmd(`/spawnpoint ${p} ${spot!.x + dx} ${spot!.y} ${spot!.z}`))
  })
  place(tester, TESTER, 0)
  place(bot, BOT, 2)
  bot.on('chatOut', m => log(`bot says${m.to ? ` to ${m.to}` : ''}> ${m.message}`))
  const steps: Step[] = []
  const record = (s: Step) => { steps.push(s); log(`${s.ok ? 'OK  ' : 'FAIL'} ${s.step} (${s.seconds.toFixed(1)}s): ${s.message}${s.extra ? ' ' + JSON.stringify(s.extra) : ''}`) }
  const sys = { kind: 'system', name: 'smoke-test' } as const
  const asTester = { kind: 'player', name: TESTER } as const
  const act = async (a: Agent, name: string, params: Record<string, unknown>, caller: typeof sys | typeof asTester = asTester): Promise<{ r: ActionResult, s: number }> => {
    const t = Date.now()
    const r = await a.act(name, params, { caller, priority: PRIORITY.player })
    return { r, s: (Date.now() - t) / 1000 }
  }

  const cleanUp = async () => {
    await killHostiles()
    for (const p of [BOT, TESTER]) {
      await cmd(`/clear ${p}`)
      await cmd(`/effect clear ${p}`)
      if (worldSpawn) await cmd(`/spawnpoint ${p} ${Math.floor(worldSpawn.x)} ${Math.floor(worldSpawn.y)} ${Math.floor(worldSpawn.z)}`)
    }
    if (spot) await cmd(`/execute positioned ${spot.x} ${spot.y} ${spot.z} run kill @e[type=item,distance=..64]`)
    await pause(1000)
    await bot.stop().catch(() => {})
    await tester.stop().catch(() => {})
    await dir.stop().catch(() => {})
  }

  try {
    const c0 = Date.now()
    await connect(tester)
    await connect(bot)
    record({ step: 'connect', ok: live(bot) && live(tester), message: `${BOT} and ${TESTER} connected`, seconds: (Date.now() - c0) / 1000 })
    for (const p of [BOT, TESTER]) { await cmd(`/clear ${p}`); await cmd(`/effect give ${p} minecraft:instant_health 1 10`); await cmd(`/effect give ${p} minecraft:saturation 5 10`); await cmd(`/effect give ${p} minecraft:resistance 1500 4 true`) }
    await cmd(`/tp ${TESTER} ${spot.x + 0.5} ${spot.y} ${spot.z + 0.5}`)
    await cmd(`/tp ${BOT} ${spot.x + 2.5} ${spot.y} ${spot.z + 0.5}`)
    await pause(4000)
    await act(bot, 'set_home', {}, sys)

    // follow: the tester walks ~8 blocks off; the bot should stay close
    const f = act(bot, 'follow', { player: TESTER })
    await pause(1500)
    const walk = await act(tester, 'goto', { x: spot.x + 10, y: spot.y, z: spot.z + 4 }, sys)
    await pause(5000)
    const d = dist(bot, tester)
    bot.stopActions('smoke: follow done')
    await f
    record({ step: 'follow', ok: d < 5, message: `bot ${d.toFixed(1)} blocks from the tester after it walked (${walk.r.ok ? 'walked' : 'walk failed: ' + walk.r.message})`, seconds: walk.s + 6.5 })
    await act(tester, 'goto', { x: spot.x, y: spot.y, z: spot.z }, sys)

    // chop
    const chop = await act(bot, 'chop_tree', { radius: 32, replant: false, make_axe: false })
    record({ step: 'chop', ok: chop.r.ok, message: chop.r.message, seconds: chop.s, extra: { logs: count(bot, /_log$/) } })

    // find iron
    const iron = await act(bot, 'find_target', { target: 'iron', radius: 64, max_minutes: 3 })
    record({ step: 'find_iron', ok: iron.r.ok, message: iron.r.message, seconds: iron.s })

    // bring planks to the tester
    const before = count(tester, /_planks$/)
    // the tester picks up what lands near it (a player would walk over to it)
    let bringing = true
    const pick = (async () => { while (bringing) { await act(tester, 'pickup_items', { radius: 6 }, sys); await pause(1000) } })()
    const bring = await act(bot, 'bring_item', { item: 'spruce_planks', count: 4, player: TESTER })
    bringing = false
    await pick
    await pause(5000)
    const got = count(tester, /_planks$/) - before
    record({ step: 'bring_planks', ok: bring.r.ok, message: bring.r.message, seconds: bring.s, extra: { testerGot: got } })

    // go home, from 12 blocks off
    await act(bot, 'goto', { x: spot.x - 10, y: spot.y, z: spot.z - 6 }, sys)
    const home = await act(bot, 'go_home', {})
    const hd = Math.hypot(posOf(bot).x - (spot.x + 2.5), posOf(bot).z - (spot.z + 0.5))
    record({ step: 'go_home', ok: home.r.ok && hd < 4, message: home.r.message, seconds: home.s, extra: { fromHome: Math.round(hd * 10) / 10 } })
  } catch (e) {
    record({ step: 'error', ok: false, message: (e as Error).message, seconds: 0 })
  } finally {
    await cleanUp().catch(e => log(`clean-up: ${(e as Error).message}`))
  }

  const line = { when: new Date().toISOString(), tag: TAG, spot, steps: steps.map(s => ({ step: s.step, ok: s.ok, message: s.message, seconds: Math.round(s.seconds), ...s.extra })) }
  appendFileSync(`${DATA}/results.jsonl`, JSON.stringify(line) + '\n')
  console.log('\nstep          result')
  for (const s of steps) console.log(`${s.step.padEnd(13)} ${s.ok ? 'ok' : 'FAIL'}  ${s.message}`)
  console.log(`\nSMOKE ${JSON.stringify(line)}`)
}

if (process.argv[1]?.endsWith('smoke-test.ts')) {
  setTimeout(() => { console.error('smoke test timed out'); process.exit(2) }, 25 * 60_000).unref()
  main().then(() => process.exit(0), e => { console.error(e); process.exit(1) })
}
