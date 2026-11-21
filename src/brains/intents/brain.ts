// Intents brain: plain-language owner commands without an LLM ("pax guard me", "chop some
// wood", "bring me bread"). Parses addressed owner chat (parse.ts), maps the intent to actions
// through agent.act() at player priority or to behaviour arm/disarm, and replies briefly and
// truthfully. With an LLM brain it either fills in while the LLM can't think (mode fallback) or
// takes the simple requests itself and leaves the rest to the LLM (mode first).
//
//   brains: [commandBrain(), reflexes(), behaviorsBrain(), intentsBrain(), llmBrain()]
//
// One message, one handler: the chat listener is prepended (it runs before every other brain)
// and sets msg.claimedBy = 'intents' on lines it takes; the LLM runtime and the command brain
// skip claimed lines. See docs/guide/intents.md.
import { defineBrain, PRIORITY, type Agent, type ActionResult, type ChatMessage, type Logger } from '../../core/index.ts'
import { llmRuntime } from '../llm.ts'
import { runtimeFor } from '../behaviors/actions.ts'
import { addressed, parseIntent, helpLines, ACTIVITIES, DEFAULT_THRESHOLD, type Intent } from './parse.ts'

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
}

export const INTENTS_CALLER = 'intents'

/** Behaviours that move the bot, worth mentioning after "stop" because they pick up again. */
const MOVING_BEHAVIOURS = ['follow_owner', 'guard_owner', 'bodyguard', 'guard_area', 'chop_wood_loop', 'farm_loop', 'farm_setup', 'wander']

type Pos = { x: number, y: number, z: number }

export const intentsBrain = (opts: IntentsBrainOptions = {}) => {
  const lastExchange = new Map<string, number>()
  const lastHint = new Map<string, number>()

  const settings = (agent: Agent) => (agent.settings.intents ?? {}) as { mode?: IntentsMode, threshold?: number, aliases?: string[] }
  const llmSettings = (agent: Agent) => (agent.settings.llm ?? {}) as { aliases?: string[], listen?: string, conversationMs?: number }
  const modeOf = (agent: Agent): IntentsMode => settings(agent).mode ?? opts.mode ?? 'fallback'

  /** Why the LLM can't answer (no LLM brain counts), or null when it can. */
  const llmDown = (agent: Agent): string | null => {
    const r = opts.llmBlocked ? opts.llmBlocked(agent) : (() => { const rt = llmRuntime(agent); return rt ? rt.blockedReason() : undefined })()
    return r === undefined ? 'no LLM brain' : r
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
    },
    observe (agent) {
      return { intents: { mode: modeOf(agent) } }
    }
  })

  function onChat (agent: Agent, msg: ChatMessage, log: Logger): void {
    if (msg.claimedBy || msg.from === agent.username || !agent.isOwner(msg.from)) return
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
    const down = llmDown(agent)
    if (mode === 'fallback' && !down) return
    const threshold = settings(agent).threshold ?? opts.threshold ?? DEFAULT_THRESHOLD
    const intent = parseIntent(addr.body, { speaker: msg.from })
    if (!intent || intent.confidence < threshold) {
      // Nobody else will answer: say so (rate limited) when the line was clearly for us.
      if (down && addr.explicit) {
        msg.claimedBy = INTENTS_CALLER
        const now = Date.now()
        if (now - (lastHint.get(msg.from) ?? 0) > 20_000) {
          lastHint.set(msg.from, now)
          agent.reply(msg, `didn't get that (${down === 'no LLM brain' ? 'plain commands only' : `LLM off: ${down}`}); say "${agent.username} help"`)
        }
        log.debug('not understood', { from: msg.from, text: addr.body, confidence: intent?.confidence })
      }
      return
    }
    msg.claimedBy = INTENTS_CALLER
    lastExchange.set(msg.from, Date.now())
    log.info(`${msg.from}: ${addr.body} -> ${intent.intent}`, { args: JSON.stringify(intent.args), confidence: intent.confidence, mode, llm: down ?? 'up' })
    void execute(agent, msg, intent, log).catch(e => {
      log.warn(`${intent.intent} failed: ${(e as Error).message}`)
      agent.reply(msg, `can't: ${(e as Error).message}`)
    })
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

    const players = (): Record<string, { entity?: { position: Pos } }> => {
      try { return (agent.bot as unknown as { players: Record<string, { entity?: { position: Pos } }> }).players ?? {} } catch { return {} }
    }
    /** The real player name for a lower-case one from the parser. */
    const playerName = (name: string): string => Object.keys(players()).find(p => p.toLowerCase() === name.toLowerCase()) ?? name
    const positionOf = (name: string): Pos | null => {
      const e = players()[playerName(name)]?.entity
      return e ? { x: Math.floor(e.position.x), y: Math.floor(e.position.y), z: Math.floor(e.position.z) } : null
    }
    const botPos = (): Pos | null => {
      try { const p = agent.bot.entity.position; return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } } catch { return null }
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
      case 'status': return reply(statusLine(agent))
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
        let text = r.ok ? 'stopped' : `can't: ${r.message}`
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
        const asPlayer = Object.keys(players()).find(p => p.toLowerCase() === place.toLowerCase())
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

function interrupted (r: ActionResult): boolean {
  return /^(preempted|replaced|stopped|session ended|died|cancelled)/.test(r.message)
}

function fmt (r: ActionResult, doneText?: (r: ActionResult) => string): string {
  if (!r.ok) return /^(busy|can't|cannot|no |not )/.test(r.message) ? r.message : `can't: ${r.message}`
  return doneText ? doneText(r) : (r.message || 'done')
}

/** An inventory item for a spoken name: exact, then generic (log -> oak_log, food -> bread), then partial. */
export function inventoryMatch (agent: Agent, name: string): string | null {
  let items: { name: string }[] = []
  try { items = agent.bot.inventory.items() } catch { return null }
  const names = [...new Set(items.map(i => i.name))]
  if (names.includes(name)) return name
  const alts: Record<string, string[]> = { iron_ingot: ['raw_iron', 'iron_ore'], gold_ingot: ['raw_gold', 'gold_ore'], copper_ingot: ['raw_copper'], diamond: ['diamond_ore'] }
  for (const alt of alts[name] ?? []) if (names.includes(alt)) return alt
  if (name === 'food') {
    let foods: Record<string, unknown> = {}
    try { foods = (agent.bot.registry as unknown as { foodsByName?: Record<string, unknown> }).foodsByName ?? {} } catch {}
    return names.find(n => n in foods) ?? null
  }
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
