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

test('adaptive weapon choice', async () => {
  const { pickMelee, hitDamage } = await import('../src/skills/weapons.ts')
  const sword = { name: 'iron_sword', damage: 6, speed: 1.6, enchants: [] }
  const axe = { name: 'iron_axe', damage: 9, speed: 0.9, enchants: [] }
  const smite = { name: 'stone_sword', damage: 5, speed: 1.6, enchants: [{ name: 'smite', lvl: 3 }] }
  assert.equal(pickMelee([sword, axe], { name: 'spider' })!.name, 'iron_sword', 'higher DPS by default')
  assert.equal(pickMelee([sword, axe], { name: 'spider', health: 8 })!.name, 'iron_axe', 'axe finishes in one hit')
  assert.equal(pickMelee([sword, axe], { name: 'vindicator', shielded: true })!.name, 'iron_axe', 'axe vs shield')
  assert.equal(pickMelee([sword, smite], { name: 'zombie' })!.name, 'stone_sword', 'smite vs undead')
  assert.equal(hitDamage(smite, 'spider'), 5, 'smite does nothing to spiders')
  assert.equal(pickMelee([], { name: 'zombie' }), null)
})
