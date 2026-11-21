// Program versions on disk: data/bots/<username>/programs/vNNN.json, one file per accepted
// program with the instruction that produced it, who asked, a diff summary and the LLM usage.
// Version 0 is the bot definition's base program (never written; it lives in code). The
// active version is kept in agent.storage under `self.program`.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Storage } from '../../core/index.ts'
import type { Program } from './format.ts'

export interface ProgramUsage {
  calls: number
  inputTokens: number
  outputTokens: number
  costUsd?: number
}

export interface ProgramRecord {
  version: number
  at: string
  /** Owner instruction (or "experience: ..." for proposals the owner accepted). */
  instruction: string
  by: string
  diff: string
  /** Version this one was derived from. */
  parent: number
  usage?: ProgramUsage
  program: Program
}

const POINTER = 'self.program'

export class ProgramStore {
  readonly dir: string
  private readonly storage: Pick<Storage, 'get' | 'set'>

  constructor (dir: string, storage: Pick<Storage, 'get' | 'set'>) {
    this.dir = dir
    this.storage = storage
  }

  private file (v: number): string {
    return join(this.dir, `v${String(v).padStart(3, '0')}.json`)
  }

  /** Stored versions, oldest first (without base). */
  versions (): number[] {
    if (!existsSync(this.dir)) return []
    return readdirSync(this.dir)
      .map(f => /^v(\d+)\.json$/.exec(f)?.[1])
      .filter((v): v is string => !!v)
      .map(Number)
      .sort((a, b) => a - b)
  }

  load (v: number): ProgramRecord | undefined {
    try {
      return JSON.parse(readFileSync(this.file(v), 'utf8')) as ProgramRecord
    } catch {
      return undefined
    }
  }

  history (limit = 10): ProgramRecord[] {
    return this.versions().slice(-limit).map(v => this.load(v)).filter((r): r is ProgramRecord => !!r)
  }

  /** Active version number (0 = base). */
  get current (): number {
    return this.storage.get<number>(POINTER, 0)
  }

  activate (v: number): void {
    this.storage.set(POINTER, v)
  }

  /** Writes a new version and makes it active. */
  save (rec: Omit<ProgramRecord, 'version' | 'at'>): ProgramRecord {
    mkdirSync(this.dir, { recursive: true })
    const version = (this.versions().at(-1) ?? 0) + 1
    const full: ProgramRecord = { version, at: new Date().toISOString(), ...rec }
    const tmp = `${this.file(version)}.tmp`
    writeFileSync(tmp, JSON.stringify(full, null, 2) + '\n')
    renameSync(tmp, this.file(version))
    this.activate(version)
    return full
  }
}
