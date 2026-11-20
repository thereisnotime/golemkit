// The director runs one scene with one cast: walks the beat tree, sends commands to cast
// members over the fleet bus, syncs cues, paces chat, pauses for player reactions and recasts
// roles when a member drops. It lives in the runtime of the elected director bot.
import { ActionAbortedError, sleep, type Blackboard, type Logger } from '../../core/index.ts'
import { renderParams, renderTemplate, pickVariant, provideLine, typingDelay, type TemplateContext } from './lines.ts'
import {
  BOARD, TOPIC,
  type ActorEntry, type CancelMsg, type Command, type Done, type DoMsg, type PlayerMsg, type RunInfo, type RunStatus, type RunSummary
} from './protocol.ts'
import type { Beat, Condition, InteractionSpec, InteractionTrigger, LineProvider, Range, Scene } from './types.ts'

export interface Vec { x: number, y: number, z: number }

/** What the director (and runtime) need from the world; faked in tests. */
export interface StageWorld {
  position (username: string): Vec | undefined
  /** Non-fleet players near a bot. */
  playersNear (username: string, radius: number): { name: string, distance: number }[]
  /** Game time from any online bot. */
  time (): { timeOfDay: number, day: number } | undefined
}

export interface DirectorHost {
  self: string
  log: Logger
  board: Blackboard
  world: StageWorld
  lineProvider?: LineProvider
  send (to: string, topic: string, data: unknown): void
  broadcast (topic: string, data: unknown): void
  /** Subscribes to cues broadcast by others; returns unsubscribe. */
  onExternalCue (fn: (cue: string) => void): () => void
  actors (): Record<string, ActorEntry>
  /** Finds an eligible replacement for a role (not in `exclude`). */
  findReplacement (scene: Scene, role: string, exclude: string[]): string | undefined
  setBusy (username: string, runId: string | undefined): void
  /** Random source (tests can make choices deterministic). */
  random?: () => number
}

/** Pause gate: closed while anything holds it (interaction, recast). */
class Gate {
  private holds = 0
  private waiters: (() => void)[] = []
  get open (): boolean { return this.holds === 0 }
  close (): void { this.holds++ }
  release (): void {
    if (this.holds > 0) this.holds--
    if (this.holds === 0) for (const w of this.waiters.splice(0)) w()
  }

  wait (signal: AbortSignal): Promise<void> {
    if (this.open) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(new ActionAbortedError())
      if (signal.aborted) return onAbort()
      signal.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(() => { signal.removeEventListener('abort', onAbort); resolve() })
    })
  }
}

/** Chat pacing shared by every director on a server (one pacer per blackboard). */
class Pacer {
  private last = 0
  private lastBy = new Map<string, number>()
  /** Reserves a slot and returns how long to wait before speaking. */
  reserve (who: string, typing: number, gap: number, botGap: number): number {
    const now = Date.now()
    const at = Math.max(now + typing, this.last + gap, (this.lastBy.get(who) ?? 0) + botGap)
    this.last = at
    this.lastBy.set(who, at)
    return at - now
  }
}
const pacers = new WeakMap<Blackboard, Pacer>()
const pacerFor = (b: Blackboard) => { let p = pacers.get(b); if (!p) pacers.set(b, p = new Pacer()); return p }

interface Inflight {
  user: string
  resolve: (d: Done) => void
  /** Cancelled because of a pause/recast: retry once the gate opens. */
  interrupted: boolean
  timer?: NodeJS.Timeout
}

interface ExecCtx {
  role?: string
  path: string
  /** Running an interaction reaction: bypasses the pause gate. */
  interaction?: { trigger: InteractionTrigger, message?: string }
}

const STOPPED = 'scene stopped'

