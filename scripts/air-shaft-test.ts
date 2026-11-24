// Live test of the air reflex in a flooded 1x1 shaft while the bot smelts (Pax drowned in its own
// flooded bunker shaft by the farm while light_up smelted charcoal).
//   node scripts/air-shaft-test.ts <x> <z> [scenarios]   scenarios: smelt,window,noblocks (default all)
// SHAFT_BOT (default ShaftTest) is put on the surface at x/z (300+ blocks from spawn, the fortress,
// the village and online players). DIRECTOR (default ClaudeTest, an op) builds, in the air above
// it, a stone block with a 1x1 shaft: 3 water at the bottom, 2 air above it, so the rim is 2 blocks
// above the water. A furnace stands on the rim.
//   smelt     the bot floats in the shaft and is asked to smelt 2 spruce_log at the furnace on the
//             rim (it should refuse to smelt afloat); it sinks, gets air and climbs out
//   window    the bot stands on the rim and smelts; 2 s later it is /tp'd to the bottom of the
//             shaft with the furnace window still open
//   noblocks  dirt walls, only a shovel: it digs a step into the wall to get out
// smelt and window have a zombie drowning in a sealed pit next to the shaft: mineflayer used to
// read its air as the bot's.
// Every 250 ms it logs the bot's air as the bot sees it, the server's Air (/data get entity), the
// block at its eyes and the open window. Everything built is checked to be empty air before and
// filled with air afterwards. Only /gamemode, /spreadplayers, /tp, /fill, /setblock, /give, /clear,
// /effect, /summon (the zombie), /data get and /kill (items, the zombie) are used; never gamerules or time.
import { Agent, defineVariant, serverFromEnv, fmtPos, headInWater, oxygen, PRIORITY, type ActionResult } from '../src/core/index.ts'
import { standardSkills, navigation, crafting } from '../src/skills/index.ts'
import { reflexes } from '../src/brains/index.ts'

