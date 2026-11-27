import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  dodgeSettings, DODGE_DEFAULTS, leapTravel, walkTravel, yawOf, landingProblem, cellOf, pickSide, projectileHit, clearance,
  advanceProjectile, releaseWindow, mobReach, meleeTiming, meleeCooldownMs, planDodge, DODGE_TECHNIQUES,
  type Cell, type DodgeView, type AttackerView, type DodgeTechnique
} from '../src/skills/dodgePlan.ts'
import { creeperMove } from '../src/skills/tactics.ts'
import { creeperEscape, LEAP_GAIN } from '../src/skills/techniques.ts'
import { findToggle, parseToggleValue } from '../src/core/toggles.ts'
import { unknownProfileKeys } from '../src/core/profile.ts'

test('settings: defaults, overrides, bad values and false', () => {
  assert.deepEqual(dodgeSettings(undefined), DODGE_DEFAULTS)
  const s = dodgeSettings({ arrows: false, latencyMs: 120, maxDrop: 9, leapMs: 'x' })
  assert.equal(s.arrows, false)
  assert.equal(s.latencyMs, 120)
  assert.equal(s.maxDrop, DODGE_DEFAULTS.maxDrop, 'out of bounds: default')
  assert.equal(s.leapMs, DODGE_DEFAULTS.leapMs, 'wrong type: default')
  assert.equal(dodgeSettings(false).enabled, false)
  for (const k of Object.keys(DODGE_DEFAULTS)) assert.ok(findToggle(`combat.dodge.${k}`), `live toggle for ${k}`)
  assert.deepEqual(parseToggleValue(findToggle('combat.dodge.arrows')!, 'off'), { ok: true, value: false })
  assert.deepEqual(unknownProfileKeys({ settings: { combat: { dodge: { arrows: false }, crits: true, nope: 1 } } }), ['settings.combat.nope'], 'settings.combat.dodge is a known key')
})

test('movement model: a sprint-jump beats a walk, both grow with time', () => {
  assert.ok(leapTravel(1) > 0.3 && leapTravel(1) < 0.4)
  assert.ok(leapTravel(6) > 1.2 && leapTravel(6) < 2, `6 ticks: ${leapTravel(6)}`)
  assert.ok(leapTravel(6) > walkTravel(6))
  assert.ok(walkTravel(20) > 3.5 && walkTravel(20) < 4.5, 'walking ~0.2 a tick')
  assert.equal(leapTravel(0), 0)
  assert.ok(Math.abs(yawOf({ x: 0, z: -1 })) < 1e-9, 'yaw 0 faces -z')
  assert.ok(Math.abs(yawOf({ x: -1, z: 0 }) - Math.PI / 2) < 1e-9, 'yaw 90 faces -x')
})

// a flat world: floor at y 63 (solid), air above; overrides per cell
function world (over: Record<string, Cell> = {}, floor = 63): (x: number, y: number, z: number) => Cell {
  return (x, y, z) => over[`${x},${y},${z}`] ?? (y <= floor ? 'solid' : 'air')
}

test('landing check: flat ground is fine; walls, water, lava, fire, powder snow and deep drops are not', () => {
  const from = { x: 0.5, y: 64, z: 0.5 }
  const east = { x: 1, z: 0 }
  assert.equal(landingProblem(world(), from, east, 2.5, 2), null)
  assert.equal(landingProblem(world({ '2,64,0': 'solid' }), from, east, 2.5, 2), 'wall')
  assert.equal(landingProblem(world({ '1,65,0': 'solid' }), from, east, 2.5, 2), 'wall', 'head height')
  assert.equal(landingProblem(world({ '2,64,0': 'water' }), from, east, 2.5, 2), 'water')
  assert.equal(landingProblem(world({ '2,63,0': 'lava' }), from, east, 2.5, 2), 'lava below')
  assert.equal(landingProblem(world({ '1,64,0': 'fire' }), from, east, 2.5, 2), 'fire or a block that hurts')
  assert.equal(landingProblem(world({ '2,64,0': 'powder_snow' }), from, east, 2.5, 2), 'powder snow')
  // a hole 3 deep at x 2
  const hole = { '2,63,0': 'air', '2,62,0': 'air', '2,61,0': 'air' } as Record<string, Cell>
  assert.equal(landingProblem(world(hole), from, east, 2.5, 2), 'a drop deeper than 2')
  assert.equal(landingProblem(world(hole), from, east, 2.5, 3), null, 'maxDrop 3 allows it')
  assert.equal(landingProblem(world({ '1,63,0': 'air' }), from, east, 2.5, 2), null, 'a 1-deep dip is fine')
  assert.equal(landingProblem(world(), from, { x: -1, z: 0 }, 2.5, 2), null)
  assert.equal(landingProblem(() => 'unknown', from, east, 2.5, 2), 'unloaded')
  assert.equal(cellOf('water', false), 'water')
  assert.equal(cellOf('magma_block', true), 'danger')
  assert.equal(cellOf('stone', true), 'solid')
  assert.equal(cellOf('short_grass', false), 'air')
})

