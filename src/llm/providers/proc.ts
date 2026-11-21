// Helpers for CLI providers: run a child non-interactively with a timeout, kill its whole
// process group on timeout/abort, stream stdout lines, and build a clean environment.
import { spawn } from 'node:child_process'
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'

export interface RunOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs: number
  signal?: AbortSignal
  stdin?: string
  /** Called for each stdout line as it arrives. */
  onLine?: (line: string) => void
}

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  aborted: boolean
}

export function runProcess (cmd: string, args: string[], opts: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true // own process group, so we can kill grandchildren (MCP helpers, shells) too
    })
    let stdout = ''
    let stderr = ''
    let buf = ''
    let timedOut = false
    let aborted = false
    const kill = () => {
      try { process.kill(-child.pid!, 'SIGTERM') } catch {}
      setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL') } catch {} }, 2000).unref()
    }
    const timer = setTimeout(() => { timedOut = true; kill() }, opts.timeoutMs)
    const onAbort = () => { aborted = true; kill() }
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      stdout += d
      if (!opts.onLine) return
      buf += d
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        if (line.trim()) opts.onLine(line)
      }
    })
    child.stderr.setEncoding('utf8').on('data', (d: string) => { if (stderr.length < 200_000) stderr += d })
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.on('close', (code) => {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      if (opts.onLine && buf.trim()) opts.onLine(buf)
      resolve({ code, stdout, stderr, timedOut, aborted })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(opts.stdin ?? '')
  })
}

/** Finds an executable on PATH (or checks an absolute path). */
export function which (bin: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = bin.includes('/') ? [bin] : (env.PATH ?? '').split(delimiter).map(d => join(d, bin))
  for (const c of candidates) {
    try { accessSync(c, constants.X_OK); return c } catch {}
  }
  return null
}

// Variables a parent Claude Code session sets; a nested CLI would think it's a child session.
const PARENT_SESSION_VARS = [
  'CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_CHILD_NOTES_DIR', 'CLAUDE_CODE_SESSION_ATTENDED'
]

export interface EnvOptions {
  /** Remove these variables (e.g. API keys a subscription provider must not use). */
  drop?: string[]
  set?: Record<string, string>
}

export function childEnv (opts: EnvOptions = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const k of [...PARENT_SESSION_VARS, ...(opts.drop ?? [])]) delete env[k]
  Object.assign(env, opts.set ?? {})
  return env
}

/** An empty scratch directory used as the CLI's working dir, so it has no project files to read. */
export function scratchDir (prefix: string): { path: string, remove (): void } {
  const path = mkdtempSync(join(tmpdir(), `mc-buddy-${prefix}-`))
  return { path, remove: () => { try { rmSync(path, { recursive: true, force: true }) } catch {} } }
}

export function tail (s: string, n = 600): string {
  const t = s.trim()
  return t.length > n ? '...' + t.slice(-n) : t
}

// ---------------------------------------------------------------- isolated profiles
//
// CLI providers (claude, codex) run in a *profile*: a directory used as their HOME, holding
// their own login and nothing else. Your ~/.claude, ~/.codex, shell config and env vars
// (gateways, API keys, base URLs) never reach them. Profiles default to .auth/<provider>
// in the repo; log in once with `just llm-login <provider>`.
//
// profile values: undefined / '' -> .auth/<provider>; 'user' -> your normal login in your real
// home (settings/hooks/plugins/MCP servers are still ignored by the provider flags);
// anything else -> that directory.

/** Variables passed through to CLI children; everything else in our environment is dropped. */
const ENV_ALLOWLIST = [
  'PATH', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'TZ', 'TMPDIR',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'
]

export interface Profile {
  /** 'isolated' (own HOME) or 'user' (real home, real login). */
  kind: 'isolated' | 'user'
  /** Directory used as HOME for the child. */
  home: string
}

export function resolveProfile (provider: string, value?: string): Profile {
  if (value === 'user') return { kind: 'user', home: homedir() }
  const raw = value || join('.auth', provider)
  const home = resolve(raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw)
  return { kind: 'isolated', home }
}

export interface IsolatedEnvOptions {
  /** Extra variables to set (provider config dirs, MCP tokens...). */
  set?: Record<string, string>
  /** Variables from our own environment to pass through when set (explicit opt-ins like CLAUDE_CODE_OAUTH_TOKEN). */
  pass?: string[]
}

/**
 * A minimal environment for a CLI child: allowlisted basics, HOME/XDG dirs pointing into the
 * profile (isolated) or the real home (user), plus `set`. The directory running node is put
 * first on PATH so `#!/usr/bin/env node` CLIs find a real node, not a version-manager shim.
 */
