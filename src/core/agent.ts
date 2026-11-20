// The Agent is one bot identity. It outlives connections: it reconnects, re-runs skill and
// brain setup on every session, owns the action lock, chat queue and persistent storage.
import { join } from 'node:path'
import mineflayer, { type Bot } from 'mineflayer'
import pf from 'mineflayer-pathfinder'
import { z } from 'zod'
import {
  PRIORITY, normalizeResult, fail, ActionAbortedError,
  type ActionDef, type ActionResult, type Caller, type ActionContext
} from './action.ts'
import type { SkillDef } from './skill.ts'
import type { BrainDef } from './brain.ts'
import { listFromEnv, type BotDefinition, type InstanceOptions, type ServerConfig } from './definition.ts'
import { TypedEmitter } from './events.ts'
import { createLogger, type Logger } from './log.ts'
import { Storage } from './storage.ts'
import { ChannelStore } from './neoforge/channelStore.ts'
import { attachNeoForge } from './neoforge/handshake.ts'
import { installTolerantParser } from './neoforge/tolerantParser.ts'
import { solidifyUnknownBlocks } from './modded.ts'
import { fmtPos, itemName } from './helpers.ts'
import type { Fleet } from './fleet.ts'

export interface ChatMessage {
  from: string
  message: string
  whisper: boolean
}

export interface ActionInfo {
  name: string
  params: unknown
  caller: Caller
  priority: number
}

export type AgentEvents = {
  /** New session, bot spawned and skills/brains set up. */
  session: (bot: Bot) => void
  sessionEnd: (reason: string) => void
  chat: (msg: ChatMessage) => void
  /** Any server/system message that isn't player chat. */
  serverMessage: (text: string) => void
  actionStart: (info: ActionInfo) => void
  actionEnd: (info: ActionInfo, result: ActionResult) => void
  stopped: () => void
}

export interface ActOptions {
  caller?: Caller
  /** Defaults from caller kind: player→player, reflex→reflex, system→system, brain→npc. */
  priority?: number
  /** Player this action is for (defaults to the caller if it's a player). */
  player?: string
}

interface Running {
  def: ActionDef
  params: unknown
  caller: Caller
  priority: number
  player?: string
  controller: AbortController
  preempted?: boolean
}

export interface ActionCatalogEntry {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  exclusive: boolean
  longRunning: boolean
}

const CHAT_INTERVAL_MS = 1100
const CHAT_QUEUE_MAX = 8

export class Agent extends TypedEmitter<AgentEvents> {
  readonly definition: BotDefinition
  readonly server: ServerConfig
  readonly username: string
  readonly log: Logger
  readonly storage: Storage
  readonly dataDir: string
  readonly settings: Record<string, unknown>
  readonly owners: string[]
  readonly canDig: boolean

  private readonly actions = new Map<string, ActionDef>()
  private readonly aliases = new Map<string, string>()
  private readonly skills: SkillDef[]
  private readonly brains: BrainDef[]
  private readonly reconnectDelayMs: number
  private readonly channels: ChannelStore

  private _bot: Bot | null = null
  private _fleet: Fleet | null = null
  private _serverName = 'default'
  private sessionController: AbortController | null = null
  private current: Running | null = null
  private suspended: Running[] = []
  private chatQueue: { to?: string, msg: string }[] = []
  private lastChat = 0
  private stopping = false

  constructor (definition: BotDefinition, server: ServerConfig, opts: InstanceOptions = {}) {
    super()
    this.definition = definition
    this.server = server
    this.username = opts.username || definition.username || definition.name
    this.log = createLogger(this.username)
    this.dataDir = opts.dataDir || join('data', 'bots', this.username)
    this.storage = new Storage(this.dataDir)
    this.settings = { ...definition.settings, ...opts.settings }
    const envOwners = listFromEnv(process.env.MC_OWNERS)
    this.owners = (opts.owners ?? (definition.owners?.length ? definition.owners : envOwners)).map(s => s.toLowerCase())
    this.canDig = opts.canDig ?? definition.canDig ?? process.env.MC_CAN_DIG === 'true'
    this.reconnectDelayMs = opts.reconnectDelayMs ?? Number(process.env.MC_RECONNECT_DELAY_MS || 10000)
    this.channels = new ChannelStore(join('data', `channels-${server.host}-${server.port}.json`))
    this.skills = definition.skills
    this.brains = definition.brains

    for (const skill of this.skills) {
      for (const action of skill.actions ?? []) this.registerAction(action)
    }
  }

  // ---------------------------------------------------------------- fleet

  /** Called by Fleet.add(). Every running agent belongs to a fleet (a fleet of one for `run`). */
  attachFleet (fleet: Fleet, serverName: string): void {
    this._fleet = fleet
    this._serverName = serverName
  }

