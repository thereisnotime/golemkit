import { test } from 'node:test'
import assert from 'node:assert/strict'
import { viewDistanceChunks, resolveViewDistance, DEFAULT_VIEW_DISTANCE } from '../src/adapters/minecraft-java/viewDistance.ts'

test('viewDistanceChunks: names, numbers 2..32, anything else null', () => {
  assert.equal(viewDistanceChunks('tiny'), 6)
  assert.equal(viewDistanceChunks('Far'), 12)
  assert.equal(viewDistanceChunks(4), 4)
  assert.equal(viewDistanceChunks('7'), 7)
  assert.equal(viewDistanceChunks(1), null)
  assert.equal(viewDistanceChunks(33), null)
  assert.equal(viewDistanceChunks(4.5), null)
  assert.equal(viewDistanceChunks('huge'), null)
  assert.equal(viewDistanceChunks(undefined), null)
})

test('resolveViewDistance: valid settings pass, the rest falls back to far', () => {
  assert.equal(DEFAULT_VIEW_DISTANCE, 'far')
  assert.equal(resolveViewDistance(undefined), 'far')
  assert.equal(resolveViewDistance('short'), 'short')
  assert.equal(resolveViewDistance(' Normal '), 'normal')
  assert.equal(resolveViewDistance(6), 6)
  assert.equal(resolveViewDistance('8'), 8)
  assert.equal(resolveViewDistance(0), 'far')
  assert.equal(resolveViewDistance('nope'), 'far')
})
