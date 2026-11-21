// Blueprint libraries: where blueprints live, a small searchable index, the checks an
// LLM-designed blueprint has to pass, the building policy (library | creative | ask) and safe
// file handling for the bot's own (learned) library. Pure or plain fs; the actions are in
// library.ts.
//
//   shipped   blueprints/                         read only, comes with the code
//   user      settings.build.blueprintDirs        read only, the owner's folders (profile `blueprints:`)
//   learned   data/bots/<name>/blueprints/        written by the bot: captured, imported, designed
//
// Later libraries win by name, but a learned blueprint never takes a shipped or user name.
import { readdirSync, readFileSync, existsSync, statSync, lstatSync, realpathSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { join, resolve, sep, isAbsolute, basename } from 'node:path'
import YAML from 'yaml'
import {
  parseBlueprint, resolveRoles, solidCells, orderCells, BLUEPRINTS_DIR, type Blueprint
} from './blueprint.ts'
import { planPlacement, DIR_VEC, type PlaceEnv } from './blockstate.ts'

export type LibraryKind = 'shipped' | 'user' | 'learned'
export interface LibraryDir { kind: LibraryKind, dir: string }

interface SettingsHolder { settings: Record<string, unknown>, dataDir: string }

const buildSettings = (agent: Pick<SettingsHolder, 'settings'>) => (agent.settings.build ?? {}) as { blueprintDirs?: string | string[], importDir?: string, importMaxBlocks?: number, designMaxBlocks?: number, captureMaxSize?: number, captureMaxBlocks?: number }

/** The bot's own library: data/bots/<name>/blueprints/. */
export const learnedDir = (agent: Pick<SettingsHolder, 'dataDir'>) => resolve(agent.dataDir, 'blueprints')

/** The only folder blueprint_import reads from: settings.build.importDir, default blueprints/import/. */
export const importDir = (agent: Pick<SettingsHolder, 'settings'>) => resolve(buildSettings(agent).importDir ?? join(BLUEPRINTS_DIR, 'import'))

/** Shipped, then the user's folders, then the learned library (later wins by name). */
export function libraryDirs (agent?: SettingsHolder): LibraryDir[] {
  const out: LibraryDir[] = [{ kind: 'shipped', dir: BLUEPRINTS_DIR }]
  if (!agent) return out
  const extra = buildSettings(agent).blueprintDirs
  for (const d of [extra ?? []].flat()) if (typeof d === 'string' && d) out.push({ kind: 'user', dir: resolve(d) })
  out.push({ kind: 'learned', dir: learnedDir(agent) })
  return out
}

/** Limits, from settings.build with defaults. */
export function limits (agent?: Pick<SettingsHolder, 'settings'>) {
  const b = agent ? buildSettings(agent) : {}
  return {
    importMaxBlocks: Number(b.importMaxBlocks ?? 4000),
    designMaxBlocks: Number(b.designMaxBlocks ?? 1500),
    designMaxSize: 24,
    captureMaxSize: Number(b.captureMaxSize ?? 32),
    captureMaxBlocks: Number(b.captureMaxBlocks ?? 4000)
  }
}

// ------------------------------------------------------------------ index

/** One line of the index: enough to search and choose without loading the cells. */
export interface IndexEntry {
  name: string
  library: LibraryKind
  file: string
  description: string
  tags: string[]
  /** width (x), depth (z), height (y). */
  size: [number, number, number]
  blocks: number
  /** Blocks by item, most first (role defaults). */
  materials: Record<string, number>
  author?: string
  source?: string
  created?: string
  rating?: number
  notes?: string
}

export interface Library {
  /** Winners by name, in library order. */
  entries: IndexEntry[]
  blueprints: Map<string, Blueprint>
  errors: string[]
}

/** What a blueprint is made of, by default item, most first. */
export function materialSummary (bp: Blueprint): Record<string, number> {
  const roles = resolveRoles(bp, {})
  const n = new Map<string, number>()
  for (const c of solidCells(bp.cells)) {
    const item = roles[c.role]?.item ?? c.role
    n.set(item, (n.get(item) ?? 0) + 1)
  }
  return Object.fromEntries([...n].sort((a, b) => b[1] - a[1]))
}

export function indexEntry (bp: Blueprint, library: LibraryKind, file: string): IndexEntry {
  const m = (bp.meta ?? {}) as Record<string, unknown>
  const e: IndexEntry = {
    name: bp.name,
    library,
    file,
    description: bp.description,
    tags: Array.isArray(m.tags) ? m.tags.map(String) : [],
    size: [bp.width, bp.depth, bp.height],
    blocks: solidCells(bp.cells).length,
    materials: materialSummary(bp)
  }
  for (const k of ['author', 'source', 'created', 'notes'] as const) if (typeof m[k] === 'string') e[k] = m[k] as string
  if (typeof m.rating === 'number') e.rating = m.rating
  return e
}

let cache: { sig: string, lib: Library } | null = null

/**
 * Loads every library (missing folders are fine) into an index plus the parsed blueprints.
 * Cached until a file changes, so searching is cheap. A learned blueprint with the name of a
 * shipped or user one is reported and skipped.
 */
export function loadLibrary (dirs: LibraryDir[]): Library {
  const files: { kind: LibraryKind, path: string, mtime: number }[] = []
  for (const { kind, dir } of dirs) {
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir).filter(f => /\.ya?ml$/.test(f)).sort()) {
      const path = join(dir, f)
      try {
        const st = lstatSync(path)
        if (!st.isFile()) continue // no symlinks or folders
        files.push({ kind, path, mtime: st.mtimeMs })
      } catch {}
    }
  }
  const sig = files.map(f => `${f.kind}:${f.path}:${f.mtime}`).join('|')
  if (cache && cache.sig === sig) return cache.lib
  const blueprints = new Map<string, Blueprint>()
  const entries = new Map<string, IndexEntry>()
  const errors: string[] = []
  for (const f of files) {
    try {
      const bp = parseBlueprint(readFileSync(f.path, 'utf8'), basename(f.path))
      const prev = entries.get(bp.name)
      if (f.kind === 'learned' && prev && prev.library !== 'learned') { errors.push(`${basename(f.path)}: learned blueprint "${bp.name}" has the name of a ${prev.library} one, ignored`); continue }
      blueprints.set(bp.name, bp)
      entries.set(bp.name, indexEntry(bp, f.kind, f.path))
    } catch (e) {
      errors.push((e as Error).message)
    }
  }
  const lib = { entries: [...entries.values()], blueprints, errors }
  cache = { sig, lib }
  return lib
}

