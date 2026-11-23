// Where crafting tables and furnaces go (stationPlan): outside spawn protection, protected areas and refused spots.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  inSpawnProtection, stationSpotBlocked, rankStationSpots, leaveSpawnPoint, refusedPlacementText, isPlacementRefusal, spotKey
} from '../src/skills/stationPlan.ts'

// Pax, 23 Nov 2026: respawned at the world spawn (545 70 45) and tried to put a table at 544 78 47.
const spawn = { x: 545, z: 45 }

test('spawn protection: a square of 16 around the spawn block', () => {
  assert.ok(inSpawnProtection({ x: 544, z: 47 }, spawn))
  assert.ok(inSpawnProtection({ x: 561, z: 61 }, spawn), 'the corner of the square counts')
  assert.ok(!inSpawnProtection({ x: 562, z: 45 }, spawn))
  assert.ok(!inSpawnProtection({ x: 544, z: 47 }, spawn, 0), 'radius 0: none')
  assert.ok(!inSpawnProtection({ x: 544, z: 47 }, null), 'no spawn known')
  assert.ok(inSpawnProtection({ x: 529.7, z: 45 }, spawn), 'floored like block coordinates')
  assert.ok(!inSpawnProtection({ x: 528.7, z: 45 }, spawn))
})

test('station spots: spawn protection, protected areas and refused spots are skipped, nearest first', () => {
  const from = { x: 560.5, y: 70, z: 45.5 }
  const cands = [{ x: 561, y: 70, z: 45 }, { x: 562, y: 70, z: 45 }, { x: 563, y: 70, z: 46 }, { x: 562, y: 70, z: 44 }]
  const rules = { spawn, refused: new Set([spotKey({ x: 562, y: 70, z: 45 })]), isProtected: (p: { z: number }) => p.z === 44 }
  assert.equal(stationSpotBlocked(cands[0]!, rules), 'inside spawn protection')
  assert.equal(stationSpotBlocked(cands[1]!, rules), 'the server refused it before')
  assert.equal(stationSpotBlocked(cands[3]!, rules), 'in a protected area')
  assert.deepEqual(rankStationSpots(cands, from, rules), [cands[2]])
  assert.deepEqual(rankStationSpots(cands, from, {}).map(c => c.x), [561, 562, 562, 563], 'no rules: nearest first')
  assert.equal(rankStationSpots(cands, from, { spawn, spawnRadius: 30 }).length, 0)
})

test('leaving spawn protection: out through the nearest side', () => {
  const out = leaveSpawnPoint({ x: 544.5, z: 58.5 }, spawn)!
  assert.equal(out.x, 544.5)
  assert.equal(out.z, 45 + 20 + 0.5, 'south side, 3 past the edge')
  const west = leaveSpawnPoint({ x: 533.5, z: 47.5 }, spawn)!
  assert.equal(west.x, 545 - 20 + 0.5)
  assert.ok(!inSpawnProtection(out, spawn) && !inSpawnProtection(west, spawn))
  assert.equal(leaveSpawnPoint({ x: 600, z: 45 }, spawn), null, 'already outside')
  assert.equal(leaveSpawnPoint({ x: 545, z: 45 }, null), null)
})

test('refused placements: a message that says the server refused it, not the snow', () => {
  const raw = 'could not place crafting_table: Server refused to place crafting_table at (544, 78, 47): the block is still snow'
  assert.ok(isPlacementRefusal(raw))
  assert.ok(!isPlacementRefusal('nothing solid next to that spot to place against'))
  const t = refusedPlacementText('crafting_table', { x: 544, y: 78, z: 47 }, { spawn })
  assert.match(t, /server refused to place crafting_table at 544 78 47/)
  assert.match(t, /spawn protection: 2 blocks from the world spawn/)
  assert.doesNotMatch(t, /snow/)
  assert.match(refusedPlacementText('furnace', { x: 900, y: 70, z: 45 }, { spawn }), /protected area or claim/)
})
