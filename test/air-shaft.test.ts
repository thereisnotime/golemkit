// Out of a flooded shaft (shaftExit, boxedIn), the air reflex while a furnace window is open, getAir
// closing that window, the bunker's flood check and dry footing for crafting/smelting.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { shaftExit, boxedIn, floodsIfDug, type AirCell, type V } from '../src/skills/airPlan.ts'
import { getAir, describePlan, closeWindow } from '../src/adapters/minecraft-java/air.ts'
import { reflexes } from '../src/adapters/minecraft-java/brains/reflexes.ts'
import { inWaterAt } from '../src/skills/navigation.ts'

const AIR: AirCell = { kind: 'air', name: 'air' }
const WATER: AirCell = { kind: 'water', name: 'water' }
const stone = (o: Partial<AirCell> = {}): AirCell => ({ kind: 'solid', name: 'stone', breakable: true, digMs: 7500, ...o })

/**
 * A 1x1 shaft at x 0 z 0 in stone: floor at y 0 (stone), water y 1..3, air y 4..`rimTop` - 1 inside,
 * stone around it up to `rimTop` - 1, open air from `rimTop` up. Pax's case: the rim 2 above the water.
 */
function shaft (rimTop = 6, wall: (p: V) => AirCell | undefined = () => undefined) {
  return (p: V): AirCell => {
    if (p.y >= rimTop) return AIR
    if (p.x === 0 && p.z === 0) {
      if (p.y <= 0) return stone()
      return p.y <= 3 ? WATER : AIR
    }
    return wall(p) ?? stone()
  }
}

test('shaft: boxed in a 1x1 shaft, not in an open pond', () => {
  assert.equal(boxedIn({ x: 0, y: 3, z: 0 }, shaft()), true)
  // a pond 9x9 with air beside the water at the edge
  const pond = (p: V): AirCell => (p.y > 3 ? AIR : Math.abs(p.x) <= 4 && Math.abs(p.z) <= 4 && p.y >= 1 ? WATER : p.y === 3 ? AIR : stone())
  assert.equal(boxedIn({ x: 0, y: 3, z: 0 }, pond), false)
  // the feet out of the water: not boxed (it stands)
  assert.equal(boxedIn({ x: 0, y: 4, z: 0 }, shaft()), false)
})

/**
 * Plays shaftExit out on a mutable copy of the world: fill and pillar put stone in, notch digs, a
 * ledge moves the feet onto it. Returns the steps until 'out' (or 'none', or 20 steps).
 */
function playOut (world: (p: V) => AirCell, feet: V, blocks: boolean): { steps: string[], feet: V } {
  const changed = new Map<string, AirCell>()
  const k = (p: V) => `${p.x},${p.y},${p.z}`
  const cell = (p: V) => changed.get(k(p)) ?? world(p)
  const steps: string[] = []
  for (let i = 0; i < 20; i++) {
    const s = shaftExit({ feet, cell, blocks })
    steps.push(s.act)
    if (s.act === 'out' || s.act === 'none') break
    if (s.act === 'fill') changed.set(k(s.at), stone())
    if (s.act === 'pillar') { changed.set(k(feet), stone()); feet = { ...feet, y: feet.y + 1 } }
    if (s.act === 'notch') for (const p of s.dig) changed.set(k(p), AIR)
    if (s.act === 'clear') changed.set(k(s.dig), AIR)
    if (s.act === 'ledge' || s.act === 'notch') feet = { ...s.ledge, y: s.ledge.y + 1 }
  }
  return { steps, feet }
}

test('shaft: afloat with the rim 2 above the water and blocks: raise the floor, step into the wall, pillar, out', () => {
  // afloat at the top of the water (feet in y 3): the floor is at 0, so fill y 1 first
  const s = shaftExit({ feet: { x: 0, y: 3, z: 0 }, cell: shaft(), blocks: true })
  assert.equal(s.act, 'fill')
  assert.deepEqual((s as any).at, { x: 0, y: 1, z: 0 })
  // standing in the top water cell no jump lifts it clear to pillar: a step into the wall instead
  const filled = (p: V) => (p.x === 0 && p.z === 0 && p.y >= 1 && p.y <= 2 ? stone() : shaft()(p))
  assert.equal(shaftExit({ feet: { x: 0, y: 3, z: 0 }, cell: filled, blocks: true }).act, 'notch')
  const r = playOut(shaft(), { x: 0, y: 3, z: 0 }, true)
  assert.deepEqual(r.steps, ['fill', 'fill', 'notch', 'pillar', 'ledge', 'out'])
  assert.equal(r.feet.y, 6, 'on the rim')
})

