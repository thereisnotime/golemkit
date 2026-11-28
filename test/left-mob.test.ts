// A mob a fight left (down a drop) is not picked up again by the proactive defend for a while.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stillLeft, LEFT_MOB_MS } from '../src/skills/tactics.ts'

test('stillLeft: left lately and not close: leave it; expired or right on top: fight', () => {
  const left = new Map([[7, 1000 + LEFT_MOB_MS]])
  assert.equal(stillLeft(left, 7, 6, 1000), true)
  assert.equal(stillLeft(left, 7, 2.5, 1000), false)
  assert.equal(stillLeft(left, 7, 6, 1000 + LEFT_MOB_MS + 1), false)
  assert.equal(stillLeft(left, 8, 6, 1000), false)
})