/** One compact line per blueprint for chat and the LLM. */
export function fmtEntry (e: IndexEntry): string {
  const top = Object.entries(e.materials).slice(0, 3).map(([k, n]) => `${n} ${k}`).join(', ')
  const tags = e.tags.length ? ` [${e.tags.join(',')}]` : ''
  const lib = e.library === 'shipped' ? '' : ` (${e.library}${e.rating !== undefined ? `, ${e.rating}/5` : ''})`
  return `${e.name}${lib}: ${e.size[0]}x${e.size[1]}x${e.size[2]}, ${e.blocks} blocks${tags} - ${e.description}; ${top}`
}

// ------------------------------------------------------------------ search

export interface SearchQuery {
  /** Free text: "small stone house", matched against name, tags, description, materials. */
  text?: string
  tags?: string[]
  /** An item the blueprint should use (cobblestone, spruce, glass). */
  material?: string
  /** Footprint limit: the larger of width and depth. */
  maxSize?: number
  maxHeight?: number
  maxBlocks?: number
  /** small (< 150 blocks), medium (< 500), large. */
  size?: 'small' | 'medium' | 'large'
  library?: LibraryKind
}

const SYNONYMS: Record<string, string> = {
  home: 'house', hut: 'house', cottage: 'house', cabin: 'house', shelter: 'house', base: 'house',
  defense: 'defence', defensive: 'defence', fort: 'defence', fortress: 'defence', castle: 'defence', wall: 'defence', walls: 'defence', tower: 'defence', watchtower: 'defence',
  farms: 'farm', field: 'farm', crops: 'farm', decor: 'decoration', decorative: 'decoration', statue: 'decoration', fountain: 'decoration'
}

