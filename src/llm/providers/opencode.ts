// OpenCode (opencode.ai) via `opencode run`, using whatever providers the user connected
// with `opencode auth login` (ChatGPT, GitHub Copilot, API keys, ...).
//
// UNTESTED: OpenCode isn't installed on the machine this was written on. Built from the
// V2 docs (2026-11): config `mcp.servers`, `agents`, ordered `permissions` rules, MCP tools
// named `<server>_<tool>`. `opencode run` output is taken as plain text, since the docs
// don't describe a JSON event format.
//
// Config is written to `opencode.jsonc` in an empty scratch directory used as cwd (project
// config), so the user's global config is not modified. `--standalone` runs a private
// server so the shared background server's config and env aren't used. Note the global
// config and /etc/opencode still merge in; the agent's permission rules are appended last
// (deny everything, then allow only our MCP tools), so they win.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ProviderError, type LlmProvider, type TurnInput, type TurnResult } from '../types.ts'
import { childEnv, runProcess, scratchDir, tail, which } from './proc.ts'

export interface OpenCodeProviderOptions {
  /** provider/model, e.g. "openai/gpt-5.5" or "github-copilot/claude-sonnet-5-5". Default: OpenCode's default. */
  model?: string
  bin?: string
  /** Config schema to write. V2 is current; v1 for older installs (`tools` map, `agent`, `--agent`). */
  configVersion?: 'v2' | 'v1'
  /** Extra args inserted before the prompt (e.g. ["--print-logs"]). */
  extraArgs?: string[]
}

const SERVER = 'minecraft'
const AGENT = 'mcbot'
const TOKEN_VAR = 'MC_BUDDY_MCP_TOKEN'

export class OpenCodeProvider implements LlmProvider {
  readonly name = 'opencode'
  // Usually a subscription login (ChatGPT, Copilot). `run` text output carries no usage, so tokens are estimated.
  readonly billing = 'subscription' as const
  readonly needsMcp = true
  readonly model?: string
  private readonly opts: OpenCodeProviderOptions

  constructor (opts: OpenCodeProviderOptions = {}) {
    this.opts = opts
    this.model = opts.model
  }

  async check (): Promise<string | null> {
    if (!which(this.opts.bin ?? 'opencode')) return 'opencode not found on PATH (install from opencode.ai, then `opencode auth login`)'
    return null
  }

  /** The project config for one turn (exported for tests). */
  config (turn: Pick<TurnInput, 'system' | 'mcp'>): Record<string, unknown> {
    if (!turn.mcp) throw new ProviderError(this.name, 'needs the MCP bridge, but it is not running')
    const headers = { Authorization: `Bearer {env:${TOKEN_VAR}}` }
    if (this.opts.configVersion === 'v1') {
      return {
        $schema: 'https://opencode.ai/config.json',
        ...(this.opts.model ? { model: this.opts.model } : {}),
        mcp: { [SERVER]: { type: 'remote', url: turn.mcp.url, headers, enabled: true } },
        tools: { '*': false, [`${SERVER}_*`]: true },
        agent: {
          [AGENT]: { mode: 'primary', prompt: turn.system, tools: { '*': false, [`${SERVER}_*`]: true } }
        }
      }
    }
    return {
      ...(this.opts.model ? { model: this.opts.model } : {}),
      default_agent: AGENT,
      mcp: { servers: { [SERVER]: { type: 'remote', url: turn.mcp.url, headers, oauth: false, codemode: false } } },
      agents: {
        [AGENT]: {
          mode: 'primary',
          description: 'Minecraft bot brain: only the bot tools',
          system: turn.system,
          permissions: [
            { action: '*', resource: '*', effect: 'deny' },
            { action: `${SERVER}_*`, resource: '*', effect: 'allow' }
          ]
        }
      }
    }
  }

  async run (turn: TurnInput): Promise<TurnResult> {
    const bin = which(this.opts.bin ?? 'opencode')
    if (!bin) throw new ProviderError(this.name, 'opencode not found on PATH')
    const scratch = scratchDir('opencode')
    try {
      writeFileSync(join(scratch.path, 'opencode.jsonc'), JSON.stringify(this.config(turn), null, 2))
      const args = ['--standalone', 'run']
      if (this.opts.configVersion === 'v1') args.push('--agent', AGENT)
      if (this.opts.model) args.push('--model', this.opts.model)
      args.push(...(this.opts.extraArgs ?? []), turn.userMessage)
      const r = await runProcess(bin, args, {
        cwd: scratch.path,
        env: childEnv({ set: { [TOKEN_VAR]: turn.mcp!.token } }),
        timeoutMs: turn.timeoutMs,
        signal: turn.signal
      })
      if (r.timedOut) throw new ProviderError(this.name, `timed out after ${turn.timeoutMs}ms`)
      if (r.aborted) throw new ProviderError(this.name, 'aborted')
      if (r.code !== 0) throw new ProviderError(this.name, `opencode exited with ${r.code}: ${tail(r.stderr || r.stdout)}`)
      // eslint-disable-next-line no-control-regex
      return { text: r.stdout.replace(/\x1b\[[0-9;]*m/g, '').trim().split('\n').slice(-6).join(' ').trim() }
    } finally {
      scratch.remove()
    }
  }
}
