// Claude through the user's logged-in Claude subscription (Pro/Max), no API key.
//
// mode 'sdk' (default): the Claude Agent SDK runs Claude Code as a library. Our tools are
//   attached as an in-process SDK MCP server (or the HTTP bridge with transport 'http').
// mode 'cli': spawns `claude -p` with --mcp-config pointing at the HTTP bridge.
//
// Sandboxing (both modes): no built-in tools (tools: [] / --tools ""), only our MCP server
// (strict MCP config), only our tools pre-approved and everything else denied
// (permission mode dontAsk), no user/project settings, hooks, plugins or CLAUDE.md
// (settingSources: []), no session persistence, and an empty scratch dir as cwd.
//
// Auth and isolation: Claude Code runs in a profile (see proc.ts): HOME and CLAUDE_CONFIG_DIR
// point at .auth/claude (or `profile`), with a minimal allowlisted environment. Your own
// ~/.claude (settings, CLAUDE.md, hooks, plugins, MCP servers, login) and shell variables
// (ANTHROPIC_BASE_URL, gateways, keys) never reach it. Log in once: `just llm-login claude`
// (interactive) or `just llm-login claude token` (`claude setup-token`, for unattended bots;
// put the token in CLAUDE_CODE_OAUTH_TOKEN, which is passed through explicitly).
// profile 'user' uses your normal login instead (settings are still ignored).
// API keys are never passed unless allowApiKey is set, and the turn is aborted if Claude Code
// still reports an API key as its credential source.
import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { join } from 'node:path'
import { buildMcpServer } from '../mcp.ts'
import { ProviderError, type LlmProvider, type TurnInput, type TurnResult, type Usage } from '../types.ts'
import { isolatedEnv, resolveProfile, runProcess, scratchDir, tail, which, type Profile } from './proc.ts'

export interface ClaudeSubscriptionOptions {
  mode?: 'sdk' | 'cli'
  /** SDK mode only: 'sdk' = in-process MCP server, 'http' = the bot's HTTP bridge. Default 'sdk'. */
  transport?: 'sdk' | 'http'
  /** Model alias or id ('sonnet', 'opus', 'haiku', or a full id). Default: Claude Code's default. */
  model?: string
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /** Let Claude Code use ANTHROPIC_API_KEY if set (billed to the API, not the subscription). Default false. */
  allowApiKey?: boolean
  /** claude binary for mode 'cli' and the login check. Default `claude` on PATH. */
  bin?: string
  /** Login profile: directory used as HOME (default .auth/claude), or 'user' for your normal login. */
  profile?: string
}

const KEY_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']
const SERVER = 'minecraft'

export class ClaudeSubscriptionProvider implements LlmProvider {
  readonly name = 'claude-subscription'
  readonly billing = 'subscription' as const
  readonly needsMcp: boolean
  readonly model?: string
  private readonly opts: ClaudeSubscriptionOptions
  readonly profile: Profile

  constructor (opts: ClaudeSubscriptionOptions = {}) {
    this.opts = opts
    this.profile = resolveProfile('claude', opts.profile)
    this.model = opts.model
    this.needsMcp = opts.mode === 'cli' || opts.transport === 'http'
  }

  private env (): NodeJS.ProcessEnv {
    const set: Record<string, string> = { CLAUDE_AGENT_SDK_CLIENT_APP: 'mc-buddy/0.1' }
    if (this.profile.kind === 'isolated') set.CLAUDE_CONFIG_DIR = join(this.profile.home, '.claude')
    const pass = ['CLAUDE_CODE_OAUTH_TOKEN', ...(this.profile.kind === 'user' ? ['CLAUDE_CONFIG_DIR'] : []), ...(this.opts.allowApiKey ? KEY_VARS : [])]
    return isolatedEnv(this.profile, { set, pass })
  }

