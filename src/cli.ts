// mc-buddy CLI.
//   node src/cli.ts run <bot> [--username NAME] [--owners a,b] [--dig]
//   node src/cli.ts fleet <fleet.yaml>
//   node src/cli.ts list
//   node src/cli.ts actions <bot>
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { Agent, Fleet, serverFromEnv, createLogger, type BotDefinition, type InstanceOptions, type ServerConfig } from './core/index.ts'
import { parseFleetFile, resolveUsername } from './core/fleetFile.ts'

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

function runFleet (fleet: Fleet, staggerMs: number | ((server: string) => number)): void {
  let stopping = false
  const shutdown = async () => {
    if (stopping) process.exit(1)
    stopping = true
    log.info('shutting down')
    await fleet.stop()
    setTimeout(() => process.exit(0), 300)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  fleet.start(staggerMs)
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
      const fleet = new Fleet()
      fleet.add(new Agent(def, server, opts))
      runFleet(fleet, 0)
      break
    }
    case 'fleet': {
      if (!arg) throw new Error('usage: fleet <fleet.yaml>')
      const plan = parseFleetFile(readFileSync(arg, 'utf8'), server)
      const fleet = new Fleet()
      for (const p of plan.agents) {
        const def = await loadBot(p.bot)
        const opts = resolveUsername(p, def.username ?? def.name, plan.multiServer)
        fleet.add(new Agent(def, p.serverConfig, opts), p.server)
      }
      for (const name of fleet.servers) {
        const s = plan.servers[name]!
        log.info(`${name} (${s.host}:${s.port}): ${fleet.onServer(name).map(a => a.username).join(', ')}`)
      }
      // Logins are staggered per server; servers start in parallel.
      runFleet(fleet, (name) => plan.servers[name]?.staggerMs ?? plan.staggerMs)
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
