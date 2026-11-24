// The bot's own air: mineflayer's entities plugin copies every entity's air_supply into
// bot.oxygenLevel (Pax drowned while a mob's air was read as its own). This loads the real plugin
// into a bare bot and feeds it packets.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { trackOwnAir, oxygen, ownAirFrom } from '../src/adapters/minecraft-java/air.ts'

const require = createRequire(import.meta.url)
const registry = require('prismarine-registry')('1.21.1')
const Entity = require('prismarine-entity')('1.21.1')
const entitiesPlugin = require('mineflayer/lib/plugins/entities.js')

const ME = 7
const ZOMBIE = 42
const AIR = registry.entitiesByName.player.metadataKeys.indexOf('air_supply')

function bareBot (): any {
  const bot: any = new EventEmitter()
  bot._client = new EventEmitter()
  bot._client.username = 'Pax'
  bot.version = '1.21.1'
  bot.registry = registry
  bot.supportFeature = registry.supportFeature
  entitiesPlugin(bot)
  bot._client.emit('login', { entityId: ME, worldName: 'minecraft:overworld', dimension: 0 })
  const z = new Entity(ZOMBIE)
  z.name = 'zombie'
  z.type = 'hostile'
  bot.entities[ZOMBIE] = z
  return bot
}
const meta = (entityId: number, air: number) => ({ entityId, metadata: [{ key: AIR, type: 'int', value: air }] })

test('own air: the air_supply index is 1 for players and zombies', () => {
  assert.equal(AIR, 1)
  assert.equal(registry.entitiesByName.zombie.metadataKeys.indexOf('air_supply'), 1)
})

test('own air: mineflayer alone takes a zombie\'s air for the bot\'s (the bug)', () => {
  const bot = bareBot()
  bot._client.emit('entity_metadata', meta(ME, 30)) // the bot: 2 of 20
  bot._client.emit('entity_metadata', meta(ZOMBIE, 300)) // a zombie in and out of the water
  assert.equal(bot.oxygenLevel, 20)
})

test('own air: trackOwnAir keeps the bot\'s own air, whatever other entities send', () => {
  const bot = bareBot()
  const stop = trackOwnAir(bot)
  assert.equal(oxygen(bot), 20)
  bot._client.emit('entity_metadata', meta(ZOMBIE, 45)) // the zombie is drowning, the bot is fine
  assert.equal(oxygen(bot), 20)
  assert.equal(bot.oxygenLevel, 20)
  bot._client.emit('entity_metadata', meta(ME, 30))
  bot._client.emit('entity_metadata', meta(ZOMBIE, 300))
  assert.equal(oxygen(bot), 2)
  assert.equal(bot.oxygenLevel, 2, 'bot.oxygenLevel is put back for code that reads it directly')
  // a packet for the bot without air in it changes nothing
  bot._client.emit('entity_metadata', { entityId: ME, metadata: [{ key: 0, type: 'byte', value: 0 }] })
  assert.equal(oxygen(bot), 2)
  bot.emit('death')
  assert.equal(oxygen(bot), 20)
  stop()
})

test('own air: ownAirFrom reads only the bot\'s own packets', () => {
  assert.equal(ownAirFrom(meta(ME, 150), ME, 1), 10)
  assert.equal(ownAirFrom(meta(ZOMBIE, 150), ME, 1), null)
  assert.equal(ownAirFrom(meta(ME, 150), undefined, 1), null)
  assert.equal(ownAirFrom({ entityId: ME, metadata: [{ key: 1, value: -15 }] }, ME, 1), -1)
})
