// Creative builds: `hand` (the default) builds like a player through the normal placement path,
// with a small delay per block; `commands` places with /fill and /setblock when the bot is op.
// The pure parts (method choice, block strings, door and bed halves, run merging) are exported
// for tests; buildWithCommands drives the commands method and reports what it found.
import type { Agent, Logger } from '../core/index.ts'
import { checkAborted, sleep } from '../core/index.ts'
import { blockNameFor, DIR_VEC, type BlockState, type Facing } from './blockstate.ts'

export type BuildMethod = 'auto' | 'hand' | 'commands'
export const BUILD_METHODS = ['auto', 'hand', 'commands'] as const

/** Default pause after each block in a creative hand build (ms), jittered ±50. */
export const HAND_DELAY_MS = 150

/** settings.build.creativeMethod and settings.build.handDelayMs, with defaults. */
export function creativeSettings (settings: Record<string, unknown>): { method: BuildMethod, handDelayMs: number } {
  const b = (settings.build ?? {}) as { creativeMethod?: unknown, handDelayMs?: unknown }
  const method = (BUILD_METHODS as readonly string[]).includes(String(b.creativeMethod)) ? b.creativeMethod as BuildMethod : 'auto'
  const d = Number(b.handDelayMs)
  return { method, handDelayMs: Number.isFinite(d) && d >= 0 ? Math.min(d, 5000) : HAND_DELAY_MS }
}

/**
 * How a build goes: survival is always by hand; in creative the action's `method` wins over the
 * setting, and auto means hand.
 */
export function chooseMethod (creative: boolean, requested: BuildMethod | undefined, setting: BuildMethod | undefined): 'hand' | 'commands' {
  if (!creative) return 'hand'
  const m = requested && requested !== 'auto' ? requested : setting ?? 'auto'
  return m === 'commands' ? 'commands' : 'hand'
}

/** `oak_stairs[facing=north,half=bottom]`; no brackets without properties. */
export function blockString (name: string, state?: Record<string, unknown>): string {
  const props = Object.entries(state ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== '')
  return props.length ? `${name}[${props.map(([k, v]) => `${k}=${v}`).join(',')}]` : name
}

export interface CommandBlock { x: number, y: number, z: number, block: string, late: boolean }

/**
 * The blocks one blueprint cell becomes: a facing torch is a wall torch, a door both halves
 * (lower here, upper above), a bed both parts (foot here, head one step along its facing).
 * `late` = attachments, doors and furniture, which go in after everything they hang on.
 */
export function cellBlocks (cell: { x: number, y: number, z: number, state?: BlockState }, item: string, kind: string): CommandBlock[] {
  const state = { ...(cell.state ?? {}) } as Record<string, unknown>
  const name = blockNameFor(item, cell.state)
  const late = kind === 'attachment' || kind === 'door' || kind === 'furnish' || /_bed$|_door$|torch$|ladder$|lantern$/.test(name)
  const at = { x: cell.x, y: cell.y, z: cell.z }
  if (/_door$/.test(name)) {
    return [
      { ...at, block: blockString(name, { ...state, half: 'lower' }), late: true },
      { ...at, y: at.y + 1, block: blockString(name, { ...state, half: 'upper' }), late: true }
    ]
  }
  if (/_bed$/.test(name)) {
    const v = DIR_VEC[(state.facing ?? 'north') as Facing]
    return [
      { ...at, block: blockString(name, { ...state, part: 'foot' }), late: true },
      { x: at.x + v.x, y: at.y, z: at.z + v.z, block: blockString(name, { ...state, part: 'head' }), late: true }
    ]
  }
  return [{ ...at, block: blockString(name, state), late }]
}

export interface FillBox { x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, block: string }

/** The vanilla /fill limit. */
export const FILL_MAX = 32768
const volume = (b: FillBox) => (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1) * (b.z1 - b.z0 + 1)

/**
 * Merges blocks into as few /fill boxes as it simply can: identical neighbours along x into
 * runs, equal runs on consecutive z into rectangles, equal rectangles on consecutive y into
 * boxes (never over the /fill limit). Boxes come out bottom-up. Pure.
 */
