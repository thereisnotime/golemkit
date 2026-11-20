// Self-sufficient villager: lives around its home without anyone commanding it. Wanders by
// day, heads home and sleeps at night, defends itself, eats, says hello now and then.
// Chores (chop_tree, harvest, deposit) switch on by themselves if a skill provides them.
// Players can still command it with !commands; player priority beats the NPC brain.
import { defineBot } from '../src/core/index.ts'
import { status, movement, combat, survival, inventorySkill, navigation } from '../src/skills/index.ts'
import { commandBrain, reflexes } from '../src/brains/index.ts'
import {
  npcBrain, actionBehavior, wander, goHome, sleepAtNight, eatWhenHungry, fleeOrFight,
  followNearbyPlayer, greetPlayers
} from '../src/brains/npc/index.ts'

const daytime = (score: number) => ({ bb }: { bb: { facts: { isNight: boolean } } }) => bb.facts.isNight ? 0 : score

export default defineBot({
  name: 'villager',
  description: 'Self-sufficient NPC that lives around its home',
  username: 'Villager',
  persona: 'a calm villager who keeps to their home and greets passers-by',
  skills: [status(), movement(), combat(), survival(), inventorySkill(), navigation()],
  brains: [
    commandBrain({ verbose: false }),
    reflexes(),
    npcBrain({
      behaviors: [
        fleeOrFight(),
        eatWhenHungry(),
        sleepAtNight(),
        goHome(),
        // Chores: score 0 unless the bot has these actions (skills built separately).
        actionBehavior('deposit', {}, ({ bb }) => bb.needs.inventoryFull > 0.8 ? 45 : 0,
          { cooldownMs: 120_000, failureCooldownMs: 60_000 }),
        actionBehavior('harvest', {}, daytime(30), { cooldownMs: 300_000, failureCooldownMs: 120_000 }),
        actionBehavior('chop_tree', {}, daytime(25), { cooldownMs: 600_000, failureCooldownMs: 120_000 }),
        followNearbyPlayer(),
        wander({ radius: 12 })
      ],
      hooks: [greetPlayers({ chance: 0.3 })]
    })
  ]
})
