// The one LLM step: given the current program, the format spec, a recent observation and
// the owner's instruction, the model submits a new program (or a patch) through a single
// tool, `submit_program`. Every submission goes through the gate right away and the tool
// result carries the errors, so the model can fix them in the same call; if a call ends
// without an accepted program, the errors go into the next call (up to repairAttempts).
// Providers, usage counters and budgets are the shared ones from src/llm.
import type { Logger, Storage } from '../../core/index.ts'
import { Budget, type BudgetOptions } from '../../llm/budget.ts'
import { PriceTable, type Price } from '../../llm/pricing.ts'
import { UsageTracker, fmtTurn, turnUsage, type TurnUsage } from '../../llm/usage.ts'
import type { LlmProvider, ToolHost, ToolSpec } from '../../llm/types.ts'
import { PatchSchema, applyPatch, formatSpec, type ActionCatalog, type Program } from './format.ts'
import { gate, type DryRunReport } from './gate.ts'
import type { ProgramUsage } from './store.ts'

export interface LearnBudget extends BudgetOptions {
  /** LLM calls per instruction, first try included. Default 3 (= 2 repair attempts). */
  callsPerInstruction?: number
}

export interface LearnerOptions {
  provider: LlmProvider | null
  catalog: () => ActionCatalog
  storage: Storage
  username: string
  log: Logger
  budget?: LearnBudget
  /** Model round trips inside one call (each submit_program is one). Default 4. */
  maxTurns?: number
  timeoutMs?: number
  prices?: Record<string, Price>
  /** Extra system prompt text from the bot definition (persona, house rules). */
  persona?: string
}

export type LearnResult =
  | { ok: true, program: Program, report: DryRunReport, usage: ProgramUsage, attempts: number }
  | { ok: false, reason: string, issues: string[], usage: ProgramUsage, attempts: number }

export interface LearnInput {
  current: Program
  instruction: string
  from: string
  observation?: Record<string, unknown>
  /** Recent experience: failures, back-offs, chat lines. */
  notes?: string[]
}

const TOOL: ToolSpec = {
  name: 'submit_program',
  description: 'Submit the bot\'s new operating program. Pass either "program" (the complete new program) or "patch" (changes to the current one). It is validated and dry-run immediately; the result says "accepted" or lists the errors to fix.',
  inputSchema: {
    type: 'object',
    properties: {
      program: { type: 'object', description: 'complete program in the format described in the system prompt', additionalProperties: true },
      patch: {
        type: 'object',
        additionalProperties: false,
        description: 'changes: {"set": {"rules": [...upsert by name], "triggers": [...upsert by name], "routines": {name: steps}, "vars": {...}}, "remove": {"rules": [names], "triggers": [names], "routines": [names], "vars": [names]}}',
        properties: { set: { type: 'object', additionalProperties: true }, remove: { type: 'object', additionalProperties: true } }
      }
    }
  }
}

export class Learner {
  readonly provider: LlmProvider | null
  readonly budget: Budget
  readonly usage: UsageTracker
  unavailable: string | null = null
  private readonly opts: LearnerOptions
  private readonly prices: PriceTable
  private readonly log: Logger
  private running = false

  constructor (opts: LearnerOptions) {
    this.opts = opts
    this.provider = opts.provider
    this.log = opts.log
    this.usage = new UsageTracker(opts.username, opts.storage)
    this.prices = new PriceTable(opts.prices)
    this.budget = new Budget({ turnsPerHour: 10, tokensPerHour: 300_000, ...opts.budget }, { today: () => this.usage.today })
    if (!opts.provider) this.unavailable = 'no LLM provider configured'
  }

  async start (): Promise<void> {
    if (!this.provider) return
    this.unavailable = await this.provider.check().catch(e => (e as Error).message)
    if (this.unavailable) this.log.warn(`learning unavailable: ${this.unavailable}`, { provider: this.provider.name })
    else this.log.info(`learning ready: ${this.provider.name}`, { provider: this.provider.name, model: this.provider.model })
  }

  dispose (): void {
    this.usage.dispose()
  }

  /** Null when a learn call could start now, otherwise why not. */
  blocked (): string | null {
    if (this.unavailable) return this.unavailable
    if (this.running) return 'already learning something'
    return this.budget.blocked()
  }

  get busy (): boolean { return this.running }

