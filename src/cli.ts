// mc-buddy CLI.
//   node src/cli.ts run <bot> [--username NAME] [--owners a,b] [--dig]
//   node src/cli.ts fleet <fleet.yaml>
//   node src/cli.ts list
//   node src/cli.ts actions <bot>
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import YAML from 'yaml'
import { z } from 'zod'
import { Agent, serverFromEnv, createLogger, type BotDefinition, type InstanceOptions, type ServerConfig } from './core/index.ts'

const BOTS_DIR = resolve(import.meta.dirname, '..', 'bots')
const log = createLogger('mc-buddy')

async function loadBot (name: string): Promise<BotDefinition> {
  const candidates = [join(BOTS_DIR, `${name}.ts`), join(BOTS_DIR, name, 'index.ts'), resolve(name)]
  const file = candidates.find(existsSync)
  if (!file) throw new Error(`no bot "${name}" (looked in ${BOTS_DIR})`)
  const mod = await import(pathToFileURL(file).href)
  const def = mod.default as BotDefinition
  if (!def?.name || !Array.isArray(def.skills)) throw new Error(`${file} must default-export defineBot({...})`)
  return def
}

function listBots (): string[] {
  return readdirSync(BOTS_DIR, { withFileTypes: true })
    .filter(d => (d.isFile() && d.name.endsWith('.ts')) || (d.isDirectory() && existsSync(join(BOTS_DIR, d.name, 'index.ts'))))
    .map(d => d.name.replace(/\.ts$/, ''))
    .sort()
}

const FleetSchema = z.object({
  server: z.object({
    host: z.string().optional(),
    port: z.number().optional(),
    auth: z.enum(['offline', 'microsoft']).optional(),
    version: z.string().optional()
  }).optional(),
  /** Delay between bot logins, to stay under connection throttles. */
  staggerMs: z.number().default(5000),
  bots: z.array(z.object({
    bot: z.string(),
    username: z.string().optional(),
    owners: z.array(z.string()).optional(),
    canDig: z.boolean().optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
    count: z.number().int().min(1).default(1).describe('spawn N copies; usernames get a number suffix')
  })).min(1)
})

function runAgents (agents: Agent[], staggerMs: number): void {
  let stopping = false
  const shutdown = async () => {
    if (stopping) process.exit(1)
    stopping = true
    log.info('shutting down')
    await Promise.allSettled(agents.map(a => a.stop()))
    setTimeout(() => process.exit(0), 300)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  agents.forEach((a, i) => setTimeout(() => { void a.start() }, i * staggerMs))
}

async function main (): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      username: { type: 'string', short: 'u' },
      owners: { type: 'string' },
      dig: { type: 'boolean' },
      host: { type: 'string' },
      port: { type: 'string' }
    }
  })
  const [cmd, arg] = positionals
  const server: ServerConfig = {
    ...serverFromEnv(),
    ...(values.host ? { host: values.host } : {}),
    ...(values.port ? { port: Number(values.port) } : {})
  }

  switch (cmd) {
    case 'run': {
      if (!arg) throw new Error('usage: run <bot>')
      const def = await loadBot(arg)
      const opts: InstanceOptions = {
        username: values.username,
        owners: values.owners?.split(',').map(s => s.trim()).filter(Boolean),
        canDig: values.dig
      }
      runAgents([new Agent(def, server, opts)], 0)
      break
    }
    case 'fleet': {
      if (!arg) throw new Error('usage: fleet <fleet.yaml>')
      const fleet = FleetSchema.parse(YAML.parse(readFileSync(arg, 'utf8')))
      const fleetServer = { ...server, ...fleet.server }
      const agents: Agent[] = []
      for (const entry of fleet.bots) {
        const def = await loadBot(entry.bot)
        for (let i = 1; i <= entry.count; i++) {
          const base = entry.username ?? def.username ?? def.name
          agents.push(new Agent(def, fleetServer, {
            username: entry.count > 1 ? `${base}${i}` : base,
            owners: entry.owners,
            canDig: entry.canDig,
            settings: entry.settings
          }))
        }
      }
      log.info(`fleet: ${agents.map(a => a.username).join(', ')}`)
      runAgents(agents, fleet.staggerMs)
      break
    }
    case 'list':
      for (const name of listBots()) {
        const def = await loadBot(name)
        console.log(`${name.padEnd(16)} ${def.description ?? ''}`)
      }
      break
    case 'actions': {
      if (!arg) throw new Error('usage: actions <bot>')
      const agent = new Agent(await loadBot(arg), server)
      for (const a of agent.listActions()) {
        const keys = Object.keys(a.params.shape)
        console.log(`${a.name.padEnd(14)} ${keys.map(k => `<${k}>`).join(' ').padEnd(28)} ${a.description}${a.internal ? ' (internal)' : ''}`)
      }
      break
    }
    default:
      console.log('usage: cli.ts run <bot> [--username X] [--owners a,b] [--dig] | fleet <file> | list | actions <bot>')
      process.exitCode = cmd ? 1 : 0
  }
}

main().catch((e) => {
  log.error(e instanceof Error ? e.message : String(e))
  process.exit(1)
})
