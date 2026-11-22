import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serverFromEnv, DEFAULT_SERVER } from '../src/core/definition.ts'

test('server defaults to localhost when nothing is set', () => {
  assert.deepEqual(serverFromEnv({}), DEFAULT_SERVER)
  assert.equal(DEFAULT_SERVER.host, 'localhost')
})

test('server values come from the environment', () => {
  assert.deepEqual(serverFromEnv({ MC_HOST: 'mc.example.com', MC_PORT: '25570', MC_AUTH: 'microsoft', MC_VERSION: '1.21.4' }),
    { host: 'mc.example.com', port: 25570, auth: 'microsoft', version: '1.21.4' })
})

test('expandEnv fills variables and defaults', async () => {
  const { expandEnv } = await import('../src/core/definition.ts')
  const env = { MC_OWNER: 'Alex' }
  assert.equal(expandEnv('owners: ["${MC_OWNER:-Robin}"]', env), 'owners: ["Alex"]')
  assert.equal(expandEnv('${NOPE:-Robin} and ${NOPE}!', env), 'Robin and !')
  assert.equal(expandEnv('file: ${F:-~/.config/x.env}', env), 'file: ~/.config/x.env')
})

test('fleet files expand ${VAR} from the environment', async () => {
  const { parseFleetFile } = await import('../src/core/fleetFile.ts')
  process.env.MCB_TEST_HOST = 'fleet.example.com'
  const plan = parseFleetFile('servers:\n  a: { host: "${MCB_TEST_HOST}" }\nbots:\n  - { variant: buddy, username: X, server: a }\n')
  assert.ok(JSON.stringify(plan).includes('fleet.example.com'))
})
