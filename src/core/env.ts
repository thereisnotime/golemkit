// Renamed environment variables: the current name, and the old one still read (with a warning,
// once per process). Only names are ever logged, never values (some hold tokens or token paths).
// No imports: definition.ts uses this and log.ts imports definition.ts, so log.ts plugs its
// logger in with setEnvWarner instead.

/** Current name -> old name. */
export const DEPRECATED_ENV: Readonly<Record<string, string>> = {
  MC_CLAUDE_OAUTH_TOKEN_VAR: 'MC_OAUTH_TOKEN_VAR',
  MC_CLAUDE_OAUTH_TOKEN_FILE: 'MC_OAUTH_TOKEN_FILE',
  MC_CLAUDE_LOGIN: 'MC_CLAUDE_PROFILE',
  MC_CODEX_LOGIN: 'MC_CODEX_PROFILE',
  MC_OPENCODE_LOGIN: 'MC_OPENCODE_PROFILE'
}

const warned = new Set<string>()
let warner: (msg: string) => void = m => console.warn(m)

/** Where deprecation warnings go (log.ts sets its logger). */
export function setEnvWarner (fn: (msg: string) => void): void { warner = fn }

/** For tests: forget which old names were already warned about. */
export function resetEnvWarnings (): void { warned.clear() }

/**
 * The variable's value, or its old name's (warning once that the old name is deprecated).
 * Empty counts as unset, like everywhere else in the env handling.
 */
export function envValue (name: string, env: NodeJS.ProcessEnv = process.env, warn: (msg: string) => void = warner): string | undefined {
  if (env[name]) return env[name]
  const old = DEPRECATED_ENV[name]
  if (!old || !env[old]) return undefined
  if (!warned.has(old)) {
    warned.add(old)
    warn(`${old} is deprecated, use ${name} (the old name still works for now)`)
  }
  return env[old]
}
