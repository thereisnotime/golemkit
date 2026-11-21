// The self-improver brain: runs a declarative program (format.ts) through the NPC brain's
// controller with no LLM involved, and rewrites that program with one LLM step when an
// owner tells it to. See docs/guide/self-improver.md.
//
//   brains: [commandBrain(), reflexes(), selfImprover({ base: myProgram, provider: 'claude-subscription' })]
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { Bot } from 'mineflayer'
import {
  defineBrain, defineAction, noParams, ok, fail, z,
  type Agent, type ActionContext, type ChatMessage, type Logger
} from '../../core/index.ts'
import { createProvider } from '../../llm/providers/index.ts'
import type { LlmProvider } from '../../llm/types.ts'
import { fmtTotals } from '../../llm/usage.ts'
import type { Price } from '../../llm/pricing.ts'
import { NpcController, INTERRUPT_ACTION, type Behavior, type NpcOptions } from '../npc/index.ts'
import { TriggerQueue, compile, liveWorld, type Outcome } from './compile.ts'
import { diffSummary, makeCatalog, mustParse, parseProgram, type ActionCatalog, type CatalogPolicy, type Program, type ProgramInput, type Trigger } from './format.ts'
import { ChatLimiter, ProgramMemory, evalCond, inWindow, type Host } from './interpreter.ts'
import { chatMatches, parseAnswer, parseInstruction, type IntakeOptions } from './intake.ts'
import { Learner, type LearnBudget } from './learner.ts'
import { ProgramStore, type ProgramRecord } from './store.ts'

export interface ExperienceOptions {
  /** Ask the owner before reworking a rule that keeps failing. Default true. */
  ask?: boolean
  /** Rework without asking. Default false: no silent autonomous rewrites. */
  autoApply?: boolean
  /** Consecutive failures of one rule/trigger before it counts as "keeps failing". Default 5. */
  failures?: number
  /** Minimum gap between proposals. Default 30 min. */
  cooldownMs?: number
}

export interface SelfImproverOptions {
  /** The bot definition's program (version 0; program_reset goes back to it). */
  base: ProgramInput
  /** Provider instance or name (as in llmBrain). null = never learn. Default MC_LLM_PROVIDER or claude-subscription. */
  provider?: LlmProvider | string | null
  providerOptions?: Record<string, unknown>
  /** Persona for the LLM step. Defaults to definition.persona. */
  persona?: string
  /** LLM budget for learning (shared Budget/usage classes from src/llm). */
  budget?: LearnBudget
  prices?: Record<string, Price>
  intake?: IntakeOptions & {
    /** Watch data/bots/<username>/inbox/*.txt for instructions (one per file). Default true. */
    inbox?: boolean
    inboxPollMs?: number
  }
  /** Which actions programs may call (default: DEFAULT_DENY). */
  actions?: CatalogPolicy
  /** NPC controller settings, plus fixed behaviours the program can't remove (e.g. fleeOrFight()). */
  npc?: Omit<NpcOptions, 'behaviors' | 'name'> & { extraBehaviors?: Behavior[] }
  /** Program chat limiter. Default 1 line per 2.5 s, 6 per minute. */
  chat?: { gapMs?: number, perMinute?: number }
  experience?: ExperienceOptions
  /** Trigger clock (interval/time triggers). Default 1000 ms. */
  triggerTickMs?: number
}

/** The agent surface the self-improver uses (lets tests use a fake). */
export type SelfAgent = Pick<Agent, 'username' | 'log' | 'storage' | 'dataDir' | 'owners' | 'isOwner' | 'say' | 'whisper' | 'listActions' | 'observe' | 'definition' | 'currentAction'> & { settings?: Record<string, unknown> }

/**
 * Owners who may change the program. Unlike agent.isOwner, an empty owners list means
 * nobody (only the console and the inbox), not everybody.
 */
export function isTeacher (agent: Pick<SelfAgent, 'owners' | 'isOwner'>, player: string): boolean {
  return agent.owners.length > 0 && agent.isOwner(player)
}

interface Stat { runs: number, failures: number, streak: number, yields: number, last?: string }

const CALLER = 'self'

