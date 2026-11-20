import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveHumanize, typingDelayMs, styleLine, HUMANIZE_DEFAULTS } from '../src/core/humanize.ts'
import { parseProfile } from '../src/core/profile.ts'

const seq = (...v: number[]) => { let i = 0; return () => v[i++ % v.length]! }

test('humanize defaults on with immersive, off otherwise, explicit wins', () => {
  assert.equal(resolveHumanize({}), null)
  assert.deepEqual(resolveHumanize({ llm: { immersive: true } }), HUMANIZE_DEFAULTS)
  assert.equal(resolveHumanize({ llm: { immersive: true }, humanize: false }), null)
  assert.equal(resolveHumanize({ humanize: { typoRate: 0.5 } })!.typoRate, 0.5)
  assert.equal(resolveHumanize({ humanize: { enabled: false } }), null)
})

test('typing delay grows with length, includes reaction only when asked, and is capped', () => {
  const h = { ...HUMANIZE_DEFAULTS, reactionMs: [1000, 1000] as [number, number], charsPerSec: [10, 10] as [number, number] }
  assert.equal(typingDelayMs('hello there', h, { reaction: true }), 1000 + 1100)
  assert.equal(typingDelayMs('hello there', h, { reaction: false }), 1100)
  assert.equal(typingDelayMs('x'.repeat(10_000), h, { reaction: true }), h.maxDelayMs)
})

test('lowercase and a typo with a correction', () => {
  const h = { ...HUMANIZE_DEFAULTS, lowercase: true, typoRate: 1 }
  const r = styleLine('Coming over NOW', h, seq(0, 0.99, 0.3, 0))
  assert.equal(r.text.toLowerCase(), r.text)
  assert.ok(r.correction?.startsWith('*'))
  assert.notEqual(r.text, 'coming over now')
  assert.deepEqual(styleLine('ok', { ...h, typoRate: 0 }), { text: 'ok' })
})

test('profile humanize lands in settings', () => {
  const p = parseProfile('variant: companion\nllm: { immersive: true }\nhumanize: { lowercase: true }\n')
  assert.deepEqual((p.options.settings as any).humanize, { lowercase: true })
  assert.equal(resolveHumanize(p.options.settings!)!.lowercase, true)
})
