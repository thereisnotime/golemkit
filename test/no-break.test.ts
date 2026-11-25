// Pathfinder must not tunnel through beds, storage, workstations, doors, lights or farmland:
// Pax walked home through its own bed and lost its respawn point every few minutes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { keepWhenPathing, protectFromPathing } from '../src/adapters/minecraft-java/noBreak.ts'

const require = createRequire(import.meta.url)
const registry = require('prismarine-registry')('1.21.1')

test('beds, storage, workstations, doors and lights are kept', () => {
  for (const n of ['red_bed', 'white_bed', 'chest', 'barrel', 'furnace', 'crafting_table', 'oak_door',
    'spruce_trapdoor', 'oak_fence_gate', 'torch', 'wall_torch', 'lantern', 'farmland', 'oak_sign',
    'shulker_box', 'blue_shulker_box', 'glass', 'red_stained_glass']) assert.ok(keepWhenPathing(n), n)
})

test('ordinary terrain stays diggable', () => {
  for (const n of ['dirt', 'stone', 'cobblestone', 'snow', 'snow_block', 'oak_log', 'oak_leaves',
    'sand', 'gravel', 'grass_block', 'bedrock_is_not_here', 'oak_planks']) assert.ok(!keepWhenPathing(n), n)
})

test('every bed in the 1.21.1 registry lands in blocksCantBreak', () => {
  const moves = { blocksCantBreak: new Set<number>() }
  const n = protectFromPathing({ registry } as any, moves)
  assert.ok(n > 50)
  const beds = Object.values(registry.blocksByName).filter((b: any) => b.name.endsWith('_bed')) as { id: number }[]
  assert.equal(beds.length, 16)
  for (const b of beds) assert.ok(moves.blocksCantBreak.has(b.id))
  assert.ok(!moves.blocksCantBreak.has(registry.blocksByName.dirt.id))
})
