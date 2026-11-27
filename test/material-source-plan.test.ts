// Material sources (src/skills/materialSourcePlan.ts, settings src/core/materialSources.ts): the
// ordered list of places a build's or a repair's materials come from, why each one is used or
// skipped, the record of a run, and the spots further out to dig for stone.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planSources, shortOf, substitutes, fmtSourcePlan, fmtSourceRun, noteFailures, farStarts, type SourceFacts } from '../src/skills/materialSourcePlan.ts'
import { MATERIAL_SOURCES, MATERIAL_SOURCES_DEFAULTS, materialSourcesSettings } from '../src/core/materialSources.ts'
import { countWant, wantsForRoles } from '../src/skills/materials.ts'
import { loadBlueprints, resolveRoles, rotate, placeCells } from '../src/skills/blueprint.ts'
import { blueprintStages, stageCells } from '../src/skills/basePlan.ts'

const ALL = [...MATERIAL_SOURCES]
const STONE_ACCEPT = /^(cobblestone|mossy_cobblestone|cobbled_deepslate|stone|stone_bricks|mossy_stone_bricks|andesite|polished_andesite|smooth_stone)$/

function facts (o: Partial<SourceFacts> = {}): SourceFacts {
  return {
    carried: {},
    stored: null,
    count: countWant,
    craftable: k => !['cobblestone', 'dirt', 'sand', 'gravel', 'log'].includes(k),
    raw: k => ['cobblestone', 'dirt', 'sand', 'gravel', 'log'].includes(k),
    stone: k => k === 'cobblestone',
    canDig: true,
    mine: null,
    far: null,
    now: 1_000_000,
    retryMs: 30 * 60_000,
    ...o
  }
}

test('sources: cobblestone in its chests is taken from there, nothing is dug', () => {
  // a repair of 16 cobblestone and 3 ladders with hundreds of cobblestone in the chests
  const p = planSources({ cobblestone: 16, ladder: 3 }, facts({ stored: { cobblestone: 508, stick: 3, ladder: 2 } }), ALL)
  assert.deepEqual(p.steps.map(s => s.source), ['chests', 'craft'])
  assert.deepEqual(p.steps[0]!.items, { cobblestone: 16, ladder: 2 })
  assert.deepEqual(p.steps[1]!.items, { ladder: 1 })
  assert.deepEqual(p.short, {})
  assert.match(fmtSourcePlan(p), /using chests \(my chests hold 16 cobblestone, 2 ladder\), then craft/)
  assert.match(fmtSourcePlan(p), /nearby: nothing short that is dug/)
})

test('sources: substitutes the blueprint takes, from the chests and carried', () => {
  const accepts = { cobblestone: [STONE_ACCEPT] }
  assert.equal(substitutes('cobblestone', 'andesite', { accepts, count: countWant }), true)
  assert.equal(substitutes('cobblestone', 'cobblestone', { accepts, count: countWant }), false)
  assert.equal(substitutes('cobblestone', 'granite', { accepts, count: countWant }), false)
  // two roles want cobblestone: only what both take stands in
  assert.equal(substitutes('cobblestone', 'andesite', { accepts: { cobblestone: [STONE_ACCEPT, /^(cobblestone|stone_bricks)$/] }, count: countWant }), false)
  // carried andesite counts
  assert.deepEqual(shortOf({ cobblestone: 9 }, { carried: { andesite: 4 }, accepts, count: countWant }, true), { cobblestone: 5 })
  assert.deepEqual(shortOf({ cobblestone: 9 }, { carried: { andesite: 4 }, accepts, count: countWant }, false), { cobblestone: 9 })
  const p = planSources({ cobblestone: 9 }, facts({ accepts, stored: { andesite: 67, granite: 77 } }), ALL)
  assert.deepEqual(p.steps.map(s => s.source), ['substitutes'])
  assert.deepEqual(p.steps[0]!.items, { andesite: 9 })
  assert.equal(p.skipped.find(s => s.source === 'chests')!.why, 'none of it in my chests')
  // without accepts there is nothing to stand in
  const q = planSources({ cobblestone: 9 }, facts({ stored: { andesite: 67 } }), ALL)
  assert.equal(q.skipped.find(s => s.source === 'substitutes')!.why, 'the blueprint allows nothing else')
})

test('sources: with the stone near home ruled out, its own mine comes next, then stone further out', () => {
  const failed = { 'nearby:cobblestone': { at: 1_000_000 - 2 * 60_000, why: 'mined no cobblestone: every way on is unsafe (water)' } }
  const p = planSources({ cobblestone: 16 }, facts({ stored: { dirt: 40 }, failed }), ALL)
  assert.deepEqual(p.steps.map(s => s.source), ['mine'])
  assert.match(p.skipped.find(s => s.source === 'nearby')!.why, /gave no cobblestone 2 min ago: mined no cobblestone/)
  assert.match(p.skipped.find(s => s.source === 'far')!.why, /only if mine falls short/)
  // after the mine gave too little, far is next
  const q = planSources({ cobblestone: 16 }, facts({ carried: { cobblestone: 4 }, failed }), ALL, new Set(['chests', 'substitutes', 'craft', 'nearby', 'mine']))
  assert.deepEqual(q.steps.map(s => s.source), ['far'])
  assert.deepEqual(q.steps[0]!.items, { cobblestone: 12 })
  // the failure is forgotten after retryMs
  const later = planSources({ cobblestone: 16 }, facts({ failed, now: 1_000_000 + 31 * 60_000 }), ALL)
  assert.equal(later.steps[0]!.source, 'nearby')
})

