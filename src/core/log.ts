// Logging for agents, brains, skills and the fleet.
//
// - Hierarchical logger names: "<username>/<component>/...", e.g. "McBuddy/action/follow",
//   "McBuddy/chat", "McBuddy/neoforge", "fleet", "golemkit".
// - Level rules like RUST_LOG: "info,McBuddy=debug,*/neoforge=trace,*/chat=warn".
//   The most specific (longest) matching pattern wins; `*` matches anything, including "/".
// - Formats: pretty (coloured), plain, json (one object per line).
// - Sinks: console, a combined file, per-bot files (first name segment), size-based rotation.
// - A ring buffer of recent entries plus subscribe(), for UIs and debugging.
// - Secrets from the environment (*KEY, *TOKEN, *SECRET, *PASSWORD) are redacted.
//
// Configure with env (MC_LOG_*), a fleet file `logging:` block, CLI flags, or
// configureLogging() from code.
import { openSync, writeSync, closeSync, renameSync, statSync, mkdirSync, existsSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { loadDotEnvOnce } from './definition.ts'
import { setEnvWarner } from './env.ts'

export const LEVELS = { trace: 5, debug: 10, info: 20, warn: 30, error: 40, silent: 100 } as const
export type Level = keyof typeof LEVELS
export type LogFields = Record<string, unknown>

export interface LogEntry {
  /** epoch ms */
  ts: number
  level: Exclude<Level, 'silent'>
  logger: string
  msg: string
  fields?: LogFields
}

export interface LogConfig {
  /** Level spec, e.g. "info,McBuddy=debug,*\/neoforge=trace". */
  level: string
  format: 'pretty' | 'plain' | 'json'
  color: 'auto' | 'always' | 'never'
  /** Timestamp style on console/file lines (json always has epoch `ts` + ISO `time`). */
  time: 'time' | 'iso' | 'none'
  /** Combined log file (all loggers). */
  file: string | null
  /** Directory for per-bot files: <dir>/<first name segment>.log */
  dir: string | null
  /** Format used in files ("json" is handy for grep/jq; default plain). */
  fileFormat: 'plain' | 'json'
  /** Rotate a file when it exceeds this size. 0 disables rotation. */
  maxSizeMb: number
  /** Rotated files to keep (name.log.1 ... name.log.N). */
  maxFiles: number
  /** Entries kept in memory for recentLogs()/UIs. */
  bufferSize: number
  /** Extra literal strings to redact. */
  redact: string[]
}

export interface Logger {
  readonly name: string
  trace (msg: string, fields?: LogFields): void
  debug (msg: string, fields?: LogFields): void
  info (msg: string, fields?: LogFields): void
  warn (msg: string, fields?: LogFields): void
  error (msg: string, fields?: LogFields): void
  /** Sub-logger "<name>/<sub>"; inherits bound fields. */
  child (sub: string): Logger
  /** Same logger with extra fields bound to every entry. */
  with (fields: LogFields): Logger
  /** True if this level would be written (to skip building expensive messages). */
  enabled (level: Level): boolean
}

// ------------------------------------------------------------------ config

const DEFAULT_CONFIG: LogConfig = {
  level: 'info',
  format: 'pretty',
  color: 'auto',
  time: 'time',
  file: null,
  dir: null,
  fileFormat: 'plain',
  maxSizeMb: 20,
  maxFiles: 5,
  bufferSize: 1000,
  redact: []
}

// .env first: this module is evaluated before index.ts runs its own loadDotEnvOnce(), and the
// level, format and redacted secrets are read from the environment right here.
loadDotEnvOnce()
let config: LogConfig = { ...DEFAULT_CONFIG, ...loggingFromEnv() }
let rules = parseLevelSpec(config.level)
let generation = 0
let secrets = collectSecrets(config.redact)

/** Reads MC_LOG_* (and the legacy MC_DEBUG / NO_COLOR) from the environment. */
export function loggingFromEnv (env: NodeJS.ProcessEnv = process.env): Partial<LogConfig> {
  const out: Partial<LogConfig> = {}
  if (env.MC_LOG_LEVEL) out.level = env.MC_LOG_LEVEL
  else if (env.MC_DEBUG === 'true') out.level = 'debug'
  if (env.MC_LOG_FORMAT) out.format = env.MC_LOG_FORMAT as LogConfig['format']
  if (env.MC_LOG_COLOR) out.color = env.MC_LOG_COLOR as LogConfig['color']
  else if (env.NO_COLOR) out.color = 'never'
  if (env.MC_LOG_TIME) out.time = env.MC_LOG_TIME as LogConfig['time']
  if (env.MC_LOG_FILE) out.file = env.MC_LOG_FILE
  if (env.MC_LOG_DIR) out.dir = env.MC_LOG_DIR
  if (env.MC_LOG_FILE_FORMAT) out.fileFormat = env.MC_LOG_FILE_FORMAT as LogConfig['fileFormat']
  if (env.MC_LOG_MAX_SIZE_MB) out.maxSizeMb = Number(env.MC_LOG_MAX_SIZE_MB)
  if (env.MC_LOG_MAX_FILES) out.maxFiles = Number(env.MC_LOG_MAX_FILES)
  if (env.MC_LOG_BUFFER) out.bufferSize = Number(env.MC_LOG_BUFFER)
  return out
}

/** Applies config on top of the current one. Undefined fields are ignored. */
export function configureLogging (partial: Partial<LogConfig>): void {
  const clean = Object.fromEntries(Object.entries(partial).filter(([, v]) => v !== undefined)) as Partial<LogConfig>
  const filesChanged = clean.file !== undefined || clean.dir !== undefined
  config = { ...config, ...clean }
  rules = parseLevelSpec(config.level)
  secrets = collectSecrets(config.redact)
  generation++
  if (filesChanged) closeFiles()
  while (buffer.length > config.bufferSize) buffer.shift()
}

export function getLoggingConfig (): Readonly<LogConfig> {
  return config
}

/** Back-compat: sets the default level (keeps per-logger rules). */
export function setLogLevel (level: Level): void {
  const rest = config.level.split(',').filter(p => p.includes('='))
  configureLogging({ level: [level, ...rest].join(',') })
}

// ------------------------------------------------------------------ level rules

interface Rule { pattern: string, re: RegExp, level: Level }

export function parseLevelSpec (spec: string): { fallback: Level, rules: Rule[] } {
  let fallback: Level = 'info'
  const out: Rule[] = []
  for (const raw of spec.split(',').map(s => s.trim()).filter(Boolean)) {
    const eq = raw.lastIndexOf('=')
    if (eq === -1) {
      if (isLevel(raw)) fallback = raw
      continue
    }
    const pattern = raw.slice(0, eq).trim()
    const level = raw.slice(eq + 1).trim()
    if (!pattern || !isLevel(level)) continue
    const re = new RegExp('^' + pattern.split('*').map(escapeRe).join('.*') + '(/.*)?$')
    out.push({ pattern, re, level })
  }
  // Most specific first: longer literal pattern wins.
  out.sort((a, b) => b.pattern.replace(/\*/g, '').length - a.pattern.replace(/\*/g, '').length)
  return { fallback, rules: out }
}

/** Effective level for a logger name under a parsed spec. */
export function levelFor (name: string, parsed = rules): Level {
  for (const r of parsed.rules) if (r.re.test(name)) return r.level
  return parsed.fallback
}

function isLevel (s: string): s is Level {
  return s in LEVELS
}

function escapeRe (s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
}

// ------------------------------------------------------------------ buffer + subscribers

const buffer: LogEntry[] = []
const subscribers = new Set<(e: LogEntry) => void>()

/** Recent entries (oldest first), optionally filtered. */
export function recentLogs (filter?: { logger?: string, minLevel?: Level, limit?: number }): LogEntry[] {
  let out = buffer
  if (filter?.logger) {
    const prefix = filter.logger
    out = out.filter(e => e.logger === prefix || e.logger.startsWith(prefix + '/'))
  }
  if (filter?.minLevel) {
    const min = LEVELS[filter.minLevel]
    out = out.filter(e => LEVELS[e.level] >= min)
  }
  return filter?.limit ? out.slice(-filter.limit) : out.slice()
}

/** Receives every entry that passes level filtering. Returns an unsubscribe function. */
export function subscribeLogs (fn: (e: LogEntry) => void): () => void {
  subscribers.add(fn)
  return () => { subscribers.delete(fn) }
}

// ------------------------------------------------------------------ redaction

function collectSecrets (extra: string[]): string[] {
  const out = new Set(extra.filter(s => s.length >= 4))
  for (const [k, v] of Object.entries(process.env)) {
    if (v && v.length >= 8 && /(KEY|TOKEN|SECRET|PASSWORD)$/i.test(k)) out.add(v)
  }
  return [...out].sort((a, b) => b.length - a.length)
}

/** Replaces secrets from the environment (and configured extra strings) with ***. */
export function redactSecrets (s: string): string {
  return redact(s)
}

function redact (s: string): string {
  for (const secret of secrets) if (s.includes(secret)) s = s.split(secret).join('***')
  return s
}

// ------------------------------------------------------------------ formatting

const COLORS = [36, 33, 35, 32, 34, 91, 92, 93, 94, 95, 96]
const LEVEL_COLOR: Record<string, number> = { trace: 90, debug: 90, info: 0, warn: 33, error: 31 }

function useColor (): boolean {
  if (config.color === 'always') return true
  if (config.color === 'never') return false
  return !!process.stdout.isTTY
}

function colorFor (name: string): number {
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return COLORS[h % COLORS.length]!
}

function fmtTime (ts: number, style: LogConfig['time']): string {
  if (style === 'none') return ''
  const iso = new Date(ts).toISOString()
  return style === 'iso' ? iso : iso.slice(11, 19)
}

function fmtValue (v: unknown): string {
  if (typeof v === 'string') return /[\s="]/.test(v) ? JSON.stringify(v) : v
  if (v instanceof Error) return JSON.stringify(v.message)
  try { return JSON.stringify(v) ?? String(v) } catch { return String(v) }
}

function fmtFields (fields: LogFields | undefined): string {
  if (!fields) return ''
  const parts = Object.entries(fields).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${fmtValue(v)}`)
  return parts.length ? ' ' + parts.join(' ') : ''
}

function formatLine (e: LogEntry, format: 'pretty' | 'plain' | 'json', color: boolean): string {
  if (format === 'json') {
    const obj: Record<string, unknown> = { time: new Date(e.ts).toISOString(), ts: e.ts, level: e.level, logger: e.logger, msg: e.msg }
    if (e.fields) for (const [k, v] of Object.entries(e.fields)) if (!(k in obj)) obj[k] = v instanceof Error ? { message: v.message, stack: v.stack } : v
    return redact(safeStringify(obj))
  }
  const time = fmtTime(e.ts, config.time)
  const lvl = e.level === 'info' ? '' : e.level
  let line: string
  if (format === 'pretty' && color) {
    const seg = e.logger.split('/')
    const tag = `\x1b[${colorFor(seg[0]!)}m${seg[0]}\x1b[0m${seg.length > 1 ? `\x1b[90m/${seg.slice(1).join('/')}\x1b[0m` : ''}`
    const l = lvl ? ` \x1b[${LEVEL_COLOR[e.level]}m${lvl}\x1b[0m` : ''
    const f = e.fields ? `\x1b[90m${fmtFields(e.fields)}\x1b[0m` : ''
    line = `${time ? `\x1b[90m${time}\x1b[0m ` : ''}${tag}${l} ${e.msg}${f}`
  } else {
    line = `${time ? time + ' ' : ''}${e.logger}${lvl ? ' ' + lvl.toUpperCase() : ''} ${e.msg}${fmtFields(e.fields)}`
  }
  return redact(line)
}

function safeStringify (obj: unknown): string {
  const seen = new WeakSet()
  return JSON.stringify(obj, (_k, v) => {
    if (typeof v === 'bigint') return v.toString()
    if (v && typeof v === 'object') {
      if (seen.has(v)) return '[circular]'
      seen.add(v)
    }
    return v
  })
}

// ------------------------------------------------------------------ files

interface FileSink { path: string, fd: number, size: number }
const files = new Map<string, FileSink>()
const SYSTEM_LOGGERS = new Set(['golemkit', 'fleet'])

function fileFor (path: string): FileSink {
  let f = files.get(path)
  if (f) return f
  mkdirSync(dirname(path), { recursive: true })
  const fd = openSync(path, 'a')
  let size = 0
  try { size = statSync(path).size } catch {}
  f = { path, fd, size }
  files.set(path, f)
  return f
}

function writeFile (path: string, line: string): void {
  try {
    const f = fileFor(path)
    const data = line + '\n'
    writeSync(f.fd, data)
    f.size += Buffer.byteLength(data)
    if (config.maxSizeMb > 0 && f.size > config.maxSizeMb * 1024 * 1024) rotate(f)
  } catch (e) {
    process.stderr.write(`log: cannot write ${path}: ${(e as Error).message}\n`)
  }
}

function rotate (f: FileSink): void {
  closeSync(f.fd)
  files.delete(f.path)
  const keep = Math.max(1, config.maxFiles)
  const oldest = `${f.path}.${keep}`
  if (existsSync(oldest)) unlinkSync(oldest)
  for (let i = keep - 1; i >= 1; i--) {
    if (existsSync(`${f.path}.${i}`)) renameSync(`${f.path}.${i}`, `${f.path}.${i + 1}`)
  }
  renameSync(f.path, `${f.path}.1`)
}

function closeFiles (): void {
  for (const f of files.values()) { try { closeSync(f.fd) } catch {} }
  files.clear()
}

// ------------------------------------------------------------------ core write

function emit (e: LogEntry): void {
  buffer.push(e)
  if (buffer.length > config.bufferSize) buffer.shift()

  const consoleLine = formatLine(e, config.format, config.format === 'pretty' && useColor())
  if (LEVELS[e.level] >= LEVELS.warn) process.stderr.write(consoleLine + '\n')
  else process.stdout.write(consoleLine + '\n')

  if (config.file || config.dir) {
    const fileLine = formatLine(e, config.fileFormat, false)
    if (config.file) writeFile(config.file, fileLine)
    if (config.dir) {
      const first = e.logger.split('/')[0]!
      writeFile(join(config.dir, `${SYSTEM_LOGGERS.has(first) ? '_system' : sanitize(first)}.log`), fileLine)
    }
  }

  for (const s of subscribers) {
    try { s(e) } catch {}
  }
}

function sanitize (s: string): string {
  return s.replace(/[^\w.-]/g, '_')
}

export function createLogger (name: string, bound?: LogFields): Logger {
  let cachedGen = -1
  let cachedLevel: Level = 'info'
  const threshold = (): number => {
    if (cachedGen !== generation) { cachedLevel = levelFor(name); cachedGen = generation }
    return LEVELS[cachedLevel]
  }
  const write = (level: Exclude<Level, 'silent'>, msg: string, fields?: LogFields) => {
    if (LEVELS[level] < threshold()) return
    const merged = bound || fields ? { ...bound, ...fields } : undefined
    emit({ ts: Date.now(), level, logger: name, msg, ...(merged && Object.keys(merged).length ? { fields: merged } : {}) })
  }
  return {
    name,
    trace: (m, f) => write('trace', m, f),
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
    child: (sub) => createLogger(`${name}/${sub}`, bound),
    with: (fields) => createLogger(name, { ...bound, ...fields }),
    enabled: (level) => LEVELS[level] >= threshold()
  }
}

/** Logs uncaught exceptions and unhandled rejections instead of dying silently. */
export function installCrashHandlers (log: Logger = createLogger('golemkit')): void {
  process.on('uncaughtException', (e) => {
    log.error(`uncaught exception: ${e.stack ?? e}`)
    closeFiles()
    process.exit(1)
  })
  process.on('unhandledRejection', (e) => {
    log.error(`unhandled rejection: ${e instanceof Error ? e.stack : String(e)}`)
  })
  process.on('exit', closeFiles)
}

// deprecated env names (core/env.ts) warn through the logger
setEnvWarner(m => createLogger('golemkit/env').warn(m))