export class SelfImprover {
  readonly agent: SelfAgent
  readonly log: Logger
  readonly store: ProgramStore
  readonly learner: Learner
  readonly queue = new TriggerQueue()
  readonly chat: ChatLimiter
  readonly stats = new Map<string, Stat>()
  base!: Program
  program!: Program
  version = 0
  memory = new ProgramMemory()
  controller: NpcController | null = null
  /** Pending "want me to rework it?" question. */
  proposal: { key: string, instruction: string, at: number, owner: string } | null = null
  private readonly opts: SelfImproverOptions
  private bot: Bot | null = null
  private lastProposal = 0
  private lastFired = new Map<string, number>()
  private inWindowState = new Map<string, boolean>()

  constructor (agent: SelfAgent, opts: SelfImproverOptions, learner?: Learner) {
    this.agent = agent
    this.opts = opts
    this.log = agent.log.child('self')
    this.chat = new ChatLimiter(opts.chat)
    this.store = new ProgramStore(join(agent.dataDir, 'programs'), agent.storage)
    this.learner = learner ?? new Learner({
      provider: makeProvider(opts, (agent.settings?.llm ?? {}) as Record<string, any>, this.log),
      catalog: () => this.catalog(),
      storage: agent.storage as any,
      username: agent.username,
      log: this.log.child('learn'),
      budget: { ...opts.budget, ...((agent.settings?.llm as any)?.budget ?? {}) },
      prices: opts.prices,
      persona: opts.persona ?? agent.definition.persona
    })
  }

  catalog (): ActionCatalog {
    return makeCatalog(this.agent.listActions(), this.opts.actions)
  }

  /** Loads the base program and the active version. Throws if the base program is invalid. */
  async start (): Promise<void> {
    this.base = mustParse(this.opts.base, this.catalog())
    let program = this.base
    let version = this.store.current
    if (version > 0) {
      const rec = this.store.load(version)
      const parsed = rec ? parseProgram(rec.program, this.catalog()) : null
      if (parsed?.ok) program = parsed.program
      else {
        this.log.warn(`stored program v${version} is missing or no longer valid, using the base program`, { issues: parsed && !parsed.ok ? parsed.issues.slice(0, 3) : undefined })
        version = 0
        this.store.activate(0)
      }
    }
    this.install(program, version)
    if (!this.agent.owners.length) this.log.warn('no owners configured: nobody can teach this bot from chat (set owners in the profile or --owners)')
    await this.learner.start()
    this.log.info(`running program v${version} "${program.name}": ${this.describe()}`, { version })
  }

  stop (): void {
    this.controller?.stop('stopped')
    this.learner.dispose()
  }

  /** Switches the running program (keeps values of variables that still exist). */
  install (program: Program, version: number): void {
    const old = this.memory
    this.memory = new ProgramMemory(program.vars)
    for (const [k, v] of old.vars) if (k in program.vars) this.memory.set(k, v)
    this.program = program
    this.version = version
    this.queue.clear()
    this.lastFired.clear()
    this.inWindowState.clear()
    if (this.bot) this.startController(this.bot)
  }

  // ---------------------------------------------------------------- session

  session (bot: Bot): () => void {
    this.bot = bot
    this.startController(bot)
    const spawnedAt = Date.now()
    let lastHurt = 0
    const onHurt = (e: any) => {
      if (e !== bot.entity || Date.now() - lastHurt < 10_000) return
      lastHurt = Date.now()
      this.fireEvent('hurt')
    }
    const onDeath = () => this.fireEvent('death')
    const onJoin = (p: { username: string }) => {
      if (p.username === bot.username || Date.now() - spawnedAt < 10_000) return
      this.fireEvent('playerJoined', p.username)
    }
    bot.on('entityHurt', onHurt)
    bot.on('death', onDeath)
    bot.on('playerJoined', onJoin)
    const spawnTimer = setTimeout(() => this.fireEvent('spawn'), 4000)
    const clock = setInterval(() => this.clockTick(), this.opts.triggerTickMs ?? 1000)
    const npcTick = setInterval(() => this.tickController(), this.opts.npc?.tickMs ?? 1500)
    const inboxOn = this.opts.intake?.inbox ?? true
    const inbox = inboxOn ? setInterval(() => this.pollInbox(), this.opts.intake?.inboxPollMs ?? 10_000) : null
    return () => {
      bot.off('entityHurt', onHurt)
      bot.off('death', onDeath)
      bot.off('playerJoined', onJoin)
      clearTimeout(spawnTimer)
      clearInterval(clock)
      clearInterval(npcTick)
      if (inbox) clearInterval(inbox)
      this.controller?.stop('session ended')
      this.controller = null
      this.bot = null
    }
  }

