// Player assistant: follows chat commands, fights back, eats.
import { defineBot } from '../src/core/index.ts'
import { standardSkills } from '../src/skills/index.ts'
import { commandBrain, reflexes } from '../src/brains/index.ts'

export default defineBot({
  name: 'buddy',
  description: 'Player assistant driven by chat commands',
  username: 'McBuddy',
  skills: standardSkills(),
  brains: [commandBrain(), reflexes()]
})