export function mergeRuns (blocks: { x: number, y: number, z: number, block: string }[]): FillBox[] {
  const seen = new Map<string, { x: number, y: number, z: number, block: string }>()
  for (const b of blocks) seen.set(`${b.x},${b.y},${b.z}`, b) // a later block for the same cell wins
  const rows = new Map<string, { x: number, block: string }[]>()
  for (const b of seen.values()) {
    const k = `${b.y},${b.z}`
    if (!rows.has(k)) rows.set(k, [])
    rows.get(k)!.push({ x: b.x, block: b.block })
  }
  const runs: FillBox[] = []
  for (const [k, list] of rows) {
    const [y, z] = k.split(',').map(Number) as [number, number]
    list.sort((a, b) => a.x - b.x)
    for (let i = 0; i < list.length;) {
      let j = i
      while (j + 1 < list.length && list[j + 1]!.x === list[j]!.x + 1 && list[j + 1]!.block === list[i]!.block) j++
      runs.push({ x0: list[i]!.x, x1: list[j]!.x, y0: y, y1: y, z0: z, z1: z, block: list[i]!.block })
      i = j + 1
    }
  }
  const grow = (boxes: FillBox[], axis: 'z' | 'y'): FillBox[] => {
    const other = axis === 'z' ? (b: FillBox) => `${b.y0},${b.y1}` : (b: FillBox) => `${b.z0},${b.z1}`
    const lo = axis === 'z' ? 'z0' : 'y0'
    const hi = axis === 'z' ? 'z1' : 'y1'
    const groups = new Map<string, FillBox[]>()
    for (const b of boxes) {
      const k = `${b.block}|${b.x0},${b.x1}|${other(b)}`
      if (!groups.has(k)) groups.set(k, [])
      groups.get(k)!.push(b)
    }
    const out: FillBox[] = []
    for (const g of groups.values()) {
      g.sort((a, b) => a[lo] - b[lo])
      let cur = { ...g[0]! }
      for (const b of g.slice(1)) {
        const next = { ...cur, [hi]: b[hi] }
        if (b[lo] === cur[hi] + 1 && volume(next) <= FILL_MAX) cur = next
        else { out.push(cur); cur = { ...b } }
      }
      out.push(cur)
    }
    return out
  }
  return grow(grow(runs, 'z'), 'y').sort((a, b) => a.y0 - b.y0 || a.z0 - b.z0 || a.x0 - b.x0)
}

export const fillCommand = (b: FillBox) => (b.x0 === b.x1 && b.y0 === b.y1 && b.z0 === b.z1
  ? `/setblock ${b.x0} ${b.y0} ${b.z0} ${b.block}`
  : `/fill ${b.x0} ${b.y0} ${b.z0} ${b.x1} ${b.y1} ${b.z1} ${b.block}`)

/** A reply that means the bot may not run the command (not op, or no such command for it). */
export function noCommandRights (lines: string[]): string | null {
  // the same wording the worldedit skill's reply parser recognises (worldedit.ts ERRORS)
  const no = lines.some(l => NO_RIGHTS.test(l.trim()))
  return no ? lines.map(l => l.trim()).filter(Boolean).join(' | ') : null
}
const NO_RIGHTS = /unknown (or incomplete )?command|command not found|(don'?t|do not) have permission|not permitted|no permission|insufficient permission|you are not allowed|lack(s)? the permission/i

/** Reply lines that say a /fill or /setblock didn't go in ("No blocks were filled" is fine: already right). */
const COMMAND_ERROR = /unknown or incomplete command|permission|too many blocks|not loaded|unknown block|invalid|incorrect argument|expected|<--\[here\]|cannot place/i

export interface CommandPlan {
  /** Air for the plan's air cells that hold something (never the rest of the box: a hut inside a fort stays). */
  clear: { x: number, y: number, z: number }[]
  /** Dips under the floor. */
  fills: { x: number, y: number, z: number }[]
  blocks: CommandBlock[]
}

/** The command list for a plan, in order: clear, dips, structure bottom-up, attachments last. Pure. */
export function planCommands (p: CommandPlan, fillBlock = 'cobblestone'): string[] {
  const air = mergeRuns(p.clear.map(c => ({ ...c, block: 'air' })))
  const dips = mergeRuns(p.fills.map(c => ({ ...c, block: fillBlock })))
  const main = mergeRuns(p.blocks.filter(b => !b.late))
  const late = mergeRuns(p.blocks.filter(b => b.late))
  return [...air, ...dips, ...main, ...late].map(fillCommand)
}

export interface CommandRun { ok: boolean, sent: number, errors: string[], noRights?: string }

/**
 * Sends the commands through the agent's rate-limited command queue. The first one waits for
 * the server's answer: "Unknown or incomplete command" or a permission message means no op
 * rights (noRights set, nothing else sent). Later replies are only scanned for errors.
 */
export async function runCommands (agent: Pick<Agent, 'command' | 'on'>, commands: string[], signal: AbortSignal, log: Logger, firstReplyMs = 3000): Promise<CommandRun> {
  const lines: string[] = []
  const off = agent.on('serverMessage', (t: string) => { lines.push(t) })
  const errors: string[] = []
  let sent = 0
  try {
    for (const [i, cmd] of commands.entries()) {
      checkAborted(signal)
      if (!await agent.command(cmd)) return { ok: false, sent, errors: [...errors, `couldn't send ${cmd}`] }
      sent++
      if (i === 0) {
        const until = Date.now() + firstReplyMs
        while (!lines.length && Date.now() < until) await sleep(50, signal)
        await sleep(200, signal) // the rest of a multi-line reply
        const no = noCommandRights(lines)
        if (no) return { ok: false, sent, errors, noRights: no }
      }
    }
    await sleep(1000, signal) // the last replies
  } finally {
    off()
  }
  for (const l of lines) if (COMMAND_ERROR.test(l) && errors.length < 5) errors.push(l.trim())
  log.info('build: commands sent', { sent, errors: errors.length, firstReply: lines[0]?.slice(0, 120) })
  return { ok: !errors.length, sent, errors }
}

/** The jittered pause after a creative hand placement. */
export function handPause (ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return sleep(Math.max(0, Math.round(ms + (Math.random() - 0.5) * 100)), signal)
}
