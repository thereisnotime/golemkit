// Shared fixtures for the self-improver tests.
import { z } from 'zod'
import { defineAction, ok } from '../src/core/index.ts'
import { makeCatalog } from '../src/brains/self/format.ts'

export const testActions = () => [
  defineAction({ name: 'wander', description: 'Walk around.', params: z.object({ radius: z.number().min(1).max(64).default(12) }), run: () => ok('walked') }),
  defineAction({ name: 'go_home', description: 'Go home.', params: z.object({ range: z.number().default(2) }), run: () => ok('home') }),
  defineAction({ name: 'goto_place', description: 'Go to a place.', params: z.object({ name: z.string(), range: z.number().default(2) }), run: () => ok('there') }),
  defineAction({ name: 'sleep', description: 'Sleep.', params: z.object({}), run: () => ok('slept') }),
  defineAction({ name: 'jump', description: 'Jump once.', params: z.object({}), exclusive: false, run: () => ok('jumped') }),
  defineAction({ name: 'look_at', description: 'Look at a player.', params: z.object({ player: z.string().optional() }), run: () => ok('looked') }),
  defineAction({ name: 'attack', description: 'Fight.', params: z.object({ entityId: z.number().optional() }), run: () => ok('hit') }),
  defineAction({ name: 'follow', description: 'Follow.', params: z.object({ player: z.string().optional() }), longRunning: true, run: () => ok('') })
]

export const catalog = () => makeCatalog(testActions())