test('side choice: only safe sides that clear in time, fewer mobs first, random otherwise, not three times the same way', () => {
  const a = { dir: { x: 1, z: 0 }, need: 0.5, can: 1, safe: true }
  const b = { dir: { x: -1, z: 0 }, need: 0.5, can: 1, safe: true }
  assert.equal(pickSide([a, { ...b, safe: false }], () => 0.99), 0)
  assert.equal(pickSide([{ ...a, need: 2 }, b], () => 0), 1, 'a cannot clear in time')
  assert.equal(pickSide([{ ...a, safe: false }, { ...b, safe: false }], () => 0), -1)
  assert.equal(pickSide([{ ...a, crowd: 2 }, b], () => 0), 1, 'mobs on the left')
  assert.equal(pickSide([a, b], () => 0), 0)
  assert.equal(pickSide([a, b], () => 0.99), 1)
  assert.equal(pickSide([a, b], () => 0, [0, 0]), 1, 'twice left: right now')
  // over many draws both sides come up
  let seed = 7
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
  const n = [0, 0]
  for (let i = 0; i < 200; i++) n[pickSide([a, b], rnd)]!++
  assert.ok(n[0]! > 60 && n[1]! > 60, `both sides: ${n}`)
})

test('projectile hit: an arrow aimed at the body hits, one a block to the side misses, the body moving out of the way counts', () => {
  const body = { pos: { x: 0, y: 64, z: 0 } }
  // from 12 blocks north (-z), flying south at 1.6 a tick, aimed at the chest
  const at = { id: 1, name: 'arrow', pos: { x: 0, y: 65.3, z: -12 }, vel: { x: 0, y: 0.05, z: 1.6 } }
  const h = projectileHit(at, body)
  assert.ok(h, 'hits')
  assert.ok(h!.ticks > 6 && h!.ticks < 8, `ticks ${h!.ticks}`)
  assert.equal(projectileHit({ ...at, pos: { ...at.pos, x: 1.2 } }, body), null, 'passes 1.2 to the side')
  assert.equal(projectileHit({ ...at, vel: { x: 0, y: 0, z: -1.6 } }, body), null, 'flying away')
  assert.equal(projectileHit({ ...at, vel: { x: 0, y: 0, z: 0.05 } }, body), null, 'lying still')
  // sprinting sideways at 0.28 a tick clears it
  assert.equal(projectileHit(at, { ...body, vel: { x: 0.28, y: 0, z: 0 } }), null, 'moving out of the way')
  // too high: over the head
  assert.equal(projectileHit({ ...at, pos: { ...at.pos, y: 67.5 }, vel: { x: 0, y: 0.1, z: 1.6 } }, body), null)
  // clearance: crossing just left of the centre, the right side is the short way
  const off = projectileHit({ ...at, pos: { ...at.pos, x: 0.3 } }, body)!
  const [l, r] = clearance(off)
  assert.ok(off)
  assert.ok(Math.abs(l + r - 2 * off.extent) < 1e-9)
  assert.ok(Math.min(l, r) < 0.5, `short side ${Math.min(l, r)}`)
  // fireballs fly straight
  assert.ok(projectileHit({ id: 2, name: 'small_fireball', pos: { x: -10, y: 65, z: 0 }, vel: { x: 1, y: 0, z: 0 } }, body))
})