  get fleet (): Fleet {
    if (!this._fleet) throw new Error('agent is not part of a fleet')
    return this._fleet
  }

  /** Name of the server this agent is on (fleet file key, "default" otherwise). */
  get serverName (): string {
    return this._serverName
  }

  // ---------------------------------------------------------------- actions

  registerAction (action: ActionDef<any>): void {
    if (this.actions.has(action.name)) throw new Error(`duplicate action "${action.name}"`)
    this.actions.set(action.name, action)
    for (const a of action.aliases ?? []) this.aliases.set(a, action.name)
  }

  getAction (name: string): ActionDef | undefined {
    return this.actions.get(name) ?? this.actions.get(this.aliases.get(name) ?? '')
  }

  listActions (): ActionDef[] {
    return [...this.actions.values()]
  }

  /** Actions as tool definitions (JSON schema), for LLM brains. */
  actionCatalog (): ActionCatalogEntry[] {
    return this.listActions().filter(a => !a.internal).map(a => ({
      name: a.name,
      description: a.description,
      inputSchema: z.toJSONSchema(a.params, { io: 'input' }) as Record<string, unknown>,
      exclusive: a.exclusive !== false,
      longRunning: !!a.longRunning
    }))
  }

  /** The action currently holding the body, if any. */
  get currentAction (): ActionInfo | null {
    const c = this.current
    return c ? { name: c.def.name, params: c.params, caller: c.caller, priority: c.priority } : null
  }

  /**
   * Runs an action by name. Exclusive actions take the body: a higher-priority call preempts
   * the current one (long-running ones are resumed afterwards), a lower-priority call is
   * rejected while the body is busy.
   */
  async act (name: string, params: unknown = {}, opts: ActOptions = {}): Promise<ActionResult> {
    const def = this.getAction(name)
    if (!def) return fail(`unknown action "${name}"`)
    const parsed = def.params.safeParse(params ?? {})
    if (!parsed.success) return fail(`bad parameters for ${def.name}: ${z.prettifyError(parsed.error).replace(/\n/g, '; ')}`)
    if (!this._bot || !this.sessionController) return fail('not connected')

    const caller = opts.caller ?? { kind: 'system', name: 'system' }
    const priority = opts.priority ?? defaultPriority(caller)
    const player = opts.player ?? (caller.kind === 'player' ? caller.name : undefined)
    const run: Running = { def, params: parsed.data, caller, priority, player, controller: new AbortController() }

    if (def.exclusive === false) return this.execute(run)

    const cur = this.current
    if (cur) {
      if (cur.priority > priority) return fail(`busy: ${cur.def.name} (${cur.caller.kind} ${cur.caller.name})`)
      if (cur.def.longRunning && priority > cur.priority) {
        cur.preempted = true
        this.suspended.push(cur)
        cur.controller.abort('preempted')
      } else {
        cur.controller.abort('replaced')
      }
    }
    this.current = run
    const result = await this.execute(run)
    if (this.current === run) {
      this.current = null
      this.resumeSuspended()
    }
    return result
  }

  /** Stops the current action and forgets suspended ones. */
  stopActions (reason = 'stopped'): void {
    this.suspended = []
    this.current?.controller.abort(reason)
    this.current = null
    this._bot?.pathfinder?.setGoal(null)
  }

  private async execute (run: Running): Promise<ActionResult> {
    const bot = this._bot!
    const session = this.sessionController!
    const onSessionEnd = () => run.controller.abort('session ended')
    session.signal.addEventListener('abort', onSessionEnd, { once: true })
    const info: ActionInfo = { name: run.def.name, params: run.params, caller: run.caller, priority: run.priority }
    const ctx: ActionContext = {
      agent: this,
      bot,
      signal: run.controller.signal,
      caller: run.caller,
      player: run.player,
      log: this.log.child(run.def.name)
    }
    this.emit('actionStart', info)
    this.log.debug(`action ${run.def.name} ${JSON.stringify(run.params)} by ${run.caller.kind}:${run.caller.name}`)
    let result: ActionResult
    try {
      result = normalizeResult(await run.def.run(ctx, run.params as any))
    } catch (e) {
      if (e instanceof ActionAbortedError || run.controller.signal.aborted) {
        result = fail(String(run.controller.signal.reason ?? 'stopped'))
      } else {
        this.log.warn(`action ${run.def.name} failed: ${(e as Error).stack ?? e}`)
        result = fail((e as Error).message)
      }
    } finally {
      session.signal.removeEventListener('abort', onSessionEnd)
    }
    this.emit('actionEnd', info, result)
    return result
  }

  private resumeSuspended (): void {
    const next = this.suspended.pop()
    if (!next || !this._bot) return
    this.log.debug(`resuming ${next.def.name}`)
    void this.act(next.def.name, next.params, { caller: next.caller, priority: next.priority, player: next.player })
  }

