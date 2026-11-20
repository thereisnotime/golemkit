import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseSceneYaml, parseScene, loadSceneDir, SceneValidationError, scene, b, castRoles, electDirector, electCoordinator,
  renderTemplate, type ActorEntry
} from '../src/brains/scene/index.ts'

const minimal = (beats: string, extra = '') => `
name: t
roles: { hauler: {}, miner: {} }
marks: { cart: [0, 0], pile: [3, 1, 2] }
${extra}
beats:
${beats}
`

function issues (fn: () => unknown): string[] {
  try { fn() } catch (e) {
    assert.ok(e instanceof SceneValidationError, String(e))
    return e.issues
  }
  assert.fail('expected a validation error')
}

test('demo scenes load', () => {
  const scenes = loadSceneDir('scenes')
  const names = scenes.map(s => s.name)
  assert.ok(names.includes('broken_cart'))
  assert.ok(names.includes('gossip_walk'))
  const cart = scenes.find(s => s.name === 'broken_cart')!
  assert.deepEqual(Object.keys(cart.roles), ['hauler', 'foreman', 'miner'])
  assert.equal(cart.options.lineGapMs, 1600)
  assert.equal(cart.interactions.length, 3)
})

test('valid yaml with nested beats', () => {
  const s = parseSceneYaml(minimal(`
  - { as: hauler, say: ["a", "b"] }
  - parallel:
      - [{ as: miner, goto: pile }, { cue: there }]
      - { as: hauler, look: miner }
  - { await: there }
  - repeat: { times: [1, 2], beats: [{ wait: 10 }] }
  - choose: [{ weight: 2, beats: [{ as: miner, gesture: nod }] }, { beats: [] }]
  - if: { key: $x, equals: 1 }
    then: [{ as: hauler, act: jump }]
    else: [{ set: { $x: 1 } }]
`))
  assert.equal(s.beats.length, 6)
  const par = s.beats[1] as { parallel: unknown[][] }
  assert.equal(par.parallel[1]!.length, 1, 'single-beat branch is wrapped in a list')
})

test('unknown role is reported with its path', () => {
  const out = issues(() => parseSceneYaml(minimal(`
  - { as: hauler, say: hi }
  - parallel:
      - [{ as: minr, say: oops }]
`)))
  assert.ok(out.some(i => i.includes('beats[1].parallel[0][0]') && i.includes('unknown role "minr"')), out.join('\n'))
})

test('structural beat errors', () => {
  const text = issues(() => parseSceneYaml(minimal(`
  - { as: hauler, say: x, act: jump }
  - { as: hauler, bogus: 1 }
  - { as: hauler, gesture: dance }
`))).join('\n')
  assert.match(text, /beats\[0\]: has several beat kinds/)
  assert.match(text, /beats\[1\]: no beat kind/)
  assert.match(text, /beats\[2\]\.gesture/)
})

test('reference errors', () => {
  const text = issues(() => parseSceneYaml(minimal(`
  - { as: hauler, goto: nowhere }
  - { say: "who says this?" }
  - { await: never }
  - { await: "ext:other_scene" }
  - { wait: [5, 1] }
`))).join('\n')
  assert.match(text, /beats\[0\]: unknown target "nowhere"/)
  assert.match(text, /beats\[1\]: say needs "as: <role>"/)
  assert.match(text, /beats\[2\]: awaits cue "never"/)
  assert.doesNotMatch(text, /ext:other_scene/)
  assert.match(text, /beats\[4\]\.wait: min is greater/)
})

test('top-level schema errors', () => {
  const out = issues(() => parseScene({ name: 'bad name!', roles: {}, beats: [] }))
  assert.ok(out.some(i => i.startsWith('.name')))
  assert.ok(out.some(i => i.startsWith('.roles')))
})

test('builder produces the same scene as yaml', () => {
  const built = scene('t')
    .role('hauler').role('miner')
    .mark('cart', 0, 0).mark('pile', 3, 1, 2)
    .beats(b.say('hauler', 'hi'), b.parallel([b.goto('miner', 'pile'), b.cue('there')]), b.awaitCue('there'))
    .build()
  const yaml = parseSceneYaml(minimal(`
  - { as: hauler, say: hi }
  - parallel: [[{ as: miner, goto: pile }, { cue: there }]]
  - { await: there }
`))
  assert.deepEqual(built, yaml)
  assert.throws(() => scene('x').role('a').beats(b.say('b', 'nope')).build(), SceneValidationError)
})

test('templating', () => {
  const ctx = { scene: 'cart', me: 'A', player: 'Steve', cast: { hauler: 'A', miner: 'C' }, vars: { n: 3 } }
  assert.equal(renderTemplate('Hi {player}, {role:miner} has {$n} wheels ({me}, {scene}) {unknown}', ctx), 'Hi Steve, C has 3 wheels (A, cart) {unknown}')
  assert.equal(renderTemplate('Hey {player}', { ...ctx, player: undefined }), 'Hey friend')
})

const actor = (o: Partial<ActorEntry> = {}): ActorEntry => ({ online: true, director: false, actions: ['scene_walk', 'follow'], ...o })

test('casting is deterministic and honours preferences and requirements', () => {
  const roles = { roles: { hauler: {}, foreman: {}, miner: {} } }
  const r1 = castRoles(roles, { C: actor(), A: actor(), B: actor() })
  assert.deepEqual(r1, { ok: true, cast: { hauler: 'A', foreman: 'B', miner: 'C' } })

  const r2 = castRoles({ roles: { hauler: {}, foreman: { prefer: ['C'] }, miner: {} } }, { A: actor(), B: actor(), C: actor() })
  assert.deepEqual(r2, { ok: true, cast: { hauler: 'A', foreman: 'C', miner: 'B' } })

  const r3 = castRoles(roles, { A: actor(), B: actor({ roles: ['miner'] }), C: actor() })
  assert.deepEqual(r3, { ok: true, cast: { hauler: 'A', foreman: 'C', miner: 'B' } })

  const r4 = castRoles({ roles: { a: { requires: ['fly'] } } }, { A: actor() })
  assert.equal(r4.ok, false)

  const r5 = castRoles({ roles: { a: {}, b: { optional: true } } }, { A: actor(), B: actor({ busyIn: 'x' }), C: actor({ online: false }) })
  assert.deepEqual(r5, { ok: true, cast: { a: 'A' } })

  const r6 = castRoles(roles, { A: actor(), B: actor() })
  assert.deepEqual(r6, { ok: false, error: 'no free actor for role miner' })
})

test('director and coordinator election', () => {
  const actors = { B: actor(), A: actor(), C: actor() }
  assert.equal(electDirector(['C', 'B'], actors), 'B')
  assert.equal(electCoordinator(actors), 'A')
  const withDirector = { ...actors, Z: actor({ director: true }) }
  assert.equal(electDirector(['C', 'B'], withDirector), 'Z')
  assert.equal(electCoordinator({ ...withDirector, Z: actor({ director: true, online: false }) }), 'A')
})

