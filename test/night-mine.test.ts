// Pax never mined at night: night trips needed a lit mine, and its first mine was never dug by day
// because every surface search for iron turned back at sunset and went home instead of to the mine.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nightMineOk, turnedBackForLight, NIGHT_START_TORCHES, stairMineSettings } from '../src/skills/stairMinePlan.ts'

test('a known mine goes at night only when lit', () => {
  assert.ok(nightMineOk({ known: true, lit: true, torches: 0, startAtNight: true }))
  assert.ok(!nightMineOk({ known: true, lit: false, torches: 64, startAtNight: true }))
})

test('no mine yet: a first one at night with torches for the stairs', () => {
  assert.ok(nightMineOk({ known: false, lit: false, torches: NIGHT_START_TORCHES, startAtNight: true }))
  assert.ok(!nightMineOk({ known: false, lit: false, torches: NIGHT_START_TORCHES - 1, startAtNight: true }))
  assert.ok(!nightMineOk({ known: false, lit: false, torches: 64, startAtNight: false }))
})

test('sunset turn-backs are told apart from the others', () => {
  assert.ok(turnedBackForLight('37 s of daylight left and 9 s of walking home (26 blocks)'))
  assert.ok(turnedBackForLight('it is getting dark, 40 blocks from home'))
  assert.ok(!turnedBackForLight('a thunderstorm, 40 blocks from home'))
  assert.ok(!turnedBackForLight('food bar at 4 and nothing left to eat'))
  assert.ok(!turnedBackForLight(undefined))
})

test('mine.startAtNight defaults on and can be turned off', () => {
  assert.equal(stairMineSettings({}).startAtNight, true)
  assert.equal(stairMineSettings({ startAtNight: false }).startAtNight, false)
})
