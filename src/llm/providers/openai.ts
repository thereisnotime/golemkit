// OpenAI-compatible chat completions with tool calling, against any base URL: Ollama
// (http://127.0.0.1:11434/v1), llama.cpp server, vLLM, LM Studio, OpenRouter, OpenAI.
// Plain fetch, no SDK dependency.
import { ProviderError, type LlmProvider, type TurnInput, type TurnResult, type Usage } from '../types.ts'

export interface OpenAICompatibleOptions {
  baseUrl?: string
  apiKey?: string
  model?: string
  temperature?: number
  maxTokens?: number
  /** Extra headers (OpenRouter's HTTP-Referer / X-Title, ...). */
  headers?: Record<string, string>
  billing?: 'api' | 'local'
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: { id: string, type: 'function', function: { name: string, arguments: string } }[]
  tool_call_id?: string
}

export class OpenAICompatibleProvider implements LlmProvider {
  readonly name = 'openai'
  readonly needsMcp = false
  /** 'local' for loopback endpoints (Ollama, llama.cpp), 'api' otherwise; add prices via MC_LLM_PRICES. */
  readonly billing: 'api' | 'local'
  readonly baseUrl: string
  readonly model: string
  private readonly opts: OpenAICompatibleOptions

  constructor (opts: OpenAICompatibleOptions = {}) {
    this.opts = opts
    this.baseUrl = (opts.baseUrl || 'http://127.0.0.1:11434/v1').replace(/\/+$/, '')
    this.model = opts.model || 'qwen3:8b'
    this.billing = opts.billing ?? (/^https?:\/\/(127\.|localhost|\[::1\])/.test(this.baseUrl) ? 'local' : 'api')
  }

  async check (): Promise<string | null> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, { headers: this.headers(), signal: AbortSignal.timeout(5000) })
      if (res.status === 401 || res.status === 403) return `${this.baseUrl} rejected the API key (${res.status})`
      if (!res.ok && res.status !== 404) return `${this.baseUrl}/models returned ${res.status}`
      return null
    } catch (e) {
      return `can't reach ${this.baseUrl}: ${(e as Error).message}`
    }
  }

  private headers (): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
      ...this.opts.headers
    }
  }

  async run (turn: TurnInput): Promise<TurnResult> {
    const tools = turn.tools.list().map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }))
    const messages: ChatMessage[] = [{ role: 'system', content: turn.system }, { role: 'user', content: turn.userMessage }]
    const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, model: this.model }
    const deadline = Date.now() + turn.timeoutMs
    let text = ''
    let stop = ''

    for (let i = 0; i < turn.maxTurns; i++) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) { stop = 'timeout'; break }
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          model: this.model,
          messages,
          tools,
          tool_choice: 'auto',
          ...(this.opts.temperature !== undefined ? { temperature: this.opts.temperature } : {}),
          ...(this.opts.maxTokens ? { max_tokens: this.opts.maxTokens } : {})
        }),
        signal: AbortSignal.any([turn.signal, AbortSignal.timeout(remaining)])
      }).catch(e => { throw new ProviderError(this.name, `request failed: ${(e as Error).message}`) })
      if (!res.ok) throw new ProviderError(this.name, `${res.status} ${(await res.text()).slice(0, 300)}`)
      const data = await res.json() as {
        choices?: { message: ChatMessage, finish_reason?: string }[]
        model?: string
        usage?: { prompt_tokens?: number, completion_tokens?: number, prompt_tokens_details?: { cached_tokens?: number } }
      }
      usage.inputTokens += data.usage?.prompt_tokens ?? 0
      usage.outputTokens += data.usage?.completion_tokens ?? 0
      usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + (data.usage?.prompt_tokens_details?.cached_tokens ?? 0)
      if (data.model) usage.model = data.model
      const choice = data.choices?.[0]
      if (!choice) throw new ProviderError(this.name, 'no choices in response')
      const msg = choice.message
      stop = choice.finish_reason ?? ''
      if (msg.content) text = stripThink(msg.content)
      messages.push({ role: 'assistant', content: msg.content ?? null, ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) })
      if (!msg.tool_calls?.length) break
      for (const call of msg.tool_calls) {
        let args: unknown = {}
        try { args = call.function.arguments ? JSON.parse(call.function.arguments) : {} } catch {
          messages.push({ role: 'tool', tool_call_id: call.id, content: 'error: arguments were not valid JSON' })
          continue
        }
        const r = await turn.tools.call(call.function.name, args)
        messages.push({ role: 'tool', tool_call_id: call.id, content: r.text })
      }
      if (i === turn.maxTurns - 1) stop = 'max_turns'
    }
    return { text, usage, detail: stop }
  }
}

/** Local reasoning models (qwen3, deepseek-r1) put their thoughts in <think> tags. */
function stripThink (s: string): string {
  return s.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
}
