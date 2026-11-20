// Joins with standard + extended skills and runs actions in order, printing each result.
//   node scripts/skill-test.ts observe 'chop_tree {"radius":24}' 'craft {"item":"stick","count":4}'
// "observe" prints the world snapshot, "scan" counts nearby logs/crops/containers,
// 'place_near {"item":"chest"}' places a block on a free spot next to the bot. Digging is off unless MC_CAN_DIG=true.
import { Agent, defineVariant, serverFromEnv } from '../src/core/index.ts'
import { standardSkills, extendedSkills } from '../src/skills/index.ts'
import { findFreeSpot } from '../src/skills/world.ts'

const steps = process.argv.slice(2)
const agent = new Agent(defineVariant({ name: 'skill-test', skills: [...standardSkills(), ...extendedSkills()], brains: [] }), serverFromEnv(), {
  username: process.env.MC_USERNAME || 'SkillTest',
  dataDir: 'data/skill-test'
})
agent.once('session', async () => {
  await new Promise(r => setTimeout(r, 4000))
  for (const step of steps) {
    const space = step.indexOf(' ')
    const name = space < 0 ? step : step.slice(0, space)
    const params = space < 0 ? {} : JSON.parse(step.slice(space + 1))
    if (name === 'scan') {
      // counts of interesting blocks within 32, nearest position of each
      const bot = agent.bot
      const re = /(_log|_leaves|chest|barrel|crafting_table|furnace|farmland|wheat|carrots|potatoes|beetroots)$/
      const ids = Object.values(bot.registry.blocksByName).filter(b => re.test(b.name)).map(b => b.id)
      const found: Record<string, { n: number, nearest: string }> = {}
      for (const p of bot.findBlocks({ matching: ids, maxDistance: params.radius ?? 32, count: 5000 })) {
        const b = bot.blockAt(p)!
        found[b.name] ??= { n: 0, nearest: `${p.x} ${p.y} ${p.z}` }
        found[b.name].n++
      }
      console.log(JSON.stringify(found, null, 1))
      continue
    }
    if (name === 'observe') {
      console.log(JSON.stringify(agent.observe(), null, 2))
      continue
    }
    // "place_near item" places a block on a free spot next to the bot
    let action = name
    if (name === 'place_near') {
      const spot = findFreeSpot(agent.bot)
      if (!spot) { console.log('FAIL place_near: no free spot'); continue }
      action = 'place_block'
      Object.assign(params, { x: spot.x, y: spot.y, z: spot.z })
    }
    const t = Date.now()
    const r = await agent.act(action, params, { caller: { kind: 'system', name: 'skill-test' } })
    console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${action} (${((Date.now() - t) / 1000).toFixed(1)}s): ${r.message}`)
  }
  await agent.stop()
  process.exit(0)
})
setTimeout(() => { console.error('timeout'); process.exit(2) }, Number(process.env.SKILL_TEST_TIMEOUT_MS || 300_000)).unref?.()
void agent.start()
