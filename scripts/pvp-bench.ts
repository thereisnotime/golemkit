// Bot-vs-bot PvP benchmark: two test bots (PVP_A, PVP_B; default PvpA and PvpB) with the same kit
// duel N rounds in an arena far from everyone, one running the PvP tactics (combat.pvpTactics,
// pvp-fight.ts) and the other the old fight loop (fightTarget, tactics off), or both the same.
//   node scripts/pvp-bench.ts [x z] [--rounds 6] [--match new-old|mirror|old-old] [--kit iron|diamond]
//        [--no-bow] [--totem] [--apples 2] [--round-s 120] [--radius 14] [--tag run] [--scout] [--cleanup] [--force]
// The DIRECTOR (default ClaudeTest, an op) only uses /tp, /give, /clear, /effect, /kill (drops),
// /spawnpoint and /gamemode on the test accounts; never gamerules or time. Before logging in it
// pings the server and stops if the director is online already; before every round it checks
// that no other player is within 300 blocks of the arena (and the arena is 300+ blocks from
// spawn, the fortress and the village). Each bot is set to combat.pvp targets with the other
// test bot as its only target, the director as its owner, every other online player as a
// friend, and no grudges (revengeMinutes 0), so it can't go after anyone else.
// A round: both healed, cleared, given the kit, put 10 blocks apart, then both switched on; it
// ends at the first death or after --round-s. In new-old the sides swap every round. Counted per
// side: wins, damage dealt and taken (health lost by the other / by itself), hits, crits (hits
// while falling), and time to kill. Results append to data/pvp-bench/results.jsonl.
import { appendFileSync, mkdirSync } from 'node:fs'
import mcProtocol from 'minecraft-protocol'
const { ping } = mcProtocol as any
import { Agent, defineVariant, serverFromEnv, PRIORITY, fmtPos, type ActionResult } from '../src/core/index.ts'
import { standardSkills, extendedSkills, navigation } from '../src/skills/index.ts'
import { reflexes, commandBrain } from '../src/brains/index.ts'

