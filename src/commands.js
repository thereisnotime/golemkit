// Chat commands. Say "!help" in chat (or whisper the bot without the prefix).
import pf from 'mineflayer-pathfinder'
import { fight, nearestHostile, equipBestWeapon, eatIfHungry } from './behaviors.js'

const { goals } = pf

// Kept to two messages: vanilla kicks for spam after ~10 quick chat lines.
const HELP = (p) => [
  `${p}come, ${p}follow [player], ${p}goto <x y z|player>, ${p}stop, ${p}guard (toggle), ${p}attack`,
  `${p}pos, ${p}hp, ${p}inv, ${p}drop [item|all], ${p}eat, ${p}sleep, ${p}collect <block> [n], ${p}say <text>`
]

export function createCommands (bot, state, config, log) {
  // Rate-limited outgoing chat so we never trip the server's spam kick.
  const queue = []
  let lastSent = 0
  const pump = setInterval(() => {
    if (!queue.length || Date.now() - lastSent < 1100) return
    const { to, msg, whisper } = queue.shift()
    lastSent = Date.now()
    try { whisper ? bot.whisper(to, msg) : bot.chat(msg) } catch (e) { log(`chat failed: ${e.message}`) }
  }, 100)
  bot.once('end', () => clearInterval(pump))
  const reply = (to, msg, whisper) => { if (queue.length < 8) queue.push({ to, msg, whisper }) }

  const playerEntity = (name) => bot.players[name]?.entity

  const handlers = {
    help (ctx) {
      for (const line of HELP(config.prefix)) reply(ctx.from, line, ctx.whisper)
    },

    come (ctx) {
      const target = playerEntity(ctx.from)
      if (!target) return reply(ctx.from, 'I can\'t see you, get closer or use goto', ctx.whisper)
      state.mode = 'idle'
      bot.pathfinder.setGoal(new goals.GoalNear(target.position.x, target.position.y, target.position.z, 1))
      reply(ctx.from, 'on my way', ctx.whisper)
    },

    follow (ctx, [name]) {
      const who = name || ctx.from
      const target = playerEntity(who)
      if (!target) return reply(ctx.from, `I can't see ${who}`, ctx.whisper)
      state.mode = 'follow'
      state.target = who
      bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true)
      reply(ctx.from, `following ${who}`, ctx.whisper)
    },

    stop (ctx) {
      state.mode = 'idle'
      state.target = null
      bot.pathfinder.setGoal(null)
      bot.stopDigging?.()
      reply(ctx.from, 'ok, stopped', ctx.whisper)
    },

    goto (ctx, args) {
      state.mode = 'idle'
      if (args.length >= 3) {
        const [x, y, z] = args.map(Number)
        if ([x, y, z].some(Number.isNaN)) return reply(ctx.from, 'usage: goto <x> <y> <z>', ctx.whisper)
        bot.pathfinder.setGoal(new goals.GoalBlock(x, y, z))
        return reply(ctx.from, `going to ${x} ${y} ${z}`, ctx.whisper)
      }
      const target = playerEntity(args[0] || ctx.from)
      if (!target) return reply(ctx.from, 'usage: goto <x> <y> <z> | goto <player>', ctx.whisper)
      const p = target.position
      bot.pathfinder.setGoal(new goals.GoalNear(p.x, p.y, p.z, 1))
      reply(ctx.from, `going to ${args[0] || ctx.from}`, ctx.whisper)
    },

    guard (ctx) {
      if (state.mode === 'guard') {
        state.mode = 'idle'
        bot.pathfinder.setGoal(null)
        return reply(ctx.from, 'guard off', ctx.whisper)
      }
      state.mode = 'guard'
      state.target = ctx.from
      const target = playerEntity(ctx.from)
      if (target) bot.pathfinder.setGoal(new goals.GoalFollow(target, 3), true)
      reply(ctx.from, 'guarding you', ctx.whisper)
    },

    async attack (ctx) {
      const mob = nearestHostile(bot, bot.entity.position, 24)
      if (!mob) return reply(ctx.from, 'no hostile mobs nearby', ctx.whisper)
      reply(ctx.from, `attacking ${mob.displayName || mob.name}`, ctx.whisper)
      await equipBestWeapon(bot)
      await fight(bot, mob)
    },

    pos (ctx) {
      const p = bot.entity.position
      reply(ctx.from, `${p.x.toFixed(0)} ${p.y.toFixed(0)} ${p.z.toFixed(0)} in ${bot.game.dimension}`, ctx.whisper)
    },

    hp (ctx) {
      reply(ctx.from, `health ${bot.health.toFixed(0)}/20, food ${bot.food}/20, mode ${state.mode}`, ctx.whisper)
    },

    inv (ctx) {
      const items = bot.inventory.items()
      if (!items.length) return reply(ctx.from, 'my inventory is empty', ctx.whisper)
      const counts = {}
      for (const i of items) {
        const name = i.name && i.name !== 'unknown' ? i.name : `modded#${i.type}`
        counts[name] = (counts[name] || 0) + i.count
      }
      reply(ctx.from, Object.entries(counts).map(([n, c]) => `${c}x ${n}`).join(', ').slice(0, 250), ctx.whisper)
    },

    async drop (ctx, [what = 'all']) {
      const target = playerEntity(ctx.from)
      if (target) await bot.lookAt(target.position.offset(0, 1.6, 0)).catch(() => {})
      const items = bot.inventory.items().filter(i => what === 'all' || i.name === what)
      if (!items.length) return reply(ctx.from, `I don't have ${what}`, ctx.whisper)
      for (const item of items) await bot.tossStack(item).catch(e => log(`toss failed: ${e.message}`))
      reply(ctx.from, 'here you go', ctx.whisper)
    },

    async eat (ctx) {
      const ok = await eatIfHungry(bot, { force: true })
      reply(ctx.from, ok ? 'nom' : 'nothing to eat (or not hungry enough)', ctx.whisper)
    },

    async sleep (ctx) {
      const bed = bot.findBlock({ matching: b => bot.isABed(b), maxDistance: 16 })
      if (!bed) return reply(ctx.from, 'no bed nearby', ctx.whisper)
      try {
        await bot.pathfinder.goto(new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2))
        await bot.sleep(bed)
        reply(ctx.from, 'zzz', ctx.whisper)
      } catch (e) {
        reply(ctx.from, `can't sleep: ${e.message}`, ctx.whisper)
      }
    },

    async collect (ctx, [name, n = '1']) {
      if (!config.canDig) return reply(ctx.from, 'digging is disabled (MC_CAN_DIG=false)', ctx.whisper)
      const type = bot.registry.blocksByName[name]
      if (!type) return reply(ctx.from, `unknown block ${name}`, ctx.whisper)
      let left = Math.min(Number(n) || 1, 64)
      reply(ctx.from, `collecting ${left} ${name}`, ctx.whisper)
      state.mode = 'collect'
      while (left > 0 && state.mode === 'collect') {
        const block = bot.findBlock({ matching: type.id, maxDistance: 32 })
        if (!block) { reply(ctx.from, `no more ${name} nearby`, ctx.whisper); break }
        try {
          await bot.pathfinder.goto(new goals.GoalLookAtBlock(block.position, bot.world))
          await bot.dig(block)
          left--
        } catch (e) {
          log(`collect: ${e.message}`)
          break
        }
      }
      // pick up drops lying around
      const drop = bot.nearestEntity(e => e.name === 'item' && e.position.distanceTo(bot.entity.position) < 8)
      if (drop) await bot.pathfinder.goto(new goals.GoalBlock(drop.position.x, drop.position.y, drop.position.z)).catch(() => {})
      if (state.mode === 'collect') state.mode = 'idle'
      reply(ctx.from, 'done collecting', ctx.whisper)
    },

    say (ctx, args) {
      if (args.length) reply(ctx.from, args.join(' '), false)
    }
  }

  function allowed (username) {
    return config.owners.length === 0 || config.owners.includes(username.toLowerCase())
  }

  async function handle (from, text, whisper) {
    if (from === bot.username || !allowed(from)) return
    let body = text.trim()
    if (body.startsWith(config.prefix)) body = body.slice(config.prefix.length)
    else if (!whisper) return
    const [cmd, ...args] = body.split(/\s+/)
    const fn = handlers[cmd?.toLowerCase()]
    if (!fn) {
      if (whisper) reply(from, `unknown command, try ${config.prefix}help`, true)
      return
    }
    log(`command from ${from}: ${body}`)
    try {
      await fn({ from, whisper }, args)
    } catch (e) {
      log(`command ${cmd} failed: ${e.stack || e.message}`)
      reply(from, `that failed: ${e.message}`, whisper)
    }
  }

  return { handle, names: Object.keys(handlers) }
}