const STOP = new Set(['a', 'an', 'the', 'of', 'with', 'and', 'for', 'to', 'me', 'us', 'build', 'make', 'please', 'some', 'nice', 'one', 'it', 'my', 'our'])

export const tokens = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 1 && !STOP.has(t))

const sizeClass = (blocks: number) => (blocks < 150 ? 'small' : blocks < 500 ? 'medium' : 'large')

export interface SearchHit { entry: IndexEntry, score: number, why: string[] }

/**
 * Ranks blueprints for a request. Size, height, block and library limits are hard filters;
 * tags, text and material add to the score (tags most). With a query, blueprints that match
 * nothing are left out. Ties go to the higher rating, then the bot's own library.
 */
export function searchLibrary (entries: IndexEntry[], q: SearchQuery): SearchHit[] {
  const qtags = (q.tags ?? []).map(t => SYNONYMS[t.toLowerCase()] ?? t.toLowerCase())
  const qtext = tokens(q.text ?? '')
  const material = q.material?.toLowerCase().replace(/^minecraft:/, '')
  const hasQuery = qtags.length > 0 || qtext.length > 0 || !!material || !!q.size
  const hits: SearchHit[] = []
  for (const e of entries) {
    if (q.library && e.library !== q.library) continue
    if (q.maxSize && Math.max(e.size[0], e.size[1]) > q.maxSize) continue
    if (q.maxHeight && e.size[2] > q.maxHeight) continue
    if (q.maxBlocks && e.blocks > q.maxBlocks) continue
    let score = 0
    const why: string[] = []
    const etags = e.tags.map(t => t.toLowerCase())
    for (const t of qtags) if (etags.includes(t)) { score += 5; why.push(`tag ${t}`) }
    const name = tokens(e.name)
    const desc = new Set(tokens(e.description))
    const mats = Object.keys(e.materials).join(' ')
    for (const t of qtext) {
      const syn = SYNONYMS[t]
      if (name.includes(t)) { score += 4; why.push(`name ${t}`) } else if (etags.includes(t) || (syn && etags.includes(syn))) { score += 3; why.push(`tag ${syn && !etags.includes(t) ? syn : t}`) } else if (desc.has(t)) { score += 1.5; why.push(`text ${t}`) } else if (mats.includes(t)) { score += 1; why.push(`uses ${t}`) }
    }
    if (material) {
      const n = Object.entries(e.materials).filter(([k]) => k.includes(material)).reduce((a, [, v]) => a + v, 0)
      if (n) { score += 3 + Math.min(2, n / Math.max(1, e.blocks) * 4); why.push(`uses ${material}`) }
    }
    if (q.size && sizeClass(e.blocks) === q.size) { score += 2; why.push(q.size) }
    if (hasQuery && score === 0) continue
    score += (e.rating ?? 2.5) * 0.1 + (e.library === 'learned' ? 0.2 : 0)
    hits.push({ entry: e, score: Math.round(score * 100) / 100, why })
  }
  return hits.sort((a, b) => b.score - a.score || a.entry.blocks - b.entry.blocks || a.entry.name.localeCompare(b.entry.name))
}

/** Tags guessed from a name, description and the blocks used, for imports and captures without tags. */
export function guessTags (text: string, blocks: string[]): string[] {
  const out = new Set<string>()
  for (const t of tokens(text)) {
    const s = SYNONYMS[t] ?? t
    if (['house', 'defence', 'farm', 'decoration'].includes(s)) out.add(s)
  }
  const has = (re: RegExp) => blocks.some(b => re.test(b))
  if (!out.size) {
    if (has(/_bed$/) || (has(/_door$/) && has(/_stairs$|_slab$/))) out.add('house')
    else if (has(/^farmland$|^(wheat|carrots|potatoes|beetroots)$/)) out.add('farm')
    else if (has(/_wall$/) && !has(/_door$/)) out.add('defence')
  }
  return [...out]
}

