export { movement } from './movement.ts'
export { combat, fight, equipBestWeapon } from './combat.ts'
export { survival, bestFood } from './survival.ts'
export { inventorySkill } from './inventory.ts'
export { status } from './status.ts'
export { gather } from './gather.ts'

import { movement } from './movement.ts'
import { combat } from './combat.ts'
import { survival } from './survival.ts'
import { inventorySkill } from './inventory.ts'
import { status } from './status.ts'
import { gather } from './gather.ts'

/** The standard skill set most bots want. */
export const standardSkills = () => [status(), movement(), combat(), survival(), inventorySkill(), gather()]
export { navigation, getHome, setHome, getPlaces, setPlace, type Place } from './navigation.ts'