test('advancing a projectile follows the same physics', () => {
  const p = { id: 1, name: 'arrow', pos: { x: 0, y: 70, z: 0 }, vel: { x: 1, y: 0, z: 0 } }
  const q = advanceProjectile(p, 2)
  assert.ok(Math.abs(q.pos.x - 1.99) < 1e-9)
  assert.ok(Math.abs(q.pos.y - 69.95) < 1e-9, 'gravity after the first tick')
  assert.deepEqual(advanceProjectile(p, 0).pos, p.pos)
})

test('release window: skeleton 20 ticks into the draw, pillager 20 to 39 ticks after charging', () => {
  const sk = { id: 1, name: 'skeleton', pos: { x: 0, y: 0, z: 8 }, dist: 8, los: true, drawingMs: 600, chargedMs: null }
  assert.deepEqual(releaseWindow(sk), [400, 400])
  assert.equal(releaseWindow({ ...sk, los: false }), null, 'no line: no shot')
  assert.equal(releaseWindow({ ...sk, drawingMs: null }), null)
  assert.equal(releaseWindow({ ...sk, drawingMs: 1500 }), null, 'long past: it shot already')
  assert.deepEqual(releaseWindow({ ...sk, name: 'pillager', drawingMs: null, chargedMs: 500 }), [500, 1500])
})

test('mob reach: axis-aligned boxes, 1.43 for a zombie, wider mobs further', () => {
  assert.ok(Math.abs(mobReach(0.6) - 1.428) < 0.01)
  assert.ok(mobReach(1.4) > 1.8, 'spider')
  assert.equal(meleeCooldownMs('zombie'), 1000)
  assert.equal(meleeCooldownMs('slime'), 500)
  assert.equal(meleeCooldownMs('husk', 900), 900, 'fallback knob')
})

test('melee timing: hold while it recharges, step or leap out before it is ready', () => {
  const s = { latencyMs: 75, meleeLeadMs: 150, meleeMargin: 0.35 }
  const z = (o: Partial<AttackerView>): AttackerView => ({ id: 1, name: 'zombie', dx: 0, dz: -1.6, width: 0.6, sinceSwingMs: 100, cooldownMs: 1000, ...o })
  assert.deepEqual(meleeTiming([z({})], s), { act: 'hold' }, 'just swung: 900 ms to go')
  assert.deepEqual(meleeTiming([z({ sinceSwingMs: 700 })], s), { act: 'back', from: 1 }, 'ready in 300: walk out')
  const m = meleeTiming([z({ sinceSwingMs: 1200, dz: -1.0 })], s)
  assert.equal(m?.act, 'leap', 'ready and deep in reach: leap')
  assert.deepEqual(m && m.act === 'leap' && m.dir, { x: 0, z: 1 }, 'away along the axis it is on')
  assert.equal(meleeTiming([z({ sinceSwingMs: null, dz: -2.5 })], s), null, 'out of reach + margin: no opinion')
  assert.equal(meleeTiming([z({ dz: -6 })], s), null, 'far away')
  assert.equal(meleeTiming([z({ sinceSwingMs: 1200, dz: -1.2, dy: 3 })], s), null, 'on a ledge above')
  // diagonal: the box reaches further, 1.6 x 1.6 is still inside 1.43 + 0.35 per axis
  assert.equal(meleeTiming([z({ sinceSwingMs: 700, dx: 1.6, dz: 1.6 })], s)?.act, 'back')
  assert.equal(meleeTiming([z({ sinceSwingMs: null, dx: 1.6, dz: 1.6 })], s)?.act, 'leap', 'ready now: no time to walk')
  // two mobs: one recharging, one ready: the ready one decides
  assert.notEqual(meleeTiming([z({}), z({ id: 2, sinceSwingMs: null, dz: 1.2 })], s)?.act, 'hold')
})

function view (o: Partial<DodgeView> = {}): DodgeView {
  return {
    now: 10_000, body: { pos: { x: 0, y: 64, z: 0 }, vel: { x: 0, y: 0, z: 0 } }, yaw: 0, onGround: true,
    projectiles: [], archers: [], attackers: [], safe: () => true, rnd: () => 0.3, lastSides: [], handled: new Set(), ...o
  }
}

