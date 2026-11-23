import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { isolatedEnv, resolveProfile } from '../src/llm/providers/proc.ts'
import { CodexProvider } from '../src/llm/providers/codex.ts'
import { createProvider } from '../src/llm/providers/index.ts'

const LEAKY = {
  ANTHROPIC_API_KEY: 'sk-ant-leak', ANTHROPIC_BASE_URL: 'http://gateway.local', OPENAI_API_KEY: 'sk-leak',
  OPENAI_BASE_URL: 'http://gw', CODEX_HOME: '/home/someone/.codex', CLAUDE_CONFIG_DIR: '/home/someone/.claude',
  MY_SHELL_THING: 'x'
}

function withEnv (vars: Record<string, string>, fn: () => void) {
  const saved: Record<string, string | undefined> = {}
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; process.env[k] = vars[k] }
  try { fn() } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
}

test('isolated profile: own HOME, nothing from our environment leaks', () => {
  withEnv(LEAKY, () => {
    const dir = join(tmpdir(), `mcb-profile-${process.pid}`)
    const env = isolatedEnv(resolveProfile('claude', dir), { set: { CLAUDE_CONFIG_DIR: join(dir, '.claude') } })
    assert.equal(env.HOME, dir)
    assert.equal(env.CLAUDE_CONFIG_DIR, join(dir, '.claude'))
    assert.equal(env.XDG_CONFIG_HOME, join(dir, '.config'))
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_HOME', 'MY_SHELL_THING']) {
      assert.equal(env[k], undefined, `${k} must not leak`)
    }
    assert.ok(env.PATH!.length > 0)
  })
})

test('default profile is .auth/<provider>; "user" is the real home', () => {
  assert.equal(resolveProfile('codex').home, join(process.cwd(), '.auth', 'codex'))
  assert.deepEqual(resolveProfile('codex', 'user'), { kind: 'user', home: homedir() })
  assert.equal(resolveProfile('codex', '~/alt').home, join(homedir(), 'alt'))
})

test('codex child env points CODEX_HOME into the profile and carries only the MCP token', () => {
  withEnv(LEAKY, () => {
    const dir = join(tmpdir(), `mcb-codex-${process.pid}`)
    const env = new CodexProvider({ profile: dir }).env({ MC_BUDDY_MCP_TOKEN: 't' })
    assert.equal(env.CODEX_HOME, join(dir, '.codex'))
    assert.equal(env.HOME, dir)
    assert.equal(env.OPENAI_API_KEY, undefined)
    assert.equal(env.MC_BUDDY_MCP_TOKEN, 't')
  })
})

test('MC_*_PROFILE env selects the profile', () => {
  const p = createProvider('codex', {}, { MC_CODEX_PROFILE: '/tmp/x-profile' } as NodeJS.ProcessEnv) as CodexProvider
  assert.equal(p.profile.home, '/tmp/x-profile')
})

test('readEnvFileVar reads one variable from a dotenv file', async () => {
  const { writeFileSync, rmSync } = await import('node:fs')
  const { readEnvFileVar } = await import('../src/llm/providers/proc.ts')
  const f = join(tmpdir(), `mcb-env-${process.pid}`)
  writeFileSync(f, '# comment\nOTHER=nope\nexport KN_TOKEN="sk-ant-oat-abc"\nPLAIN=x # trailing\n')
  try {
    assert.equal(readEnvFileVar(f, 'KN_TOKEN'), 'sk-ant-oat-abc')
    assert.equal(readEnvFileVar(f, 'PLAIN'), 'x')
    assert.equal(readEnvFileVar(f, 'MISSING'), undefined)
    assert.equal(process.env.OTHER, undefined, 'nothing else is loaded into our env')
  } finally { rmSync(f) }
})

test('proxy: caveman maps to the local layer; codex gets a per-run provider override', async () => {
  const { resolveProxy } = await import('../src/llm/providers/proc.ts')
  assert.equal(await resolveProxy(undefined), null)
  assert.equal(await resolveProxy('none'), null)
  const custom = await resolveProxy('https://gw.example/v1/')
  assert.equal(custom!.baseUrl, 'https://gw.example/v1')
  await assert.rejects(resolveProxy('gw.example'), /http/)
  const args = new CodexProvider({ login: join(tmpdir(), 'x') }).args({ system: 's', mcp: { url: 'http://127.0.0.1:1/mcp', token: 't' } } as any, '/tmp', custom)
  const joined = args.join(' ')
  assert.match(joined, /model_provider="mcbproxy"/)
  assert.match(joined, /base_url = "https:\/\/gw.example\/v1"/)
})

test('renamed env variables: current names win, old ones still work with one warning that names no value', async () => {
  const { envValue, resetEnvWarnings } = await import('../src/core/env.ts')
  const { expandEnv } = await import('../src/core/definition.ts')
  resetEnvWarnings()
  const warnings: string[] = []
  const warn = (m: string) => { warnings.push(m) }
  const secretish = '/very/secret/path.env'
  const env = { MC_OAUTH_TOKEN_FILE: secretish, MC_CLAUDE_OAUTH_TOKEN_VAR: 'NEW_VAR', MC_OAUTH_TOKEN_VAR: 'OLD_VAR' }
  assert.equal(envValue('MC_CLAUDE_OAUTH_TOKEN_VAR', env, warn), 'NEW_VAR')
  assert.equal(envValue('MC_CLAUDE_OAUTH_TOKEN_FILE', env, warn), secretish)
  assert.equal(envValue('MC_CLAUDE_OAUTH_TOKEN_FILE', env, warn), secretish)
  assert.equal(warnings.length, 1, 'once per old name')
  assert.match(warnings[0]!, /MC_OAUTH_TOKEN_FILE is deprecated, use MC_CLAUDE_OAUTH_TOKEN_FILE/)
  assert.ok(!warnings[0]!.includes(secretish), 'never the value')
  assert.equal(envValue('MC_CLAUDE_LOGIN', {}, warn), undefined)
  // profiles: ${MC_CLAUDE_OAUTH_TOKEN_FILE:-default} picks up the old name too
  assert.equal(expandEnv('f: ${MC_CLAUDE_OAUTH_TOKEN_FILE:-~/x.env}', env), `f: ${secretish}`)
  assert.equal(expandEnv('f: ${MC_CLAUDE_OAUTH_TOKEN_FILE:-~/x.env}', {}), 'f: ~/x.env')
  resetEnvWarnings()
  const p = createProvider('codex', {}, { MC_CODEX_LOGIN: '/new/codex' }) as any
  assert.equal(p.profile.home, '/new/codex')
})
