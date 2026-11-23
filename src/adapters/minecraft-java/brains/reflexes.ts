// Reflexes: things the bot does on its own regardless of other brains: fight back when hit,
// eat when hungry. They run at reflex priority, so they briefly preempt everything else and
// long-running actions (follow, guard) resume afterwards.
// Mobs shooting at the bot get their own reflex (ranged_defense, skills/ranged.ts): it starts on
// an arrow or bolt on course for the bot, a hit from range, or a shooter in range looking at it,
// and picks shoot back / shield up / cover / back off by health and gear. It preempts whatever
// job runs (scouting for food, chopping), which resumes afterwards.
import { defineBrain, PRIORITY, nearestHostile, isHostile, FLYING, needsSurvival } from '../../../core/index.ts'
import { bestFood, isClimbingOut, keepClimbing } from '../../../skills/survival.ts'
import { isRangedMob } from '../../../skills/weapons.ts'
import { threats } from '../../../skills/combat.ts'
import { fightFood } from '../../../skills/fight.ts'
import { gearPlan, hasGearUpgrade } from '../../../skills/gear.ts'
import { escorting } from '../../../skills/bodyguard.ts'
import { rangedSituation, onRangedAlarm, noteUnexplainedHit } from '../../../skills/ranged.ts'
import { isShooter, rangedResponse } from '../../../skills/ranged-plan.ts'
import { wornArmorPoints } from '../../../skills/gear.ts'
import { clutchInputs, extinguishInputs, hasWaterBucket } from '../../../skills/clutch.ts'
import { totemSwap } from '../../../skills/techniques.ts'
import { pvpAllowed } from '../../../skills/defense.ts'

export interface ReflexOptions {
  selfDefense?: boolean
  autoEat?: boolean
  /** Eat when food drops below this. */
  eatBelow?: number
  /** At or below this health, back off instead of fighting. Default 8 (4 hearts). */
  retreatBelow?: number
  /** Don't fight mobs standing in water below this health (drowned, guardians). Default 14. */
  waterFightAbove?: number
  /** React to mobs shooting at the bot (ranged_defense). Default true. */
  rangedDefense?: boolean
}

/** Actions the ranged reflex never interrupts. */
const RANGED_KEEP = new Set(['ranged_defense', 'retreat', 'bunker', 'pillar', 'climb_out', 'eat', 'water_bucket', 'defend_player'])

