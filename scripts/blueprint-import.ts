// Converts a schematic (Sponge/WorldEdit .schem, legacy .schematic, Litematica .litematic, structure .nbt, Axiom .bp)
// into a blueprint. The format is read from the content, not the extension.
//   node scripts/blueprint-import.ts <file> [--name tower] [--crop "x1 y1 z1 x2 y2 z2"] [--max-blocks 4000]
//        [--no-air] [--no-terrain] [--exact] [--facing south] [--tags house,stone] [--out <dir> | --bot <username>] [--force]
// Without --out or --bot it prints the YAML and a preview. --bot writes into that bot's learned
// library (data/bots/<username>/blueprints/), --out into any folder (e.g. one listed in
// settings.build.blueprintDirs).
import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { parseBlueprint, renderBlueprint, FACINGS, type Facing } from '../src/skills/blueprint.ts'
import { readSchematic, importStructure, parseBox } from '../src/skills/schematic.ts'
import { writeLearned, guessTags, checkName, today } from '../src/skills/blueprint-library.ts'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: 'string' },
    crop: { type: 'string' },
    'max-blocks': { type: 'string', default: '4000' },
    'no-air': { type: 'boolean', default: false },
    'no-terrain': { type: 'boolean', default: false },
    exact: { type: 'boolean', default: false },
    facing: { type: 'string' },
    tags: { type: 'string' },
    description: { type: 'string' },
    out: { type: 'string' },
    bot: { type: 'string' },
    force: { type: 'boolean', default: false }
  }
})

const die = (msg: string): never => { console.error(msg); process.exit(1) }
const file = positionals[0] ?? die('usage: blueprint-import <file.schem|.schematic|.litematic|.nbt|.bp> [--name x] [--crop "x1 y1 z1 x2 y2 z2"] [--max-blocks n] [--no-air] [--no-terrain] [--facing f] [--tags a,b] [--out dir | --bot name]')
const name = (values.name ?? basename(file).replace(/\.[^.]+$/, '')).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
const bad = checkName(name)
if (bad) die(bad)
if (values.facing && !FACINGS.includes(values.facing as Facing)) die(`--facing must be one of ${FACINGS.join(', ')}`)
const crop = values.crop ? parseBox(values.crop) ?? die('--crop takes six whole numbers: "x1 y1 z1 x2 y2 z2"') : undefined

try {
  const s = await readSchematic(readFileSync(file))
  const names = [...new Set(s.palette.map(e => e.name.replace(/^minecraft:/, '')))]
  const tags = values.tags ? values.tags.split(',').map(t => t.trim()).filter(Boolean) : guessTags(`${name} ${values.description ?? ''}`, names)
  const out = importStructure(s, {
    name, description: values.description, facing: values.facing as Facing | undefined, air: !values['no-air'], terrain: !values['no-terrain'], anyWood: !values.exact, maxBlocks: Number(values['max-blocks']), ...(crop ? { crop } : {}),
    meta: { tags, author: process.env.USER ?? 'cli', source: `imported from ${basename(file)} (${s.format})`, created: today() }
  })
  const bp = parseBlueprint(out.yaml, name)
  const yaml = out.yaml
  for (const w of out.warnings) console.error(`warning: ${w}`)
  console.error(`${s.format}: ${s.width}x${s.depth}x${s.height} -> ${name}: ${out.width}x${out.depth}x${out.height}, ${out.blocks} blocks, entrance ${out.facing}`)
  const dir = values.bot ? resolve('data', 'bots', values.bot, 'blueprints') : values.out ? resolve(values.out) : null
  if (!dir) {
    console.log(yaml)
    console.error(renderBlueprint(bp, { layers: false }))
  } else {
    console.error(`wrote ${writeLearned(dir, name, yaml, values.force)}`)
  }
} catch (e) {
  die(`can't import ${file}: ${(e as Error).message}`)
}
