// The built-in behaviour library. Order matters only for ties and listings.
import type { BehaviorDefinition } from '../../../brains/behaviors/types.ts'
import { keepFed } from './keepFed.ts'
import { staySafe, avoidMobs } from './safety.ts'
import { bodyguard } from './bodyguard.ts'
import { followOwner, guardOwner, greetPlayersBehavior, idleLook } from './social.ts'
import { idleAntics, antiAfk } from './fun.ts'
import { sleepAtNightBehavior, returnHome, wanderBehavior, guardArea } from './routine.ts'
import { collectDrops, depositWhenFull, chopWoodLoop, farmLoop, lightArea } from './work.ts'
import { farmSetup } from './farm.ts'
import { keepToolsUpgraded } from './tools.ts'
import { keepSpawnBed } from './bed.ts'
import { withStockHelp } from './help.ts'
import { lightHome } from './light.ts'
import { recoverDrops } from './recover.ts'
import { checkStorage } from './storage.ts'
import { startOverBehavior } from './startOver.ts'

export { keepFed, nextFoodStep, isHungry, senseFood, COOKED, type FoodStep, type FoodWorld, type FoodStepOptions } from './keepFed.ts'
export { staySafe, avoidMobs, assessDanger } from './safety.ts'
export { bodyguard } from './bodyguard.ts'
export { followOwner, guardOwner, greetPlayersBehavior, idleLook } from './social.ts'
export { sleepAtNightBehavior, returnHome, wanderBehavior, guardArea } from './routine.ts'
export { idleAntics, antiAfk } from './fun.ts'
export { collectDrops, depositWhenFull, chopWoodLoop, farmLoop, lightArea, woodStock } from './work.ts'
export { farmSetup, nextFarmTask, senseFarm, type FarmTask, type FarmState, type FarmTaskOptions } from './farm.ts'
export { keepToolsUpgraded, wornTools } from './tools.ts'
export { keepSpawnBed } from './bed.ts'
export { stockHelp, stockGoal, withStockHelp } from './help.ts'
export { lightHome } from './light.ts'
export { recoverDrops, RECOVER_SCORE } from './recover.ts'
export { checkStorage, lowReportDue } from './storage.ts'
export { startOverBehavior, START_OVER_SCORE } from './startOver.ts'

export function defaultBehaviors (): BehaviorDefinition<any>[] {
  return withStockHelp([
    staySafe, avoidMobs, keepFed, recoverDrops, startOverBehavior,
    bodyguard, guardOwner, guardArea, followOwner,
    sleepAtNightBehavior, returnHome, keepSpawnBed, depositWhenFull,
    farmSetup, farmLoop, chopWoodLoop, collectDrops, lightArea, lightHome, keepToolsUpgraded, checkStorage,
    greetPlayersBehavior, wanderBehavior, idleLook, idleAntics, antiAfk
  ])
}
