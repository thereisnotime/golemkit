// Joins as a second offline player and sends commands to McBuddy, printing what comes back.
import mineflayer from 'mineflayer'
import { attachNeoForge } from '../src/neoforge/handshake.js'
import { ChannelStore } from '../src/neoforge/channelStore.js'
import { installTolerantParser } from '../src/neoforge/tolerantParser.js'
installTolerantParser()
const host = process.env.MC_HOST || 'mc.example.com'
const store = new ChannelStore(`data/channels-${host}-25565.json`)
const bot = mineflayer.createBot({ host, username: process.env.TESTER || 'BuddyTester', auth: 'offline', version: '1.21.1', hideErrors: true })
attachNeoForge(bot._client, store)
const cmds = (process.argv[2] || '!help,!pos,!hp,!come,!follow,!inv,!guard,!stop').split(',')
bot.on('messagestr', m => console.log('chat>', m))
bot.once('spawn', async () => {
  console.log('tester at', bot.entity.position.floored())
  await bot.waitForTicks(60)
  for (const c of cmds) { console.log('send>', c); bot.chat(c); await bot.waitForTicks(70) }
  const b = bot.players.McBuddy?.entity
  console.log('McBuddy distance:', b ? b.position.distanceTo(bot.entity.position).toFixed(1) : 'not visible')
  bot.quit(); setTimeout(() => process.exit(0), 500)
})
bot.on('kicked', r => { console.log('kicked', JSON.stringify(r)); process.exit(1) })
setTimeout(() => process.exit(2), 90000)