  systemPrompt (): string {
    return [
      'You rewrite the operating program of a Minecraft NPC bot. The program is declarative JSON that a small interpreter runs without you; you are only consulted when the owner asks for a change.',
      'Submit the result with the submit_program tool: a "patch" for small changes, a full "program" for big ones. If it comes back with errors, fix them and submit again. Do not answer in prose; when submit_program says "accepted", reply with one short sentence (under 120 characters) describing the change for the owner.',
      'Keep everything the owner did not ask to change. Be conservative: no chat spam (space greetings with cooldownMs), no fighting, no breaking blocks. Only the actions listed below exist.',
      this.opts.persona ? `Bot persona: ${this.opts.persona}` : '',
      '',
      formatSpec(this.opts.catalog())
    ].filter(s => s !== undefined).join('\n')
  }

  private userMessage (input: LearnInput, issues: string[]): string {
    const parts = [
      `CURRENT PROGRAM:\n${JSON.stringify(input.current)}`,
      input.observation ? `BOT RIGHT NOW: ${JSON.stringify(input.observation).slice(0, 2500)}` : '',
      input.notes?.length ? `RECENT EXPERIENCE:\n${input.notes.map(n => `- ${n}`).join('\n')}` : '',
      `INSTRUCTION FROM OWNER ${input.from}: ${input.instruction}`,
      issues.length ? `YOUR PREVIOUS SUBMISSION WAS REJECTED. Fix these and submit again:\n${issues.slice(0, 20).map(i => `- ${i}`).join('\n')}` : ''
    ]
    return parts.filter(Boolean).join('\n\n')
  }

  /** Runs the LLM step with repairs. Never throws. */
  async learn (input: LearnInput, signal?: AbortSignal): Promise<LearnResult> {
    const usage: ProgramUsage = { calls: 0, inputTokens: 0, outputTokens: 0 }
    const blocked = this.blocked()
    if (blocked || !this.provider) return { ok: false, reason: blocked ?? 'no provider', issues: [], usage, attempts: 0 }
    this.running = true
    let issues: string[] = []
    let attempts = 0
    try {
      const maxCalls = Math.max(1, this.opts.budget?.callsPerInstruction ?? 3)
      while (attempts < maxCalls) {
        const b = this.budget.blocked()
        if (b) return { ok: false, reason: b, issues, usage, attempts }
        attempts++
        const accepted: { program?: Program, report?: DryRunReport } = {}
        const submitted: string[][] = []
        const host = this.toolHost(input.current, accepted, submitted)
        const system = this.systemPrompt()
        const userMessage = this.userMessage(input, issues)
        this.log.trace('learn prompt', { system, user: userMessage, attempt: attempts })
        const started = Date.now()
        let text = ''
        let reported
        let error: string | undefined
        let detail: string | undefined
        try {
          const r = await this.provider.run({
            system,
            userMessage,
            tools: host,
            maxTurns: this.opts.maxTurns ?? 4,
            timeoutMs: this.opts.timeoutMs ?? 180_000,
            signal: signal ?? new AbortController().signal
          })
          text = r.text
          reported = r.usage
          detail = r.detail
        } catch (e) {
          error = (e as Error).message
        }
        this.log.trace('learn response', { text, detail, error })
        const u = this.account({ reported, ok: !error, system, userMessage, text, toolCalls: submitted.length, durationMs: Date.now() - started })
        usage.calls++
        usage.inputTokens += u.inputTokens
        usage.outputTokens += u.outputTokens
        if (u.costUsd !== undefined) usage.costUsd = (usage.costUsd ?? 0) + u.costUsd
        this.log.info(`learn call ${attempts}: ${fmtTurn(u)}`, { attempt: attempts, in: u.inputTokens, out: u.outputTokens, ok: !error, submissions: submitted.length, accepted: !!accepted.program })
        if (error) return { ok: false, reason: `LLM call failed: ${error}`, issues, usage, attempts }
        // Providers without tool support: accept a JSON program in the final text.
        if (!accepted.program && !submitted.length) {
          const json = extractJson(text)
          if (json !== undefined) await host.call(TOOL.name, json && typeof json === 'object' && ('program' in json || 'patch' in json) ? json : { program: json })
        }
        if (accepted.program) return { ok: true, program: accepted.program, report: accepted.report!, usage, attempts }
        issues = submitted.at(-1) ?? ['no program was submitted; call submit_program']
      }
      return { ok: false, reason: `no valid program after ${attempts} attempts`, issues, usage, attempts }
    } finally {
      this.running = false
    }
  }

