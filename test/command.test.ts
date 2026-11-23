import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs } from '../src/brains/command.ts'
import { defineAction, z } from '../src/core/index.ts'

const goto = defineAction({ name: 'goto', description: '', params: z.object({ x: z.number(), y: z.number().optional(), z: z.number() }), run: () => {} })
const say = defineAction({ name: 'say', description: '', params: z.object({ text: z.string() }), run: () => {} })
const follow = defineAction({ name: 'follow', description: '', params: z.object({ player: z.string().optional(), distance: z.number().default(2) }), run: () => {} })

test('positional numbers', () => {
  assert.deepEqual(parseArgs(goto, ['10', '64', '-20']), { x: 10, y: 64, z: -20 })
})

test('last string param swallows the rest', () => {
  assert.deepEqual(parseArgs(say, ['hello', 'there', 'friend']), { text: 'hello there friend' })
})

test('key=value and positional mix', () => {
  assert.deepEqual(parseArgs(follow, ['distance=4', 'Steve']), { distance: 4, player: 'Steve' })
})

test('missing args stay missing', () => {
  assert.deepEqual(parseArgs(follow, []), {})
})

test('non-owners: only actions marked anyone, everything else and help silently ignored', async () => {
  const { commandBrain, anyoneMay } = await import('../src/brains/command.ts')
  const pvp = defineAction({ name: 'pvp', description: '', params: z.object({ mode: z.string().optional() }), anyone: true, run: () => {} })
  const internal = defineAction({ name: 'pvp_engage', description: '', params: z.object({}), anyone: true, internal: true, run: () => {} })
  assert.equal(anyoneMay(pvp), true)
  assert.equal(anyoneMay(goto), false)
  assert.equal(anyoneMay(internal), false)
  assert.equal(anyoneMay(undefined), false)

  const defs = new Map([pvp, goto].map(d => [d.name, d]))
  const calls: string[] = []
  const said: string[] = []
  let listener: (m: any) => void = () => {}
  const agent = {
    username: 'Pax',
    on: (_e: string, fn: (m: any) => void) => { listener = fn },
    isOwner: (p: string) => p === 'Robin',
    getAction: (n: string) => defs.get(n),
    listActions: () => [...defs.values()],
    log: { info () {} },
    act: async (name: string, params: Record<string, unknown>, o: any) => { calls.push(`${o.caller.name}:${name}:${JSON.stringify(params)}`); return { ok: true, message: 'done' } },
    reply: (_m: unknown, text: string) => { said.push(text) }
  }
  commandBrain({ prefix: '!' }).start!(agent as any)
  const send = async (from: string, message: string, whisper = false) => { listener({ from, message, whisper }); await new Promise(r => setTimeout(r, 5)) }
  await send('Stranger', '!goto 1 2 3')
  await send('Stranger', '!help')
  await send('Stranger', '!nosuch', true)
  assert.deepEqual(calls, [])
  assert.deepEqual(said, [])
  await send('Stranger', '!pvp off')
  await send('Robin', '!goto 1 2 3')
  assert.deepEqual(calls, ['Stranger:pvp:{"mode":"off"}', 'Robin:goto:{"x":1,"y":2,"z":3}'])
})
