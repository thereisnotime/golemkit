// Boxed in by an interrupted bunker: climb out before walking.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { boxedIn } from '../src/skills/pitPlan.ts'

const all = Array(8).fill(true)

test('boxedIn: solid all round with a lid close above', () => {
  assert.equal(boxedIn(all, 1), true)
  assert.equal(boxedIn(all, 3), true)
})

test('boxedIn: not with an open side, open sky or a high ceiling', () => {
  const open = [...all]; open[5] = false
  assert.equal(boxedIn(open, 1), false) // a doorway at head height
  assert.equal(boxedIn(all, null), false) // a hole open to the sky: pathfinding gets out
  assert.equal(boxedIn(all, 4), false)
})
