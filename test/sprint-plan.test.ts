// Walk, don't sprint, on a low food bar.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sprintAllowed, sprintAbove, SPRINT_ABOVE_DEFAULT } from '../src/skills/sprintPlan.ts'

test('sprintAllowed: only above the threshold; 0 or unknown food always sprints', () => {
  assert.equal(sprintAllowed(13, 12), true)
  assert.equal(sprintAllowed(12, 12), false)
  assert.equal(sprintAllowed(6, 12), false)
  assert.equal(sprintAllowed(3, 0), true)
  assert.equal(sprintAllowed(undefined, 12), true)
})

test('sprintAbove: fallback and clamping', () => {
  assert.equal(sprintAbove(undefined), SPRINT_ABOVE_DEFAULT)
  assert.equal(sprintAbove('x'), SPRINT_ABOVE_DEFAULT)
  assert.equal(sprintAbove(25), 20)
  assert.equal(sprintAbove(8), 8)
})
