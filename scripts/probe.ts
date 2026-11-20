// Connects once with no brains, prints a world snapshot, then quits.
import { Agent, defineVariant, serverFromEnv } from '../src/core/index.ts'
import { standardSkills } from '../src/skills/index.ts'

const agent = new Agent(defineVariant({ name: 'probe', skills: standardSkills(), brains: [] }), serverFromEnv(), {
  username: process.env.MC_USERNAME || 'McBuddyProbe',
  dataDir: 'data/probe'
})
agent.once('session', async () => {
  await new Promise(r => setTimeout(r, 4000))
  console.log(JSON.stringify(agent.observe(), null, 2))
  await agent.stop()
  process.exit(0)
})
setTimeout(() => { console.error('timeout'); process.exit(2) }, 90_000)
void agent.start()
