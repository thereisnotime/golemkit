// Controlled combat benchmark on a live server, with an op account as the director.
//   node scripts/arena-test.ts <x> <y> <z> [minutes] [tag] [gear]   (x y z: a spot on the ground)
//     gear: basic (stone sword, 8 bread; default) | iron (same plus an iron armour set in the inventory)
// FIGHT_BOT (default FightTest, survival, owner FIGHT_TESTER) walks to x/z and fights; DIRECTOR
// (default ClaudeTest, an op) gives the same gear after every death, teleports it back and summons
// waves of tagged mobs next to it: 2 zombies and a skeleton (leather helmets so daylight doesn't
// burn them), a spider, and a creeper every other wave, at most 6 alive at once. Only the reflexes
// brain runs (retreatBelow 0, like Pax). Kills = mobs that die within 4 s of the bot hitting them.
// Everything summoned is killed at the end. Results append to data/fight-test/results.jsonl.
import { appendFileSync, mkdirSync } from 'node:fs'
import { Agent, defineVariant, serverFromEnv, PRIORITY, fmtPos, type ActionResult } from '../src/core/index.ts'
import { standardSkills, extendedSkills, navigation } from '../src/skills/index.ts'
import { reflexes } from '../src/brains/index.ts'

const [xs = '699', ys = '109', zs = '201', mins = '10', tag = 'run', gear = 'basic'] = process.argv.slice(2)
const X = Number(xs)
const Y = Number(ys)
const Z = Number(zs)
const BOT = process.env.FIGHT_BOT || 'FightTest'
const OWNER = process.env.FIGHT_TESTER || 'FightTester'
const DIRECTOR = process.env.DIRECTOR || 'ClaudeTest'
const DATA = process.env.FIGHT_DATA_DIR || 'data/fight-test'
const TAG = 'fighttest'
const server = serverFromEnv()
const t0 = Date.now()
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`)
const pause = (ms: number) => new Promise(r => setTimeout(r, ms))

const variant = defineVariant({
  name: 'fight-test',
  skills: [...standardSkills(), navigation(), ...extendedSkills()],
  brains: [reflexes({ retreatBelow: 0, waterFightAbove: 0 })]
})

async function connect (agent: Agent): Promise<void> {
  const ready = new Promise<void>(resolve => agent.once('session', () => setTimeout(resolve, 4000)))
  void agent.start()
  await ready
}

function state (a: Agent): string {
  const b = a.bot
  const cur = a.currentAction ? a.currentAction.name : 'idle'
  const armour = [5, 6, 7, 8].map(i => b.inventory.slots[i]?.name).filter(Boolean).join('+') || 'no armour'
  return `at ${fmtPos(b.entity.position)} hp ${Math.round(b.health)} food ${b.food} | ${cur} | ${armour} | held ${b.heldItem?.name ?? '-'}`
}

const live = (a: Agent) => { try { return !!a.bot?.entity } catch { return false } }
async function waitLive (a: Agent): Promise<void> { while (!live(a)) await pause(1000) }

async function main (): Promise<void> {
  mkdirSync(DATA, { recursive: true })
  const bot = new Agent(variant, server, { username: BOT, dataDir: DATA, canDig: true, owners: [OWNER] })
  const dir = new Agent(defineVariant({ name: 'director', skills: standardSkills(), brains: [] }), server, { username: DIRECTOR, dataDir: `${DATA}-director` })
  const cmd = async (c: string) => { const ok = await dir.command(c); if (!ok) log(`command refused: ${c}`); await pause(400) }
  bot.on('actionEnd', (info: any, r: ActionResult) => {
    if (info.caller?.name !== 'arena') log(`${r.ok ? 'done' : 'FAIL'} ${info.name} (${info.caller.kind}): ${r.message}`)
  })

  const stats = { kills: 0, deaths: 0, hits: 0, damage: 0, summoned: 0, killed: {} as Record<string, number>, aliveMs: [] as number[] }
  let measuring = false
  let lifeStart = 0
  let died = false
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
    b.on('health', () => {
      if (b.health < last && measuring) {
        stats.damage += last - b.health
        const near = Object.values(b.entities).filter((e: any) => e !== b.entity && e.position && e.type !== 'object' && e.type !== 'orb' && e.position.distanceTo(b.entity.position) < 8)
          .map((e: any) => `${e.name}@${e.position.distanceTo(b.entity.position).toFixed(1)}`).join(' ')
        log(`hurt ${Math.round(last)} -> ${Math.round(b.health)} (${bot.currentAction?.name ?? 'idle'}) near: ${near || '-'}`)
      }
      last = b.health
    })
    b.on('death', () => {
      if (!measuring) return
      stats.deaths++
      stats.aliveMs.push(Date.now() - lifeStart)
      died = true
      log(`DEATH at ${fmtPos(b.entity.position)}`)
    })
  })
  await connect(bot)
  await connect(dir)
  await waitLive(bot)
  log(`spawned: ${state(bot)}`)

  const kit = async () => {
    await cmd(`/clear ${BOT}`)
    await cmd(`/give ${BOT} minecraft:stone_sword 1`)
    await cmd(`/give ${BOT} minecraft:bread 8`)
    if (gear === 'iron') for (const p of ['helmet', 'chestplate', 'leggings', 'boots']) await cmd(`/give ${BOT} minecraft:iron_${p} 1`)
    await cmd(`/effect clear ${BOT}`)
    await cmd(`/effect give ${BOT} minecraft:instant_health 1 10`)
    await cmd(`/effect give ${BOT} minecraft:saturation 1 10`)
  }
  await cmd(`/gamemode survival ${BOT}`)
  await cmd(`/tp ${BOT} ${X} ${Y} ${Z}`) // onto the ground: a teleport into the air gets kicked for flying
  await pause(3000)
  await waitLive(bot)
  const spot = bot.bot.entity.position.floored()
  log(`arena at ${fmtPos(spot)}`)
  await cmd(`/tp ${DIRECTOR} ${spot.x} ${spot.y + 40} ${spot.z}`) // creative, out of the way, keeps chunks loaded
  await kit()
  await pause(3000)
  log(`measuring ${mins} min (${tag}, gear ${gear}): ${state(bot)}`)
  measuring = true
  lifeStart = Date.now()
  const until = Date.now() + Number(mins) * 60_000
  let wave = 0
  let lastWave = 0
  while (Date.now() < until) {
    await pause(2000)
    if (!live(bot) || !live(dir)) continue // kicked (timeouts under load): the agent reconnects
    if (died) {
      died = false
      await pause(2500) // respawn
      await kit()
      await cmd(`/tp ${BOT} ${spot.x} ${spot.y} ${spot.z}`)
      lifeStart = Date.now()
      continue
    }
    const alive = Object.values(bot.bot.entities).filter((e: any) => e.type === 'hostile' && e.position.distanceTo(spot) < 40).length
    if (Date.now() - lastWave > 40_000 && alive < 6) {
      lastWave = Date.now()
      wave++
      const helmet = `{Tags:["${TAG}"],ArmorItems:[{},{},{},{id:"minecraft:leather_helmet",count:1}]}`
      const mobs: [string, string][] = [['zombie', helmet], ['zombie', helmet], ['skeleton', helmet], ['spider', `{Tags:["${TAG}"]}`]]
      if (wave % 2 === 0) mobs.push(['creeper', `{Tags:["${TAG}"]}`])
      for (const [m, nbt] of mobs) {
        const a = Math.random() * Math.PI * 2
        const r = 7 + Math.random() * 4
        await cmd(`/summon minecraft:${m} ${(spot.x + Math.cos(a) * r).toFixed(1)} ${spot.y + 1} ${(spot.z + Math.sin(a) * r).toFixed(1)} ${nbt}`)
        stats.summoned++
      }
      log(`wave ${wave}: ${mobs.map(m => m[0]).join(', ')} (${alive} already there)`)
    }
    // wandered off (chase, retreat): come back after a while like a bot heading home
    if (!bot.currentAction && bot.bot.entity.position.distanceTo(spot) > 6) {
      void bot.act('goto', { x: spot.x, y: spot.y, z: spot.z }, { caller: { kind: 'system', name: 'arena' }, priority: PRIORITY.player })
    }
  }
  measuring = false
  await waitLive(bot)
  const lives = stats.aliveMs.concat(Date.now() - lifeStart)
  const result = { tag, gear, at: new Date().toISOString(), minutes: Number(mins), waves: wave, summoned: stats.summoned, kills: stats.kills, killed: stats.killed, deaths: stats.deaths, hits: stats.hits, damageTaken: Math.round(stats.damage), avgLifeS: Math.round(lives.reduce((a, b) => a + b, 0) / lives.length / 1000), endState: state(bot) }
  log(`RESULT ${JSON.stringify(result)}`)
  appendFileSync(`${DATA}/results.jsonl`, JSON.stringify(result) + '\n')
  // clean up everything summoned, and the drops
  await cmd(`/kill @e[tag=${TAG}]`)
  await cmd(`/execute positioned ${spot.x} ${spot.y} ${spot.z} run kill @e[type=item,distance=..48]`)
  await cmd(`/execute positioned ${spot.x} ${spot.y} ${spot.z} run kill @e[type=arrow,distance=..48]`)
  await pause(1500)
  await bot.stop()
  await dir.stop()
}

main().then(() => process.exit(0), e => { console.error(e); process.exit(1) })
