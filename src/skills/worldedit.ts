// WorldEdit (the NeoForge/Fabric mod, the Bukkit plugin, or FAWE) driven through chat
// commands, for servers where it runs and the bot has permission. Three steps per action:
//
//   detect   settings (worldedit.enabled) > announced channels / registry namespaces > a
//            `/we version` probe whose reply is read from chat; cached per session
//   command  checked first (owner, block limit worldedit.maxBlocks, protected areas, whitelist
//            for we_raw), then sent with agent.command (rate limited like chat, logged)
//   reply    the server messages that follow are collected for a moment and parsed
//            (blocks affected, no permission, unknown command, region too big...), so the
//            result is the server's answer, not a guess
//
// A client can't upload files, so library blueprints are built with WorldEdit only when the
// server already has a schematic of that name (we_build); otherwise the normal build runs.
import type { Bot } from 'mineflayer'
import type { ActionContext, ActionResult, Agent } from '../core/index.ts'
import { defineSkill, defineAction, z, ok, fail, sleep, checkAborted, fmtPos, goals, goto } from '../core/index.ts'
import { serverSignals } from './mods.ts'
import { buildStructure, SPAWN_KEEP_OUT } from './construction.ts'
import { libraryDirs, loadLibrary } from './blueprint-library.ts'
import { FACINGS, type Facing } from './blueprint.ts'

// ------------------------------------------------------------------ settings

export interface WeSettings {
  /** true/false: forced on/off (no detection); undefined: detect. */
  enabled?: boolean
  /** Largest region volume a world-changing action may touch. */
  maxBlocks: number
  /** Only owners may use the actions (default true). */
  ownersOnly: boolean
  /** How long to wait for WorldEdit's reply (ms). */
  replyMs: number
}

export const DEFAULT_MAX_BLOCKS = 50_000

export function weSettings (settings: Record<string, unknown>): WeSettings {
  const raw = settings.worldedit
  const w = (typeof raw === 'boolean' ? { enabled: raw } : raw && typeof raw === 'object' ? raw : {}) as Partial<WeSettings>
  const out: WeSettings = {
    maxBlocks: Number.isFinite(Number(w.maxBlocks)) && Number(w.maxBlocks) > 0 ? Number(w.maxBlocks) : DEFAULT_MAX_BLOCKS,
    ownersOnly: w.ownersOnly !== false,
    replyMs: Number(w.replyMs ?? 3000)
  }
  if (typeof w.enabled === 'boolean') out.enabled = w.enabled
  return out
}

// ------------------------------------------------------------------ reply parsing

export type WeReplyKind =
  | 'ok' | 'silent' | 'permission' | 'unknown_command' | 'too_big' | 'no_selection' | 'empty_clipboard'
  | 'bad_pattern' | 'not_found' | 'exists' | 'nothing' | 'usage' | 'error'

export interface WeReply {
  kind: WeReplyKind
  ok: boolean
  /** Blocks affected / changed / copied, when the reply says. */
  blocks?: number
  /** Region or clipboard size (x, y, z) from //size. */
  size?: [number, number, number]
  /** "# of blocks" from //size (volume, air included). */
  volume?: number
  /** Clipboard offset from //size -c. */
  offset?: [number, number, number]
  /** Position from "First/Second position set to (x, y, z)". */
  pos?: { x: number, y: number, z: number }
  /** Schematic files named in the reply (//schem list). */
  files?: string[]
  /** "WorldEdit 7.3.6" / "FastAsyncWorldEdit 2.12.0". */
  version?: string
  /** Total pages of a paged list, when shown. */
  pages?: number
  /** The reply lines joined, for the result message. */
  text: string
}

