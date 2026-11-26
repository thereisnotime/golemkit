// Intents brain: plain-language owner commands without an LLM ("pax guard me", "chop some
// wood", "bring me bread"). Non-owners only get the peaceful PvP ones ("pvp off", "stop
// attacking", "leave bob alone"). Parses addressed owner chat (parse.ts), maps the intent to actions
// through agent.act() at player priority or to behaviour arm/disarm, and replies briefly and
// truthfully. With an LLM brain it either fills in while the LLM can't think (mode fallback) or
// takes the simple requests itself and leaves the rest to the LLM (mode first).
//
//   brains: [commandBrain(), reflexes(), behaviorsBrain(), intentsBrain(), llmBrain()]
//
// One message, one handler: the chat listener is prepended (it runs before every other brain)
// and sets msg.claimedBy = 'intents' on lines it takes; the LLM runtime and the command brain
// skip claimed lines. Understanding is a pipeline of layers (config.ts): patterns decide
// synchronously; when slower layers (embeddings, a local LLM) have to run, the line is claimed
// first and handed back to the LLM brain (LlmRuntime.handoff) if none of them understood it.
// See docs/guide/intents.md.
import { defineBrain, PRIORITY, type Agent, type ActionResult, type ChatMessage, type Logger } from '../../core/index.ts'
import { llmRuntime } from '../llm.ts'
import { runtimeFor } from '../behaviors/actions.ts'
import { addressed, helpLines, parseIntent, ACTIVITIES, DEFAULT_THRESHOLD, type Intent, type Addressed } from './parse.ts'
import { resolveConfig, buildPipeline, type LayerConfig, type PipelineConfig, type IntentsSettings, type BuildDeps } from './config.ts'
import { formatDecision, type Decision, type IntentLayer, type IntentPipeline, type Strategy } from './pipeline.ts'

export type IntentsMode = 'fallback' | 'first' | 'off'

export interface IntentsBrainOptions {
  /** fallback (default): only while the LLM is unavailable; first: simple requests itself; off. Profile/toggle: intents.mode. */
  mode?: IntentsMode
  /** Confidence needed to act. Default 0.7. Profile: intents.threshold. */
  threshold?: number
  /** Extra names it answers to (besides the username and llm.aliases). Profile: intents.aliases. */
  aliases?: string[]
  /** After a reply, follow-ups without the name count for this long. Default llm.conversationMs or 90 s; 0 with llm.listen mention. */
  conversationMs?: number
  /** How long to wait for an action before replying "on it" (the real result follows). Default 1500 ms. */
  ackAfterMs?: number
  /** Why the LLM can't think right now, or null when it can; undefined when there is no LLM brain. Default: the llm brain's runtime. */
  llmBlocked?: (agent: Agent) => string | null | undefined
  /** Gives a claimed line back to the LLM brain; false when there is none. Default: the llm brain's runtime.handoff(). */
  llmHandoff?: (agent: Agent, msg: ChatMessage) => boolean
  /** Layers when the profile has none (profile: intents.layers). Default [patterns, cloud_llm]. */
  layers?: LayerConfig[]
  /** Default first_confident. Profile/toggle: intents.strategy. */
  strategy?: Strategy
  /** One debug line per message with each layer's guess. Profile: intents.log_decisions. */
  logDecisions?: boolean
  /** Injected dependencies for the layers (tests: a fake embedder or fetch). */
  deps?: Omit<BuildDeps, 'log' | 'cache'>
}

export const INTENTS_CALLER = 'intents'

/** Intents a non-owner may use: they only make the bot more peaceful (pvp off or defend, spare a player). */
export function peaceful (i: Pick<Intent, 'intent' | 'args'>): boolean {
  return i.intent === 'pvp_spare' || (i.intent === 'pvp_mode' && (i.args.mode === 'off' || i.args.mode === 'defend'))
}

/** Behaviours that move the bot, worth mentioning after "stop" because they pick up again. */
const MOVING_BEHAVIOURS = ['follow_owner', 'guard_owner', 'bodyguard', 'guard_area', 'chop_wood_loop', 'farm_loop', 'farm_setup', 'wander']

