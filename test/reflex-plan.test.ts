import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mayReplace, HOLD_MS } from '../src/skills/reflexPlan.ts'

const s = (o: Partial<Parameters<typeof mayReplace>[0]>) => ({ current: 'defend', currentIsReflex: true, sinceStartMs: 5000, healthDrop: 0, next: 'retreat', meleeDist: Infinity, ...o })

test('arbiter: idle, a non-reflex action or an unrefereed one never blocks a reflex', () => {
  assert.equal(mayReplace(s({ current: null })), null)
  assert.equal(mayReplace(s({ currentIsReflex: false })), null, "a player's command is the priorities' business")
  assert.equal(mayReplace(s({ current: 'gear_up' })), null)
})

test('arbiter: a reflex keeps the body 1.5 s unless health drops sharply; water always', () => {
  assert.equal(mayReplace(s({ sinceStartMs: 300 })), 'defend just started')
  assert.equal(mayReplace(s({ sinceStartMs: HOLD_MS + 1 })), null)
  assert.equal(mayReplace(s({ sinceStartMs: 300, healthDrop: 5 })), null)
  assert.equal(mayReplace(s({ sinceStartMs: 300, next: 'water_bucket' })), null)
  assert.equal(mayReplace(s({ next: 'defend' })), 'already running')
})

test('arbiter: the underground skeleton case does not flap (climb_out / ranged_defense / defend)', () => {
  // climbing out: archers don't pull it back into ranged_defense, a spider 4 blocks off doesn't start a fight
  assert.match(mayReplace(s({ current: 'climb_out', next: 'ranged_defense' }))!, /gets away/)
  assert.match(mayReplace(s({ current: 'climb_out', next: 'defend', meleeDist: 4 }))!, /nothing adjacent/)
  assert.equal(mayReplace(s({ current: 'climb_out', next: 'defend', meleeDist: 1.5 })), null, 'a spider on it')
  assert.match(mayReplace(s({ current: 'retreat', next: 'defend', meleeDist: 5 }))!, /nothing adjacent/)
  // ranged_defense isn't interrupted by defend for a mob further than 3
  assert.match(mayReplace(s({ current: 'ranged_defense', next: 'defend', meleeDist: 5 }))!, /no melee mob within 3/)
  assert.equal(mayReplace(s({ current: 'ranged_defense', next: 'defend', meleeDist: 2 })), null)
  // getting out still wins over fighting archers
  assert.equal(mayReplace(s({ current: 'ranged_defense', next: 'climb_out' })), null)
  assert.equal(mayReplace(s({ current: 'defend', next: 'climb_out' })), null)
})
