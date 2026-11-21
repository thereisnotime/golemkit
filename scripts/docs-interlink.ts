// Adds in-text cross links to the docs: the first mention of each key concept on a page links
// to the page that explains it. Skips code blocks, inline code, headings, existing links,
// frontmatter and links to the page itself. Safe to re-run (already linked terms are left alone).
//   node scripts/docs-interlink.ts [--dry]
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const DOCS = 'docs'
const SKIP = new Set(['index.md', 'reference/actions.md'])

/** term (regex source, case-insensitive) -> target. Longer/more specific terms first. */
const TERMS: [string, string][] = [
  ['feature toggles?', '/guide/live-config'],
  ['config_set', '/guide/live-config'],
  ['game modes?', '/concepts/world#game-modes'],
  ['bunker', '/concepts/world#phantoms-bunker'],
  ['idle_antics', '/guide/behaviors'],
  ['action lock', '/concepts/architecture#the-action-lock-and-priorities'],
  ['context packs?', '/guide/context-pack'],
  ['hooks\\.yaml', '/guide/context-pack'],
  ['event journal', '/guide/journal'],
  ['journal', '/guide/journal'],
  ['behaviou?rs brain', '/guide/behaviors'],
  ['armable behaviou?rs', '/guide/behaviors'],
  ['armed behaviou?rs', '/guide/behaviors'],
  ['keep_fed', '/guide/behaviors'],
  ['persistent goals?', '/guide/goals-and-building#goals'],
  ['blueprint librar(?:y|ies)', '/guide/blueprints'],
  ['WorldEdit', '/guide/worldedit'],
  ['learned blueprints?', '/guide/blueprints#libraries'],
  ['building policy', '/guide/blueprints#building-policy'],
  ['schematic import', '/guide/blueprints#import'],
  ['schematics?', '/guide/blueprints#import'],
  ['blueprint capture', '/guide/blueprints#capture'],
  ['blueprints?', '/guide/goals-and-building#blueprint-format'],
  ['NPC brain', '/guide/npc-brain'],
  ['LLM brain', '/guide/llm-brain'],
  ['scene brain', '/guide/scenes'],
  ['self-improver', '/guide/self-improver'],
  ['Apprentice', '/guide/self-improver'],
  ['MCP bridge', '/guide/llm-brain'],
  ['protected areas?', '/concepts/world#protected-areas'],
  ['spawn protection', '/concepts/world#protected-areas'],
  ['long-distance travel', '/concepts/world#long-distance-travel'],
  ['reflexes', '/concepts/world#reflexes'],
  ['flying mobs', '/concepts/world#hostile-mobs'],
  ['registry sync', '/concepts/neoforge#_4-modded-item-and-entity-names'],
  ['channel negotiation', '/concepts/neoforge#_1-channel-negotiation'],
  ['NeoForge layer', '/concepts/neoforge'],
  ['humanize', '/guide/profiles#humanize-player-like-timing'],
  ['immersive mode', '/guide/profiles#factual-vs-immersive'],
  ['listen modes?', '/guide/profiles#llm-listening-modes'],
  ['retries', '/guide/profiles#retries'],
  ['caveman', '/guide/profiles#llm-proxy-caveman-or-a-gateway'],
  ['login profiles?', '/guide/llm-brain#login-profiles-isolation-from-your-own-setup'],
  ['level spec', '/guide/logging#levels'],
  ['profiles?', '/guide/profiles'],
  ['variants?', '/concepts/variants-profiles'],
  ['fleet files?', '/guide/running#a-fleet'],
  ['fleets?', '/concepts/architecture#fleets-and-multiple-servers'],
  ['blackboard', '/concepts/architecture#fleets-and-multiple-servers'],
  ['scenes?', '/guide/scenes'],
  ['action reference', '/reference/actions'],
  ['priorities', '/concepts/architecture#the-action-lock-and-priorities']
]

function walk (dir: string): string[] {
  return readdirSync(dir).flatMap(f => {
    const p = join(dir, f)
    if (f.startsWith('.')) return []
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.md') ? [p] : []
  })
}

/** "/guide/profiles" for docs/guide/profiles.md */
function pageRoute (file: string): string {
  return '/' + relative(DOCS, file).replace(/\.md$/, '').replace(/(^|\/)index$/, '')
}

/** Splits a prose line into segments we may edit (plain text) and ones we must not (code, links). */
function protectedSpans (line: string): [number, number][] {
  const spans: [number, number][] = []
  for (const re of [/`[^`]*`/g, /\[[^\]]*\]\([^)]*\)/g, /<[^>]+>/g, /https?:\/\/\S+/g]) {
    for (const m of line.matchAll(re)) spans.push([m.index!, m.index! + m[0].length])
  }
  return spans
}

let changedFiles = 0
let added = 0
const dry = process.argv.includes('--dry')

for (const file of walk(DOCS)) {
  const rel = relative(DOCS, file)
  if (SKIP.has(rel)) continue
  const route = pageRoute(file)
  const lines = readFileSync(file, 'utf8').split('\n')
  const linkedTargets = new Set<string>()
  // Targets already linked anywhere on the page count as done.
  for (const l of lines) for (const m of l.matchAll(/\]\((\/[^)#]*)(#[^)]*)?\)/g)) linkedTargets.add(m[1]! + (m[2] ?? ''))
  let inCode = false
  let inFront = lines[0] === '---'
  let changed = false
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!
    if (inFront) { if (i > 0 && line === '---') inFront = false; continue }
    if (/^\s*(```|~~~)/.test(line)) { inCode = !inCode; continue }
    if (inCode || /^\s*#/.test(line) || /^\s*\|?\s*-{3,}/.test(line) || /^\s*<!--/.test(line)) continue
    for (const [term, target] of TERMS) {
      const targetPage = target.split('#')[0]!
      if (targetPage === route || linkedTargets.has(target) || linkedTargets.has(targetPage)) continue
      const re = new RegExp(`(?<![\\w/#-])(${term})(?![\\w-])`, 'i')
      const spans = protectedSpans(line)
      const m = re.exec(line)
      if (!m) continue
      const at = m.index
      if (spans.some(([a, b]) => at >= a && at < b)) continue
      line = line.slice(0, at) + `[${m[1]}](${target})` + line.slice(at + m[1]!.length)
      linkedTargets.add(target)
      linkedTargets.add(targetPage)
      added++
      changed = true
    }
    lines[i] = line
  }
  if (changed) {
    changedFiles++
    if (!dry) writeFileSync(file, lines.join('\n'))
  }
}
console.log(`${dry ? '(dry) ' : ''}added ${added} links in ${changedFiles} files`)