  private startController (bot: Bot): void {
    this.controller?.stop('program changed')
    const agent = this.agent as Agent
    const behaviors = compile({
      program: this.program,
      memory: this.memory,
      chat: this.chat,
      queue: this.queue,
      world: (ctx) => liveWorld(agent, bot, ctx.bb, this.memory),
      onOutcome: (kind, name, outcome, detail) => this.onOutcome(kind, name, outcome, detail)
    })
    const { extraBehaviors = [], ...npc } = this.opts.npc ?? {}
    this.controller = new NpcController(agent, bot, { ...npc, name: CALLER, behaviors: [...extraBehaviors, ...behaviors] })
  }

  private tickController (): void {
    this.controller?.tick().catch(e => this.log.warn(`tick: ${(e as Error).message}`))
  }

  // ---------------------------------------------------------------- triggers

  private host (): Host {
    return { act: async () => fail('no'), say: () => {}, whisper: () => {}, wait: async () => {}, now: Date.now, random: Math.random }
  }

  private conditionHolds (t: Trigger): boolean {
    if (!t.when) return true
    const bot = this.bot
    const c = this.controller
    if (!bot || !c) return false
    c.bb.update(bot)
    return evalCond(t.when, { world: liveWorld(this.agent as Agent, bot, c.bb, this.memory), memory: this.memory, host: this.host() })
  }

  /** Queues a trigger's routine if its cooldown and condition allow. */
  fire (t: Trigger, player?: string): boolean {
    const now = Date.now()
    const key = player && (t.on === 'chat' || t.on === 'playerJoined') ? `${t.name}|${player}` : t.name
    const cd = t.cooldownMs ?? (t.on === 'chat' ? 30_000 : 0)
    if (now - (this.lastFired.get(key) ?? -Infinity) < cd) return false
    if (!this.conditionHolds(t)) return false
    this.lastFired.set(key, now)
    this.queue.push({ trigger: t, player, at: now })
    this.log.debug(`trigger ${t.name} fired`, { trigger: t.name, player })
    this.tickController()
    return true
  }

  private fireEvent (on: Trigger['on'], player?: string): void {
    for (const t of this.program.triggers) if (t.on === on) this.fire(t, player)
  }

  private clockTick (): void {
    const now = Date.now()
    const time = this.bot?.time?.timeOfDay
    for (const t of this.program.triggers) {
      if (t.on === 'interval' && t.everyMs) {
        if (!this.lastFired.has(t.name)) this.lastFired.set(t.name, now)
        else if (now - this.lastFired.get(t.name)! >= t.everyMs) this.fire(t)
      } else if (t.on === 'time' && t.at !== undefined && typeof time === 'number') {
        const inside = inWindow(time, t.at)
        const was = this.inWindowState.get(t.name)
        this.inWindowState.set(t.name, inside)
        if (inside && was === false) this.fire(t)
      }
    }
  }

  // ---------------------------------------------------------------- chat

  onChat (msg: ChatMessage): void {
    if (msg.from === this.agent.username) return
    const owner = isTeacher(this.agent, msg.from)
    if (owner && this.proposal) {
      const a = parseAnswer(msg.message, this.agent.username)
      if (a) return void this.answerProposal(a, msg)
    }
    const instruction = parseInstruction(msg, this.agent.username, this.opts.intake)
    if (instruction !== null) {
      if (!owner) {
        this.log.debug(`ignored instruction from non-owner ${msg.from}`)
        return
      }
      void this.teach(instruction, msg.from, text => msg.whisper ? this.agent.whisper(msg.from, text) : this.agent.say(text))
      return
    }
    if (msg.message.trim().startsWith(process.env.MC_PREFIX ?? '!')) return
    for (const t of this.program.triggers) {
      if (t.on !== 'chat' || !t.match || !chatMatches(msg.message, t.match)) continue
      if (t.ownersOnly && !owner) continue
      if (t.near !== undefined) {
        const e = this.bot?.players?.[msg.from]?.entity
        const me = this.bot?.entity
        const d = e && me ? e.position.distanceTo(me.position) : undefined
        if (d === undefined || d > t.near) {
          this.log.debug(`chat trigger ${t.name}: ${msg.from} is ${d === undefined ? 'not visible' : `${Math.round(d)} blocks away`} (near ${t.near})`)
          continue
        }
      }
      this.fire(t, msg.from)
    }
  }

  // ---------------------------------------------------------------- learning

