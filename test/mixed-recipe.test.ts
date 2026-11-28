import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tagShape, planMix, mixedRecipe, mixFor, type RecipeLike } from '../src/skills/mixedRecipe.ts'

// ids: 1 oak_planks, 2 spruce_planks, 3 cherry_planks, 9 chest, 10 stick, 11 oak_stairs, 12 white_wool, 13 white_bed
const P = [1, 2, 3]
const cell = (id: number) => ({ id, metadata: null, count: 1 })
const E = { id: -1, metadata: null, count: 1 }
function chest (p: number): RecipeLike {
  return { inShape: [[cell(p), cell(p), cell(p)], [cell(p), E, cell(p)], [cell(p), cell(p), cell(p)]], ingredients: null, delta: [{ id: p, count: -8 }, { id: 9, count: 1 }], result: { id: 9, count: 1 }, requiresTable: true }
}
const bed = (p: number): RecipeLike => ({ inShape: [[cell(12), cell(12), cell(12)], [cell(p), cell(p), cell(p)]], ingredients: null, delta: [{ id: 12, count: -3 }, { id: p, count: -3 }, { id: 13, count: 1 }], result: { id: 13, count: 1 }, requiresTable: true })
const inv = (m: Record<number, number>) => (id: number) => m[id] ?? 0

test('mixed planks: a chest from 4 spruce and 4 oak (no single-wood recipe fits)', () => {
  const r = mixFor(P.map(chest), inv({ 1: 4, 2: 4 }))
  assert.ok(r.recipe)
  const d = Object.fromEntries(r.recipe!.delta.map(x => [x.id, x.count]))
  assert.deepEqual(d, { 1: -4, 2: -4, 9: 1 })
  assert.equal(r.recipe!.inShape![1]![1]!.id, -1, 'the middle stays empty')
})

test('mixed: short says how many of any member are missing', () => {
  const r = mixFor(P.map(chest), inv({ 1: 3, 3: 2 }))
  assert.equal(r.recipe, null)
  assert.deepEqual(r.short.map(s => s.need), [3])
  assert.deepEqual(r.short[0]!.alts.sort(), [1, 2, 3])
})

test('mixed: fixed slots stay exact (bed wool), only the varying slots mix', () => {
  const t = tagShape(P.map(bed))!
  assert.deepEqual(t.alts.slice(0, 3), [[12], [12], [12]])
  assert.equal(planMix(t.alts, inv({ 12: 2, 1: 2, 2: 1 })).fill, null, 'two wool is not three')
  const p = planMix(t.alts, inv({ 12: 3, 1: 2, 2: 1 }))
  assert.deepEqual(p.fill, [12, 12, 12, 1, 1, 2])
})

test('mixed: a one-variant recipe (oak_stairs) never mixes', () => {
  const stairs: RecipeLike = { inShape: [[cell(1), E, E], [cell(1), cell(1), E], [cell(1), cell(1), cell(1)]], ingredients: null, delta: [{ id: 1, count: -6 }, { id: 11, count: 4 }], result: { id: 11, count: 4 }, requiresTable: true }
  assert.equal(tagShape([stairs]), null)
  assert.equal(mixFor([stairs], inv({ 2: 64 })).recipe, null)
})

test('mixed: biggest stacks are used first, shapeless works, prototype kept', () => {
  class R { inShape = null; ingredients: any; delta: any; result: any; requiresTable = false; constructor (p: number) { this.ingredients = [cell(p), cell(p)]; this.delta = [{ id: p, count: -2 }, { id: 10, count: 4 }]; this.result = { id: 10, count: 4 } } }
  const r = mixFor(P.map(p => new R(p)) as any, inv({ 1: 1, 2: 1, 3: 5 }))
  assert.ok(r.recipe instanceof R)
  assert.deepEqual(r.recipe!.ingredients!.map((c: any) => c.id), [3, 3])
  const m = mixedRecipe(new R(1) as any, [2, 3])
  assert.deepEqual(m.delta, [{ id: 2, metadata: null, count: -1 }, { id: 3, metadata: null, count: -1 }, { id: 10, metadata: null, count: 4 }])
})
