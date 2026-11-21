// Hooks brain: runs the context pack's hooks.yaml. Deterministic event -> action rules, no
// LLM involved, so they work when the model is slow, paused or out of budget.
//
//   brains: [commandBrain(), reflexes(), hooksBrain(), llmBrain()]
//
// Actions run through agent.act() with caller brain:hooks at HOOK_PRIORITY (40): above the
// LLM (30) and NPC loops (20), below player commands (50) and reflexes (60). A hook step can
// set its own priority (npc | llm | player | number). Chat goes through agent.say/whisper.
import type { Agent } from '../core/index.ts'
import { defineBrain, fmtPos } from '../core/index.ts'
import { Memory } from '../llm/memory.ts'
import { contextFor, disposeContext, onLlmBudgetExhausted } from '../context/handle.ts'
import { HookEngine, parseDuration, type HookHost, type HookState } from '../context/hooks.ts'

export const HOOKS_CALLER = { kind: 'brain', name: 'hooks' } as const

export interface HooksBrainOptions {
  /** Debounce for `hurt` events. Default 3000 ms. */
  hurtDebounceMs?: number
}

export const hooksBrain = (opts: HooksBrainOptions = {}) => {
  const engines = new Map<Agent, HookEngine>()
  const states = new Map<Agent, () => HookState>()

  return defineBrain({
    name: 'hooks',
    start (agent) {
      const ctx = contextFor(agent)
      if (!ctx) return
      const log = agent.log.child('hooks')
      const host: HookHost = {
        username: agent.username,
        owners: agent.owners,
        isOwner: p => agent.isOwner(p), // empty owners list = everyone, as everywhere else
        state: () => states.get(agent)?.() ?? {},
        act: (name, params, priority, player) => agent.act(name, params, { caller: HOOKS_CALLER, priority, player }),
        say: text => agent.say(text),
        whisper: (to, text) => agent.whisper(to, text),
        remember: (text, about) => { new Memory(agent.storage, { store: ctx.pack.memory ?? undefined }).remember(text, about) },
        log
      }
      const engine = new HookEngine(host, ctx.pack.hooks)
      engines.set(agent, engine)
      ctx.onReload(pack => engine.setHooks(pack.hooks))
      log.debug(`${engine.list.length} hooks active`, { hooks: engine.list.map(h => `${h.id}:${h.on}`).join(' ') || undefined })

      const run = (p: Promise<unknown>) => { p.catch(e => log.warn(`hook error: ${(e as Error).message}`)) }
      agent.on('chat', msg => {
        if (msg.from === agent.username) return
        run(engine.emit({ type: 'chat', player: msg.from, message: msg.message, whisper: msg.whisper }))
      })
      agent.on('actionEnd', (info, result) => {
        if (result.ok || /^(preempted|replaced|stopped|session ended|cancelled)/.test(result.message)) return
        const own = info.caller.kind === 'brain' && info.caller.name === HOOKS_CALLER.name
        run(engine.emit({ type: 'actionFailed', action: info.name, error: result.message, own, ...(info.player ? { player: info.player } : {}) }))
      })
      onLlmBudgetExhausted(agent, reason => run(engine.emit({ type: 'llmBudgetExhausted', reason })))
    },

    session (agent, bot) {
      const engine = engines.get(agent)
      if (!engine) return
      const log = agent.log.child('hooks')
      const run = (p: Promise<unknown>) => { p.catch(e => log.warn(`hook error: ${(e as Error).message}`)) }
      states.set(agent, () => {
        const inventory: Record<string, number> = {}
        let foodItems = 0
        const foods = (bot.registry as any).foodsByName ?? {}
        for (const i of bot.inventory?.items() ?? []) {
          inventory[i.name] = (inventory[i.name] ?? 0) + i.count
          if (foods[i.name]) foodItems += i.count
        }
        const t = bot.time?.timeOfDay ?? 0
        return {
          health: bot.health,
          food: bot.food,
          inventory,
          foodItems,
          position: bot.entity ? fmtPos(bot.entity.position) : undefined,
          isDay: t < 13000 || t > 23000,
          idle: !agent.currentAction,
          players: Object.keys(bot.players ?? {}).filter(p => p !== bot.username)
        }
      })
      engine.resetSession()
      const spawnedAt = Date.now()
      let lastHurt = 0
      const hurtMs = opts.hurtDebounceMs ?? 3000

      // The first health readings after login/respawn aren't news (we may log in hurt): skip 5 s.
      let healthQuietUntil = Date.now() + 5000
      bot.on('spawn', () => { healthQuietUntil = Date.now() + 5000 })
      const onHealth = () => { if (Date.now() >= healthQuietUntil && bot.health > 0) run(engine.health(bot.health)) }
      const onHurt = (entity: any) => {
        if (entity !== bot.entity || Date.now() - lastHurt < hurtMs) return
        lastHurt = Date.now()
        run(engine.emit({ type: 'hurt', health: bot.health }))
      }
      const onDeath = () => {
        const pos = bot.entity ? fmtPos(bot.entity.position) : 'unknown position'
        run(engine.emit({ type: 'death', vars: { pos, deathPos: pos } }))
      }
      const onJoin = (p: { username: string }) => {
        if (p.username === bot.username || Date.now() - spawnedAt < 10_000) return // the list is replayed on spawn
        run(engine.emit({ type: 'playerJoined', player: p.username }))
      }
      const onLeave = (p: { username: string }) => {
        if (p.username !== bot.username) run(engine.emit({ type: 'playerLeft', player: p.username }))
      }
      bot.on('health', onHealth)
      bot.on('entityHurt', onHurt)
      bot.on('death', onDeath)
      bot.on('playerJoined', onJoin)
      bot.on('playerLeft', onLeave)
      const timers = engine.list.filter(h => h.on === 'timer').map(h => setInterval(() => run(engine.emit({ type: 'timer', hookId: h.id })), parseDuration(h.every)))
      run(engine.emit({ type: 'spawn' }))

      return () => {
        bot.off('health', onHealth)
        bot.off('entityHurt', onHurt)
        bot.off('death', onDeath)
        bot.off('playerJoined', onJoin)
        bot.off('playerLeft', onLeave)
        for (const t of timers) clearInterval(t)
        states.delete(agent)
      }
    },

    observe (agent) {
      const e = engines.get(agent)
      if (!e) return {}
      const last = e.history[e.history.length - 1]
      return { hooks: { count: e.list.length, lastFired: last ? `${last.hook} (${last.event})` : null } }
    },

    stop (agent) {
      engines.delete(agent)
      disposeContext(agent)
    }
  })
}