export function isolatedEnv (profile: Profile, opts: IsolatedEnvOptions = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const k of [...ENV_ALLOWLIST, ...(opts.pass ?? [])]) if (process.env[k] !== undefined) env[k] = process.env[k]
  env.PATH = [dirname(process.execPath), env.PATH ?? ''].filter(Boolean).join(delimiter)
  env.HOME = profile.home
  if (profile.kind === 'isolated') {
    mkdirSync(profile.home, { recursive: true, mode: 0o700 })
    env.XDG_CONFIG_HOME = join(profile.home, '.config')
    env.XDG_DATA_HOME = join(profile.home, '.local', 'share')
    env.XDG_CACHE_HOME = join(profile.home, '.cache')
    env.XDG_STATE_HOME = join(profile.home, '.local', 'state')
  }
  Object.assign(env, opts.set ?? {})
  return env
}

/** Expands a leading "~/" to the home directory. */
export function expandHome (p: string): string {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
}

/**
 * Reads one variable from a dotenv-style file (KEY=VALUE, optional `export`, quotes, comments)
 * without loading anything else from it into our environment.
 */
export function readEnvFileVar (file: string, name: string): string | undefined {
  let text: string
  try { text = readFileSync(expandHome(file), 'utf8') } catch { return undefined }
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m || m[1] !== name) continue
    let v = m[2]!.trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    else v = v.replace(/\s+#.*$/, '')
    return v
  }
  return undefined
}

// ---------------------------------------------------------------- proxies (caveman, gateways)
//
// proxy: 'caveman'        -> the local caveman layer (http://127.0.0.1:8787), started if needed
// proxy: 'http://host:p'  -> any Anthropic/OpenAI-compatible gateway
// proxy: undefined/'none' -> direct
// Only the base URL goes to the child; the rest of the isolation stays as it is.

import { connect } from 'node:net'
import { existsSync, readdirSync } from 'node:fs'
import { spawn as spawnChild } from 'node:child_process'

export const CAVEMAN_URL = 'http://127.0.0.1:8787'

export interface ProxyInfo {
  /** Base URL for Anthropic-style and OpenAI-style clients. */
  baseUrl: string
  /** Codex (ChatGPT login) needs its own route on caveman. */
  codexBaseUrl: string
  kind: 'caveman' | 'custom'
}

function portOpen (host: string, port: number, ms = 800): Promise<boolean> {
  return new Promise(resolve => {
    const s = connect({ host, port })
    const done = (v: boolean) => { s.destroy(); resolve(v) }
    s.setTimeout(ms, () => done(false))
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
  })
}

/** Finds the caveman CLI: MC_CAVEMAN_BIN, then asdf node installs, then PATH. */
export function findCaveman (): string | null {
  if (process.env.MC_CAVEMAN_BIN) return process.env.MC_CAVEMAN_BIN
  const installs = join(homedir(), '.asdf', 'installs', 'nodejs')
  try {
    for (const v of readdirSync(installs).sort().reverse()) {
      const p = join(installs, v, 'bin', 'caveman')
      if (existsSync(p)) return p
    }
  } catch {}
  return which('caveman')
}

let starting: Promise<void> | null = null

/** Starts the caveman proxy (it keeps running in the background) and waits for its port. */
async function ensureCaveman (): Promise<void> {
  if (await portOpen('127.0.0.1', 8787)) return
  starting ??= (async () => {
    const bin = findCaveman()
    if (!bin) throw new Error('caveman not found (install it or set MC_CAVEMAN_BIN)')
    // `caveman run -- true` starts the proxy and leaves it running. It runs with the user's
    // own environment on purpose: it's their tool and keeps its state in ~/.caveman.
    const child = spawnChild(bin, ['run', '--', 'true'], {
      stdio: 'ignore',
      detached: true,
      env: { ...process.env, PATH: [dirname(bin), process.env.PATH ?? ''].join(delimiter) }
    })
    child.unref()
    for (let i = 0; i < 40; i++) {
      if (await portOpen('127.0.0.1', 8787)) return
      await new Promise(r => setTimeout(r, 250))
    }
    throw new Error('caveman proxy did not come up on 127.0.0.1:8787')
  })().finally(() => { starting = null })
  await starting
}

export async function resolveProxy (spec: string | undefined): Promise<ProxyInfo | null> {
  if (!spec || spec === 'none' || spec === 'off') return null
  if (spec === 'caveman') {
    await ensureCaveman()
    return { kind: 'caveman', baseUrl: CAVEMAN_URL, codexBaseUrl: `${CAVEMAN_URL}/chatgpt` }
  }
  if (!/^https?:\/\//.test(spec)) throw new Error(`proxy must be "caveman", "none" or an http(s) URL, got "${spec}"`)
  const url = spec.replace(/\/$/, '')
  return { kind: 'custom', baseUrl: url, codexBaseUrl: url }
}
