// Prints a blueprint as text: top view, every layer and a legend, plus its materials.
//   node scripts/blueprint-preview.ts cottage [east] [--top]
//   node scripts/blueprint-preview.ts            (lists the blueprints)
import { loadBlueprints, renderBlueprint, rotate, resolveRoles, materials, fmtMaterials, solidCells, FACINGS, type Facing } from '../src/skills/blueprint.ts'

const args = process.argv.slice(2)
const top = args.includes('--top')
const [name, facing] = args.filter(a => !a.startsWith('--'))
const { blueprints, errors } = loadBlueprints()
for (const e of errors) console.error(`broken: ${e}`)
if (!name) {
  for (const b of blueprints.values()) console.log(`${b.name.padEnd(14)} ${b.width}x${b.depth}x${b.height}  ${String(solidCells(b.cells).length).padStart(4)} blocks  ${b.description}`)
  process.exit(0)
}
const bp = blueprints.get(name)
if (!bp) { console.error(`unknown blueprint ${name}; known: ${[...blueprints.keys()].join(', ')}`); process.exit(1) }
if (facing && !FACINGS.includes(facing as Facing)) { console.error(`facing must be one of ${FACINGS.join(', ')}`); process.exit(1) }
const turned = facing ? rotate(bp, facing as Facing) : bp
console.log(renderBlueprint(turned, { layers: !top }))
console.log(`materials: ${fmtMaterials(materials(turned.cells, resolveRoles(turned, {}), {}))}`)
