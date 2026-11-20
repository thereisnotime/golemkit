// Creates one bot session: connects, passes the NeoForge handshake, wires up behaviours.
import mineflayer from 'mineflayer'
import pf from 'mineflayer-pathfinder'
import { attachNeoForge } from './neoforge/handshake.js'
import { solidifyUnknownBlocks } from './modded.js'
import { createCommands } from './commands.js'
import { nearestHostile, fight, equipBestWeapon, eatIfHungry } from './behaviors.js'

const { pathfinder, Movements, goals } = pf

/**
 * @returns {Promise<{reason: 'learned'|'ended', detail?: string}>} resolves when the session is over
 */
export function runSession ({ config, store, log }) {
  return new Promise((resolve) => {
    let finished = false
    const finish = (reason, detail) => {
      if (finished) return
      finished = true
      clearInterval(tick)
      try { bot.quit() } catch {}
      resolve({ reason, detail })
    }

    const bot = mineflayer.createBot({
      host: config.host,
      port: config.port,
      username: config.username,
      auth: config.auth,
      version: config.version,
      profilesFolder: '.auth',
      checkTimeoutInterval: 60_000,
      hideErrors: !config.debug
    })

    attachNeoForge(bot._client, store, (m) => config.debug && log(m))

    bot._client.on('neoforge_failed', (failures) => {
      const { changed, unknown } = store.learn(failures)
      store.save()
      for (const u of unknown.slice(0, 10)) log(`unhandled negotiation failure: ${u}`)
      log(`server rejected our channel list (${Object.keys(failures).length} issues), ${changed ? `learned, now ${store.size} channels` : 'nothing new learned'}`)
      finish(changed ? 'learned' : 'ended', changed ? undefined : 'negotiation failed and nothing new to learn')
    })

    bot.loadPlugin(pathfinder)

    const state = { mode: 'idle', target: null }
    const commands = createCommands(bot, state, config, log)

    bot.once('login', () => solidifyUnknownBlocks(bot.registry))

    bot.once('spawn', () => {
      const p = bot.entity.position
      log(`spawned at ${p.x.toFixed(0)} ${p.y.toFixed(0)} ${p.z.toFixed(0)} (${bot.game.dimension}, ${bot.game.gameMode})`)
      const moves = new Movements(bot)
      moves.canDig = config.canDig
      moves.allow1by1towers = false // don't spend blocks pillaring
      moves.allowSprinting = true
      bot.pathfinder.setMovements(moves)
      bot.chat(`hi! I'm ${bot.username}. Say ${config.prefix}help for commands`)
    })

    bot.on('chat', (username, message) => commands.handle(username, message, false))
    bot.on('whisper', (username, message) => commands.handle(username, message, true))
    bot.on('messagestr', (msg, pos) => { if (pos !== 'chat' && pos !== 'game_info') log(`[server] ${msg}`) })

    bot.on('death', () => {
      log('died, respawning')
      state.mode = state.mode === 'collect' ? 'idle' : state.mode
    })

    // Fight back when hit.
    bot.on('entityHurt', async (entity) => {
      if (entity !== bot.entity || state.busy) return
      const mob = nearestHostile(bot, bot.entity.position, 6)
      if (!mob) return
      state.busy = true
      try { await equipBestWeapon(bot); await fight(bot, mob, { maxMs: 10000 }) } finally { state.busy = false; resumeMode() }
    })

    // When following, re-target if the player left render distance and came back.
    function resumeMode () {
      const target = state.target && bot.players[state.target]?.entity
      if ((state.mode === 'follow' || state.mode === 'guard') && target) {
        bot.pathfinder.setGoal(new goals.GoalFollow(target, state.mode === 'guard' ? 3 : 2), true)
      }
    }

    const tick = setInterval(async () => {
      if (!bot.entity || state.busy) return
      try {
        if (await eatIfHungry(bot)) log(`ate, food now ${bot.food}`)
        if (state.mode === 'guard') {
          const owner = bot.players[state.target]?.entity
          const center = owner ? owner.position : bot.entity.position
          const mob = nearestHostile(bot, center, 12)
          if (mob) {
            state.busy = true
            try { await equipBestWeapon(bot); await fight(bot, mob) } finally { state.busy = false }
          }
        }
        if ((state.mode === 'follow' || state.mode === 'guard') && !bot.pathfinder.goal) resumeMode()
      } catch (e) {
        if (config.debug) log(`tick: ${e.message}`)
      }
    }, 1000)

    bot.on('kicked', (reason) => {
      if (finished) return
      log(`kicked: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`)
    })
    bot.on('error', (e) => log(`error: ${e.message}`))
    bot.on('end', (why) => finish('ended', why))
  })
}
