// The bot's tool set for language models: every catalog action plus observe / chat /
// memory tools. One instance per bot. API providers call it in-process; CLI agents reach it
// through the MCP bridge (mcp.ts). Guardrails live here so they hold for every provider:
// actions run at LLM priority, long-running actions start in the background, chat is capped
// per turn, and tool calls are capped per turn.
import { z } from 'zod'
import { PRIORITY, type Agent, type ActionResult, type Caller, type Logger } from '../core/index.ts'
import type { Memory } from './memory.ts'
import { fmtEvent } from './memory.ts'
import type { ToolCallRecord, ToolHost, ToolSpec } from './types.ts'

/** The parts of Agent the tools need (lets tests use a fake). */
export type ToolAgent = Pick<Agent, 'username' | 'actionCatalog' | 'act' | 'observe' | 'say' | 'whisper' | 'currentAction' | 'log'>

export const LLM_CALLER: Caller = { kind: 'brain', name: 'llm' }

export interface TurnScope {
  /** Player the turn is for (whoever talked to the bot), passed to actions as ctx.player. */
  player?: string
  /** Who actually talked this turn (chat turns only; goal/event turns have none). */
  speaker?: string
  /** Where `reply` goes. */
  replyTo?: { from: string, whisper: boolean }
  maxToolCalls: number
  maxChatMessages: number
  calls: ToolCallRecord[]
  chatCount: number
}

export interface BotToolsOptions {
  /** How long to wait for a short action before reporting it as still running. Default 30s. */
  actionTimeoutMs?: number
  /** How long to watch a long-running action for an immediate failure before reporting "started". Default 1.5s. */
  startGraceMs?: number
  /** Max characters per chat tool call. Default 400. */
  maxChatChars?: number
  /** Actions hidden from the model (in addition to `internal` ones). */
  exclude?: string[]
  /** Priority for LLM actions. Default PRIORITY.llm. */
  priority?: number
  /** Where tool calls are logged (debug). Default `<username>/llm/tools`. */
  log?: Logger
  /** Accept calls outside a turn (an external MCP client driving the bot). Default false. */
  allowOutsideTurn?: boolean
  /** Extra built-in tools (e.g. list_skills / read_skill from a context pack). */
  extra?: ExtraTool[]
}

/** A tool added from outside (context pack skills): JSON-schema'd via zod, plain-text result. */
export interface ExtraTool {
  name: string
  description: string
  schema: z.ZodObject
  run (args: any): Promise<{ ok: boolean, text: string }> | { ok: boolean, text: string }
}

interface Builtin {
  spec: ToolSpec
  schema: z.ZodObject
  run (args: any, scope: TurnScope): Promise<{ ok: boolean, text: string }> | { ok: boolean, text: string }
}

const MAX_RESULT_CHARS = 4000

export class BotTools implements ToolHost {
  readonly agent: ToolAgent
  readonly memory: Memory
  private readonly opts: Required<Omit<BotToolsOptions, 'exclude' | 'log' | 'allowOutsideTurn' | 'extra'>> & { exclude: string[] }
  private readonly external: TurnScope | null
  private readonly log: Logger
  private readonly builtins = new Map<string, Builtin>()
  private scope: TurnScope | null = null

  constructor (agent: ToolAgent, memory: Memory, opts: BotToolsOptions = {}) {
    this.agent = agent
    this.memory = memory
    this.log = opts.log ?? agent.log.child('llm').child('tools')
    this.opts = {
      actionTimeoutMs: opts.actionTimeoutMs ?? 30_000,
      startGraceMs: opts.startGraceMs ?? 1500,
      maxChatChars: opts.maxChatChars ?? 400,
      exclude: opts.exclude ?? ['llm_usage', 'goal', 'goal_cancel'],
      priority: opts.priority ?? PRIORITY.llm
    }
    this.external = opts.allowOutsideTurn ? { maxToolCalls: Infinity, maxChatMessages: Infinity, calls: [], chatCount: 0 } : null
    this.defineBuiltins()
    for (const t of opts.extra ?? []) this.addTool(t)
  }

  /** Adds (or replaces) a built-in tool. Counts toward the per-turn tool limit like any other. */
  addTool (t: ExtraTool): void {
    this.builtins.set(t.name, { spec: { name: t.name, description: t.description, inputSchema: cleanSchema(z.toJSONSchema(t.schema, { io: 'input' }) as Record<string, unknown>) }, schema: t.schema, run: args => t.run(args) })
  }

  // ------------------------------------------------------------ turn scope

  /** Starts a turn. Tool calls outside a turn are rejected (stray calls from a CLI that outlived its turn). */
  begin (scope: Omit<TurnScope, 'calls' | 'chatCount'>): TurnScope {
    this.scope = { ...scope, calls: [], chatCount: 0 }
    return this.scope
  }