test('sources: a mine that is not ready, digging off, a short list of sources', () => {
  const p = planSources({ cobblestone: 8 }, facts({ mine: 'not ready to go down: no food', failed: { 'nearby:cobblestone': { at: 999_000, why: 'x' } } }), ALL)
  assert.deepEqual(p.steps.map(s => s.source), ['far'])
  assert.equal(p.skipped.find(s => s.source === 'mine')!.why, 'not ready to go down: no food')
  const off = planSources({ cobblestone: 8 }, facts({ canDig: false }), ALL)
  assert.deepEqual(off.steps, [])
  assert.deepEqual(off.short, { cobblestone: 8 })
  assert.match(fmtSourcePlan(off), /no source left for 8 cobblestone/)
  // sources left out are never used, and the order is the settings' order
  const only = planSources({ cobblestone: 8 }, facts({ stored: { cobblestone: 64 } }), ['mine', 'chests'])
  assert.deepEqual(only.steps.map(s => s.source), ['mine', 'chests'])
})

test('sources: chests it never looked into are tried when the known ones lack it', () => {
  const p = planSources({ cobblestone: 8 }, facts({ stored: { dirt: 3 }, unknownChests: 2 }), ALL)
  assert.equal(p.steps[0]!.source, 'chests')
  assert.match(p.steps[0]!.why, /2 of my chests I never looked into/)
})

test('sources: a run is remembered and told in one line; failures per source and item', () => {
  const line = fmtSourceRun({ used: [{ source: 'chests', got: { cobblestone: 16 } }, { source: 'nearby', got: {}, note: 'every way on is unsafe' }], skipped: [{ source: 'mine', why: 'no stone pickaxe' }], short: { ladder: 1 } })
  assert.equal(line, 'materials: chests gave 16 cobblestone, nearby gave nothing (every way on is unsafe); skipped mine (no stone pickaxe); still short 1 ladder')
  let f = noteFailures({}, { source: 'nearby', got: {}, note: 'water' }, { cobblestone: 9 }, 100, 60_000)
  assert.deepEqual(Object.keys(f), ['nearby:cobblestone'])
  f = noteFailures(f, { source: 'nearby', got: { cobblestone: 3 } }, { cobblestone: 9 }, 200, 60_000)
  assert.deepEqual(f, {})
  // old entries drop out
  f = noteFailures({ 'mine:cobblestone': { at: 0, why: 'x' } }, { source: 'far', got: { cobblestone: 1 } }, { cobblestone: 1 }, 120_000, 60_000)
  assert.deepEqual(f, {})
})

test('sources: spots further out are past the keep-out, nearest first', () => {
  const box = { min: { x: 552, z: -51 }, max: { x: 568, z: -35 } }
  const s = farStarts(box, 4, 32, { x: 560, z: -60 })
  assert.equal(s.length, 8)
  assert.deepEqual(s[0], { x: 560, z: -51 - 36 })
  for (const p of s) assert.ok(p.x < 552 - 4 || p.x > 568 + 4 || p.z < -51 - 4 || p.z > -35 + 4)
})

test('sources: settings with defaults; wrong values fall back', () => {
  assert.deepEqual(materialSourcesSettings(undefined), MATERIAL_SOURCES_DEFAULTS)
  const s = materialSourcesSettings({ sources: ['mine', 'chests', 'mine', 'bogus'], retryMinutes: -1, mineMinutes: 12, farDistance: 3 })
  assert.deepEqual(s.sources, ['mine', 'chests'])
  assert.equal(s.retryMinutes, 30)
  assert.equal(s.mineMinutes, 12)
  assert.equal(s.farDistance, 32)
})

test('sources: the fortress floor takes andesite, the whole fortress (walls too) does not', () => {
  const bp = loadBlueprints().blueprints.get('fortress')!
  const turned = rotate(bp, 'north')
  const cells = placeCells(turned, { x: 0, y: 0, z: 0 })
  const roles = resolveRoles(turned, {})
  const stages = blueprintStages(bp)
  const floor = wantsForRoles(stageCells(cells, stages.find(s => s.name === 'floor')!, stages), roles)
  assert.equal(substitutes('cobblestone', 'andesite', { accepts: floor.accepts, count: countWant }), true)
  const all = wantsForRoles(cells, roles)
  assert.equal(substitutes('cobblestone', 'andesite', { accepts: all.accepts, count: countWant }), false)
  assert.equal(substitutes('cobblestone', 'cobbled_deepslate', { accepts: all.accepts, count: countWant }), true)
})