export const reflexes = (defaults: ReflexOptions = {}) => {
  const caller = { kind: 'reflex', name: 'reflexes' } as const

  return defineBrain({
    name: 'reflexes',
    session (agent, bot) {
      // Profile `reflexes:` (settings.reflexes) overrides the variant's defaults. Read on every
      // use, so in-game changes (config_set reflexes.*) apply immediately.
      const cfg = () => {
        const o: ReflexOptions = { ...defaults, ...(agent.settings.reflexes as ReflexOptions | undefined) }
        return { selfDefense: o.selfDefense ?? true, autoEat: o.autoEat ?? true, eatBelow: o.eatBelow ?? 15, retreatBelow: o.retreatBelow ?? 8, waterFightAbove: o.waterFightAbove ?? 14, rangedDefense: o.rangedDefense ?? true }
      }
      let busy = false
      let bunkerFailedAt = 0
      let gearTriedAt = 0
      const combatCfg = () => (agent.settings.combat ?? {}) as { autoArmor?: boolean, disengageToHeal?: boolean, totem?: boolean, waterClutch?: boolean }
      const reflex = async (action: string, force = false, params: Record<string, unknown> = {}) => {
        if (busy && !force) return
        busy = true
        try { await agent.act(action, params, { caller, priority: PRIORITY.reflex }) } finally { busy = false }
      }

      // ---- totem: into the offhand the moment health gets low (gear_up runs beside the current action) ----
      let totemTriedAt = 0
      const totemCheck = (lethalFall = false) => {
        if (!needsSurvival(bot) || bot.currentWindow || !agent.getAction('gear_up') || Date.now() - totemTriedAt < 1000) return
        const off = bot.inventory.slots[45]?.name ?? null
        if (!totemSwap({ enabled: combatCfg().totem !== false, hasTotem: bot.inventory.items().some(i => i.name === 'totem_of_undying'), offhand: off, health: bot.health, lethalFall })) return
        totemTriedAt = Date.now()
        void agent.act('gear_up', lethalFall ? { danger: true } : {}, { caller, priority: PRIORITY.reflex })
      }

      // ---- water bucket: a damaging fall (MLG clutch) or burning ----
      let fallStartY: number | null = null
      let waterBusy = false
      let fireTriedAt = 0
      const water = (params: Record<string, unknown>) => {
        if (waterBusy || !agent.getAction('water_bucket')) return
        waterBusy = true
        void agent.act('water_bucket', params, { caller, priority: PRIORITY.reflex }).finally(() => { waterBusy = false })
      }
      const onTick = () => {
        try {
          if (!bot.entity || bot.health <= 0 || !needsSurvival(bot)) { fallStartY = null; return }
          const e = bot.entity as any
          const y = bot.entity.position.y
          if (bot.entity.onGround || e.isInWater || e.isInLava || e.onClimbable) { fallStartY = y; return }
          if (fallStartY === null || y > fallStartY) fallStartY = y
          const enabled = combatCfg().waterClutch !== false
          if (bot.entity.velocity.y < -0.5 && !waterBusy) {
            const d = clutchInputs(bot, fallStartY, enabled && hasWaterBucket(bot))
            if (d.act !== 'none') water({ reason: 'fall', fallStartY })
            // a fall that kills without water: a totem in the offhand at least
            if (d.damage >= bot.health || (!hasWaterBucket(bot) && clutchInputs(bot, fallStartY, true).damage >= bot.health)) totemCheck(true)
          }
          if (enabled && Date.now() - fireTriedAt > 3000 && extinguishInputs(bot, true)) { fireTriedAt = Date.now(); water({ reason: 'fire' }) }
        } catch {}
      }
      bot.on('physicsTick', onTick)

      // ---- PvP (combat.pvp defend): fight back a player who hits the bot or the player it guards ----
      let pvpBusy = false
      const onPlayerHit = (entity: any, source: any) => {
        if (!source || source.type !== 'player' || source === bot.entity || pvpBusy || !cfg().selfDefense) return
        const who = source.username as string | undefined
        if (!who) return
        const guarded = escorting(agent)
        const victimMe = entity === bot.entity
        if (!victimMe && !(guarded && entity?.username?.toLowerCase() === guarded.toLowerCase())) return
        if (pvpAllowed(agent, bot, who)) return
        if (agent.currentAction?.name === 'defend_player' || !agent.getAction('defend_player')) return
        pvpBusy = true
        setImmediate(() => {
          void agent.act('defend_player', guarded ? { player: who, protect: guarded } : { player: who }, { caller, priority: PRIORITY.reflex })
            .finally(() => { pvpBusy = false })
        })
      }
      bot.on('entityHurt', onPlayerHit)

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

      // ---- ranged: something is shooting at us ----
      let rangedTriedAt = 0
      const rangedCheck = () => {
        const c = cfg()
        if (!c.selfDefense || !c.rangedDefense || !needsSurvival(bot) || !bot.entity || bot.health <= 0) return
        if (!agent.getAction('ranged_defense') || Date.now() - rangedTriedAt < 1500) return
        const cur = agent.currentAction?.name ?? ''
        if (RANGED_KEEP.has(cur)) return
        const s = rangedSituation(bot)
        if (!s.active.length || !(s.underFire || s.aimed)) return
        if (climbingAway(s.active[0]!.e)) return
        const hide = rangedResponse({
          health: bot.health,
          armor: wornArmorPoints(bot),
          bow: false,
          shield: true,
          melee: true,
          shooters: s.active,
          patrol: s.patrol,
          coverNear: true
        })
        const mustHide = hide?.act === 'cover' || hide?.act === 'build' || hide?.act === 'retreat'
        // a fight already running (defend, attack) goes for archers itself; only take over to hide
        if ((cur === 'defend' || cur === 'attack') && !mustHide) return
        // a melee mob on us: defend deals with it first (it ranks archers with a shot right after)
        const melee = nearestHostile(bot, bot.entity.position, 3)
        if (melee && !isShooter(melee.name, (melee as any).heldItem?.name) && !mustHide) return
        // a bodyguard fights archers for its player; take over only when it is about to die
        if (cur === 'protect' && bot.health > 6) return
        rangedTriedAt = Date.now()
        void reflex('ranged_defense', true)
      }
      const unalarm = onRangedAlarm(bot, () => setImmediate(() => { try { rangedCheck() } catch {} }))
      const rangedTimer = setInterval(() => { try { rangedCheck() } catch {} }, 500)

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
        if (cur === 'bunker' || cur === 'defend_player' || cur === 'water_bucket') return
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
        // a shooter out of reach: the ranged reflex picks shoot back / shield / cover / back off by health and gear
        if (cfg().rangedDefense && isShooter(mob.name, mob.heldItem?.name) && mob.position.distanceTo(bot.entity.position) > 4 && agent.getAction('ranged_defense')) {
          if (cur !== 'ranged_defense' && !(cur === 'protect' && bot.health > 6)) { rangedTriedAt = Date.now(); void reflex('ranged_defense', true) }
          return
        }
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
        if (dropped) totemCheck()
        lastHealth = bot.health
        if (!dropped || !cfg().selfDefense || !needsSurvival(bot)) return
        // Starving (food 0) drains health too, so a drop alone isn't a hit then. But a shooter with
        // a line to us is: Pax, starving while it scouted for food, was shot dead by a pillager and
        // only reacted to the last bolt.
        const shot = !nearestHostile(bot, bot.entity.position, 4) && noteUnexplainedHit(bot)
        if (shot) setImmediate(() => { try { rangedCheck() } catch {} })
        else if (!busy && (bot.food > 0 || nearestHostile(bot, bot.entity.position, 4))) setImmediate(() => { try { onHurtNow() } catch {} })
      }
      bot.on('health', onHealth)
      // respawned: put on whatever armour there is at the next tick instead of up to 10 s later
      const onSpawn = () => { gearTriedAt = 0 }
      bot.on('spawn', onSpawn)

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
        bot.off('entityHurt', onPlayerHit)
        bot.off('physicsTick', onTick)
        bot.off('health', onHealth)
        bot.off('spawn', onSpawn)
        clearInterval(timer)
        clearInterval(rangedTimer)
        unalarm()
      }
    }
  })
}
