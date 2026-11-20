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
