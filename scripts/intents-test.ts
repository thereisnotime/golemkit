// Live test of the intents brain with no LLM: starts a bot (INTENTS_BOT, default IntentTest) that
// obeys only INTENTS_OWNER (default IntentTester), joins as the owner, moves both far from spawn
// (/spreadplayers when op, else both walk out east; aborts if they end up within 300 blocks of spawn, the village or
// robin) and says plain requests in chat, printing the bot's replies.
//   node scripts/intents-test.ts ["follow me,come here,chop some wood,what are you doing,stop"] [x z]
// INTENTS_EMBEDDINGS=1 adds the embeddings layer after the patterns (decision log on; see it with
// MC_LOG_LEVEL='info,*/intents=debug').
import { Agent, defineVariant, serverFromEnv, PRIORITY, configureLogging, loggingFromEnv } from '../src/core/index.ts'
import { standardSkills, extendedSkills, navigation } from '../src/skills/index.ts'
import { commandBrain, reflexes, intentsBrain } from '../src/brains/index.ts'

const BOT = process.env.INTENTS_BOT || 'IntentTest'
const OWNER = process.env.INTENTS_OWNER || 'IntentTester'
const phrases = (process.argv[2] || 'follow me,what are you doing,stop,come here,chop some wood,what are you doing,stop').split(',').map(s => s.trim())
const [xs = '900', zs = '45'] = process.argv.slice(3)
configureLogging(loggingFromEnv())
const t0 = Date.now()
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(3)}s] ${m}`)
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

const bot = new Agent(defineVariant({
  name: 'intents-test',
  skills: [...standardSkills(), navigation(), ...extendedSkills()],
  brains: [commandBrain({ verbose: false }), reflexes(), intentsBrain({
    mode: 'fallback',
    ...(process.env.INTENTS_EMBEDDINGS === '1'
      ? { logDecisions: true, layers: [{ use: 'patterns' }, { use: 'embeddings', threshold: 0.58, margin: 0.03, preload: true }, { use: 'cloud_llm' }] }
      : {})
  })]
}), serverFromEnv(), { username: BOT, owners: [OWNER], dataDir: `data/${BOT}`, canDig: true })
const owner = new Agent(defineVariant({ name: 'owner', skills: [...standardSkills()], brains: [] }), serverFromEnv(), { username: OWNER, dataDir: `data/${OWNER}` })

owner.on('chat', m => { if (m.from === BOT) log(`reply> ${m.message}`) })
const serverLines: string[] = []
owner.on('serverMessage', t => { serverLines.push(t) })
const session = (a: Agent) => new Promise<void>(resolve => a.once('session', () => setTimeout(resolve, 4000)))

const KEEP_AWAY = [{ x: 545, z: 45 }, { x: -2770, z: 1090 }]
function pos (a: Agent): { x: number, y: number, z: number } | null {
  try { const p = a.bot.entity.position; return { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) } } catch { return null }
}
function farEnough (a: Agent): boolean {
  const p = pos(a)
  if (!p) return false
  const pe = (() => { try { return owner.bot.players.robin?.entity?.position } catch { return undefined } })()
  return [...KEEP_AWAY, ...(pe ? [pe] : [])].every(k => Math.hypot(k.x - p.x, k.z - p.z) >= 300)
}

async function main (): Promise<void> {
  const ready = Promise.all([session(bot), session(owner)])
  void bot.start()
  await wait(3000)
  void owner.start()
  await ready
  log(`connected: ${BOT} at ${JSON.stringify(pos(bot))}, ${OWNER} at ${JSON.stringify(pos(owner))}`)
  if (!farEnough(bot) || !farEnough(owner) || Math.hypot(pos(bot)!.x - pos(owner)!.x, pos(bot)!.z - pos(owner)!.z) > 20) {
    const before = serverLines.length
    await owner.command(`/spreadplayers ${xs} ${zs} 2 4 false ${OWNER} ${BOT}`)
    await wait(5000)
    log(`spreadplayers -> ${serverLines.slice(before).join(' | ').slice(0, 200) || '(no reply)'}; now ${BOT} ${JSON.stringify(pos(bot))}, ${OWNER} ${JSON.stringify(pos(owner))}`)
  }
  for (let attempt = 0; attempt < 3 && (!farEnough(bot) || !farEnough(owner)); attempt++) {
    // not op: walk both out on the surface (no digging on the way: the bot's digging stays off until it's out)
    log(`walking out to ${xs} ${zs} (attempt ${attempt + 1})`)
    bot.setToggle('canDig', false)
    const sys = { caller: { kind: 'system' as const, name: 'test' }, priority: PRIORITY.player }
    const [a, b] = await Promise.all([
      owner.act('goto', { x: Number(xs), z: Number(zs) }, sys),
      wait(1500).then(() => bot.act('goto', { x: Number(xs) + 3, z: Number(zs) + 2 }, sys))
    ])
    bot.resetToggle('canDig')
    log(`owner: ${a.message}; bot: ${b.message}; now ${BOT} ${JSON.stringify(pos(bot))}, ${OWNER} ${JSON.stringify(pos(owner))}`)
  }
  if (!farEnough(bot) || !farEnough(owner)) { log('ABORT: too close to spawn, the village or robin'); return }
  for (const phrase of phrases) {
    if (/^come here/.test(phrase)) {
      // step away first so "come here" has somewhere to go
      const p = pos(owner)!
      const r = await owner.act('goto', { x: p.x + 8, z: p.z + 6 }, { caller: { kind: 'system', name: 'test' }, priority: PRIORITY.player })
      log(`(owner walked away: ${r.message})`)
    }
    log(`send> ${BOT} ${phrase}   [bot at ${JSON.stringify(pos(bot))}, doing ${bot.currentAction?.name ?? 'nothing'}]`)
    owner.say(`${BOT} ${phrase}`)
    await wait(/chop|get|mine|collect/.test(phrase) ? 75_000 : 9000)
  }
  log(`end: ${BOT} at ${JSON.stringify(pos(bot))}, doing ${bot.currentAction?.name ?? 'nothing'}; inventory ${JSON.stringify((bot.observe() as any).inventory)}`)
}

const timer = setTimeout(() => { log('timeout'); process.exit(2) }, 20 * 60_000)
main().catch(e => log(`error: ${(e as Error).stack}`)).finally(async () => {
  clearTimeout(timer)
  await Promise.allSettled([bot.stop(), owner.stop()])
  process.exit(0)
})