// ------------------------------------------------------------------ design checks

export interface DesignReport { problems: string[], warnings: string[] }

const where = (bp: Blueprint, c: { x: number, y: number, z: number, glyph?: string, role: string }) =>
  `layer ${c.y} row ${c.z} col ${c.x}${c.glyph ? ` "${c.glyph}"` : ''} (${bp.roles[c.role]?.default ?? c.role})`

/**
 * Cells that can't be placed in build order: nothing solid to click for their state, after
 * up to six passes (the same simulation the shipped-blueprint test runs). Layer 0 stands on
 * the ground.
 */
export function unplaceableCells (bp: Blueprint) {
  const roles = resolveRoles(bp, {})
  const order = orderCells(bp.cells, roles).filter(c => c.role !== 'air' && !c.passive)
  const solid = new Set<string>()
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`
  let deferred = order.slice()
  for (let round = 0; round < 6 && deferred.length; round++) {
    deferred = deferred.filter(c => {
      const e: PlaceEnv = {
        solid: d => { const v = DIR_VEC[d]; return c.y + v.y < 0 || solid.has(key(c.x + v.x, c.y + v.y, c.z + v.z)) },
        free: () => true
      }
      if (!planPlacement(roles[c.role]!.item, c.state, e).length) return true
      solid.add(key(c.x, c.y, c.z))
      return false
    })
  }
  return deferred
}

/** Blocks with no chain of touching blocks down to the bottom layer (they'd hang in the air). */
export function floatingCells (bp: Blueprint) {
  const solid = solidCells(bp.cells)
  if (!solid.length) return []
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`
  const byPos = new Map(solid.map(c => [key(c.x, c.y, c.z), c]))
  const bottom = Math.min(...solid.map(c => c.y))
  const seen = new Set<string>()
  const queue = solid.filter(c => c.y === bottom)
  for (const c of queue) seen.add(key(c.x, c.y, c.z))
  while (queue.length) {
    const c = queue.pop()!
    for (const v of Object.values(DIR_VEC)) {
      const k = key(c.x + v.x, c.y + v.y, c.z + v.z)
      const n = byPos.get(k)
      if (n && !seen.has(k)) { seen.add(k); queue.push(n) }
    }
  }
  return solid.filter(c => !seen.has(key(c.x, c.y, c.z)))
}

const NAME_RE = /^[a-z0-9_]+(:[a-z0-9_./-]+)?$/

/**
 * Sanity checks for a blueprint someone (usually the LLM) designed: size and block limits,
 * real block or item names (`knownBlock`), every block placeable in build order, nothing floating. Problems are
 * worded so the model can fix the YAML and try again.
 */
