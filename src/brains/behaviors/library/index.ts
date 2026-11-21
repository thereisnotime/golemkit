// The built-in behaviour library. Order matters only for ties and listings.
import type { BehaviorDefinition } from '../types.ts'
import { keepFed } from './keepFed.ts'
import { staySafe, avoidMobs } from './safety.ts'
import { followOwner, guardOwner, greetPlayersBehavior, idleLook } from './social.ts'
import { idleAntics, antiAfk } from './fun.ts'
import { sleepAtNightBehavior, returnHome, wanderBehavior, guardArea } from './routine.ts'
import { collectDrops, depositWhenFull, chopWoodLoop, farmLoop, lightArea } from './work.ts'
import { farmSetup } from './farm.ts'

export { keepFed, nextFoodStep, isHungry, senseFood, COOKED, type FoodStep, type FoodWorld, type FoodStepOptions } from './keepFed.ts'
export { staySafe, avoidMobs, assessDanger } from './safety.ts'
export { followOwner, guardOwner, greetPlayersBehavior, idleLook } from './social.ts'
export { sleepAtNightBehavior, returnHome, wanderBehavior, guardArea } from './routine.ts'
export { idleAntics, antiAfk } from './fun.ts'
export { collectDrops, depositWhenFull, chopWoodLoop, farmLoop, lightArea, woodStock } from './work.ts'
export { farmSetup, nextFarmTask, senseFarm, type FarmTask, type FarmState, type FarmTaskOptions } from './farm.ts'

export function defaultBehaviors (): BehaviorDefinition<any>[] {
  return [
    staySafe, avoidMobs, keepFed,
    guardOwner, guardArea, followOwner,
    sleepAtNightBehavior, returnHome, depositWhenFull,
    farmSetup, farmLoop, chopWoodLoop, collectDrops, lightArea,
    greetPlayersBehavior, wanderBehavior, idleLook, idleAntics, antiAfk
  ]
}