  private toolHost (current: Program, accepted: { program?: Program, report?: DryRunReport }, submitted: string[][]): ToolHost & { lastText?: string } {
    return {
      list: () => [TOOL],
      call: async (name, args) => {
        if (name !== TOOL.name) return { ok: false, text: `unknown tool "${name}"` }
        if (accepted.program) return { ok: true, text: 'already accepted; stop and reply with one short sentence' }
        const a = (args ?? {}) as { program?: unknown, patch?: unknown }
        let raw: unknown
        if (a.patch !== undefined && a.program === undefined) {
          const p = PatchSchema.safeParse(a.patch)
          if (!p.success) {
            const issues = p.error.issues.map(i => `patch.${i.path.join('.')}: ${i.message}`)
            submitted.push(issues)
            return { ok: false, text: `rejected:\n${issues.join('\n')}` }
          }
          raw = applyPatch(current, p.data)
        } else if (a.program !== undefined) {
          raw = a.program
        } else {
          submitted.push(['pass "program" or "patch"'])
          return { ok: false, text: 'rejected: pass "program" or "patch"' }
        }
        const g = await gate(raw, this.opts.catalog())
        if (!g.ok) {
          submitted.push(g.issues)
          this.log.debug(`submission rejected at ${g.stage}`, { issues: g.issues.slice(0, 5) })
          return { ok: false, text: `rejected at ${g.stage}:\n${g.issues.slice(0, 20).join('\n')}` }
        }
        submitted.push([])
        accepted.program = g.program
        accepted.report = g.report
        return { ok: true, text: `accepted (${g.report.runs} dry runs, ${g.report.calls.length} simulated actions)` }
      }
    }
  }

  /** Asks the model to explain the program in plain words (no tools). */
  async explain (program: Program, question = 'Explain in two short sentences what this bot does and when.'): Promise<{ ok: boolean, text: string }> {
    const blocked = this.blocked()
    if (blocked || !this.provider) return { ok: false, text: blocked ?? 'no provider' }
    this.running = true
    try {
      const system = 'You explain a Minecraft NPC bot\'s declarative program to its owner. Plain words, at most 2 sentences, under 220 characters.'
      const userMessage = `PROGRAM:\n${JSON.stringify(program)}\n\nQUESTION: ${question}`
      const started = Date.now()
      const empty: ToolHost = { list: () => [], call: async () => ({ ok: false, text: 'no tools' }) }
      try {
        const r = await this.provider.run({ system, userMessage, tools: empty, maxTurns: 1, timeoutMs: 60_000, signal: new AbortController().signal })
        this.account({ reported: r.usage, ok: true, system, userMessage, text: r.text, toolCalls: 0, durationMs: Date.now() - started })
        return { ok: true, text: r.text.replace(/\s+/g, ' ').trim().slice(0, 240) }
      } catch (e) {
        this.account({ ok: false, system, userMessage, text: '', toolCalls: 0, durationMs: Date.now() - started })
        return { ok: false, text: (e as Error).message }
      }
    } finally {
      this.running = false
    }
  }

  private account (a: { reported?: TurnUsage | any, ok: boolean, system: string, userMessage: string, text: string, toolCalls: number, durationMs: number }): TurnUsage {
    const p = this.provider!
    const u = turnUsage({
      provider: p.name,
      model: p.model,
      billing: p.billing,
      reported: a.reported,
      inText: a.system + a.userMessage,
      outText: a.text,
      toolCalls: a.toolCalls,
      durationMs: a.durationMs,
      ok: a.ok,
      price: (x, model) => this.prices.cost(x, model)
    })
    if (!a.ok && u.estimated) { u.inputTokens = 0; u.outputTokens = 0 }
    this.usage.record(u)
    this.budget.record(u)
    return u
  }
}

/** First balanced {...} block in a text, parsed, or undefined. */
export function extractJson (text: string): unknown {
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const src = fence ? fence[1]! : text
  const start = src.indexOf('{')
  if (start < 0) return undefined
  let depth = 0
  let inStr = false
  for (let i = start; i < src.length; i++) {
    const c = src[i]
    if (inStr) {
      if (c === '\\') i++
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) {
      try { return JSON.parse(src.slice(start, i + 1)) } catch { return undefined }
    }
  }
  return undefined
}
