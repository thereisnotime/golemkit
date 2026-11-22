// Golden snapshots: a value is compared with test/fixtures/golden/<name>.json. Run the tests with
// UPDATE_GOLDEN=1 to write the files, and only when a change is intended (say why in the commit).
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export const GOLDEN_DIR = join(import.meta.dirname, 'fixtures', 'golden')

export function matchGolden (name: string, value: unknown): void {
  const file = join(GOLDEN_DIR, `${name}.json`)
  const text = JSON.stringify(value, null, 2) + '\n'
  if (process.env.UPDATE_GOLDEN === '1') {
    mkdirSync(GOLDEN_DIR, { recursive: true })
    writeFileSync(file, text)
    return
  }
  assert.ok(existsSync(file), `no golden file ${file}; run with UPDATE_GOLDEN=1 to create it`)
  assert.deepEqual(JSON.parse(text), JSON.parse(readFileSync(file, 'utf8')), `${name} differs from ${file}`)
}
