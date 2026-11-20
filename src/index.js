// mc-buddy entry point: keeps one bot connected, reconnecting when it drops.
import { config } from './config.js'
import { ChannelStore } from './neoforge/channelStore.js'
import { installTolerantParser, skipped } from './neoforge/tolerantParser.js'
import { runSession } from './bot.js'

const log = (msg) => console.log(`${new Date().toISOString().slice(11, 19)} ${msg}`)

installTolerantParser((name, e) => {
  if (config.debug || skipped.get(name) === 1) log(`skipping unparseable packet ${name} (modded data): ${e.message.slice(0, 120)}`)
})

const store = new ChannelStore(`data/channels-${config.host}-${config.port}.json`)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

let stopping = false
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { stopping = true; log('bye'); setTimeout(() => process.exit(0), 300) })
}

log(`connecting to ${config.host}:${config.port} as ${config.username} (${config.auth}), ${store.size} known NeoForge channels`)
let learnRounds = 0
while (!stopping) {
  const { reason, detail } = await runSession({ config, store, log })
  if (stopping) break
  if (reason === 'learned' && learnRounds++ < 15) {
    // Negotiation taught us something new; retry quickly.
    await sleep(4500)
    continue
  }
  learnRounds = 0
  log(`disconnected${detail ? ` (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}, reconnecting in ${config.reconnectDelayMs / 1000}s`)
  await sleep(config.reconnectDelayMs)
}
