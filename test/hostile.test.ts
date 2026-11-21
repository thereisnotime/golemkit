import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isHostile, FLYING } from '../src/core/helpers.ts'

const e = (name: string, type: string) => ({ name, type, isValid: true }) as any

test('hostile classification covers mobs minecraft-data types as plain "mob"', () => {
  for (const n of ['phantom', 'ghast', 'slime', 'magma_cube', 'shulker', 'hoglin']) assert.equal(isHostile(e(n, 'mob')), true, n)
  assert.equal(isHostile(e('zombie', 'hostile')), true)
  for (const n of ['enderman', 'piglin', 'zombified_piglin']) assert.equal(isHostile(e(n, 'hostile')), false, `${n} is neutral`)
  assert.equal(isHostile(e('cow', 'animal')), false)
  assert.equal(isHostile({ ...e('zombie', 'hostile'), isValid: false }), false)
  assert.ok(FLYING.has('phantom'))
})

test('protected areas need two refusals close together (one can be lag)', async () => {
  const { ProtectedAreas } = await import('../src/core/protection.ts')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const pa = new ProtectedAreas(join(tmpdir(), `mcb-prot-${process.pid}.json`))
  assert.equal(pa.add({ x: 100, y: 64, z: 100 }), false, 'first refusal is only a suspect')
  assert.equal(pa.isProtected({ x: 100, y: 64, z: 100 }), false)
  assert.equal(pa.add({ x: 300, y: 64, z: 300 }), false, 'far away: another suspect')
  assert.equal(pa.add({ x: 103, y: 64, z: 101 }), true, 'second nearby refusal confirms')
  assert.equal(pa.isProtected({ x: 110, y: 64, z: 110 }), true)
  assert.equal(pa.add({ x: 500, y: 64, z: 500 }, { confirmed: true }), true)
})
