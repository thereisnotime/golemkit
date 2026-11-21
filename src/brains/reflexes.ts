// Reflexes: things the bot does on its own regardless of other brains: fight back when hit,
// eat when hungry. They run at reflex priority, so they briefly preempt everything else and
// long-running actions (follow, guard) resume afterwards.
import { defineBrain, PRIORITY, nearestHostile, isHostile, FLYING, needsSurvival } from '../core/index.ts'
import { bestFood, isClimbingOut, keepClimbing } from '../skills/survival.ts'
import { isRangedMob } from '../skills/weapons.ts'
import { threats } from '../skills/combat.ts'
import { fightFood } from '../skills/fight.ts'
import { gearPlan, hasGearUpgrade } from '../skills/gear.ts'
import { escorting } from '../skills/bodyguard.ts'

export interface ReflexOptions {
  selfDefense?: boolean
  autoEat?: boolean
  /** Eat when food drops below this. */
  eatBelow?: number
  /** At or below this health, back off instead of fighting. Default 8 (4 hearts). */
  retreatBelow?: number
  /** Don't fight mobs standing in water below this health (drowned, guardians). Default 14. */
  waterFightAbove?: number
}

export const reflexes = (defaults: ReflexOptions = {}) => {
  const caller = { kind: 'reflex', name: 'reflexes' } as const

  return defineBrain({
    name: 'reflexes',
    session (agent, bot) {
      // Profile `reflexes:` (settings.reflexes) overrides the variant's defaults. Read on every
      // use, so in-game changes (config_set reflexes.*) apply immediately.
      const cfg = () => {
        const o: ReflexOptions = { ...defaults, ...(agent.settings.reflexes as ReflexOptions | undefined) }
        return { selfDefense: o.selfDefense ?? true, autoEat: o.autoEat ?? true, eatBelow: o.eatBelow ?? 15, retreatBelow: o.retreatBelow ?? 8, waterFightAbove: o.waterFightAbove ?? 14 }
      }
      let busy = false
      let bunkerFailedAt = 0
      let gearTriedAt = 0
      const combatCfg = () => (agent.settings.combat ?? {}) as { autoArmor?: boolean, disengageToHeal?: boolean }
      const reflex = async (action: string) => {
        if (busy) return
        busy = true
        try { await agent.act(action, {}, { caller, priority: PRIORITY.reflex }) } finally { busy = false }
      }

      const inWater = (e: any) => {
        const b = bot.blockAt(e.position)
        return b?.name === 'water' || e.name === 'drowned' || e.name === 'guardian'
      }
      // Running from flyers is pointless (they're faster); fight them even when low.
      const shouldRetreat = (mob: any) => !FLYING.has(mob.name ?? '') &&
        ((bot.health > 0 && bot.health <= cfg().retreatBelow) || (inWater(mob) && bot.health < cfg().waterFightAbove))

      // Climbing out of a cave (climb_out, or goto starting underground): going on up beats
      // stopping to fight unless a melee mob is right on us (keepClimbing). Fighting underground
      // and chasing archers through caves is how a climb got cancelled and the bot died.
      const climbingAway = (mob: any) => {
        if (!mob || !isClimbingOut(bot)) return false
        const p = bot.entity.position
        const q = mob.position
        return keepClimbing({ dist: Math.hypot(q.x - p.x, q.z - p.z), dy: q.y - p.y, ranged: isRangedMob(mob.name) || FLYING.has(mob.name ?? ''), creeper: mob.name === 'creeper' })
      }

      const onHurt = (entity: any) => {
        if (!cfg().selfDefense || entity !== bot.entity || !needsSurvival(bot)) return
        // next tick: the combat skill notes who hit us first (neutral mobs count only then)
        setImmediate(() => { try { onHurtNow() } catch {} })
      }
      const onHurtNow = () => {
        // Flyers (phantoms) hit and climb away, so look further for them; archers shoot from afar.
        const mob = threats(bot, 20)[0] ?? nearestHostile(bot, bot.entity.position, 8) ??
          bot.nearestEntity((e: any) => isHostile(e) && FLYING.has(e.name ?? '') && e.position.distanceTo(bot.entity.position) < 20)
        if (!mob) return
        const cur = agent.currentAction?.name
        if (cur === 'bunker') return
        // Phantoms at night with no weapon (or hurt): dig in instead of punching the sky.
        const unarmed = !bot.inventory.items().some(i => /_(sword|axe)$/.test(i.name))
        const night = bot.time.timeOfDay >= 12_500 && bot.time.timeOfDay <= 23_500
        // a bodyguard stays with its player unless it is about to die
        const guarding = !!escorting(agent) && bot.health > 6
        if (mob.name === 'phantom' && night && (unarmed || bot.health <= 12) && !guarding && agent.canDig && agent.getAction('bunker') &&
            !agent.protectedAreas.isProtected(bot.entity.position) && Date.now() - bunkerFailedAt > 60_000) {
          // A failed bunker (thin ground, nothing to seal with) isn't retried for a minute; fight instead.
          if (!busy) {
            busy = true
            void agent.act('bunker', {}, { caller, priority: PRIORITY.reflex })
              .then(r => { if (!r.ok) bunkerFailedAt = Date.now() })
              .finally(() => { busy = false })
          }
          return
        }
        if (climbingAway(mob)) return
        if (shouldRetreat(mob) && agent.getAction('retreat')) {
          if (cur !== 'retreat') void reflex('retreat')
          return
        }
        // protect (bodyguard) fights for itself and picks targets around the player: don't take over
        if (cur === 'defend' || cur === 'attack' || cur === 'retreat' || cur === 'protect') return
        void reflex('defend')
      }
      bot.on('entityHurt', onHurt)
      // Health going down is a hit too. entityHurt for our own entity was seen missing after a
      // respawn (the bot stood idle for 5 s while two mobs hit it), so this is the backstop.
      let lastHealth = bot.health
      const onHealth = () => {
        const dropped = bot.health < lastHealth && bot.health > 0
        lastHealth = bot.health
        if (dropped && cfg().selfDefense && needsSurvival(bot) && !busy && bot.food > 0) setImmediate(() => { try { onHurtNow() } catch {} })
      }
      bot.on('health', onHealth)

      const timer = setInterval(() => {
        if (!needsSurvival(bot)) return // creative/spectator: no hunger, no danger
        const { selfDefense, autoEat, eatBelow, retreatBelow } = cfg()
        // Low health with a hostile close by: get away even before the next hit.
        const mob = selfDefense ? nearestHostile(bot, bot.entity.position, 6) : null
        const climbing = climbingAway(mob)
        if (mob && !climbing && !FLYING.has(mob.name ?? '') && bot.health > 0 && bot.health <= retreatBelow && agent.currentAction?.name !== 'retreat' && agent.getAction('retreat')) {
          void reflex('retreat')
          return
        }
        // retreatBelow 0 means stand ground, not die: at <= 4 health with food, defend backs off to eat (combat.disengageToHeal)
        if (selfDefense && mob && !climbing && bot.health <= 4 && combatCfg().disengageToHeal !== false && fightFood(bot) &&
            agent.currentAction?.name !== 'defend' && agent.getAction('defend')) {
          void reflex('defend')
          return
        }
        // Don't wait for the first hit: a creeper walking up (its blast is the hit) or a mob at arm's
        // length gets fought now. Same defend action as when hurt.
        if (selfDefense && bot.health > 0 && !busy && agent.getAction('defend') && !['defend', 'retreat', 'bunker', 'pillar', 'protect'].includes(agent.currentAction?.name ?? '')) {
          const t = threats(bot, 8)[0]
          const d = t ? t.position.distanceTo(bot.entity.position) : Infinity
          if (t && isHostile(t) && !FLYING.has(t.name ?? '') && (d <= 4 || (t.name === 'creeper' && d <= 7)) && !climbingAway(t)) {
            void reflex('defend')
            return
          }
        }
        // wear armour (and a shield/totem) as soon as it's in the inventory: gear_up runs beside the current action
        if (combatCfg().autoArmor !== false && agent.getAction('gear_up') && !bot.currentWindow && Date.now() - gearTriedAt > 10_000 && hasGearUpgrade(gearPlan(bot))) {
          gearTriedAt = Date.now()
          void agent.act('gear_up', {}, { caller, priority: PRIORITY.reflex })
        }
        if (autoEat && bot.food < eatBelow && agent.getAction('eat') && bestFood(bot)) void reflex('eat')
        // Eat to heal when hurt and safe (food above 17 doesn't heal faster, but saturation helps).
        else if (autoEat && !mob && bot.health < 14 && bot.food < 20 && agent.getAction('eat') && bestFood(bot)) void reflex('eat')
      }, 2000)

      return () => {
        bot.off('entityHurt', onHurt)
        bot.off('health', onHealth)
        clearInterval(timer)
      }
    }
  })
}