  /** Runs the LLM step for an owner instruction and switches program if it passes the gate. */
  async teach (instruction: string, from: string, reply: (text: string) => void): Promise<ProgramRecord | null> {
    const blocked = this.learner.blocked()
    if (blocked) {
      reply(`I can't learn right now (${blocked}). I'll keep doing what I do.`)
      this.log.info(`instruction not learned: ${blocked}`, { from })
      return null
    }
    this.log.info(`learning from ${from}: ${instruction}`, { from })
    reply('ok, let me think about that...')
    const r = await this.learner.learn({
      current: this.program,
      instruction,
      from,
      observation: safeObserve(this.agent),
      notes: this.notes()
    })
    if (!r.ok) {
      this.log.warn(`learning failed: ${r.reason}`, { issues: r.issues.slice(0, 5), calls: r.usage.calls, in: r.usage.inputTokens, out: r.usage.outputTokens })
      reply(`I couldn't make that work (${r.reason.slice(0, 120)}). Still running v${this.version}.`)
      return null
    }
    const diff = diffSummary(this.program, r.program)
    const rec = this.store.save({ instruction, by: from, diff, parent: this.version, usage: r.usage, program: r.program })
    this.install(r.program, rec.version)
    for (const s of this.stats.values()) s.streak = 0
    this.log.info(`program v${rec.version} accepted: ${diff}`, { version: rec.version, calls: r.usage.calls, in: r.usage.inputTokens, out: r.usage.outputTokens, dryRuns: r.report.runs })
    reply(`learned it, now on v${rec.version} (${diff.slice(0, 150)})`)
    return rec
  }

  rollback (version?: number): { ok: boolean, message: string } {
    const versions = this.store.versions()
    const target = version ?? [0, ...versions].filter(v => v < this.version).at(-1) ?? 0
    if (target === 0) return this.reset()
    const rec = this.store.load(target)
    if (!rec) return { ok: false, message: `no version ${target} (have: ${versions.join(', ') || 'none'})` }
    const parsed = parseProgram(rec.program, this.catalog())
    if (!parsed.ok) return { ok: false, message: `v${target} no longer validates: ${parsed.issues[0]}` }
    this.store.activate(target)
    this.install(parsed.program, target)
    this.log.info(`rolled back to v${target}`, { version: target })
    return { ok: true, message: `back on v${target}: ${rec.instruction.slice(0, 80)}` }
  }

  reset (): { ok: boolean, message: string } {
    this.store.activate(0)
    this.install(this.base, 0)
    this.log.info('reset to the base program')
    return { ok: true, message: `back on the base program "${this.base.name}"` }
  }

  // ---------------------------------------------------------------- experience

  onOutcome (kind: 'rule' | 'trigger', name: string, outcome: Outcome, detail: string): void {
    const key = `${kind} ${name}`
    const s = this.stats.get(key) ?? { runs: 0, failures: 0, streak: 0, yields: 0 }
    this.stats.set(key, s)
    s.runs++
    s.last = `${outcome}: ${detail}`.slice(0, 160)
    if (outcome === 'ok') s.streak = 0
    else if (outcome === 'yield') s.yields++
    else if (outcome === 'fail') {
      s.failures++
      s.streak++
      this.maybePropose(key, s)
    }
  }

  private maybePropose (key: string, s: Stat): void {
    const e = this.opts.experience ?? {}
    const threshold = e.failures ?? 5
    if (s.streak < threshold || this.proposal || this.learner.blocked()) return
    if (Date.now() - this.lastProposal < (e.cooldownMs ?? 30 * 60_000)) return
    const instruction = `My ${key} failed ${s.streak} times in a row (last: ${s.last}). Rework it so it works or fails less, keeping its purpose.`
    this.lastProposal = Date.now()
    if (e.autoApply) {
      void this.teach(instruction, 'experience', t => this.log.info(t))
      return
    }
    if (!(e.ask ?? true)) return
    const owner = this.onlineOwner()
    if (!owner) return
    this.proposal = { key, instruction, at: Date.now(), owner }
    this.agent.whisper(owner, `my ${key} failed ${s.streak} times (${(s.last ?? '').slice(0, 80)}). want me to rework it? yes/no`)
  }

  private onlineOwner (): string | null {
    const players = Object.keys(this.bot?.players ?? {})
    return players.find(p => p !== this.agent.username && isTeacher(this.agent, p)) ?? null
  }

