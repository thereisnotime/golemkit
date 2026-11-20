import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nbt from 'prismarine-nbt'
import { encodeQuery, decodeNetworkSetup, decodeSetupFailed, failureReason, Reader, Writer, PROTOCOL, FLOW } from '../src/core/neoforge/codec.ts'
import { ChannelStore } from '../src/core/neoforge/channelStore.ts'

const comp = (translate: string, ...args: any[]): any => nbt.comp({
  translate: nbt.string(translate),
  with: nbt.list(nbt.comp(args.map((a: any) => typeof a === 'string' ? { '': nbt.string(a) } : a.value) as any))
})

function failedPayload (entries: [string, any][]): Buffer {
  const w = new Writer().varint(entries.length)
  const parts: Buffer[] = []
  for (const [id, c] of entries) {
    w.string(id)
    parts.push(w.buffer())
    w.parts = []
    parts.push((nbt.protos.big as any).createPacketBuffer('anonymousNbt', c))
  }
  return Buffer.concat([...parts, w.buffer()])
}

test('query encodes protocol map and components', () => {
  const buf = encodeQuery({ [PROTOCOL.PLAY]: [{ id: 'create:x', version: '6.0.8', flow: 'SERVERBOUND', optional: true }] })
  const r = new Reader(buf)
  assert.equal(r.varint(), 1)
  assert.equal(r.varint(), PROTOCOL.PLAY)
  assert.equal(r.varint(), 1)
  assert.equal(r.string(), 'create:x')
  assert.equal(r.string(), '6.0.8')
  assert.equal(r.bool(), true)
  assert.equal(r.varint(), FLOW.SERVERBOUND)
  assert.equal(r.bool(), true)
  assert.ok(r.done)
})

test('network setup decodes', () => {
  const w = new Writer().varint(1).varint(PROTOCOL.CONFIGURATION).varint(1).string('neoforge:config_file').string('neoforge:config_file').string('1')
  assert.deepEqual(decodeNetworkSetup(w.buffer()), { [PROTOCOL.CONFIGURATION]: [{ id: 'neoforge:config_file', version: '1' }] })
})

test('store learns missing channels, versions and flows', () => {
  const store = new ChannelStore(join(tmpdir(), `mcb-${process.pid}.json`))
  const missing = comp('neoforge.network.negotiation.failure.mod', 'Create', comp('neoforge.network.negotiation.failure.missing.server.client'))
  let res = store.learn(decodeSetupFailed(failedPayload([['create:a', missing], ['create:b', missing]])))
  assert.equal(res.changed, true)
  assert.equal(store.size, 2)

  const flow = comp('neoforge.network.negotiation.failure.flow.client.missing', 'SERVERBOUND')
  const ver = comp('neoforge.network.negotiation.failure.mod', 'Create', comp('neoforge.network.negotiation.failure.version.mismatch', '1', '6.0.8'))
  const failures = decodeSetupFailed(failedPayload([['create:a', flow], ['create:b', ver]]))
  assert.equal((failureReason(failures['create:b']) as any).key, 'neoforge.network.negotiation.failure.version.mismatch')
  res = store.learn(failures)
  assert.equal(res.changed, true)
  assert.deepEqual(store.channels['create:a'], { version: '1', flow: 'SERVERBOUND' })
  assert.deepEqual(store.channels['create:b'], { version: '6.0.8', flow: null })

  // Same failures again teach nothing new.
  assert.equal(store.learn(failures).changed, false)
})
