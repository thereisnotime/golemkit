// The Minecraft Java adapter: one Mineflayer bot per session, with the pathfinder, the skills'
// plugins, the server platform (NeoForge handshake, registries) and the journal capture. The
// Agent (src/core/agent.ts) keeps the action lock, chat queue, storage and brains, and talks to
// this through the GameAdapter interface.
import mineflayer, { type Bot } from 'mineflayer'
import pf from 'mineflayer-pathfinder'
import type {
  GameAdapter, AdapterEvents, AdapterConnectOptions, Capability, Observation, SelfState, Pos,
  SeenEntity, InventoryStack, WorldTime
} from '../../core/adapter.ts'
import { KNOWN_CAPABILITIES } from '../../core/adapter.ts'
import type { Agent } from '../../core/agent.ts'
import type { Logger } from '../../core/log.ts'
import { getPath } from '../../core/toggles.ts'
import type { PlatformContext, ServerPlatform } from './platform.ts'
import { platformFor } from './platforms/index.ts'
import { fmtPos, itemName, gameModeNote, isHostile } from './helpers.ts'
import { watchRefusedDigs } from './refusals.ts'
import { holdStill, fidget } from './humanize.ts'
import { inDanger } from './danger.ts'
import { JournalCapture } from './journal-capture.ts'
import { watchDeaths } from './deaths.ts'
import './types.ts'

type EventName = keyof AdapterEvents
interface Sub {
  event: EventName
  fn: (...args: any[]) => void
  /** listeners on the current bot, to detach */
  offs: (() => void)[]
}

export class MinecraftJavaAdapter implements GameAdapter {
  readonly game = 'minecraft-java'
  readonly capabilities = new Set<Capability>(KNOWN_CAPABILITIES.filter(c => c !== 'mods'))
  private agent!: Agent
  private platform!: ServerPlatform
  private platformLog!: Logger
  private capture!: JournalCapture
  private bot: Bot | null = null
  private spawned = false
  private sessionCleanups: (() => void)[] = []
  private readonly subs: Sub[] = []
  private readonly spawnFns = new Set<() => void>()

  attach (agent: Agent): void {
    this.agent = agent
    this.platform = platformFor(agent.server)
    for (const c of this.platform.capabilities) this.capabilities.add(c)
    this.platformLog = agent.log.child(this.platform.name)
    this.capture = new JournalCapture(agent, agent.journal)
  }

  get client (): Bot | null {
    return this.bot
  }

  get connected (): boolean {
    return this.spawned && !!this.bot?.entity
  }

  start (): void {
    this.platform.install?.({ server: this.agent.server, settings: this.agent.settings, log: this.platformLog })
  }

  // ---------------------------------------------------------------- session

  async connect (opts: AdapterConnectOptions): Promise<void> {
    const agent = this.agent
    const server = agent.server
    const more = this.platform.describe?.()
    agent.log.info(`connecting to ${server.host}:${server.port} (${server.auth})${more ? `, ${more}` : ''}`)
    const bot = mineflayer.createBot({
      host: server.host,
      port: server.port,
      username: opts.username,
      auth: server.auth,
      version: server.version,
      profilesFolder: '.auth',
      checkTimeoutInterval: 60_000,
      hideErrors: true
    })
    for (const s of this.subs) { for (const off of s.offs) off(); s.offs = [] }
    this.bot = bot
    this.spawned = false
    this.sessionCleanups = []
    const ctx: PlatformContext = {
      server,
      settings: agent.settings,
      log: this.platformLog,
      end: (reason, detail) => { if (this.bot === bot) for (const s of this.subs.filter(x => x.event === 'end')) s.fn(reason, detail) }
    }

    this.platform.attach?.(bot, ctx)
    bot.loadPlugin(pf.pathfinder)
    const loaded = new Set<unknown>()
    for (const skill of agent.definition.skills) {
      for (const plugin of skill.plugins ?? []) {
        if (!loaded.has(plugin)) { loaded.add(plugin); bot.loadPlugin(plugin as any) }
      }
    }
    this.platform.afterPlugins?.(bot, { ...ctx, settings: agent.settings })
    bot.once('login', () => this.platform.onLogin?.(bot, { ...ctx, settings: agent.settings }))

    bot.once('spawn', () => {
      this.spawned = true
      agent.log.info(`spawned at ${fmtPos(bot.entity.position)} (${bot.game.dimension}, ${bot.game.gameMode})`)
      const moves = new pf.Movements(bot)
      moves.canDig = agent.canDig
      moves.allow1by1towers = false
      moves.allowSprinting = true // explicit: travel sprints
      moves.allowParkour = true
      // Never plan long drops into water (the default allows any height): Pax died falling 32 blocks
      // into a ravine pool. Normal max drop (4) still applies.
      ;(moves as { infiniteLiquidDropdownDistance?: boolean }).infiniteLiquidDropdownDistance = false
      moves.exclusionAreasBreak.push(agent.protectedAreas.breakCost)
      bot.pathfinder.setMovements(moves)
      this.applyPathfinderSettings(bot)
      this.sessionCleanups.push(watchRefusedDigs(bot, (pos) => agent.markProtected(pos)))
      try { this.sessionCleanups.push(this.capture.session(bot)) } catch (e) { agent.log.warn(`journal: ${(e as Error).message}`) }
      for (const fn of [...this.spawnFns]) fn()
    })
    // before the agent's listeners: the action holding the body is still set at the death event
    const unwatch = watchDeaths(bot, agent, r => {
      if (this.bot !== bot) return
      for (const s of this.subs.filter(x => x.event === 'deathCause')) { try { s.fn(r) } catch (e) { agent.log.warn(`deathCause: ${(e as Error).message}`) } }
    })
    bot.once('end', unwatch)
    for (const s of this.subs) this.bind(s, bot)
  }

