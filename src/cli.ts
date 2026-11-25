// golemkit CLI.
//   node src/cli.ts run <profile|variant> [--username NAME] [--owners a,b] [--dig]
//   node src/cli.ts fleet <name|file.yaml>        (fleets/<name>.yaml)
//   node src/cli.ts list
//   node src/cli.ts actions <profile|variant>
//   node src/cli.ts status [name] [--json] [--watch]   (reads data/bots/**/status.json)
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { flushCompileCache } from 'node:module'
import { parseArgs } from 'node:util'
import { Agent, Fleet, serverFromEnv, createLogger, configureLogging, installCrashHandlers, type BotDefinition, type InstanceOptions, type ServerConfig } from './core/index.ts'
import { parseFleetFile, resolveUsername, fleetServerConfig, fleetAddresses } from './core/fleetFile.ts'
import { loadProfile, mergeOptions, PROFILES_DIR, type LoadedProfile } from './core/profile.ts'
import { memlogInterval, startMemLog } from './core/memlog.ts'
import { validateBehaviorConfig, defaultBehaviorRegistry } from './brains/behaviors/index.ts'
import { formatStatus, staleAfter, fmtDuration, type BotStatus } from './core/status.ts'

const ROOT = resolve(import.meta.dirname, '..')
const VARIANTS_DIR = join(ROOT, 'variants')
const FLEETS_DIR = join(ROOT, 'fleets')
const log = createLogger('golemkit')

async function loadVariant (name: string): Promise<BotDefinition> {
  const candidates = [join(VARIANTS_DIR, `${name}.ts`), join(VARIANTS_DIR, name, 'index.ts'), resolve(name)]
  const file = candidates.find(f => f.endsWith('.ts') && existsSync(f))
  if (!file) throw new Error(`no variant or profile "${name}" (looked in ${VARIANTS_DIR} and ${join(ROOT, PROFILES_DIR)})`)
  const mod = await import(pathToFileURL(file).href)
  const def = mod.default as BotDefinition
  if (!def?.name || !Array.isArray(def.skills)) throw new Error(`${file} must default-export defineVariant({...})`)
  return def
}

interface Target { def: BotDefinition, profile: LoadedProfile | null }

/** A name is a profile if profiles/<name>.yaml exists, otherwise a variant. */
async function resolveTarget (name: string): Promise<Target> {
  const profile = loadProfile(name, join(ROOT, PROFILES_DIR))
  if (profile) {
    const def = await loadVariant(profile.profile.variant)
    if (profile.profile.behaviors) {
      // fail before connecting: unknown behaviour names and bad options are config errors
      validateBehaviorConfig(profile.profile.behaviors, defaultBehaviorRegistry(), `${profile.file}: behaviors`)
      if (!def.brains.some(b => b.name === 'behaviors')) log.warn(`${profile.file} sets behaviors but variant ${def.name} has no behaviorsBrain(); they will not run`)
    }
    return { def, profile }
  }
  return { def: await loadVariant(name), profile: null }
}

function listDir (dir: string, ext: RegExp): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter(d => (d.isFile() && ext.test(d.name)) || (d.isDirectory() && existsSync(join(dir, d.name, 'index.ts'))))
    .map(d => d.name.replace(ext, ''))
    .sort()
}

function fleetPath (name: string): string {
  for (const f of [join(FLEETS_DIR, `${name}.yaml`), join(FLEETS_DIR, `${name}.yml`), name]) if (existsSync(f)) return f
  throw new Error(`no fleet "${name}" (looked in ${FLEETS_DIR})`)
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
  const memEvery = memlogInterval(process.env.GOLEM_MEMLOG)
  if (memEvery) {
    log.info(`memlog every ${memEvery}s (pid ${process.pid})`)
    startMemLog({ intervalS: memEvery, log: createLogger('memlog'), sources: () => fleet.agents.map(a => ({ name: a.username, counts: () => a.memStats() })) })
  }
  fleet.start(staggerMs)
  // With NODE_COMPILE_CACHE set (the justfile does), write the cache once the bots are up, so the
  // next start skips the TypeScript stripper even when this process is killed instead of stopped.
  if (process.env.NODE_COMPILE_CACHE) setTimeout(() => { try { flushCompileCache() } catch {} }, 60_000).unref()
}

