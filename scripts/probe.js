// Connects, learns the server's NeoForge channels (reconnecting as needed), spawns, reports, quits.
import mineflayer from 'mineflayer'
import { attachNeoForge } from '../src/neoforge/handshake.js'
import { ChannelStore } from '../src/neoforge/channelStore.js'
import { installTolerantParser } from '../src/neoforge/tolerantParser.js'
installTolerantParser((name, e) => console.log('skipped packet', name, e.message.slice(0, 100)))

const host = process.env.MC_HOST || 'mc.example.com'
const store = new ChannelStore(`data/channels-${host}-25565.json`)

function attempt (round) {
  return new Promise(resolve => {
    const bot = mineflayer.createBot({ host, port: 25565, username: process.env.MC_USERNAME || 'McBuddyProbe', auth: 'offline', version: '1.21.1' })
    attachNeoForge(bot._client, store, m => console.log(`[${round}]`, m))
    bot._client.on('neoforge_failed', f => {
      const { changed, unknown } = store.learn(f)
      store.save()
      console.log(`[${round}] failed: ${Object.keys(f).length} reasons, changed=${changed}, known=${store.size}`)
      if (unknown.length) console.log(unknown.slice(0, 5).join('\n'))
      resolve(changed ? 'retry' : 'stuck')
    })
    bot._client.on('neoforge_unhandled', (ch, d) => console.log(`[${round}] unhandled config payload`, ch, d.length))
    bot._client.on('state', s => console.log(`[${round}] state ->`, s))
    bot.on('spawn', () => {
      console.log('SPAWN', bot.entity.position, bot.game.dimension, bot.game.gameMode)
      setTimeout(() => {
        const b = bot.blockAt(bot.entity.position.offset(0, -1, 0))
        console.log('below:', b?.name, b?.stateId, '| players:', Object.keys(bot.players).join(','))
        bot.quit(); resolve('ok')
      }, 5000)
    })
    bot.on('kicked', r => { console.log(`[${round}] kicked`, JSON.stringify(r).slice(0, 400)); setTimeout(() => resolve('kicked'), 300) })
    bot.on('error', e => console.log(`[${round}] error`, e.message))
    bot.on('end', () => setTimeout(() => resolve('end'), 500))
  })
}

for (let round = 1; round <= 12; round++) {
  const r = await attempt(round)
  console.log(`round ${round}: ${r}`)
  if (r !== 'retry') break
  await new Promise(res => setTimeout(res, 4500))
}
process.exit(0)
