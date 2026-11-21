import { test } from 'node:test'
import assert from 'node:assert/strict'
import { catalog } from './self-helpers.ts'
import { parseProgram, applyPatch, diffSummary, formatSpec, mustParse, type ProgramInput } from '../src/brains/self/format.ts'
import { baseProgram } from '../variants/apprentice.ts'

const minimal = (extra: Partial<ProgramInput> = {}): ProgramInput => ({ version: 1, name: 't', ...extra })

test('the apprentice base program is valid', () => {
  const r = parseProgram(baseProgram, catalog())
  assert.ok(r.ok, r.ok ? '' : r.issues.join('\n'))
})

test('defaults fill in empty sections', () => {
  const r = parseProgram(minimal(), catalog())
  assert.ok(r.ok)
  assert.deepEqual(r.program.rules, [])
  assert.deepEqual(r.program.routines, {})
})

test('unknown action is rejected with a path', () => {
  const r = parseProgram(minimal({ routines: { a: [{ wait: 10 }, { act: 'teleport' }] } }), catalog())
  assert.equal(r.ok, false)
  assert.match(r.ok ? '' : r.issues.join('\n'), /routines\.a\[1\]\.act: unknown action "teleport"/)
})

test('bad action params are checked against the action schema', () => {
  const r = parseProgram(minimal({ rules: [{ name: 'w', score: 10, do: [{ act: 'wander', params: { radius: 500 } }] }] }), catalog())
  assert.equal(r.ok, false)
  assert.match(r.ok ? '' : r.issues.join('\n'), /rules\[0\]\.do\[0\]\.params\.radius/)
})

test('denied, long-running and program_* actions are refused', () => {
  const r = parseProgram(minimal({ routines: { a: [{ act: 'attack' }, { act: 'follow' }] } }), catalog())
  const issues = r.ok ? '' : r.issues.join('\n')
  assert.match(issues, /attack" is not allowed/)
  assert.match(issues, /follow" is long-running/)
})

test('unbounded while is rejected (max is required and capped)', () => {
  const noMax = parseProgram(minimal({ routines: { a: [{ while: { cond: { chance: 1 }, steps: [{ wait: 10 }] } }] } }), catalog())
  assert.equal(noMax.ok, false)
  assert.match(noMax.ok ? '' : noMax.issues.join('\n'), /routines\.a\[0\]\.while\.max/)
  const huge = parseProgram(minimal({ routines: { a: [{ while: { cond: { chance: 1 }, max: 100000, steps: [{ wait: 10 }] } }] } }), catalog())
  assert.equal(huge.ok, false)
  const big = parseProgram(minimal({ routines: { a: [{ repeat: { times: 1000, steps: [{ wait: 1 }] } }] } }), catalog())
  assert.equal(big.ok, false)
})

test('nested conditions and steps report deep paths', () => {
  const r = parseProgram(minimal({
    routines: { a: [{ if: { all: [{ fact: 'health', lt: 5 }, { fact: 'mana', gt: 1 }] }, then: [{ say: 'hi' }], else: [{ act: 'jump', params: { high: true } }] }] }
  }), catalog())
  const issues = r.ok ? '' : r.issues.join('\n')
  assert.match(issues, /routines\.a\[0\]\.if\.all\[1\]\.fact: unknown fact/)
  assert.match(issues, /routines\.a\[0\]\.else\[0\]\.params/)
})

test('a step with two kinds or none is rejected', () => {
  const r = parseProgram(minimal({ routines: { a: [{ say: 'x', wait: 5 } as any, {} as any] } }), catalog())
  const issues = r.ok ? '' : r.issues.join('\n')
  assert.match(issues, /\[0\]: has several step kinds/)
  assert.match(issues, /\[1\]: no step kind/)
})

test('references, recursion and placeholders are checked', () => {
  const r = parseProgram(minimal({
    rules: [{ name: 'r', score: 5, do: 'missing' }],
    routines: { a: [{ run: 'b' }], b: [{ run: 'a' }], c: [{ say: 'hi {target}' }] }
  }), catalog())
  const issues = r.ok ? '' : r.issues.join('\n')
  assert.match(issues, /no routine "missing"/)
  assert.match(issues, /recursion/)
  assert.match(issues, /unknown placeholder \{target\}/)
})

test('triggers need their kind-specific fields', () => {
  const r = parseProgram(minimal({ triggers: [{ name: 'x', on: 'chat', do: [{ say: 'hi' }] }, { name: 'y', on: 'interval', everyMs: 50, do: [{ say: 'hi' }] }] }), catalog())
  const issues = r.ok ? '' : r.issues.join('\n')
  assert.match(issues, /triggers\[0\]\.match/)
  assert.match(issues, /triggers\[1\]\.everyMs/)
})

test('templates in string params validate', () => {
  const r = parseProgram(minimal({ triggers: [{ name: 'hello', on: 'chat', match: ['hello'], do: [{ act: 'look_at', params: { player: '{player}' } }, { say: 'hi {player}' }] }] }), catalog())
  assert.ok(r.ok, r.ok ? '' : r.issues.join('\n'))
})

test('patches upsert by name and remove', () => {
  const base = mustParse(baseProgram, catalog())
  const raw = applyPatch(base, {
    set: { triggers: [{ name: 'hello', on: 'chat', match: ['hello'], do: [{ act: 'jump' }, { say: 'hi {player}' }] }], rules: [{ name: 'stroll', score: 12, do: 'stroll' }] },
    remove: { rules: ['night_stroll'] }
  })
  const r = parseProgram(raw, catalog())
  assert.ok(r.ok, r.ok ? '' : r.issues.join('\n'))
  assert.equal(r.program.rules.find(x => x.name === 'stroll')!.score, 12)
  assert.ok(!r.program.rules.some(x => x.name === 'night_stroll'))
  assert.equal(diffSummary(base, r.program), '~rule stroll, -rule night_stroll, +trigger hello')
})

test('the spec lists allowed actions only, with params', () => {
  const spec = formatSpec(catalog())
  assert.match(spec, /- wander: Walk around\. params=/)
  assert.doesNotMatch(spec, /- attack:/)
  assert.doesNotMatch(spec, /- follow:/)
  assert.match(spec, /while.*max/)
})
