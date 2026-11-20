// Logs a subscription CLI into an isolated mc-buddy profile, or shows profile status.
//   node scripts/llm-login.ts <claude|codex|opencode> [token|device] [--profile DIR]
//   node scripts/llm-login.ts status
// The CLI runs with the same isolated environment the bots use (HOME = profile), so the
// login lands in .auth/<provider> (or --profile) and never touches your own ~/.claude etc.
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { isolatedEnv, resolveProfile, which } from '../src/llm/providers/proc.ts'
import { createProvider } from '../src/llm/providers/index.ts'

const { positionals, values } = parseArgs({ allowPositionals: true, options: { profile: { type: 'string' } } })
const [provider = 'status', mode] = positionals

function envFor (name: string) {
  const profile = resolveProfile(name, values.profile)
  const set: Record<string, string> = {}
  if (profile.kind === 'isolated' && name === 'claude') set.CLAUDE_CONFIG_DIR = join(profile.home, '.claude')
  if (profile.kind === 'isolated' && name === 'codex') set.CODEX_HOME = join(profile.home, '.codex')
  return { profile, env: isolatedEnv(profile, { set }) }
}

function run (bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise(resolve => {
    const child = spawn(bin, args, { env, stdio: 'inherit' })
    child.on('close', code => resolve(code ?? 1))
  })
}

async function status (): Promise<void> {
  const providers: [string, string][] = [['claude-subscription', 'claude'], ['codex', 'codex'], ['opencode', 'opencode']]
  for (const [name, short] of providers) {
    const p = createProvider(name, values.profile ? { profile: values.profile } : {})
    const home = (p as any).profile?.home ?? '?'
    const problem = await p.check().catch((e: Error) => e.message)
    console.log(`${short.padEnd(9)} ${problem ? `✗ ${problem.replace(/ for profile \S+:/, ':')}` : '✓ ready'}\n          profile: ${home}`)
  }
}

const COMMANDS: Record<string, { bin: string, args: (mode?: string) => string[] }> = {
  claude: { bin: 'claude', args: m => m === 'token' ? ['setup-token'] : ['auth', 'login'] },
  codex: { bin: 'codex', args: m => m === 'device' ? ['login', '--device-auth'] : ['login'] },
  opencode: { bin: 'opencode', args: () => ['auth', 'login'] }
}

if (provider === 'status') {
  await status()
} else {
  const cmd = COMMANDS[provider]
  if (!cmd) { console.error('usage: llm-login.ts <claude|codex|opencode> [token|device] [--profile DIR] | status'); process.exit(1) }
  const bin = which(cmd.bin)
  if (!bin) { console.error(`${cmd.bin} not found on PATH`); process.exit(1) }
  const { profile, env } = envFor(provider)
  console.log(`logging ${provider} into ${profile.kind === 'user' ? 'your normal profile' : profile.home}`)
  if (provider === 'claude' && mode === 'token') {
    console.log('after this, put the printed token in CLAUDE_CODE_OAUTH_TOKEN (e.g. in .env)')
  }
  process.exit(await run(bin, cmd.args(mode), env))
}
