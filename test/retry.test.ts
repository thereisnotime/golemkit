import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveRetry, actionAttempts, backoffMs, isRetryableResult, isTransientLlmError } from '../src/core/retry.ts'
import { parseProfile } from '../src/core/profile.ts'

test('layers: defaults < env < settings', () => {
  const cfg = resolveRetry({ retry: { actions: { goto: 3 } } }, { MC_RETRY_ACTIONS: '*=1,chop_tree=2', MC_RETRY_LLM: '4' } as any)
  assert.equal(actionAttempts(cfg, 'goto'), 3)
  assert.equal(actionAttempts(cfg, 'chop_tree'), 2)
  assert.equal(actionAttempts(cfg, 'jump'), 1)
  assert.equal(cfg.llm.attempts, 4)
  assert.equal(actionAttempts(resolveRetry({}, {} as any), 'goto'), 0, 'no action retries by default')
})

test('backoff doubles, caps and jitters', () => {
  const mid = () => 0.5
  assert.equal(backoffMs(0, [1000, 8000], mid), 1000)
  assert.equal(backoffMs(2, [1000, 8000], mid), 4000)
  assert.equal(backoffMs(10, [1000, 8000], mid), 8000)
  assert.ok(backoffMs(0, [1000, 8000], () => 0) >= 750)
})

test('what gets retried', () => {
  assert.equal(isRetryableResult('stuck at 1 2 3, 400 blocks left'), true)
  for (const m of ['busy: follow (player robin)', 'stopped', 'preempted', 'bad parameters for goto: x', 'digging is disabled for this bot']) {
    assert.equal(isRetryableResult(m), false, m)
  }
  assert.equal(isTransientLlmError('timed out after 120000ms'), true)
  assert.equal(isTransientLlmError('429 rate limit'), true)
  assert.equal(isTransientLlmError('Claude Code is not logged in'), false)
  assert.equal(isTransientLlmError('aborted'), false)
})

test('profile retry lands in settings', () => {
  const p = parseProfile('variant: buddy\nretry: { actions: { goto: 2 }, llm: { attempts: 1 } }\n')
  const cfg = resolveRetry(p.options.settings!, {} as any)
  assert.equal(actionAttempts(cfg, 'goto'), 2)
  assert.equal(cfg.llm.attempts, 1)
})