test('shaft: no blocks: steps dug into the wall all the way up', () => {
  const r = playOut(shaft(), { x: 0, y: 3, z: 0 }, false)
  assert.equal(r.steps.at(-1), 'out')
  assert.equal(r.feet.y, 6)
  assert.ok(r.steps.filter(x => x === 'notch').length >= 2, r.steps.join(','))
})

test('shaft: a furnace on the rim right above the step is dug out of the way, then on up', () => {
  // the furnace stands on the rim at 1 6 0, right above the first step dug into the east wall
  const furnace = (p: V): AirCell => (p.x === 1 && p.y === 6 && p.z === 0 ? { kind: 'solid', name: 'furnace', breakable: true, digMs: 17_500 } : shaft()(p))
  const r = playOut(furnace, { x: 0, y: 3, z: 0 }, false)
  assert.ok(r.steps.includes('clear'), r.steps.join(','))
  assert.equal(r.steps.at(-1), 'out')
  // an unbreakable block over the head: no way on
  const lid = (p: V): AirCell => (p.x === 0 && p.y === 5 && p.z === 0 ? stone({ breakable: false }) : shaft()(p))
  assert.equal(shaftExit({ feet: { x: 0, y: 3, z: 0 }, cell: lid, blocks: true }).act, 'none')
})

test('shaft: dry ground beside the feet is out', () => {
  const ground = (p: V): AirCell => (p.y < 0 ? stone() : AIR)
  assert.equal(shaftExit({ feet: { x: 0, y: 0, z: 0 }, cell: ground, blocks: true }).act, 'out')
})

test('shaft: a rim one above the water is a ledge right away', () => {
  // rim top at 4: stone up to 3 beside the water at 3, air at 4 and 5
  const s = shaftExit({ feet: { x: 0, y: 3, z: 0 }, cell: shaft(4), blocks: false })
  assert.equal(s.act, 'ledge')
})

test('shaft: no blocks: dig a step into the wall, the softer side first', () => {
  const dirtEast = (p: V) => (p.x === 1 && p.z === 0 ? { kind: 'solid', name: 'dirt', breakable: true, digMs: 750 } as AirCell : undefined)
  const s = shaftExit({ feet: { x: 0, y: 3, z: 0 }, cell: shaft(6, dirtEast), blocks: false })
  assert.equal(s.act, 'notch')
  assert.deepEqual((s as any).ledge, { x: 1, y: 3, z: 0 })
  assert.deepEqual((s as any).dig, [{ x: 1, y: 4, z: 0 }, { x: 1, y: 5, z: 0 }])
})

test('shaft: no blocks and only protected or unbreakable walls: nothing to do', () => {
  const s = shaftExit({ feet: { x: 0, y: 3, z: 0 }, cell: shaft(6, () => stone({ breakable: false, protected: true })), blocks: false })
  assert.equal(s.act, 'none')
})

test('shaft: a notch that would let water in is not dug', () => {
  // water behind the east wall at y 4
  const wet = (p: V) => (p.x === 2 && p.z === 0 && p.y === 4 ? WATER : p.x === 1 && p.z === 0 ? stone({ digMs: 10 }) : undefined)
  const s = shaftExit({ feet: { x: 0, y: 3, z: 0 }, cell: shaft(6, wet), blocks: false })
  assert.equal(s.act, 'notch')
  assert.notEqual((s as any).ledge.x, 1)
})

test('bunker: water or ice beside a cell about to be dug floods it', () => {
  assert.equal(floodsIfDug(['dirt', 'stone', 'dirt', 'grass_block']), null)
  assert.match(floodsIfDug(['dirt', 'ice', undefined, 'dirt'])!, /ice/)
  assert.match(floodsIfDug(['water'])!, /water/)
})

test('dry footing: water at the feet or head, or afloat over water', () => {
  assert.equal(inWaterAt({ feet: 'water', head: 'air', below: 'stone', onGround: true }), true)
  assert.equal(inWaterAt({ feet: 'air', head: 'water', below: 'stone', onGround: false }), true)
  assert.equal(inWaterAt({ feet: 'air', head: 'air', below: 'water', onGround: false }), true)
  assert.equal(inWaterAt({ feet: 'air', head: 'air', below: 'stone', onGround: true }), false)
})