  private answerProposal (a: 'yes' | 'no', msg: ChatMessage): void {
    const p = this.proposal!
    this.proposal = null
    if (Date.now() - p.at > 10 * 60_000) return
    const reply = (t: string) => this.agent.whisper(msg.from, t)
    if (a === 'no') {
      const s = this.stats.get(p.key)
      if (s) s.streak = 0
      reply('ok, leaving it as it is')
      return
    }
    void this.teach(p.instruction, `${msg.from} (accepted proposal)`, reply)
  }

  /** Recent experience for the LLM: failing and often-interrupted rules. */
  notes (): string[] {
    return [...this.stats].filter(([, s]) => s.failures || s.yields)
      .map(([k, s]) => `${k}: ${s.runs} runs, ${s.failures} failures (${s.streak} in a row), ${s.yields} times interrupted; last ${s.last}`)
      .slice(0, 10)
  }

  // ---------------------------------------------------------------- inbox

  private pollInbox (): void {
    const dir = join(this.agent.dataDir, 'inbox')
    if (!existsSync(dir) || this.learner.busy) return
    const file = readdirSync(dir).filter(f => f.endsWith('.txt')).sort()[0]
    if (!file) return
    const path = join(dir, file)
    let text = ''
    try { text = readFileSync(path, 'utf8').trim() } catch { return }
    mkdirSync(join(dir, 'done'), { recursive: true })
    renameSync(path, join(dir, 'done', file))
    if (!text) return
    const owner = this.onlineOwner()
    void this.teach(text.slice(0, 600), `inbox:${file}`, t => owner ? this.agent.whisper(owner, t) : this.log.info(`inbox: ${t}`))
  }

  // ---------------------------------------------------------------- reporting

  describe (): string {
    const p = this.program
    const rules = p.rules.map(r => `${r.name}(${r.score})`).join(' ')
    const triggers = p.triggers.map(t => `${t.name}(${t.on}${t.match ? `:${t.match.join('/')}` : ''})`).join(' ')
    return `rules: ${rules || 'none'}; triggers: ${triggers || 'none'}`
  }

  status (): string {
    const u = this.learner.usage.today
    const learn = this.learner.blocked()
    const npc = this.controller?.summary() ?? 'not connected'
    return `program v${this.version} "${this.program.name}" | ${npc} | learning: ${learn ? `off (${learn})` : 'ready'} | LLM today ${fmtTotals(u, this.learner.provider?.billing ?? 'local')}`
  }
}

/**
 * The LLM provider: a profile's `llm:` block (agent.settings.llm: provider, model, effort,
 * login, oauthTokenVar, oauthTokenFile) wins over the variant's options, like in llmBrain.
 */
function makeProvider (opts: SelfImproverOptions, fromProfile: Record<string, any>, log: Logger): LlmProvider | null {
  const p = fromProfile.provider ?? (opts.provider === undefined ? (process.env.MC_LLM_PROVIDER ?? 'claude-subscription') : opts.provider)
  if (p === null || p === 'none') return null
  if (typeof p !== 'string') return p
  const keys = ['model', 'effort', 'login', 'profile', 'oauthTokenVar', 'oauthTokenFile', 'mode', 'transport', 'baseUrl', 'reasoningEffort']
  const overrides = Object.fromEntries(keys.filter(k => fromProfile[k] !== undefined).map(k => [k, fromProfile[k]]))
  try {
    return createProvider(p, { ...opts.providerOptions, ...overrides })
  } catch (e) {
    log.warn(`no LLM provider: ${(e as Error).message}`)
    return null
  }
}

function safeObserve (agent: SelfAgent): Record<string, unknown> | undefined {
  try { return agent.observe() } catch { return undefined }
}

/** Owners (players) and the console may change the program; other brains (an LLM brain reading chat) may not. */
function mayChange (agent: SelfAgent, ctx: ActionContext): string | null {
  if (ctx.caller.kind === 'system') return null
  if (ctx.caller.kind === 'player') return isTeacher(agent, ctx.caller.name) ? null : 'only my owners can change my program'
  return `${ctx.caller.kind} callers can't change the program`
}

// ------------------------------------------------------------------ brain