export class Director {
  readonly runId: string
  readonly scene: Scene
  readonly cast: Record<string, string>
  readonly vars: Record<string, unknown>
  private readonly host: DirectorHost
  private readonly log: Logger
  private readonly controller = new AbortController()
  private readonly gate = new Gate()
  private readonly inflight = new Map<number, Inflight>()
  private readonly cues = new Set<string>()
  private readonly cueWaiters = new Map<string, (() => void)[]>()
  private readonly lastVariant = new Map<string, string>()
  private readonly lastChoice = new Map<string, number>()
  private readonly cooldowns = new Map<string, number>()
  private readonly pendingEvents = new Map<string, PlayerMsg[]>()
  private readonly recasting = new Set<string>()
  private readonly cleanups: (() => void)[] = []
  private beatSeq = 0
  private reactions = 0
  private reacting = false
  private anchor?: Vec
  private player?: string
  private status: RunStatus = 'starting'
  private stopReason?: string
  private result: RunSummary['result'] = 'finished'
  private readonly by?: string
  private readonly startedAt = Date.now()

  constructor (host: DirectorHost, runId: string, scene: Scene, cast: Record<string, string>, opts: { by?: string, player?: string } = {}) {
    this.host = host
    this.runId = runId
    this.scene = scene
    this.cast = { ...cast }
    this.vars = { ...scene.vars }
    this.log = host.log.with({ scene: scene.name, run: runId })
    this.by = opts.by
    this.player = opts.player
  }

  get signal (): AbortSignal { return this.controller.signal }
  get stopped (): boolean { return this.controller.signal.aborted }

  private rnd (): number { return (this.host.random ?? Math.random)() }
  private pick (r: Range): number {
    return Array.isArray(r) ? r[0] + this.rnd() * (r[1] - r[0]) : r
  }

  // ------------------------------------------------------------ lifecycle

  /** Runs the scene to the end (or until stopped). Never throws. */
  async run (): Promise<RunSummary> {
    const s = this.scene
    for (const user of Object.values(this.cast)) this.host.setBusy(user, this.runId)
    this.publish('starting')
    const limit = setTimeout(() => this.stop('time limit reached', 'aborted'), s.options.maxDurationMs)
    this.cleanups.push(() => clearTimeout(limit))
    this.cleanups.push(this.host.board.watch(BOARD.actors, () => this.checkCast()))
    this.cleanups.push(this.host.onExternalCue(cue => this.fire(cue, false)))
    try {
      this.anchor = this.resolveAnchor()
      if (!this.anchor && Object.keys(s.marks).length) this.log.warn('could not resolve the anchor; mark targets will be skipped', { anchor: s.anchor })
      else this.log.debug('anchor', { ...this.anchor })
      this.log.info(`starting ${s.name}`, { cast: this.cast, ...(this.by ? { by: this.by } : {}) })
      this.publish('running')
      this.checkCast()
      const tracks = Object.entries(s.tracks).map(([role, beats]) => this.runBeats(beats, { role, path: `tracks.${role}` }))
      await Promise.all([this.runBeats(s.beats, { path: 'beats' }), ...tracks])
    } catch (e) {
      if (!(e instanceof ActionAbortedError) && !this.stopped) {
        this.log.warn('run failed', { error: (e as Error).stack ?? String(e) })
        this.result = 'aborted'
        this.stopReason = (e as Error).message
      }
    } finally {
      this.finish()
    }
    const summary: RunSummary = { runId: this.runId, scene: s.name, result: this.result, ...(this.stopReason ? { reason: this.stopReason } : {}), endedAt: Date.now() }
    this.host.board.set(BOARD.last, summary)
    this.log.info(`${s.name} ${summary.result}`, { ...(summary.reason ? { reason: summary.reason } : {}), secs: Math.round((summary.endedAt - this.startedAt) / 1000) })
    return summary
  }

  /** Stops the run: aborts the timeline and cancels every action it started. */
  stop (reason = 'stopped', result: RunSummary['result'] = 'stopped'): void {
    if (this.stopped) return
    this.stopReason = reason
    this.result = result
    this.publish('stopping')
    this.controller.abort(STOPPED)
    this.cancelAll(false)
  }

  private finish (): void {
    if (!this.stopped) this.controller.abort(STOPPED)
    this.cancelAll(false)
    for (const c of this.cleanups.splice(0)) { try { c() } catch {} }
    this.pendingEvents.clear()
    for (const user of Object.values(this.cast)) this.host.setBusy(user, undefined)
    const runs = { ...this.host.board.get<Record<string, RunInfo>>(BOARD.runs) }
    delete runs[this.runId]
    this.host.board.set(BOARD.runs, runs)
  }

