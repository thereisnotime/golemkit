import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseFleetFile, resolveUsername } from '../src/core/fleetFile.ts'
import { Agent, Fleet, defineBot } from '../src/core/index.ts'

const base = { host: 'base.example', port: 25565, auth: 'offline' as const, version: '1.21.1' }

test('legacy single-server fleet file', () => {
  const plan = parseFleetFile('server: { host: a.example }\nbots:\n  - bot: buddy\n    username: B\n', base)
  assert.deepEqual(Object.keys(plan.servers), ['default'])
  assert.equal(plan.servers.default!.host, 'a.example')
  assert.equal(plan.servers.default!.port, 25565)
  assert.equal(plan.agents[0]!.options.username, 'B')
  assert.equal(plan.multiServer, false)
})

test('multi-server with defaults, counts and per-server data dirs', () => {
  const plan = parseFleetFile(`
servers:
  one: { host: one.example, staggerMs: 1000 }
  two: { host: two.example, port: 25570 }
defaults: { server: one, owners: [robin] }
bots:
  - bot: buddy
  - bot: villager
    server: two
    username: Vil
    count: 2
`, base)
  assert.equal(plan.multiServer, true)
  assert.equal(plan.servers.one!.staggerMs, 1000)
  assert.equal(plan.servers.two!.port, 25570)
  const [buddy, v1, v2] = plan.agents
  assert.equal(buddy!.server, 'one')
  assert.deepEqual(buddy!.options.owners, ['robin'])
  assert.equal(v1!.options.username, 'Vil1')
  assert.equal(v2!.options.username, 'Vil2')
  assert.equal(resolveUsername(buddy!, 'McBuddy', true).dataDir, 'data/bots/one/McBuddy')
})

test('count without username suffixes the definition default', () => {
  const plan = parseFleetFile('bots:\n  - bot: villager\n    count: 2\n', base)
  assert.equal(resolveUsername(plan.agents[1]!, 'Villager', false).username, 'Villager2')
})

test('unknown server is an error', () => {
  assert.throws(() => parseFleetFile('servers: { a: {} }\nbots:\n  - { bot: x, server: b }\n', base), /unknown server/)
})

test('fleet messages stay on their server and respect recipients', () => {
  const def = defineBot({ name: 't', skills: [], brains: [] })
  const fleet = new Fleet()
  const a = new Agent(def, base, { username: 'A', dataDir: 'data/test/A' })
  const b = new Agent(def, base, { username: 'B', dataDir: 'data/test/B' })
  const c = new Agent(def, base, { username: 'C', dataDir: 'data/test/C' })
  fleet.add(a, 's1'); fleet.add(b, 's1'); fleet.add(c, 's2')
  const got: string[] = []
  fleet.subscribe(b, m => got.push(`B:${m.topic}`))
  fleet.subscribe(c, m => got.push(`C:${m.topic}`))
  fleet.send({ from: 'A', server: 's1', topic: 'hello' })
  fleet.send({ from: 'A', server: 's1', to: 'C', topic: 'direct-wrong-server' })
  fleet.send({ from: 'B', server: 's1', topic: 'self' })
  assert.deepEqual(got, ['B:hello'])
  assert.deepEqual(fleet.peers(a).map(x => x.username), ['B'])
  fleet.board('s1').set('scene', 'act1')
  assert.equal(fleet.board('s1').get('scene'), 'act1')
  assert.equal(fleet.board('s2').get('scene'), undefined)
})