/** Every status.json under data/bots/ (data/bots/<bot>/ and data/bots/<server>/<bot>/), relative to the working directory like the agents' data. */
function findStatusFiles (root = join('data', 'bots')): string[] {
  if (!existsSync(root)) return []
  const out: string[] = []
  for (const d of readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    const dir = join(root, d.name)
    if (existsSync(join(dir, 'status.json'))) out.push(join(dir, 'status.json'))
    for (const sub of readdirSync(dir, { withFileTypes: true })) {
      if (sub.isDirectory() && existsSync(join(dir, sub.name, 'status.json'))) out.push(join(dir, sub.name, 'status.json'))
    }
  }
  return out.sort()
}

function readStatus (file: string): BotStatus | null {
  try { return JSON.parse(readFileSync(file, 'utf8')) as BotStatus } catch { return null }
}

/** `status [name]`: one bot in detail (by username, profile or data dir name), or one line per bot. */
function printStatus (name: string | undefined, json: boolean): boolean {
  const all = findStatusFiles().map(f => ({ file: f, s: readStatus(f) })).filter((x): x is { file: string, s: BotStatus } => !!x.s)
  const now = Date.now()
  const want = name?.toLowerCase()
  const hits = want ? all.filter(x => x.s.bot.toLowerCase() === want || x.s.profile?.toLowerCase() === want || x.file.split(/[\\/]/).at(-2)?.toLowerCase() === want) : all
  if (!hits.length) {
    console.error(want ? `no status for "${name}" (looked in data/bots/*/status.json; is the bot running with settings.status.file on?)` : 'no status files under data/bots/ (no bot has run with settings.status.file on)')
    return false
  }
  if (json) {
    console.log(JSON.stringify(want && hits.length === 1 ? hits[0]!.s : hits.map(x => x.s), null, 2))
    return true
  }
  if (!want && hits.length > 1) {
    for (const { s } of hits) {
      const stale = now - s.updatedAt > staleAfter(s)
      console.log(`${s.bot.padEnd(14)} ${(stale ? 'not running' : s.state).padEnd(11)} ${stale ? `last update ${fmtDuration(now - s.updatedAt)} ago` : s.summary}`)
    }
    return true
  }
  for (const [i, { s, file }] of hits.entries()) {
    if (i) console.log('')
    for (const line of formatStatus(s, now)) console.log(line)
    console.log(`  file      ${file}`)
  }
  return true
}

