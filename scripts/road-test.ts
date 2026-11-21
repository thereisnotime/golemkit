// Live test of roads on a real server (creative op account, commands method):
//   node scripts/road-test.ts [x z]
// Teleports ROAD_BOT (default ClaudeTest) near x z (default 1400 1400), looks for a hilly patch
// with two flat hut sites at different heights, builds two huts with `build method=commands`,
// joins them with `connect_buildings method=commands`, prints the road's profile and the
// walkability check, then removes the road and the huts (ROAD_KEEP=true keeps everything).
// Every op command shows to other ops: the run keeps them to a few dozen /fill runs.
import { Agent, defineVariant, serverFromEnv, PRIORITY, configureLogging, loggingFromEnv, type ActionResult } from '../src/core/index.ts'
import { standardSkills, extendedSkills } from '../src/skills/index.ts'
import { getPlacements } from '../src/skills/construction.ts'
import { getRoads } from '../src/skills/roads.ts'
import { isNaturalBlock, facingToward } from '../src/skills/blueprint.ts'

const [xs = '1400', zs = '1400'] = process.argv.slice(2)
const CX = Number(xs)
const CZ = Number(zs)
const BOT = process.env.ROAD_BOT || 'ClaudeTest'
const KEEP = process.env.ROAD_KEEP === 'true'
configureLogging(loggingFromEnv())
const t0 = Date.now()
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`)
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

const agent = new Agent(defineVariant({ name: 'road-test', skills: [...standardSkills(), ...extendedSkills()], brains: [] }), serverFromEnv(), {
  username: BOT, dataDir: 'data/road-test', canDig: true
})
const once = () => new Promise<void>(resolve => agent.once('session', () => setTimeout(resolve, 4000)))

async function step (name: string, params: Record<string, unknown> = {}): Promise<ActionResult> {
  for (let attempt = 0; ; attempt++) {
    const t = Date.now()
    const r = await agent.act(name, params, { caller: { kind: 'system', name: 'road-test' }, priority: PRIORITY.player })
      .catch(e => ({ ok: false, message: (e as Error).message }) as ActionResult)
    log(`${r.ok ? 'OK  ' : 'FAIL'} ${name} ${JSON.stringify(params)} (${((Date.now() - t) / 1000).toFixed(1)}s): ${r.message}`)
    if (r.ok || attempt >= 3 || !/session ended|not connected|disconnected|timed out/.test(r.message)) return r
    log('connection lost, waiting for the reconnect')
    await new Promise<void>(resolve => { const to = setTimeout(resolve, 180_000); agent.once('session', () => { clearTimeout(to); setTimeout(resolve, 5000) }) })
  }
}

const replies: string[] = []
agent.on('serverMessage', (t: string) => { replies.push(t); if (replies.length > 50) replies.shift() })
async function command (cmd: string): Promise<void> {
  const before = replies.length
  await agent.command(cmd)
  await wait(1500)
  log(`${cmd} -> ${replies.slice(before).join(' | ').slice(0, 200) || '(no reply)'}`)
}

/** Places this test must keep away from (spawn, the village, the fortress): at least 300 blocks. */
const KEEP_AWAY = [{ x: 545, z: 45 }, { x: -2778, z: 1090 }, { x: 560, z: -43 }]
function farEnough (x: number, z: number): boolean {
  const pe = (() => { try { return agent.bot.players.robin?.entity?.position } catch { return undefined } })()
  return [...KEEP_AWAY, ...(pe ? [pe] : [])].every(p => Math.hypot(p.x - x, p.z - z) >= 300)
}
function here (): { x: number, z: number } | null {
  try { return agent.bot.entity.position } catch { return null }
}

/** Natural ground at x z (null: unloaded, water, a tree or something built). */
function ground (x: number, z: number): number | null {
  let b: typeof agent.bot
  try { b = agent.bot } catch { return null }
  for (let y = 200; y > 40; y--) {
    const k = b.blockAt(b.entity.position.floored().set(x, y, z))
    if (!k) return null
    const n = k.name
    if (n === 'air' || n === 'cave_air' || n === 'short_grass' || n === 'tall_grass' || n === 'snow' || n === 'fern') continue
    if (n === 'water' || n === 'lava' || /_leaves$|_log$/.test(n) || !isNaturalBlock(n)) return null
    return y
  }
  return null
}

/** Two hut sites (flat 7x7 within 2, no trees or water) 18-40 apart with the biggest height difference. */
function findSites (): { a: { x: number, z: number, y: number }, b: { x: number, z: number, y: number }, spread: number } | null {
  const p = agent.bot.entity.position
  const sites: { x: number, z: number, y: number }[] = []
  let lo = Infinity
  let hi = -Infinity
  let known = 0
  let tried = 0
  for (let x = Math.floor(p.x) - 40; x <= p.x + 40; x += 3) {
    for (let z = Math.floor(p.z) - 40; z <= p.z + 40; z += 3) {
      const hs: number[] = []
      for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) { const g = ground(x + dx, z + dz); if (g !== null) hs.push(g) }
      tried++
      if (hs.length) { known++; lo = Math.min(lo, ...hs); hi = Math.max(hi, ...hs) }
      if (hs.length < 45 || Math.max(...hs) - Math.min(...hs) > 2) continue
      sites.push({ x, z, y: Math.max(...hs) })
    }
  }
  log(`  ${known}/${tried} patches with natural ground, ${sites.length} flat enough, heights ${lo}..${hi}`)
  let best: ReturnType<typeof findSites> = null
  for (const a of sites) {
    for (const b of sites) {
      const d = Math.hypot(a.x - b.x, a.z - b.z)
      if (d < 18 || d > 40) continue
      const dy = Math.abs(a.y - b.y)
      if (!best || dy > Math.abs(best.a.y - best.b.y)) best = { a, b, spread: hi - lo }
    }
  }
  return best
}

void agent.start()
await once()
log(`spawned at ${JSON.stringify(agent.observe().position)}, game mode ${agent.bot.game.gameMode}`)
const robin = agent.bot.players.robin?.entity?.position
if (robin && Math.hypot(robin.x - CX, robin.z - CZ) < 300) { log(`robin is within 300 blocks of ${CX} ${CZ}; pick another spot`); await agent.stop(); process.exit(1) }
if (!farEnough(CX, CZ)) { log(`${CX} ${CZ} is too close to spawn, the village or the fortress`); await agent.stop(); process.exit(1) }

let sites: ReturnType<typeof findSites> = null
for (const [dx, dz] of [[0, 0], [160, 0], [0, 160], [-160, 0], [0, -160]] as const) {
  if (!farEnough(CX + dx, CZ + dz)) continue
  await command(`/tp ${BOT} ${CX + dx} 180 ${CZ + dz}`)
  // really there? (a tp that didn't happen once had the test look for sites in the village)
  for (let i = 0; i < 40; i++) {
    const p = here()
    if (p && Math.hypot(p.x - (CX + dx), p.z - (CZ + dz)) < 8 && ground(CX + dx, CZ + dz) !== null) break
    await wait(1000)
  }
  const p = here()
  if (!p || Math.hypot(p.x - (CX + dx), p.z - (CZ + dz)) >= 8) { log(`the teleport to ${CX + dx} ${CZ + dz} didn't happen (at ${p ? `${Math.round(p.x)} ${Math.round(p.z)}` : 'nowhere'})`); continue }
  await wait(10000)
  sites = findSites()
  if (sites && !(farEnough(sites.a.x, sites.a.z) && farEnough(sites.b.x, sites.b.z))) sites = null
  log(`around ${CX + dx} ${CZ + dz}: ${sites ? `sites ${JSON.stringify(sites.a)} and ${JSON.stringify(sites.b)}, heights spread ${sites.spread}` : 'no two hut sites'}`)
  if (sites && Math.abs(sites.a.y - sites.b.y) >= Number(process.env.ROAD_RISE ?? 8)) break
}
if (!sites || !farEnough(sites.a.x, sites.a.z)) { log('no sites, stopping'); await agent.stop(); process.exit(1) }
const { a, b } = sites
await command(`/tp ${BOT} ${Math.round((a.x + b.x) / 2)} ${Math.max(a.y, b.y) + 12} ${Math.round((a.z + b.z) / 2)}`)
await wait(3000)
try { agent.bot.creative.startFlying() } catch {}

