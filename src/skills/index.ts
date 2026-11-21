export { movement } from './movement.ts'
export { combat, fight, equipBestWeapon, huntRefusal, HUNTABLE } from './combat.ts'
export { survival, bestFood, fillerBlock } from './survival.ts'
export { inventorySkill } from './inventory.ts'
export { status } from './status.ts'
export { gather } from './gather.ts'
export { journal, fmtDeath, fmtEventList, resolveTypes, recentEventsObservation } from './journal.ts'

import { movement } from './movement.ts'
import { combat } from './combat.ts'
import { survival } from './survival.ts'
import { inventorySkill } from './inventory.ts'
import { status } from './status.ts'
import { config } from './config.ts'
import { gather } from './gather.ts'
import { journal } from './journal.ts'

/** The standard skill set most bots want. */
export const standardSkills = () => [status(), config(), movement(), combat(), survival(), inventorySkill(), gather(), journal()]
export { navigation, getHome, setHome, getPlaces, setPlace, type Place } from './navigation.ts'

// Extended skills: crafting, storage, farming, woodcutting, building, picking up drops.
export { crafting } from './crafting.ts'
export { containers } from './containers.ts'
export { farming } from './farming.ts'
export { woodcutting } from './woodcutting.ts'
export { building } from './building.ts'
export { pickup, pickupNearby } from './pickup.ts'
export { placeAt, reachBlock } from './world.ts'
export { construction, buildStructure } from './construction.ts'
export { materialsSkill, gatherMaterials, planWood } from './materials.ts'
export { ensureTool, type ToolKind } from './toolkit.ts'
export { food, startFarm, getFarms, getFoodSpots, type Farm } from './food.ts'
export { progressionSkill, nextToolUpgrade, upgradeTools, autoUpgrade, type UpgradeStep, type Nearby } from './progression.ts'
export { mineStone, planStep, digHazard } from './mining.ts'

import { crafting } from './crafting.ts'
import { containers } from './containers.ts'
import { farming } from './farming.ts'
import { woodcutting } from './woodcutting.ts'
import { building } from './building.ts'
import { pickup } from './pickup.ts'
import { construction } from './construction.ts'
import { materialsSkill } from './materials.ts'
import { food } from './food.ts'
import { progressionSkill } from './progression.ts'

/** Extra skills on top of standardSkills(): crafting, containers, farming, food, woodcutting, building, construction, materials, progression, pickup. */
export const extendedSkills = () => [crafting(), containers(), farming(), food(), woodcutting(), building(), construction(), materialsSkill(), progressionSkill(), pickup()]
export { modsSkill, installedMods } from './mods.ts'
export { config } from './config.ts'
