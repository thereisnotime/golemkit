// Player-assistant brain: turns chat commands into actions. Every registered action is a
// command automatically ("!goto 10 64 -20", "!follow Steve"); positional words map to the
// action's parameters in schema order, "key=value" works too.
import { z } from 'zod'
import { defineBrain, PRIORITY, type Agent, type ActionDef, type ChatMessage } from '../core/index.ts'

export interface CommandBrainOptions {
  /** Prefix for public chat commands. Whispers work without it. */
  prefix?: string
  /** Reply to failed/unknown commands. Default true. */
  verbose?: boolean
  /** Say hello in public chat after each login. Default false (fleets would spam). */
  greet?: boolean
  /** Require the prefix in whispers too. Default false. Set it when an LLM brain answers plain whispers. */
  whisperNeedsPrefix?: boolean
}

export const commandBrain = (opts: CommandBrainOptions = {}) => {
  const prefix = opts.prefix ?? process.env.MC_PREFIX ?? '!'
  const verbose = opts.verbose ?? true
  const greet = opts.greet ?? false
  const whisperNeedsPrefix = opts.whisperNeedsPrefix ?? false

  return defineBrain({
    name: 'command',
    start (agent) {
      agent.on('chat', (msg) => { void handle(agent, msg) })
    },
    session (agent) {
      if (greet) agent.say(`hi! I'm ${agent.username}. Say ${prefix}help for commands`)
    }
  })

  async function handle (agent: Agent, msg: ChatMessage): Promise<void> {
    if (!agent.isOwner(msg.from) || msg.claimedBy) return
    let body = msg.message.trim()
    if (body.startsWith(prefix)) body = body.slice(prefix.length)
    else if (!msg.whisper || whisperNeedsPrefix) return

    const [name = '', ...words] = body.split(/\s+/)
    if (name === 'help') return help(agent, msg, words[0])
    const def = agent.getAction(name.toLowerCase())
    if (!def || def.internal) {
      if (verbose && msg.whisper) agent.reply(msg, `unknown command, try ${prefix}help`)
      return
    }
    const params = parseArgs(def, words)
    agent.log.info(`${msg.from}: ${body}`)
    const result = await agent.act(def.name, params, {
      caller: { kind: 'player', name: msg.from },
      priority: PRIORITY.player
    })
    if (result.message && (result.ok || verbose)) agent.reply(msg, result.message)
  }

  function help (agent: Agent, msg: ChatMessage, topic?: string): void {
    if (topic) {
      const def = agent.getAction(topic)
      if (!def) return agent.reply(msg, `no command ${topic}`)
      const keys = Object.keys(def.params.shape)
      return agent.reply(msg, `${prefix}${def.name} ${keys.map(k => `<${k}>`).join(' ')} - ${def.description}`)
    }
    const names = agent.listActions().filter(a => !a.internal).map(a => a.name)
    agent.reply(msg, `commands: ${names.map(n => prefix + n).join(' ')} (${prefix}help <command> for details)`)
  }
}

/**
 * Maps words to parameters: "key=value" pairs by name, the rest positionally in schema
 * order. The last string parameter swallows the remaining words (for "!say hello there").
 * Numbers and booleans are converted when the schema wants them.
 */
export function parseArgs (def: ActionDef, words: string[]): Record<string, unknown> {
  const shape = def.params.shape as Record<string, z.ZodType>
  const keys = Object.keys(shape)
  const out: Record<string, unknown> = {}
  const positional: string[] = []
  for (const w of words) {
    const m = /^([a-zA-Z_]\w*)=(.*)$/.exec(w)
    if (m && keys.includes(m[1]!)) out[m[1]!] = convert(shape[m[1]!]!, m[2]!)
    else positional.push(w)
  }
  const free = keys.filter(k => !(k in out))
  free.forEach((key, i) => {
    if (!positional.length) return
    const schema = shape[key]!
    const isLast = i === free.length - 1
    out[key] = isLast && wants(schema, 'string') ? positional.splice(0).join(' ') : convert(schema, positional.shift()!)
  })
  return out
}

function wants (schema: z.ZodType, type: 'number' | 'boolean' | 'string'): boolean {
  return schema.safeParse(type === 'number' ? 1 : type === 'boolean' ? true : 'x').success
}

function convert (schema: z.ZodType, raw: string): unknown {
  if (wants(schema, 'number') && raw.trim() !== '' && !Number.isNaN(Number(raw))) return Number(raw)
  if (wants(schema, 'boolean') && /^(true|false|on|off|yes|no)$/i.test(raw)) return /^(true|on|yes)$/i.test(raw)
  return raw
}
