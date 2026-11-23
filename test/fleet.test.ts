import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import YAML from 'yaml'
import { parseFleetFile, resolveUsername, fleetServerConfig, fleetAddresses } from '../src/core/fleetFile.ts'
import { Agent, Fleet, defineVariant } from '../src/core/index.ts'

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
defaults: { server: one, owners: [Robin] }
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
  assert.deepEqual(buddy!.options.owners, ['Robin'])
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
  const def = defineVariant({ name: 't', skills: [], brains: [] })
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

test("fleet server wins over a profile's server:, the profile fills the gaps", () => {
  const plan = parseFleetFile('servers:\n  mc: { host: fleet.example, port: 25570 }\nbots:\n  - profile: p\n', base)
  const p = plan.agents[0]!
  assert.deepEqual(p.serverFields, { host: 'fleet.example', port: 25570 })
  const s = fleetServerConfig(p, { host: 'profile.example', port: 1, platform: 'paper', version: '1.21.4' })
  assert.deepEqual(s, { host: 'fleet.example', port: 25570, auth: 'offline', version: '1.21.4', platform: 'paper' })
  assert.deepEqual(fleetServerConfig(p), { host: 'fleet.example', port: 25570, auth: 'offline', version: '1.21.1' }, 'no profile: fleet over environment, no staggerMs')
})

test('fleet: --host/--port beat the fleet entry and the profile, like with run', () => {
  const plan = parseFleetFile('servers:\n  mc: { host: fleet.example, port: 25570 }\nbots:\n  - profile: p\n', base)
  const p = plan.agents[0]!
  const s = fleetServerConfig(p, { host: 'profile.example', version: '1.21.4' }, { host: 'cli.example', port: 1234 })
  assert.deepEqual(s, { host: 'cli.example', port: 1234, auth: 'offline', version: '1.21.4' })
  assert.equal(fleetServerConfig(p, {}, { port: 9 }).host, 'fleet.example', 'only the flags given')
})

test('fleet: startup line shows the address each bot really uses', () => {
  const line = fleetAddresses([
    { username: 'Pax', server: { ...base, host: 'a.example' } },
    { username: 'Helper', server: { ...base, host: 'a.example' } },
    { username: 'Scout', server: { ...base, host: 'b.example', port: 25566 } }
  ])
  assert.equal(line, 'a.example:25565: Pax, Helper; b.example:25566: Scout')
})

test('fleet: unknown keys are warned about, not silently dropped', async () => {
  const { subscribeLogs } = await import('../src/core/log.ts')
  const { unknownKeys } = await import('../src/core/schemaKeys.ts')
  const { FleetFileSchema } = await import('../src/core/fleetFile.ts')
  const text = 'staggerMS: 10\nservers:\n  mc: { host: a, prot: 1 }\ndefaults: { ownres: [x] }\nbots:\n  - { variant: buddy, usrname: B }\n  - { profile: pax, settings: { anything: 1 } }\n'
  assert.deepEqual(unknownKeys(YAML.parse(text), FleetFileSchema), ['staggerMS', 'servers.mc.prot', 'defaults.ownres', 'bots[0].usrname'])
  const seen: string[] = []
  const off = subscribeLogs(e => { if (e.level === 'warn') seen.push(e.msg) })
  try { parseFleetFile(text, base, 'fleets/x.yaml') } finally { off() }
  assert.equal(seen.length, 4)
  assert.match(seen[3]!, /fleets\/x\.yaml: unknown key bots\[0\]\.usrname \(ignored\)/)
  for (const f of readdirSync('fleets').filter(f => /\.ya?ml$/.test(f))) {
    assert.deepEqual(unknownKeys(YAML.parse(readFileSync(join('fleets', f), 'utf8')), FleetFileSchema), [], f)
  }
})
