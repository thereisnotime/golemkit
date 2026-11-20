// Helpers for CLI providers: run a child non-interactively with a timeout, kill its whole
// process group on timeout/abort, stream stdout lines, and build a clean environment.
import { spawn } from 'node:child_process'
import { accessSync, constants, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

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