const argv = process.argv.slice(2)
const flag = (name: string) => argv.includes(`--${name}`)
const opt = (name: string, def: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : def }
const BOOL_FLAGS = ['--scout', '--cleanup', '--force', '--no-bow', '--totem', '--commands']
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1]!.startsWith('--') && !BOOL_FLAGS.includes(argv[i - 1]!)))
const X = Number(positional[0] ?? 1250)
const Z = Number(positional[1] ?? 445)
const ROUNDS = Number(opt('rounds', '6'))
const MATCH = opt('match', 'new-old') as 'new-old' | 'mirror' | 'old-old'
const KIT = opt('kit', 'iron')
const BOW = !flag('no-bow')
const TOTEM = flag('totem')
const APPLES = Number(opt('apples', '2'))
const ROUND_S = Number(opt('round-s', '120'))
/** Half-size of the floor checked flat; the bots start min(5, R - 3) blocks either side of the centre. */
const R = Number(opt('radius', '14'))
const GAP = Math.max(2, Math.min(5, R - 3))
const RUN_TAG = opt('tag', 'run')
const A = process.env.PVP_A || 'PvpA'
const B = process.env.PVP_B || 'PvpB'
const DIRECTOR = process.env.DIRECTOR || 'ClaudeTest'
const DATA = process.env.PVP_BENCH_DIR || 'data/pvp-bench'
const KEEP_AWAY: [string, number, number][] = [['spawn', 545, 45], ['village', -2770, 1090], ['fortress', 560, -43]]
const TEST_ACCOUNTS = new Set([A, B, DIRECTOR].map(s => s.toLowerCase()))
const server = serverFromEnv()
const t0 = Date.now()
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`)
const pause = (ms: number) => new Promise(r => setTimeout(r, ms))

const variant = defineVariant({
  name: 'pvp-bench',
  skills: [...standardSkills(), navigation(), ...extendedSkills()],
  // owner commands (the director is the only owner) for --commands
  brains: [reflexes(), commandBrain({ greet: false })]
})
const sys = { kind: 'system', name: 'pvp-bench' } as const
async function step (agent: Agent, name: string, params: Record<string, unknown> = {}): Promise<ActionResult> {
  const r = await agent.act(name, params, { caller: sys, priority: PRIORITY.system })
  log(`${agent.username}: ${r.ok ? 'OK  ' : 'FAIL'} ${name} ${JSON.stringify(params)}: ${r.message}`)
  return r
}
async function connect (agent: Agent, minutes = 5): Promise<void> {
  const ready = new Promise<boolean>(resolve => {
    const to = setTimeout(() => resolve(false), minutes * 60_000)
    agent.once('session', () => { clearTimeout(to); setTimeout(() => resolve(true), 4000) })
  })
  void agent.start().catch(() => {})
  if (!await ready) { await agent.stop().catch(() => {}); throw new Error(`${agent.username} could not connect in ${minutes} min`) }
}
const live = (a: Agent) => { try { return !!a.bot?.entity } catch { return false } }
async function waitLive (a: Agent, ms = 60_000): Promise<boolean> {
  const until = Date.now() + ms
  while (!live(a) && Date.now() < until) await pause(500)
  return live(a)
}
const state = (a: Agent) => live(a) ? `at ${fmtPos(a.bot.entity.position)} hp ${Math.round(a.bot.health)} | ${a.currentAction?.name ?? 'idle'} | ${a.bot.heldItem?.name ?? '-'} / ${a.bot.inventory.slots[45]?.name ?? '-'}` : 'offline'

/** Who is online, from a status ping (no login). */
async function onlineNow (): Promise<string[]> {
  const r: any = await ping({ host: server.host, port: server.port } as any)
  return ((r?.players?.sample ?? []) as { name: string }[]).map(p => p.name)
}

interface Side { hits: number, crits: number, taken: number, dealt: number, deaths: number }
const freshSide = (): Side => ({ hits: 0, crits: 0, taken: 0, dealt: 0, deaths: 0 })

async function main (): Promise<void> {
  mkdirSync(DATA, { recursive: true })
  for (const [name, x, z] of KEEP_AWAY) {
    const d = Math.hypot(X - x, Z - z)
    if (d < 300) throw new Error(`the arena is ${Math.round(d)} blocks from the ${name}; pick one 300+ away`)
  }
  const before = await onlineNow().catch(() => null)
  log(`online before login: ${before === null ? 'ping failed' : before.join(', ') || 'nobody'}`)
  if (before?.some(n => n.toLowerCase() === DIRECTOR.toLowerCase())) throw new Error(`${DIRECTOR} is online already; not logging in`)
  for (const n of [A, B]) if (before?.some(p => p.toLowerCase() === n.toLowerCase())) throw new Error(`${n} is online already`)

  const dir = new Agent(defineVariant({ name: 'director', skills: standardSkills(), brains: [] }), server, { username: DIRECTOR, dataDir: `${DATA}/director` })
  const cmd = async (c: string) => { const ok = await dir.command(c); if (!ok) log(`command refused: ${c}`); await pause(250) }
  const replies: string[] = []
  dir.on('session', () => {
    dir.bot.on('messagestr', (m: string) => {
      replies.push(m)
      if (replies.length > 80) replies.shift()
      if (/Unknown|Incorrect|Expected|Could not|^Unable/i.test(m)) log(`server: ${m}`)
    })
  })
  await connect(dir)
  await waitLive(dir)
  log(`director: ${state(dir)}`)

  /** Every other online player: distance to the arena (null when the server didn't say). */
  const others = () => Object.keys(dir.bot.players).filter(n => !TEST_ACCOUNTS.has(n.toLowerCase()))
  const distanceOf = async (p: string, tries = 2): Promise<number | null> => {
    replies.length = 0
    await cmd(`/data get entity ${p} Pos`)
    for (let i = 0; i < 60; i++) {
      // only the answer itself: "No entity was found" also comes back from the mob clean-up kills
      const line = replies.find(r => r.includes(`${p} has the following entity data`))
      if (line) {
        const m = /\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/.exec(line)
        return m ? Math.hypot(Number(m[1]) - X, Number(m[3]) - Z) : null
      }
      await pause(250)
    }
    return tries > 1 ? distanceOf(p, tries - 1) : null
  }
  const checkPlayersFar = async () => {
    if (!live(dir)) throw new Error('director not connected')
    for (const p of others()) {
      const d = await distanceOf(p)
      log(`${p}: ${d === null ? 'unknown' : `${Math.round(d)} blocks from the arena`}`)
      if (d === null || d < 300) throw new Error(`${p} is ${d === null ? 'at an unknown distance' : `${Math.round(d)} blocks`} from the arena: stopping`)
    }
  }
  const worldSpawn = (dir.bot as any).spawnPoint as { x: number, y: number, z: number } | undefined
  let cleaned = false
  const agents: Agent[] = []
  const cleanUp = async () => {
    if (cleaned) return
    cleaned = true
    for (const a of agents) { try { if (live(a)) a.setToggle('combat.pvp', 'off') } catch {} }
    for (const p of [A, B]) {
      await cmd(`/clear ${p}`)
      await cmd(`/effect clear ${p}`)
      if (worldSpawn) await cmd(`/spawnpoint ${p} ${Math.floor(worldSpawn.x)} ${Math.floor(worldSpawn.y)} ${Math.floor(worldSpawn.z)}`)
    }
    await cmd(`/execute positioned ${X} 70 ${Z} run kill @e[type=item,distance=..60]`)
    await cmd(`/execute positioned ${X} 70 ${Z} run kill @e[type=arrow,distance=..60]`)
    await cmd(`/execute positioned ${X} 70 ${Z} run kill @e[type=experience_orb,distance=..60]`)
    await pause(1500)
    for (const a of agents) await a.stop().catch(() => {})
    await dir.stop().catch(() => {})
  }

  try {
    await checkPlayersFar()
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
    let cols: { dx: number, dz: number, y: number }[] = []
    for (let tries = 0; tries < 10; tries++) {
      heights = []
      cols = []
      odd.length = 0
      for (let dx = -R; dx <= R; dx++) for (let dz = -R; dz <= R; dz++) {
        const s = surface(X + dx, Z + dz)
        if (!s) continue
        heights.push(s.y)
        cols.push({ dx, dz, y: s.y })
        if (/water|lava|leaves|log/.test(s.name)) odd.push(`${s.name}@${dx},${dz}`)
      }
      if (heights.length === (2 * R + 1) ** 2) break
      await pause(2000)
    }
    if (heights.length < (2 * R + 1) ** 2) throw new Error(`couldn't read the arena (${heights.length} columns)`)
    const counts = new Map<number, number>()
    for (const h of heights) counts.set(h, (counts.get(h) ?? 0) + 1)
    const G = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0]
    const off = heights.filter(h => Math.abs(h - G) > 1).length
    if (off) log(`off columns: ${cols.filter(c => Math.abs(c.y - G) > 1).slice(0, 200).map(c => `${c.dx},${c.dz}:${c.y - G}`).join(' ')}`)
    log(`arena ${X} ${Z}: floor y ${G}, ${off} columns off by 2+${odd.length ? `, odd: ${odd.slice(0, 10).join(' ')}` : ''}`)
    if ((odd.some(o => /water|lava/.test(o)) || off > 20) && !flag('force') && !flag('cleanup')) throw new Error('the arena is not flat and dry (use --force)')
    if (flag('scout')) return
    const park = surface(X + 20, Z)
    await cmd(`/tp ${DIRECTOR} ${X + 20.5} ${(park?.y ?? G) + 1} ${Z + 0.5}`)

    const mk = (name: string) => new Agent(variant, server, { username: name, dataDir: `${DATA}/agents/${name}`, canDig: false, owners: [DIRECTOR] })
    const a = mk(A)
    const b = mk(B)
    agents.push(a, b)
    if (flag('cleanup')) { await connect(a); await connect(b); return }
    await connect(a)
    await connect(b)
    await waitLive(a)
    await waitLive(b)

    // per-session counters
    const stats = new Map<string, Side>([[A, freshSide()], [B, freshSide()]])
    let measuring = false
    const deathAt = new Map<string, number>()
    const wire = (ag: Agent) => {
      const bt = ag.bot
      if (!bt || (bt as any).__pvpBench) return
      ;(bt as any).__pvpBench = true
      const orig = bt.attack.bind(bt)
      ;(bt as any).attack = (e: any) => {
        if (measuring && e?.type === 'player') {
          const s = stats.get(ag.username)!
          s.hits++
          if (!bt.entity.onGround && bt.entity.velocity.y < 0) s.crits++
        }
        return orig(e)
      }
      let last = bt.health
      bt.on('health', () => {
        if (measuring && bt.health < last) {
          stats.get(ag.username)!.taken += last - bt.health
          stats.get(ag.username === A ? B : A)!.dealt += last - bt.health
        }
        last = bt.health
      })
      bt.on('death', () => { if (measuring) { stats.get(ag.username)!.deaths++; deathAt.set(ag.username, Date.now()) } log(`${ag.username} DIED`) })
    }
    for (const ag of [a, b]) { wire(ag); ag.on('session', () => wire(ag)) }

    const spawnY = G + 1
    if (flag('commands')) {
      // owner commands over whispers, PvP never switched on long enough to fight (the two stand 30 apart)
      await cmd(`/tp ${A} ${X - 15 + 0.5} ${spawnY} ${Z + 0.5}`)
      await cmd(`/tp ${B} ${X + 15 + 0.5} ${spawnY} ${Z + 0.5}`)
      a.setToggle('combat.pvpEngage', 4)
      const heard: string[] = []
      dir.bot.on('whisper', (u: string, m: string) => { if (u === A) heard.push(m) })
      const ask = async (line: string, expect: RegExp) => {
        heard.length = 0
        dir.whisper(A, line)
        for (let i = 0; i < 40 && !heard.length; i++) await pause(250)
        await pause(3000) // the reply and the owner whisper about a mode change go through the chat rate limit
        const got = heard.join(' | ')
        log(`${expect.test(got) ? 'PASS' : 'FAIL'} ${line} -> ${got || '(nothing)'}`)
      }
      await ask('!pvp', /PvP off/)
      await ask(`!attack_player ${DIRECTOR}`, /never/)
      await ask(`!attack_player ${B}`, new RegExp(`${B} is a target`))
      await ask('!pvp_list', new RegExp(`PvP targets; targets: ${B}`))
      await ask('!stop', /PvP off/)
      await ask('!pvp revenge', /revenge/)
      await ask(`!spare_player ${B}`, /leaving|wasn't/)
      await ask('!pvp off', /PvP off/)
      return
    }
    for (const p of [A, B]) await cmd(`/spawnpoint ${p} ${X} ${spawnY} ${Z + Math.min(12, R)}`)
    for (const p of [A, B]) await cmd(`/gamemode survival ${p}`)
    const setup = (ag: Agent, other: string, tactics: boolean) => {
      const friends = others()
      ag.setToggle('combat.pvp', 'off')
      ag.setToggle('combat.targets', other)
      ag.setToggle('combat.friends', friends.length ? friends.join(',') : DIRECTOR)
      ag.setToggle('combat.revengeMinutes', 0)
      ag.setToggle('combat.pvpEngage', 24)
      ag.setToggle('combat.pvpMinOdds', 0)
      ag.setToggle('combat.pvpTactics', tactics)
      ag.setToggle('combat.taunts', false)
    }
    const kit = async (p: string) => {
      await cmd(`/clear ${p}`)
      const m = KIT === 'diamond' ? 'diamond' : 'iron'
      await cmd(`/give ${p} minecraft:${m}_sword 1`)
      await cmd(`/give ${p} minecraft:${m}_axe 1`)
      await cmd(`/give ${p} minecraft:shield 1`)
      for (const piece of ['helmet', 'chestplate', 'leggings', 'boots']) await cmd(`/give ${p} minecraft:${m}_${piece} 1`)
      if (BOW) { await cmd(`/give ${p} minecraft:bow 1`); await cmd(`/give ${p} minecraft:arrow 16`) }
      if (APPLES > 0) await cmd(`/give ${p} minecraft:golden_apple ${APPLES}`)
      if (TOTEM) await cmd(`/give ${p} minecraft:totem_of_undying 1`)
      await cmd(`/give ${p} minecraft:cooked_beef 8`)
      await cmd(`/effect clear ${p}`)
      await cmd(`/effect give ${p} minecraft:instant_health 1 10`)
      await cmd(`/effect give ${p} minecraft:saturation 3 10`)
    }
    const role = (round: number, who: string): 'new' | 'old' => {
      if (MATCH === 'mirror') return 'new'
      if (MATCH === 'old-old') return 'old'
      const aNew = round % 2 === 0
      return (who === A) === aNew ? 'new' : 'old'
    }
    // natural mobs in the arena (night) would decide the duel: killed before and during every round
    const MOBS = ['zombie', 'husk', 'drowned', 'zombie_villager', 'skeleton', 'stray', 'bogged', 'creeper', 'spider', 'cave_spider', 'phantom', 'witch', 'enderman', 'slime', 'pillager']
    const clearMobs = async () => { for (const m of MOBS) await cmd(`/execute positioned ${X} ${G} ${Z} run kill @e[type=minecraft:${m},distance=..64]`) }
    let drops = 0
    for (const ag of [dir, a, b]) ag.on('session', () => { drops++ })
    const rounds: any[] = []
    let retries = 0
    for (let round = 0; round < ROUNDS; round++) {
      try {
        await checkPlayersFar()
        for (const ag of [dir, a, b]) { if (!live(ag)) await waitLive(ag, 120_000) }
        // hostile mobs spawn at night and a creeper blew holes in the arena in testing: duel by day only
        // (the time is never changed, the director just waits)
        while (live(dir) && (dir.bot.time.timeOfDay >= 12_500 && dir.bot.time.timeOfDay <= 23_400)) {
          log(`night (time ${dir.bot.time.timeOfDay}): waiting for the day`)
          await pause(30_000)
        }
        const sessions = drops
        if (![dir, a, b].every(live)) throw new Error('a test account is offline')
        await clearMobs()
        setup(a, B, role(round, A) === 'new')
        setup(b, A, role(round, B) === 'new')
        await cmd(`/execute positioned ${X} ${spawnY} ${Z} run kill @e[type=item,distance=..60]`)
        await cmd(`/execute positioned ${X} ${spawnY} ${Z} run kill @e[type=arrow,distance=..60]`)
        for (const p of [A, B]) await kit(p)
        await cmd(`/tp ${A} ${X - GAP + 0.5} ${spawnY} ${Z + 0.5} -90 0`)
        await cmd(`/tp ${B} ${X + GAP + 0.5} ${spawnY} ${Z + 0.5} 90 0`)
        await pause(1500)
        for (const ag of [a, b]) await step(ag, 'gear_up')
        await pause(1000)
        log(`== round ${round + 1}: ${A} ${role(round, A)}, ${B} ${role(round, B)} | ${state(a)} || ${state(b)}`)
        for (const s of stats.values()) Object.assign(s, freshSide())
        deathAt.clear()
        measuring = true
        const start = Date.now()
        a.setToggle('combat.pvp', 'targets')
        b.setToggle('combat.pvp', 'targets')
        let lastLog = 0
        let lastClear = Date.now()
        let clearing: Promise<void> = Promise.resolve()
        let clearBusy = false
        while (Date.now() - start < ROUND_S * 1000 && deathAt.size === 0) {
          await pause(250)
          if (Date.now() - lastLog > 10_000) { lastLog = Date.now(); log(`  ${state(a)} || ${state(b)}`) }
          if (Date.now() - lastClear > 8000 && !clearBusy) {
            lastClear = Date.now()
            clearBusy = true
            clearing = clearMobs().finally(() => { clearBusy = false })
          }
        }
        // the first death ends the round: both off before anything else (the mob clean-up can take seconds)
        measuring = false
        a.setToggle('combat.pvp', 'off')
        b.setToggle('combat.pvp', 'off')
        await clearing
        const reconnected = drops !== sessions || (![a, b].every(live) && deathAt.size === 0)
        const loser = [...deathAt.keys()][0] ?? null
        const winner = loser ? (loser === A ? B : A) : null
        const row = {
          tag: RUN_TAG, at: new Date().toISOString(), void: reconnected, match: MATCH, kit: KIT, bow: BOW, totem: TOTEM, apples: APPLES, round: round + 1,
          winner, winnerRole: winner ? role(round, winner) : null, ttkS: loser ? Math.round((deathAt.get(loser)! - start) / 100) / 10 : null,
          sides: [A, B].map(p => ({ player: p, role: role(round, p), ...stats.get(p)! }))
        }
        if (reconnected) log('a test account reconnected during the round: not counted')
        else rounds.push(row)
        appendFileSync(`${DATA}/results.jsonl`, JSON.stringify(row) + '\n')
        log(`round ${round + 1}: ${winner ? `${winner} (${role(round, winner)}) won in ${row.ttkS} s` : 'no kill'} | ${JSON.stringify(row.sides)}`)
        await pause(3000) // respawn
      } catch (e) {
        // the server dropped every connection at once twice in testing: wait, then play the round again
        if (++retries > 5 || !/not connected|offline/.test(String((e as Error)?.message ?? e))) throw e
        measuring = false
        log(`round ${round + 1} interrupted (${(e as Error).message}); waiting for the accounts and playing it again`)
        for (const ag of [a, b]) { try { if (live(ag)) ag.setToggle('combat.pvp', 'off') } catch {} }
        for (const ag of [dir, a, b]) await waitLive(ag, 180_000)
        await pause(5000)
        round--
      }
    }
    // ---- summary per role ----
    const agg: Record<string, Side & { wins: number, ttk: number[] }> = {}
    for (const r of rounds) {
      for (const s of r.sides as (Side & { player: string, role: string })[]) {
        const key = MATCH === 'new-old' ? s.role : s.player
        const g = agg[key] ??= { ...freshSide(), wins: 0, ttk: [] }
        g.hits += s.hits; g.crits += s.crits; g.taken += s.taken; g.dealt += s.dealt; g.deaths += s.deaths
        if (r.winner === s.player) { g.wins++; if (r.ttkS !== null) g.ttk.push(r.ttkS) }
      }
    }
    console.log(`\n${MATCH}, ${rounds.length} rounds, kit ${KIT}${BOW ? ' + bow' : ''}${TOTEM ? ' + totem' : ''}, ${APPLES} golden apples`)
    console.log('side        wins  deaths  dealt  taken  hits  crits  median ttk s')
    for (const [k, g] of Object.entries(agg)) {
      const s = [...g.ttk].sort((x, y) => x - y)
      const med = s.length ? s[s.length >> 1] : null
      console.log(`${k.padEnd(10)}  ${String(g.wins).padStart(4)}  ${String(g.deaths).padStart(6)}  ${g.dealt.toFixed(0).padStart(5)}  ${g.taken.toFixed(0).padStart(5)}  ${String(g.hits).padStart(4)}  ${String(g.crits).padStart(5)}  ${med ?? '-'}`)
    }
  } finally {
    await cleanUp()
  }
}

main().then(() => process.exit(0), e => { console.error(e); process.exit(1) })
