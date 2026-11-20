// Provider registry: build a provider by name, with settings from options or env.
import type { LlmProvider } from '../types.ts'
import { AnthropicProvider, type AnthropicProviderOptions } from './anthropic.ts'
import { ClaudeSubscriptionProvider, type ClaudeSubscriptionOptions } from './claude.ts'
import { CodexProvider, type CodexProviderOptions } from './codex.ts'
import { OpenCodeProvider, type OpenCodeProviderOptions } from './opencode.ts'
import { OpenAICompatibleProvider, type OpenAICompatibleOptions } from './openai.ts'

export { AnthropicProvider, ClaudeSubscriptionProvider, CodexProvider, OpenCodeProvider, OpenAICompatibleProvider }
export type { AnthropicProviderOptions, ClaudeSubscriptionOptions, CodexProviderOptions, OpenCodeProviderOptions, OpenAICompatibleOptions }

export const PROVIDERS = ['claude-subscription', 'codex', 'anthropic', 'opencode', 'openai'] as const
export type ProviderName = typeof PROVIDERS[number]

const ALIASES: Record<string, ProviderName> = {
  claude: 'claude-subscription',
  'claude-code': 'claude-subscription',
  'openai-compatible': 'openai',
  ollama: 'openai'
}

const bool = (v: string | undefined) => v === 'true' || v === '1'
const list = (v: string | undefined) => (v ?? '').split(/\s+/).filter(Boolean)

/**
 * Creates a provider. Env (all optional):
 *   MC_LLM_MODEL                        model for any provider
 *   MC_LLM_EFFORT                       anthropic / claude-subscription effort, codex reasoning effort
 *   ANTHROPIC_API_KEY                   anthropic
 *   MC_CLAUDE_MODE=sdk|cli, MC_CLAUDE_TRANSPORT=sdk|http, MC_CLAUDE_ALLOW_API_KEY, MC_CLAUDE_BIN
 *   MC_CODEX_BIN, MC_CODEX_USE_USER_CONFIG, MC_CODEX_CONFIG (space-separated key=value overrides)
 *   MC_OPENCODE_BIN, MC_OPENCODE_CONFIG_VERSION=v2|v1
 *   MC_OPENAI_BASE_URL, MC_OPENAI_API_KEY (or OPENAI_API_KEY)
 */
export function createProvider (name: string, opts: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = process.env): LlmProvider {
  const n = (ALIASES[name] ?? name) as ProviderName
  const model = (opts.model as string | undefined) ?? env.MC_LLM_MODEL
  const effort = (opts.effort as string | undefined) ?? env.MC_LLM_EFFORT
  switch (n) {
    case 'anthropic':
      return new AnthropicProvider({ model, effort: (effort ?? 'low') as AnthropicProviderOptions['effort'], ...opts })
    case 'claude-subscription':
      return new ClaudeSubscriptionProvider({
        model,
        effort: effort as ClaudeSubscriptionOptions['effort'],
        mode: (env.MC_CLAUDE_MODE as 'sdk' | 'cli' | undefined) ?? 'sdk',
        transport: (env.MC_CLAUDE_TRANSPORT as 'sdk' | 'http' | undefined) ?? 'sdk',
        allowApiKey: bool(env.MC_CLAUDE_ALLOW_API_KEY),
        bin: env.MC_CLAUDE_BIN,
        ...opts
      })
    case 'codex':
      return new CodexProvider({
        model,
        reasoningEffort: effort,
        bin: env.MC_CODEX_BIN,
        useUserConfig: bool(env.MC_CODEX_USE_USER_CONFIG),
        config: list(env.MC_CODEX_CONFIG),
        ...opts
      })
    case 'opencode':
      return new OpenCodeProvider({
        model,
        bin: env.MC_OPENCODE_BIN,
        configVersion: (env.MC_OPENCODE_CONFIG_VERSION as 'v1' | 'v2' | undefined) ?? 'v2',
        ...opts
      })
    case 'openai':
      return new OpenAICompatibleProvider({
        model,
        baseUrl: env.MC_OPENAI_BASE_URL,
        apiKey: env.MC_OPENAI_API_KEY || env.OPENAI_API_KEY,
        ...opts
      })
    default:
      throw new Error(`unknown LLM provider "${name}" (expected one of: ${PROVIDERS.join(', ')})`)
  }
}