test('planDodge: arrows, draws and melee, with the switches', () => {
  const arrow = { id: 5, name: 'arrow', pos: { x: 0, y: 65.3, z: -20 }, vel: { x: 0, y: 0.25, z: 1.6 } }
  const i = planDodge(view({ projectiles: [arrow] }), DODGE_DEFAULTS)
  assert.equal(i?.kind, 'leap')
  assert.equal(i?.kind === 'leap' && i.technique, 'arrows')
  assert.ok(i?.kind === 'leap' && Math.abs(i.dir.z) < 1e-9, 'perpendicular to the flight')
  assert.equal(planDodge(view({ projectiles: [arrow], handled: new Set(['p:5']) }), DODGE_DEFAULTS), null, 'already dodged')
  assert.equal(planDodge(view({ projectiles: [arrow] }), { ...DODGE_DEFAULTS, arrows: false }), null)
  assert.equal(planDodge(view({ projectiles: [arrow] }), { ...DODGE_DEFAULTS, enabled: false }), null)
  assert.equal(planDodge(view({ projectiles: [arrow], safe: () => false }), DODGE_DEFAULTS), null, 'nowhere safe to land')
  // point blank, arriving next tick: too late, nothing to do
  assert.equal(planDodge(view({ projectiles: [{ ...arrow, pos: { x: 0, y: 65.3, z: -1.5 } }] }), DODGE_DEFAULTS), null)

  const sk = { id: 7, name: 'skeleton', pos: { x: 0, y: 64, z: -8 }, dist: 8, los: true, drawingMs: 900, chargedMs: null }
  const d = planDodge(view({ archers: [sk] }), DODGE_DEFAULTS)
  assert.equal(d?.kind === 'leap' && d.technique, 'draws', 'release in 100 ms: go')
  assert.equal(planDodge(view({ archers: [{ ...sk, drawingMs: 300 }] }), DODGE_DEFAULTS), null, 'too early')
  assert.equal(planDodge(view({ archers: [{ ...sk, dist: 14 }] }), DODGE_DEFAULTS), null, 'beyond drawRange: the arrow decides')
  assert.equal(planDodge(view({ archers: [sk] }), { ...DODGE_DEFAULTS, draws: false }), null)

  const zombie: AttackerView = { id: 3, name: 'zombie', dx: 0, dz: -1.2, width: 0.6, sinceSwingMs: 1100, cooldownMs: 1000 }
  assert.equal(planDodge(view({ attackers: [zombie] }), DODGE_DEFAULTS)?.kind, 'leap')
  assert.equal(planDodge(view({ attackers: [zombie], safe: () => false }), DODGE_DEFAULTS)?.kind, 'back', 'no room to leap: step back')
  assert.equal(planDodge(view({ attackers: [zombie] }), { ...DODGE_DEFAULTS, meleeTiming: false }), null)
  // an arrow beats a step back
  assert.equal(planDodge(view({ attackers: [zombie], projectiles: [arrow] }), DODGE_DEFAULTS)?.technique, 'arrows')
})

test('the registry takes another technique without touching the loop', () => {
  const always: DodgeTechnique = { name: 'test', key: 'enabled', plan: () => ({ kind: 'hold', technique: 'test' }) }
  assert.equal(planDodge(view(), DODGE_DEFAULTS, [...DODGE_TECHNIQUES, always])?.technique, 'test')
  assert.equal(planDodge(view(), DODGE_DEFAULTS, DODGE_TECHNIQUES), null)
})

test('creeper: leap instead of walking when the dodge layer has it, and the faster escape needs the shield less', () => {
  assert.equal(creeperMove({ dist: 2.5, fuseLit: true, bow: false, leap: true }), 'leap')
  assert.equal(creeperMove({ dist: 2.5, fuseLit: true, bow: false }), 'back_off')
  assert.equal(creeperMove({ dist: 8, fuseLit: false, bow: true, leap: true }), 'shoot')
  assert.equal(creeperEscape({ dist: 3, msLeft: 1300, shield: true }), 'shield', 'walking: 3 + 2.6 < 7')
  assert.equal(creeperEscape({ dist: 3, msLeft: 1300, shield: true, gain: LEAP_GAIN }), 'run', 'sprint-jumping: 3 + 4.5 > 7')
})
