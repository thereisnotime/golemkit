// Fixed fake worlds for golden observe() snapshots: a Mineflayer-shaped bot built from the real
// 1.21.1 registry (prismarine-registry, -item, -entity), with entities, players and an
// inventory, and no blocks loaded (blockAt is null, findBlocks finds nothing).
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'

const require = createRequire(import.meta.url)
const registry = require('prismarine-registry')('1.21.1')
const Item = require('prismarine-item')(registry)
const Entity = require('prismarine-entity')(registry)

export interface FakeWorldSpec {
  username: string
  position: [number, number, number]
  gameMode: 'survival' | 'creative'
  dimension?: string
  health: number
  food: number
  timeOfDay: number
  /** [item, count]; a "modded#123" name makes an item the registry doesn't know */
  inventory: [string, number][]
  held?: string
  /** armour worn: helmet, chest, legs, feet slot items */
  armour?: string[]
  players: { name: string, position?: [number, number, number] }[]
  mobs: { name: string, position: [number, number, number] }[]
  spawnPoint?: [number, number, number]
}

function item (name: string, count: number): any {
  const m = /^modded#(\d+)$/.exec(name)
  if (m) { const it = new Item(1, count); it.name = 'unknown'; it.type = Number(m[1]); return it }
  const def = registry.itemsByName[name]
  if (!def) throw new Error(`no item ${name}`)
  return new Item(def.id, count)
}

export function fakeBot (spec: FakeWorldSpec): any {
  const bot: any = new EventEmitter()
  let nextId = 1
  const self = new Entity(nextId++)
  self.type = 'player'
  self.username = spec.username
  self.name = 'player'
  self.position = new Vec3(...spec.position)
  self.height = 1.8
  self.yaw = 0
  self.pitch = 0
  const entities: Record<number, any> = { [self.id]: self }
  const players: Record<string, any> = { [spec.username]: { username: spec.username, entity: self, ping: 0, gamemode: 0 } }
  for (const p of spec.players) {
    let e: any
    if (p.position) {
      e = new Entity(nextId++)
      e.type = 'player'; e.name = 'player'; e.username = p.name; e.position = new Vec3(...p.position); e.height = 1.8
      entities[e.id] = e
    }
    players[p.name] = { username: p.name, entity: e, ping: 0, gamemode: 0 }
  }
  for (const m of spec.mobs) {
    const e = new Entity(nextId++)
    e.setType?.(registry.entitiesByName[m.name]?.id)
    const def = registry.entitiesByName[m.name]
    e.name = m.name
    e.type = def?.type ?? 'mob'
    e.position = new Vec3(...m.position)
    e.height = def?.height ?? 1.8
    entities[e.id] = e
  }
  const slots: any[] = new Array(46).fill(null)
  spec.inventory.forEach(([n, c], i) => { slots[36 + i] = item(n, c); slots[36 + i].slot = 36 + i })
  ;(spec.armour ?? []).forEach((n, i) => { slots[5 + i] = item(n, 1); slots[5 + i].slot = 5 + i })
  Object.assign(bot, {
    username: spec.username,
    registry,
    version: '1.21.1',
    entity: self,
    entities,
    players,
    health: spec.health,
    food: spec.food,
    foodSaturation: 5,
    isSleeping: false,
    game: { gameMode: spec.gameMode, dimension: spec.dimension ?? 'overworld', difficulty: 'normal' },
    time: { timeOfDay: spec.timeOfDay, day: 3, age: 3 * 24000 + spec.timeOfDay },
    spawnPoint: spec.spawnPoint ? new Vec3(...spec.spawnPoint) : undefined,
    heldItem: spec.held ? item(spec.held, 1) : null,
    inventory: { slots, items: () => slots.slice(9, 45).filter(Boolean) },
    _client: new EventEmitter(),
    blockAt: () => null,
    findBlocks: () => [],
    findBlock: () => null,
    nearestEntity (match: (e: any) => boolean = () => true) {
      let best: any = null
      let bd = Infinity
      for (const e of Object.values(entities)) {
        if (e === self || !match(e)) continue
        const d = e.position.distanceTo(self.position)
        if (d < bd) { bd = d; best = e }
      }
      return best
    },
    pathfinder: { setGoal () {}, isMoving: () => false, goal: null },
    supportFeature: () => false
  })
  return bot
}

/** Two fixed worlds and a disconnected agent; see golden.test.ts. */
export const WORLDS: Record<string, FakeWorldSpec> = {
  survivalDay: {
    username: 'Golem',
    position: [1250.5, 70, 445.5],
    gameMode: 'survival',
    health: 17,
    food: 14,
    timeOfDay: 6000,
    inventory: [['bread', 5], ['oak_log', 12], ['stone_pickaxe', 1], ['cobblestone', 40], ['iron_ingot', 3], ['bread', 2]],
    held: 'stone_pickaxe',
    armour: ['iron_helmet', 'leather_chestplate'],
    players: [{ name: 'Owner', position: [1253, 70, 447] }, { name: 'FarAway' }],
    mobs: [
      { name: 'zombie', position: [1258, 70, 445] },
      { name: 'cow', position: [1245, 70, 440] },
      { name: 'skeleton', position: [1240, 70, 460] },
      { name: 'item', position: [1251, 70, 446] }
    ],
    spawnPoint: [545, 70, 45]
  },
  creativeNight: {
    username: 'Golem',
    position: [-400.2, 64, 900.8],
    gameMode: 'creative',
    dimension: 'the_nether',
    health: 20,
    food: 20,
    timeOfDay: 18000,
    inventory: [['diamond_block', 64], ['modded#9001', 3]],
    players: [],
    mobs: [{ name: 'creeper', position: [-395, 64, 905] }, { name: 'phantom', position: [-410, 80, 890] }]
  }
}