  async check (): Promise<string | null> {
    // A long-lived subscription token from `claude setup-token` (for unattended bots).
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return null
    const bin = which(this.opts.bin ?? 'claude')
    if (!bin) {
      if (this.opts.mode === 'cli') return 'claude CLI not found on PATH (set MC_CLAUDE_BIN)'
      return null // SDK mode ships its own binary; auth is verified when the session starts
    }
    try {
      const r = await runProcess(bin, ['auth', 'status', '--json'], { env: this.env(), timeoutMs: 15_000 })
      const s = JSON.parse(r.stdout) as { loggedIn?: boolean, authMethod?: string }
      if (!s.loggedIn) return `Claude Code is not logged in for profile ${this.profile.home}: run \`just llm-login claude\``
      if (!this.opts.allowApiKey && /api.?key/i.test(s.authMethod ?? '')) return `Claude Code auth method is ${s.authMethod}, not a subscription login`
      return null
    } catch (e) {
      return `could not check Claude login: ${(e as Error).message}`
    }
  }

  async run (turn: TurnInput): Promise<TurnResult> {
    return this.opts.mode === 'cli' ? this.runCli(turn) : this.runSdk(turn)
  }

  // ---------------------------------------------------------------- SDK mode

  private async runSdk (turn: TurnInput): Promise<TurnResult> {
    const scratch = scratchDir('claude')
    const abort = new AbortController()
    const onAbort = () => abort.abort()
    turn.signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => abort.abort(), turn.timeoutMs)
    const mcpServers: Options['mcpServers'] = this.opts.transport === 'http'
      ? { [SERVER]: { type: 'http', url: need(turn).url, headers: { Authorization: `Bearer ${need(turn).token}` } } }
      : { [SERVER]: { type: 'sdk', name: SERVER, instance: buildMcpServer(turn.tools, SERVER) as any } }
    const options: Options = {
      systemPrompt: turn.system,
      tools: [],
      mcpServers,
      strictMcpConfig: true,
      allowedTools: [`mcp__${SERVER}`],
      permissionMode: 'dontAsk',
      settingSources: [],
      persistSession: false,
      maxTurns: turn.maxTurns,
      cwd: scratch.path,
      env: this.env(),
      abortController: abort,
      extraArgs: { 'disable-slash-commands': null },
      ...(this.opts.model ? { model: this.opts.model } : {}),
      ...(this.opts.effort ? { effort: this.opts.effort } : {})
    }
    const state = newState()
    try {
      for await (const msg of query({ prompt: turn.userMessage, options })) {
        const err = this.consume(state, msg)
        if (err) { abort.abort(); throw new ProviderError(this.name, err) }
      }
    } catch (e) {
      if (e instanceof ProviderError) throw e
      if (abort.signal.aborted && !state.done) throw new ProviderError(this.name, turn.signal.aborted ? 'aborted' : `timed out after ${turn.timeoutMs}ms`)
      throw new ProviderError(this.name, (e as Error).message)
    } finally {
      clearTimeout(timer)
      turn.signal.removeEventListener('abort', onAbort)
      scratch.remove()
    }
    return finish(state)
  }

  // ---------------------------------------------------------------- CLI mode

  private async runCli (turn: TurnInput): Promise<TurnResult> {
    const bin = which(this.opts.bin ?? 'claude')
    if (!bin) throw new ProviderError(this.name, 'claude CLI not found on PATH')
    const mcp = need(turn)
    const mcpConfig = JSON.stringify({ mcpServers: { [SERVER]: { type: 'http', url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` } } } })
    const args = [
      '-p', '--output-format', 'stream-json', '--verbose',
      '--system-prompt', turn.system,
      '--tools', '',
      '--strict-mcp-config', '--mcp-config', mcpConfig,
      '--allowedTools', `mcp__${SERVER}`,
      '--permission-mode', 'dontAsk',
      '--setting-sources', '',
      '--no-session-persistence',
      '--disable-slash-commands'
    ]
    if (this.opts.model) args.push('--model', this.opts.model)
    if (this.opts.effort) args.push('--effort', this.opts.effort)
    const scratch = scratchDir('claude')
    const state = newState()
    let authError: string | null = null
    try {
      const r = await runProcess(bin, args, {
        cwd: scratch.path,
        env: this.env(),
        timeoutMs: turn.timeoutMs,
        signal: turn.signal,
        stdin: turn.userMessage,
        onLine: (line) => {
          let msg: SDKMessage
          try { msg = JSON.parse(line) } catch { return }
          authError ??= this.consume(state, msg)
        }
      })
      if (authError) throw new ProviderError(this.name, authError)
      if (r.timedOut) throw new ProviderError(this.name, `timed out after ${turn.timeoutMs}ms`)
      if (r.aborted) throw new ProviderError(this.name, 'aborted')
      if (!state.done && r.code !== 0) throw new ProviderError(this.name, `claude exited with ${r.code}: ${tail(r.stderr || r.stdout)}`)
    } finally {
      scratch.remove()
    }
    return finish(state)
  }

  // ---------------------------------------------------------------- messages

  /** Folds one SDK / stream-json message into the turn state. Returns an error to abort with. */
  private consume (s: TurnState, msg: SDKMessage): string | null {
    if (msg.type === 'system' && msg.subtype === 'init') {
      s.model = msg.model
      s.detail.push(`model ${msg.model}, auth ${msg.apiKeySource}`)
      const viaKey = msg.apiKeySource !== 'none' && msg.apiKeySource !== 'oauth'
      if (viaKey && !this.opts.allowApiKey) return `Claude Code is using an API key (${msg.apiKeySource}) instead of the subscription login; refusing (set MC_CLAUDE_ALLOW_API_KEY=true to allow)`
      const mcp = msg.mcp_servers.find(m => m.name === SERVER)
      if (mcp && mcp.status !== 'connected') return `MCP server ${SERVER} is ${mcp.status}`
      return null
    }
    if (msg.type === 'assistant') {
      const text = msg.message.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('\n').trim()
      if (text) s.text = text
      return null
    }
    if (msg.type === 'result') {
      s.done = true
      if (msg.subtype === 'success') s.text = msg.result?.trim() || s.text
      else s.detail.push(msg.subtype)
      // modelUsage covers every model call of the query (main loop and helpers); usage only the main loop.
      const models = Object.entries(msg.modelUsage ?? {})
      if (models.length) {
        const sum: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
        for (const [, m] of models) {
          sum.inputTokens += m.inputTokens + m.cacheReadInputTokens + m.cacheCreationInputTokens
          sum.outputTokens += m.outputTokens
          sum.cacheReadTokens = (sum.cacheReadTokens ?? 0) + m.cacheReadInputTokens
          sum.cacheWriteTokens = (sum.cacheWriteTokens ?? 0) + m.cacheCreationInputTokens
        }
        sum.model = models.sort((a, b) => b[1].outputTokens - a[1].outputTokens)[0]![0]
        s.usage = sum
      } else {
        const u = msg.usage
        const read = u.cache_read_input_tokens ?? 0
        const write = u.cache_creation_input_tokens ?? 0
        s.usage = { inputTokens: (u.input_tokens ?? 0) + read + write, outputTokens: u.output_tokens ?? 0, cacheReadTokens: read, cacheWriteTokens: write, model: s.model }
      }
      // total_cost_usd is Claude Code's list-price estimate; on a subscription it is not money spent.
      if (msg.total_cost_usd) s.usage.costUsd = msg.total_cost_usd
      s.detail.push(`${msg.num_turns} turns`)
      // Auth failures etc. come back as an error result whose text would otherwise look like a reply.
      if (msg.is_error) return `turn failed: ${(msg.subtype === 'success' ? msg.result : msg.subtype) || 'unknown error'}`.slice(0, 400)
    }
    return null
  }
}

interface TurnState { text: string, usage?: Usage, done: boolean, detail: string[], model?: string }
const newState = (): TurnState => ({ text: '', done: false, detail: [] })
const finish = (s: TurnState): TurnResult => ({ text: s.text, usage: s.usage, detail: s.detail.join('; ') })

function need (turn: TurnInput): NonNullable<TurnInput['mcp']> {
  if (!turn.mcp) throw new ProviderError('claude-subscription', 'this mode needs the MCP bridge, but it is not running')
  return turn.mcp
}
