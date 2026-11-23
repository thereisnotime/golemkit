// One SceneRuntime per agent with the scene brain. It plays three parts:
// - member: registers the bot as an actor, performs commands from directors, reports players;
// - coordinator (when elected): handles start/stop requests, casts, runs the scheduler;
// - director host: runs Director instances for the runs it was given.
import { randomUUID } from 'node:crypto'
import { PRIORITY, sleep, distance, type Agent, type Blackboard, type FleetMessage, type Logger } from '../../core/index.ts'
import { Director, type StageWorld } from './director.ts'
import {
  BOARD, TOPIC, callerName, castRoles, electCoordinator, electDirector,
  type ActorEntry, type CancelMsg, type Command, type DirectMsg, type Done, type DoMsg, type DoneMsg,
  type PlayerMsg, type ReplyMsg, type RequestMsg, type RunInfo, type RunSummary
} from './protocol.ts'
import type { LineProvider, Scene, TimeOfDay } from './types.ts'

export interface SceneRuntimeOptions {
  scenes: Scene[]
  /** This bot directs every scene while online. */
  director?: boolean
  /** Roles this bot prefers to play. */
  roles?: string[]
  lineProvider?: LineProvider
  /** Run scene schedules (interval, game time, players nearby). Default true. */
  schedule?: boolean
  /** Idle filler between scenes, from scenes marked `schedule.ambient`. false disables. */
  ambient?: false | { gapMs?: [number, number], requirePlayersNear?: number }
  /** Notice players near cast members (approach/chat/hit hooks). Default true. */
  interact?: boolean
  /** May this player start/stop scenes? Default: anyone the command brain lets through. */
  allow?: (player: string, op: 'start' | 'stop', scene?: string) => boolean
}

/** Executes a director's command on this bot. Swappable for tests. */
export type Performer = (cmd: Command, ctx: { runId: string, beatId: number, signal: AbortSignal }) => Promise<Done>

const TIMES: Record<TimeOfDay, number> = { dawn: 0, morning: 1000, noon: 6000, dusk: 12000, night: 13000, midnight: 18000 }
const TIME_WINDOW = 1200
const CANCEL_REASON = 'scene:cancel'

const runtimes = new WeakMap<Agent, SceneRuntime>()
export const runtimeOf = (agent: Agent): SceneRuntime | undefined => runtimes.get(agent)

export class SceneRuntime {
  readonly agent: Agent
  readonly opts: SceneRuntimeOptions
  readonly log: Logger
  private world: StageWorld
  private performer: Performer
  private readonly directors = new Map<string, Director>()
  /** In-flight commands on this bot: runId -> beatId -> controller. */
  private readonly performing = new Map<string, Map<number, AbortController>>()
  private readonly cleanups: (() => void)[] = []
  private sessionCleanups: (() => void)[] = []
  private scheduler?: NodeJS.Timeout
  private readonly lastScheduled = new Map<string, number>()
  private readonly nextEvery = new Map<string, number>()
  private readonly firedAt = new Map<string, number>()
  private nextAmbient = 0
  private started = false

  constructor (agent: Agent, opts: SceneRuntimeOptions, deps: { world?: StageWorld, performer?: Performer } = {}) {
    this.agent = agent
    this.opts = opts
    this.log = agent.log.child('scene')
    this.world = deps.world ?? agentWorld(agent)
    this.performer = deps.performer ?? agentPerformer(agent)
    runtimes.set(agent, this)
  }

  get self (): string { return this.agent.username }
  get board (): Blackboard { return this.agent.fleet.board(this.agent.serverName) }

  scene (name: string): Scene | undefined {
    return this.opts.scenes.find(s => s.name === name)
  }

  actors (): Record<string, ActorEntry> {
    return this.board.get<Record<string, ActorEntry>>(BOARD.actors) ?? {}
  }

  runs (): Record<string, RunInfo> {
    return this.board.get<Record<string, RunInfo>>(BOARD.runs) ?? {}
  }

  /** The run this bot is cast in right now (null: not acting). Armed behaviours pause while set. */
  actingIn (): string | null {
    const id = this.actors()[this.self]?.busyIn
    return id && this.runs()[id] ? id : null
  }

