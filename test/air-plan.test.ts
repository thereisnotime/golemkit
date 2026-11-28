import { test } from 'node:test'
import assert from 'node:assert/strict'
import { airPlan, airTrigger, airThreshold, airDone, airSettings, waterStepCost, UNDER_ICE_COST, UNDER_ROOF_COST, SUBMERGED_COST, type AirCell, type V } from '../src/skills/airPlan.ts'
import { mayReplace } from '../src/skills/reflexPlan.ts'

const AIR: AirCell = { kind: 'air', name: 'air' }
const WATER: AirCell = { kind: 'water', name: 'water' }
const stone = (o: Partial<AirCell> = {}): AirCell => ({ kind: 'solid', name: 'stone', breakable: true, digMs: 37_500, ...o })
const ice = (o: Partial<AirCell> = {}): AirCell => ({ kind: 'solid', name: 'ice', breakable: true, digMs: 3750, ...o })

/**
 * A pool 9x9 (x, z in -4..4), water from y -3 to `top`, stone around and below, air above y top+1
 * unless `lid` says otherwise. The head is at 0 0 0.
 */
function pool (top: number, lid: (p: V) => AirCell | undefined = () => undefined) {
  return (p: V): AirCell => {
    const inside = Math.abs(p.x) <= 4 && Math.abs(p.z) <= 4
    if (p.y > top) {
      const l = lid(p)
      if (l) return l
      return AIR
    }
    if (inside && p.y >= -3) return WATER
    return stone()
  }
}
const head = { x: 0, y: 0, z: 0 }

test('air: open water straight up', () => {
  const r = airPlan({ head, cell: pool(2) })
  assert.equal(r.act, 'up')
  assert.deepEqual((r as any).to, { x: 0, y: 3, z: 0 })
})

test('air: ice above is broken, then up through the hole', () => {
  // ice over the whole pool at y 3, air above
  const r = airPlan({ head, cell: pool(2, p => p.y === 3 ? ice() : undefined) })
  assert.equal(r.act, 'break')
  assert.deepEqual((r as any).block, { x: 0, y: 3, z: 0 })
  assert.match(r.why, /break ice above, then up to 4/)
})

test('air: an opening to the side beats digging through a stone roof', () => {
  // stone roof at y 3 except a hole at x 4; stone above the roof
  const r = airPlan({ head, cell: pool(2, p => p.y === 3 && !(p.x === 4 && p.z === 0) ? stone() : undefined) })
  assert.equal(r.act, 'swim')
  assert.deepEqual((r as any).to, { x: 4, y: 3, z: 0 })
  assert.equal((r as any).dist, 7)
})

test('air: protected ice is left alone, swims to another opening', () => {
  const r = airPlan({ head, cell: pool(2, p => p.y === 3 && !(p.x === -4 && p.z === -4) ? ice({ protected: true, breakable: false }) : undefined) })
  assert.equal(r.act, 'swim')
  assert.deepEqual((r as any).to, { x: -4, y: 3, z: -4 })
  assert.match(r.why, /protected/)
})

test('air: protected ice and no opening: nothing to do', () => {
  const r = airPlan({ head, cell: pool(2, p => p.y === 3 ? ice({ protected: true, breakable: false }) : undefined) })
  assert.equal(r.act, 'none')
  assert.match(r.why, /protected/)
})

test('air: a solid stone roof with no opening: dig up into it for an air pocket', () => {
  const r = airPlan({ head, cell: pool(2, p => p.y <= 6 ? stone() : undefined) })
  assert.equal(r.act, 'break')
  assert.deepEqual((r as any).block, { x: 0, y: 3, z: 0 })
  assert.match(r.why, /air pocket/)
})

test('air: a roof out of reach or without digging: swim up blind', () => {
  // head deep: roof 6 above, no digging
  const r = airPlan({ head: { x: 0, y: -3, z: 0 }, cell: pool(2, p => p.y === 3 ? stone({ breakable: false }) : undefined) })
  assert.equal(r.act, 'none')
})