export function checkDesign (bp: Blueprint, lim: { maxSize: number, maxBlocks: number }, knownBlock: (name: string) => boolean): DesignReport {
  const problems: string[] = []
  const warnings: string[] = []
  if (bp.width > lim.maxSize || bp.depth > lim.maxSize || bp.height > lim.maxSize) problems.push(`too big: ${bp.width}x${bp.depth}x${bp.height}, at most ${lim.maxSize} on each side`)
  const blocks = solidCells(bp.cells).length
  if (blocks > lim.maxBlocks) problems.push(`too many blocks: ${blocks}, at most ${lim.maxBlocks}`)
  for (const [name, r] of Object.entries(bp.roles)) {
    const item = r.default
    if (!NAME_RE.test(item)) { problems.push(`role ${name}: "${item}" is not a block id (lowercase, like oak_planks)`); continue }
    if (item.includes(':') && !item.startsWith('minecraft:')) warnings.push(`modded block ${item}: the bot can only place it if it carries one`)
    else if (!knownBlock(item.replace(/^minecraft:/, ''))) problems.push(`role ${name}: unknown block "${item}"${suggest(item, knownBlock)}`)
  }
  if (problems.length) return { problems, warnings }
  const stuck = unplaceableCells(bp)
  if (stuck.length) problems.push(`${stuck.length} block${stuck.length === 1 ? '' : 's'} can't be placed in build order (nothing to click for their state): ${stuck.slice(0, 5).map(c => where(bp, c) + (c.state ? ` [${Object.entries(c.state).map(([k, v]) => `${k}=${v}`).join(',')}]` : '')).join('; ')}`)
  const floating = floatingCells(bp)
  if (floating.length) problems.push(`${floating.length} block${floating.length === 1 ? '' : 's'} float with nothing under or beside them connecting to the ground: ${floating.slice(0, 5).map(c => where(bp, c)).join('; ')}`)
  const air = bp.cells.filter(c => c.role === 'air').length
  if (!air && bp.height > 2) warnings.push('no "." air cells: the inside is "don\'t care", so clutter in it stays')
  return { problems, warnings }
}

function suggest (item: string, known: (n: string) => boolean): string {
  const tries = [`${item}s`, item.replace(/s$/, ''), item.replace(/_planks?$/, '_planks'), item.replace(/^wood_/, 'oak_'), `oak_${item}`]
  const hit = tries.find(t => t !== item && known(t))
  return hit ? ` (did you mean ${hit}?)` : ''
}

// ------------------------------------------------------------------ policy

export type BuildingPolicy = 'library' | 'creative' | 'ask'
export const POLICIES: BuildingPolicy[] = ['library', 'creative', 'ask']

export function buildingPolicy (settings: Record<string, unknown>): BuildingPolicy {
  const v = settings.building
  return POLICIES.includes(v as BuildingPolicy) ? v as BuildingPolicy : 'library'
}

export interface PolicyDecision {
  mode: 'build' | 'design' | 'ask'
  /** build: the blueprint to use; design: the fallback if designing fails. */
  pick?: IndexEntry
  /** ask: the matches to offer. */
  options: IndexEntry[]
  message: string
}

/**
 * What to do for a build request under a policy:
 * - library: the best match; nothing matches: design one
 * - creative: design one, the best match as the fallback
 * - ask: owner online and something matches: offer up to 3 matches (or a new design); otherwise library
 */
export function decideBuilding (policy: BuildingPolicy, hits: SearchHit[], ownerOnline: boolean, owner?: string): PolicyDecision {
  const best = hits[0]?.entry
  const options = hits.slice(0, 3).map(h => h.entry)
  const byLibrary = (why: string): PolicyDecision => best
    ? { mode: 'build', pick: best, options, message: `${why}use ${best.name}: build template=${best.name}${options.length > 1 ? ` (other matches: ${options.slice(1).map(o => o.name).join(', ')})` : ''}` }
    : { mode: 'design', options: [], message: `${why}nothing in the library fits: design one with blueprint_design, then build it` }
  if (policy === 'creative') {
    return { mode: 'design', ...(best ? { pick: best } : {}), options, message: `policy creative: design a new blueprint for this with blueprint_design (look at blueprint_show ${best?.name ?? 'small_house'} for the format), then build it${best ? `; if the design keeps failing, build template=${best.name}` : ''}` }
  }
  if (policy === 'ask') {
    if (ownerOnline && options.length) {
      return { mode: 'ask', options, message: `policy ask: ask ${owner ?? 'the owner'} which they want: ${options.map(o => `${o.name} (${o.size[0]}x${o.size[1]}, ${o.description})`).join('; ')}; or a new design. Then call update_goal wait_for_owner=true` }
    }
    return byLibrary(ownerOnline ? 'policy ask, but nothing to offer: ' : 'policy ask, owner offline so from the library: ')
  }
  return byLibrary('policy library: ')
}

// ------------------------------------------------------------------ safe files

