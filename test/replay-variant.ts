// The bot used for packet recording and replay: standard skills and navigation, no brains, so it
// never acts on its own and the replayed session only exercises connect, handshake and setup.
import { defineVariant } from '../src/core/index.ts'
import { standardSkills, navigation } from '../src/skills/index.ts'

export const replayVariant = () => defineVariant({ name: 'replay', skills: [...standardSkills(), navigation()], brains: [] })