  private updateActor (name: string, fn: (a: ActorEntry | undefined) => ActorEntry | undefined): void {
    const all = { ...this.actors() }
    const next = fn(all[name])
    if (next) all[name] = next
    else delete all[name]
    this.board.set(BOARD.actors, all)
  }

  setBusy (name: string, runId: string | undefined): void {
    this.updateActor(name, a => {
      if (!a) return a
      if (runId) return { ...a, busyIn: runId }
      const { busyIn: _, ...rest } = a
      return rest
    })
  }

  // ------------------------------------------------------------ lifecycle

  /** Once per agent: subscribes to the fleet bus and starts the scheduler. */
  start (): void {
    if (this.started) return
    this.started = true
    this.cleanups.push(this.agent.fleet.subscribe(this.agent, m => this.onMessage(m)))
    if (this.opts.schedule !== false || this.opts.ambient !== false) {
      this.scheduler = setInterval(() => { void this.tick() }, 5000)
      this.cleanups.push(() => clearInterval(this.scheduler))
    }
  }

  /** Every session: mark the bot online and start watching players. */
  online (): void {
    this.updateActor(this.self, a => {
      const busy = a?.busyIn && this.runs()[a.busyIn] ? { busyIn: a.busyIn } : {}
      return { online: true, director: !!this.opts.director, actions: this.agent.listActions().map(x => x.name), ...(this.opts.roles?.length ? { roles: this.opts.roles } : {}), ...busy }
    })
    if (this.opts.interact !== false) this.sessionCleanups.push(this.watchPlayers())
  }

  offline (): void {
    for (const c of this.sessionCleanups.splice(0)) { try { c() } catch {} }
    for (const runs of this.performing.values()) for (const c of runs.values()) c.abort(CANCEL_REASON)
    this.performing.clear()
    this.updateActor(this.self, a => a && { ...a, online: false })
  }

  /** Agent stops: stop the runs this bot directs and leave the registry. */
  stop (): void {
    for (const d of this.directors.values()) d.stop('director stopped', 'aborted')
    this.offline()
    for (const c of this.cleanups.splice(0)) { try { c() } catch {} }
    this.updateActor(this.self, () => undefined)
    this.started = false
  }

  // ------------------------------------------------------------ messaging

  /** Sends to a bot on this server; messages to ourselves are delivered locally. */
  send (to: string, topic: string, data: unknown): void {
    const msg: FleetMessage = { from: this.self, to, topic, data, server: this.agent.serverName }
    if (to === this.self) queueMicrotask(() => this.onMessage(msg))
    else this.agent.fleet.send(msg)
  }

  private broadcast (topic: string, data: unknown): void {
    this.agent.fleet.send({ from: this.self, topic, data, server: this.agent.serverName })
  }

  private onMessage (m: FleetMessage): void {
    switch (m.topic) {
      case TOPIC.do: void this.perform(m.from, m.data as DoMsg); break
      case TOPIC.done: {
        const d = m.data as DoneMsg
        this.directors.get(d.runId)?.onDone(d.beatId, d)
        break
      }
      case TOPIC.cancel: this.cancel(m.data as CancelMsg); break
      case TOPIC.player: {
        const p = m.data as PlayerMsg
        this.directors.get(p.runId)?.onPlayer(p)
        break
      }
      case TOPIC.request: void this.onRequest(m.from, m.data as RequestMsg); break
      case TOPIC.direct: this.onDirect(m.from, m.data as DirectMsg); break
    }
  }

  // ------------------------------------------------------------ member

  private async perform (director: string, msg: DoMsg): Promise<void> {
    const controller = new AbortController()
    let beats = this.performing.get(msg.runId)
    if (!beats) this.performing.set(msg.runId, beats = new Map())
    beats.set(msg.beatId, controller)
    let done: Done
    try {
      done = await this.performer(msg.cmd, { runId: msg.runId, beatId: msg.beatId, signal: controller.signal })
    } catch (e) {
      done = controller.signal.aborted ? { status: 'cancelled', message: 'cancelled' } : { status: 'failed', message: (e as Error).message }
    } finally {
      beats.delete(msg.beatId)
      if (!beats.size) this.performing.delete(msg.runId)
    }
    this.send(director, TOPIC.done, { runId: msg.runId, beatId: msg.beatId, ...done } satisfies DoneMsg)
    this.hold(msg.runId)
  }

