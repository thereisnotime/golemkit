import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { Writer } from '../src/adapters/minecraft-java/platforms/neoforge/codec.ts'
import { decodeFrozenRegistry, RegistryCache, applyModdedRegistries } from '../src/adapters/minecraft-java/platforms/neoforge/registries.ts'

const require = createRequire(import.meta.url)
const Registry = require('prismarine-registry')

function payload (name: string, ids: [number, string][], aliases: [string, string][] = []): Buffer {
  const w = new Writer().string(name).varint(ids.length)
  for (const [id, n] of ids) w.varint(id).string(n)
  w.varint(aliases.length)
  for (const [a, b] of aliases) w.string(a).string(b)
  return w.buffer()
}

test('decodes a frozen registry payload', () => {
  const snap = decodeFrozenRegistry(payload('minecraft:item', [[0, 'minecraft:air'], [1400, 'create:andesite_alloy']], [['old:x', 'create:andesite_alloy']]))
  assert.equal(snap.name, 'minecraft:item')
  assert.equal(snap.ids[1400], 'create:andesite_alloy')
  assert.equal(snap.aliases['old:x'], 'create:andesite_alloy')
})

test('applies modded items/entities per bot without touching shared minecraft-data maps', () => {
  const cache = new RegistryCache(join(tmpdir(), `mcb-reg-${process.pid}.json`))
  const a = Registry('1.21.1')
  const b = Registry('1.21.1')
  const vanillaZombie = Number(Object.values(a.entitiesByName as Record<string, { id: number }>).find(e => (e as any).name === 'zombie')!.id)
  cache.add(decodeFrozenRegistry(payload('minecraft:item', [[1, 'minecraft:stone'], [5000, 'create:andesite_alloy']])))
  cache.add(decodeFrozenRegistry(payload('minecraft:entity_type', [
    [vanillaZombie, 'minecraft:zombie'], [900, 'ars_nouveau:wilden_hunter'], [901, 'ars_nouveau:starbuncle'], [902, 'create:contraption']
  ])))
  const r = applyModdedRegistries(a, cache, { hostile: ['create:none'] })
  assert.equal(r.items, 1)
  assert.equal(r.entities, 3)
  assert.deepEqual(r.mismatches, [])
  assert.equal(a.items[5000].name, 'create:andesite_alloy')
  assert.equal(a.itemsByName['create:andesite_alloy'].displayName, 'Andesite Alloy')
  assert.equal(a.entities[900].type, 'hostile')
  assert.equal(a.entities[901].type, 'mob')
  assert.equal(a.entities[902].type, 'object')
  assert.equal(b.items[5000], undefined, 'other bots keep the plain vanilla registry')
})

test('reports vanilla id mismatches', () => {
  const cache = new RegistryCache(join(tmpdir(), `mcb-reg2-${process.pid}.json`))
  cache.add(decodeFrozenRegistry(payload('minecraft:item', [[1, 'minecraft:dirt']])))
  const r = applyModdedRegistries(Registry('1.21.1'), cache)
  assert.equal(r.mismatches.length, 1)
})