const ERRORS: [WeReplyKind, RegExp][] = [
  ['permission', /(don'?t|do not) have permission|not permitted|no permission|insufficient permission|you are not allowed|lack(s)? the permission/i],
  ['unknown_command', /unknown (or incomplete )?command|unknown command|command not found/i],
  ['too_big', /max(imum)? (number of )?(blocks|changes)|too (large|big|many blocks)|exceeds? (the )?(block )?limit|selection is too large|limit (of \d+ )?(was )?reached|reached (the|your) (block )?limit/i],
  ['no_selection', /make a region selection first|no (region )?selection|incomplete region|selection (is )?incomplete|region is not fully defined/i],
  ['empty_clipboard', /clipboard is empty|no clipboard/i],
  ['bad_pattern', /does not match a valid block|not a valid (block|pattern|mask)|unknown block|invalid (block|pattern|mask)|no block (type )?(by|with|named)/i],
  ['exists', /already exists/i],
  ['not_found', /does not exist|doesn'?t exist|not found|could not (find|read|load)|no such (file|schematic)|file .* not exist/i],
  ['nothing', /nothing (left )?to (undo|redo)/i],
  ['usage', /^usage:|incorrect argument|invalid command syntax|expected (an? )?(integer|number|argument)|too many arguments|<--\[here\]/i],
  ['error', /an error occurred|internal error|^error[: ]|failed to /i]
]

const num = (s: string) => Number(s.replace(/[,_\s]/g, ''))

/** Turns the lines WorldEdit sent back into a truthful result. No lines: 'silent'. */
export function parseWeReply (lines: string[]): WeReply {
  const text = lines.map(l => l.trim()).filter(Boolean).join(' | ')
  if (!text) return { kind: 'silent', ok: false, text: '' }
  const out: WeReply = { kind: 'ok', ok: true, text }
  for (const [kind, re] of ERRORS) {
    if (lines.some(l => re.test(l.trim()))) { out.kind = kind; out.ok = false; break }
  }
  const m1 = /\((\d[\d,]*) blocks? (?:were |was )?(?:affected|changed)\)/i.exec(text) ??
    /(\d[\d,]*) blocks?(?:\(s\))? (?:have been|has been|were|was|got) (?:changed|replaced|copied|cut|affected|pasted|set|moved|stacked)/i.exec(text) ??
    /(?:changed|affected|replaced|copied|cut) (\d[\d,]*) blocks?/i.exec(text)
  if (m1) out.blocks = num(m1[1]!)
  const sz = /size:\s*\(?\s*(-?\d+)\s*[, ]\s*(-?\d+)\s*[, ]\s*(-?\d+)\s*\)?/i.exec(text)
  if (sz) out.size = [num(sz[1]!), num(sz[2]!), num(sz[3]!)]
  const vol = /# of blocks:\s*([\d,]+)/i.exec(text)
  if (vol) out.volume = num(vol[1]!)
  const off = /offset:\s*\(?\s*(-?\d+)\s*[, ]\s*(-?\d+)\s*[, ]\s*(-?\d+)\s*\)?/i.exec(text)
  if (off) out.offset = [num(off[1]!), num(off[2]!), num(off[3]!)]
  const pos = /(?:first|second) position set to \(?\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)?/i.exec(text)
  if (pos) out.pos = { x: Math.floor(num(pos[1]!)), y: Math.floor(num(pos[2]!)), z: Math.floor(num(pos[3]!)) }
  const ver = /\b(FastAsyncWorldEdit|WorldEdit)(?:\s+version)?\s+v?(\d[\w.+-]*)/i.exec(text)
  if (ver) out.version = `${ver[1]} ${ver[2]}`
  else if (/\b(FastAsyncWorldEdit|WorldEdit) version/i.test(text)) {
    // "WorldEdit version (unknown)" on mod builds; the platform line has it: "* Forge-Official(7.3.8+6939-...)"
    const plat = /^\*?\s*[\w-]+\((\d[\w.+-]*)\)/m.exec(lines.join('\n'))
    out.version = `${/FastAsyncWorldEdit/i.test(text) ? 'FastAsyncWorldEdit' : 'WorldEdit'} ${plat ? plat[1] : '(version unknown)'}`
  }
  const files = new Set<string>()
  for (const l of lines) for (const f of l.matchAll(/([\w][\w.\- ]*?)\.(schem|schematic|litematic|nbt)\b/gi)) files.add(`${f[1]!.trim().replace(/^.*[\s:)\]-]\s*/, '')}.${f[2]!.toLowerCase()}`)
  if (files.size) out.files = [...files]
  const page = /(?:page\s*)?\[?\s*(\d+)\s*(?:\/|of)\s*(\d+)\s*\]?/i.exec(lines.find(l => /page|\[\d+\s*\/\s*\d+\]/i.test(l)) ?? '')
  if (page) out.pages = num(page[2]!)
  return out
}

/** One line for a failed reply, worded for the player and the LLM. */
export function explainReply (r: WeReply, what: string): string {
  const said = r.text ? ` (WorldEdit said: ${r.text.slice(0, 200)})` : ''
  switch (r.kind) {
    case 'silent': return `${what}: no reply from WorldEdit; it may not be installed or I may lack permission`
    case 'permission': return `${what}: I don't have permission for that on this server${said}`
    case 'unknown_command': return `${what}: the server doesn't know that command; WorldEdit isn't installed or I lack permission${said}`
    case 'too_big': return `${what}: the region is over the server's WorldEdit limit${said}`
    case 'no_selection': return `${what}: no region selected; use we_select first${said}`
    case 'empty_clipboard': return `${what}: the clipboard is empty; we_copy or we_schem_load first${said}`
    case 'bad_pattern': return `${what}: WorldEdit doesn't know that block or pattern${said}`
    case 'not_found': return `${what}: not found${said}`
    case 'exists': return `${what}: it already exists (overwrite=true replaces it)${said}`
    case 'nothing': return `${what}: nothing to do${said}`
    case 'usage': return `${what}: WorldEdit rejected the arguments${said}`
    default: return `${what}: failed${said}`
  }
}

// ------------------------------------------------------------------ detection

export interface WeDetection {
  /** true: available, false: not, null: unknown (no probe yet). */
  available: boolean | null
  how: string
  version?: string
}

const WE_NAMESPACES = ['worldedit', 'fawe', 'fastasyncworldedit']

/** What settings and the server's announced channels and registries say, without asking it. */
export function detectFromSignals (s: { forced?: boolean, channels: string[], namespaces: string[] }): WeDetection {
  if (s.forced === true) return { available: true, how: 'forced on in settings (worldedit.enabled)' }
  if (s.forced === false) return { available: false, how: 'turned off in settings (worldedit.enabled=false)' }
  const ch = s.channels.find(c => WE_NAMESPACES.includes(c.split(':')[0]!.toLowerCase()))
  if (ch) return { available: true, how: `the server announces the ${ch} channel` }
  const ns = s.namespaces.find(n => WE_NAMESPACES.includes(n.toLowerCase()))
  if (ns) return { available: true, how: `the server's registries have ${ns} entries` }
  return { available: null, how: `no WorldEdit channels or registry entries${s.channels.length ? ` among ${s.channels.length} channels` : ''}` }
}

/**
 * Installed is not the same as usable: `/we version` answers everyone, the editing commands only
 * players with permission (vanilla command trees hide the rest as "unknown command"). `//size`
 * with no selection is the harmless check: "Make a region selection first" means allowed.
 */
export function detectPermission (d: WeDetection, r: WeReply): WeDetection {
  if (!d.available) return d
  if (r.kind === 'unknown_command' || r.kind === 'permission') return { ...d, available: false, how: `${d.how}, but I have no permission for its commands (//size: ${r.kind === 'permission' ? 'no permission' : 'unknown command'})` }
  if (r.kind === 'silent') return { ...d, available: false, how: `${d.how}, but //size got no reply` }
  return d
}

/** The answer to the `/we version` probe. */
export function detectFromProbe (r: WeReply, before: string): WeDetection {
  if (r.version) return { available: true, how: `${before}; /we version answered ${r.version}`, version: r.version }
  if (r.kind === 'permission') return { available: false, how: `${before}; /we version: no permission (WorldEdit may be there, but not for me)` }
  if (r.kind === 'unknown_command') return { available: false, how: `${before}; /we version: unknown command` }
  if (r.kind === 'silent') return { available: false, how: `${before}; /we version: no reply` }
  if (/worldedit/i.test(r.text)) return { available: true, how: `${before}; /we version mentions WorldEdit` }
  return { available: false, how: `${before}; /we version answered something else: ${r.text.slice(0, 120)}` }
}

// ------------------------------------------------------------------ per-session state

interface Selection { pos1?: Vec, pos2?: Vec }
interface Vec { x: number, y: number, z: number }
interface WeState {
  detection?: WeDetection
  sel: Selection
  /** What's in the clipboard as far as we know: size and where it came from. */
  clipboard?: { size?: [number, number, number], volume?: number, offset?: [number, number, number], from: string }
  /** Channels the server registered with minecraft:register (Bukkit plugins). */
  registered: Set<string>
}

const states = new WeakMap<object, WeState>()
function state (bot: object): WeState {
  let s = states.get(bot)
  if (!s) { s = { sel: {}, registered: new Set() }; states.set(bot, s) }
  return s
}

/** Volume of a box given by two corners (inclusive). */
export const boxVolume = (a: Vec, b: Vec) => (Math.abs(a.x - b.x) + 1) * (Math.abs(a.y - b.y) + 1) * (Math.abs(a.z - b.z) + 1)

// ------------------------------------------------------------------ safety

/** Characters a block pattern, mask or schematic argument may use: no spaces, slashes or quotes. */
const PATTERN = /^[a-z0-9_:%,.[\]=#*!^&|~-]{1,120}$/i
export const validPattern = (p: string) => PATTERN.test(p) && !p.includes('..')
const SCHEM_NAME = /^[A-Za-z0-9_\-]{1,64}(\.(schem|schematic))?$/
export const validSchemName = (n: string) => SCHEM_NAME.test(n)

/**
 * we_raw whitelist: command (without slashes) -> 'info' (doesn't change the world), 'region'
 * (changes at most the selection), 'stack' (selection times the count). Anything else is refused.
 */
export const RAW_WHITELIST: Record<string, 'info' | 'region' | 'stack'> = {
  size: 'info', count: 'info', distr: 'info', sel: 'info', desel: 'info', pos1: 'info', pos2: 'info', hpos1: 'info', hpos2: 'info',
  expand: 'info', contract: 'info', shift: 'info', outset: 'info', inset: 'info', chunk: 'info', clearclipboard: 'info',
  set: 'region', replace: 'region', walls: 'region', faces: 'region', outline: 'region', hollow: 'region', overlay: 'region', naturalize: 'region',
  smooth: 'region', center: 'region', centre: 'region', line: 'region', move: 'region',
  stack: 'stack'
}

const RAW_ARGS = /^[a-z0-9_:%,.[\]=#*!^&|~ -]{0,120}$/i

export interface RawCheck { ok: boolean, why?: string, command?: string, kind?: 'info' | 'region' | 'stack', count?: number }

/** Checks a we_raw command against the whitelist; returns the normalised `//command args`. */
export function checkRaw (input: string): RawCheck {
  const t = input.trim().replace(/^\/{1,2}/, '')
  const [name0, ...rest] = t.split(/\s+/)
  const name = (name0 ?? '').toLowerCase()
  const kind = RAW_WHITELIST[name]
  if (!kind) return { ok: false, why: `//${name} isn't on the whitelist (${Object.keys(RAW_WHITELIST).join(', ')}); use the we_ actions for the rest` }
  const args = rest.join(' ')
  if (!RAW_ARGS.test(args) || args.includes('..')) return { ok: false, why: 'arguments may only use letters, digits, spaces and , . : % # [ ] = - _ ! ^ & | ~ *' }
  let count = 1
  if (kind === 'stack') {
    const n = rest.find(a => /^\d+$/.test(a))
    count = n ? Number(n) : 1
  }
  return { ok: true, command: `//${name}${args ? ` ${args}` : ''}`, kind, count }
}

type Ctx = Pick<ActionContext, 'agent' | 'bot' | 'caller' | 'player' | 'signal' | 'log'>

function isOwnerCall (ctx: Pick<ActionContext, 'agent' | 'caller' | 'player'>): boolean {
  if (ctx.caller.kind === 'player' && !ctx.agent.isOwner(ctx.caller.name)) return false
  if (ctx.player && !ctx.agent.isOwner(ctx.player)) return false
  return true
}

function denied (ctx: Ctx): string | null {
  if (!weSettings(ctx.agent.settings).ownersOnly) return null
  return isOwnerCall(ctx) ? null : `only my owners can use WorldEdit through me${ctx.player ? ` (asked for ${ctx.player})` : ''}`
}

/** A box overlaps a learned protected area or the spawn keep-out square: which one, or null. */
export function protectedOverlap (box: { min: Vec, max: Vec }, zones: Vec[], spawn: Vec | null | undefined, keepOut: number, zoneRadius = 20): string | null {
  for (const z of zones) {
    if (box.max.x >= z.x - zoneRadius && box.min.x <= z.x + zoneRadius && box.max.z >= z.z - zoneRadius && box.min.z <= z.z + zoneRadius && box.max.y >= z.y - zoneRadius * 2 && box.min.y <= z.y + zoneRadius * 2) return `the protected area around ${fmtPos(z)}`
  }
  if (spawn && box.max.x >= spawn.x - keepOut && box.min.x <= spawn.x + keepOut && box.max.z >= spawn.z - keepOut && box.min.z <= spawn.z + keepOut) return `the spawn area (within ${keepOut} blocks of ${fmtPos(spawn)})`
  return null
}

function protectedCheck (ctx: Ctx, box: { min: Vec, max: Vec }, allow: boolean): string | null {
  const keepOut = Number((ctx.agent.settings.build as { spawnKeepOut?: number } | undefined)?.spawnKeepOut ?? SPAWN_KEEP_OUT)
  const hit = protectedOverlap(box, ctx.agent.protectedAreas.zones, ctx.bot?.spawnPoint, keepOut)
  if (!hit) return null
  if (allow && isOwnerCall(ctx)) { ctx.log.info('worldedit inside a protected area, an owner allowed it', { area: hit }); return null }
  return `that region touches ${hit}; I don't use WorldEdit there unless an owner asks with protected_ok=true`
}

const selBox = (s: Selection) => (s.pos1 && s.pos2 ? { min: { x: Math.min(s.pos1.x, s.pos2.x), y: Math.min(s.pos1.y, s.pos2.y), z: Math.min(s.pos1.z, s.pos2.z) }, max: { x: Math.max(s.pos1.x, s.pos2.x), y: Math.max(s.pos1.y, s.pos2.y), z: Math.max(s.pos1.z, s.pos2.z) } } : null)

/** The selection this session set, its volume, and the limit/protection checks for changing it. */
function checkRegion (ctx: Ctx, what: string, factor = 1, allowProtected = false): { box: { min: Vec, max: Vec }, volume: number } | string {
  const st = state(ctx.bot)
  const box = selBox(st.sel)
  if (!box) return `${what}: select a region with we_select first (I only change regions I selected, so I know how big they are)`
  const volume = boxVolume(box.min, box.max) * factor
  const max = weSettings(ctx.agent.settings).maxBlocks
  if (volume > max) return `${what}: ${volume} blocks is over my WorldEdit limit of ${max} (worldedit.maxBlocks)`
  const p = protectedCheck(ctx, box, allowProtected)
  if (p) return `${what}: ${p}`
  return { box, volume }
}

// ------------------------------------------------------------------ sending

const QUIET_MS = 600

/**
 * Sends one WorldEdit command through the agent's rate-limited command path and collects the
 * server messages that arrive after it went out, until they stop (or replyMs passes).
 */
export async function weRun (ctx: Pick<Ctx, 'agent' | 'signal' | 'log'>, cmd: string, opts: { replyMs?: number, quietMs?: number } = {}): Promise<WeReply> {
  const { agent, signal } = ctx
  const lines: string[] = []
  let sentAt = 0
  let last = 0
  const off = agent.on('serverMessage', (t: string) => { if (sentAt) { lines.push(t); last = Date.now() } })
  try {
    const sent = await agent.command(cmd)
    if (!sent) return { kind: 'error', ok: false, text: `couldn't send ${cmd} (not connected or the chat queue is full)` }
    sentAt = Date.now()
    const replyMs = opts.replyMs ?? weSettings(agent.settings).replyMs
    const quiet = opts.quietMs ?? QUIET_MS
    for (;;) {
      checkAborted(signal)
      const now = Date.now()
      if (lines.length && now - last >= quiet) break
      if (now - sentAt >= replyMs) break
      await sleep(50, signal)
    }
  } finally {
    off()
  }
  const r = parseWeReply(lines)
  ctx.log.info('worldedit', { command: cmd, kind: r.kind, reply: r.text.slice(0, 300) })
  return r
}

/** Detection with the probe as the last step; cached for the session (refresh=true asks again). */
export async function detect (ctx: Pick<Ctx, 'agent' | 'bot' | 'signal' | 'log'>, opts: { probe?: boolean, refresh?: boolean } = {}): Promise<WeDetection> {
  const st = state(ctx.bot)
  const forced = weSettings(ctx.agent.settings).enabled
  if (forced !== undefined) return detectFromSignals({ forced, channels: [], namespaces: [] })
  if (st.detection && !opts.refresh && st.detection.available !== null) return st.detection
  const sig = serverSignals(ctx.agent)
  const d = detectFromSignals({ channels: [...sig.channels, ...st.registered], namespaces: sig.namespaces })
  if (d.available === false || opts.probe === false) { st.detection = d; return d }
  if (d.available) { st.detection = detectPermission(d, await weRun(ctx, '//size', { replyMs: 3000 })); return st.detection }
  const r = await weRun(ctx, '/we version', { replyMs: 3000 })
  let found = detectFromProbe(r, d.how)
  if (found.available) found = detectPermission(found, await weRun(ctx, '//size', { replyMs: 3000 }))
  st.detection = found
  return st.detection
}

async function requireWe (ctx: Ctx): Promise<string | null> {
  const no = denied(ctx)
  if (no) return no
  if (!ctx.bot?.entity) return 'not in the world right now'
  const d = await detect(ctx)
  return d.available ? null : `WorldEdit is not available here: ${d.how}`
}

/** Runs a command and turns the reply into a result; `done` words the success. */
async function runAndReport (ctx: Ctx, cmd: string, what: string, done: (r: WeReply) => string, extra?: Record<string, unknown>): Promise<ActionResult> {
  const r = await weRun(ctx, cmd)
  if (!r.ok) return fail(explainReply(r, what), { command: cmd, reply: r.text, kind: r.kind })
  return ok(done(r), { command: cmd, reply: r.text, blocks: r.blocks, ...extra })
}

const fmtVec = (v: Vec) => `${v.x},${v.y},${v.z}`
const blocksNote = (r: WeReply, fallback: string) => (r.blocks !== undefined ? `${r.blocks} blocks` : fallback)

// ------------------------------------------------------------------ actions

const regionOpts = {
  protected_ok: z.boolean().default(false).describe('owners only: allow it inside a protected area or the spawn area, when the owner explicitly asked for that spot')
}

const weStatus = defineAction({
  name: 'we_status',
  description: 'Is WorldEdit available on this server for me? Checks settings, the channels and registries the server announced, and if those say nothing asks the server with /we version. Also shows my selection, clipboard and limit.',
  params: z.object({ refresh: z.boolean().default(false).describe('ask the server again instead of the cached answer') }),
  exclusive: false,
  async run (ctx, { refresh }) {
    if (!ctx.bot?.entity) return fail('not in the world right now')
    const d = await detect(ctx, { refresh })
    const st = state(ctx.bot)
    const s = weSettings(ctx.agent.settings)
    const box = selBox(st.sel)
    const sel = box ? `selection ${fmtPos(box.min)} to ${fmtPos(box.max)} (${boxVolume(box.min, box.max)} blocks)` : 'no selection'
    const clip = st.clipboard ? `clipboard from ${st.clipboard.from}${st.clipboard.volume ? ` (${st.clipboard.volume} blocks)` : ''}` : 'clipboard unknown'
    const msg = `WorldEdit ${d.available ? 'available' : 'not available'}: ${d.how}${d.version && !d.how.includes(d.version) ? ` (${d.version})` : ''}. ${sel}; ${clip}; limit ${s.maxBlocks} blocks${s.ownersOnly ? ', owners only' : ''}`
    return d.available ? ok(msg, { ...d, maxBlocks: s.maxBlocks }) : fail(msg, { ...d })
  }
})

const weSelect = defineAction({
  name: 'we_select',
  description: 'Select a WorldEdit region (//pos1 and //pos2): two corners x1 y1 z1 x2 y2 z2, or a box around the asking player (or me): radius around them, height up from their feet. Owners only.',
  params: z.object({
    x1: z.number().optional(), y1: z.number().optional(), z1: z.number().optional(),
    x2: z.number().optional(), y2: z.number().optional(), z2: z.number().optional(),
    radius: z.number().int().min(0).max(64).default(3).describe('around the player: blocks out from them on each side'),
    height: z.number().int().min(1).max(64).default(4).describe('around the player: from their feet up'),
    down: z.number().int().min(0).max(64).default(0).describe('around the player: blocks below their feet to include')
  }),
  exclusive: false,
  async run (ctx, p) {
    const no = await requireWe(ctx)
    if (no) return fail(no)
    const corners = [p.x1, p.y1, p.z1, p.x2, p.y2, p.z2]
    let a: Vec
    let b: Vec
    if (corners.every(v => v !== undefined)) {
      const c = corners.map(v => Math.floor(v!)) as [number, number, number, number, number, number]
      a = { x: c[0], y: c[1], z: c[2] }
      b = { x: c[3], y: c[4], z: c[5] }
    } else if (corners.some(v => v !== undefined)) {
      return fail('give all six corners (x1 y1 z1 x2 y2 z2), or none for a box around the player')
    } else {
      const who = (ctx.player && ctx.bot.players[ctx.player]?.entity?.position) || ctx.bot.entity.position
      const c = { x: Math.floor(who.x), y: Math.floor(who.y), z: Math.floor(who.z) }
      a = { x: c.x - p.radius, y: c.y - p.down, z: c.z - p.radius }
      b = { x: c.x + p.radius, y: c.y + p.height - 1, z: c.z + p.radius }
    }
    const st = state(ctx.bot)
    const r1 = await weRun(ctx, `//pos1 ${fmtVec(a)}`)
    if (!r1.ok) return fail(explainReply(r1, 'pos1'))
    const r2 = await weRun(ctx, `//pos2 ${fmtVec(b)}`)
    if (!r2.ok) return fail(explainReply(r2, 'pos2'))
    st.sel = { pos1: r1.pos ?? a, pos2: r2.pos ?? b }
    const vol = boxVolume(st.sel.pos1!, st.sel.pos2!)
    const max = weSettings(ctx.agent.settings).maxBlocks
    return ok(`selected ${fmtPos(st.sel.pos1!)} to ${fmtPos(st.sel.pos2!)}: ${vol} blocks${vol > max ? `, over my limit of ${max} for changes` : ''}`, { pos1: st.sel.pos1, pos2: st.sel.pos2, volume: vol })
  }
})

function patternAction (name: string, cmd: string, description: string, verb: string) {
  return defineAction({
    name,
    description,
    params: z.object({ pattern: z.string().describe('block or WorldEdit pattern, e.g. stone_bricks, oak_planks, 50%stone,50%cobblestone, oak_stairs[facing=north]'), ...regionOpts }),
    exclusive: false,
    async run (ctx, { pattern, protected_ok }) {
      const no = await requireWe(ctx)
      if (no) return fail(no)
      if (!validPattern(pattern)) return fail(`"${pattern}" isn't a block pattern I'll send (letters, digits and , : % [ ] = # only, no spaces)`)
      const reg = checkRegion(ctx, name, 1, protected_ok)
      if (typeof reg === 'string') return fail(reg)
      return runAndReport(ctx, `//${cmd} ${pattern}`, name, r => `${verb} ${blocksNote(r, `the ${reg.volume}-block selection`)} with ${pattern}`, { volume: reg.volume })
    }
  })
}

const weSet = patternAction('we_set', 'set', 'Fill the selected WorldEdit region with a block pattern (//set). Owners only; refused over the block limit (worldedit.maxBlocks) or in protected areas.', 'set')
const weWalls = patternAction('we_walls', 'walls', 'Build walls around the sides of the selected region (//walls), not floor or ceiling. Owners only; block limit and protected areas apply.', 'built walls:')
const weOutline = patternAction('we_outline', 'faces', 'Cover all six faces of the selected region (//faces, also known as //outline): walls, floor and ceiling. Owners only; block limit and protected areas apply.', 'outlined')

const weReplace = defineAction({
  name: 'we_replace',
  description: 'Replace one block (or mask) with another pattern in the selected region (//replace from to). Owners only; block limit and protected areas apply.',
  params: z.object({ from: z.string().describe('block or mask to replace, e.g. dirt, grass_block,dirt'), to: z.string().describe('block or pattern to put instead'), ...regionOpts }),
  exclusive: false,
  async run (ctx, { from, to, protected_ok }) {
    const no = await requireWe(ctx)
    if (no) return fail(no)
    if (!validPattern(from) || !validPattern(to)) return fail('from and to must be block names or patterns without spaces')
    const reg = checkRegion(ctx, 'we_replace', 1, protected_ok)
    if (typeof reg === 'string') return fail(reg)
    return runAndReport(ctx, `//replace ${from} ${to}`, 'we_replace', r => `replaced ${blocksNote(r, 'blocks')} of ${from} with ${to}`, { volume: reg.volume })
  }
})

const weHollow = defineAction({
  name: 'we_hollow',
  description: 'Hollow out the objects in the selected region (//hollow), leaving a shell of the given thickness, inside filled with the pattern (default air). Owners only; block limit and protected areas apply.',
  params: z.object({ thickness: z.number().int().min(1).max(8).default(1), pattern: z.string().default('air').describe('what to fill the inside with'), ...regionOpts }),
  exclusive: false,
  async run (ctx, { thickness, pattern, protected_ok }) {
    const no = await requireWe(ctx)
    if (no) return fail(no)
    if (!validPattern(pattern)) return fail(`"${pattern}" isn't a block pattern I'll send`)
    const reg = checkRegion(ctx, 'we_hollow', 1, protected_ok)
    if (typeof reg === 'string') return fail(reg)
    return runAndReport(ctx, `//hollow ${thickness} ${pattern}`, 'we_hollow', r => `hollowed ${blocksNote(r, 'the selection')}`, { volume: reg.volume })
  }
})

const weCopy = defineAction({
  name: 'we_copy',
  description: 'Copy the selected region to the WorldEdit clipboard (//copy). The clipboard remembers where I stood: we_paste puts it back relative to where I stand then. Owners only.',
  params: z.object({}),
  exclusive: false,
  async run (ctx) {
    const no = await requireWe(ctx)
    if (no) return fail(no)
    const st = state(ctx.bot)
    const box = selBox(st.sel)
    if (!box) return fail('we_copy: select a region with we_select first')
    const max = weSettings(ctx.agent.settings).maxBlocks
    const volume = boxVolume(box.min, box.max)
    if (volume > max) return fail(`we_copy: ${volume} blocks is over my WorldEdit limit of ${max}; pasting it later would be refused anyway`)
    const r = await weRun(ctx, '//copy')
    if (!r.ok) return fail(explainReply(r, 'we_copy'))
    st.clipboard = { size: [box.max.x - box.min.x + 1, box.max.y - box.min.y + 1, box.max.z - box.min.z + 1], volume, from: `a copy of ${fmtPos(box.min)} to ${fmtPos(box.max)}` }
    return ok(`copied ${blocksNote(r, `${volume} blocks`)} to the clipboard`, { volume, reply: r.text })
  }
})

const weCut = defineAction({
  name: 'we_cut',
  description: 'Cut the selected region to the WorldEdit clipboard (//cut): copies it and leaves air. Owners only; block limit and protected areas apply.',
  params: z.object({ ...regionOpts }),
  exclusive: false,
  async run (ctx, { protected_ok }) {
    const no = await requireWe(ctx)
    if (no) return fail(no)
    const reg = checkRegion(ctx, 'we_cut', 1, protected_ok)
    if (typeof reg === 'string') return fail(reg)
    const r = await weRun(ctx, '//cut')
    if (!r.ok) return fail(explainReply(r, 'we_cut'))
    const { min, max } = reg.box
    state(ctx.bot).clipboard = { size: [max.x - min.x + 1, max.y - min.y + 1, max.z - min.z + 1], volume: reg.volume, from: `a cut of ${fmtPos(min)} to ${fmtPos(max)}` }
    return ok(`cut ${blocksNote(r, `${reg.volume} blocks`)} to the clipboard`, { volume: reg.volume, reply: r.text })
  }
})

/** Asks WorldEdit how big the clipboard is (//size -c) and remembers it. */
async function clipboardSize (ctx: Ctx): Promise<{ volume: number, size?: [number, number, number], offset?: [number, number, number] } | string> {
  const r = await weRun(ctx, '//size -c')
  if (!r.ok) return explainReply(r, 'clipboard size')
  const volume = r.volume ?? (r.size ? Math.abs(r.size[0] * r.size[1] * r.size[2]) : undefined)
  if (!volume) return `clipboard size: couldn't read the size from the reply (${r.text.slice(0, 120)})`
  const st = state(ctx.bot)
  st.clipboard = { ...(st.clipboard ?? { from: 'the clipboard' }), volume, ...(r.size ? { size: r.size } : {}), ...(r.offset ? { offset: r.offset } : {}) }
  return { volume, ...(r.size ? { size: r.size } : {}), ...(r.offset ? { offset: r.offset } : {}) }
}

/** Pastes the clipboard where the bot stands (after walking to x y z when given), with the limit and protection checks. */
async function pasteHere (ctx: Ctx, opts: { skipAir: boolean, original?: boolean, at?: Vec, protectedOk: boolean, what: string }): Promise<ActionResult> {
  const size = await clipboardSize(ctx)
  if (typeof size === 'string') return fail(`${opts.what}: ${size}`)
  const max = weSettings(ctx.agent.settings).maxBlocks
  if (size.volume > max) return fail(`${opts.what}: the clipboard is ${size.volume} blocks, over my WorldEdit limit of ${max} (worldedit.maxBlocks)`)
  if (opts.at && !opts.original) {
    const t = opts.at
    try {
      await goto(ctx.bot, new goals.GoalBlock(Math.floor(t.x), Math.floor(t.y), Math.floor(t.z)), ctx.signal)
    } catch (e) {
      checkAborted(ctx.signal)
      return fail(`${opts.what}: couldn't get to ${fmtPos(t)} to paste there (${(e as Error).message})`)
    }
  }
  const me = ctx.bot.entity.position
  const here = { x: Math.floor(me.x), y: Math.floor(me.y), z: Math.floor(me.z) }
  const s = size.size ?? [32, 32, 32]
  const off = size.offset ?? [-Math.floor(Math.abs(s[0]) / 2), 0, -Math.floor(Math.abs(s[2]) / 2)]
  // WorldEdit pastes the clipboard's origin at my feet; the offset says where its corner lands
  const min = { x: here.x + off[0] - 1, y: here.y + off[1] - 1, z: here.z + off[2] - 1 }
  const box = { min, max: { x: min.x + Math.abs(s[0]) + 1, y: min.y + Math.abs(s[1]) + 1, z: min.z + Math.abs(s[2]) + 1 } }
  if (!opts.original) {
    const p = protectedCheck(ctx, box, opts.protectedOk)
    if (p) return fail(`${opts.what}: ${p}`)
  }
  const flags = `${opts.skipAir ? 'a' : ''}${opts.original ? 'o' : ''}`
  const cmd = `//paste${flags ? ` -${flags}` : ''}`
  const r = await weRun(ctx, cmd)
  if (!r.ok) return fail(explainReply(r, opts.what), { command: cmd, reply: r.text })
  return ok(`pasted the clipboard (${size.volume} blocks of volume${opts.skipAir ? ', air skipped' : ''}) ${opts.original ? 'at its original position' : `at ${fmtPos(here)}`}${r.blocks !== undefined ? `: ${r.blocks} blocks changed` : ''}`,
    { command: cmd, reply: r.text, at: here, volume: size.volume })
}

const wePaste = defineAction({
  name: 'we_paste',
  description: 'Paste the WorldEdit clipboard (//paste) where I stand, or walk to x y z first. skip_air=true (-a) leaves existing blocks where the clipboard has air. Owners only; the clipboard size is checked against the block limit and protected areas first.',
  params: z.object({
    skip_air: z.boolean().default(true).describe('-a: don\'t paste air'),
    original: z.boolean().default(false).describe('-o: paste where it was copied from, not where I stand'),
    x: z.number().optional().describe('walk here first (where I stand is where the clipboard origin goes)'),
    y: z.number().optional(),
    z: z.number().optional(),
    ...regionOpts
  }),
  async run (ctx, p) {
    const no = await requireWe(ctx)
    if (no) return fail(no)
    const at = p.x !== undefined && p.y !== undefined && p.z !== undefined ? { x: p.x, y: p.y, z: p.z } : undefined
    if (!at && (p.x !== undefined || p.z !== undefined)) return fail('give x, y and z, or none to paste where I stand')
    return pasteHere(ctx, { skipAir: p.skip_air, original: p.original, ...(at ? { at } : {}), protectedOk: p.protected_ok, what: 'we_paste' })
  }
})

const weRotate = defineAction({
  name: 'we_rotate',
  description: 'Rotate the WorldEdit clipboard around the vertical axis (//rotate), in steps of 90 degrees. Owners only.',
  params: z.object({ degrees: z.union([z.literal(90), z.literal(180), z.literal(270), z.literal(-90)]).describe('90, 180, 270 or -90') }),
  exclusive: false,
  async run (ctx, { degrees }) {
    const no = await requireWe(ctx)
    if (no) return fail(no)
    return runAndReport(ctx, `//rotate ${degrees}`, 'we_rotate', () => `rotated the clipboard by ${degrees} degrees`)
  }
})

const weFlip = defineAction({
  name: 'we_flip',
  description: 'Flip (mirror) the WorldEdit clipboard (//flip) along a direction; default the way I face. Owners only.',
  params: z.object({ direction: z.enum(['north', 'south', 'east', 'west', 'up', 'down']).optional() }),
  exclusive: false,
  async run (ctx, { direction }) {
    const no = await requireWe(ctx)
    if (no) return fail(no)
    return runAndReport(ctx, `//flip${direction ? ` ${direction}` : ''}`, 'we_flip', () => `flipped the clipboard${direction ? ` ${direction}` : ''}`)
  }
})

function historyAction (name: 'we_undo' | 'we_redo', cmd: 'undo' | 'redo') {
  return defineAction({
    name,
    description: cmd === 'undo' ? 'Undo my last WorldEdit change(s) (//undo). Owners only.' : 'Redo WorldEdit changes I undid (//redo). Owners only.',
    params: z.object({ times: z.number().int().min(1).max(10).default(1) }),
    exclusive: false,
    async run (ctx, { times }) {
      const no = await requireWe(ctx)
      if (no) return fail(no)
      return runAndReport(ctx, `//${cmd}${times > 1 ? ` ${times}` : ''}`, name, r => `${cmd === 'undo' ? 'undid' : 'redid'} ${times} change${times === 1 ? '' : 's'}${r.blocks !== undefined ? ` (${r.blocks} blocks)` : ''}`)
    }
  })
}

/** Every schematic file on the server's WorldEdit list (up to 5 pages). */
async function listSchematics (ctx: Ctx): Promise<{ files: string[] } | string> {
  const files = new Set<string>()
  let pages = 1
  for (let page = 1; page <= Math.min(pages, 5); page++) {
    const r = await weRun(ctx, page === 1 ? '//schem list' : `//schem list -p ${page}`)
    if (!r.ok) return explainReply(r, 'we_schem_list')
    for (const f of r.files ?? []) files.add(f)
    pages = r.pages ?? 1
  }
  return { files: [...files] }
}

const weSchemList = defineAction({
  name: 'we_schem_list',
  description: 'List the schematics in the server\'s WorldEdit schematics folder (//schem list). Owners only.',
  params: z.object({}),
  exclusive: false,
  async run (ctx) {
    const no = await requireWe(ctx)
    if (no) return fail(no)
    const r = await listSchematics(ctx)
    if (typeof r === 'string') return fail(r)
    return ok(r.files.length ? `${r.files.length} schematics on the server: ${r.files.join(', ')}` : 'the server\'s WorldEdit schematics folder is empty (or the list was not readable)', r)
  }
})

const weSchemLoad = defineAction({
  name: 'we_schem_load',
  description: 'Load a schematic from the server\'s WorldEdit schematics folder into the clipboard (//schem load name), then we_paste puts it down. Only files already on the server; I can\'t upload any. Owners only.',
  params: z.object({ name: z.string().describe('schematic name, with or without .schem') }),
  exclusive: false,
  async run (ctx, { name }) {
    const no = await requireWe(ctx)
    if (no) return fail(no)
    if (!validSchemName(name)) return fail(`"${name}" isn't a schematic name I'll send (letters, digits, _ and -, optional .schem)`)
    const r = await weRun(ctx, `//schem load ${name}`)
    if (!r.ok) return fail(explainReply(r, `we_schem_load ${name}`))
    state(ctx.bot).clipboard = { from: `schematic ${name}` }
    return ok(`loaded ${name} into the clipboard; we_paste puts it down`, { reply: r.text })
  }
})

const weSchemSave = defineAction({
  name: 'we_schem_save',
  description: 'Save the WorldEdit clipboard as a schematic in the server\'s schematics folder (//schem save name). Owners only.',
  params: z.object({ name: z.string().describe('schematic name (letters, digits, _ and -)'), overwrite: z.boolean().default(false).describe('-f: replace a schematic of that name') }),
  exclusive: false,
  async run (ctx, { name, overwrite }) {
    const no = await requireWe(ctx)
    if (no) return fail(no)
    if (!validSchemName(name)) return fail(`"${name}" isn't a schematic name I'll send (letters, digits, _ and -)`)
    return runAndReport(ctx, `//schem save${overwrite ? ' -f' : ''} ${name}`, `we_schem_save ${name}`, () => `saved the clipboard as ${name} on the server`)
  }
})

const weRaw = defineAction({
  name: 'we_raw',
  description: `Run one other WorldEdit command from a whitelist (${Object.keys(RAW_WHITELIST).join(', ')}), e.g. "//expand 5 up" or "//stack 3 north". Commands that change blocks need a selection from we_select and stay under the block limit. Owners only.`,
  params: z.object({ command: z.string().describe('the command with its arguments, e.g. "//expand 5 up"'), ...regionOpts }),
  exclusive: false,
  async run (ctx, { command, protected_ok }) {
    const no = await requireWe(ctx)
    if (no) return fail(no)
    const c = checkRaw(command)
    if (!c.ok) return fail(`we_raw: ${c.why}`)
    if (c.kind !== 'info') {
      const reg = checkRegion(ctx, c.command!, c.kind === 'stack' ? (c.count ?? 1) + 1 : c.command!.startsWith('//move') ? 2 : 1, protected_ok)
      if (typeof reg === 'string') return fail(reg)
    }
    const r = await weRun(ctx, c.command!)
    if (!r.ok) return fail(explainReply(r, c.command!), { reply: r.text })
    // selection changes from //expand and friends: we no longer know the exact box
    if (/^\/\/(expand|contract|shift|outset|inset|chunk|desel|sel|hpos1|hpos2|pos1|pos2|move|stack)\b/.test(c.command!)) state(ctx.bot).sel = {}
    return ok(`${c.command}: ${r.text.slice(0, 300) || 'done'}`, { reply: r.text, blocks: r.blocks })
  }
})

const weBuild = defineAction({
  name: 'we_build',
  description: 'Build a library blueprint with WorldEdit when an owner asks for it: if WorldEdit is available and the server already has a schematic with that name (//schem list), load and paste it (-a) at x y z (or where I stand); ' +
    'otherwise, or when that fails, build it the normal way (build). I can\'t upload schematics to the server. Owners only.',
  params: z.object({
    template: z.string().describe('blueprint name (also the schematic name looked for on the server)'),
    schematic: z.string().optional().describe('schematic name on the server if it differs from the blueprint name'),
    x: z.number().optional(), y: z.number().optional(), z: z.number().optional(),
    facing: z.enum(FACINGS as [Facing, ...Facing[]]).optional().describe('for the normal build fallback'),
    fallback: z.boolean().default(true).describe('build it normally when WorldEdit can\'t'),
    gather: z.boolean().default(false).describe('normal build: gather missing materials first'),
    ...regionOpts
  }),
  longRunning: true,
  async run (ctx, p) {
    const no = denied(ctx)
    if (no) return fail(no)
    const normal = async (why: string): Promise<ActionResult> => {
      if (!p.fallback) return fail(`${why}; not building it normally (fallback=false)`)
      ctx.log.info('we_build falls back to build', { template: p.template, why })
      const r = await buildStructure(ctx, { template: p.template, gather: p.gather, ...(p.x !== undefined ? { x: p.x } : {}), ...(p.y !== undefined ? { y: p.y } : {}), ...(p.z !== undefined ? { z: p.z } : {}), ...(p.facing ? { facing: p.facing } : {}) })
      return { ...r, message: `${why}, so I built it the normal way: ${r.message}` }
    }
    const lib = loadLibrary(libraryDirs(ctx.agent))
    if (!lib.blueprints.has(p.template) && !p.schematic) return fail(`unknown blueprint "${p.template}"; blueprint_search finds one`)
    if (!ctx.bot?.entity) return fail('not in the world right now')
    const d = await detect(ctx)
    if (!d.available) return normal(`WorldEdit isn't available (${d.how})`)
    const want = (p.schematic ?? p.template).toLowerCase().replace(/\.(schem|schematic)$/, '')
    if (!validSchemName(want)) return normal(`"${want}" can't be a WorldEdit schematic name`)
    const list = await listSchematics(ctx)
    if (typeof list === 'string') return normal(list)
    const file = list.files.find(f => f.toLowerCase().replace(/\.(schem|schematic)$/, '') === want)
    if (!file) return normal(`the server has no WorldEdit schematic named ${want} (it has ${list.files.length ? list.files.slice(0, 8).join(', ') : 'none'}) and I can't upload one`)
    const r = await weRun(ctx, `//schem load ${file.replace(/\.(schem|schematic)$/, '')}`)
    if (!r.ok) return normal(explainReply(r, `loading ${file}`))
    state(ctx.bot).clipboard = { from: `schematic ${file}` }
    const at = p.x !== undefined && p.y !== undefined && p.z !== undefined ? { x: p.x, y: p.y, z: p.z } : undefined
    const pasted = await pasteHere(ctx, { skipAir: true, ...(at ? { at } : {}), protectedOk: p.protected_ok, what: `pasting ${file}` })
    if (!pasted.ok) return /limit|protected|spawn area/.test(pasted.message) ? pasted : normal(pasted.message)
    return ok(`built ${p.template} with WorldEdit from the server's ${file}: ${pasted.message}. we_undo takes it back`, pasted.data)
  }
})

/**
 * WorldEdit skill: detection, selection, region edits, clipboard, schematics on the server,
 * a whitelisted raw command, and building library blueprints with WorldEdit.
 */
export const worldedit = () => defineSkill({
  name: 'worldedit',
  description: 'WorldEdit commands (mod or plugin, or FAWE) on servers that have it and give me permission; owners only, with a block limit.',
  actions: [weStatus, weSelect, weSet, weReplace, weWalls, weOutline, weHollow, weCopy, weCut, wePaste, weRotate, weFlip, historyAction('we_undo', 'undo'), historyAction('we_redo', 'redo'),
    weSchemList, weSchemLoad, weSchemSave, weRaw, weBuild],
  setup (_agent: Agent, bot: Bot) {
    states.delete(bot)
    const st = state(bot)
    // Bukkit plugins announce their channels with minecraft:register (worldedit:cui)
    const onPayload = (p: { channel?: string, data?: Buffer }) => {
      if (p?.channel !== 'minecraft:register' || !p.data) return
      for (const c of p.data.toString('utf8').split('\0')) if (c) st.registered.add(c)
    }
    bot._client.on('custom_payload', onPayload)
    return () => { bot._client.removeListener('custom_payload', onPayload) }
  },
  observe (agent: Agent, bot: Bot) {
    const d = states.get(bot)?.detection
    const forced = weSettings(agent.settings).enabled
    if (forced === true || d?.available) return { worldedit: 'available (only when an owner asks)' }
    return {}
  }
})
