// Live bodyguard test: how often a player standing still at night gets hit with the bot's
// bodyguard behaviour armed, against follow_owner only.
//   node scripts/guard-test.ts prep 900 -300            (day) both walk there, the bot makes a stone sword and hunts food
//   node scripts/guard-test.ts run 900 -300 5 guard,follow   (night) N minutes per phase, in this order
// The bot is GUARD_BOT (default GuardTest), owned by GUARD_TESTER (default GuardTester), who
// stands still (no self-defence; eats when it has food). Hits on the tester are counted from its
// own health; results append to data/guard-test/results.jsonl.
import { appendFileSync, mkdirSync } from 'node:fs'
import { Agent, defineVariant, serverFromEnv, PRIORITY, fmtPos, goals, type ActionResult } from '../src/core/index.ts'
import { standardSkills, extendedSkills, navigation, pickup } from '../src/skills/index.ts'
import { reflexes, behaviorsBrain } from '../src/brains/index.ts'
import { playerHealth } from '../src/skills/bodyguard.ts'

const [mode = 'run', xs = '900', zs = '-300', mins = '5', order = 'guard,follow', tag = 'run'] = process.argv.slice(2)
const X = Number(xs)
const Z = Number(zs)
const BOT = process.env.GUARD_BOT || 'GuardTest'
const TESTER = process.env.GUARD_TESTER || 'GuardTester'
const DATA = process.env.GUARD_DATA_DIR || 'data/guard-test'
const server = serverFromEnv()
const t0 = Date.now()
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`)
const pause = (ms: number) => new Promise(r => setTimeout(r, ms))

const botVariant = defineVariant({
  name: 'guard-test',
  skills: [...standardSkills(), navigation(), ...extendedSkills()],
  brains: [reflexes(), behaviorsBrain({ defaults: { stay_safe: { shelterUnprepared: false } }, autoHome: false })]
})
const testerVariant = defineVariant({
  name: 'guard-tester',
  skills: [...standardSkills(), navigation(), pickup()],
  brains: [reflexes({ selfDefense: false, autoEat: true })]
})

const sys = { kind: 'system', name: 'guard-test' } as const
async function step (agent: Agent, name: string, params: Record<string, unknown> = {}): Promise<ActionResult> {
  const t = Date.now()
  const r = await agent.act(name, params, { caller: sys, priority: PRIORITY.player })
  log(`${agent.username}: ${r.ok ? 'OK  ' : 'FAIL'} ${name} ${JSON.stringify(params)} (${((Date.now() - t) / 1000).toFixed(1)}s): ${r.message}`)
  return r
}

/** Connects, retrying kicks and timeouts (the machine and the server are loaded). */
async function connect (agent: Agent): Promise<void> {
  for (let i = 1; i <= 6; i++) {
    const ready = new Promise<boolean>(resolve => {
      const to = setTimeout(() => resolve(false), 60_000)
      agent.once('session', () => { clearTimeout(to); setTimeout(() => resolve(true), 4000) })
    })
    void agent.start().catch(() => {})
    if (await ready) return
    log(`${agent.username}: no session yet (try ${i}), retrying`)
    await agent.stop().catch(() => {})
    await pause(10_000)
  }
  throw new Error(`${agent.username} could not connect`)
}

function state (a: Agent): string {
  const b = a.bot
  if (!b?.entity) return 'offline'
  const cur = a.currentAction ? `${a.currentAction.name} (${a.currentAction.caller.kind}:${a.currentAction.caller.name})` : 'idle'
  const inv = b.inventory.items().map(i => `${i.count} ${i.name}`).join(', ') || 'empty'
  return `at ${fmtPos(b.entity.position)} hp ${Math.round(b.health)} food ${b.food} t ${b.time.timeOfDay} | ${cur} | ${inv}`
}

const far = (a: Agent, x = X, z = Z) => Math.hypot(a.bot.entity.position.x - x, a.bot.entity.position.z - z)
const isNight = (a: Agent) => { const t = a.bot.time.timeOfDay; return t > 13_000 && t < 23_000 }

async function walkThere (a: Agent, x = X, z = Z): Promise<void> {
  for (let i = 0; i < 12 && far(a, x, z) > 6; i++) {
    while (a.currentAction && a.currentAction.caller.kind !== 'brain') await pause(1500)
    await step(a, 'goto', { x, z })
  }
}

async function main (): Promise<void> {
  mkdirSync(DATA, { recursive: true })
  const bot = new Agent(botVariant, server, { username: BOT, dataDir: DATA, canDig: true, owners: [TESTER] })
  const tester = new Agent(testerVariant, server, { username: TESTER, dataDir: `${DATA}-tester`, canDig: true })
  bot.on('actionEnd', (info: any, r: ActionResult) => {
    if (info.caller?.name === 'guard-test' || info.name === 'npc_interrupt') return
    log(`bot ${r.ok ? 'done' : 'FAIL'} ${info.name} (${info.caller.kind}:${info.caller.name}): ${r.message}`)
  })
  // what the bot says (warnings, callouts)
  const said: string[] = []
  const stats = { hits: 0, damage: 0, deaths: 0, botDeaths: 0, healthSeen: 0, healthSamples: 0 }
  let measuring = false
  tester.on('session', () => {
    const b = tester.bot
    // a hit is damage with a source entity (mobs, arrows report the shooter) or with a hostile mob close by;
    // starvation and falls don't count
    b.on('entityHurt', (e: any, source: any) => {
      if (e !== b.entity) return
      const near = Object.values(b.entities).filter((x: any) => x !== b.entity && x.position && x.type !== 'object' && x.type !== 'orb' && x.type !== 'player' && x.position.distanceTo(b.entity.position) < 16)
        .map((x: any) => `${x.name}@${x.position.distanceTo(b.entity.position).toFixed(1)}`).join(' ')
      const mobClose = Object.values(b.entities).some((x: any) => x !== b.entity && x.type === 'hostile' && x.position?.distanceTo(b.entity.position) < 5)
      if (!source && !mobClose) { log(`tester hurt without a mob (hunger ${b.food}?)`); return }
      if (measuring) stats.hits++
      log(`TESTER HIT by ${source?.name ?? '?'} hp ${Math.round(b.health)} near: ${near || '-'} | bot: ${state(bot)}`)
    })
    let last = b.health
    b.on('health', () => {
      if (b.health < last && measuring) stats.damage += last - b.health
      last = b.health
    })
    b.on('death', () => { if (measuring) stats.deaths++; log('TESTER DIED') })
    b.on('chat', (user: string, msg: string) => { if (user === BOT) { said.push(msg); log(`CHAT <${user}> ${msg}`) } })
    b.on('whisper', (user: string, msg: string) => { if (user === BOT) { said.push(`(w) ${msg}`); log(`WHISPER <${user}> ${msg}`) } })
  })
  // walking without sprinting costs (almost) no hunger: both arrive fed after 500 blocks (fights still sprint)
  for (const a of [bot, tester]) a.on('session', () => { a.bot.once('spawn', () => {}); setTimeout(() => { const m = (a.bot?.pathfinder as any)?.movements; if (m) { m.allowSprinting = false; m.allowParkour = false } }, 3000) })
  const kills: Record<string, number> = {}
  bot.on('session', () => {
    const b = bot.bot
    const hitAt = new Map<number, number>()
    const orig = b.attack.bind(b)
    ;(b as any).attack = (e: any) => { hitAt.set(e.id, Date.now()); return orig(e) }
    b.on('entityDead', (e: any) => { const t = hitAt.get(e.id); if (measuring && t && Date.now() - t < 4000 && e !== b.entity) { kills[e.name] = (kills[e.name] ?? 0) + 1; log(`KILL ${e.name}`) } })
  })
  bot.on('session', () => { bot.bot.on('death', () => { if (measuring) stats.botDeaths++; log('BOT DIED') }) })

  await connect(bot)
  await connect(tester)
  log(`bot: ${state(bot)}`)
  log(`tester: ${state(tester)}`)
  for (const name of ['bodyguard', 'follow_owner']) await step(bot, 'behavior_disarm', { name }).catch(() => null)
  const robin = bot.bot.players.robin?.entity
  if (robin) log(`robin is in sight at ${fmtPos(robin.position)}: pick another spot`)

  if (mode === 'logs') {
    // the tester hands its logs over (drop next to the bot), the bot crafts a sword
    await step(tester, 'goto', { x: Math.floor(bot.bot.entity.position.x) + 1, y: Math.floor(bot.bot.entity.position.y), z: Math.floor(bot.bot.entity.position.z) })
    await step(tester, 'drop', { item: 'spruce_log' })
    await pause(1500)
    await step(bot, 'pickup_items', { radius: 6 })
    await step(bot, 'upgrade_tools', { up_to: 'stone', kinds: ['sword'], prospect: false })
    await walkThere(bot)
    await walkThere(tester, X + 2, Z + 2)
    log(`logs: bot ${state(bot)} | tester ${state(tester)}`)
  } else if (mode === 'reset') {
    // reset hunger without /kill: walk off a ledge (dying refills food), respawn at spawn, walk back without sprinting
    const who = (process.env.GUARD_RESET || 'tester,bot').split(',').map(n => n === 'bot' ? bot : tester)
    for (const a of who) {
      const b = a.bot
      const died = new Promise<void>(resolve => b.once('death', () => resolve()))
      const me = b.entity.position.floored()
      let edge: { at: any, dir: [number, number] } | null = null
      const ground = (x: number, z: number, from: number) => { for (let y = from; y > from - 40; y--) { const bl = b.blockAt(me.clone().set(x, y, z)); const up = b.blockAt(me.clone().set(x, y + 1, z)); const up2 = b.blockAt(me.clone().set(x, y + 2, z)); if (bl && bl.boundingBox === 'block' && !/leaves/.test(bl.name) && up?.boundingBox === 'empty' && up2?.boundingBox === 'empty') return y } return -999 }
      for (let r = 1; r <= 20 && !edge; r++) {
        for (let dx = -r; dx <= r && !edge; dx++) for (let dz = -r; dz <= r && !edge; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
          const gy = ground(me.x + dx, me.z + dz, me.y + 4)
          if (gy < -900) continue
          for (const [ux, uz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as [number, number][]) {
            const ny = ground(me.x + dx + ux, me.z + dz + uz, gy + 1)
            const liquid = b.blockAt(me.clone().set(me.x + dx + ux, ny + 1, me.z + dz + uz))?.name
            if (ny > -900 && gy - ny >= Math.ceil(b.health) + 4 && liquid !== 'water' && [1, 2, 3].every(h => b.blockAt(me.clone().set(me.x + dx + ux, gy + h, me.z + dz + uz))?.boundingBox === 'empty')) { edge = { at: me.clone().set(me.x + dx, gy + 1, me.z + dz), dir: [ux, uz] }; break }
          }
        }
      }
      if (!edge) { log(`${a.username}: no ledge high enough nearby`); continue }
      log(`${a.username}: ledge at ${fmtPos(edge.at)}, stepping off`)
      try { await b.pathfinder.goto(new goals.GoalBlock(edge.at.x, edge.at.y, edge.at.z)) } catch (e) { log(`${a.username}: couldn't stand on the edge: ${(e as Error).message}`); continue }
      log(`${a.username}: on the edge at ${fmtPos(b.entity.position)}`)
      await b.lookAt(edge.at.offset(edge.dir[0] * 3 + 0.5, 0, edge.dir[1] * 3 + 0.5), true)
      b.setControlState('forward', true)
      b.setControlState('jump', true)
      await Promise.race([died, pause(6000)])
      b.setControlState('forward', false)
      b.setControlState('jump', false)
      await pause(5000)
      log(`${a.username}: ${state(a)}`)
    }
    await Promise.all([walkThere(bot), walkThere(tester, X + 2, Z + 2)])
    log(`reset: bot ${state(bot)} | tester ${state(tester)}`)
  } else if (mode === 'food') {
    // daytime: scout for animals, bring food back, feed the tester with feed_player
    const idle = async (a: Agent) => { for (let i = 0; i < 30 && a.currentAction; i++) await pause(1000) }
    log(`difficulty ${bot.bot.game.difficulty}; tester ${state(tester)}`)
    if (far(bot) > 50 || far(tester) > 50) await Promise.all([walkThere(bot), walkThere(tester, X + 2, Z + 2)])
    const meat = () => bot.bot.inventory.items().filter(it => /beef|porkchop|mutton|chicken|rabbit$|cod|salmon|bread|apple|carrot|potato/.test(it.name)).reduce((n, it) => n + it.count, 0)
    for (let i = 0; i < 4 && meat() < 10; i++) {
      await idle(bot)
      const r = await step(bot, 'hunt', { count: 4, radius: 64 })
      if (!r.ok && r.message.startsWith('no animal')) { const f = await step(bot, 'find_food', { from: 'here', radius: 400, crops: false, maxMinutes: 6 }); const m = /at (-?\d+) (-?\d+) (-?\d+)/.exec(f.message); if (m) await step(bot, 'goto', { x: Number(m[1]), z: Number(m[3]) }) }
    }
    await idle(bot)
    if (process.env.GUARD_STAY_THERE) {
      // move the test to where the food is: the tester walks to the bot
      const p = bot.bot.entity.position
      log(`new spot: ${fmtPos(p)} (spawn ${Math.round(Math.hypot(p.x - 545, p.z - 45))} blocks away, village ${Math.round(Math.hypot(p.x + 2770, p.z - 1090))})`)
      await walkThere(tester, Math.floor(p.x) + 2, Math.floor(p.z) + 2)
    } else await walkThere(bot)
    for (let i = 0; i < 3; i++) { await idle(bot); await step(bot, 'feed_player', { player: TESTER, keepFood: 4 }); await pause(1500); await step(tester, 'pickup_items', { radius: 6 }).catch(() => null) }
    for (let i = 0; i < 4 && tester.bot.food < 18; i++) await step(tester, 'eat').catch(() => null)
    log(`fed: ${state(bot)} | tester ${state(tester)}`)
  } else if (mode === 'gear') {
    // the bot on the spot: food for both (hunt, then feed_player), wood and a sword
    const idle = async (a: Agent) => { for (let i = 0; i < 30 && a.currentAction; i++) await pause(1000) }
    await step(tester, 'pickup_items', { radius: 16 }).catch(() => null)
    for (let i = 0; i < 6 && bot.bot.inventory.items().filter(it => /beef|porkchop|mutton|chicken|rabbit$|cooked_rabbit/.test(it.name)).reduce((n, it) => n + it.count, 0) < 6; i++) { await idle(bot); const r = await step(bot, 'hunt', { count: 3, radius: 64 }); if (!r.ok && r.message.startsWith('no animal')) break }
    await idle(bot)
    await step(bot, 'feed_player', { player: TESTER, keepFood: 2 })
    await pause(1500)
    await step(tester, 'pickup_items', { radius: 6 }).catch(() => null)
    await step(tester, 'eat').catch(() => null)
    if (!bot.bot.inventory.items().some(it => /_sword$/.test(it.name))) for (let i = 0; i < 3; i++) { await idle(bot); const r = await step(bot, 'chop_tree', { radius: 64 }); if (r.ok) break }
    await idle(bot)
    await step(bot, 'upgrade_tools', { up_to: 'stone', kinds: ['sword'], prospect: false })
    await walkThere(bot)
    log(`geared: ${state(bot)} | tester ${state(tester)}`)
  } else if (mode === 'prep') {
    await Promise.all([walkThere(bot), walkThere(tester, X + 2, Z + 2)])
    await step(bot, 'upgrade_tools', { up_to: 'stone', kinds: ['sword'], prospect: false })
    const food = () => bot.bot.inventory.items().filter(i => /beef|porkchop|mutton|chicken|rabbit|bread|apple|cod|salmon|potato|carrot/.test(i.name)).reduce((n, i) => n + i.count, 0)
    for (let i = 0; i < 4 && food() < 10; i++) await step(bot, 'hunt', { count: 3, radius: 48 })
    await walkThere(bot)
    log(`prepared: ${state(bot)}`)
  } else {
    while (!isNight(bot)) { log(`waiting for night: ${state(bot)}`); await pause(20_000) }
    await walkThere(tester, X, Z)
    const spot = tester.bot.entity.position.clone()
    const results = []
    for (const phase of order.split(',')) {
      if (!isNight(bot)) { log(`day came, stopping before ${phase}`); break }
      for (const k of Object.keys(kills)) delete kills[k]
      Object.assign(stats, { hits: 0, damage: 0, deaths: 0, botDeaths: 0, healthSeen: 0, healthSamples: 0 })
      said.length = 0
      if (phase === 'guard') await step(bot, 'behavior_arm', { name: 'bodyguard', options: { player: TESTER } })
      else await step(bot, 'behavior_arm', { name: 'follow_owner', options: { player: TESTER } })
      log(`measuring ${phase} for ${mins} min at ${fmtPos(spot)}`)
      measuring = true
      const until = Date.now() + Number(mins) * 60_000
      while (Date.now() < until) {
        await pause(5000)
        if (!tester.bot?.entity || !bot.bot?.entity) continue
        if (tester.bot.entity.position.distanceTo(spot) > 3 && !tester.currentAction) {
          // knocked away or respawned: back to the spot (respawn: far, the phase is spoiled but it keeps counting)
          void step(tester, 'goto', { x: Math.floor(spot.x), y: Math.floor(spot.y), z: Math.floor(spot.z) })
        }
        const te = bot.bot.players[TESTER]?.entity
        if (te) { stats.healthSamples++; if (playerHealth(bot.bot, te) !== null) stats.healthSeen++ }
        log(`bot ${state(bot)} | tester hp ${Math.round(tester.bot.health)} seen by bot as ${te ? playerHealth(bot.bot, te) : '-'}`)
      }
      measuring = false
      await step(bot, 'behavior_disarm', { name: phase === 'guard' ? 'bodyguard' : 'follow_owner' })
      const r = { tag, phase, at: new Date().toISOString(), minutes: Number(mins), at_xz: [X, Z], testerHits: stats.hits, damage: Math.round(stats.damage), testerDeaths: stats.deaths, botDeaths: stats.botDeaths, kills: { ...kills }, healthVisible: `${stats.healthSeen}/${stats.healthSamples}`, said: said.slice(0, 20) }
      log(`RESULT ${JSON.stringify(r)}`)
      appendFileSync(`${DATA}/results.jsonl`, JSON.stringify(r) + '\n')
      results.push(r)
    }
  }
  await bot.stop()
  await tester.stop()
}

main().then(() => process.exit(0), e => { console.error(e); process.exit(1) })