const [xs = '1100', zs = '400', which = 'smelt,window,noblocks'] = process.argv.slice(2)
const X = Number(xs)
const Z = Number(zs)
const BOT = process.env.SHAFT_BOT || 'ShaftTest'
const DIRECTOR = process.env.DIRECTOR || 'ClaudeTest'
const DATA = process.env.SHAFT_DATA_DIR || 'data/air-shaft-test'
const KEEP_AWAY = [{ name: 'spawn', x: 545, z: 45 }, { name: 'fortress', x: 560, z: -43 }, { name: 'village', x: -2770, z: 1090 }]
const server = serverFromEnv()
const t0 = Date.now()
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`)
const pause = (ms: number) => new Promise(r => setTimeout(r, ms))

const variant = defineVariant({
  name: 'air-shaft-test',
  skills: [...standardSkills(), navigation(), crafting()],
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
  let serverAir: number | null = null
  const director = async (): Promise<Agent> => {
    if (dir) return dir
    if (bot.bot?.players?.[DIRECTOR]) throw new Error(`${DIRECTOR} is online (another script or a person); not logging in`)
    const d = new Agent(defineVariant({ name: 'director', skills: standardSkills(), brains: [] }), server, { username: DIRECTOR, dataDir: `${DATA}-director` })
    await connect(d)
    d.bot.on('messagestr', (m: string) => {
      const air = /has the following entity data: (-?\d+)s/.exec(m)
      if (air) { serverAir = Number(air[1]); return }
      if (/Unknown|Incorrect|Expected|Could not|Unable|No entity|too many/i.test(m)) log(`server: ${m}`)
    })
    dir = d
    return d
  }
  const cmd = async (c: string, wait = 400) => {
    const d = await director()
    const ok = await d.command(c)
    if (!ok) log(`command refused: ${c}`)
    if (wait) await pause(wait)
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

  const at = (x: number, y: number, z: number) => g.clone().set(x, y, z)
  const empty = (b: Box) => {
    for (let x = b.x1; x <= b.x2; x++) for (let y = b.y1; y <= b.y2; y++) for (let z = b.z1; z <= b.z2; z++) {
      const k = bot.bot.blockAt(at(x, y, z))
      if (!k || k.name !== 'air') return `${k?.name ?? 'unloaded'} at ${x} ${y} ${z}`
    }
    return null
  }
  const fill = (b: Box, block: string) => cmd(`/fill ${b.x1} ${b.y1} ${b.z1} ${b.x2} ${b.y2} ${b.z2} minecraft:${block}`)
  const removeAll = async () => {
    await cmd(`/tp ${BOT} ${g.x + 0.5} ${g.y} ${g.z + 0.5}`)
    await cmd(`/kill @e[type=#minecraft:zombies,x=${g.x},y=${g.y + 8},z=${g.z},distance=..8]`)
    for (const b of built.splice(0)) { await fill(b, 'air'); log(`removed ${b.x1} ${b.y1} ${b.z1} .. ${b.x2} ${b.y2} ${b.z2}`) }
    await cmd(`/kill @e[type=item,x=${g.x},y=${g.y},z=${g.z},distance=..24]`)
  }

  // the shaft: a 5x5 block from B to B+5, the shaft at the middle column: water B+1..B+3, air
  // B+4..B+5; the rim is the top of the block (standing at B+6); the furnace on the rim east of the
  // shaft. zombie: a sealed water pit two blocks south with a zombie drowning in it (its air used
  // to be read as the bot's).
  const B = g.y + 8
  const c = { x: g.x, z: g.z }
  const outer: Box = { x1: c.x - 2, y1: B, z1: c.z - 2, x2: c.x + 2, y2: B + 7, z2: c.z + 2 }
  const build = async (o: { walls?: string, zombie?: boolean } = {}): Promise<boolean> => {
    const why = empty(outer)
    if (why) { results.push(`shaft: not empty (${why})`); return false }
    built.push(outer)
    await fill({ ...outer, y2: B + 5 }, o.walls ?? 'stone')
    await fill({ x1: c.x, y1: B + 1, z1: c.z, x2: c.x, y2: B + 3, z2: c.z }, 'water')
    await fill({ x1: c.x, y1: B + 4, z1: c.z, x2: c.x, y2: B + 5, z2: c.z }, 'air')
    await cmd(`/setblock ${c.x + 1} ${B + 6} ${c.z} minecraft:furnace`)
    if (o.zombie) {
      await fill({ x1: c.x, y1: B + 1, z1: c.z + 2, x2: c.x, y2: B + 4, z2: c.z + 2 }, 'water')
      await cmd(`/setblock ${c.x} ${B + 5} ${c.z + 2} minecraft:glass`)
      await cmd(`/summon minecraft:zombie ${c.x + 0.5} ${B + 1} ${c.z + 2.5}`)
    }
    return true
  }
  const stock = async (blocks = true) => {
    await cmd(`/clear ${BOT}`)
    // Pax carried stone tools; the step into the wall and the furnace above it want a pickaxe
    await cmd(`/give ${BOT} minecraft:stone_pickaxe 1`)
    if (blocks) {
      await cmd(`/give ${BOT} minecraft:spruce_log 4`)
      await cmd(`/give ${BOT} minecraft:spruce_planks 8`)
      await cmd(`/give ${BOT} minecraft:cobblestone 16`)
    } else {
      await cmd(`/give ${BOT} minecraft:stone_shovel 1`)
    }
    await cmd(`/effect give ${BOT} minecraft:instant_health 1 5`)
  }

  // watch: the bot's air, the server's, the eyes and the window, until the air action ends or 60 s
  const watch = async (name: string, start: () => void) => {
    let airEnded: string | null = null
    let firedAt: number | null = null
    const onStart = (info: any) => { if (info.name === 'air' && firedAt === null) firedAt = oxygen(bot.bot) }
    const onEnd = (info: any, r: ActionResult) => { if (info.name === 'air') airEnded = `${r.ok ? 'ok' : 'failed'}: ${r.message}` }
    bot.on('actionStart', onStart)
    bot.on('actionEnd', onEnd)
    start()
    const until = Date.now() + 60_000
    let minAir = 20
    let minHp = 20
    let lastQuery = 0
    while (Date.now() < until && !died) {
      const b = bot.bot
      if (Date.now() - lastQuery > 1000) { lastQuery = Date.now(); void cmd(`/data get entity ${BOT} Air`, 0) }
      minAir = Math.min(minAir, oxygen(b))
      minHp = Math.min(minHp, b.health)
      const e = b.entity
      const eye = b.blockAt(e.position.offset(0, 1.62, 0)) as any
      const props = eye?.getProperties?.() ?? {}
      log(`  ${name}: ${e.position.x.toFixed(2)} ${e.position.y.toFixed(2)} ${e.position.z.toFixed(2)} air ${oxygen(b)} server ${serverAir === null ? '?' : (serverAir / 15).toFixed(1)} hp ${b.health.toFixed(1)} eyes ${eye?.name}${props.level !== undefined ? `(${props.level})` : ''} inWater ${headInWater(b)} window ${b.currentWindow?.type ?? '-'} | ${bot.currentAction?.name ?? 'idle'}`)
      if (airEnded && !bot.currentAction) break
      await pause(250)
    }
    bot.off('actionStart', onStart)
    bot.off('actionEnd', onEnd)
    results.push(`${name}: ${died ? 'DIED' : airEnded ?? 'air never ended'}; air reflex fired at ${firedAt ?? 'never'}; lowest air ${minAir}, lowest health ${minHp.toFixed(1)}; ends at ${fmtPos(bot.bot.entity.position)}`)
  }
  // after whatever reflex is running (the zombie draws a defend): smelting at npc priority waits for it
  const smelt = () => {
    void (async () => {
      const until = Date.now() + 15_000
      while (bot.currentAction && Date.now() < until) await pause(100)
      const r = await bot.act('smelt', { item: 'spruce_log', count: 2 }, { caller: { kind: 'brain', name: 'test' }, priority: PRIORITY.npc })
      log(`smelt: ${r.ok ? 'ok' : 'failed'}: ${r.message}`)
    })()
  }
  const out = () => {
    const p = bot.bot.entity.position
    return p.y >= B + 6 - 0.01 ? 'out on the rim' : `still in the shaft (y ${p.y.toFixed(1)})`
  }

  // smelt: afloat in the shaft, asked to smelt at the furnace on the rim; a drowning zombie next door
  if (which.includes('smelt') && await build({ zombie: true })) {
    await stock()
    await cmd(`/tp ${BOT} ${c.x + 0.5} ${B + 3} ${c.z + 0.5}`)
    await pause(500)
    await watch('smelt', smelt)
    results.push(`smelt: ${out()}`)
    await removeAll()
  }
  // window: smelting on the rim, put at the bottom of the shaft with the furnace window open
  if (which.includes('window') && !died && await build({ zombie: true })) {
    await stock()
    await cmd(`/tp ${BOT} ${c.x - 0.5} ${B + 6} ${c.z + 0.5}`)
    await pause(1000)
    await watch('window', () => {
      smelt()
      setTimeout(() => { void cmd(`/tp ${BOT} ${c.x + 0.5} ${B + 1} ${c.z + 0.5}`, 0) }, 2500)
    })
    results.push(`window: ${out()}`)
    await removeAll()
  }
  // noblocks: dirt walls, a shovel and nothing to build with: digs a step into the wall
  if (which.includes('noblocks') && !died && await build({ walls: 'dirt' })) {
    await stock(false)
    await cmd(`/tp ${BOT} ${c.x + 0.5} ${B + 1} ${c.z + 0.5}`)
    await watch('noblocks', () => {})
    results.push(`noblocks: ${out()}`)
    await removeAll()
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