  /**
   * Between beats a cast member holds its body with scene_hold at scene priority, so an NPC
   * brain (lower priority) backs off instead of wandering away or chatting over the scene.
   * The next beat replaces it; stopping the run cancels it with everything else.
   */
  private hold (runId: string): void {
    if (!this.agent.connected || !this.agent.getAction('scene_hold')) return
    if (this.actors()[this.self]?.busyIn !== runId || this.performing.get(runId)?.size) return
    const cur = this.agent.currentAction
    if (cur && cur.priority >= PRIORITY.scene) return
    void this.agent.act('scene_hold', {}, { caller: { kind: 'brain', name: `${callerName(runId)}hold` }, priority: PRIORITY.scene })
  }

  private cancel (msg: CancelMsg): void {
    const beats = this.performing.get(msg.runId)
    for (const [id, c] of beats ?? []) if (msg.beatId === undefined || id === msg.beatId) c.abort(CANCEL_REASON)
    const name = callerName(msg.runId, msg.beatId)
    const exact = msg.beatId !== undefined
    // Only the actions this run (or beat) started; everything else on the bot is left alone.
    this.agent.cancelActions(i => i.caller.kind === 'brain' && (exact ? i.caller.name === name : i.caller.name.startsWith(name)), CANCEL_REASON)
  }

  /** Watches for players near this bot while it is cast in a run. */
  private watchPlayers (): () => void {
    const inside = new Set<string>()
    const myRun = (): RunInfo | undefined => {
      const id = this.actors()[this.self]?.busyIn
      return id ? this.runs()[id] : undefined
    }
    const report = (run: RunInfo, evt: Omit<PlayerMsg, 'runId' | 'member'>) =>
      this.send(run.director, TOPIC.player, { runId: run.runId, member: this.self, ...evt } satisfies PlayerMsg)

    const timer = setInterval(() => {
      const run = myRun()
      if (!run?.approachRadius) { inside.clear(); return }
      const r = run.approachRadius
      const near = this.world.playersNear(this.self, r + 4)
      for (const p of near) {
        if (p.distance <= r && !inside.has(p.name)) {
          inside.add(p.name)
          report(run, { trigger: 'approach', player: p.name, distance: p.distance })
        }
      }
      // Re-arm once a player walks clearly away (hysteresis avoids flapping at the edge).
      for (const name of [...inside]) if (!near.some(p => p.name === name)) inside.delete(name)
    }, 1000)

    const offChat = this.agent.on('chat', (msg) => {
      const run = myRun()
      if (!run?.listens.chat || msg.whisper || this.agent.fleet.get(msg.from, this.agent.serverName)) return
      const text = msg.message.toLowerCase()
      const mentioned = Object.entries(run.cast).some(([role, user]) => text.includes(user.toLowerCase()) || new RegExp(`\\b${role}\\b`, 'i').test(text))
      const dist = this.world.playersNear(this.self, 32).find(p => p.name === msg.from)?.distance ?? Infinity
      if (!mentioned && dist > 32) return
      report(run, { trigger: 'chat', player: msg.from, distance: dist, message: msg.message, mentioned })
    })

    let offHurt = () => {}
    const game = (this.agent as Partial<Agent>).adapter
    if (game) {
      const onHurt = () => {
        const run = myRun()
        if (!run?.listens.hit) return
        const p = this.world.playersNear(this.self, 5).sort((a, b) => a.distance - b.distance)[0]
        if (p) report(run, { trigger: 'hit', player: p.name, distance: p.distance })
      }
      game.on('hurt', onHurt)
      offHurt = () => game.off('hurt', onHurt)
    }

    return () => { clearInterval(timer); offChat(); offHurt() }
  }

  // ------------------------------------------------------------ requests (any bot)

  coordinator (): string | undefined {
    return electCoordinator(this.actors())
  }

