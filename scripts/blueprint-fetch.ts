// Downloads the schematics listed in blueprints/sources.yaml and converts them into blueprints:
// freely licensed ones into blueprints/library/ (committed), the rest into blueprints/downloaded/
// (gitignored). Every result goes through the design checks a survival bot cares about: can each
// block be placed in build order, does anything float, and can gather_materials make it all.
//   node scripts/blueprint-fetch.ts [--only a,b] [--force] [--check] [--keep-raw] [--sources file]
// --check converts and reports without writing. --keep-raw keeps the downloads in
// blueprints/downloaded/raw/. Requests use a generic User-Agent, one per second, nothing else is sent.
import { readFileSync, writeFileSync, mkdirSync, existsSync, lstatSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import YAML from 'yaml'
import { z } from 'zod'
import { parseBlueprint, resolveRoles, solidCells, FACINGS, BLUEPRINTS_DIR, type Facing } from '../src/skills/blueprint.ts'
import { readSchematic, importStructure, parseBox } from '../src/skills/schematic.ts'
import { checkName, safeChild, unplaceableCells, floatingCells, writeLearned, today, COMMUNITY_DIR, DOWNLOADED_DIR } from '../src/skills/blueprint-library.ts'
import { wantsForRoles, planWood } from '../src/skills/materials.ts'

const Source = z.object({
  name: z.string(),
  url: z.string().url().optional(),
  page: z.string(),
  author: z.string(),
  license: z.string(),
  license_url: z.string().url().optional(),
  redistribute: z.boolean(),
  manual: z.boolean().default(false),
  file: z.string().optional(),
  tags: z.array(z.string()).default([]),
  notes: z.string().optional(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  crop: z.string().optional(),
  facing: z.enum(FACINGS as [Facing, ...Facing[]]).optional(),
  exact: z.boolean().default(false),
  terrain: z.boolean().default(false),
  max_blocks: z.number().int().min(1).optional()
})
type Source = z.infer<typeof Source>

const { values } = parseArgs({
  options: {
    only: { type: 'string' },
    force: { type: 'boolean', default: false },
    check: { type: 'boolean', default: false },
    'keep-raw': { type: 'boolean', default: false },
    sources: { type: 'string', default: join(BLUEPRINTS_DIR, 'sources.yaml') }
  }
})

const USER_AGENT = 'Mozilla/5.0 (compatible; schematic-fetch/1.0)'
const MAX_BYTES = 16 * 1024 * 1024
const RAW_DIR = join(DOWNLOADED_DIR, 'raw')

const doc = YAML.parse(readFileSync(values.sources!, 'utf8')) as { sources?: unknown[] }
const sources = z.array(Source).parse(doc.sources ?? [])
const only = values.only ? new Set(values.only.split(',').map(s => s.trim())) : null
const seen = new Set<string>()
for (const s of sources) {
  const bad = checkName(s.name)
  if (bad) throw new Error(`sources.yaml: ${bad}`)
  if (seen.has(s.name)) throw new Error(`sources.yaml: ${s.name} is listed twice`)
  seen.add(s.name)
  if (!s.manual && !s.url) throw new Error(`sources.yaml: ${s.name} needs a url (or manual: true)`)
  if (s.url && !s.url.startsWith('https://')) throw new Error(`sources.yaml: ${s.name}: only https urls`)
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** One download, with a size cap and nothing about us but a generic User-Agent. */
async function download (url: string): Promise<Buffer> {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: '*/*' }, redirect: 'follow', signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const len = Number(res.headers.get('content-length') ?? 0)
  if (len > MAX_BYTES) throw new Error(`${len} bytes is over the 16 MB cap`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > MAX_BYTES) throw new Error(`${buf.length} bytes is over the 16 MB cap`)
  return buf
}

interface Row { name: string, license: string, where: string, size: string, blocks: number, verdict: string, notes: string[] }
const rows: Row[] = []
let lastRequest = 0

for (const s of sources) {
  if (only && !only.has(s.name)) continue
  const row: Row = { name: s.name, license: s.license, where: s.redistribute ? 'library (committed)' : 'downloaded (local)', size: '', blocks: 0, verdict: '', notes: [] }
  rows.push(row)
  const outDir = s.redistribute ? COMMUNITY_DIR : DOWNLOADED_DIR
  if (!values.force && !values.check && existsSync(join(outDir, `${s.name}.yaml`))) { row.verdict = 'already there (--force refetches)'; continue }
  let buf: Buffer
  try {
    if (s.manual) {
      const p = s.file ? safeChild(RAW_DIR, s.file) : null
      if (!p || !existsSync(p) || !lstatSync(p).isFile()) { row.where = 'manual'; row.verdict = `download it by hand from ${s.page} and save it as blueprints/downloaded/raw/${s.file ?? `${s.name}.schem`}`; continue }
      buf = readFileSync(p)
    } else {
      const wait = 1000 - (Date.now() - lastRequest)
      if (wait > 0) await sleep(wait) // GitHub asks for a crawl delay of 1 s
      lastRequest = Date.now()
      buf = await download(s.url!)
    }
  } catch (e) {
    row.verdict = `download failed: ${(e as Error).message}`
    continue
  }
  const sha = createHash('sha256').update(buf).digest('hex')
  if (s.sha256 && s.sha256 !== sha) { row.verdict = `sha256 mismatch (got ${sha}); not converted`; continue }
  if (values['keep-raw'] && !s.manual) {
    mkdirSync(RAW_DIR, { recursive: true })
    const ext = (/\.(schem|schematic|litematic|nbt|bp)$/i.exec(s.url ?? '')?.[1] ?? 'bin').toLowerCase()
    writeFileSync(join(RAW_DIR, `${s.name}.${ext}`), buf)
  }
  try {
    const st = await readSchematic(buf)
    const crop = s.crop ? parseBox(s.crop) ?? undefined : undefined
    const out = importStructure(st, {
      name: s.name,
      description: s.notes ? `${s.name.replace(/_/g, ' ')}: ${s.notes}` : undefined,
      facing: s.facing,
      anyWood: !s.exact,
      terrain: s.terrain,
      maxBlocks: s.max_blocks ?? 4000,
      ...(crop ? { crop } : {}),
      meta: { tags: s.tags, author: s.author, source: s.page, url: s.url ?? s.page, license: s.license, sha256: sha, created: today() }
    })
    const bp = parseBlueprint(out.yaml, s.name)
    row.size = `${out.width}x${out.depth}x${out.height}`
    row.blocks = out.blocks
    row.notes.push(...out.warnings)
    // what a survival bot makes of it
    const stuck = unplaceableCells(bp)
    const floating = floatingCells(bp)
    const roles = resolveRoles(bp, {})
    const wants = wantsForRoles(solidCells(bp.cells), roles)
    const cant = planWood(wants.required, {}).unsupported
    const modded = cant.filter(i => i.includes(':'))
    const problems: string[] = []
    if (stuck.length) problems.push(`${stuck.length} unplaceable`)
    if (floating.length) problems.push(`${floating.length} floating`)
    const cantBlocks = cant.reduce((n, i) => n + (wants.required[i] ?? 0), 0)
    if (cant.length) problems.push(`${cantBlocks} of ${out.blocks} blocks need items gather_materials can't make: ${cant.length - modded.length ? cant.filter(i => !i.includes(':')).slice(0, 6).join(', ') + (cant.length - modded.length > 6 ? ` +${cant.length - modded.length - 6}` : '') : ''}${modded.length ? `${cant.length - modded.length ? '; ' : ''}modded ${modded.join(', ')}` : ''}`)
    row.verdict = problems.length ? problems.join('; ') : 'survival: buildable with gather_materials'
    if (!values.check) writeLearned(resolve(outDir), s.name, out.yaml, true)
  } catch (e) {
    row.verdict = `can't convert: ${(e as Error).message}`
  }
}

// attribution for everything in the committed library: the license texts and a table
if (!values.check && !only) {
  const texts = new Map<string, string>()
  for (const s of sources.filter(x => x.redistribute && x.license_url)) {
    const m = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\//.exec(s.license_url!)
    texts.set(s.license_url!, m ? `${m[1]}-${m[2]}.txt` : `${s.name}.txt`)
  }
  mkdirSync(join(COMMUNITY_DIR, 'licenses'), { recursive: true })
  for (const [url, file] of texts) {
    try {
      const wait = 1000 - (Date.now() - lastRequest)
      if (wait > 0) await sleep(wait)
      lastRequest = Date.now()
      writeFileSync(join(COMMUNITY_DIR, 'licenses', file), await download(url))
    } catch (e) {
      console.error(`license text ${url}: ${(e as Error).message}`)
    }
  }
  const lines = ['# Blueprint library licenses', '', 'Generated by `just blueprint-fetch` from `blueprints/sources.yaml`. Each blueprint here is converted',
    'from the file at its source and stays under that file\'s license; the full texts are in `licenses/`.', '',
    '| blueprint | author | license | license text | source |', '|---|---|---|---|---|']
  for (const s of sources.filter(x => x.redistribute)) lines.push(`| ${s.name} | ${s.author} | ${s.license} | ${s.license_url ? `licenses/${texts.get(s.license_url)}` : '-'} | ${s.page} |`)
  mkdirSync(COMMUNITY_DIR, { recursive: true })
  writeFileSync(join(COMMUNITY_DIR, 'LICENSES.md'), lines.join('\n') + '\n')
}

const w = (s: string, n: number) => s.length >= n ? s : s + ' '.repeat(n - s.length)
console.log(`${w('blueprint', 24)} ${w('license', 18)} ${w('where', 20)} ${w('size', 9)} ${w('blocks', 6)} result`)
for (const r of rows) {
  console.log(`${w(r.name, 24)} ${w(r.license, 18)} ${w(r.where, 20)} ${w(r.size, 9)} ${w(String(r.blocks || ''), 6)} ${r.verdict}`)
  for (const n of r.notes) console.log(`${' '.repeat(26)}note: ${n}`)
}
if (rows.some(r => /failed|can't convert|mismatch/.test(r.verdict))) process.exitCode = 1
