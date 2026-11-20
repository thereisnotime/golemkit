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

// Extended skills: crafting, storage, farming, woodcutting, building, picking up drops.
export { crafting } from './crafting.ts'
export { containers } from './containers.ts'
export { farming } from './farming.ts'
export { woodcutting } from './woodcutting.ts'
export { building } from './building.ts'
export { pickup, pickupNearby } from './pickup.ts'
export { placeAt, reachBlock } from './world.ts'

import { crafting } from './crafting.ts'
import { containers } from './containers.ts'
import { farming } from './farming.ts'
import { woodcutting } from './woodcutting.ts'
import { building } from './building.ts'
import { pickup } from './pickup.ts'

/** Extra skills on top of standardSkills(): crafting, containers, farming, woodcutting, building, pickup. */
export const extendedSkills = () => [crafting(), containers(), farming(), woodcutting(), building(), pickup()]
