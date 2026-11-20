// Player assistant: follows chat commands, fights back, eats.
import { defineVariant } from '../src/core/index.ts'
import { standardSkills } from '../src/skills/index.ts'
import { commandBrain, reflexes } from '../src/brains/index.ts'

export default defineVariant({
  name: 'buddy',
  description: 'Player assistant driven by chat commands',
  username: 'McBuddy',
  skills: standardSkills(),
  brains: [commandBrain({ greet: true }), reflexes()]
})