  // ---------------------------------------------------------------- chat

  /** Public chat, rate limited. */
  say (msg: string): void {
    this.enqueueChat({ msg })
  }

  /** Whisper to a player, rate limited. */
  whisper (player: string, msg: string): void {
    this.enqueueChat({ to: player, msg })
  }

  /** Replies the way a message came in (whisper → whisper, chat → chat). */
  reply (to: ChatMessage | string, msg: string): void {
    if (typeof to === 'string') return this.say(msg)
    if (to.whisper) this.whisper(to.from, msg)
    else this.say(msg)
  }

  private enqueueChat (item: { to?: string, msg: string }): void {
    for (const line of splitChat(item.msg)) {
      if (this.chatQueue.length >= CHAT_QUEUE_MAX) { this.log.warn('chat queue full, dropping message'); return }
      this.chatQueue.push({ to: item.to, msg: line })
    }
  }

  private pumpChat (): void {
    const bot = this._bot
    if (!bot || !this.chatQueue.length || Date.now() - this.lastChat < CHAT_INTERVAL_MS) return
    const { to, msg } = this.chatQueue.shift()!
    this.lastChat = Date.now()
    try {
      if (to) bot.whisper(to, msg)
      else bot.chat(msg)
    } catch (e) {
      this.log.warn(`chat failed: ${(e as Error).message}`)
    }
  }

  isOwner (player: string): boolean {
    return this.owners.length === 0 || this.owners.includes(player.toLowerCase())
  }

  // ---------------------------------------------------------------- world

  get bot (): Bot {
    if (!this._bot) throw new Error('not connected')
    return this._bot
  }

  get connected (): boolean {
    return !!this._bot?.entity
  }

  /** JSON-friendly snapshot of the bot and its surroundings. */
  observe (): Record<string, unknown> {
    const bot = this._bot
    if (!bot?.entity) return { connected: false }
    const pos = bot.entity.position
    const near = Object.values(bot.entities)
      .filter(e => e !== bot.entity && e.position.distanceTo(pos) < 24)
      .sort((a, b) => a.position.distanceTo(pos) - b.position.distanceTo(pos))
      .slice(0, 12)
      .map(e => ({
        name: e.type === 'player' ? e.username : (e.name ?? 'unknown'),
        type: e.type,
        distance: Math.round(e.position.distanceTo(pos)),
        position: fmtPos(e.position)
      }))
    const inventory: Record<string, number> = {}
    for (const i of bot.inventory.items()) inventory[itemName(i)] = (inventory[itemName(i)] ?? 0) + i.count
    const snapshot: Record<string, unknown> = {
      username: bot.username,
      position: fmtPos(pos),
      dimension: bot.game.dimension,
      gameMode: bot.game.gameMode,
      health: Math.round(bot.health),
      food: bot.food,
      timeOfDay: bot.time.timeOfDay,
      isDay: bot.time.timeOfDay < 13000 || bot.time.timeOfDay > 23000,
      heldItem: bot.heldItem ? itemName(bot.heldItem) : null,
      currentAction: this.currentAction ? { name: this.currentAction.name, params: this.currentAction.params } : null,
      players: Object.keys(bot.players).filter(p => p !== bot.username),
      nearby: near,
      inventory
    }
    for (const skill of this.skills) {
      if (!skill.observe) continue
      try {
        Object.assign(snapshot, skill.observe(this, bot))
      } catch (e) {
        this.log.debug(`observe ${skill.name}: ${(e as Error).message}`)
      }
    }
    return snapshot
  }

  // ---------------------------------------------------------------- lifecycle

  /** Connects and keeps reconnecting until stop(). Resolves when stopped. */
  async start (): Promise<void> {
    installTolerantParser((id, e) => this.log.debug(`skipped packet ${id}: ${e.message.slice(0, 120)}`))
    for (const brain of this.brains) await brain.start?.(this)
    this.log.info(`starting: ${this.skills.length} skills, ${this.actions.size} actions, brains: ${this.brains.map(b => b.name).join(', ') || 'none'}`)
    let learnRounds = 0
    while (!this.stopping) {
      const { reason, detail } = await this.runSession()
      if (this.stopping) break
      if (reason === 'learned' && learnRounds++ < 15) {
        await delay(4500)
        continue
      }
      learnRounds = 0
      this.log.info(`disconnected${detail ? ` (${detail})` : ''}, reconnecting in ${this.reconnectDelayMs / 1000}s`)
      await delay(this.reconnectDelayMs)
    }
  }

