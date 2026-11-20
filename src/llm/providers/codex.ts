// OpenAI Codex CLI through the user's ChatGPT/Codex login: spawns `codex exec` with the
// bot's MCP bridge configured by per-invocation `-c` overrides.
//
// Nothing in ~/.codex/config.toml is modified. By default the user's config.toml is not
// even loaded (--ignore-user-config; auth still comes from CODEX_HOME), so the user's own
// MCP servers, hooks, plugins and custom providers don't leak into the bot's sandbox.
//
// Sandboxing: shell / unified exec / image / browser / computer-use / plugin / hook features
// disabled, web search off, read-only sandbox in an empty scratch dir, approval policy
// "never", ephemeral session (nothing persisted). Verified on codex-cli 0.154: the model has
// no shell (asked to run `ls /`, it reports no shell tool) and apply_patch can't write in
// the read-only sandbox. What remains built in: code mode's `exec` (JavaScript that can only
// call the exposed tools; codex routes MCP calls through it, so it must stay on: disabling
// `code_mode_host` makes our MCP tools unreachable), request_user_input (no-op in exec mode),
// apply_patch, and the collaboration/sub-agent tools (sub-agents get the same tool set).
import { ProviderError, type LlmProvider, type TurnInput, type TurnResult, type Usage } from '../types.ts'
import { isolatedEnv, resolveProfile, runProcess, scratchDir, tail, which, type Profile } from './proc.ts'
import { join } from 'node:path'

export interface CodexProviderOptions {
  model?: string
  /** model_reasoning_effort: minimal | low | medium | high | xhigh. Default low. */
  reasoningEffort?: string
  bin?: string
  /**
   * Load config.toml from the profile's CODEX_HOME (e.g. a model provider/gateway you put
   * there on purpose). With profile 'user' that's your real ~/.codex/config.toml, MCP servers
   * included. Default false.
   */
  useUserConfig?: boolean
  /** Login: directory used as the CLI's HOME (default .auth/codex), or 'user' for your normal login. */
  login?: string
  /** @deprecated older name for `login` */
  profile?: string
  /** Extra `-c key=value` overrides. */
  config?: string[]
}

const SERVER = 'minecraft'
const TOKEN_VAR = 'MC_BUDDY_MCP_TOKEN'
// Built-in capabilities a Minecraft bot must not have (from `codex features list`, codex-cli 0.154).
const DISABLED_FEATURES = [
  'shell_tool', 'unified_exec', 'shell_snapshot', 'view_image', 'image_generation', 'browser_use',
  'browser_use_external', 'computer_use', 'multi_agent', 'plugins', 'apps', 'goals', 'hooks',
  'skill_mcp_dependency_install', 'tool_suggest', 'workspace_dependencies', 'in_app_browser',
  'sleep_tool', 'skill_search'
]

export class CodexProvider implements LlmProvider {
  readonly name = 'codex'
  readonly billing = 'subscription' as const
  readonly needsMcp = true
  readonly model?: string
  private readonly opts: CodexProviderOptions
  readonly profile: Profile

  constructor (opts: CodexProviderOptions = {}) {
    this.opts = opts
    this.profile = resolveProfile('codex', opts.login ?? opts.profile)
    this.model = opts.model
  }

  /** Isolated child environment: HOME and CODEX_HOME in the profile, no inherited OPENAI or CODEX variables. */
  env (extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const set: Record<string, string> = { ...extra }
    if (this.profile.kind === 'isolated') set.CODEX_HOME = join(this.profile.home, '.codex')
    return isolatedEnv(this.profile, { set, pass: this.profile.kind === 'user' ? ['CODEX_HOME'] : [] })
  }

  private bin (): string | null {
    return which(this.opts.bin ?? 'codex')
  }

