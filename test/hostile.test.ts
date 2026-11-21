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
