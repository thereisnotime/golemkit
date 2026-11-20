import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseLevelSpec, levelFor, createLogger, configureLogging, recentLogs, subscribeLogs } from '../src/core/log.ts'

// Keep test output quiet: route console writes nowhere while asserting on buffer/files.
const origOut = process.stdout.write.bind(process.stdout)
const origErr = process.stderr.write.bind(process.stderr)
function mute () { (process.stdout as any).write = () => true; (process.stderr as any).write = () => true }
function unmute () { (process.stdout as any).write = origOut; (process.stderr as any).write = origErr }

test('level spec: default, specific beats wildcard, children inherit', () => {
  const spec = parseLevelSpec('warn,McBuddy=debug,*/neoforge=trace,McBuddy/chat=error')
  assert.equal(levelFor('Other', spec), 'warn')
  assert.equal(levelFor('McBuddy', spec), 'debug')
  assert.equal(levelFor('McBuddy/action/follow', spec), 'debug')
  assert.equal(levelFor('Villager/neoforge', spec), 'trace')
  assert.equal(levelFor('McBuddy/chat', spec), 'error')
  assert.equal(levelFor('McBuddyX', spec), 'warn', 'prefix match must respect segment boundaries')
})

test('filtering, fields, child/with, buffer and subscribers', () => {
  mute()
  try {
    configureLogging({ level: 'info,T1/noisy=error', format: 'plain', file: null, dir: null })
    const seen: string[] = []
    const off = subscribeLogs(e => seen.push(`${e.logger}:${e.msg}`))
    const log = createLogger('T1').with({ run: 7 })
    log.debug('hidden')
    log.info('shown', { x: 1 })
    log.child('noisy').warn('hidden too')
    log.child('noisy').error('loud')
    off()
    log.info('after unsubscribe')
    assert.deepEqual(seen, ['T1:shown', 'T1/noisy:loud'])
    const recent = recentLogs({ logger: 'T1' })
    assert.equal(recent.at(-1)!.msg, 'after unsubscribe')
    assert.deepEqual(recent.find(e => e.msg === 'shown')!.fields, { run: 7, x: 1 })
    assert.equal(recentLogs({ logger: 'T1', minLevel: 'error' }).length, 1)
  } finally { unmute() }
})

test('per-bot files, json file format, redaction and rotation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcb-log-'))
  process.env.TEST_FAKE_API_KEY = 'sk-test-supersecret-123'
  mute()
  try {
    configureLogging({ level: 'info', dir, file: join(dir, 'all.log'), fileFormat: 'json', maxSizeMb: 0.0005, maxFiles: 2 })
    const bot = createLogger('Bot1')
    bot.info('key is sk-test-supersecret-123')
    createLogger('fleet').info('system line')
    for (let i = 0; i < 40; i++) bot.info(`filler line number ${i} with some padding to grow the file`)
    configureLogging({ file: null, dir: null })
    const names = readdirSync(dir).sort()
    assert.ok(names.includes('Bot1.log'))
    assert.ok(names.includes('_system.log'))
    assert.ok(names.includes('all.log.1'), `rotation should happen, got ${names}`)
    assert.ok(!names.includes('all.log.3'), 'keeps at most maxFiles rotated files')
    const all = readdirSync(dir).filter(n => n.startsWith('all.log')).map(n => readFileSync(join(dir, n), 'utf8')).join('')
    assert.ok(!all.includes('supersecret'), 'secrets are redacted')
    const first = JSON.parse(readFileSync(join(dir, '_system.log'), 'utf8').trim().split('\n')[0]!)
    assert.equal(first.logger, 'fleet')
    assert.equal(first.msg, 'system line')
  } finally {
    unmute()
    delete process.env.TEST_FAKE_API_KEY
    configureLogging({ level: 'info', format: 'pretty', maxSizeMb: 20, maxFiles: 5, fileFormat: 'plain' })
    rmSync(dir, { recursive: true, force: true })
  }
})
