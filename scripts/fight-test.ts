// Live combat test on a real server: kills, deaths and damage over a stretch of night.
//   node scripts/fight-test.ts prep 700 200          walk there, make stone tools (sword), hunt some food
//   node scripts/fight-test.ts night 700 200 10 tag  wait for night, then stand out there N minutes and fight what comes
//   node scripts/fight-test.ts armour 700 200        iron tools and iron armour through the bot's own progression
// The bot is FIGHT_BOT (default FightTest), owned by FIGHT_TESTER (default FightTester), who
// joins and stays at spawn. Only reflexes run (retreatBelow 0, like Pax), no behaviours, so the
// numbers measure fighting, not hiding. Kills are counted the same way for any fight() version:
// a mob that dies within 4 s of the bot hitting it. Results append to data/fight-test/results.jsonl.
import { appendFileSync, mkdirSync } from 'node:fs'
import { Agent, defineVariant, serverFromEnv, PRIORITY, fmtPos, type ActionResult } from '../src/core/index.ts'
import { standardSkills, extendedSkills, navigation } from '../src/skills/index.ts'
import { reflexes } from '../src/brains/index.ts'

const [mode = 'night', xs = '700', zs = '200', mins = '10', tag = 'run'] = process.argv.slice(2)
const X = Number(xs)
const Z = Number(zs)
const BOT = process.env.FIGHT_BOT || 'FightTest'
const TESTER = process.env.FIGHT_TESTER || 'FightTester'
const DATA = process.env.FIGHT_DATA_DIR || 'data/fight-test'
const server = serverFromEnv()
const t0 = Date.now()
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`)
const pause = (ms: number) => new Promise(r => setTimeout(r, ms))

const variant = defineVariant({
  name: 'fight-test',
  skills: [...standardSkills(), navigation(), ...extendedSkills()],
  brains: [reflexes({ retreatBelow: 0, waterFightAbove: 0 })]
})

async function step (agent: Agent, name: string, params: Record<string, unknown> = {}): Promise<ActionResult> {
  const t = Date.now()
  const r = await agent.act(name, params, { caller: { kind: 'system', name: 'fight-test' }, priority: PRIORITY.player })
  log(`${r.ok ? 'OK  ' : 'FAIL'} ${name} ${JSON.stringify(params)} (${((Date.now() - t) / 1000).toFixed(1)}s): ${r.message}`)
  return r
}

async function connect (agent: Agent): Promise<void> {
  const ready = new Promise<void>(resolve => agent.once('session', () => setTimeout(resolve, 4000)))
  void agent.start()
  await ready
}

function state (a: Agent): string {
  const b = a.bot
  const cur = a.currentAction ? `${a.currentAction.name} (${a.currentAction.caller.kind})` : 'idle'
  const armour = [5, 6, 7, 8].map(i => b.inventory.slots[i]?.name).filter(Boolean).join('+') || 'no armour'
  const inv = b.inventory.items().map(i => `${i.count} ${i.name}`).join(', ') || 'empty'
  return `at ${fmtPos(b.entity.position)} hp ${Math.round(b.health)} food ${b.food} t ${b.time.timeOfDay} | ${cur} | ${armour} | ${inv}`
}

const far = (a: Agent) => Math.hypot(a.bot.entity.position.x - X, a.bot.entity.position.z - Z)
const isNight = (a: Agent) => { const t = a.bot.time.timeOfDay; return t > 13_000 && t < 23_000 }

async function walkThere (bot: Agent): Promise<void> {
  for (let i = 0; i < 10 && far(bot) > 10; i++) {
    while (bot.currentAction) await pause(1500)
    await step(bot, 'goto', { x: X, z: Z })
  }
}

async function main (): Promise<void> {
  mkdirSync(DATA, { recursive: true })
  const bot = new Agent(variant, server, { username: BOT, dataDir: DATA, canDig: true, owners: [TESTER] })
  const tester = new Agent(defineVariant({ name: 'tester', skills: standardSkills(), brains: [] }), server, { username: TESTER, dataDir: `${DATA}-tester` })
  bot.on('actionEnd', (info: any, r: ActionResult) => {
    if (info.caller?.name === 'fight-test') return
    log(`${r.ok ? 'done' : 'FAIL'} ${info.name} (${info.caller.kind}): ${r.message}`)
  })

  // the same kill counter for every fight() version: hits recorded on bot.attack, deaths on entityDead
  const stats = { kills: 0, deaths: 0, hits: 0, damage: 0, killed: {} as Record<string, number>, aliveMs: [] as number[] }
  let measuring = false
  let lifeStart = 0
  bot.on('session', () => {
    const b = bot.bot
    const hitAt = new Map<number, number>()
    const orig = b.attack.bind(b)
    ;(b as any).attack = (e: any) => { if (measuring) { stats.hits++; hitAt.set(e.id, Date.now()) } return orig(e) }
    b.on('entityDead', (e: any) => {
      const t = hitAt.get(e.id)
      if (measuring && t && Date.now() - t < 4000 && e !== b.entity) { stats.kills++; stats.killed[e.name] = (stats.killed[e.name] ?? 0) + 1; log(`KILL ${e.name}`) }
    })
    let last = b.health
    b.on('health', () => { if (measuring && b.health < last) stats.damage += last - b.health; last = b.health })
    b.on('death', () => {
      if (!measuring) return
      stats.deaths++
      stats.aliveMs.push(Date.now() - lifeStart)
      lifeStart = Date.now()
      log(`DEATH at ${fmtPos(b.entity.position)}`)
    })
  })
  await connect(bot)
  await connect(tester).catch(() => null)
  log(`spawned: ${state(bot)}`)
  for (const name of ['keep_fed', 'farm_setup', 'stay_safe', 'follow_owner', 'collect_drops']) await step(bot, 'behavior_disarm', { name }).catch(() => null)

  if (mode === 'prep' || mode === 'armour') {
    await walkThere(bot)
    if (mode === 'prep') {
      await step(bot, 'upgrade_tools', { up_to: 'stone', kinds: ['pickaxe', 'sword'], prospect: false })
      const food = () => bot.bot.inventory.items().filter(i => /beef|porkchop|mutton|chicken|rabbit|bread|apple|cod|salmon|potato|carrot/.test(i.name)).reduce((n, i) => n + i.count, 0)
      for (let i = 0; i < 4 && food() < 6; i++) await step(bot, 'hunt', { count: 2, radius: 48 })
    } else {
      await step(bot, 'upgrade_tools', { up_to: 'iron', armour: true, kinds: ['pickaxe', 'sword'] })
    }
    log(`prepared: ${state(bot)}`)
  } else {
    while (!isNight(bot)) { log(`waiting for night: ${state(bot)}`); await pause(20_000) }
    await walkThere(bot)
    log(`measuring ${mins} min (${tag}): ${state(bot)}`)
    measuring = true
    lifeStart = Date.now()
    const until = Date.now() + Number(mins) * 60_000
    let lastPatrol = 0
    let lastDeaths = 0
    while (Date.now() < until) {
      await pause(5000)
      if (!bot.bot?.entity) continue
      if (stats.deaths > lastDeaths) {
        // after a death: get the gear back and walk out again, the same for every version
        lastDeaths = stats.deaths
        await pause(3000)
        while (bot.currentAction) await pause(1000)
        await step(bot, 'goto_death', { pickup: true })
        await walkThere(bot)
        continue
      }
      if (!bot.currentAction && Date.now() - lastPatrol > 20_000) {
        // wander inside a 12-block circle so mobs find it
        lastPatrol = Date.now()
        const a = Math.random() * Math.PI * 2
        void step(bot, 'goto', { x: Math.round(X + Math.cos(a) * 8), z: Math.round(Z + Math.sin(a) * 8) })
      }
      log(state(bot))
    }
    measuring = false
    const alive = stats.aliveMs.concat(Date.now() - lifeStart)
    const result = { tag, at: new Date().toISOString(), minutes: Number(mins), kills: stats.kills, killed: stats.killed, deaths: stats.deaths, hits: stats.hits, damageTaken: Math.round(stats.damage), avgLifeS: Math.round(alive.reduce((a, b) => a + b, 0) / alive.length / 1000), endState: state(bot) }
    log(`RESULT ${JSON.stringify(result)}`)
    appendFileSync(`${DATA}/results.jsonl`, JSON.stringify(result) + '\n')
  }
  await bot.stop()
  await tester.stop()
}

main().then(() => process.exit(0), e => { console.error(e); process.exit(1) })