  /** Start or stop a scene from anywhere; routed to the coordinator. */
  async request (op: 'start' | 'stop', sceneName?: string, by?: string, player?: string): Promise<ReplyMsg> {
    const reqId = randomUUID().slice(0, 8)
    if (op === 'start' && sceneName && this.opts.allow && by && !this.opts.allow(by, op, sceneName)) return { reqId, ok: false, message: 'not allowed' }
    const coord = this.coordinator()
    if (!coord) return { reqId, ok: false, message: 'no scene actors online' }
    const req: RequestMsg = { reqId, op, ...(sceneName ? { scene: sceneName } : {}), ...(by ? { by } : {}), ...(player ? { player } : {}) }
    // Pass the scene itself along so the coordinator can run scenes only we know.
    if (sceneName && this.scene(sceneName)) req.sceneData = this.scene(sceneName)
    if (coord === this.self) return this.handleRequest(req)
    const reply = this.agent.fleet.waitFor(this.agent, m => m.topic === TOPIC.reply && (m.data as ReplyMsg).reqId === reqId, 8000)
    this.send(coord, TOPIC.request, req)
    try {
      return (await reply).data as ReplyMsg
    } catch {
      return { reqId, ok: false, message: `no answer from ${coord}` }
    }
  }

  private async onRequest (from: string, req: RequestMsg): Promise<void> {
    const reply = await this.handleRequest(req)
    this.send(from, TOPIC.reply, reply)
  }

  /** Coordinator: casts and hands the run to its director, or stops runs. */
  async handleRequest (req: RequestMsg): Promise<ReplyMsg> {
    const { reqId } = req
    const runs = Object.values(this.runs())
    if (req.op === 'stop') {
      const targets = runs.filter(r => !req.scene || r.scene === req.scene)
      if (!targets.length) return { reqId, ok: false, message: req.scene ? `${req.scene} isn't running` : 'no scene is running' }
      for (const r of targets) {
        const local = this.directors.get(r.runId)
        if (local) local.stop(req.by ? `stopped by ${req.by}` : 'stopped')
        else this.send(r.director, TOPIC.direct, { reqId, runId: r.runId, stop: true, ...(req.by ? { reason: `stopped by ${req.by}` } : {}) } satisfies DirectMsg)
      }
      return { reqId, ok: true, message: `stopping ${targets.map(r => r.scene).join(', ')}` }
    }
    const scene = (req.scene && this.scene(req.scene)) || req.sceneData
    if (!scene) return { reqId, ok: false, message: `no scene ${req.scene ?? '(none given)'}` }
    if (runs.some(r => r.scene === scene.name)) return { reqId, ok: false, message: `${scene.name} is already running` }
    const actors = this.actors()
    const cast = castRoles(scene, actors)
    if (!cast.ok) this.log.debug('casting failed', { scene: scene.name, error: cast.error })
    if (!cast.ok) return { reqId, ok: false, message: `can't cast ${scene.name}: ${cast.error}` }
    const director = electDirector(Object.values(cast.cast), actors)!
    this.log.debug('cast', { scene: scene.name, cast: cast.cast, director, ...(req.by ? { by: req.by } : {}) })
    const runId = `${scene.name}-${randomUUID().slice(0, 6)}`
    // Reserve the cast right away so a second request can't double-book it.
    for (const u of Object.values(cast.cast)) this.setBusy(u, runId)
    const direct: DirectMsg = { reqId, runId, scene, cast: cast.cast, ...(req.by ? { by: req.by } : {}), ...(req.player ? { player: req.player } : {}) }
    if (director === this.self) this.onDirect(this.self, direct)
    else this.send(director, TOPIC.direct, direct)
    const who = Object.entries(cast.cast).map(([r, u]) => `${u} as ${r}`).join(', ')
    return { reqId, ok: true, message: `starting ${scene.name}: ${who}` }
  }

  // ------------------------------------------------------------ director host