/**
 * `root/name` when it stays inside root: no absolute paths, no "..", no NUL, and no symlink
 * (the file, or any folder on the way) that leads out. The file itself may not exist yet.
 * Returns null when the path isn't safe.
 */
export function safeChild (root: string, name: string): string | null {
  if (!name || name.includes('\0') || isAbsolute(name) || name.split(/[\\/]/).includes('..')) return null
  const base = resolve(root)
  const target = resolve(base, name)
  if (!target.startsWith(base + sep)) return null
  if (!existsSync(base)) return target
  const realBase = realpathSync(base)
  // the deepest existing part of the path must resolve inside the real root
  let probe = target
  while (!existsSync(probe) && probe.startsWith(base + sep)) probe = resolve(probe, '..')
  const real = realpathSync(probe)
  if (real !== realBase && !real.startsWith(realBase + sep)) return null
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) return null
  return target
}

const BP_NAME = /^[a-z0-9_]{1,48}$/

export function checkName (name: string): string | null {
  return BP_NAME.test(name) ? null : `bad name "${name}": lowercase letters, digits and _ (at most 48)`
}

/** Writes a learned blueprint as <name>.yaml (atomically). Throws when the name or path isn't safe or it exists and overwrite is off. */
export function writeLearned (dir: string, name: string, yaml: string, overwrite = false): string {
  const bad = checkName(name)
  if (bad) throw new Error(bad)
  mkdirSync(dir, { recursive: true })
  const path = safeChild(dir, `${name}.yaml`)
  if (!path) throw new Error(`unsafe path for ${name}`)
  const existing = findLearnedFile(dir, name)
  if (existing && !overwrite) throw new Error(`a learned blueprint named ${name} already exists; pick another name or pass overwrite=true`)
  const tmp = `${path}.tmp`
  writeFileSync(tmp, yaml)
  renameSync(tmp, path)
  if (existing && existing !== path) unlinkSync(existing)
  return path
}

/** The file in the learned library that holds blueprint `name` (regular files only). */
export function findLearnedFile (dir: string, name: string): string | null {
  if (!existsSync(dir)) return null
  const direct = safeChild(dir, `${name}.yaml`)
  const files = readdirSync(dir).filter(f => /\.ya?ml$/.test(f)).map(f => safeChild(dir, f)).filter((f): f is string => !!f)
  const ordered = direct && files.includes(direct) ? [direct, ...files.filter(f => f !== direct)] : files
  for (const f of ordered) {
    try {
      if (!statSync(f).isFile() || lstatSync(f).isSymbolicLink()) continue
      const doc = YAML.parse(readFileSync(f, 'utf8')) as { name?: unknown } | null
      if (doc?.name === name) return f
    } catch {}
  }
  return null
}

export function deleteLearned (dir: string, name: string): string {
  const f = findLearnedFile(dir, name)
  if (!f) throw new Error(`no learned blueprint named ${name}`)
  unlinkSync(f)
  return f
}

/** Renames a learned blueprint: the name inside the file and the file itself. */
export function renameLearned (dir: string, from: string, to: string): string {
  const bad = checkName(to)
  if (bad) throw new Error(bad)
  const f = findLearnedFile(dir, from)
  if (!f) throw new Error(`no learned blueprint named ${from}`)
  if (findLearnedFile(dir, to)) throw new Error(`a learned blueprint named ${to} already exists`)
  const doc = YAML.parseDocument(readFileSync(f, 'utf8'))
  doc.set('name', to)
  const path = writeLearned(dir, to, doc.toString({ lineWidth: 100 }))
  if (path !== f) unlinkSync(f)
  return path
}

/** Sets meta fields in blueprint YAML text, keeping the rest (and its comments) as written. */
export function withMeta (yaml: string, meta: Record<string, unknown>): string {
  const doc = YAML.parseDocument(yaml)
  for (const [k, v] of Object.entries(meta)) if (v !== undefined) doc.setIn(['meta', k], v)
  return doc.toString({ lineWidth: 100 })
}

export const today = () => new Date().toISOString().slice(0, 10)