  end (): TurnScope | null {
    const s = this.scope
    this.scope = null
    return s
  }

  get active (): TurnScope | null {
    return this.scope
  }

  // ------------------------------------------------------------ ToolHost

  list (): ToolSpec[] {
    const builtinSpecs = [...this.builtins.values()].map(b => b.spec)
    const actions = this.agent.actionCatalog()
      .filter(a => !this.builtins.has(a.name) && !this.opts.exclude.includes(a.name))
      .map(a => ({
        name: a.name,
        description: a.longRunning
          ? `${a.description} (Long-running: starts in the background and keeps going until stopped or replaced.)`
          : a.description,
        inputSchema: cleanSchema(a.inputSchema)
      }))
    return [...builtinSpecs, ...actions]
  }

  async call (name: string, args: unknown): Promise<{ ok: boolean, text: string }> {
    const scope = this.scope ?? this.external
    if (!scope) return { ok: false, text: 'no active turn; tool calls are only accepted while the bot is thinking' }
    if (scope === this.external && scope.calls.length > 100) scope.calls.splice(0, 50)
    const started = Date.now()
    let out: { ok: boolean, text: string }
    if (scope.calls.length >= scope.maxToolCalls) {
      out = { ok: false, text: `tool call limit reached (${scope.maxToolCalls} per turn). Stop calling tools and finish your answer.` }
    } else {
      try {
        out = await this.dispatch(name, args ?? {}, scope)
      } catch (e) {
        out = { ok: false, text: `error: ${(e as Error).message}` }
      }
    }
    if (out.text.length > MAX_RESULT_CHARS) out = { ok: out.ok, text: out.text.slice(0, MAX_RESULT_CHARS) + ' ...(truncated)' }
    scope.calls.push({ name, args, ok: out.ok, result: out.text, ms: Date.now() - started })
    this.log.debug(`${name} -> ${out.ok ? 'ok' : 'fail'}`, { tool: name, args, ok: out.ok, ms: Date.now() - started, result: out.text.slice(0, 160) })
    return out
  }

  private async dispatch (name: string, args: unknown, scope: TurnScope): Promise<{ ok: boolean, text: string }> {
    const builtin = this.builtins.get(name)
    if (builtin) {
      const parsed = builtin.schema.safeParse(args)
      if (!parsed.success) return { ok: false, text: `bad parameters for ${name}: ${z.prettifyError(parsed.error).replace(/\n/g, '; ')}` }
      return builtin.run(parsed.data, scope)
    }
    const entry = this.agent.actionCatalog().find(a => a.name === name)
    if (!entry || this.opts.exclude.includes(name)) return { ok: false, text: `unknown tool "${name}"` }
    return this.runAction(entry.name, args, entry.longRunning, scope)
  }

  /**
   * Turns for an owner (they're talking, or it's their goal) outrank the bot's own behaviours. A goal
   * doesn't while the bot is in danger (low health or food, night, hostiles close): then eating,
   * going home and safety behaviours keep the upper hand. A live request from the owner always does.
   */
  private priorityFor (scope: TurnScope): number {
    const isOwner = (p?: string) => !!p && !!(this.agent as { isOwner?: (p: string) => boolean }).isOwner?.(p)
    if (isOwner(scope.speaker)) return Math.max(this.opts.priority, PRIORITY.behavior + 5)
    if (isOwner(scope.player)) {
      if (inSessionAndSafe(this.agent)) return Math.max(this.opts.priority, PRIORITY.behavior + 5)
    }
    return this.opts.priority
  }

  /** Actions the model may not call for a while (repeated identical failures during a goal). */
  readonly blocked = new Map<string, { until: number, why: string }>()

  private async runAction (name: string, args: unknown, longRunning: boolean, scope: TurnScope): Promise<{ ok: boolean, text: string }> {
    const b = this.blocked.get(name)
    if (b && Date.now() < b.until) {
      return { ok: false, text: `${name} is on hold for ${Math.ceil((b.until - Date.now()) / 60_000)} more min: it failed the same way several times (${b.why}). Do a different step or use another approach.` }
    }
    const cur = this.agent.currentAction
    // `stop` is non-exclusive, so the lock wouldn't stop the model from cancelling a player's command.
    if (name === 'stop' && cur && cur.priority > this.priorityFor(scope)) {
      return { ok: false, text: `busy: ${cur.name} was started by ${cur.caller.kind} ${cur.caller.name} and outranks you; you can't stop it` }
    }
    // Doing what an owner just asked outranks the bot's own behaviours (hunt, scouting...), but not
    // reflexes or a direct player command.
    const priority = this.priorityFor(scope)
    const pending = this.agent.act(name, args, { caller: LLM_CALLER, priority, player: scope.player })
    const waitMs = longRunning ? this.opts.startGraceMs : this.opts.actionTimeoutMs
    const settled = await raceTimeout(pending, waitMs)
    if (settled) return fmtResult(settled)
    pending.then(r => this.memory.push({ kind: 'action', text: `${name} ended: ${r.ok ? 'ok' : 'failed'} ${r.message}` }), () => {})
    if (longRunning) return { ok: true, text: `started ${name}; it runs in the background until stopped, replaced or preempted` }
    return { ok: true, text: `${name} is still running after ${Math.round(waitMs / 1000)}s; it continues in the background` }
  }