  private onDirect (_from: string, msg: DirectMsg): void {
    if (msg.stop) { this.directors.get(msg.runId)?.stop(msg.reason ?? 'stopped'); return }
    if (this.directors.has(msg.runId)) return
    const d = new Director({
      self: this.self,
      log: this.log,
      board: this.board,
      world: this.world,
      ...(this.opts.lineProvider ? { lineProvider: this.opts.lineProvider } : {}),
      send: (to, topic, data) => this.send(to, topic, data),
      broadcast: (topic, data) => this.broadcast(topic, data),
      onExternalCue: (fn) => this.agent.fleet.subscribe(this.agent, m => {
        const c = m.data as { runId?: string, cue?: string } | undefined
        if (m.topic === TOPIC.cue && c?.cue && c.runId !== msg.runId) fn(c.cue)
      }),
      actors: () => this.actors(),
      findReplacement: (scene, role, exclude) => {
        const r = castRoles(scene, this.actors(), { only: [role], exclude })
        return r.ok ? r.cast[role] : undefined
      },
      setBusy: (u, id) => this.setBusy(u, id)
    }, msg.runId, msg.scene, msg.cast, { ...(msg.by ? { by: msg.by } : {}), ...(msg.player ? { player: msg.player } : {}) })
    this.directors.set(msg.runId, d)
    void d.run().then((summary) => this.afterRun(summary)).finally(() => this.directors.delete(msg.runId))
  }

  /** Waits for a run of this runtime's directors to end (tests, scripts). */
  async waitForRun (runId: string, timeoutMs = 60_000): Promise<RunSummary | undefined> {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
      if (!this.runs()[runId] && !this.directors.has(runId)) {
        const last = this.board.get<RunSummary>(BOARD.last)
        return last?.runId === runId ? last : undefined
      }
      await sleep(20)
    }
    return undefined
  }

  private afterRun (_s: RunSummary): void {
    this.scheduleAmbientGap()
  }

  // ------------------------------------------------------------ scheduler (coordinator only)

  private scheduleAmbientGap (): void {
    const a = this.opts.ambient
    if (a === false) return
    const [min, max] = a?.gapMs ?? [120_000, 300_000]
    this.nextAmbient = Date.now() + min + Math.random() * (max - min)
  }

  private playersNearActors (radius: number, idleOnly = false): boolean {
    const actors = this.actors()
    return Object.entries(actors).some(([n, a]) => a.online && (!idleOnly || !a.busyIn) && this.world.playersNear(n, radius).length > 0)
  }

  private async trigger (scene: Scene, why: string): Promise<void> {
    const s = scene.schedule ?? {}
    const now = Date.now()
    if (now - (this.lastScheduled.get(scene.name) ?? 0) < (s.cooldownMs ?? 5 * 60_000)) return
    if (s.chance !== undefined && Math.random() >= s.chance) return
    if (s.requirePlayersNear && !this.playersNearActors(s.requirePlayersNear)) return
    if (Object.values(this.runs()).some(r => r.scene === scene.name)) return
    this.lastScheduled.set(scene.name, now)
    const r = await this.handleRequest({ reqId: `sched-${now}`, op: 'start', scene: scene.name, by: `schedule:${why}` })
    this.log.info(`schedule: ${r.message}`, { scene: scene.name, trigger: why })
  }

  private async tick (): Promise<void> {
    if (this.coordinator() !== this.self || !this.agent.connected) return
    const now = Date.now()
    if (this.opts.schedule !== false) {
      const time = this.world.time()
      for (const scene of this.opts.scenes) {
        const s = scene.schedule
        if (!s) continue
        if (s.everyMs) {
          const next = this.nextEvery.get(scene.name)
          if (next === undefined) this.nextEvery.set(scene.name, now + s.everyMs + Math.random() * (s.jitterMs ?? 0))
          else if (now >= next) {
            this.nextEvery.set(scene.name, now + s.everyMs + Math.random() * (s.jitterMs ?? 0))
            await this.trigger(scene, 'interval')
          }
        }
        if (s.at && time) {
          for (const at of s.at) {
            const tick = typeof at === 'number' ? at : TIMES[at]
            const key = `${scene.name}@${tick}`
            const into = (time.timeOfDay - tick + 24000) % 24000
            if (into < TIME_WINDOW && this.firedAt.get(key) !== time.day) {
              this.firedAt.set(key, time.day)
              await this.trigger(scene, `time ${at}`)
            }
          }
        }
        if (s.whenPlayersNear && this.playersNearActors(s.whenPlayersNear, true)) await this.trigger(scene, 'players near')
      }
    }
    const ambient = this.opts.ambient
    if (ambient !== false && !Object.keys(this.runs()).length) {
      if (!this.nextAmbient) this.scheduleAmbientGap()
      else if (now >= this.nextAmbient) {
        this.scheduleAmbientGap()
        const radius = ambient?.requirePlayersNear ?? 48
        if (radius > 0 && !this.playersNearActors(radius)) return
        const options = this.opts.scenes.filter(s => s.schedule?.ambient && castRoles(s, this.actors()).ok)
        const pick = options[Math.floor(Math.random() * options.length)]
        if (pick) {
          const r = await this.handleRequest({ reqId: `ambient-${now}`, op: 'start', scene: pick.name, by: 'ambient' })
          this.log.info(`ambient: ${r.message}`, { scene: pick.name })
        }
      }
    }
  }
}

