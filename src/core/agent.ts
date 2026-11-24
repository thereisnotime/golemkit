// The Agent is one bot identity. It outlives connections: it reconnects, re-runs skill and
// brain setup on every session, owns the action lock, chat queue and persistent storage.
// The game itself is behind a GameAdapter (core/adapter.ts); Minecraft Java is the default.
import { join } from 'node:path'
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
import { fmtPos } from './format.ts'
import type { Fleet } from './fleet.ts'
import { ProtectedAreas } from './protection.ts'
import { resolveRetry, actionAttempts, backoffMs, isRetryableResult, type RetryConfig } from './retry.ts'
import { TOGGLES, findToggle, parseToggleValue, getPath, expandPaths, deepMerge, type ToggleDef } from './toggles.ts'
import { resolveHumanize, typingDelayMs, styleLine, between, type HumanizeOptions } from './humanize.ts'
import type { UsageSnapshot } from '../llm/usage.ts'
import { Journal } from './journal/journal.ts'
import type { DeathReport } from './journal/deathReport.ts'
import { supports, type GameAdapter, type GameClient, type AdapterEvents, type Capability } from './adapter.ts'
// The default game until profiles pick one (game-adapters phase 4).
import { minecraftJava } from '../adapters/minecraft-java/adapter.ts'

export interface ChatMessage {
  from: string
  message: string
  whisper: boolean
  /**
   * Set by the first brain that takes the message on (e.g. 'intents'), so the others leave it
   * alone: one message, one handler. Brains that answer chat check it before acting.
   */
  claimedBy?: string
}

export interface ActionInfo {
  name: string
  params: unknown
  caller: Caller
  priority: number
  /** Player the action is for, if any. */
  player?: string
}

/** What askHelp / helpSorted carry (the HelpAsk of brains/npc/help.ts). */
export interface HelpEventInfo {
  behavior: string
  reason: string
  goal: string
  help: string | null
  text: string
  failures: number
  at: number
  to: string[]
  [k: string]: unknown
}