  /** Cancels in-flight beats on every cast member. `interrupt` marks them for retry. */
  private cancelAll (interrupt: boolean): void {
    for (const [id, f] of this.inflight) {
      if (interrupt) f.interrupted = true
      else this.settle(id, { status: 'cancelled', message: STOPPED })
    }
    for (const user of new Set(Object.values(this.cast))) this.host.send(user, TOPIC.cancel, { runId: this.runId } satisfies CancelMsg)
  }

  private publish (status: RunStatus, beat?: string): void {
    this.status = status
    const runs = { ...this.host.board.get<Record<string, RunInfo>>(BOARD.runs) }
    const prev = runs[this.runId]
    const approach = this.scene.interactions.filter(i => i.on === 'approach').map(i => i.radius ?? 6)
    runs[this.runId] = {
      runId: this.runId,
      scene: this.scene.name,
      director: this.host.self,
      cast: { ...this.cast },
      status,
      ...(beat ?? prev?.beat ? { beat: beat ?? prev?.beat } : {}),
      startedAt: prev?.startedAt ?? Date.now(),
      ...(this.by ? { by: this.by } : {}),
      ...(approach.length ? { approachRadius: Math.max(...approach) } : {}),
      listens: { chat: this.scene.interactions.some(i => i.on === 'chat'), hit: this.scene.interactions.some(i => i.on === 'hit') }
    }
    this.host.board.set(BOARD.runs, runs)
  }

  // ------------------------------------------------------------ messages in

  /** A cast member finished a command. */
  onDone (beatId: number, done: Done): void {
    this.settle(beatId, done)
  }

  private settle (beatId: number, done: Done): void {
    const f = this.inflight.get(beatId)
    if (!f) return
    clearTimeout(f.timer)
    this.inflight.delete(beatId)
    f.resolve(f.interrupted && done.status !== 'ok' ? { status: 'cancelled', message: 'interrupted' } : done)
  }

  // ------------------------------------------------------------ timeline

  private async runBeats (beats: Beat[], ctx: ExecCtx): Promise<void> {
    for (let i = 0; i < beats.length; i++) {
      await this.exec(beats[i]!, { ...ctx, path: `${ctx.path}[${i}]` })
    }
  }

  private async exec (beat: Beat, ctx: ExecCtx): Promise<void> {
    if (this.stopped) throw new ActionAbortedError()
    if (!ctx.interaction) await this.gate.wait(this.signal)
    const role = beat.as ?? ctx.role
    const inner: ExecCtx = { ...ctx, ...(role ? { role } : {}) }

    if ('wait' in beat) return sleep(this.pick(beat.wait), this.signal)
    if ('cue' in beat) return this.fire(beat.cue, true)
    if ('await' in beat) return this.awaitCue(beat.await, beat.timeoutMs ?? this.scene.options.awaitTimeoutMs)
    if ('set' in beat) {
      for (const [k, v] of Object.entries(beat.set)) this.setVar(k, v)
      return
    }
    if ('if' in beat) {
      const pass = this.test(beat.if)
      this.log.debug('if', { beat: ctx.path, key: beat.if.key, pass })
      return this.runBeats(pass ? beat.then : beat.else ?? [], { ...inner, path: `${ctx.path}.${pass ? 'then' : 'else'}` })
    }
    if ('choose' in beat) {
      // Avoid picking the same branch twice in a row at this spot (loops would feel canned).
      const last = this.lastChoice.get(ctx.path)
      const weight = (i: number) => beat.choose.length > 1 && i === last ? 0 : beat.choose[i]!.weight ?? 1
      const total = beat.choose.reduce((n, _c, i) => n + weight(i), 0)
      let roll = this.rnd() * total
      let idx = beat.choose.findIndex((_c, i) => weight(i) > 0 && (roll -= weight(i)) < 0)
      if (idx < 0) idx = beat.choose.findIndex((_c, i) => weight(i) > 0)
      this.lastChoice.set(ctx.path, idx)
      this.log.debug('choose', { beat: ctx.path, branch: idx })
      return this.runBeats(beat.choose[idx]!.beats, { ...inner, path: `${ctx.path}.choose[${idx}].beats` })
    }
    if ('repeat' in beat) {
      const r = beat.repeat
      const times = r.times === undefined ? Infinity : Math.round(this.pick(r.times))
      const until = r.forMs === undefined ? Infinity : Date.now() + this.pick(r.forMs)
      for (let n = 0; n < times && Date.now() < until; n++) {
        await this.runBeats(r.beats, { ...inner, path: `${ctx.path}.repeat.beats` })
        // An empty or instant body would spin forever.
        if (!r.beats.length) break
        await sleep(0, this.signal)
      }
      return
    }
    if ('parallel' in beat) {
      await Promise.all(beat.parallel.map((br, i) => this.runBeats(br, { ...inner, path: `${ctx.path}.parallel[${i}]` })))
      return
    }
    return this.body(beat, inner)
  }