  endSession (): void {
    for (const c of this.sessionCleanups.reverse()) { try { c() } catch {} }
    this.sessionCleanups = []
    const bot = this.bot
    try { bot?.quit() } catch {}
    this.bot = null
    this.spawned = false
  }

  async disconnect (): Promise<void> {
    this.bot?.quit()
  }

  // ---------------------------------------------------------------- events

  on<E extends EventName> (event: E, fn: AdapterEvents[E]): void {
    if (event === 'spawn') { this.spawnFns.add(fn as () => void); return }
    const s: Sub = { event, fn: fn as (...a: any[]) => void, offs: [] }
    this.subs.push(s)
    if (this.bot) this.bind(s, this.bot)
  }

  off<E extends EventName> (event: E, fn: AdapterEvents[E]): void {
    if (event === 'spawn') { this.spawnFns.delete(fn as () => void); return }
    const i = this.subs.findIndex(s => s.event === event && s.fn === fn)
    if (i < 0) return
    for (const off of this.subs[i]!.offs) off()
    this.subs.splice(i, 1)
  }

  /** Puts one subscription on the bot as Mineflayer listeners (so it keeps its place among the bot's other listeners). */
  private bind (s: Sub, bot: Bot): void {
    const fn = s.fn
    const add = (ev: string, l: (...a: any[]) => void) => {
      bot.on(ev as any, l)
      s.offs.push(() => bot.off(ev as any, l))
    }
    switch (s.event) {
      case 'chat':
        add('chat', (u: string, m: string) => { if (u !== bot.username) fn(u, m, false) })
        add('whisper', (u: string, m: string) => { if (u !== bot.username) fn(u, m, true) })
        break
      case 'serverMessage': add('messagestr', (m: string, position: string) => { if (position !== 'chat') fn(m, position) }); break
      case 'hurt': add('entityHurt', (e: unknown) => { if (e === bot.entity) fn(bot.health) }); break
      case 'health': add('health', () => fn(bot.health, bot.food)); break
      case 'death': add('death', () => fn()); break
      case 'deathCause': break // emitted by watchDeaths (connect)
      case 'respawn': add('spawn', () => fn()); break
      case 'playerJoined': add('playerJoined', (p: { username: string }) => { if (p.username !== bot.username) fn(p.username) }); break
      case 'playerLeft': add('playerLeft', (p: { username: string }) => { if (p.username !== bot.username) fn(p.username) }); break
      case 'gameMode': {
        let last = bot.game?.gameMode
        add('game', () => {
          if (bot.game.gameMode === last) return
          const previous = last
          last = bot.game.gameMode
          fn(last, previous)
        })
        break
      }
      case 'kicked': add('kicked', (reason: unknown) => fn(typeof reason === 'string' ? reason : JSON.stringify(reason))); break
      case 'error': add('error', (e: Error) => fn(e)); break
      case 'end': add('end', (why: string) => fn('ended', why)); break
    }
  }

  // ---------------------------------------------------------------- what the bot sees

  self (): SelfState | null {
    const bot = this.bot
    if (!this.spawned || !bot?.entity) return null
    return {
      username: bot.username,
      position: bot.entity.position,
      health: bot.health,
      food: bot.food,
      heldItem: bot.heldItem ? itemName(bot.heldItem) : null,
      sleeping: !!bot.isSleeping,
      game: {
        dimension: bot.game?.dimension,
        // World spawn (compass target); context packs use it for "don't dig near spawn" rules.
        spawnPoint: bot.spawnPoint ? fmtPos(bot.spawnPoint) : null,
        gameMode: bot.game?.gameMode,
        gameModeNote: gameModeNote(bot.game?.gameMode)
      }
    }
  }