export type AgentEvents = {
  /** New session, bot spawned and skills/brains set up. */
  session: (bot: GameClient) => void
  sessionEnd: (reason: string) => void
  chat: (msg: ChatMessage) => void
  /** Any server/system message that isn't player chat. */
  serverMessage: (text: string) => void
  actionStart: (info: ActionInfo) => void
  actionEnd: (info: ActionInfo, result: ActionResult) => void
  /** After every LLM turn (llm brain): that turn's usage plus session/today/all-time totals. */
  llmUsage: (snapshot: UsageSnapshot) => void
  /** A chat line or whisper the bot actually sent (after the queue and humanize styling). */
  chatOut: (msg: { to?: string, message: string }) => void
  /** The server refused a block break here and the area is now avoided (see markProtected). */
  protectedArea: (pos: { x: number, y: number, z: number }) => void
  stopped: () => void
  /** A setting was changed in game (config_set / config_reset); key is the dotted path or '*'. */
  settingsChanged: (key: string) => void
  /** A behaviour kept failing the same way and asked its owners for help (brains/npc/help.ts, settings.askHelp). */
  askHelp: (ask: HelpEventInfo) => void
  /** A behaviour it had asked for help about works again. */
  helpSorted: (ask: HelpEventInfo) => void
  /** The server changed this bot's game mode (survival/creative/adventure/spectator). */
  gameModeChanged: (mode: string, previous: string) => void
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
  /** Category loggers: "<username>/action", "/chat", "/neoforge", "/server". */
  private readonly logs: { action: Logger, chat: Logger, server: Logger }
  readonly storage: Storage
  readonly dataDir: string
  readonly owners: string[]
  /** Settings from the variant, profile and fleet entry (without in-game overrides). */
  private readonly baseSettings: Record<string, unknown>
  private readonly baseCanDig: boolean
  private mergedSettings: Record<string, unknown> = {}

  private readonly actions = new Map<string, ActionDef>()
  private readonly aliases = new Map<string, string>()
  private readonly skills: SkillDef[]
  private readonly brains: BrainDef[]
  /** Retry policies (actions, LLM, reconnect) from env + settings.retry. */
  retry!: RetryConfig
  /** Areas where the server refuses block breaking (learned); the pathfinder won't dig there. */
  readonly protectedAreas: ProtectedAreas
  /** Event journal (data/bots/<username>/journal/), see docs/guide/journal.md. */
  readonly journal: Journal
  /** The game behind this agent (Minecraft Java unless InstanceOptions.adapter says otherwise). */
  readonly adapter: GameAdapter
  /** Actions left out because the adapter lacks a capability they need. */
  readonly unsupported: { name: string, missing: Capability[] }[] = []

  /** Bumped on every session, so delayed work can tell its session is gone. */
  private sessionId = 0
  private _fleet: Fleet | null = null
  private _serverName = 'default'
  private sessionController: AbortController | null = null
  private current: Running | null = null
  private suspended: Running[] = []
  private chatQueue: { to?: string, msg: string, face?: string, command?: (sent: boolean) => void }[] = []
  private lastChat = 0
  private chatSending = false
  /** Player-like timing (see humanize.ts); null when off. */
  humanize: HumanizeOptions | null = null
  private reconnectBaseOverride?: number
  private stopping = false

  constructor (definition: BotDefinition, server: ServerConfig, opts: InstanceOptions = {}) {
    super()
    this.definition = opts.persona ? { ...definition, persona: opts.persona } : definition
    this.server = server
    this.username = opts.username || definition.username || definition.name
    this.log = createLogger(this.username)
    this.logs = {
      action: this.log.child('action'),
      chat: this.log.child('chat'),
      server: this.log.child('server')
    }
    this.dataDir = opts.dataDir || join('data', 'bots', this.username)
    this.storage = new Storage(this.dataDir)
    this.baseSettings = { ...definition.settings, ...opts.settings }
    const envOwners = listFromEnv(process.env.MC_OWNERS)
    this.owners = (opts.owners ?? (definition.owners?.length ? definition.owners : envOwners)).map(s => s.toLowerCase())
    this.baseCanDig = opts.canDig ?? definition.canDig ?? process.env.MC_CAN_DIG === 'true'
    this.reconnectBaseOverride = opts.reconnectDelayMs
    this.recomputeSettings()
    this.protectedAreas = new ProtectedAreas(join('data', `protected-${server.host}-${server.port}.json`))
    this.skills = definition.skills
    this.brains = definition.brains
    this.journal = new Journal({ dir: join(this.dataDir, 'journal'), settings: this.settings, log: this.log.child('journal'), bot: this.username })
    this.adapter = (opts.adapter ?? definition.adapter ?? minecraftJava)()
    this.adapter.attach(this)

    for (const skill of this.skills) {
      for (const action of skill.actions ?? []) this.registerAction(action, skill.capabilities)
    }
    if (this.unsupported.length) this.log.debug(`left out (the game lacks what they need): ${this.unsupported.map(u => `${u.name} (${u.missing.join(', ')})`).join(', ')}`)
  }

  // ---------------------------------------------------------------- settings / toggles

  /**
   * What the bot is and how it's set up, for observe() (settings.selfAware, on unless set to false):
   * variant, profile, brains, LLM model and modes, the key toggles and which ones were changed in game.
   * Armed behaviours come from the behaviours brain's own observe field.
   */
  selfSummary (): Record<string, unknown> {
    const s = this.settings as Record<string, any>
    const llm = s.llm ?? {}
    const pick = (o: Record<string, unknown> | undefined, keys: string[]) =>
      Object.fromEntries(keys.filter(k => o?.[k] !== undefined).map(k => [k, o![k]]))
    return {
      variant: this.definition.name,
      ...(s.profileName ? { profile: s.profileName } : {}),
      brains: this.brains.map(b => (b as { name?: string }).name).filter(Boolean),
      owners: this.owners,
      ...(llm.provider || llm.model ? { llm: pick(llm, ['provider', 'model', 'effort', 'listen', 'immersive', 'aliases']) } : {}),
      settings: {
        canDig: this.canDig,
        respectBuilds: s.respectBuilds === true,
        ...(s.building ? { building: s.building } : {}),
        ...(s.reflexes ? { reflexes: pick(s.reflexes, ['selfDefense', 'autoEat', 'eatBelow', 'retreatBelow', 'waterFightAbove', 'rangedDefense', 'air', 'airBelow']) } : {}),
        ...(s.combat ? { combat: s.combat } : {}),
        ...(s.mining ? { mining: s.mining } : {}),
        ...(s.humanize?.enabled !== undefined ? { humanize: s.humanize.enabled } : {})
      },
      changedInGame: Object.keys(this.overrides()),
      ...(this.storage.get<string[] | undefined>('npcMode.armed') ? { mode: 'NPC mode (LLM paused): extra behaviours armed: ' + this.storage.get<string[]>('npcMode.armed')!.join(', ') } : {}),
      howToChange: 'owners: !config_list / !config_set <key> <value>; behaviours: !behavior_configure'
    }
  }

  /** The last death's cause report (adapter `deathCause`), shown in observe for 10 minutes. */
  lastDeathReport: (DeathReport & { at: number }) | null = null

  /** Effective settings: profile/variant values with in-game overrides (config_set) on top. */
  get settings (): Record<string, unknown> {
    return this.mergedSettings
  }

  get canDig (): boolean {
    const o = this.overrides().canDig
    return typeof o === 'boolean' ? o : this.baseCanDig
  }

  /** In-game overrides, flat dotted keys, persisted in storage. */
  overrides (): Record<string, unknown> {
    return this.storage.get<Record<string, unknown>>('settings.overrides', {})
  }

  private recomputeSettings (): void {
    const flat = { ...this.overrides() }
    delete flat.canDig
    this.mergedSettings = deepMerge(this.baseSettings, expandPaths(flat))
    this.humanize = resolveHumanize(this.mergedSettings)
    this.retry = resolveRetry(this.mergedSettings)
    if (this.reconnectBaseOverride) this.retry.reconnect.baseMs = this.reconnectBaseOverride
  }

  /** Toggleable settings with their current value and whether an override is active. */
  listToggles (): { def: ToggleDef, key: string, value: unknown, overridden: boolean }[] {
    const ov = this.overrides()
    const rows = TOGGLES.filter(t => !t.key.endsWith('.*')).map(def => ({
      def, key: def.key, value: def.key === 'canDig' ? this.canDig : getPath(this.settings, def.key), overridden: def.key in ov
    }))
    for (const [k, v] of Object.entries(ov)) {
      const def = findToggle(k)
      if (def?.key.endsWith('.*')) rows.push({ def, key: k, value: v, overridden: true })
    }
    return rows
  }

  /** Changes a toggle live (validated) and persists it. */
  setToggle (key: string, raw: unknown): { ok: true, value: unknown } | { ok: false, error: string } {
    const def = findToggle(key)
    if (!def) return { ok: false, error: `${key} can't be changed in game (see config_list)` }
    const parsed = parseToggleValue(def, raw)
    if (!parsed.ok) return parsed
    this.storage.set('settings.overrides', { ...this.overrides(), [key]: parsed.value })
    this.applyToggles(key)
    return parsed
  }

  /** Drops one override, or all of them. */
  resetToggle (key?: string): number {
    const ov = { ...this.overrides() }
    const keys = key ? Object.keys(ov).filter(k => k === key || k.startsWith(key + '.')) : Object.keys(ov)
    for (const k of keys) delete ov[k]
    this.storage.set('settings.overrides', ov)
    this.applyToggles(key ?? '*')
    return keys.length
  }

  private applyToggles (key: string): void {
    this.recomputeSettings()
    this.adapter.settingsChanged?.(key)
    this.log.info(`setting changed: ${key}`, { overrides: this.overrides() })
    this.emit('settingsChanged', key)
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

  /**
   * Adds an action. One that needs a capability the adapter lacks (its `capabilities`, else
   * `inherited` from its skill) is left out and listed in `unsupported`: no command, no LLM
   * tool, not in help.
   */
  registerAction (action: ActionDef<any>, inherited?: Capability[]): void {
    if (this.actions.has(action.name)) throw new Error(`duplicate action "${action.name}"`)
    const need = action.capabilities ?? inherited
    if (!supports(this.adapter.capabilities, need)) {
      this.unsupported.push({ name: action.name, missing: need!.filter(c => !this.adapter.capabilities.has(c)) })
      return
    }
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
    if (!this.adapter.client || !this.sessionController) return fail('not connected')

    const caller = opts.caller ?? { kind: 'system', name: 'system' }
    const priority = opts.priority ?? defaultPriority(caller)
    const player = opts.player ?? (caller.kind === 'player' ? caller.name : undefined)
    const run: Running = { def, params: parsed.data, caller, priority, player, controller: new AbortController() }

    if (def.exclusive === false) return this.executeWithRetry(run)

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
    // Humanize: a person takes a moment before doing what they were asked.
    if (this.humanize && (caller.kind === 'player' || caller.kind === 'brain')) {
      await new Promise(r => setTimeout(r, between(this.humanize!.actionHesitationMs)))
      if (this.current !== run) return fail('replaced')
    }
    const result = await this.executeWithRetry(run)
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
    this.adapter.stopMotion?.()
  }

  /**
   * Aborts the current action and drops suspended ones that match, leaving everything else
   * alone (unlike stopActions, which forgets every suspended action). Returns how many were
   * cancelled. Used by brains that need to stop only what they started.
   */
  cancelActions (match: (info: ActionInfo) => boolean, reason = 'cancelled'): number {
    const info = (r: Running): ActionInfo => ({ name: r.def.name, params: r.params, caller: r.caller, priority: r.priority })
    const before = this.suspended.length
    this.suspended = this.suspended.filter(r => !match(info(r)))
    let n = before - this.suspended.length
    const cur = this.current
    if (cur && match(info(cur))) {
      n++
      cur.controller.abort(reason)
      this.current = null
      this.adapter.stopMotion?.()
      this.resumeSuspended()
    }
    return n
  }

  /**
   * Runs the action, re-running it after a retryable failure as configured in
   * retry.actions (default: no retries). Stops retrying if the action was replaced,
   * preempted or stopped meanwhile.
   */
  private async executeWithRetry (run: Running): Promise<ActionResult> {
    let result = await this.execute(run)
    const extra = actionAttempts(this.retry, run.def.name)
    for (let attempt = 0; attempt < extra && !result.ok && isRetryableResult(result.message); attempt++) {
      const wait = backoffMs(attempt, this.retry.actionBackoffMs)
      this.logs.action.info(`retrying ${run.def.name} in ${Math.round(wait / 100) / 10}s`, { attempt: attempt + 1, of: extra, after: result.message })
      await delay(wait)
      const exclusive = run.def.exclusive !== false
      if (run.controller.signal.aborted || (exclusive && this.current !== run) || !this.sessionController) break
      result = await this.execute(run)
    }
    return result
  }

  private async execute (run: Running): Promise<ActionResult> {
    const bot = this.adapter.client as GameClient
    const session = this.sessionController!
    const onSessionEnd = () => run.controller.abort('session ended')
    session.signal.addEventListener('abort', onSessionEnd, { once: true })
    const info: ActionInfo = { name: run.def.name, params: run.params, caller: run.caller, priority: run.priority, ...(run.player ? { player: run.player } : {}) }
    const ctx: ActionContext = {
      agent: this,
      bot,
      signal: run.controller.signal,
      caller: run.caller,
      player: run.player,
      log: this.logs.action.child(run.def.name)
    }
    const started = Date.now()
    this.emit('actionStart', info)
    this.logs.action.debug(`start ${run.def.name}`, { params: run.params, caller: `${run.caller.kind}:${run.caller.name}`, priority: run.priority })
    let result: ActionResult
    try {
      result = normalizeResult(await run.def.run(ctx, run.params as any))
    } catch (e) {
      if (e instanceof ActionAbortedError || run.controller.signal.aborted) {
        result = fail(String(run.controller.signal.reason ?? 'stopped'))
      } else {
        this.logs.action.warn(`${run.def.name} threw: ${(e as Error).stack ?? e}`)
        result = fail((e as Error).message)
      }
    } finally {
      session.signal.removeEventListener('abort', onSessionEnd)
    }
    this.logs.action.debug(`end ${run.def.name}`, { ok: result.ok, ms: Date.now() - started, result: result.message })
    this.emit('actionEnd', info, result)
    return result
  }

  private resumeSuspended (): void {
    const next = this.suspended.pop()
    if (!next || !this.sessionController) return
    this.logs.action.debug(`resuming ${next.def.name}`, { caller: `${next.caller.kind}:${next.caller.name}` })
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
    this.enqueueChat({ ...(to.whisper ? { to: to.from } : {}), msg, face: to.from })
  }

  /**
   * Sends a server command (`/...`, `//...` for WorldEdit) through the same rate-limited queue
   * as chat, without humanize styling or line splitting, and logs it. Resolves true once it
   * went out, false when it was refused (too long, queue full, no session).
   */
  command (cmd: string): Promise<boolean> {
    const line = cmd.trim()
    if (!line.startsWith('/') || line.length > 256 || /[\r\n]/.test(line)) {
      this.logs.chat.warn('refused command', { command: line.slice(0, 80) })
      return Promise.resolve(false)
    }
    if (!this.sessionController || this.chatQueue.length >= CHAT_QUEUE_MAX) {
      this.logs.chat.warn(this.sessionController ? 'chat queue full, dropping command' : 'not connected, dropping command', { command: line })
      return Promise.resolve(false)
    }
    return new Promise(resolve => this.chatQueue.push({ msg: line, command: resolve }))
  }

  private enqueueChat (item: { to?: string, msg: string, face?: string }): void {
    for (const line of splitChat(item.msg)) {
      if (this.chatQueue.length >= CHAT_QUEUE_MAX) { this.logs.chat.warn('chat queue full, dropping message', { dropped: line }); return }
      this.chatQueue.push({ to: item.to, msg: line, face: item.face ?? item.to })
    }
  }

  private pumpChat (): void {
    if (!this.sessionController || this.chatSending || !this.chatQueue.length || Date.now() - this.lastChat < CHAT_INTERVAL_MS) return
    const item = this.chatQueue.shift()!
    if (item.command) {
      this.lastChat = Date.now()
      let sent = true
      try {
        void this.adapter.command(item.msg)
        this.logs.chat.info(`command ${item.msg}`)
      } catch (e) {
        sent = false
        this.logs.chat.warn(`command failed: ${(e as Error).message}`)
      }
      item.command(sent)
      return
    }
    if (!this.humanize) return this.sendChat(item.to, item.msg)
    // Humanize: react, maybe turn to the person and stand still, "type", then send.
    const h = this.humanize
    const session = this.sessionId
    this.chatSending = true
    const styled = styleLine(item.msg, h)
    const delay = typingDelayMs(styled.text, h, { reaction: Date.now() - this.lastChat > 4000 })
    const wait = h.pauseWhileTyping && this.adapter.holdStill
      ? this.adapter.holdStill(delay, h.lookAtSpeaker && item.face ? item.face : undefined)
      : new Promise(r => setTimeout(r, delay))
    void wait.then(() => {
      if (this.sessionId !== session || !this.sessionController) return
      this.sendChat(item.to, styled.text)
      if (styled.correction) this.chatQueue.unshift({ to: item.to, msg: styled.correction })
    }).finally(() => { this.chatSending = false })
  }

  private sendChat (to: string | undefined, msg: string): void {
    this.lastChat = Date.now()
    try {
      void this.adapter.chat(msg, to)
      this.logs.chat.info(to ? `-> ${to}: ${msg}` : `> ${msg}`)
      this.emit('chatOut', { ...(to ? { to } : {}), message: msg })
    } catch (e) {
      this.logs.chat.warn(`chat failed: ${(e as Error).message}`)
    }
  }

  /**
   * Records that the server refused a block break here (spawn protection, a claim). The
   * pathfinder stops planning digs in that area and re-plans right away.
   */
  markProtected (pos: { x: number, y: number, z: number }, opts: { confirmed?: boolean, crop?: boolean } = {}): void {
    if (!this.protectedAreas.add(pos, opts)) {
      if (opts.crop) this.log.debug('crop or plant break rolled back (lag), not a protected area', { at: fmtPos(pos) })
      else this.log.debug('break refused once here (lag or protection), watching for a second refusal', { at: fmtPos(pos) })
      return
    }
    this.emit('protectedArea', pos)
    this.log.info('server refuses block breaking here, not digging in this area anymore', { at: fmtPos(pos) })
    this.adapter.replan?.()
  }

  isOwner (player: string): boolean {
    return this.owners.length === 0 || this.owners.includes(player.toLowerCase())
  }

  // ---------------------------------------------------------------- world

  /** The game client for game-specific code (Minecraft Java: the Mineflayer bot). Throws when not in the world. */
  get bot (): GameClient {
    const client = this.adapter.client
    if (!client || !this.sessionController) throw new Error('not connected')
    return client as GameClient
  }

  /** Between spawn and the end of the session (the game client exists; `connected` also wants the bot's entity). */
  get inSession (): boolean {
    return !!this.sessionController && !!this.adapter.client
  }

  get connected (): boolean {
    return !!this.sessionController && this.adapter.connected
  }

  /** JSON-friendly snapshot of the bot and its surroundings. */
  observe (): Record<string, unknown> {
    const o = this.sessionController ? this.adapter.observe() : null
    if (!o) return { connected: false }
    const snapshot: Record<string, unknown> = {
      username: o.self.username,
      ...(this.settings.selfAware === false ? {} : { self: this.selfSummary() }),
      position: fmtPos(o.self.position),
      ...o.self.game,
      health: o.self.health === null ? null : Math.round(o.self.health),
      food: o.self.food,
      timeOfDay: o.time.timeOfDay,
      isDay: o.time.isDay,
      heldItem: o.self.heldItem,
      currentAction: this.currentAction ? { name: this.currentAction.name, params: this.currentAction.params } : null,
      players: o.players,
      nearby: o.nearby.map(e => ({ name: e.name, type: e.type, distance: Math.round(e.distance), position: fmtPos(e.position) })),
      inventory: o.inventory,
      // the facts about a death in the last 10 minutes, so nobody has to guess what killed it
      ...(this.lastDeathReport && Date.now() - this.lastDeathReport.at < 600_000
        ? { lastDeath: { cause: this.lastDeathReport.cause, detail: this.lastDeathReport.summary, secondsAgo: Math.round((Date.now() - this.lastDeathReport.at) / 1000) } }
        : {})
    }
    const bot = this.adapter.client as GameClient
    for (const part of [...this.skills, ...this.brains]) {
      if (!part.observe) continue
      try {
        Object.assign(snapshot, part.observe(this, bot))
      } catch (e) {
        this.log.debug(`observe ${part.name}: ${(e as Error).message}`)
      }
    }
    return snapshot
  }

  // ---------------------------------------------------------------- lifecycle

  /** Connects and keeps reconnecting until stop(). Resolves when stopped. */
  async start (): Promise<void> {
    this.adapter.start?.()
    for (const brain of this.brains) await brain.start?.(this)
    this.log.info(`starting: ${this.skills.length} skills, ${this.actions.size} actions, brains: ${this.brains.map(b => b.name).join(', ') || 'none'}`)
    let learnRounds = 0
    let failures = 0
    while (!this.stopping) {
      const startedAt = Date.now()
      const { reason, detail } = await this.runSession()
      if (this.stopping) break
      if (reason === 'learned' && learnRounds++ < 15) {
        await delay(4500)
        continue
      }
      learnRounds = 0
      // A session that lasted a while counts as healthy: start the backoff over.
      failures = Date.now() - startedAt > 60_000 ? 0 : failures + 1
      const { baseMs, maxMs } = this.retry.reconnect
      const wait = failures <= 1 ? baseMs : backoffMs(failures - 1, [baseMs, maxMs])
      this.log.info(`disconnected${detail ? ` (${detail})` : ''}, reconnecting in ${Math.round(wait / 1000)}s`, failures > 1 ? { attempt: failures } : undefined)
      await delay(wait)
    }
  }

  async stop (): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    for (const brain of this.brains) {
      try { await brain.stop?.(this) } catch (e) { this.log.warn(`brain ${brain.name} stop: ${(e as Error).message}`) }
    }
    void this.adapter.disconnect('stopped').catch(() => {})
    this.storage.flush()
    this.journal.stop()
    this.emit('stopped')
  }

  private runSession (): Promise<{ reason: 'learned' | 'ended', detail?: string }> {
    return new Promise(resolve => {
      const session = new AbortController()
      const cleanups: (() => void)[] = []
      const subs: [keyof AdapterEvents, (...a: any[]) => void][] = []
      const on = <E extends keyof AdapterEvents>(event: E, fn: AdapterEvents[E]) => {
        this.adapter.on(event, fn)
        subs.push([event, fn as (...a: any[]) => void])
      }
      let finished = false
      const adapter = this.adapter

      const finish = (reason: 'learned' | 'ended', detail?: string) => {
        if (finished) return
        finished = true
        session.abort('session ended')
        this.current = null
        this.suspended = []
        for (const q of this.chatQueue) q.command?.(false)
        this.chatQueue = []
        for (const c of cleanups.reverse()) { try { c() } catch {} }
        for (const [event, fn] of subs) adapter.off(event, fn as any)
        adapter.endSession()
        this.sessionController = null
        this.emit('sessionEnd', detail ?? reason)
        resolve({ reason, detail })
      }

      on('spawn', () => {
        this.sessionId++
        this.sessionController = session
        const bot = adapter.client as GameClient
        const onGame = (mode: string, previous: string) => {
          this.log.info(`game mode changed: ${previous} -> ${mode}`)
          this.emit('gameModeChanged', mode, previous)
        }
        on('gameMode', onGame)
        const chatTimer = setInterval(() => this.pumpChat(), 100)
        cleanups.push(() => clearInterval(chatTimer))
        if (this.humanize?.idleFidget && adapter.fidget) {
          const fidget = setInterval(() => {
            if (this.current || this.chatSending || adapter.isMoving?.() || Math.random() > 0.35) return
            adapter.fidget?.()
          }, 6000)
          cleanups.push(() => clearInterval(fidget))
        }

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

      on('chat', (from, message, whisper) => {
        this.logs.chat.info(whisper ? `<${from} whispers> ${message}` : `<${from}> ${message}`)
        this.emit('chat', { from, message, whisper })
      })
      on('serverMessage', (msg, position) => {
        this.logs.server.debug(msg, { position })
        this.emit('serverMessage', msg)
      })
      on('death', () => {
        const p = adapter.self()?.position
        this.log.info('died', p ? { at: fmtPos(p) } : undefined)
        this.stopActions('died')
      })
      on('deathCause', (r) => {
        this.lastDeathReport = { ...r, at: Date.now() }
        this.log.info(`death cause: ${r.summary}`)
      })
      on('kicked', (reason) => this.log.warn(`kicked: ${reason}`))
      on('error', (e) => this.log.warn(`error: ${e.message}`))
      on('end', (reason, detail) => finish(reason, detail))
      void adapter.connect({ username: this.username }).catch(e => {
        this.log.warn(`connect failed: ${(e as Error).message}`)
        finish('ended', (e as Error).message)
      })
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