  /** say / act / goto / look / gesture: performed by a cast member. */
  private async body (beat: Beat, ctx: ExecCtx): Promise<void> {
    const role = ctx.role
    if (!role) return
    for (let attempt = 0; attempt < 3; attempt++) {
      const user = this.cast[role]
      if (!user) { this.log.debug('role not cast, skipping beat', { beat: ctx.path, role }); return }
      const cmd = await this.command(beat, role, user, ctx)
      if (!cmd) return
      // A say beat may have waited for its chat slot while a reaction paused the scene.
      if (!ctx.interaction) await this.gate.wait(this.signal)
      this.publish(this.status, `${ctx.path} (${role})`)
      const timeout = beat.timeoutMs ?? (cmd.kind === 'say' ? 10_000 : this.scene.options.beatTimeoutMs + (cmd.kind === 'act' ? cmd.busyWaitMs : 0))
      const done = await this.dispatch(user, cmd, timeout)
      if (this.stopped) throw new ActionAbortedError()
      if (done.status === 'ok') return
      if (done.status === 'cancelled' && done.message === 'interrupted' && !ctx.interaction) {
        // Paused (player reaction) or recast mid-beat: wait and do it again.
        await this.gate.wait(this.signal)
        continue
      }
      this.log.info(`beat ${done.status}, skipping`, { beat: ctx.path, role, bot: user, ...(done.message ? { message: done.message } : {}) })
      return
    }
  }

  private templateCtx (user: string): TemplateContext {
    return { scene: this.scene.name, me: user, ...(this.player ? { player: this.player } : {}), cast: this.cast, vars: this.vars }
  }

  private async command (beat: Beat, role: string, user: string, ctx: ExecCtx): Promise<Command | undefined> {
    const tctx = this.templateCtx(user)
    const busyWaitMs = this.scene.options.busyWaitMs
    if ('say' in beat) {
      const variants = (Array.isArray(beat.say) ? beat.say : [beat.say]).map(l => renderTemplate(l, tctx))
      const line = pickVariant(variants, this.lastVariant.get(ctx.path), () => this.rnd())
      this.lastVariant.set(ctx.path, line)
      const text = await provideLine(this.host.lineProvider, {
        scene: this.scene.name,
        role,
        speaker: user,
        line,
        variants,
        ...(this.player ? { player: this.player } : {}),
        vars: this.vars,
        cast: this.cast,
        context: ctx.interaction?.trigger ?? 'beat',
        ...(ctx.interaction?.message ? { message: ctx.interaction.message } : {})
      }, 3000)
      const typing = beat.typingMs !== undefined ? this.pick(beat.typingMs) : typingDelay(text, this.scene.options.typingMsPerChar)
      const wait = pacerFor(this.host.board).reserve(user, typing, this.scene.options.lineGapMs, this.scene.options.botLineGapMs)
      await sleep(wait, this.signal)
      return { kind: 'say', text, ...(beat.whisper && this.player ? { whisperTo: this.player } : {}) }
    }
    if ('act' in beat) {
      return { kind: 'act', name: beat.act, params: renderParams(beat.params ?? {}, tctx), ...(this.player ? { player: this.player } : {}), busyWaitMs }
    }
    if ('gesture' in beat) {
      return { kind: 'act', name: 'scene_gesture', params: { gesture: beat.gesture, times: beat.times ?? 1 }, busyWaitMs }
    }
    if ('look' in beat) {
      const who = this.entityTarget(beat.look, user)
      if (who) return { kind: 'act', name: 'scene_look', params: { player: who }, busyWaitMs }
      const p = this.pointTarget(beat.look)
      if (!p) { this.log.debug('can\'t resolve target', { beat: ctx.path, target: beat.look }); return undefined }
      return { kind: 'act', name: 'scene_look', params: { x: p.x, y: p.y ?? this.anchor?.y ?? 64, z: p.z }, busyWaitMs }
    }
    if ('goto' in beat) {
      const who = this.entityTarget(beat.goto, user)
      const p = who ? this.host.world.position(who) : this.pointTarget(beat.goto)
      if (!p) { this.log.debug('can\'t resolve target', { beat: ctx.path, target: beat.goto }); return undefined }
      const range = beat.range ?? (who ? 2 : 1.5)
      return { kind: 'act', name: 'scene_walk', params: { x: p.x, ...(p.y !== undefined ? { y: p.y } : {}), z: p.z, range }, busyWaitMs }
    }
    return undefined
  }