  observe (): Observation | null {
    const self = this.self()
    const bot = this.bot
    if (!self || !bot) return null
    const pos = bot.entity.position
    const nearby = Object.values(bot.entities)
      .filter(e => e !== bot.entity && e.position.distanceTo(pos) < 24)
      .sort((a, b) => a.position.distanceTo(pos) - b.position.distanceTo(pos))
      .slice(0, 12)
      .map(e => ({
        name: (e.type === 'player' ? e.username : (e.name ?? 'unknown')) as string,
        type: e.type,
        distance: e.position.distanceTo(pos),
        position: e.position
      }))
    const inventory: Record<string, number> = {}
    for (const i of bot.inventory.items()) inventory[itemName(i)] = (inventory[itemName(i)] ?? 0) + i.count
    return {
      version: 1,
      game: this.game,
      self,
      time: { timeOfDay: bot.time.timeOfDay, isDay: bot.time.timeOfDay < 13000 || bot.time.timeOfDay > 23000 },
      players: Object.keys(bot.players).filter(p => p !== bot.username),
      nearby,
      inventory
    }
  }

  entities (): SeenEntity[] {
    const bot = this.bot
    const pos = bot?.entity?.position
    if (!bot || !pos) return []
    const out: SeenEntity[] = []
    for (const e of Object.values(bot.entities ?? {})) {
      if (e === bot.entity || !e.position) continue
      out.push({ id: e.id, name: e.name ?? '', type: e.type, ...(e.username ? { username: e.username } : {}), position: e.position, distance: e.position.distanceTo(pos), hostile: isHostile(e) })
    }
    return out
  }

  inventory (): { items: InventoryStack[], slots: number } {
    const inv = this.bot?.inventory
    if (!inv) return { items: [], slots: 36 }
    const foods = (this.bot!.registry as any)?.foodsByName ?? {}
    return {
      items: inv.items().map(i => ({ name: i.name, label: itemName(i), count: i.count, food: !!foods[i.name] })),
      slots: inv.inventoryEnd - inv.inventoryStart || 36
    }
  }

  time (): WorldTime | null {
    const t = this.bot?.time
    if (!t) return null
    const timeOfDay = t.timeOfDay ?? 0
    const storm = (this.bot as any).thunderState > 0
    return { timeOfDay, day: t.day, isDay: timeOfDay < 13000 || timeOfDay > 23000, isNight: storm || (timeOfDay >= 12542 && timeOfDay <= 23459) }
  }

  players (): string[] {
    return Object.keys(this.bot?.players ?? {})
  }

  playerPosition (name: string): Pos | null {
    return this.bot?.players?.[name]?.entity?.position ?? null
  }

  inDanger (): boolean {
    return !!this.bot && inDanger(this.bot)
  }

  // ---------------------------------------------------------------- chat and primitives

  chat (text: string, to?: string): Promise<void> {
    const bot = this.bot
    if (!bot) throw new Error('not connected')
    if (to) bot.whisper(to, text)
    else bot.chat(text)
    return Promise.resolve()
  }

  command (line: string): Promise<void> {
    const bot = this.bot
    if (!bot) throw new Error('not connected')
    bot.chat(line)
    return Promise.resolve()
  }

  stopMotion (): void {
    this.bot?.pathfinder?.setGoal(null)
  }

  /**
   * Pathfinder planning budget. The library default (5 s) fails with "Took to long to decide
   * path" on a loaded machine, where each 40 ms think slice gets fewer ticks; 10 s by default,
   * `pathfinder.thinkTimeoutMs` in settings or live via config_set.
   */
  private applyPathfinderSettings (bot: any): void {
    const ms = Number(getPath(this.agent.settings, 'pathfinder.thinkTimeoutMs'))
    bot.pathfinder.thinkTimeout = Number.isFinite(ms) && ms >= 1000 ? ms : 10_000
  }

  settingsChanged (key: string): void {
    const bot = this.bot as any
    if (bot?.pathfinder?.movements && (key === 'canDig' || key === '*')) bot.pathfinder.movements.canDig = this.agent.canDig
    if (bot?.pathfinder && (key.startsWith('pathfinder') || key === '*')) this.applyPathfinderSettings(bot)
  }

  replan (): void {
    const bot = this.bot
    const goal = bot?.pathfinder?.goal
    if (bot && goal) bot.pathfinder.setMovements(bot.pathfinder.movements) // forces a re-plan with the new exclusion
  }

  holdStill (ms: number, speaker?: string): Promise<void> {
    const bot = this.bot!
    const target = speaker ? bot.players[speaker]?.entity : undefined
    const face = target ? target.position.offset(0, target.height ?? 1.6, 0) : undefined
    return holdStill(bot, ms, face)
  }

  fidget (): void {
    if (this.bot) fidget(this.bot)
  }

  isMoving (): boolean {
    return !!this.bot?.pathfinder?.isMoving?.()
  }
}

/** The adapter factory for Minecraft Java servers. */
export const minecraftJava = (): MinecraftJavaAdapter => new MinecraftJavaAdapter()
