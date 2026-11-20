// Fleet file (YAML) parsing. One process can run bots on several servers:
//
//   servers:
//     mc02: { host: mc.example.com }
//     test: { host: localhost, port: 25566 }
//   defaults: { server: mc02, owners: [robin] }
//   bots:
//     - { bot: buddy, username: McBuddy }
//     - { bot: villager, server: test, count: 3 }
//
// The older single-server form (`server: {...}` at the top) still works.
import { join } from 'node:path'
import YAML from 'yaml'
import { z } from 'zod'
import { serverFromEnv, type InstanceOptions, type ServerConfig } from './definition.ts'

const ServerSchema = z.object({
  host: z.string().optional(),
  port: z.number().int().optional(),
  auth: z.enum(['offline', 'microsoft']).optional(),
  version: z.string().optional(),
  /** Delay between logins on this server. */
  staggerMs: z.number().optional()
})

const BotEntrySchema = z.object({
  bot: z.string().describe('bot definition name (bots/<name>.ts) or path'),
  server: z.string().optional().describe('key in `servers`; defaults.server otherwise'),
  username: z.string().optional(),
  owners: z.array(z.string()).optional(),
  canDig: z.boolean().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  count: z.number().int().min(1).default(1).describe('spawn N copies; usernames get a number suffix')
})

export const LoggingSchema = z.object({
  level: z.string().optional().describe('level spec, e.g. "info,McBuddy=debug,*/neoforge=trace"'),
  format: z.enum(['pretty', 'plain', 'json']).optional(),
  color: z.enum(['auto', 'always', 'never']).optional(),
  time: z.enum(['time', 'iso', 'none']).optional(),
  file: z.string().nullable().optional(),
  dir: z.string().nullable().optional(),
  fileFormat: z.enum(['plain', 'json']).optional(),
  maxSizeMb: z.number().optional(),
  maxFiles: z.number().int().optional(),
  bufferSize: z.number().int().optional()
})

export const FleetFileSchema = z.object({
  logging: LoggingSchema.optional(),
  /** Legacy single-server form. */
  server: ServerSchema.optional(),
  servers: z.record(z.string(), ServerSchema).optional(),
  defaults: z.object({
    server: z.string().optional(),
    owners: z.array(z.string()).optional(),
    canDig: z.boolean().optional(),
    settings: z.record(z.string(), z.unknown()).optional()
  }).optional(),
  staggerMs: z.number().default(5000),
  bots: z.array(BotEntrySchema).min(1)
})

export type FleetFile = z.infer<typeof FleetFileSchema>

export interface PlannedAgent {
  bot: string
  server: string
  serverConfig: ServerConfig
  options: InstanceOptions
  /** Copy number when count > 1 (used to suffix the definition's default username). */
  index?: number
}

export interface FleetPlan {
  servers: Record<string, ServerConfig & { staggerMs: number }>
  agents: PlannedAgent[]
  staggerMs: number
  multiServer: boolean
  logging?: z.infer<typeof LoggingSchema>
}

/** Final username and data dir once the bot definition's default username is known. */
export function resolveUsername (p: PlannedAgent, defUsername: string, multiServer: boolean): InstanceOptions {
  const username = p.options.username ?? (p.index ? `${defUsername}${p.index}` : defUsername)
  return {
    ...p.options,
    username,
    // Keep per-server data apart when the same username runs on several servers.
    ...(multiServer ? { dataDir: join('data', 'bots', p.server, username) } : {})
  }
}

export function parseFleetFile (text: string, base: ServerConfig = serverFromEnv()): FleetPlan {
  const file = FleetFileSchema.parse(YAML.parse(text))
  const servers: FleetPlan['servers'] = {}
  const rawServers = file.servers ?? { default: file.server ?? {} }
  for (const [name, s] of Object.entries(rawServers)) {
    const { staggerMs, ...conn } = s
    servers[name] = { ...base, ...conn, staggerMs: staggerMs ?? file.staggerMs }
  }
  const names = Object.keys(servers)
  const defaultServer = file.defaults?.server ?? names[0]!
  if (!servers[defaultServer]) throw new Error(`defaults.server "${defaultServer}" is not in servers`)
  const multi = names.length > 1

  const agents: PlannedAgent[] = []
  for (const entry of file.bots) {
    const server = entry.server ?? defaultServer
    const serverConfig = servers[server]
    if (!serverConfig) throw new Error(`bot ${entry.bot}: unknown server "${server}" (have: ${names.join(', ')})`)
    for (let i = 1; i <= entry.count; i++) {
      const username = entry.username && entry.count > 1 ? `${entry.username}${i}` : entry.username
      agents.push({
        bot: entry.bot,
        server,
        serverConfig,
        ...(entry.count > 1 ? { index: i } : {}),
        options: {
          username,
          owners: entry.owners ?? file.defaults?.owners,
          canDig: entry.canDig ?? file.defaults?.canDig,
          settings: { ...file.defaults?.settings, ...entry.settings }
        }
      })
    }
  }
  return { servers, agents, staggerMs: file.staggerMs, multiServer: multi, logging: file.logging }
}