test('air: water beside the broken block floods it, so it is not a pocket', () => {
  // a stone block right above the head with water around it at y 1, air at y 2
  const cell = (p: V): AirCell => {
    if (p.x === 0 && p.z === 0 && p.y === 1) return stone({ digMs: 500 })
    if (p.y <= 1 && Math.abs(p.x) <= 1 && Math.abs(p.z) <= 1) return WATER
    if (p.y === 2) return AIR
    return stone({ breakable: false })
  }
  const r = airPlan({ head, cell })
  // the column breaks the stone and goes on up to air at 2; swimming around it costs 3 blocks (1.5 s) vs 0.5 + 0.35 s
  assert.equal(r.act, 'break')
  assert.match(r.why, /then up to 2/)
})

test('air: unknown blocks above (unloaded) do not count as air', () => {
  const r = airPlan({ head, cell: p => p.y > 0 ? { kind: 'unknown' } : WATER, radius: 1 })
  assert.equal(r.act, 'none')
})

test('air trigger: threshold, earlier at low health, off, head out of water', () => {
  const s = airSettings(undefined)
  assert.deepEqual(s, { enabled: true, below: 10, shoreRadius: 48 })
  assert.equal(airSettings({ airShoreRadius: 80 }).shoreRadius, 80)
  assert.equal(airSettings({ airShoreRadius: 500 }).shoreRadius, 48, 'out of range: default')
  assert.equal(airTrigger({ settings: s, headInWater: true, oxygen: 11, health: 20 }), null)
  assert.match(airTrigger({ settings: s, headInWater: true, oxygen: 10, health: 20 })!, /air 10\/20/)
  assert.equal(airTrigger({ settings: s, headInWater: false, oxygen: 2, health: 20 }), null, 'head out of water: breathing already')
  assert.match(airTrigger({ settings: s, headInWater: true, oxygen: 13, health: 10 })!, /going at 13/)
  assert.match(airTrigger({ settings: s, headInWater: true, oxygen: 16, health: 5 })!, /going at 16/)
  assert.equal(airTrigger({ settings: s, headInWater: true, oxygen: 17, health: 5 }), null)
  assert.equal(airTrigger({ settings: airSettings({ air: false }), headInWater: true, oxygen: 0, health: 3 }), null)
  assert.equal(airTrigger({ settings: airSettings({ airBelow: 15 }), headInWater: true, oxygen: 15, health: 20 }) !== null, true)
  assert.equal(airSettings({ airBelow: 99 }).below, 10, 'out of range: default')
  assert.equal(airThreshold(0, 2), 0, '0 = only when empty')
  assert.equal(airThreshold(18, 2), 19)
})

test('air done: 18 of 20, or 16 with the head out of water', () => {
  assert.equal(airDone(17, true), false)
  assert.equal(airDone(18, true), true)
  assert.equal(airDone(16, false), true)
  assert.equal(airDone(10, false), false)
})

test('pathfinder: water under ice costs a lot, under a roof less, deep water a little', () => {
  const col = (cells: AirCell[]) => (dy: number) => cells[dy - 1] ?? AIR
  assert.equal(waterStepCost(col([AIR])), 0, 'shallow water, head in air')
  assert.equal(waterStepCost(col([WATER, AIR])), SUBMERGED_COST)
  assert.equal(waterStepCost(col([WATER, WATER, ice()])), UNDER_ICE_COST)
  assert.equal(waterStepCost(col([{ kind: 'solid', name: 'packed_ice' }])), UNDER_ICE_COST)
  assert.equal(waterStepCost(col([WATER, stone()])), UNDER_ROOF_COST)
  assert.equal(waterStepCost(col([WATER, WATER, WATER, WATER, ice()])), SUBMERGED_COST, 'ice further than 4 up is not counted')
})

test('arbiter: air goes first and nothing but water_bucket interrupts it', () => {
  const s = (o: Partial<Parameters<typeof mayReplace>[0]>) => ({ current: 'eat', currentIsReflex: true, sinceStartMs: 100, healthDrop: 0, next: 'air', meleeDist: Infinity, ...o })
  assert.equal(mayReplace(s({})), null, 'eat just started, air still goes')
  assert.equal(mayReplace(s({ current: 'air', next: 'eat', sinceStartMs: 60_000 })), 'air: getting air first')
  assert.equal(mayReplace(s({ current: 'air', next: 'defend', sinceStartMs: 60_000, healthDrop: 10, meleeDist: 1 })), 'air: getting air first')
  assert.equal(mayReplace(s({ current: 'air', next: 'water_bucket' })), null)
  assert.equal(mayReplace(s({ current: 'air', next: 'air' })), 'already running')
})
