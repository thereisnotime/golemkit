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

    session (agent) {
      const engine = engines.get(agent)
      if (!engine) return
      const log = agent.log.child('hooks')
      const run = (p: Promise<unknown>) => { p.catch(e => log.warn(`hook error: ${(e as Error).message}`)) }
      const game = agent.adapter
      states.set(agent, () => {
        const inventory: Record<string, number> = {}
        let foodItems = 0
        for (const i of game.inventory?.().items ?? []) {
          inventory[i.name] = (inventory[i.name] ?? 0) + i.count
          if (i.food) foodItems += i.count
        }
        const t = game.time?.()?.timeOfDay ?? 0
        const self = game.self()
        const me = self?.username ?? agent.username
        return {
          health: self?.health ?? undefined,
          food: self?.food ?? undefined,
          inventory,
          foodItems,
          position: self ? fmtPos(self.position) : undefined,
          isDay: t < 13000 || t > 23000,
          idle: !agent.currentAction,
          players: (game.players?.() ?? []).filter(p => p !== me)
        }
      })
      engine.resetSession()
      const spawnedAt = Date.now()
      let lastHurt = 0
      const hurtMs = opts.hurtDebounceMs ?? 3000

      // The first health readings after login/respawn aren't news (we may log in hurt): skip 5 s.
      let healthQuietUntil = Date.now() + 5000
      const onRespawn = () => { healthQuietUntil = Date.now() + 5000 }
      const onHealth = (health: number) => { if (Date.now() >= healthQuietUntil && health > 0) run(engine.health(health)) }
      const onHurt = (health: number) => {
        if (Date.now() - lastHurt < hurtMs) return
        lastHurt = Date.now()
        run(engine.emit({ type: 'hurt', health }))
      }
      // What we carried just before dying (the inventory is already empty by the death event).
      let carried = 0
      let carriedAt = 0
      const countItems = () => {
        try {
          const n = (game.inventory?.().items ?? []).reduce((a, i) => a + i.count, 0)
          if (n > 0 || Date.now() - carriedAt > 5000) { carried = n; carriedAt = Date.now() } // keep a recent non-empty count: the server empties the inventory just before the death event
        } catch {}
      }
      const carryTimer = setInterval(countItems, 2000)
      const onDeath = () => {
        const p = game.self()?.position
        const pos = p ? fmtPos(p) : 'unknown position'
        const drops = carried > 0 ? `My stuff (${carried} items) should still be there for 5 minutes.` : 'I had nothing on me.'
        run(engine.emit({ type: 'death', vars: { pos, deathPos: pos, drops } }))
      }
      const onJoin = (player: string) => {
        if (Date.now() - spawnedAt < 10_000) return // the list is replayed on spawn
        run(engine.emit({ type: 'playerJoined', player }))
      }
      const onLeave = (player: string) => { run(engine.emit({ type: 'playerLeft', player })) }
      game.on('respawn', onRespawn)
      game.on('health', onHealth)
      game.on('hurt', onHurt)
      game.on('death', onDeath)
      game.on('playerJoined', onJoin)
      game.on('playerLeft', onLeave)
      const timers = engine.list.filter(h => h.on === 'timer').map(h => setInterval(() => run(engine.emit({ type: 'timer', hookId: h.id })), parseDuration(h.every)))
      run(engine.emit({ type: 'spawn' }))

      return () => {
        game.off('respawn', onRespawn)
        game.off('health', onHealth)
        game.off('hurt', onHurt)
        game.off('death', onDeath)
        game.off('playerJoined', onJoin)
        game.off('playerLeft', onLeave)
        for (const t of timers) clearInterval(t)
        clearInterval(carryTimer)
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
