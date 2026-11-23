// Live test of the air reflex on a real server, with an op account as the director.
//   node scripts/air-test.ts <x> <z> [scenarios]   scenarios: ice,roof (default both)
// AIR_BOT (default AirTest) is put on the surface at x/z (300+ blocks from spawn, the fortress,
// the village and online players). DIRECTOR (default ClaudeTest, an op) builds a small water tank
// in the air above it with /fill, /tp's the bot to the bottom and watches:
//   ice    4 deep, an ice ceiling over all of it: breaks the ice above its head and surfaces
//   roof   4 deep, a stone roof with one opening 4 blocks to the side: swims to the opening
// The bot has no tools (ice by hand). Every tank is checked to be empty air before it is built and
// filled with air afterwards. Only /gamemode, /spreadplayers, /tp, /fill, /clear, /effect and
// /kill (items) are used; never gamerules or time. If the bot dies the script cleans up and stops.
import { Agent, defineVariant, serverFromEnv, fmtPos, headInWater, oxygen, type ActionResult } from '../src/core/index.ts'
import { standardSkills, navigation } from '../src/skills/index.ts'
import { reflexes } from '../src/brains/index.ts'

const [xs = '1100', zs = '400', which = 'ice,roof'] = process.argv.slice(2)
const X = Number(xs)
const Z = Number(zs)
const BOT = process.env.AIR_BOT || 'AirTest'
const DIRECTOR = process.env.DIRECTOR || 'ClaudeTest'
const DATA = process.env.AIR_DATA_DIR || 'data/air-test'
const KEEP_AWAY = [{ name: 'spawn', x: 545, z: 45 }, { name: 'fortress', x: 560, z: -43 }, { name: 'village', x: -2770, z: 1090 }]
const server = serverFromEnv()
const t0 = Date.now()
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`)
const pause = (ms: number) => new Promise(r => setTimeout(r, ms))

const variant = defineVariant({
  name: 'air-test',
  skills: [...standardSkills(), navigation()],
  brains: [reflexes({ retreatBelow: 0, waterFightAbove: 0 })]
})

async function connect (agent: Agent): Promise<void> {
  const ready = new Promise<void>(resolve => agent.once('session', () => setTimeout(resolve, 4000)))
  void agent.start()
  await ready
}

interface Box { x1: number, y1: number, z1: number, x2: number, y2: number, z2: number }

async function main (): Promise<void> {
  const near = KEEP_AWAY.find(p => Math.hypot(p.x - X, p.z - Z) < 300)
  if (near) { log(`${X} ${Z} is within 300 blocks of the ${near.name}; pick another spot`); return }
  const bot = new Agent(variant, server, { username: BOT, dataDir: DATA, canDig: true, owners: [DIRECTOR] })
  let dir = null as Agent | null
  const director = async (): Promise<Agent> => {
    if (dir) return dir
    if (bot.bot?.players?.[DIRECTOR]) throw new Error(`${DIRECTOR} is online (another script or a person); not logging in`)
    const d = new Agent(defineVariant({ name: 'director', skills: standardSkills(), brains: [] }), server, { username: DIRECTOR, dataDir: `${DATA}-director` })
    await connect(d)
    d.bot.on('messagestr', (m: string) => { if (/Unknown|Incorrect|Expected|Could not|Unable|No entity|too many/i.test(m)) log(`server: ${m}`) })
    dir = d
    return d
  }
  const cmd = async (c: string) => {
    const d = await director()
    const ok = await d.command(c)
    if (!ok) log(`command refused: ${c}`)
    await pause(400)
  }
  let died = false
  bot.on('actionEnd', (info: any, r: ActionResult) => log(`${r.ok ? 'done' : 'FAIL'} ${info.name} (${info.caller.kind}:${info.caller.name}): ${r.message}`))
  bot.on('actionStart', (info: any) => log(`start ${info.name} (${info.caller.kind}:${info.caller.name})`))
  await connect(bot)
  bot.bot.on('death', () => { died = true; log('THE TEST BOT DIED') })

  const players = Object.values(bot.bot.players).filter(p => p.username !== BOT)
  log(`online: ${players.map(p => p.username).join(', ') || 'nobody else'}`)
  if (bot.bot.players[DIRECTOR]) { log(`${DIRECTOR} is online; stopping`); await bot.stop(); return }
  const close = players.filter(p => p.entity && Math.hypot(p.entity.position.x - X, p.entity.position.z - Z) < 300)
  if (close.length) { log(`players near the test spot (${close.map(p => p.username).join(', ')}); stopping`); await bot.stop(); return }

  await cmd(`/gamemode survival ${BOT}`)
  await cmd(`/clear ${BOT}`)
  await cmd(`/spreadplayers ${X} ${Z} 0 1 false ${BOT}`)
  await pause(3000)
  const g = bot.bot.entity.position.floored()
  log(`test bot on the ground at ${fmtPos(g)}`)
  if (Math.hypot(g.x - X, g.z - Z) > 20) { log('not where it should be; stopping'); await (dir as Agent | null)?.stop(); await bot.stop(); return }
  const results: string[] = []
  const built: Box[] = []

  const empty = (b: Box) => {
    for (let x = b.x1; x <= b.x2; x++) for (let y = b.y1; y <= b.y2; y++) for (let z = b.z1; z <= b.z2; z++) {
      const k = bot.bot.blockAt(g.clone().set(x, y, z))
      if (!k || k.name !== 'air') return `${k?.name ?? 'unloaded'} at ${x} ${y} ${z}`
    }
    return null
  }
  const fill = (b: Box, block: string) => cmd(`/fill ${b.x1} ${b.y1} ${b.z1} ${b.x2} ${b.y2} ${b.z2} minecraft:${block}`)
  const removeAll = async () => {
    await cmd(`/tp ${BOT} ${g.x + 0.5} ${g.y} ${g.z + 0.5}`)
    for (const b of built.splice(0)) { await fill(b, 'air'); log(`removed ${b.x1} ${b.y1} ${b.z1} .. ${b.x2} ${b.y2} ${b.z2}`) }
    await cmd(`/kill @e[type=item,x=${g.x},y=${g.y},z=${g.z},distance=..24]`)
  }

  // watch until the air action ends with the air back, the bot dies, or 90 s pass
  const watch = async (name: string, check: () => string) => {
    let airEnded: string | null = null
    const onEnd = (info: any, r: ActionResult) => { if (info.name === 'air') airEnded = `${r.ok ? 'ok' : 'failed'}: ${r.message}` }
    bot.on('actionEnd', onEnd)
    const until = Date.now() + 90_000
    let minAir = 20
    let minHp = 20
    while (Date.now() < until && !died) {
      const b = bot.bot
      minAir = Math.min(minAir, oxygen(b))
      minHp = Math.min(minHp, b.health)
      log(`  ${name}: ${fmtPos(b.entity.position)} air ${oxygen(b)} hp ${b.health.toFixed(1)} head in water ${headInWater(b)} | ${bot.currentAction?.name ?? 'idle'}`)
      if (airEnded && !bot.currentAction) break
      await pause(1000)
    }
    bot.off('actionEnd', onEnd)
    results.push(`${name}: ${died ? 'DIED' : airEnded ?? 'air never ended'}; lowest air ${minAir}, lowest health ${minHp.toFixed(1)}; ${check()}`)
  }

  const tank = async (name: string, outer: Box, water: Box, lid: Box | null, lidBlock: string, opening: { x: number, y: number, z: number } | null) => {
    const why = empty(outer)
    if (why) { results.push(`${name}: skipped, not empty (${why})`); return }
    built.push(outer)
    await fill(outer, 'stone')
    await fill(water, 'water')
    if (lid) await fill(lid, lidBlock)
    if (opening) await cmd(`/setblock ${opening.x} ${opening.y} ${opening.z} minecraft:air`)
    await cmd(`/effect give ${BOT} minecraft:instant_health 1 5`)
    log(`${name}: bot at the bottom of the tank`)
  }

  const B = g.y + 8
  if (which.includes('ice')) {
    // 5x5 water, 4 deep, ice over all of it; the bot in the middle
    const c = { x: g.x, z: g.z }
    const outer = { x1: c.x - 3, y1: B, z1: c.z - 3, x2: c.x + 3, y2: B + 5, z2: c.z + 3 }
    await tank('ice', outer, { x1: c.x - 2, y1: B + 1, z1: c.z - 2, x2: c.x + 2, y2: B + 4, z2: c.z + 2 }, { x1: c.x - 2, y1: B + 5, z1: c.z - 2, x2: c.x + 2, y2: B + 5, z2: c.z + 2 }, 'ice', null)
    if (built.length) {
      // the bot was put in the corner (x1, z1): move it under the middle
      await cmd(`/tp ${BOT} ${c.x + 0.5} ${B + 1} ${c.z + 0.5}`)
      await watch('ice', () => {
        const holes = []
        for (let x = c.x - 2; x <= c.x + 2; x++) for (let z = c.z - 2; z <= c.z + 2; z++) if (bot.bot.blockAt(g.clone().set(x, B + 5, z))?.name !== 'ice') holes.push(`${x} ${z}`)
        return `ice gone at ${holes.join(', ') || 'nowhere'}; ends at ${fmtPos(bot.bot.entity.position)}`
      })
      await removeAll()
    }
  }
  if (which.includes('roof') && !died) {
    // 9x3 water, 4 deep, a stone roof with an opening 4 blocks east of the bot
    const c = { x: g.x, z: g.z }
    const outer = { x1: c.x - 2, y1: B, z1: c.z - 2, x2: c.x + 8, y2: B + 5, z2: c.z + 2 }
    const opening = { x: c.x + 4, y: B + 5, z: c.z }
    await tank('roof', outer, { x1: c.x - 1, y1: B + 1, z1: c.z - 1, x2: c.x + 7, y2: B + 4, z2: c.z + 1 }, null, 'stone', opening)
    if (built.length) {
      await cmd(`/tp ${BOT} ${c.x + 0.5} ${B + 1} ${c.z + 0.5}`)
      await watch('roof', () => {
        const roofBroken = []
        for (let x = c.x - 1; x <= c.x + 7; x++) for (let z = c.z - 1; z <= c.z + 1; z++) if (!(x === opening.x && z === opening.z) && bot.bot.blockAt(g.clone().set(x, B + 5, z))?.name !== 'stone') roofBroken.push(`${x} ${z}`)
        return `roof broken at ${roofBroken.join(', ') || 'nowhere'}; ends at ${fmtPos(bot.bot.entity.position)}`
      })
      await removeAll()
    }
  }
  if (built.length) await removeAll()
  await cmd(`/clear ${BOT}`)
  log('RESULTS')
  for (const r of results) log(r)
  bot.storage.flush()
  await (dir as Agent | null)?.stop().catch(() => {})
  await bot.stop()
}

main().then(() => process.exit(0), e => { console.error(e); process.exit(1) })