  /** Role name or "player" -> a username to look at / walk to. */
  private entityTarget (t: string, self: string): string | undefined {
    if (t === 'player') return this.player ?? this.nearestPlayer(32)
    const u = this.cast[t]
    return u && u !== self ? u : undefined
  }

  private pointTarget (t: string): { x: number, y?: number, z: number } | undefined {
    const a = this.anchor
    if (!a) return undefined
    if (t === 'anchor') return a
    const m = this.scene.marks[t]
    if (!m) return undefined
    return m.length === 2 ? { x: a.x + m[0], z: a.z + m[1] } : { x: a.x + m[0], y: a.y + m[1], z: a.z + m[2] }
  }

  private nearestPlayer (radius: number): string | undefined {
    let best: { name: string, distance: number } | undefined
    for (const user of Object.values(this.cast)) {
      for (const p of this.host.world.playersNear(user, radius)) if (!best || p.distance < best.distance) best = p
    }
    return best?.name
  }

  private resolveAnchor (): Vec | undefined {
    const a = this.scene.anchor
    const floor = (p: Vec | undefined) => p && { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }
    if (!a) {
      const first = Object.keys(this.scene.roles).map(r => this.cast[r]).find(Boolean)
      return first ? floor(this.host.world.position(first)) : undefined
    }
    if ('pos' in a) return { x: a.pos[0], y: a.pos[1], z: a.pos[2] }
    if ('role' in a) {
      const u = this.cast[a.role]
      return u ? floor(this.host.world.position(u)) : undefined
    }
    const name = a.player === 'nearest' ? this.player ?? this.nearestPlayer(a.radius ?? 32) : a.player
    if (!name) throw new Error('no player nearby to stage the scene around')
    const pos = this.host.world.position(name)
    if (!pos) throw new Error(`can't see ${name}`)
    this.player ??= name
    return floor(pos)
  }

  /** Sends a command to a member and waits for its done (or timeout/stop). */
  private dispatch (user: string, cmd: Command, timeoutMs: number): Promise<Done> {
    const beatId = ++this.beatSeq
    return new Promise<Done>(resolve => {
      const f: Inflight = { user, resolve, interrupted: false }
      f.timer = setTimeout(() => {
        this.host.send(user, TOPIC.cancel, { runId: this.runId, beatId } satisfies CancelMsg)
        this.settle(beatId, { status: 'timeout', message: `no result after ${Math.round(timeoutMs / 1000)}s` })
      }, timeoutMs)
      this.inflight.set(beatId, f)
      this.log.trace('dispatch', { beatId, bot: user, cmd: cmd.kind === 'say' ? `say ${cmd.text}` : cmd.name })
      this.host.send(user, TOPIC.do, { runId: this.runId, beatId, cmd } satisfies DoMsg)
    })
  }

  // ------------------------------------------------------------ cues, vars, conditions

