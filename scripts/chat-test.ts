// Joins as a second player and sends chat commands to a running bot, printing replies.
//   node scripts/chat-test.ts "!help,!pos,!hp"
import { Agent, defineBot, serverFromEnv } from '../src/core/index.ts'

const cmds = (process.argv[2] || '!help,!pos,!hp,!come,!follow,!inventory,!stop').split(',')
const tester = new Agent(defineBot({ name: 'tester', skills: [], brains: [] }), serverFromEnv(), {
  username: process.env.TESTER || 'BuddyTester',
  dataDir: 'data/tester'
})
tester.on('chat', m => console.log(`chat> ${m.whisper ? '(whisper) ' : ''}<${m.from}> ${m.message}`))
tester.on('serverMessage', m => console.log(`server> ${m}`))
tester.once('session', async () => {
  await new Promise(r => setTimeout(r, 3000))
  for (const c of cmds) {
    console.log(`send> ${c}`)
    tester.say(c)
    await new Promise(r => setTimeout(r, 3500))
  }
  await tester.stop()
  process.exit(0)
})
setTimeout(() => process.exit(2), 120_000)
void tester.start()
