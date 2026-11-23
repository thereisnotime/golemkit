// Live test of light_up / light_home on a real server.
//   node --env-file=.env scripts/light-test.ts [x z]     default 1600 445
// DIRECTOR (default ClaudeTest, an op) is only used for teleports (/execute ... positioned over
// motion_blocking_no_leaves run tp puts a player on the surface), /give and cleanup. It checks the spot is 300+ blocks from spawn, the fortress,
// the village and every other online player. LIGHT_BOT (default LightTest) then:
//   1. light_up dry_run around the spot (radius 10, target 8): the dark spots, the plan, whether
//      the chunks carry real light data
//   2. light_up with nothing to make torches from: fails with the reason
//   3. with 12 oak logs and 8 cobblestone (no coal): charcoal path, places up to 6 torches, then the rest
//   5. one of its torches broken (by the test bot itself): the next dry run leaves that spot alone
//   6. light_home armed (home here, by day only): runs on its own and checks the area
// FARM=1 instead builds a 9x9 wheat farm on the dry patch (/fill: water in the middle, farmland,
// ripe wheat), saves it as the test bot's farm:1, puts a learned protected zone over it in
// memory (what blocked Pax's farm), and from 12 blocks out runs light_up place=farm:1: a dry
// run, then with 16 torches. It checks no torch is on the field and no farmland was trampled,
// then puts every block of the farm back as it was.
// Every block that appears near the spot while it runs (torches, crafting table, furnace) is
// removed at the end with /setblock air; inventories are cleared and drops killed.
import { rmSync } from 'node:fs'
import { Agent, defineVariant, serverFromEnv, PRIORITY, fmtPos, type ActionResult } from '../src/core/index.ts'
import { standardSkills, extendedSkills, navigation } from '../src/skills/index.ts'
import { behaviorsBrain } from '../src/brains/index.ts'
import { ownTorches } from '../src/skills/lighting.ts'
import { saveFarm } from '../src/skills/food.ts'