  async check (): Promise<string | null> {
    const bin = this.bin()
    if (!bin) return 'codex CLI not found on PATH (install it, or set MC_CODEX_BIN)'
    const r = await runProcess(bin, ['login', 'status'], { env: this.env(), timeoutMs: 15_000 }).catch(e => ({ code: 1, stdout: '', stderr: String(e) }))
    const out = `${r.stdout}\n${r.stderr}`
    if (r.code !== 0 || /not logged in/i.test(out)) return `codex is not logged in for profile ${this.profile.home}: run \`just llm-login codex\``
    return null
  }

  /** The argv for one turn (exported for tests and docs). */
  args (turn: Pick<TurnInput, 'system' | 'mcp'>, cwd: string): string[] {
    if (!turn.mcp) throw new ProviderError(this.name, 'needs the MCP bridge, but it is not running')
    const toml = (s: string) => JSON.stringify(s) // a JSON string is a valid TOML basic string
    const args = ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--ignore-rules', '-s', 'read-only', '-C', cwd]
    if (!this.opts.useUserConfig) args.push('--ignore-user-config')
    for (const f of DISABLED_FEATURES) args.push('--disable', f)
    const cfg = [
      'approval_policy="never"',
      'web_search="disabled"',
      `model_reasoning_effort=${toml(this.opts.reasoningEffort ?? 'low')}`,
      `developer_instructions=${toml(turn.system)}`,
      `mcp_servers.${SERVER}.url=${toml(turn.mcp.url)}`,
      `mcp_servers.${SERVER}.bearer_token_env_var=${toml(TOKEN_VAR)}`,
      `mcp_servers.${SERVER}.default_tools_approval_mode="approve"`,
      `mcp_servers.${SERVER}.tool_timeout_sec=60`,
      ...(this.opts.config ?? [])
    ]
    for (const c of cfg) args.push('-c', c)
    if (this.opts.model) args.push('-m', this.opts.model)
    args.push('-') // prompt from stdin
    return args
  }

  async run (turn: TurnInput): Promise<TurnResult> {
    const bin = this.bin()
    if (!bin) throw new ProviderError(this.name, 'codex CLI not found on PATH')
    const scratch = scratchDir('codex')
    let text = ''
    let usage: Usage | undefined
    const errors: string[] = []
    try {
      const r = await runProcess(bin, this.args(turn, scratch.path), {
        cwd: scratch.path,
        env: this.env({ [TOKEN_VAR]: turn.mcp!.token }),
        timeoutMs: turn.timeoutMs,
        signal: turn.signal,
        stdin: turn.userMessage,
        onLine: (line) => {
          let ev: any
          try { ev = JSON.parse(line) } catch { return }
          if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && ev.item.text) text = String(ev.item.text).trim()
          // codex-cli 0.154: {"type":"turn.completed","usage":{"input_tokens","cached_input_tokens",
          // "cache_write_input_tokens","output_tokens","reasoning_output_tokens"}}; cached is a subset of input,
          // reasoning a subset of output (Responses API semantics).
          if (ev.type === 'turn.completed' && ev.usage) {
            const u = ev.usage
            usage = {
              inputTokens: (usage?.inputTokens ?? 0) + (u.input_tokens ?? 0),
              outputTokens: (usage?.outputTokens ?? 0) + (u.output_tokens ?? 0),
              cacheReadTokens: (usage?.cacheReadTokens ?? 0) + (u.cached_input_tokens ?? 0),
              cacheWriteTokens: (usage?.cacheWriteTokens ?? 0) + (u.cache_write_input_tokens ?? 0),
              model: this.opts.model
            }
          }
          if (ev.type === 'turn.failed' || ev.type === 'error') errors.push(ev.error?.message ?? ev.message ?? JSON.stringify(ev))
        }
      })
      if (r.timedOut) throw new ProviderError(this.name, `timed out after ${turn.timeoutMs}ms`)
      if (r.aborted) throw new ProviderError(this.name, 'aborted')
      if (r.code !== 0) throw new ProviderError(this.name, `codex exited with ${r.code}: ${errors.join('; ') || tail(r.stderr)}`)
    } finally {
      scratch.remove()
    }
    return { text, usage, detail: errors.length ? errors.join('; ') : undefined }
  }
}
