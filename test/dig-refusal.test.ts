import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { digBlock, DigRefusedError } from '../src/skills/world.ts'
import { watchRefusedDigs } from '../src/core/protection.ts'

const NAMES: Record<number, string> = { 0: 'air', 9: 'grass_block', 14: 'cobblestone' }

/** A bot whose server answers a dig with the given block_change states, in order. */
function fakeBot (replies: number[], heldItem: string | null = null, gameMode = 'survival') {
  const client = new EventEmitter()
  const pos = new Vec3(1, 64, 1)
  let current = 9
  const bot: any = new EventEmitter()
  Object.assign(bot, {
    _client: client,
    game: { gameMode },
    heldItem: heldItem ? { name: heldItem } : null,
    inventory: { items: () => [{ name: 'oak_planks' }] },
    equipped: [] as string[],
    async equip (it: any) { bot.equipped.push(it.name); bot.heldItem = it },
    async unequip () { bot.heldItem = null },
    registry: { blocksByStateId: Object.fromEntries(Object.entries(NAMES).map(([k, v]) => [k, { name: v }])) },
    world: { setBlockStateId (_p: unknown, id: number) { current = id } },
    blockAt: () => ({ name: NAMES[current], position: pos }),
    stopDigging () {},
    async dig () {
      for (const t of replies) { current = t; client.emit('block_change', { location: pos, type: t }) }
    }
  })
  return { bot, block: { name: 'grass_block', position: pos } as any }
}

test('dig: a start-of-dig echo followed by air is not a refusal (NeoForge)', async () => {
  const { bot, block } = fakeBot([9, 0])
  await digBlock(bot, block, new AbortController().signal, 0)
})

test('dig: the old block coming back and staying is a refusal', async () => {
  const { bot, block } = fakeBot([0, 9])
  await assert.rejects(digBlock(bot, block, new AbortController().signal, 0), DigRefusedError)
})

test('dig: in creative a sword is put away first (it breaks nothing there)', async () => {
  const { bot, block } = fakeBot([0], 'stone_sword', 'creative')
  await digBlock(bot, block, new AbortController().signal, 0)
  assert.deepEqual(bot.equipped, ['oak_planks'])
})

test('refusal watch: our own next block in a freshly dug cell is not a refusal; the old block back is', () => {
  const { bot } = fakeBot([])
  const refused: unknown[] = []
  const stop = watchRefusedDigs(bot, p => refused.push(p))
  const realNow = Date.now
  Date.now = () => realNow() + 20_000 // past the quiet time after connecting
  try {
    const p = new Vec3(1, 64, 1)
    // dug grass, then placed cobblestone there 150 ms later (creative build)
    bot.emit('blockUpdate', { name: 'grass_block', type: 9 }, { type: 0, position: p })
    bot.emit('diggingCompleted', { position: p })
    bot._client.emit('block_change', { location: p, type: 14 })
    assert.equal(refused.length, 0)
    // dug grass, the server put grass back
    bot.emit('blockUpdate', { name: 'grass_block', type: 9 }, { type: 0, position: p })
    bot.emit('diggingCompleted', { position: p })
    bot._client.emit('block_change', { location: p, type: 9 })
    assert.equal(refused.length, 1)
  } finally {
    Date.now = realNow
    stop()
  }
})
