import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memlogInterval, formatMemSample, formatCounts, parseVmRss } from '../src/core/memlog.ts'

test('memlogInterval: off unless a positive number, at least 5 s', () => {
  assert.equal(memlogInterval(undefined), null)
  assert.equal(memlogInterval(''), null)
  assert.equal(memlogInterval('0'), null)
  assert.equal(memlogInterval('-3'), null)
  assert.equal(memlogInterval('abc'), null)
  assert.equal(memlogInterval('60'), 60)
  assert.equal(memlogInterval('1'), 5)
  assert.equal(memlogInterval('12.6'), 13)
})

test('formatMemSample: megabytes, children only when known', () => {
  const M = 1024 * 1024
  const s = { rss: 812 * M, heapUsed: 310 * M, heapTotal: 402 * M, external: 95 * M, arrayBuffers: 80 * M }
  assert.equal(formatMemSample(s), 'rss 812M heap 310/402M ext 95M ab 80M other 315M')
  assert.equal(formatMemSample({ ...s, children: { count: 1, rss: 350 * M } }), 'rss 812M heap 310/402M ext 95M ab 80M other 315M kids 1/350M')
  assert.equal(formatMemSample({ ...s, children: null }), 'rss 812M heap 310/402M ext 95M ab 80M other 315M')
  assert.equal(formatMemSample({ ...s, swap: 40 * M }), 'rss 812M heap 310/402M ext 95M ab 80M other 315M swap 40M')
  assert.equal(formatMemSample({ ...s, gc: { count: 40, ms: 12.4 } }), 'rss 812M heap 310/402M ext 95M ab 80M other 315M gc 40/12ms')
})

test('formatCounts and parseVmRss', () => {
  assert.equal(formatCounts('Pax', { chunks: 289, entities: 40 }), 'Pax chunks=289 entities=40')
  assert.equal(parseVmRss('Name:\tnode\nVmRSS:\t  123456 kB\nVmData: 1 kB\n'), 123456 * 1024)
  assert.equal(parseVmRss('Name:\tzombie\n'), 0)
  assert.equal(parseVmRss('VmRSS:\t 10 kB\nVmSwap:\t  2048 kB\n', 'VmSwap'), 2048 * 1024)
})