  // ------------------------------------------------------------ builtins

  /** Adds a built-in tool (not an action): goals.ts uses this for set_goal and friends. */
  define (name: string, description: string, schema: z.ZodObject, run: Builtin['run']): void {
    this.builtins.set(name, { spec: { name, description, inputSchema: cleanSchema(z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>) }, schema, run })
  }

  private defineBuiltins (): void {
    const add = this.define.bind(this)
    const text = z.string().min(1).describe('what to say; keep it short, it is Minecraft chat')

    add('observe', 'Look around: position, health, food, time, inventory, nearby players and mobs, current action.', z.object({}), () => {
      return { ok: true, text: JSON.stringify(this.agent.observe()) }
    })
    add('reply', 'Answer whoever triggered this turn, the way they talked to you (whisper or public chat).', z.object({ text }), ({ text }, scope) => {
      return this.chat(scope, scope.replyTo?.whisper ? scope.replyTo.from : undefined, text)
    })
    add('say', 'Say something in public chat.', z.object({ text }), ({ text }, scope) => this.chat(scope, undefined, text))
    add('whisper', 'Whisper a private message to one player.', z.object({ player: z.string().min(1), text }), ({ player, text }, scope) => this.chat(scope, player, text))
    add('recent_chat', 'Recent chat lines and events (oldest first).', z.object({ limit: z.number().int().min(1).max(40).default(15) }), ({ limit }) => {
      const lines = this.memory.recent(limit).map(fmtEvent)
      return { ok: true, text: lines.length ? lines.join('\n') : '(nothing yet)' }
    })
    add('remember', 'Save a long-term note (facts about players, places, promises). Survives restarts.', z.object({
      text: z.string().min(1).max(300),
      about: z.string().optional().describe('player or topic the note is about')
    }), ({ text, about }) => {
      const note = this.memory.remember(text, about)
      return { ok: true, text: note.status === 'duplicate' ? 'already noted' : note.status === 'updated' ? 'noted (updated an existing note)' : 'noted' }
    })
    add('recall', 'Search long-term notes. Without a query returns the latest ones.', z.object({ query: z.string().optional() }), ({ query }) => {
      const notes = this.memory.recall(query)
      return { ok: true, text: notes.length ? notes.map(n => `- ${n.about ? `[${n.about}] ` : ''}${n.text}`).join('\n') : '(no matching notes)' }
    })
  }

  private chat (scope: TurnScope, to: string | undefined, msg: string): { ok: boolean, text: string } {
    if (scope.chatCount >= scope.maxChatMessages) return { ok: false, text: `chat limit reached (${scope.maxChatMessages} messages per turn)` }
    scope.chatCount++
    const clean = msg.replace(/\s+/g, ' ').trim().slice(0, this.opts.maxChatChars)
    if (to) this.agent.whisper(to, clean)
    else this.agent.say(clean)
    this.memory.push({ kind: 'self', text: to ? `(to ${to}) ${clean}` : clean })
    return { ok: true, text: 'sent' }
  }
}

function fmtResult (r: ActionResult): { ok: boolean, text: string } {
  let text = `${r.ok ? 'ok' : 'failed'}: ${r.message || (r.ok ? 'done' : 'error')}`
  if (r.data !== undefined) text += `\n${JSON.stringify(r.data)}`
  return { ok: r.ok, text }
}

function raceTimeout<T> (p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(null), ms)
    p.then(v => { clearTimeout(t); resolve(v) }, e => { clearTimeout(t); reject(e) })
  })
}

/** Drops the $schema key zod adds; some providers reject unknown top-level keys. */
export function cleanSchema (schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _drop, ...rest } = schema
  if (rest.type !== 'object') return { type: 'object', properties: {}, ...rest }
  if (!rest.properties) rest.properties = {}
  return rest
}

/** The parts of an agent the danger checks read (a fake ToolAgent has neither: never safe, never in danger). */
type SessionView = { inSession?: boolean, adapter?: { inDanger? (): boolean } }

/** In a session and not in danger (low health or food, night, hostiles close: the adapter's judgement). */
export function inSessionAndSafe (agent: object): boolean {
  const a = agent as SessionView
  return !!a.inSession && !a.adapter?.inDanger?.()
}

/** In a session and in danger. */
export function inSessionAndDanger (agent: object): boolean {
  const a = agent as SessionView
  return !!a.inSession && !!a.adapter?.inDanger?.()
}
