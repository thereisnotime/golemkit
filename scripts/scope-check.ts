// Where does the code touch Minecraft? Counts, per directory, the TypeScript files that import a
// Mineflayer / PrismarineJS package and the files that reach into the bot (agent.bot, bot.entity,
// ...), then lists files outside src/adapters, src/skills and scripts that import one of
// those packages. Informational only: it always exits 0. See docs/concepts/scope.md.
//   node scripts/scope-check.ts [--files]
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOTS = ['src', 'variants', 'scripts']
/** directories where Minecraft packages are expected (today and after the adapter split) */
const EXPECTED = ['src/adapters/', 'src/skills/', 'scripts/']

const GAME_IMPORT = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](mineflayer(?:-[\w-]+)?|prismarine-[\w-]+|minecraft-[\w-]+|vec3)['"]/g
// direct use of the Mineflayer bot: agent.bot / ctx.bot / this.bot, or the bot's own state and calls
const BOT_TOUCH = /\b(?:agent|ctx|this|a|self)\.bot\b|\bbot\.(?:entity|entities|inventory|pathfinder|blockAt|findBlocks?|registry|players|game|time|health|food|dig|placeBlock|equip|attack|lookAt|setControlState|heldItem|world|on|once)\b/

function walk (dir: string): string[] {
  let names: string[]
  try { names = readdirSync(dir) } catch { return [] }
  return names.flatMap(n => {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) return n === 'node_modules' ? [] : walk(p)
    return p.endsWith('.ts') ? [p] : []
  })
}

/** group a file the way the scope page's table does */
function group (file: string): string {
  const parts = file.split('/')
  if (parts[0] !== 'src') return parts[0] + '/'
  if (parts.length === 2) return 'src/ (top level)'
  if (parts[1] === 'core' && parts.length > 3) return `src/core/${parts[2]}/`
  if (parts[1] === 'core') return 'src/core/ (top level)'
  if (parts[1] === 'brains' && parts.length > 3) return `src/brains/${parts[2]}/`
  if (parts[1] === 'brains') return 'src/brains/ (top level)'
  if (parts[1] === 'adapters' && parts.length > 3) return `src/adapters/${parts[2]}/`
  return `src/${parts[1]}/`
}

interface Row { files: number, imports: number, touches: number, either: number }
const rows = new Map<string, Row>()
const outside: { file: string, pkgs: string[] }[] = []
const showFiles = process.argv.includes('--files')
const perFile: string[] = []

for (const file of ROOTS.flatMap(walk).sort()) {
  if (file === 'scripts/scope-check.ts') continue
  const text = readFileSync(file, 'utf8')
  const pkgs = [...new Set([...text.matchAll(GAME_IMPORT)].map(m => m[1]!))]
  // comment lines don't count (doc comments may say "ctx.bot")
  const code = text.split('\n').filter(l => !/^\s*(\*|\/\*|\/\/)/.test(l)).map(l => l.replace(/\s\/\/.*$/, '')).join('\n')
  const touches = BOT_TOUCH.test(code)
  const g = group(file)
  const r = rows.get(g) ?? { files: 0, imports: 0, touches: 0, either: 0 }
  r.files++
  if (pkgs.length) r.imports++
  if (touches) r.touches++
  if (pkgs.length || touches) r.either++
  rows.set(g, r)
  if (pkgs.length && !EXPECTED.some(d => file.startsWith(d))) outside.push({ file, pkgs })
  if (showFiles && (pkgs.length || touches)) perFile.push(`  ${file}${pkgs.length ? '  imports ' + pkgs.join(', ') : ''}${touches ? '  touches bot' : ''}`)
}

const pad = (s: string | number, n: number) => String(s).padEnd(n)
console.log(pad('directory', 30) + pad('files', 7) + pad('import', 8) + pad('bot use', 9) + 'either')
for (const [g, r] of [...rows].sort((a, b) => a[0].localeCompare(b[0]))) {
  console.log(pad(g, 30) + pad(r.files, 7) + pad(r.imports, 8) + pad(r.touches, 9) + `${r.either}/${r.files}`)
}
console.log('\nimport = imports mineflayer*, prismarine-*, minecraft-* or vec3; bot use = agent.bot, bot.entity, bot.inventory, ...')

console.log(`\nFiles importing Minecraft packages outside ${EXPECTED.join(', ')} (${outside.length}):`)
for (const o of outside) console.log(`  ${o.file}  (${o.pkgs.join(', ')})`)
if (showFiles) { console.log('\nAll files that import or touch the bot:'); console.log(perFile.join('\n')) }