  async stop (): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    for (const brain of this.brains) {
      try { await brain.stop?.(this) } catch (e) { this.log.warn(`brain ${brain.name} stop: ${(e as Error).message}`) }
    }
    this._bot?.quit()
    this.storage.flush()
    this.emit('stopped')
  }

  private runSession (): Promise<{ reason: 'learned' | 'ended', detail?: string }> {
    return new Promise(resolve => {
      const session = new AbortController()
      const cleanups: (() => void)[] = []
      let finished = false

      this.log.info(`connecting to ${this.server.host}:${this.server.port} (${this.server.auth}), ${this.channels.size} known NeoForge channels`)
      const bot = mineflayer.createBot({
        host: this.server.host,
        port: this.server.port,
        username: this.username,
        auth: this.server.auth,
        version: this.server.version,
        profilesFolder: '.auth',
        checkTimeoutInterval: 60_000,
        hideErrors: true
      })

      const finish = (reason: 'learned' | 'ended', detail?: string) => {
        if (finished) return
        finished = true
        session.abort('session ended')
        this.current = null
        this.suspended = []
        this.chatQueue = []
        for (const c of cleanups.reverse()) { try { c() } catch {} }
        try { bot.quit() } catch {}
        this._bot = null
        this.sessionController = null
        this.emit('sessionEnd', detail ?? reason)
        resolve({ reason, detail })
      }

      attachNeoForge(bot._client, this.channels, m => this.log.debug(m))
      bot._client.on('neoforge_failed' as any, (failures: Record<string, unknown>) => {
        const { changed, unknown } = this.channels.learn(failures)
        this.channels.save()
        for (const u of unknown.slice(0, 10)) this.log.warn(`unhandled negotiation failure: ${u}`)
        this.log.info(`server rejected our channel list (${Object.keys(failures).length} issues), ${changed ? `learned, now ${this.channels.size} channels` : 'nothing new learned'}`)
        finish(changed ? 'learned' : 'ended', changed ? undefined : 'negotiation failed and nothing new to learn')
      })

      bot.loadPlugin(pf.pathfinder)
      const loaded = new Set<unknown>()
      for (const skill of this.skills) {
        for (const plugin of skill.plugins ?? []) {
          if (!loaded.has(plugin)) { loaded.add(plugin); bot.loadPlugin(plugin) }
        }
      }

      bot.once('login', () => solidifyUnknownBlocks(bot.registry))

      bot.once('spawn', () => {
        this._bot = bot
        this.sessionController = session
        this.log.info(`spawned at ${fmtPos(bot.entity.position)} (${bot.game.dimension}, ${bot.game.gameMode})`)
        const moves = new pf.Movements(bot)
        moves.canDig = this.canDig
        moves.allow1by1towers = false
        bot.pathfinder.setMovements(moves)

        const chatTimer = setInterval(() => this.pumpChat(), 100)
        cleanups.push(() => clearInterval(chatTimer))

        for (const skill of this.skills) {
          try {
            const c = skill.setup?.(this, bot)
            if (c) cleanups.push(c)
          } catch (e) {
            this.log.error(`skill ${skill.name} setup failed: ${(e as Error).stack}`)
          }
        }
        for (const brain of this.brains) {
          try {
            const c = brain.session?.(this, bot)
            if (c) cleanups.push(c)
          } catch (e) {
            this.log.error(`brain ${brain.name} session failed: ${(e as Error).stack}`)
          }
        }
        try { this.definition.onSpawn?.(this, bot) } catch (e) { this.log.error(`onSpawn: ${(e as Error).stack}`) }
        this.emit('session', bot)
      })

      bot.on('chat', (username, message) => {
        if (username !== bot.username) this.emit('chat', { from: username, message, whisper: false })
      })
      bot.on('whisper', (username, message) => {
        if (username !== bot.username) this.emit('chat', { from: username, message, whisper: true })
      })
      bot.on('messagestr', (msg, position) => {
        if (position !== 'chat') this.emit('serverMessage', msg)
      })
      bot.on('death', () => {
        this.log.info('died')
        this.stopActions('died')
      })
      bot.on('kicked', (reason) => this.log.warn(`kicked: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`))
      bot.on('error', (e) => this.log.warn(`error: ${e.message}`))
      bot.on('end', (why) => finish('ended', why))
    })
  }
}

function defaultPriority (caller: Caller): number {
  switch (caller.kind) {
    case 'player': return PRIORITY.player
    case 'reflex': return PRIORITY.reflex
    case 'system': return PRIORITY.system
    default: return PRIORITY.npc
  }
}

/** Splits long text into chat-sized lines (vanilla limit is 256 chars). */
function splitChat (msg: string): string[] {
  const out: string[] = []
  for (const para of msg.split('\n')) {
    let rest = para.trim()
    while (rest.length > 240) {
      let cut = rest.lastIndexOf(' ', 240)
      if (cut < 100) cut = 240
      out.push(rest.slice(0, cut))
      rest = rest.slice(cut).trim()
    }
    if (rest) out.push(rest)
  }
  return out
}

const delay = (ms: number) => new Promise(r => setTimeout(r, ms))