export const selfImprover = (opts: SelfImproverOptions) => {
  const states = new Map<Agent, SelfImprover>()
  const get = (agent: Agent) => states.get(agent)

  const actions = [
    defineAction({
      name: 'program_status',
      description: 'Show which program version the self-improver runs, what it is doing, and whether it can learn right now.',
      params: noParams,
      exclusive: false,
      run: ({ agent }) => { const s = get(agent); return s ? ok(s.status(), { version: s.version, stats: Object.fromEntries(s.stats) }) : fail('not running') }
    }),
    defineAction({
      name: 'program_show',
      description: 'Summarise the current program (rules and triggers); the full JSON is in the result data and data/bots/<username>/programs/.',
      params: noParams,
      exclusive: false,
      run: ({ agent }) => { const s = get(agent); return s ? ok(`v${s.version} "${s.program.name}": ${s.describe()}`, s.program) : fail('not running') }
    }),
    defineAction({
      name: 'program_history',
      description: 'List the last program versions with the instruction that produced each one.',
      params: z.object({ limit: z.number().int().min(1).max(10).default(5) }),
      exclusive: false,
      run: ({ agent }, { limit }) => {
        const s = get(agent)
        if (!s) return fail('not running')
        const h = s.store.history(limit)
        if (!h.length) return ok('only the base program (v0) so far')
        return ok(h.map(r => `v${r.version}${r.version === s.version ? '*' : ''} by ${r.by}: ${r.instruction.slice(0, 60)} [${r.diff.slice(0, 60)}]`).join(' | '), h.map(({ program: _p, ...r }) => r))
      }
    }),
    defineAction({
      name: 'program_rollback',
      description: 'Go back to an earlier program version (default: the one before the current). 0 is the base program.',
      params: z.object({ version: z.number().int().min(0).optional() }),
      exclusive: false,
      run: (ctx, { version }) => {
        const s = get(ctx.agent)
        if (!s) return fail('not running')
        const denied = mayChange(s.agent, ctx)
        if (denied) return fail(denied)
        const r = s.rollback(version)
        return r.ok ? ok(r.message) : fail(r.message)
      }
    }),
    defineAction({
      name: 'program_reset',
      description: 'Go back to the bot definition\'s base program (version 0). Learned versions stay on disk for rollback.',
      params: noParams,
      exclusive: false,
      run: (ctx) => {
        const s = get(ctx.agent)
        if (!s) return fail('not running')
        const denied = mayChange(s.agent, ctx)
        if (denied) return fail(denied)
        return ok(s.reset().message)
      }
    }),
    defineAction({
      name: 'program_teach',
      description: 'Teach the bot something new or change how it behaves (owners only). Uses the LLM once to rewrite its program.',
      params: z.object({ instruction: z.string().min(3).max(600) }),
      aliases: ['teach'],
      exclusive: false,
      run: async (ctx, { instruction }) => {
        const s = get(ctx.agent)
        if (!s) return fail('not running')
        const denied = mayChange(s.agent, ctx)
        if (denied) return fail(denied)
        const from = ctx.caller.kind === 'player' ? ctx.caller.name : 'console'
        let last = ''
        // The interim "thinking" line goes out as a whisper; the outcome is the action result.
        const rec = await s.teach(instruction, from, t => { last = t; if (from !== 'console' && t.startsWith('ok,')) ctx.agent.whisper(from, t) })
        return rec ? ok(`learned it, now on v${rec.version} (${rec.diff.slice(0, 150)})`) : fail(last || 'not learned')
      }
    }),
    defineAction({
      name: 'program_explain',
      description: 'Explain in plain words what the current program does (asks the LLM; falls back to a summary without it).',
      params: z.object({ question: z.string().max(200).optional() }),
      exclusive: false,
      run: async ({ agent }, { question }) => {
        const s = get(agent)
        if (!s) return fail('not running')
        if (s.learner.blocked()) return ok(`v${s.version}: ${s.describe()}`)
        const r = await s.learner.explain(s.program, question)
        return r.ok ? ok(r.text) : ok(`v${s.version}: ${s.describe()}`)
      }
    })
  ]

  const interrupt = defineAction({
    name: INTERRUPT_ACTION,
    description: 'Ends the NPC brain\'s current action (used when it switches behaviour).',
    params: noParams,
    internal: true,
    run: () => ok('')
  })

  return defineBrain({
    name: 'self',
    async start (agent) {
      for (const a of [...actions, interrupt]) if (!agent.getAction(a.name)) agent.registerAction(a)
      const s = new SelfImprover(agent, opts)
      states.set(agent, s)
      await s.start()
      agent.on('chat', msg => s.onChat(msg))
    },
    session (agent, bot) {
      return get(agent)?.session(bot)
    },
    observe (agent) {
      const s = get(agent)
      return s ? { program: { version: s.version, name: s.program.name, learning: s.learner.busy } } : {}
    },
    stop (agent) {
      get(agent)?.stop()
      states.delete(agent)
    }
  })
}