type Pos = { x: number, y: number, z: number }

export const intentsBrain = (opts: IntentsBrainOptions = {}) => {
  const lastExchange = new Map<string, number>()
  const lastHint = new Map<string, number>()
  /** Per speaker: sequence of addressed lines, and the newest one acted on (a slow guess never overtakes a newer command). */
  let seq = 0
  const lastActed = new Map<string, number>()
  const layerCache = new Map<string, IntentLayer>()
  const pipelines = new WeakMap<Agent, { key: string, cfg: PipelineConfig, pipe: IntentPipeline }>()

  const settings = (agent: Agent) => (agent.settings.intents ?? {}) as IntentsSettings & { mode?: IntentsMode, aliases?: string[] }
  const llmSettings = (agent: Agent) => (agent.settings.llm ?? {}) as { aliases?: string[], listen?: string, conversationMs?: number }
  const modeOf = (agent: Agent): IntentsMode => settings(agent).mode ?? opts.mode ?? 'fallback'

  /** Why the LLM can't answer (no LLM brain counts), or null when it can. */
  const llmDown = (agent: Agent): string | null => {
    const r = opts.llmBlocked ? opts.llmBlocked(agent) : (() => { const rt = llmRuntime(agent); return rt ? rt.blockedReason() : undefined })()
    return r === undefined ? 'no LLM brain' : r
  }

  const handoff = (agent: Agent, msg: ChatMessage): boolean => {
    if (opts.llmHandoff) return opts.llmHandoff(agent, msg)
    const rt = llmRuntime(agent)
    if (!rt) return false
    rt.handoff(msg)
    return true
  }

  /** The pipeline for the current settings (rebuilt when they change; loaded layers are reused). */
  const pipelineOf = (agent: Agent, log: Logger): { cfg: PipelineConfig, pipe: IntentPipeline } => {
    const s = settings(agent)
    const cfg = resolveConfig({ ...s, threshold: s.threshold ?? opts.threshold }, opts.layers, { strategy: opts.strategy, logDecisions: opts.logDecisions })
    const key = JSON.stringify(cfg)
    const hit = pipelines.get(agent)
    if (hit?.key === key) return hit
    const pipe = buildPipeline(cfg, { ...opts.deps, log, cache: layerCache })
    pipelines.set(agent, { key, cfg, pipe })
    if (hit) log.info(`pipeline: ${describe(cfg)}`)
    return { cfg, pipe }
  }

  const othersOnline = (agent: Agent, except: string): number => {
    try {
      const map = (agent as unknown as { bot?: { players?: Record<string, unknown> } }).bot?.players
      if (!map) return 1
      return Object.keys(map).filter(p => p !== agent.username && p !== except).length
    } catch { return 1 }
  }

  return defineBrain({
    name: 'intents',
    start (agent) {
      const log = agent.log.child('intents')
      agent.prependListener('chat', msg => {
        try { onChat(agent, msg, log) } catch (e) { log.warn(`chat: ${(e as Error).message}`) }
      })
      try {
        const { cfg, pipe } = pipelineOf(agent, log)
        log.debug(`pipeline: ${describe(cfg)}`)
        // preload: true loads a model now instead of on the first line that needs it
        for (const l of cfg.layers) {
          if (!l.preload) continue
          const layer = pipe.layers.find(p => p.layer.name === l.name)?.layer
          void layer?.warmup?.().catch(() => {})
        }
      } catch (e) { log.warn(`pipeline: ${(e as Error).message}`) }
    },
    observe (agent) {
      const cfg = pipelines.get(agent)?.cfg
      return { intents: { mode: modeOf(agent), ...(cfg ? { layers: cfg.layers.map(l => l.name), strategy: cfg.strategy, handoff: cfg.handoff } : {}) } }
    }
  })

  function onChat (agent: Agent, msg: ChatMessage, log: Logger): void {
    if (msg.claimedBy || msg.from === agent.username) return
    const owner = agent.isOwner(msg.from)
    const mode = modeOf(agent)
    if (mode === 'off') return
    const prefix = process.env.MC_PREFIX ?? '!'
    if (msg.message.trim().startsWith(prefix)) return
    const ls = llmSettings(agent)
    const listen = ls.listen ?? 'conversation'
    const convMs = listen === 'mention' ? 0 : (opts.conversationMs ?? ls.conversationMs ?? 90_000)
    const names = [agent.username, ...(ls.aliases ?? []), ...(settings(agent).aliases ?? opts.aliases ?? [])]
    const last = lastExchange.get(msg.from) ?? 0
    const addr = addressed(msg.message, {
      names,
      whisper: msg.whisper,
      alone: listen !== 'mention' && othersOnline(agent, msg.from) === 0,
      inConversation: convMs > 0 && last > 0 && Date.now() - last < convMs
    })
    if (!addr) return
    if (!owner) return stranger(agent, msg, addr, log)
    const down = llmDown(agent)
    if (mode === 'fallback' && !down) return
    const { cfg, pipe } = pipelineOf(agent, log)
    const ctx = { speaker: msg.from, ...(agent.inSession && agent.adapter.players ? { players: agent.adapter.players() } : {}) }
    const n = ++seq
    const sync = pipe.decideSync(addr.body, ctx)
    if (sync) return conclude(agent, msg, addr, sync, { cfg, down, mode, n, early: false }, log)
    // Slower layers have to run: take the line now (the LLM and command brain skip it) and give
    // it back to the LLM brain afterwards if none of them understood it.
    msg.claimedBy = INTENTS_CALLER
    void pipe.decide(addr.body, ctx)
      .then(d => conclude(agent, msg, addr, d, { cfg, down, mode, n, early: true }, log))
      .catch(e => {
        log.warn(`pipeline: ${(e as Error).message}`)
        if (!down && cfg.handoff) handoff(agent, msg)
      })
  }

  /**
   * A non-owner's line: only the patterns, and only what makes the bot more peaceful ("pvp off",
   * "stop attacking", "leave bob alone"); the action refuses raising the mode. Everything else is
   * left alone, as before.
   */
  function stranger (agent: Agent, msg: ChatMessage, addr: Addressed, log: Logger): void {
    const i = parseIntent(addr.body, { speaker: msg.from })
    if (!i || !peaceful(i) || i.confidence < (pipelineOf(agent, log).cfg.layers.find(l => l.name === 'patterns')?.threshold ?? DEFAULT_THRESHOLD)) return
    msg.claimedBy = INTENTS_CALLER
    log.info(`${msg.from} (not an owner): ${addr.body} -> ${i.intent}`, { args: JSON.stringify(i.args) })
    void execute(agent, msg, i, log).catch(e => log.warn(`${i.intent} failed: ${(e as Error).message}`))
  }

  function conclude (agent: Agent, msg: ChatMessage, addr: Addressed, d: Decision, o: { cfg: PipelineConfig, down: string | null, mode: IntentsMode, n: number, early: boolean }, log: Logger): void {
    if (o.cfg.logDecisions) log.debug(`decide ${formatDecision(addr.body, d)}`)
    const w = d.winner
    if (w) {
      if (o.early && (lastActed.get(msg.from) ?? 0) > o.n) { log.info(`${msg.from}: ${addr.body} -> ${w.intent} dropped: a newer command came first`); return }
      const intent: Intent = { intent: w.intent, args: w.args, confidence: w.confidence }
      msg.claimedBy = INTENTS_CALLER
      lastActed.set(msg.from, o.n)
      lastExchange.set(msg.from, Date.now())
      log.info(`${msg.from}: ${addr.body} -> ${intent.intent}`, { args: JSON.stringify(intent.args), confidence: intent.confidence, layer: w.layer, ms: d.ms, mode: o.mode, llm: o.down ?? 'up' })
      void execute(agent, msg, intent, log).catch(e => {
        log.warn(`${intent.intent} failed: ${(e as Error).message}`)
        agent.reply(msg, `can't: ${(e as Error).message}`)
      })
      return
    }
    const best = d.trace.map(e => e.result?.confidence ?? 0).reduce((a, b) => Math.max(a, b), 0)
    if (o.down) {
      // Nobody else will answer: say so (rate limited) when the line was clearly for us.
      if (addr.explicit) {
        msg.claimedBy = INTENTS_CALLER
        const now = Date.now()
        if (now - (lastHint.get(msg.from) ?? 0) > 20_000) {
          lastHint.set(msg.from, now)
          agent.reply(msg, `didn't get that (${o.down === 'no LLM brain' ? 'plain commands only' : `LLM off: ${o.down}`}); say "${agent.username} help"`)
        }
        log.debug('not understood', { from: msg.from, text: addr.body, confidence: best })
      }
      return
    }
    // The LLM can think (mode first): it gets the line, unless the handoff is switched off.
    if (!o.cfg.handoff) {
      msg.claimedBy = INTENTS_CALLER
      log.debug('not understood, cloud_llm handoff off', { from: msg.from, text: addr.body, confidence: best })
      return
    }
    if (o.early && !handoff(agent, msg)) log.debug('not understood, no LLM brain to hand it to', { from: msg.from, text: addr.body })
    // not claimed (sync decision): the LLM runtime's own listener sees it next, as before
  }

  // ---------------------------------------------------------------- execution

  async function execute (agent: Agent, msg: ChatMessage, intent: Intent, log: Logger): Promise<void> {
    const speaker = msg.from
    const reply = (text: string) => agent.reply(msg, text)
    const has = (name: string) => !!agent.getAction(name)
    const act = (name: string, params: Record<string, unknown> = {}) =>
      agent.act(name, params, { caller: { kind: 'player', name: speaker }, priority: PRIORITY.player, player: speaker })
    const a = intent.args

    /** Runs an action: quick results are reported as they are, slow ones get "on it" now and the outcome later. */
    const run = async (name: string, params: Record<string, unknown>, startedText: string, doneText?: (r: ActionResult) => string): Promise<ActionResult> => {
      if (!has(name)) { reply(`can't: I don't have the ${name} action`); return { ok: false, message: 'missing' } }
      const p = act(name, params)
      const quick = await Promise.race([p, new Promise<null>(r => setTimeout(() => r(null), opts.ackAfterMs ?? 1500).unref?.())])
      if (quick) { const t = fmt(quick, doneText); if (t) reply(t); return quick }
      reply(startedText)
      const r = await p
      const t = fmt(r, doneText)
      if (!interrupted(r) && t) reply(t)
      return r
    }

    const players = (): string[] => agent.inSession ? agent.adapter.players?.() ?? [] : []
    /** The real player name for a lower-case one from the parser. */
    const playerName = (name: string): string => players().find(p => p.toLowerCase() === name.toLowerCase()) ?? name
    const positionOf = (name: string): Pos | null => {
      const p = agent.inSession ? agent.adapter.playerPosition?.(playerName(name)) : null
      return p ? { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } : null
    }
    const botPos = (): Pos | null => {
      const p = agent.inSession ? agent.adapter.self()?.position : undefined
      return p ? { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } : null
    }
    /** "here"/"there": where the speaker stands (null and a reply when they're out of sight). */
    const speakerPos = (): Pos | null => {
      const p = positionOf(speaker)
      if (!p) reply("can't see you, so I don't know where you mean")
      return p
    }
    const registry = () => runtimeFor(agent)?.registry
    const armed = (name: string) => !!runtimeFor(agent)?.store.isArmed(name)
    const arm = async (name: string, options: Record<string, unknown>, okText: string): Promise<boolean> => {
      if (!has('behavior_arm')) { reply(`can't: this bot has no behaviours brain, so I can't ${okText}`); return false }
      const r = await act('behavior_arm', { name, options })
      reply(r.ok ? `${okText} (${r.message})` : `can't: ${r.message}`)
      return r.ok
    }
    const disarm = async (name: string): Promise<ActionResult> => act('behavior_disarm', { name })

    switch (intent.intent) {
      case 'help': {
        for (const line of helpLines(agent.username)) reply(line)
        return
      }
      case 'status': return reply(agent.status ? agent.status.chatLine() : statusLine(agent))
      case 'where': {
        const o = agent.observe() as { position?: string, dimension?: string, connected?: boolean }
        return reply(o.connected === false ? 'not connected' : `at ${o.position} in ${String(o.dimension ?? '?').replace('minecraft:', '')}`)
      }
      case 'inventory': {
        const r = await act('inventory')
        return reply(r.ok ? r.message : `can't: ${r.message}`)
      }
      case 'stop': {
        const r = await act('stop')
        let text = r.ok ? (r.message || 'stopped') : `can't: ${r.message}`
        if (a.stay) {
          // "stay": following would pick up again right away
          for (const b of ['follow_owner', 'bodyguard', 'guard_owner']) if (armed(b)) await disarm(b)
          text = r.ok ? 'staying here' : text
        }
        const still = MOVING_BEHAVIOURS.filter(armed)
        if (r.ok && still.length) text += `; still armed: ${still.join(', ')}`
        return reply(text)
      }
      case 'follow': {
        const who = playerName(String(a.player ?? speaker))
        const label = who === speaker ? 'you' : who
        if (!has('follow')) return reply("can't: I don't have the follow action")
        if (!positionOf(who)) return reply(`can't see ${label}`)
        await run('follow', { player: who, ...(a.distance ? { distance: a.distance } : {}) }, `following ${label}`)
        return
      }
      case 'unfollow': {
        const n = agent.cancelActions(i => i.name === 'follow' || i.name === 'come', 'stopped')
        const off: string[] = []
        if (armed('follow_owner')) { const r = await disarm('follow_owner'); if (r.ok) off.push('follow_owner') }
        return reply(n || off.length ? `ok, not following anymore${off.length ? ` (disarmed ${off.join(', ')})` : ''}` : "I wasn't following anyone")
      }
      case 'come': {
        const who = playerName(String(a.player ?? speaker))
        if (!positionOf(who)) return reply(`can't see ${who === speaker ? 'you' : who}`)
        await run('come', { player: who }, 'coming')
        return
      }
      case 'go_home': {
        await run('go_home', {}, 'heading home')
        return
      }
      case 'goto': {
        if (a.at === 'speaker') {
          const p = speakerPos()
          if (p) await run('goto', p, `heading to ${p.x} ${p.y} ${p.z}`)
          return
        }
        if (typeof a.x === 'number' && typeof a.z === 'number') {
          await run('goto', { x: a.x, ...(typeof a.y === 'number' ? { y: a.y } : {}), z: a.z }, `heading to ${a.x} ${a.y ?? ''} ${a.z}`.replace(/\s+/g, ' '))
          return
        }
        const place = String(a.place ?? '')
        const asPlayer = players().find(p => p.toLowerCase() === place.toLowerCase())
        if (asPlayer && asPlayer !== agent.username) { await run('come', { player: asPlayer }, `going to ${asPlayer}`); return }
        await run('goto_place', { name: place }, `heading to ${place}`)
        return
      }
      case 'guard': {
        if (a.target === 'player') {
          const who = playerName(String(a.player ?? speaker))
          const label = who === speaker ? 'you' : who
          const reg = registry()
          if (reg?.has('bodyguard')) { await arm('bodyguard', { player: who }, `guarding ${label}`); return }
          if (reg?.has('guard_owner')) { await arm('guard_owner', { player: who }, `guarding ${label}`); return }
          if (has('guard')) { await run('guard', { player: who }, `guarding ${label}`); return }
          return reply("can't guard: no bodyguard behaviour or guard action here")
        }
        if (!registry()?.has('guard_area')) return reply("can't: no guard_area behaviour here")
        if (a.target === 'place') { await arm('guard_area', { place: String(a.place) }, `guarding ${a.place}`); return }
        const p = positionOf(speaker) ?? botPos()
        if (!p) return reply("can't: not connected")
        await arm('guard_area', { ...p }, `guarding the area around ${p.x} ${p.y} ${p.z}`)
        return
      }
      case 'unguard': {
        const off: string[] = []
        for (const b of ['bodyguard', 'guard_owner', 'guard_area']) if (armed(b)) { const r = await disarm(b); if (r.ok) off.push(b) }
        const n = agent.cancelActions(i => i.name === 'guard', 'stopped')
        return reply(off.length || n ? `stopped guarding${off.length ? ` (disarmed ${off.join(', ')})` : ''}` : "I wasn't guarding")
      }
      case 'pvp_mode': {
        if (!has('pvp')) return reply("can't: I don't have PvP")
        const r = await act('pvp', { mode: String(a.mode) })
        return reply(r.ok ? r.message : `can't: ${r.message}`)
      }
      case 'pvp_attack': {
        const name = String(a.player ?? '')
        // only players online by that name: "attack the zombie" or a typo never adds a target
        const online = players().find(p => p.toLowerCase() === name.toLowerCase())
        if (!online) return reply(`no player called ${name} online (!attack_player ${name} adds them anyway)`)
        if (a.hunt) { await run('hunt_player', { player: online }, `hunting ${online}`); return }
        if (!has('attack_player')) return reply("can't: I don't have PvP")
        const r = await act('attack_player', { player: online })
        return reply(r.ok ? r.message : `can't: ${r.message}`)
      }
      case 'hunt': {
        if (!has('hunt')) return reply("can't: I don't have the hunt action")
        const animal = a.animal ? String(a.animal) : undefined
        const count = typeof a.count === 'number' ? Math.min(a.count, 8) : undefined
        await run('hunt', { ...(animal ? { animal } : {}), ...(count ? { count } : {}) }, `hunting ${animal ?? 'animals'}${count ? ` (${count})` : ''}`)
        return
      }
      case 'pvp_spare': {
        if (!has('spare_player')) return reply("can't: I don't have PvP")
        const r = await act('spare_player', { player: playerName(String(a.player ?? '')) })
        return reply(r.ok ? r.message : `can't: ${r.message}`)
      }
      case 'farm': {
        if (a.create) {
          const p = a.at === 'speaker' ? speakerPos() : null
          if (a.at === 'speaker' && !p) return
          await run('start_farm', p ? { x: p.x, z: p.z } : {}, 'starting a farm')
          return
        }
        if (!has('harvest')) return reply("can't farm: I don't have the harvest action")
        if (a.place) {
          const r = await run('goto_place', { name: String(a.place) }, `heading to ${a.place} to farm`)
          if (!r.ok) return
        }
        await run('harvest', {}, 'harvesting')
        return
      }
      case 'chop': {
        const count = typeof a.count === 'number' ? a.count : undefined
        if (a.unit === 'tree' || count === undefined) {
          const trees = Math.min(count ?? 1, 5)
          if (!has('chop_tree')) return reply("can't: I don't have the chop_tree action")
          let done = 0
          for (let i = 0; i < trees; i++) {
            const r = await run('chop_tree', {}, trees > 1 ? `chopping tree ${i + 1} of ${trees}` : 'chopping a tree')
            if (!r.ok) break
            done++
          }
          if (trees > 1) reply(`chopped ${done} of ${trees} trees`)
          return
        }
        const item = a.wood ? `${a.wood}_${a.unit}` : String(a.unit)
        if (has('gather_materials')) { await run('gather_materials', { items: { [item]: Math.min(count, 512) } }, `getting ${count} ${item}`); return }
        await run('chop_tree', {}, `chopping a tree (gather_materials isn't here, so one tree, not ${count} ${item})`)
        return
      }
      case 'collect': {
        const item = String(a.item)
        const count = typeof a.count === 'number' ? a.count : 8
        const wood = /(^|_)(log|planks)$/.test(item)
        if ((wood || count > 64) && has('gather_materials')) {
          await run('gather_materials', { items: { [item]: Math.min(count, 512) } }, `getting ${count} ${item}`)
          return
        }
        if (!has('collect')) return reply("can't: I don't have the collect action")
        const n = Math.min(count, 64)
        await run('collect', { block: item, count: n }, `getting ${n} ${item}${n < count ? ` (64 at a time, not ${count})` : ''}`)
        return
      }
      case 'find': {
        // "where's my iron": from what it remembers seeing in chests; nothing known falls through to a search only when asked to bring it
        if (a.stored && has('where_stored')) {
          const r = await act('where_stored', { item: String(a.target) })
          const fetchable = r.ok && (r.data as { fetchable?: boolean } | undefined)?.fetchable && has('bring_item')
          return reply(r.ok ? `${r.message}${fetchable ? ` (say "bring me ${String(a.target).replace(/_/g, ' ')}" and I fetch it)` : ''}` : r.message)
        }
        if (!has('find_target')) return reply("find_target isn't available here yet")
        await run('find_target', { target: String(a.target), ...(a.radius ? { radius: a.radius } : {}), ...(a.bring ? { bring: true } : {}) }, `looking for ${a.target}`)
        return
      }
      case 'bring':
      case 'give': {
        const item = String(a.item)
        const count = typeof a.count === 'number' ? a.count : undefined
        const held = inventoryMatch(agent, item)
        // give: from my own inventory first; bring: the bring_item action first
        if (intent.intent === 'bring' && has('bring_item')) {
          await run('bring_item', { item, ...(count ? { count } : {}), player: speaker }, `getting ${count ?? ''} ${item} for you`.replace(/\s+/g, ' '))
          return
        }
        if (held) {
          const p = positionOf(speaker)
          const me = botPos()
          if (p && me && Math.hypot(p.x - me.x, p.z - me.z) > 4 && has('come')) {
            const r = await run('come', { player: speaker }, `bringing ${held}`, () => '')
            if (!r.ok) return
          }
          const r = await act('drop', { item: held, ...(count ? { count } : {}) })
          return reply(r.ok ? `here: ${count ?? 'all my'} ${held}` : `can't: ${r.message}`)
        }
        if (has('bring_item')) { await run('bring_item', { item, ...(count ? { count } : {}), player: speaker }, `getting ${item} for you`); return }
        return reply(intent.intent === 'give' ? `I have no ${item}` : `bring_item isn't available here yet, and I have no ${item} on me`)
      }
      case 'drop': {
        const item = String(a.item)
        if (item === 'all') { const r = await act('drop', { item: 'all' }); return reply(r.ok ? 'dropped everything' : `can't: ${r.message}`) }
        const held = inventoryMatch(agent, item)
        if (!held) return reply(`I have no ${item}`)
        const r = await act('drop', { item: held, ...(typeof a.count === 'number' ? { count: a.count } : {}) })
        return reply(r.ok ? `dropped ${a.count ?? 'all my'} ${held}` : `can't: ${r.message}`)
      }
      case 'eat': { await run('eat', {}, 'eating'); return }
      case 'sleep': { await run('sleep', {}, 'going to sleep'); return }
      case 'set_home': {
        const p = a.at === 'speaker' ? speakerPos() : null
        if (a.at === 'speaker' && !p) return
        const r = await act('set_home', p ?? {})
        return reply(r.ok ? r.message : `can't: ${r.message}`)
      }
      case 'remember_place': {
        const p = positionOf(speaker) ?? botPos()
        const r = await act('remember_place', { name: String(a.name), ...(p ?? {}) })
        return reply(r.ok ? r.message : `can't: ${r.message}`)
      }
      case 'build': {
        const p = a.at === 'speaker' ? speakerPos() : null
        if (a.at === 'speaker' && !p) return
        await run('build', { template: String(a.template), ...(p ? { x: p.x, z: p.z } : {}) }, `building ${a.template}`)
        return
      }
      case 'projects': {
        const op = String(a.op)
        if (op === 'list' || op === 'plan') {
          const name = op === 'list' ? 'projects' : 'plan_base'
          if (!has(name)) return reply("can't: I have no base projects")
          const r = await act(name, op === 'plan' ? { detail: true } : {})
          if (!r.ok) return reply(`can't: ${r.message}`)
          // packed into a few chat lines: the chat queue drops the rest of a long list
          const lines = (r.data as { lines?: string[] } | undefined)?.lines ?? r.message.split('\n')
          const packed: string[] = []
          for (const line of lines.map(l => l.trim())) {
            const last = packed[packed.length - 1]
            if (last !== undefined && last.length + line.length + 3 <= 240) packed[packed.length - 1] = `${last} | ${line}`
            else packed.push(line.slice(0, 240))
          }
          for (const line of packed.slice(0, op === 'plan' ? 6 : 4)) reply(line)
          return
        }
        if (!has('project')) return reply("can't: I have no base projects")
        const r = await act('project', { op, ...(a.name ? { name: String(a.name) } : {}) })
        return reply(r.ok ? r.message : `can't: ${r.message}`)
      }
      case 'behavior_on':
      case 'behavior_off': {
        const name = a.behavior ? String(a.behavior) : ACTIVITIES[String(a.activity)] ?? ''
        if (name === 'guard') return execute(agent, msg, { ...intent, intent: intent.intent === 'behavior_on' ? 'guard' : 'unguard', args: { target: 'player', player: speaker } }, log)
        if (intent.intent === 'behavior_off') {
          if (name === 'follow_owner') return execute(agent, msg, { ...intent, intent: 'unfollow', args: {} }, log)
          if (!has('behavior_disarm')) return reply("can't: this bot has no behaviours brain")
          const r = await disarm(name)
          // the one-off action of the same kind may be running too
          const action = { chop_wood_loop: 'chop_tree', farm_loop: 'harvest', wander: 'wander' }[name]
          if (action) agent.cancelActions(i => i.name === action && i.caller.kind === 'player', 'stopped')
          return reply(r.ok ? r.message : `can't: ${r.message}`)
        }
        if (!registry()?.has(name)) return reply(`can't: no ${name} behaviour here`)
        const options = name === 'follow_owner' ? { player: speaker } : {}
        await arm(name, options, name === 'follow_owner' ? 'following you' : `${a.activity ?? name} on`)
        return
      }
    }
  }
}

