// Small leveled logger with a per-bot prefix and colour.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const
export type Level = keyof typeof LEVELS

const COLORS = [36, 33, 35, 32, 34, 91, 92, 93, 94, 95, 96]
const useColor = process.stdout.isTTY && !process.env.NO_COLOR
let globalLevel: Level = (process.env.MC_LOG_LEVEL as Level) || (process.env.MC_DEBUG === 'true' ? 'debug' : 'info')

export function setLogLevel (level: Level): void {
  globalLevel = level
}

export interface Logger {
  debug (msg: string): void
  info (msg: string): void
  warn (msg: string): void
  error (msg: string): void
  child (name: string): Logger
}

function colorFor (name: string): number {
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return COLORS[h % COLORS.length]!
}

export function createLogger (name: string): Logger {
  const tag = useColor ? `\x1b[${colorFor(name.split('/')[0]!)}m${name}\x1b[0m` : name
  const write = (level: Level, msg: string) => {
    if (LEVELS[level] < LEVELS[globalLevel]) return
    const time = new Date().toISOString().slice(11, 19)
    const lvl = level === 'info' ? '' : useColor ? ` \x1b[${level === 'error' ? 31 : level === 'warn' ? 33 : 90}m${level}\x1b[0m` : ` ${level}`
    const line = `${time} ${tag}${lvl} ${msg}`
    if (level === 'error' || level === 'warn') console.error(line)
    else console.log(line)
  }
  return {
    debug: m => write('debug', m),
    info: m => write('info', m),
    warn: m => write('warn', m),
    error: m => write('error', m),
    child: (sub) => createLogger(`${name}/${sub}`)
  }
}
