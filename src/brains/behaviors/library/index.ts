// The built-in behaviour library. Order matters only for ties and listings.
import type { BehaviorDefinition } from '../types.ts'
import { keepFed } from './keepFed.ts'
import { staySafe, avoidMobs } from './safety.ts'
import { followOwner, guardOwner, greetPlayersBehavior, idleLook } from './social.ts'
import { idleAntics } from './fun.ts'
import { sleepAtNightBehavior, returnHome, wanderBehavior, guardArea } from './routine.ts'
import { collectDrops, depositWhenFull, chopWoodLoop, farmLoop, lightArea } from './work.ts'

export { keepFed, nextFoodStep, isHungry, senseFood, COOKED, type FoodStep, type FoodWorld, type FoodStepOptions } from './keepFed.ts'
export { staySafe, avoidMobs, assessDanger } from './safety.ts'
export { followOwner, guardOwner, greetPlayersBehavior, idleLook } from './social.ts'
export { sleepAtNightBehavior, returnHome, wanderBehavior, guardArea } from './routine.ts'
export { idleAntics } from './fun.ts'
export { collectDrops, depositWhenFull, chopWoodLoop, farmLoop, lightArea, woodStock } from './work.ts'

export function defaultBehaviors (): BehaviorDefinition<any>[] {
  return [
    staySafe, avoidMobs, keepFed,
    guardOwner, guardArea, followOwner,
    sleepAtNightBehavior, returnHome, depositWhenFull,
    farmLoop, chopWoodLoop, collectDrops, lightArea,
    greetPlayersBehavior, wanderBehavior, idleLook, idleAntics
  ]
}
