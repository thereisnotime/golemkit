// Scene actor: acts out scenes from scenes/*.yaml with the other actors on its server, still
// takes chat commands (!scene_start broken_cart) and fights back / eats on its own.
import { defineBot } from '../src/core/index.ts'
import { standardSkills } from '../src/skills/index.ts'
import { commandBrain, reflexes, sceneBrain, sceneSkill } from '../src/brains/index.ts'

export default defineBot({
  name: 'actor',
  description: 'NPC actor that performs scenes with other actors (scene brain + commands + reflexes)',
  username: 'Actor',
  skills: [...standardSkills(), sceneSkill()],
  brains: [sceneBrain(), commandBrain(), reflexes()]
})
