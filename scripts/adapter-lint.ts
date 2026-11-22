// The game-adapter line as a check: game-agnostic code (src/core, src/llm, src/context,
// src/brains, src/cli.ts) must not import Minecraft packages or reach into the Mineflayer bot.
// src/adapters/ and the Minecraft skills (src/skills/) are where that belongs; variants and
// scripts are Minecraft examples and live tests. See docs/concepts/adapters.md.
//   node scripts/adapter-lint.ts [--warn]     --warn reports without failing
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const CHECKED = ['src/core', 'src/llm', 'src/context', 'src/brains', 'src/cli.ts']
// the same patterns as scripts/scope-check.ts
const GAME_IMPORT = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](mineflayer(?:-[\w-]+)?|prismarine-[\w-]+|minecraft-[\w-]+|vec3)['"]/
const BOT_TOUCH = /\b(?:agent|ctx|this|a|self)\.bot\b|\bbot\.(?:entity|entities|inventory|pathfinder|blockAt|findBlocks?|registry|players|game|time|health|food|dig|placeBlock|equip|attack|lookAt|setControlState|heldItem|world|on|once)\b/

function walk (p: string): string[] {
  let st
  try { st = statSync(p) } catch { return [] }
  if (!st.isDirectory()) return p.endsWith('.ts') ? [p] : []
  return readdirSync(p).flatMap(n => walk(join(p, n)))
}

const warnOnly = process.argv.includes('--warn')
const hits: string[] = []
for (const file of CHECKED.flatMap(walk).sort()) {
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    const imp = GAME_IMPORT.exec(line)
    if (imp) hits.push(`${file}:${i + 1}: imports ${imp[1]}`)
    else if (BOT_TOUCH.test(line)) hits.push(`${file}:${i + 1}: touches the Mineflayer bot: ${line.trim().slice(0, 100)}`)
  })
}
const files = new Set(hits.map(h => h.split(':')[0]))
for (const h of hits) console.log(`${warnOnly ? 'warning' : 'error'} ${h}`)
console.log(`adapter-lint: ${hits.length} violation(s) in ${files.size} file(s) outside src/adapters and src/skills${warnOnly ? ' (warnings)' : ''}`)
process.exit(hits.length && !warnOnly ? 1 : 0)