const roadsBefore = new Set(getRoads(agent).map(r => r.id))
const h1 = await step('build', { template: 'hut', x: a.x, z: a.z, facing: facingToward(a, b), method: 'commands', path: false })
const h2 = await step('build', { template: 'hut', x: b.x, z: b.z, facing: facingToward(b, a), method: 'commands', path: false })
if (h1.ok && h2.ok) {
  await step('connect_buildings', { source: 'built', radius: 96, method: 'commands', dry_run: true })
  const c = await step('connect_buildings', { source: 'built', radius: 96, method: 'commands' })
  for (const r of getRoads(agent).filter(r => !roadsBefore.has(r.id))) {
    log(`road ${r.id}: ${r.label}`)
    log(`  profile (x z f, T = landing): ${r.route.map(c => `${c[0]} ${c[1]} ${c[2]}${c[3] ? 'T' : ''}${c[4] ? 'J' : ''}`).join(' | ')}`)
    // walk it: every lane's floor solid, the two blocks above it free
    const bad: string[] = []
    for (const [x, zz, f] of r.surface) {
      const bl = agent.bot.blockAt(agent.bot.entity.position.floored().set(x!, f! - 1, zz!))
      const up = [0, 1].map(dy => agent.bot.blockAt(agent.bot.entity.position.floored().set(x!, f! + dy, zz!)))
      if (!bl || bl.boundingBox !== 'block') bad.push(`no floor at ${x} ${f! - 1} ${zz}`)
      if (up.some(u => u && u.boundingBox !== 'empty')) bad.push(`blocked above ${x} ${f} ${zz}`)
    }
    let steps = 0
    for (let i = 1; i < r.route.length; i++) if (Math.abs(r.route[i]![2]! - r.route[i - 1]![2]!) > 1) steps++
    log(`  walkable: ${bad.length ? `NO, ${bad.length} problems: ${bad.slice(0, 5).join('; ')}` : 'yes'}; steps of more than one block: ${steps}`)
  }
  if (!c.ok) log('connect_buildings reported a problem (see above)')
}
if (!KEEP) {
  for (const r of getRoads(agent).filter(r => !roadsBefore.has(r.id) && !r.removed)) await step('remove_road', { id: r.id, method: 'commands' })
  const placed = getPlacements(agent).filter(p => [a, b].some(s => Math.abs(p.origin.x - s.x) <= 1 && Math.abs(p.origin.z - s.z) <= 1))
  for (const p of placed) await command(`/fill ${p.box.min.x} ${p.box.min.y} ${p.box.min.z} ${p.box.max.x} ${p.box.max.y + 1} ${p.box.max.z} air`)
  log(`removed ${placed.length} huts`)
}
agent.storage.flush()
await wait(2000)
await agent.stop()
process.exit(0)
