import { test } from 'node:test'
import assert from 'node:assert/strict'
import { enchantsOf, enchantList } from '../src/skills/enchants.ts'
import { armorScore } from '../src/skills/tactics.ts'

test('enchantsOf: arrays, objects, maps and junk all come back as a list, never a throw', () => {
  assert.deepEqual(enchantsOf({ enchants: [{ name: 'protection', lvl: 2 }] }), [{ name: 'protection', lvl: 2 }])
  assert.deepEqual(enchantList({ 'minecraft:unbreaking': 3 }), [{ name: 'unbreaking', lvl: 3 }])
  assert.deepEqual(enchantList(new Map([['sharpness', 5]])), [{ name: 'sharpness', lvl: 5 }])
  assert.deepEqual(enchantList({ mending: { level: 1 } }), [{ name: 'mending', lvl: 1 }])
  for (const junk of [null, undefined, 7, 'x', true]) assert.deepEqual(enchantList(junk), [])
  assert.deepEqual(enchantsOf({ get enchants () { throw new Error('nbt') } }), [])
  assert.deepEqual(enchantsOf(null), [])
})

test('armour score: a piece with non-array enchants scores instead of crashing (Pax crashed on this)', () => {
  const s = armorScore({ name: 'iron_chestplate', enchants: { protection: 1 } as any })
  assert.ok(s && s.score > 0)
})
