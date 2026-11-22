import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MinecraftJavaAdapter } from '../src/adapters/minecraft-java/adapter.ts'
import { platformFor } from '../src/adapters/minecraft-java/platforms/index.ts'
import { fakeBot, WORLDS } from './fake-world.ts'
import { minecraftView } from './fake-attach.ts'

const SERVER = { host: 'adapter.invalid', port: 25565, auth: 'offline' as const, version: '1.21.1' }

test('platforms: NeoForge by default (with mods), vanilla and Paper on request, unknown names refused', () => {
  assert.equal(platformFor(SERVER).name, 'neoforge')
  assert.deepEqual(platformFor(SERVER).capabilities, ['mods'])
  assert.equal(platformFor({ ...SERVER, platform: 'vanilla' }).name, 'vanilla')
  assert.equal(platformFor({ ...SERVER, platform: 'paper' }).name, 'paper')
  assert.throws(() => platformFor({ ...SERVER, platform: 'bukkit' }), /unknown server platform/)
})

test('events: hurt only for the bot itself, chat without its own lines, game mode changes once', () => {
  const bot = fakeBot(WORLDS.survivalDay!)
  const a = minecraftView(bot)
  const hurt: number[] = []
  const chat: string[] = []
  const modes: string[] = []
  a.on('hurt', h => hurt.push(h))
  a.on('chat', (from, msg, whisper) => chat.push(`${whisper ? 'w:' : ''}${from}:${msg}`))
  a.on('gameMode', (m, prev) => modes.push(`${prev}->${m}`))
  bot.emit('entityHurt', { id: 999 })
  bot.emit('entityHurt', bot.entity)
  bot.emit('chat', 'Golem', 'my own line')
  bot.emit('chat', 'Owner', 'hi')
  bot.emit('whisper', 'Owner', 'psst')
  bot.emit('game')
  bot.game.gameMode = 'creative'
  bot.emit('game')
  bot.emit('game')
  assert.deepEqual(hurt, [17])
  assert.deepEqual(chat, ['Owner:hi', 'w:Owner:psst'])
  assert.deepEqual(modes, ['survival->creative'])
})

test('events: off() detaches the listener from the bot', () => {
  const bot = fakeBot(WORLDS.survivalDay!)
  const a = minecraftView(bot)
  let n = 0
  const fn = () => { n++ }
  a.on('death', fn)
  bot.emit('death')
  a.off('death', fn)
  bot.emit('death')
  assert.equal(n, 1)
  assert.equal(bot.listenerCount('death'), 0)
})

test('world view: self, entities, inventory and time from the Mineflayer bot', () => {
  const a = minecraftView(fakeBot(WORLDS.survivalDay!))
  const self = a.self()!
  assert.equal(self.username, 'Golem')
  assert.equal(self.health, 17)
  assert.equal(self.game.gameMode, 'survival')
  const zombie = a.entities().find(e => e.name === 'zombie')!
  assert.equal(zombie.hostile, true)
  assert.equal(Math.round(zombie.distance), 8)
  assert.equal(a.entities().find(e => e.name === 'cow')!.hostile, false)
  const inv = a.inventory()
  assert.equal(inv.items.find(i => i.name === 'bread')!.food, true)
  assert.equal(inv.items.find(i => i.name === 'cobblestone')!.food, false)
  assert.deepEqual(a.time(), { timeOfDay: 6000, day: 3, isDay: true, isNight: false })
  assert.deepEqual(a.players(), ['Golem', 'Owner', 'FarAway'])
  assert.equal(a.playerPosition('FarAway'), null)
  const night = minecraftView(fakeBot(WORLDS.creativeNight!))
  assert.equal(night.time()!.isNight, true)
  assert.equal(night.inventory().items.find(i => i.label === 'modded#9001')!.name, 'unknown')
})

test('not in the world: no self, no observation', () => {
  const a = new MinecraftJavaAdapter()
  assert.equal(a.self(), null)
  assert.equal(a.observe(), null)
  assert.equal(a.connected, false)
  assert.deepEqual(a.entities(), [])
})