async function main (): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      username: { type: 'string', short: 'u' },
      owners: { type: 'string' },
      dig: { type: 'boolean' },
      host: { type: 'string' },
      port: { type: 'string' },
      'log-level': { type: 'string', short: 'l' },
      'log-format': { type: 'string' },
      'log-file': { type: 'string' },
      'log-dir': { type: 'string' },
      verbose: { type: 'boolean', short: 'v' },
      quiet: { type: 'boolean', short: 'q' },
      json: { type: 'boolean' },
      watch: { type: 'boolean', short: 'w' }
    }
  })
  installCrashHandlers(log)
  const cliLogging = {
    level: values['log-level'] ?? (values.verbose ? 'debug' : values.quiet ? 'warn' : undefined),
    format: values['log-format'] as 'pretty' | 'plain' | 'json' | undefined,
    file: values['log-file'],
    dir: values['log-dir']
  }
  configureLogging(cliLogging)
  const [cmd, arg] = positionals
  /** --host/--port: they beat the environment, profiles and fleet files. */
  const serverFlags: Partial<ServerConfig> = {
    ...(values.host ? { host: values.host } : {}),
    ...(values.port ? { port: Number(values.port) } : {})
  }
  const server: ServerConfig = { ...serverFromEnv(), ...serverFlags }

  switch (cmd) {
    case 'run': {
      if (!arg) throw new Error('usage: run <profile|variant>')
      const { def, profile } = await resolveTarget(arg)
      const flags: InstanceOptions = {
        username: values.username,
        owners: values.owners?.split(',').map(s => s.trim()).filter(Boolean),
        canDig: values.dig
      }
      // env < profile < CLI flags
      if (profile?.profile.logging) configureLogging({ ...profile.profile.logging, file: profile.profile.logging.file ?? undefined, dir: profile.profile.logging.dir ?? undefined })
      configureLogging(cliLogging)
      const target: ServerConfig = { ...serverFromEnv(), ...profile?.server, ...serverFlags }
      if (profile) log.info(`profile ${profile.name} (variant ${def.name})`)
      const fleet = new Fleet()
      fleet.add(new Agent(def, target, mergeOptions(profile?.options, flags)))
      runFleet(fleet, 0)
      break
    }
    case 'fleet': {
      if (!arg) throw new Error('usage: fleet <name|file.yaml>')
      const file = fleetPath(arg)
      // env < profile server: < fleet servers: entry < --host/--port (same as run: flags win)
      const plan = parseFleetFile(readFileSync(file, 'utf8'), serverFromEnv(), file)
      // Fleet file logging first, then CLI flags on top.
      if (plan.logging) configureLogging({ ...plan.logging, file: plan.logging.file ?? undefined, dir: plan.logging.dir ?? undefined })
      configureLogging(cliLogging)
      const fleet = new Fleet()
      for (const p of plan.agents) {
        const { def, profile } = p.profile ? await resolveTarget(p.profile) : { def: await loadVariant(p.variant!), profile: null }
        const merged = mergeOptions(profile?.options, p.options)
        const opts = resolveUsername(p, merged.username ?? def.username ?? def.name, plan.multiServer, merged)
        fleet.add(new Agent(def, fleetServerConfig(p, profile?.server, serverFlags), opts), p.server)
      }
      // the address each bot really connects to (after profiles and flags), grouped
      for (const name of fleet.servers) log.info(`${name}: ${fleetAddresses(fleet.onServer(name))}`)
      // Logins are staggered per server; servers start in parallel.
      runFleet(fleet, (name) => plan.servers[name]?.staggerMs ?? plan.staggerMs)
      break
    }
    case 'list': {
      console.log('variants:')
      for (const name of listDir(VARIANTS_DIR, /\.ts$/)) {
        const def = await loadVariant(name)
        console.log(`  ${name.padEnd(14)} ${def.description ?? ''}`)
      }
      console.log('profiles:')
      for (const name of listDir(join(ROOT, PROFILES_DIR), /\.ya?ml$/)) {
        const p = loadProfile(name, join(ROOT, PROFILES_DIR))!
        console.log(`  ${name.padEnd(14)} ${p.profile.variant.padEnd(10)} ${p.profile.username ?? ''}${p.profile.description ? `  ${p.profile.description}` : ''}`)
      }
      console.log('fleets:')
      for (const name of listDir(FLEETS_DIR, /\.ya?ml$/)) console.log(`  ${name}`)
      break
    }
    case 'actions': {
      if (!arg) throw new Error('usage: actions <profile|variant>')
      const { def, profile } = await resolveTarget(arg)
      const agent = new Agent(def, server, profile?.options)
      for (const a of agent.listActions()) {
        const keys = Object.keys(a.params.shape)
        console.log(`${a.name.padEnd(14)} ${keys.map(k => `<${k}>`).join(' ').padEnd(28)} ${a.description}${a.internal ? ' (internal)' : ''}`)
      }
      break
    }
    case 'status': {
      if (values.watch) {
        const draw = () => { process.stdout.write('\x1b[2J\x1b[H'); printStatus(arg, !!values.json) }
        draw()
        setInterval(draw, 2000)
        await new Promise(() => {})
      }
      if (!printStatus(arg, !!values.json)) process.exitCode = 1
      break
    }
    default:
      console.log([
        'usage: cli.ts <command> [options]',
        '  run <profile|variant>  [--username X] [--owners a,b] [--dig] [--host H] [--port P]',
        '  fleet <name|file>      run fleets/<name>.yaml or a file',
        '  list                   variants, profiles and fleets',
        '  actions <name>         a profile\'s or variant\'s actions',
        '  status [name]          what a running bot is doing and why (data/bots/**/status.json) [--json] [-w|--watch]',
        'logging: [-l|--log-level SPEC] [--log-format pretty|plain|json] [--log-file F] [--log-dir D] [-v|--verbose] [-q|--quiet]'
      ].join('\n'))
      process.exitCode = cmd ? 1 : 0
  }
}

main().catch((e) => {
  log.error(e instanceof Error ? e.message : String(e))
  process.exit(1)
})
