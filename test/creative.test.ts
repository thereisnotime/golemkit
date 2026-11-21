import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { Vec3 } from 'vec3'
import { flyNear, takeFromCreative } from '../src/skills/creative.ts'

const require = createRequire(import.meta.url)
const Registry = require('prismarine-registry')

/** A creative bot in a flat world: ground up to y=63, a stone wall at x=10 from y 64 to 80. */
function fakeCreativeBot (setSlot?: (slot: number, item: any) => Promise<void>) {
  const slots: any[] = new Array(46).fill(null)
  const bot: any = {
    game: { gameMode: 'creative' },
    registry: Registry('1.21.1'),
    entity: { position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0) },
    physics: { gravity: 0.08 },
    blockAt: (p: Vec3) => {
      const solid = p.y <= 63 || (p.x === 10 && p.y <= 80)
      return { name: solid ? 'stone' : 'air', boundingBox: solid ? 'block' : 'empty', position: p }
    },
    inventory: { slots },
    creative: {
      startFlying () { bot.physics.gravity = 0 },
      setInventorySlot: setSlot ?? (async (slot: number, item: any) => { slots[slot] = item })
    }
  }
  return bot
}

test('creative: flies up, across and down to a free spot', async () => {
  const bot = fakeCreativeBot()
  const ok = await flyNear(bot, new Vec3(6.5, 64, 3.5), new AbortController().signal)
  assert.equal(ok, true)
  assert.ok(bot.entity.position.distanceTo(new Vec3(6.5, 64, 3.5)) < 0.01)
})

test('creative: a flight into a wall gives up quickly instead of hanging', async () => {
  const bot = fakeCreativeBot()
  const t0 = Date.now()
  const ok = await flyNear(bot, new Vec3(10.5, 70, 0.5), new AbortController().signal)
  assert.equal(ok, false)
  assert.ok(Date.now() - t0 < 10_000)
  const p = bot.entity.position.floored()
  assert.notEqual(bot.blockAt(p).boundingBox, 'block', 'never ends up inside the wall')
})

test('creative: a preempted flight stops', async () => {
  const bot = fakeCreativeBot()
  const ctl = new AbortController()
  setTimeout(() => ctl.abort(), 120)
  await assert.rejects(flyNear(bot, new Vec3(60.5, 64, 0.5), ctl.signal), (e: Error) => e.name === 'ActionAbortedError')
})

test('creative stock: items land in empty slots and are counted from the inventory', async () => {
  const bot = fakeCreativeBot()
  const r = await takeFromCreative(bot, new AbortController().signal, { cobblestone: 130, nonsense_block: 1 })
  assert.equal(r.taken, 130)
  assert.deepEqual(r.unknown, ['nonsense_block'])
  assert.equal(bot.inventory.slots.filter((s: any) => s?.name === 'cobblestone').length, 3)
})

test('creative stock: a server that never confirms a slot does not hang the build', async () => {
  const bot = fakeCreativeBot(() => new Promise(() => {}))
  const t0 = Date.now()
  const r = await takeFromCreative(bot, new AbortController().signal, { cobblestone: 64 }, 100)
  assert.ok(Date.now() - t0 < 2000)
  assert.equal(r.taken, 0)
  assert.match(r.error ?? '', /didn't confirm/)
})
