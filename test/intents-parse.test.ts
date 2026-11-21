import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseIntent, addressed, leadingCount, normalizeItem, DEFAULT_THRESHOLD } from '../src/brains/intents/parse.ts'
import { SEEN_CASES as CASES } from './fixtures/intents-seen.ts'

const ctx = { speaker: 'Tester' }

for (const [phrase, intent, args] of CASES) {
  test(`parse: ${JSON.stringify(phrase)} -> ${intent ?? 'nothing'}`, () => {
    const r = parseIntent(phrase, ctx)
    if (intent === null) {
      assert.ok(!r || r.confidence < DEFAULT_THRESHOLD, `expected no intent, got ${JSON.stringify(r)}`)
      return
    }
    assert.ok(r, 'no intent')
    assert.equal(r.intent, intent, JSON.stringify(r))
    assert.ok(r.confidence >= DEFAULT_THRESHOLD, `confidence ${r.confidence}`)
    for (const [k, v] of Object.entries(args ?? {})) assert.deepEqual(r.args[k], v, `${k} in ${JSON.stringify(r.args)}`)
  })
}

test('the table is big enough', () => {
  assert.ok(CASES.length >= 80, `${CASES.length} cases`)
})

test('addressing: name at the start or end, whisper, alone; not in the middle', () => {
  const names = ['Pax', 'pax']
  assert.deepEqual(addressed('pax, guard me', { names }), { body: 'guard me', explicit: true })
  assert.deepEqual(addressed('Pax follow me', { names }), { body: 'follow me', explicit: true })
  assert.deepEqual(addressed('@Pax: stop', { names }), { body: 'stop', explicit: true })
  assert.deepEqual(addressed('hey pax come here', { names }), { body: 'come here', explicit: true })
  assert.deepEqual(addressed('follow me pax', { names }), { body: 'follow me', explicit: true })
  assert.deepEqual(addressed('what are you doing, Pax?', { names }), { body: 'what are you doing', explicit: true })
  assert.equal(addressed('i think pax is lost', { names }), null)
  assert.equal(addressed('follow me', { names }), null)
  assert.equal(addressed('paxton follow me', { names }), null)
  assert.deepEqual(addressed('follow me', { names, whisper: true }), { body: 'follow me', explicit: true })
  assert.deepEqual(addressed('follow me', { names, alone: true }), { body: 'follow me', explicit: false })
  assert.deepEqual(addressed('follow me', { names, inConversation: true }), { body: 'follow me', explicit: false })
})

test('numbers: digits, words, stacks, vague amounts', () => {
  assert.equal(leadingCount('64 cobble').count, 64)
  assert.equal(leadingCount('twenty five logs').count, 25)
  assert.equal(leadingCount('sixty-four stone').count, 64)
  assert.equal(leadingCount('a stack of dirt').count, 64)
  assert.equal(leadingCount('half a stack of dirt').count, 32)
  assert.equal(leadingCount('3 stacks of dirt').count, 192)
  assert.equal(leadingCount('a few apples').count, 3)
  assert.equal(leadingCount('a dozen eggs').count, 12)
  assert.equal(leadingCount('some bread').count, undefined)
  assert.equal(leadingCount('a torch').count, 1)
})

test('items: aliases, plurals, block vs item context', () => {
  assert.equal(normalizeItem('cobble', 'block'), 'cobblestone')
  assert.equal(normalizeItem('logs', 'block'), 'log')
  assert.equal(normalizeItem('wood', 'item'), 'log')
  assert.equal(normalizeItem('wooden planks', 'item'), 'planks')
  assert.equal(normalizeItem('spruce logs', 'block'), 'spruce_log')
  assert.equal(normalizeItem('iron', 'block'), 'iron_ore')
  assert.equal(normalizeItem('iron', 'item'), 'iron_ingot')
  assert.equal(normalizeItem('diamonds', 'item'), 'diamond')
  assert.equal(normalizeItem('potatoes', 'item'), 'potato')
  assert.equal(normalizeItem('torches', 'item'), 'torch')
  assert.equal(normalizeItem('glass', 'item'), 'glass')
  assert.equal(normalizeItem('sweet berries', 'item'), 'sweet_berries')
  assert.equal(normalizeItem('stone bricks', 'block'), 'stone_bricks')
})