const argv = process.argv.slice(2)
const X = Number(argv[0] ?? 1600)
const Z = Number(argv[1] ?? 445)
const BOT = process.env.LIGHT_BOT || 'LightTest'
const DIRECTOR = process.env.DIRECTOR || 'ClaudeTest'
const DATA = 'data/light-test'
const KEEP_AWAY: [string, number, number][] = [['spawn', 545, 45], ['village', -2770, 1090], ['fortress', 560, -43]]
const t0 = Date.now()
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`)
const pause = (ms: number) => new Promise(r => setTimeout(r, ms))

async function connect (agent: Agent, minutes = 3): Promise<void> {
  const ready = new Promise<boolean>(resolve => {
    const to = setTimeout(() => resolve(false), minutes * 60_000)
    agent.once('session', () => { clearTimeout(to); setTimeout(() => resolve(true), 4000) })
  })
  void agent.start().catch(() => {})
  if (!await ready) { await agent.stop().catch(() => {}); throw new Error(`${agent.username} could not connect`) }
}

async function main (): Promise<void> {
  for (const [name, x, z] of KEEP_AWAY) if (Math.hypot(X - x, Z - z) < 300) throw new Error(`${X} ${Z} is within 300 blocks of the ${name}`)
  rmSync(`${DATA}/agents`, { recursive: true, force: true })
  const variant = defineVariant({ name: 'light-test', skills: [...standardSkills(), navigation(), ...extendedSkills()], brains: [behaviorsBrain({ defaults: {} })] })
  const a = new Agent(variant, serverFromEnv(), { username: BOT, dataDir: DATA, canDig: true, owners: [] }) // canDig only for the test's own break_block; light_up never digs
  a.on('actionEnd', (info: any, r: ActionResult) => { if (info.caller?.name !== 'light-test') log(`${r.ok ? 'done' : 'FAIL'} ${info.name} (${info.caller.kind}:${info.caller.name}): ${r.message}`) })
  await connect(a)

  // The director account is shared with other tests: only log it in while nobody else uses it
  // (a second login kicks the first), and only for short bursts of commands.
  const withDirector = async (fn: (cmd: (c: string) => Promise<void>, replies: string[]) => Promise<void>) => {
    for (let i = 0; i < 120 && a.bot.players[DIRECTOR]; i++) {
      if (i % 6 === 0) log(`${DIRECTOR} is online (another test); waiting`)
      await pause(5000)
    }
    if (a.bot.players[DIRECTOR]) throw new Error(`${DIRECTOR} stayed online; try later`)
    const dir = new Agent(defineVariant({ name: 'director', skills: [], brains: [] }), serverFromEnv(), { username: DIRECTOR, dataDir: `${DATA}/director` })
    const replies: string[] = []
    dir.on('serverMessage', m => { replies.push(m); if (replies.length > 80) replies.shift() })
    await connect(dir)
    // a refused command (kicked by another login of the same account): once more after its reconnect
    const cmd = async (c: string) => {
      let ok = await dir.command(c)
      if (!ok) { log(`command refused, retrying: ${c}`); await pause(15_000); ok = await dir.command(c) }
      if (!ok) log(`command refused: ${c}`)
      await pause(400)
    }
    try { await fn(cmd, replies) } finally { await dir.stop().catch(() => {}) }
  }

  // by day only (the behaviour runs by day, and a test bot without armour at night is a meal)
  while (a.bot.time.timeOfDay > 12000 && a.bot.time.timeOfDay < 23500) { log(`night (${a.bot.time.timeOfDay}); waiting for the morning`); await pause(30_000) }

  await withDirector(async (cmd, replies) => {
    // every other online player must be 300+ away
    for (const p of Object.keys(a.bot.players).filter(n => n !== DIRECTOR && n !== BOT)) {
      replies.length = 0
      await cmd(`/data get entity ${p} Pos`)
      let d: number | null = null
      for (let i = 0; i < 20; i++) {
        const line = replies.find(r => /has the following entity data|No entity was found/i.test(r))
        if (line) { const m = /\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/.exec(line); d = m ? Math.hypot(Number(m[1]) - X, Number(m[3]) - Z) : null; break }
        await pause(250)
      }
      log(`${p}: ${d === null ? 'unknown' : `${Math.round(d)} blocks away`}`)
      if (d !== null && d < 300) throw new Error(`${p} is ${Math.round(d)} blocks from the spot`)
    }
    await cmd(`/clear ${BOT}`)
    // the director (spectator or creative, no fall damage) goes first so the chunks load, then the
    // bot straight onto the surface; teleporting the bot to y 200 and down again killed it by fall
    // damage (the second teleport doesn't reset the fall on this server)
    await cmd(`/tp ${DIRECTOR} ${X + 0.5} 150 ${Z + 0.5}`)
    await pause(4000)
    replies.length = 0
    await cmd(`/execute positioned ${X} 0 ${Z} positioned over motion_blocking_no_leaves run tp ${BOT} ~0.5 ~ ~0.5`)
    await pause(2000)
    log(`server: ${replies.join(' | ')}`)
  })
  await pause(6000)
  const step = async (name: string, params: Record<string, unknown> = {}): Promise<ActionResult> => {
    const t = Date.now()
    const r = await a.act(name, params, { caller: { kind: 'system', name: 'light-test' }, priority: PRIORITY.player })
    log(`${r.ok ? 'OK  ' : 'FAIL'} ${name} ${JSON.stringify(params)} (${((Date.now() - t) / 1000).toFixed(1)}s): ${r.message}`)
    return r
  }
  // X Z may be water: the nearest dry, open patch (11 x 11 of solid ground, nothing above) within the loaded chunks
  const land = (): { x: number, z: number } | null => {
    const me = a.bot.entity.position.floored()
    const at = (x: number, y: number, z: number) => a.bot.blockAt(me.clone().set(x, y, z))
    const top = (x: number, z: number): string | null => {
      for (let y = 120; y > 40; y--) { const b = at(x, y, z); if (!b) return null; if (b.name !== 'air' && b.name !== 'cave_air' && b.name !== 'short_grass') return b.name }
      return null
    }
    const dry = (x: number, z: number) => { const t = top(x, z); return !!t && /^(grass_block|dirt|sand|stone|gravel|podzol|coarse_dirt|snow_block|red_sand|terracotta)$/.test(t) }
    for (let r = 0; r <= 80; r += 4) {
      for (let dx = -r; dx <= r; dx += 4) {
        for (const dz of [-r, r]) {
          const x = me.x + dx, z = me.z + dz
          let ok = true
          for (let i = -5; i <= 5 && ok; i += 5) for (let j = -5; j <= 5 && ok; j += 5) ok = dry(x + i, z + j)
          if (ok) return { x, z }
        }
      }
    }
    return null
  }
  const here = a.bot.entity.position
  if (Math.hypot(here.x - X, here.z - Z) > 32) { await a.stop(); throw new Error(`not at the spot (at ${fmtPos(here)}; died on the teleport?)`) }
  const dryAt = land()
  if (!dryAt) {
    const me = a.bot.entity.position.floored()
    const tops: string[] = []
    for (let i = -8; i <= 8; i += 8) for (let j = -8; j <= 8; j += 8) for (let y = 120; y > 40; y--) { const b = a.bot.blockAt(me.offset(i, y - me.y, j)); if (!b) { tops.push('unloaded'); break } if (!/^(air|cave_air|short_grass)$/.test(b.name)) { tops.push(`${b.name}@${y}`); break } }
    log(`tops around ${fmtPos(me)}: ${tops.join(', ')}`)
    await a.stop(); throw new Error('no dry land within 80 blocks')
  }
  // everything that appears near the spot, for cleanup
  const placed = new Map<string, { x: number, y: number, z: number, name: string }>()
  a.bot.on('blockUpdate', (old: any, now: any) => {
    if (!now || !/(torch|crafting_table|furnace)$/.test(now.name) || (old && old.name === now.name)) return
    if (Math.hypot(now.position.x - dryAt.x, now.position.z - dryAt.z) > 40) return
    placed.set(`${now.position.x},${now.position.y},${now.position.z}`, { x: now.position.x, y: now.position.y, z: now.position.z, name: now.name })
  })
  if (process.env.FARM === '1') return farmTest(a, dryAt, step, withDirector, placed)
  // one short director session: onto the dry patch, the checks that need an empty inventory, then the wood
  let spot = a.bot.entity.position.floored()
  let base = { x: spot.x, y: spot.y, z: spot.z, radius: 10, y_range: 4, target: 8 }
  await withDirector(async cmd => {
    await cmd(`/execute positioned ${dryAt.x} 0 ${dryAt.z} positioned over motion_blocking_no_leaves run tp ${BOT} ~0.5 ~ ~0.5`)
    await pause(4000)
    spot = a.bot.entity.position.floored()
    log(`spot ${fmtPos(spot)}, time ${a.bot.time.timeOfDay}`)
    for (const [name, x, z] of KEEP_AWAY) if (Math.hypot(spot.x - x, spot.z - z) < 300) throw new Error(`landed within 300 of the ${name}`)
    base = { x: spot.x, y: spot.y, z: spot.z, radius: 10, y_range: 4, target: 8 }
    const dry = await step('light_up', { ...base, dry_run: true })
    log(`dry run data: ${JSON.stringify({ ...(dry.data as object), torches: undefined })}`)
    await step('light_up', { ...base, max_torches: 6 })
    await cmd(`/give ${BOT} minecraft:oak_log 12`)
    await cmd(`/give ${BOT} minecraft:cobblestone 8`)
  })
  await pause(1500)

  try {
    const r3 = await step('light_up', { ...base, max_torches: 6 })
    log(`inventory: ${a.bot.inventory.items().map(i => `${i.count} ${i.name}`).join(', ')}`)
    log(`own torches: ${ownTorches(a).length}; ${(r3.data as any)?.placed?.length ?? 0} from charcoal`)
    await step('light_up', { ...base, max_torches: 16 })
    const own = ownTorches(a)
    log(`own torches: ${own.length}; inventory: ${a.bot.inventory.items().map(i => `${i.count} ${i.name}`).join(', ')}`)
    const after = await step('light_up', { ...base, dry_run: true })
    log(`after: ${JSON.stringify({ ...(after.data as object), torches: undefined })}`)
    if (own[0]) {
      // the "owner" takes one away (the test bot breaks it; light_up itself never breaks anything)
      await step('break_block', { x: own[0].x, y: own[0].y, z: own[0].z })
      await pause(1000)
      const gone = await step('light_up', { ...base, dry_run: true })
      const planned = ((gone.data as any)?.torches ?? []) as { x: number, y: number, z: number }[]
      log(`after taking ${fmtPos(own[0])} away: gone ${(gone.data as any)?.gone}, planned there again: ${planned.some(t => t.x === own[0]!.x && t.y === own[0]!.y && t.z === own[0]!.z)}`)
    }
    // the behaviour on its own (by day only)
    await step('set_home')
    await step('behavior_arm', { name: 'light_home', options: { radius: 14, farms: false, target: 8, maxTorches: 8, everyMinutes: 5 } })
    const until = Date.now() + 3 * 60_000
    while (Date.now() < until) {
      await pause(15_000)
      const cur = a.currentAction ? a.currentAction.name : 'idle'
      log(`${cur}; checked ${JSON.stringify(a.storage.get('lighting.checked', {}))}; own torches ${ownTorches(a).length}`)
      if (Object.keys(a.storage.get('lighting.checked', {})).length) break
    }
    await step('behavior_disarm', { name: 'light_home' })
  } finally {
    log(`removing ${placed.size} blocks: ${[...placed.values()].map(p => `${p.name} ${p.x} ${p.y} ${p.z}`).join(', ')}`)
    for (const p of ownTorches(a)) placed.set(`${p.x},${p.y},${p.z}`, { ...p, name: 'torch' })
    await withDirector(async cmd => {
      for (const p of placed.values()) await cmd(`/setblock ${p.x} ${p.y} ${p.z} minecraft:air`)
      await cmd(`/kill @e[type=minecraft:item,x=${spot.x},y=${spot.y},z=${spot.z},distance=..48]`)
      await cmd(`/clear ${BOT}`)
    })
    await pause(1500)
    let left = 0
    for (const p of placed.values()) {
      const b = a.bot.blockAt(a.bot.entity.position.clone().set(p.x, p.y, p.z))
      if (b && b.name !== 'air') { left++; log(`still there: ${b.name} at ${p.x} ${p.y} ${p.z}`) }
    }
    log(`cleanup: ${placed.size - left} removed, ${left} left`)
    a.storage.flush()
    await a.stop()
  }
}

type Director = (fn: (cmd: (c: string) => Promise<void>, replies: string[]) => Promise<void>) => Promise<void>

async function farmTest (a: Agent, dryAt: { x: number, z: number }, step: (n: string, p?: Record<string, unknown>) => Promise<ActionResult>,
  withDirector: Director, placed: Map<string, { x: number, y: number, z: number, name: string }>): Promise<void> {
  const blockAt = (x: number, y: number, z: number) => a.bot.blockAt(a.bot.entity.position.clone().set(x, y, z))
  // the bot may have died on the way (and respawned at the world spawn): check where the farm goes
  for (const [name, x, z] of KEEP_AWAY) if (Math.hypot(dryAt.x - x, dryAt.z - z) < 300) throw new Error(`the farm would be within 300 of the ${name} (${dryAt.x} ${dryAt.z})`)
  // the farm's ground level: the top solid block at the middle
  let g = 0
  for (let y = 120; y > 40; y--) { const b = blockAt(dryAt.x, y, dryAt.z); if (b && b.boundingBox === 'block') { g = y; break } }
  const X = dryAt.x, Z = dryAt.z
  // everything the farm overwrites (ground level to 3 above, 9x9), to put back afterwards
  const saved: { x: number, y: number, z: number, state: string }[] = []
  for (let x = X - 4; x <= X + 4; x++) {
    for (let z = Z - 4; z <= Z + 4; z++) {
      for (let y = g; y <= g + 3; y++) {
        const b = blockAt(x, y, z)
        if (!b) throw new Error(`not loaded at ${x} ${y} ${z}`)
        const props = Object.entries(b.getProperties() as Record<string, unknown>).map(([k, v]) => `${k}=${v}`).join(',')
        saved.push({ x, y, z, state: `minecraft:${b.name}${props ? `[${props}]` : ''}` })
      }
    }
  }
  const zone = { x: X + 4, y: g + 1, z: Z + 2, at: new Date().toISOString() }
  try {
    await withDirector(async cmd => {
      await cmd(`/execute positioned ${X + 12} 0 ${Z} positioned over motion_blocking_no_leaves run tp ${a.username} ~0.5 ~ ~0.5`)
      await pause(1500)
      await cmd(`/fill ${X - 4} ${g + 1} ${Z - 4} ${X + 4} ${g + 3} ${Z + 4} minecraft:air`)
      await cmd(`/fill ${X - 4} ${g} ${Z - 4} ${X + 4} ${g} ${Z + 4} minecraft:farmland[moisture=7]`)
      await cmd(`/fill ${X - 4} ${g + 1} ${Z - 4} ${X + 4} ${g + 1} ${Z + 4} minecraft:wheat[age=7]`)
      await cmd(`/setblock ${X} ${g + 1} ${Z} minecraft:air`)
      await cmd(`/setblock ${X} ${g} ${Z} minecraft:water`)
      await cmd(`/give ${a.username} minecraft:torch 16`)
    })
    await pause(3000)
    saveFarm(a, { name: 'farm:1', x: X, y: g, z: Z, size: 9, crop: 'wheat', created: Date.now(), dim: a.bot.game.dimension })
    // the false zone: in memory only, never written to the shared protected-areas file
    a.protectedAreas.zones.push(zone)
    const count = (name: string) => { let n = 0; for (let x = X - 4; x <= X + 4; x++) for (let z = Z - 4; z <= Z + 4; z++) if (blockAt(x, name === 'wheat' ? g + 1 : g, z)?.name === name) n++; return n }
    log(`farm at ${X} ${g} ${Z}: ${count('farmland')} farmland, ${count('wheat')} wheat; bot at ${fmtPos(a.bot.entity.position)}`)
    const dry = await step('light_up', { place: 'farm:1', radius: 12, target: 8, dry_run: true })
    log(`dry run data: ${JSON.stringify({ ...(dry.data as object), torches: undefined })}`)
    const r = await step('light_up', { place: 'farm:1', radius: 12, target: 8, max_torches: 16, craft: false })
    const torches = ((r.data as any)?.placed ?? []) as { x: number, y: number, z: number }[]
    const onField = torches.filter(t => Math.abs(t.x - X) <= 4 && Math.abs(t.z - Z) <= 4)
    log(`placed ${torches.length}: ${torches.map(t => fmtPos(t)).join(', ')}; on the field: ${onField.length}`)
    log(`after: ${count('farmland')} farmland, ${count('wheat')} wheat (80 of each before)`)
    const again = await step('light_up', { place: 'farm:1', radius: 12, target: 8, dry_run: true })
    log(`after, dry run: ${JSON.stringify({ ...(again.data as object), torches: undefined })}`)
  } finally {
    a.protectedAreas.zones = a.protectedAreas.zones.filter(z => z !== zone)
    for (const p of ownTorches(a)) placed.set(`${p.x},${p.y},${p.z}`, { ...p, name: 'torch' })
    log(`removing ${placed.size} torches, putting back ${saved.length} farm blocks`)
    await withDirector(async cmd => {
      for (const p of placed.values()) await cmd(`/setblock ${p.x} ${p.y} ${p.z} minecraft:air`)
      // clear above the ground, then the saved blocks bottom up, so plants go back onto their ground
      // (air above the ground is already back; at ground level it may have been a dip)
      await cmd(`/fill ${X - 4} ${g + 1} ${Z - 4} ${X + 4} ${g + 3} ${Z + 4} minecraft:air`)
      for (const b of [...saved].sort((p, q) => p.y - q.y)) if (b.y === g || !/^minecraft:(air|cave_air)$/.test(b.state)) await cmd(`/setblock ${b.x} ${b.y} ${b.z} ${b.state}`)
      await cmd(`/kill @e[type=minecraft:item,x=${X},y=${g},z=${Z},distance=..32]`)
      await cmd(`/clear ${a.username}`)
    })
    await pause(1500)
    let off = 0
    for (const b of saved) { const now = blockAt(b.x, b.y, b.z); if (now && !b.state.startsWith(`minecraft:${now.name}`)) { off++; if (off <= 5) log(`differs: ${b.x} ${b.y} ${b.z} ${now.name}, was ${b.state}`) } }
    for (const p of placed.values()) { const now = blockAt(p.x, p.y, p.z); if (now && now.name !== 'air') { off++; log(`still there: ${now.name} at ${p.x} ${p.y} ${p.z}`) } }
    log(`cleanup: ${off} blocks differ`)
    a.storage.flush()
    await a.stop()
  }
}

main().then(() => process.exit(0), e => { console.error(e); process.exit(1) })