function describe (cfg: PipelineConfig): string {
  return `${cfg.layers.map(l => `${l.name}@${l.threshold}`).join(' > ') || '(no layers)'}${cfg.handoff ? ' > cloud_llm' : ''}, ${cfg.strategy}`
}

function interrupted (r: ActionResult): boolean {
  return /^(preempted|replaced|stopped|session ended|died|cancelled)/.test(r.message)
}

function fmt (r: ActionResult, doneText?: (r: ActionResult) => string): string {
  if (!r.ok) return /^(busy|can't|cannot|no |not )/.test(r.message) ? r.message : `can't: ${r.message}`
  return doneText ? doneText(r) : (r.message || 'done')
}

/** An inventory item for a spoken name: exact, then generic (log -> oak_log, food -> bread), then partial. */
export function inventoryMatch (agent: Agent, name: string): string | null {
  if (!agent.inSession) return null
  const items = agent.adapter.inventory?.().items ?? []
  const names = [...new Set(items.map(i => i.name))]
  if (names.includes(name)) return name
  const alts: Record<string, string[]> = { iron_ingot: ['raw_iron', 'iron_ore'], gold_ingot: ['raw_gold', 'gold_ore'], copper_ingot: ['raw_copper'], diamond: ['diamond_ore'] }
  for (const alt of alts[name] ?? []) if (names.includes(alt)) return alt
  if (name === 'food') return names.find(n => items.some(i => i.name === n && i.food)) ?? null
  return names.find(n => n.endsWith(`_${name}`)) ?? names.find(n => n.startsWith(`${name}_`)) ?? names.find(n => n.includes(name)) ?? null
}

/** One line from observe(): what it's doing, where, health, food, armed behaviours, LLM state. */
export function statusLine (agent: Pick<Agent, 'observe'>): string {
  const o = agent.observe() as Record<string, any>
  if (o.connected === false) return 'not connected'
  const cur = o.currentAction as { name: string, params?: Record<string, unknown> } | null
  const p = cur?.params ?? {}
  const detail = p.player ?? p.template ?? p.block ?? p.name ?? p.target
  const doing = cur ? `doing ${cur.name}${detail ? ` ${detail}` : ''}` : 'idle'
  const parts = [doing, `at ${o.position}`, `hp ${o.health}/20 food ${o.food}/20`]
  const b = o.behaviors as { armed?: string[], running?: string | null } | undefined
  if (b?.running) parts.push(`behaviour ${b.running}`)
  if (b?.armed?.length) parts.push(`armed: ${b.armed.join(', ')}`)
  const llm = o.llm as { paused?: string | null, goal?: unknown } | undefined
  if (llm?.paused) parts.push(`LLM paused (${llm.paused})`)
  return parts.join('; ')
}