test('air: the plan in the debug log names the kind and the target', () => {
  assert.equal(describePlan({ act: 'up', to: { x: 1, y: 64, z: -2 }, cost: 0, why: 'air right above' }), 'up to 1 64 -2: air right above')
  assert.equal(describePlan({ act: 'break', block: { x: 1, y: 64, z: -2 }, name: 'ice', cost: 0, why: 'x' }), 'break ice at 1 64 -2: x')
  assert.match(describePlan({ act: 'swim', to: { x: 3, y: 64, z: 0 }, next: { x: 1, y: 63, z: 0 }, dist: 3, cost: 0, why: 'y' }), /^swim to 3 64 0 via 1 63 0/)
})

/** A bot standing in a flooded shaft: water at the eyes, stone below. */
function wetBot (o: { air: number, window?: boolean, eyesWet?: boolean } = { air: 20 }): any {
  const bot: any = new EventEmitter()
  bot.entity = { id: 1, position: new Vec3(0.5, 1, 0.5), eyeHeight: 1.62, onGround: true, velocity: new Vec3(0, 0, 0), effects: {} }
  bot.health = 20
  bot.food = 20
  bot.game = { gameMode: 'survival' }
  bot.oxygenLevel = o.air
  bot.entities = {}
  bot.players = {}
  bot.inventory = { items: () => [], slots: [] }
  bot.time = { timeOfDay: 6000 }
  bot.closed = 0
  bot.currentWindow = o.window ? { type: 'minecraft:furnace' } : null
  bot.closeWindow = () => { bot.closed++; bot.currentWindow = null }
  bot.clearControlStates = () => {}
  bot.setControlState = () => {}
  bot.look = async () => {}
  bot.pathfinder = { setGoal () {} }
  const wet = o.eyesWet !== false
  bot.blockAt = (p: Vec3) => {
    const y = Math.floor(p.y)
    if (y <= 0) return { name: 'stone', boundingBox: 'block', position: p.floored(), getProperties: () => ({}) }
    if (y <= 3 && wet) return { name: 'water', boundingBox: 'empty', position: p.floored(), getProperties: () => ({ level: 0 }) }
    return { name: 'air', boundingBox: 'empty', position: p.floored(), getProperties: () => ({}) }
  }
  return bot
}

test('air reflex: fires at the threshold while another action holds the body with a furnace window open', async () => {
  const bot = wetBot({ air: 10, window: true })
  const acted: string[] = []
  const agent: any = {
    settings: {},
    canDig: true,
    currentAction: { name: 'light_up', caller: { kind: 'brain', name: 'behaviors' } },
    getAction: (n: string) => (n === 'air' ? { name: 'air' } : undefined),
    act: (n: string) => { acted.push(n); return new Promise(() => {}) },
    log: { info () {}, debug () {}, warn () {} },
    protectedAreas: { isProtected: () => false }
  }
  const brain = reflexes()
  const stop = (brain as any).session(agent, bot)
  try {
    await new Promise(r => setTimeout(r, 400))
    assert.deepEqual(acted, ['air'])
  } finally {
    stop?.()
  }
})

test('air reflex: no air action above the threshold or with the eyes dry', async () => {
  for (const o of [{ air: 11 }, { air: 2, eyesWet: false }]) {
    const bot = wetBot(o)
    const acted: string[] = []
    const agent: any = {
      settings: {}, canDig: true, currentAction: null,
      getAction: (n: string) => (n === 'air' ? { name: 'air' } : undefined),
      act: (n: string) => { acted.push(n); return new Promise(() => {}) },
      log: { info () {}, debug () {}, warn () {} },
      protectedAreas: { isProtected: () => false }
    }
    const stop = (reflexes() as any).session(agent, bot)
    try {
      await new Promise(r => setTimeout(r, 400))
      assert.deepEqual(acted, [], JSON.stringify(o))
    } finally {
      stop?.()
    }
  }
})

test('getAir: closes an open furnace window first', async () => {
  const bot = wetBot({ air: 20, window: true })
  const r = await getAir(bot, new AbortController().signal, { maxMs: 500 })
  assert.equal(bot.closed, 1)
  assert.equal(r.ok, true)
  assert.equal(closeWindow(bot), false)
})