// ------------------------------------------------------------ defaults backed by a real bot

/** Reads positions/players/time through the fleet's connected bots. */
export function agentWorld (agent: Agent): StageWorld {
  const bots = () => agent.fleet.onServer(agent.serverName).filter(a => a.connected)
  const isFleet = (name: string) => !!agent.fleet.get(name, agent.serverName)
  return {
    position (username) {
      const a = agent.fleet.get(username, agent.serverName)
      if (a?.connected) return a.adapter.self()?.position
      for (const b of bots()) {
        const p = b.adapter.playerPosition?.(username)
        if (p) return p
      }
      return undefined
    },
    playersNear (username, radius) {
      const a = agent.fleet.get(username, agent.serverName)
      if (!a?.connected) return []
      const self = a.adapter.self()
      if (!self) return []
      const out: { name: string, distance: number }[] = []
      for (const name of a.adapter.players?.() ?? []) {
        if (name === self.username || isFleet(name)) continue
        const p = a.adapter.playerPosition?.(name)
        if (!p) continue
        const d = distance(p, self.position)
        if (d <= radius) out.push({ name, distance: d })
      }
      return out
    },
    time () {
      const b = bots()[0]
      if (!b) return undefined
      const t = b.adapter.time?.()
      return t ? { timeOfDay: t.timeOfDay, day: t.day } : undefined
    }
  }
}

/** Runs commands through agent.act()/agent.say() at scene priority. */
export function agentPerformer (agent: Agent): Performer {
  return async (cmd, { runId, beatId, signal }) => {
    if (cmd.kind === 'say') {
      if (cmd.whisperTo) agent.whisper(cmd.whisperTo, cmd.text)
      else agent.say(cmd.text)
      return { status: 'ok', message: '' }
    }
    const def = agent.getAction(cmd.name)
    if (!def) return { status: 'failed', message: `no action ${cmd.name}` }
    if (def.exclusive !== false) {
      // The body may be held by a player command or a reflex: wait a bit, then give up.
      const until = Date.now() + cmd.busyWaitMs
      while ((agent.currentAction?.priority ?? 0) > PRIORITY.scene) {
        if (Date.now() >= until) return { status: 'busy', message: `busy with ${agent.currentAction!.name}` }
        await sleep(250, signal)
      }
    }
    if (signal.aborted) return { status: 'cancelled', message: 'cancelled' }
    const name = callerName(runId, beatId)
    const r = await agent.act(cmd.name, cmd.params, {
      caller: { kind: 'brain', name },
      priority: PRIORITY.scene,
      ...(cmd.player ? { player: cmd.player } : {})
    })
    // Long-running actions often end "ok" when aborted (follow), so check our signal first.
    if (signal.aborted || r.message === CANCEL_REASON) return { status: 'cancelled', message: 'cancelled' }
    if (r.ok) return { status: 'ok', message: r.message }
    if (r.message === 'preempted') {
      // Don't let a suspended scene action resume later on its own.
      agent.cancelActions(i => i.caller.kind === 'brain' && i.caller.name === name, CANCEL_REASON)
      return { status: 'preempted', message: 'preempted by a higher priority' }
    }
    if (r.message.startsWith('busy')) return { status: 'busy', message: r.message }
    return { status: 'failed', message: r.message }
  }
}
