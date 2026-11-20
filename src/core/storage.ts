// Per-bot persistent key/value storage (JSON file under data/bots/<name>/).
// Good for memories, home locations, NPC state. Writes are debounced.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'

export class Storage {
  readonly file: string
  private data: Record<string, unknown> = {}
  private timer: NodeJS.Timeout | null = null

  constructor (dir: string, name = 'store') {
    this.file = join(dir, `${name}.json`)
    try {
      this.data = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {}
  }

  get<T = unknown> (key: string): T | undefined
  get<T> (key: string, fallback: T): T
  get<T> (key: string, fallback?: T): T | undefined {
    return (key in this.data ? this.data[key] : fallback) as T | undefined
  }

  set (key: string, value: unknown): void {
    this.data[key] = value
    this.schedule()
  }

  delete (key: string): void {
    delete this.data[key]
    this.schedule()
  }

  keys (): string[] {
    return Object.keys(this.data)
  }

  /** Writes immediately (also called on shutdown). */
  flush (): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n')
    renameSync(tmp, this.file)
  }

  private schedule (): void {
    if (this.timer) return
    this.timer = setTimeout(() => this.flush(), 1000)
    this.timer.unref()
  }
}