  private fire (cue: string, broadcast: boolean): void {
    if (this.cues.has(cue)) return
    this.cues.add(cue)
    this.log.debug('cue', { cue, external: !broadcast })
    for (const w of this.cueWaiters.get(cue) ?? []) w()
    this.cueWaiters.delete(cue)
    if (broadcast) this.host.broadcast(TOPIC.cue, { runId: this.runId, scene: this.scene.name, cue })
  }

  private awaitCue (cue: string, timeoutMs: number): Promise<void> {
    if (this.cues.has(cue)) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const done = () => { clearTimeout(t); this.signal.removeEventListener('abort', onAbort); resolve() }
      const t = setTimeout(() => {
        this.log.warn('await timed out, carrying on', { cue, secs: Math.round(timeoutMs / 1000) })
        const list = this.cueWaiters.get(cue)
        if (list) this.cueWaiters.set(cue, list.filter(w => w !== done))
        this.signal.removeEventListener('abort', onAbort)
        resolve()
      }, timeoutMs)
      const onAbort = () => { clearTimeout(t); reject(new ActionAbortedError()) }
      this.signal.addEventListener('abort', onAbort, { once: true })
      const list = this.cueWaiters.get(cue) ?? []
      list.push(done)
      this.cueWaiters.set(cue, list)
    })
  }

  private getVar (key: string): unknown {
    return key.startsWith('$') ? this.vars[key.slice(1)] : this.host.board.get(key)
  }

  private setVar (key: string, value: unknown): void {
    if (key.startsWith('$')) this.vars[key.slice(1)] = value
    else this.host.board.set(key, value)
  }

  private test (c: Condition): boolean {
    if (c.chance !== undefined && !(this.rnd() < c.chance)) return false
    if (c.key === undefined) return true
    const v = this.getVar(c.key)
    if (c.exists !== undefined && (v !== undefined && v !== null) !== c.exists) return false
    if ('equals' in c && JSON.stringify(v) !== JSON.stringify(c.equals)) return false
    if ('notEquals' in c && JSON.stringify(v) === JSON.stringify(c.notEquals)) return false
    if (c.gt !== undefined && !(typeof v === 'number' && v > c.gt)) return false
    if (c.lt !== undefined && !(typeof v === 'number' && v < c.lt)) return false
    return true
  }

  // ------------------------------------------------------------ pausing

  /** Pauses the timeline and interrupts in-flight beats (they are retried on resume). */
  private pause (status: RunStatus): void {
    this.log.debug('pause', { status, inflight: this.inflight.size })
    this.gate.close()
    this.publish(status)
    this.cancelAll(true)
  }

  private resume (): void {
    this.gate.release()
    if (this.gate.open && !this.stopped) this.publish('running')
  }

  // ------------------------------------------------------------ recasting

  private checkCast (): void {
    if (this.stopped) return
    const actors = this.host.actors()
    for (const [role, user] of Object.entries(this.cast)) {
      if (!actors[user]?.online && !this.recasting.has(role)) void this.recast(role, user)
    }
  }

  private async recast (role: string, lost: string): Promise<void> {
    this.recasting.add(role)
    this.log.info('cast member dropped out, pausing to recast', { role, bot: lost })
    this.pause('recasting')
    // The lost member won't answer: settle its beats now so the timeline can move on.
    for (const [id, f] of this.inflight) if (f.user === lost) this.settle(id, { status: 'cancelled', message: 'interrupted' })
    const deadline = Date.now() + this.scene.options.recastTimeoutMs
    try {
      while (!this.stopped) {
        const actors = this.host.actors()
        const back = actors[lost]?.online && (!actors[lost]!.busyIn || actors[lost]!.busyIn === this.runId)
        const others = Object.values(this.cast).filter(u => u !== lost)
        const next = back ? lost : this.host.findReplacement(this.scene, role, [...others, lost])
        if (next) {
          if (next !== lost) {
            this.host.setBusy(lost, undefined)
            this.cast[role] = next
            this.host.setBusy(next, this.runId)
            this.log.info('recast', { role, from: lost, to: next })
          } else {
            this.host.setBusy(lost, this.runId)
            this.log.info('cast member is back', { role, bot: lost })
          }
          return
        }
        if (Date.now() >= deadline) {
          if (this.scene.roles[role]?.optional) {
            delete this.cast[role]
            this.host.setBusy(lost, undefined)
            this.log.info('optional role dropped, carrying on', { role })
            return
          }
          this.stop(`nobody to play ${role}`, 'aborted')
          return
        }
        await sleep(Math.min(500, Math.max(10, deadline - Date.now())), this.signal).catch(() => {})
      }
    } finally {
      this.recasting.delete(role)
      if (!this.stopped) {
        this.publish(this.status)
        this.resume()
      }
    }
  }

  // ------------------------------------------------------------ player interactions

  /**
   * A member saw a player approach, chat or hit. Events are buffered briefly so the same
   * thing seen by several members is handled once, by the most relevant member.
   */
  onPlayer (evt: PlayerMsg): void {
    if (this.stopped || !this.scene.interactions.some(i => i.on === evt.trigger)) return
    const key = `${evt.trigger}:${evt.player}:${evt.message ?? ''}`
    const list = this.pendingEvents.get(key)
    if (list) { list.push(evt); return }
    this.pendingEvents.set(key, [evt])
    const t = setTimeout(() => {
      const events = this.pendingEvents.get(key) ?? []
      this.pendingEvents.delete(key)
      events.sort((a, b) => Number(!!b.mentioned) - Number(!!a.mentioned) || a.distance - b.distance)
      if (events[0]) void this.react(events[0])
    }, 150)
    this.cleanups.push(() => clearTimeout(t))
  }

  private matchInteraction (evt: PlayerMsg): { spec: InteractionSpec, index: number } | undefined {
    const now = Date.now()
    for (const [index, spec] of this.scene.interactions.entries()) {
      if (spec.on !== evt.trigger) continue
      if (spec.on === 'approach' && evt.distance > (spec.radius ?? 6)) continue
      if (spec.on === 'chat') {
        if (!evt.mentioned && evt.distance > (spec.radius ?? 12)) continue
        if (spec.match && !new RegExp(spec.match, 'i').test(evt.message ?? '')) continue
      }
      if (now < (this.cooldowns.get(`${index}`) ?? 0)) continue
      if (now < (this.cooldowns.get(`${index}:${evt.player}`) ?? 0)) continue
      return { spec, index }
    }
    return undefined
  }

  private async react (evt: PlayerMsg): Promise<void> {
    if (this.stopped || this.reacting || this.status === 'recasting') return
    if (this.reactions >= this.scene.options.maxReactions) return
    const m = this.matchInteraction(evt)
    if (!m) { this.log.debug('player event ignored (no match or cooldown)', { trigger: evt.trigger, player: evt.player }); return }
    const { spec, index } = m
    const now = Date.now()
    this.cooldowns.set(`${index}`, now + (spec.cooldownMs ?? 30_000))
    this.cooldowns.set(`${index}:${evt.player}`, now + (spec.perPlayerCooldownMs ?? 120_000))
    this.reactions++
    this.reacting = true
    this.player = evt.player
    this.vars.player = evt.player
    const role = Object.entries(this.cast).find(([, u]) => u === evt.member)?.[0]
    this.log.info(`reacting to ${evt.trigger}`, { player: evt.player, near: evt.member, mode: spec.mode ?? 'pause', interaction: index, ...(evt.message ? { message: evt.message } : {}) })
    const pause = (spec.mode ?? 'pause') === 'pause'
    if (pause) this.pause('reacting')
    try {
      await this.runBeats(spec.beats, {
        ...(role ? { role } : {}),
        path: `interactions[${index}].beats`,
        interaction: { trigger: evt.trigger, ...(evt.message ? { message: evt.message } : {}) }
      })
    } catch (e) {
      if (!(e instanceof ActionAbortedError)) this.log.warn('reaction failed', { error: (e as Error).message })
    } finally {
      this.reacting = false
      if (pause) this.resume()
    }
    if (spec.then === 'stop') this.stop(`ended by ${evt.trigger} from ${evt.player}`)
  }
}
