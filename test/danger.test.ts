import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  rememberDanger, activeZones, isInDanger, avoidZones, crossesDanger, clearDanger, DangerMemory, dangerMemory, describeZone,
  DANGER_TTL_MS, PATROL_TTL_MS, type DangerZone
} from '../src/core/danger.ts'

const MIN = 60_000

test('danger zones: a sighting is remembered for a few minutes, a patrol longer', () => {
  let zones: DangerZone[] = []
  zones = rememberDanger(zones, { x: 100, y: 64, z: 0, kind: 'skeleton', radius: 24 }, 0)
  zones = rememberDanger(zones, { x: -200, y: 64, z: 0, kind: 'patrol', radius: 32, count: 4 }, 0)
  assert.equal(zones.length, 2)
  assert.ok(isInDanger(zones, { x: 110, z: 10 }, 1 * MIN))
  assert.equal(isInDanger(zones, { x: 130, z: 0 }, 1 * MIN), null, '30 blocks out is outside a 24 radius')
  assert.ok(isInDanger(zones, { x: 130, z: 0 }, 1 * MIN, 8), 'with a margin it counts')
  assert.equal(isInDanger(zones, { x: 100, z: 0 }, DANGER_TTL_MS + 1), null, 'the skeleton is forgotten after 5 min')
  assert.equal(isInDanger(zones, { x: -200, z: 0 }, DANGER_TTL_MS + 1)?.kind, 'patrol', 'the patrol is still remembered')
  assert.equal(isInDanger(zones, { x: -200, z: 0 }, PATROL_TTL_MS + 1), null)
  assert.equal(activeZones(zones, PATROL_TTL_MS + 1).length, 0)
})

test('danger zones: seeing the same shooter again refreshes its zone instead of adding one', () => {
  let zones: DangerZone[] = []
  zones = rememberDanger(zones, { x: 0, y: 64, z: 0, kind: 'pillager' }, 0)
  zones = rememberDanger(zones, { x: 3, y: 64, z: 2, kind: 'pillager' }, 4 * MIN)
  assert.equal(zones.length, 1)
  assert.equal(zones[0]!.x, 3, 'moved to the latest sighting')
  assert.ok(isInDanger(zones, { x: 3, z: 2 }, 8 * MIN), 'kept 5 min from the last sighting')
  // another kind at the same place is its own zone
  zones = rememberDanger(zones, { x: 3, y: 64, z: 2, kind: 'witch' }, 4 * MIN)
  assert.equal(zones.length, 2)
})

test('danger zones: waypoints inside are left out, in order', () => {
  const zones = rememberDanger([], { x: 0, y: 64, z: 0, kind: 'patrol', radius: 32 }, 0)
  const wps = [{ x: 10, z: 0, id: 1 }, { x: 50, z: 0, id: 2 }, { x: -20, z: 20, id: 3 }, { x: 0, z: -60, id: 4 }]
  assert.deepEqual(avoidZones(wps, zones, MIN).map(w => w.id), [2, 4])
})

test('danger zones: a walk through a zone counts, a walk out of one does not', () => {
  const zones = rememberDanger([], { x: 0, y: 64, z: 0, kind: 'skeleton', radius: 20 }, 0)
  assert.ok(crossesDanger({ x: -50, z: 5 }, { x: 50, z: 5 }, zones, MIN), 'straight through the middle')
  assert.equal(crossesDanger({ x: -50, z: 30 }, { x: 50, z: 30 }, zones, MIN), null, 'passes 30 blocks off')
  assert.equal(crossesDanger({ x: 5, z: 0 }, { x: 60, z: 0 }, zones, MIN), null, 'getting out is fine')
  assert.ok(crossesDanger({ x: 15, z: 0 }, { x: 2, z: 0 }, zones, MIN), 'deeper in is not')
})

test('danger zones: a kill clears the zone, memory per owner with a clock', () => {
  let zones = rememberDanger([], { x: 0, y: 64, z: 0, kind: 'skeleton' }, 0)
  zones = rememberDanger(zones, { x: 100, y: 64, z: 0, kind: 'skeleton' }, 0)
  zones = clearDanger(zones, { x: 2, z: 1 }, 8, 'skeleton')
  assert.equal(zones.length, 1)
  assert.equal(zones[0]!.x, 100)

  const owner = {}
  const m = dangerMemory(owner)
  assert.equal(dangerMemory(owner), m, 'one memory per owner')
  assert.notEqual(dangerMemory({}), m)
  let t = 0
  m.now = () => t
  m.remember({ x: 0, y: 64, z: 0, kind: 'pillager', radius: 24 })
  assert.ok(m.isInDanger({ x: 10, z: 10 }))
  assert.deepEqual(m.avoid([{ x: 5, z: 5 }, { x: 40, z: 0 }]), [{ x: 40, z: 0 }])
  assert.ok(m.crosses({ x: -40, z: 0 }, { x: 40, z: 0 }))
  assert.match(describeZone(m.active()[0]!, 0), /pillager at 0 0/)
  t = DANGER_TTL_MS + 1
  assert.equal(m.isInDanger({ x: 10, z: 10 }), null)
  assert.ok(m instanceof DangerMemory)
})
