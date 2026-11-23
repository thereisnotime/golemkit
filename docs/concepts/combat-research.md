---
title: Combat research
scope: minecraft
---

# Combat research

Reference notes on Java Edition combat (the 1.9+ system) as it applies to a Mineflayer bot on
Java 1.21.1. Each technique lists the mechanic, the numbers behind it, and whether a bot can do it.
The current bot behaviour is described in [Movement, protection and combat](./world.md); this page
is the research behind it and the backlog for improving it.

Primary source is the [Minecraft Wiki](https://minecraft.wiki). Some wiki pages already describe
versions newer than 1.21.1 (copper tools, spears, 1.21.2+ projectile changes); those are called out
where they matter. Numbers marked **derived** were computed from wiki constants, and ones marked
**source** come from the decompiled 1.21.1 game code rather than a wiki page, so test them in
the arena before relying on them.

Units: 1 tick = 50 ms, 20 ticks = 1 s. HP is half-hearts (a player has 20).

## What Mineflayer gives us

| Need | API | Notes |
|---|---|---|
| Melee hit | `bot.attack(entity, swing)` | Sends the attack packet and an arm swing. No cooldown check at all ([entities.js](https://github.com/PrismarineJS/mineflayer/blob/master/lib/plugins/entities.js)), so the bot must time swings itself. |
| Shield, bow, crossbow, eat, drink | `bot.activateItem(offHand)` / `bot.deactivateItem()` / `bot.consume()` | `offHand=true` uses the off-hand item, e.g. a shield ([api.md](https://github.com/PrismarineJS/mineflayer/blob/master/docs/api.md)). |
| Movement | `bot.setControlState(c, s)` | `forward`, `back`, `left`, `right`, `jump`, `sprint`, `sneak` ([api.md](https://github.com/PrismarineJS/mineflayer/blob/master/docs/api.md)). |
| Aim | `bot.lookAt(point, force)` | Server-side checks use the rotation the bot last sent. |
| Gear | `bot.equip(item, dest)` | Destinations include `hand`, `head`, `torso`, `legs`, `feet`, `off-hand` ([api.md](https://github.com/PrismarineJS/mineflayer/blob/master/docs/api.md)). |
| Blocks | `bot.placeBlock(ref, face)` | Cover, pillars, water. |
| Tracking | `entity.position`, `entity.velocity`, `entityHurt`, `entitySwingArm` | Velocity comes from server packets and is often zero for players and walking mobs; estimating it from position deltas over a few ticks is more reliable. |

## Melee fundamentals

### Attack cooldown

**What:** after a swing, an item switch or a block break, melee damage recovers over time.
Hitting early does much less damage.

**Mechanic** ([Melee attack](https://minecraft.wiki/w/Melee_attack), [Damage](https://minecraft.wiki/w/Damage)):

- Cooldown length `T = 20 / attack_speed` ticks.
- Charge `c = clamp((t + 0.5) / T, 0, 1)`, `t` = ticks since the last attack or main-hand switch.
- Base damage is multiplied by `0.2 + 0.8 * c^2`. Enchantment damage (Sharpness, Smite, Bane) is
  multiplied by `c` (not squared).
- Sharpness adds `0.5 * level + 0.5`; Smite and Bane add `2.5 * level` to their targets
  ([Melee attack](https://minecraft.wiki/w/Melee_attack)).
- Crit, sweep and sprint-knockback all need `c > 0.9`. The wiki phrases this as "84.8%", which
  is the damage multiplier at `c = 0.9` (`0.2 + 0.8 * 0.81 = 0.848`), so the two statements agree.

Java 1.21.1 weapon stats ([Sword](https://minecraft.wiki/w/Sword), [Axe](https://minecraft.wiki/w/Axe)).
Tick columns are **derived** from the formula above.

| Weapon | Damage | Speed | T (ticks) | First tick with c > 0.9 | First tick with c = 1 | DPS at full charge |
|---|---|---|---|---|---|---|
| Wood / gold sword | 4 | 1.6 | 12.5 | 11 | 12 | 6.4 |
| Stone sword | 5 | 1.6 | 12.5 | 11 | 12 | 8 |
| Iron sword | 6 | 1.6 | 12.5 | 11 | 12 | 9.6 |
| Diamond sword | 7 | 1.6 | 12.5 | 11 | 12 | 11.2 |
| Netherite sword | 8 | 1.6 | 12.5 | 11 | 12 | 12.8 |
| Wood axe | 7 | 0.8 | 25 | 23 | 25 | 5.6 |
| Stone axe | 9 | 0.8 | 25 | 23 | 25 | 7.2 |
| Iron axe | 9 | 0.9 | 22.2 | 20 | 22 | 8.1 |
| Gold axe | 7 | 1.0 | 20 | 18 | 20 | 7 |
| Diamond axe | 9 | 1.0 | 20 | 18 | 20 | 9 |
| Netherite axe | 10 | 1.0 | 20 | 18 | 20 | 10 |
| Empty hand | 1 | 4 | 5 | 5 | 5 | 4 |

**Why it matters:** a sword spammed every tick deals about 20% damage per hit; waiting 12 ticks
gets 100%. The 10-tick hurt immunity (below) also means faster swings are wasted.

**Bot feasibility: yes.** Count server ticks (`physicsTick`) from the last `bot.attack` and the last
`bot.equip` to the hand. Swing at tick 12 for swords, at the "c = 1" column for axes. Never
swap weapons right before a swing: the switch resets `t`.

### Hurt immunity (i-frames)

**Mechanic** ([Damage](https://minecraft.wiki/w/Damage)): after taking damage an entity is immune
for 10 ticks (0.5 s). A hit during that window only lands if it is stronger than the hit that
started it, and then only deals the difference. Knockback is also ignored during the window
([Knockback](https://minecraft.wiki/w/Knockback_(mechanic))).

**Why it matters:** a sword at full charge (12 ticks) always clears the 10-tick window, so
single-target DPS is set by the cooldown, not the i-frames. Two bots hitting the same mob in the
same 10 ticks waste the weaker hit.

**Bot feasibility: yes.** Track `entityHurt` per target and avoid stacking swings inside 10 ticks.

### Critical hits

**What:** a falling hit for 1.5x base damage.

**Conditions** ([Melee attack](https://minecraft.wiki/w/Melee_attack), [Damage](https://minecraft.wiki/w/Damage)):

1. Falling (fall distance > 0) and not on the ground.
2. Cooldown `c > 0.9`.
3. Not sprinting. A sprinting hit becomes a sprint-knockback hit instead, which takes priority.
4. Not on a ladder, vines or other climbable block; not in water (lava is fine).
5. Not riding anything.
6. No Blindness. The wiki also lists Slow Falling and Levitation; treat them as disqualifying.

The 1.5x applies to base damage (after Strength, before enchantments and armour), rounded down
([Damage](https://minecraft.wiki/w/Damage)).

**Timing (derived):** players fall with gravity 0.08 and vertical drag 0.98 per tick
([Entity](https://minecraft.wiki/w/Entity)). With the vanilla jump velocity of 0.42 (**source**),
the apex comes about 6 ticks after the jump and landing about 12 ticks after it, so the falling
window is roughly ticks 6 to 11. For a sword that means jumping around tick 1 to 5 after the
previous hit so the falling window overlaps tick 11+. A jump under a 2-high ceiling cuts the
window short.

**Why it works:** +50% damage per hit for no gear cost. Netherite sword goes from 8 to 12.

**Bot feasibility: yes.** `setControlState('jump', true)` for one tick, then watch
`bot.entity.onGround === false` and `bot.entity.velocity.y < 0` and swing when charge is ready.
Release sprint before the jump, or the hit becomes a sprint hit and is not a crit.

### Sprint hits, sprint reset and W-tap

**What:** a hit while sprinting deals extra knockback and ends the sprint. To get the bonus
again, the attacker has to start sprinting again; W-tap means releasing forward briefly and
pressing it again after each hit ([Lunar Client guide](https://www.lunarclient.com/news/lunar-client-and-minecraft-pvp-mastering-modern-combat),
[r/CompetitiveMinecraft melee guide](https://www.reddit.com/r/CompetitiveMinecraft/comments/ngfh12/comprehensive_melee_guide/)).
S-tap (tap back) and sneak-tap are variants.

**Mechanic:**

- Sprint-knockback needs sprinting and `c > 0.9`; it cancels the sprint, stacks with the Knockback
  enchantment, and cannot be a crit or a sweep ([Melee attack](https://minecraft.wiki/w/Melee_attack)).
- Since 15w47a sprint hits use vertical knockback 0.5 instead of 0.1
  ([Knockback](https://minecraft.wiki/w/Knockback_(mechanic))). Airborne targets only get
  horizontal knockback.
- Knockback resistance scales velocity by `1 - r`; each netherite piece gives 10%
  ([Knockback](https://minecraft.wiki/w/Knockback_(mechanic))).
- Sprinting needs food > 6 and stops on attack, blocking, eating, or hitting a wall at more than
  8 degrees ([Sprinting](https://minecraft.wiki/w/Sprinting)). Sprint speed is about 5.6 m/s vs
  4.3 m/s walking.

**Why it works:** the knockback pushes the target back out of its own reach while the attacker
re-closes in the cooldown window. Against mobs this is a free "hit and step back"; against a
creeper it can push it away before the fuse ends.

**Bot feasibility: yes.** Sprint on approach, hit, then `sprint=false` and `forward=false` for
1 to 2 ticks and back on. Pick per hit: sprint hit for knockback (creepers, crowds, edges) or
crit for damage (single tanky target). They are mutually exclusive.

### Sweep attacks

**Conditions** ([Melee attack](https://minecraft.wiki/w/Melee_attack), [Sword](https://minecraft.wiki/w/Sword)):

- Sword in the main hand, `c > 0.9`, on the ground.
- Not a crit and not a sprint-knockback hit.
- Horizontal movement this tick no more than the movement speed attribute (0.1 blocks/tick
  default), so walking forward is fine but sprinting is not.

**Effect:** entities within 1 block horizontally and 0.25 blocks vertically of the target's
hitbox, and within 3 blocks of the attacker, take `1 + ratio * base + enchantment`, with
Sweeping Edge ratio `n / (n + 1)` (50%, 67%, 75% of base). Without Sweeping Edge a sweep deals
1 HP. Sweep knockback is 80% of normal ([Sword](https://minecraft.wiki/w/Sword)).

**Why it matters:** a Sharpness V / Sweeping Edge III diamond sword sweeps for 1 + 5.25 + 3 = 9.25
(derived) on every neighbour, which makes crowds in a doorway manageable.

**Bot feasibility: yes.** Stand still or walk, no sprint, no jump, full charge. Useful choice
when two or more hostiles are packed together.

### Spacing and reach

**Mechanic:** player attack reach is the `entity_interaction_range` attribute, 3 blocks in
survival, measured from the eyes to the target's hitbox ([Melee attack](https://minecraft.wiki/w/Melee_attack)).
Since 23w33a (1.20.2) mob melee reach is based on the mob's hitbox and covers its full height
([Enderman](https://minecraft.wiki/w/Enderman)), so a zombie reaches roughly 1.4 blocks between
centres (measured, see [world.md](./world.md)).

**Why it works:** the gap between 3 blocks (us) and about 1.4 (a zombie) is a safe band. Stay
at 2.2 to 2.9 blocks, step in to hit, step out while recharging.

**Bot feasibility: yes.** Already implemented as `combat.strafe`. Reach check must use eye
position (`bot.entity.position + eyeHeight`) to the nearest point of the target's bounding box,
not centre to centre.

### Strafing and circle-strafing

**What:** moving sideways around the target while keeping the crosshair on it. Makes the
target turn and miss, and in PvP lets you hit right after the opponent's swing while their
cooldown is running ([Sportskeeda: combat tactics](https://sportskeeda.com/minecraft/3-best-combat-tactics-minecraft-java-edition)).
Skeletons do it themselves when a player is close ([Skeleton](https://minecraft.wiki/w/Skeleton)).

**Why it works vs mobs:** mobs path toward your position; side steps make archers' arrows
(aimed at where you are) miss more often, and keep you out of a melee mob's straight line.

**Bot feasibility: yes.** `left`/`right` control with `lookAt` the target each tick. Check each
step for drops, water, lava and fire (existing safe-step check).

### Hit-and-run (kiting)

**What:** hit once at full charge, retreat while the cooldown runs, re-engage. Works against
anything slower than a walking or sprinting player: zombies, creepers (speed 0.25,
[Creeper](https://minecraft.wiki/w/Creeper)), witches (0.25, [Witch](https://minecraft.wiki/w/Witch)),
husks. Sprint-hit then run back is the wiki's recommended creeper melee
([Tutorial:Combat](https://minecraft.wiki/w/Tutorial:Combat)).

**Bot feasibility: yes.** Not useful against vindicators (speed 0.35,
[Vindicator](https://minecraft.wiki/w/Vindicator)), spiders that pounce, or evokers (0.5, they
flee anyway, [Evoker](https://minecraft.wiki/w/Evoker)).

### Axe vs sword

| | Sword | Axe |
|---|---|---|
| Best single hit | 8 (netherite) | 10 (netherite) |
| DPS at full charge | 12.8 (netherite) | 10 (netherite) |
| Sweep | yes | no |
| Disables shields | no | yes, 5 s |

Sources: [Sword](https://minecraft.wiki/w/Sword), [Axe](https://minecraft.wiki/w/Axe).

**Rule of thumb:** sword for sustained fights and crowds; axe when a single hit kills (axe crit on
a 20 HP mob: netherite 15 + Sharpness), against shield users, and as the opener against a
blocking player. Stone axe (9) hits harder per swing than an iron sword (6) but has less DPS
(7.2 vs 9.6). Cave spiders are small enough that the wiki recommends a sword
([Tutorial:Combat](https://minecraft.wiki/w/Tutorial:Combat)).

**Bot feasibility: yes.** Keep the swap away from the swing (switching resets the cooldown), so
swap during approach, not at point-blank.

## Defence

### Shield

**Mechanic** ([Shield](https://minecraft.wiki/w/Shield)):

- Blocks damage coming from within 90 degrees either side of where the player faces, a
  half-circle in front. Pitch is ignored.
- Only active 5 ticks (0.25 s) after raising. Raising again restarts the delay.
- Blocks melee, arrows (not piercing), tridents, fireballs, shulker bullets and, in Java, all
  explosions including creepers. Does not block piercing crossbow bolts, splash/lingering
  potions, evoker fangs, warden sonic boom or fall damage.
- Java: blocked melee and projectiles cause no knockback; explosion and ravager knockback is
  reduced.
- Durability: 336. A blocked hit of 3+ damage costs durability roughly equal to the damage.
- An axe hit, from a player or from any axe-wielding mob (vindicator, piglin brute, zombie with
  an axe), disables all the defender's shields for 5 s (100 ticks), only while the shield is up and
  past its 5-tick delay ([Axe](https://minecraft.wiki/w/Axe), [Shield](https://minecraft.wiki/w/Shield)).
  Wardens also disable shields.
- Blocking stops sprinting ([Sprinting](https://minecraft.wiki/w/Sprinting)).

**Block timing:** raise at least 5 ticks before the expected impact (arrow flight time from the
simulator, mob windup), lower to attack. The vanilla client discards attack clicks while an item
is in use; whether the 1.21.1 server rejects an attack packet sent mid-block is untested
(**source** suggests it does not check), but anticheat plugins flag it, so lower first.

**Bot feasibility: yes.** `bot.equip(shield, 'off-hand')`, `bot.activateItem(true)` to raise,
`bot.deactivateItem()` to lower. Face the threat with `lookAt`. After a disable, the item
cooldown is visible as a set-cooldown packet; treat the shield as gone for 100 ticks. Never hold
a shield up against a vindicator.

### Armour and toughness

**Formula** ([Armor](https://minecraft.wiki/w/Armor#Damage_reduction)):

```
damageTaken = damage * (1 - min(20, max(armor / 5, armor - 4 * damage / (toughness + 8))) / 25)
```

Max reduction 80% (20 points). Toughness only matters for big hits.

| Set | Armour | Toughness | KB resist |
|---|---|---|---|
| Diamond | 20 | 8 | 0 |
| Netherite | 20 | 12 | 40% |

Per-piece values from [Armor](https://minecraft.wiki/w/Armor); totals derived. Worked examples
(derived): a 10 HP hit against full diamond is cut 70%; a 43 HP creeper blast (Normal max) is
cut only 37% by diamond and 46% by netherite. Armour does not reduce fall damage
([Damage](https://minecraft.wiki/w/Damage)), evoker fangs ([Evoker](https://minecraft.wiki/w/Evoker))
or the warden's sonic boom ([Warden](https://minecraft.wiki/w/Warden)).

**Bot feasibility: yes.** Already `combat.autoArmor`. Score pieces with this formula at the
expected hit size, not by armour points alone.

### Protection vs Blast Protection

**Mechanic** ([Armor](https://minecraft.wiki/w/Armor#Enchantments), [Protection](https://minecraft.wiki/w/Protection)):

- EPF per level: Protection 1; Blast, Fire, Projectile Protection 2; Feather Falling 3.
- EPF from all worn pieces is summed and capped at 20. Reduction = `EPF / 25` (cap 80%),
  applied after armour.
- Protection, Blast, Fire and Projectile Protection are mutually exclusive on one piece.
- Blast Protection also cuts explosion knockback by `15 * level` percent
  ([Knockback](https://minecraft.wiki/w/Knockback_(mechanic))).

| Loadout | General EPF | Explosion EPF | Projectile EPF |
|---|---|---|---|
| 4x Protection IV | 16 (64%) | 16 (64%) | 16 (64%) |
| 3x Prot IV + 1x Blast IV | 12 (48%) | 20 (80%) | 12 (48%) |
| 3x Prot IV + 1x Proj IV | 12 (48%) | 12 (48%) | 20 (80%) |

(derived)

**Takeaway:** 4x Protection IV is the best general set. Swapping one piece to Blast Protection
IV maxes explosion reduction for a creeper-heavy or TNT-heavy area at the cost of 16% general.

**Bot feasibility: yes.** Selection logic only; armour swaps mid-fight cost time.

### Totem of Undying

**Mechanic** ([Totem of Undying](https://minecraft.wiki/w/Totem_of_Undying)):

- Works only held in the main hand or off-hand, not anywhere else in the hotbar.
- On lethal damage: health set to 1 HP, all effects removed, then Regeneration II 45 s,
  Fire Resistance I 40 s, Absorption II 5 s. Consumed.
- Does not save from the void or `/kill`. An arrow of Harming whose physical hit is lethal still
  kills, because the Instant Damage applies after the totem.
- Evokers always drop one ([Evoker](https://minecraft.wiki/w/Evoker)).

**Use:** keep it in the off-hand when a death is likely (low health, raid, many mobs) and the
shield is less useful; after a pop, re-equip the next totem at once, since the 5 s Absorption is
the only buffer.

**Bot feasibility: yes.** `bot.equip(totem, 'off-hand')`. Detect a pop by the off-hand slot
emptying while health is at 1 to 2. Off-hand is a trade: totem or shield, not both.

### Golden apples

**Mechanic:**

| | Eat time | Effects |
|---|---|---|
| Golden apple | 32 ticks (1.6 s) | Absorption I 2 min (4 HP), Regeneration II 5 s (about 4 HP) |
| Enchanted golden apple | 32 ticks (1.6 s) | Absorption IV 2 min (16 HP), Regeneration II 20 s, Resistance I 5 min, Fire Resistance I 5 min |

Both can be eaten at full hunger. Sources: [Golden Apple](https://minecraft.wiki/w/Golden_Apple),
[Enchanted Golden Apple](https://minecraft.wiki/w/Enchanted_Golden_Apple).

**When to eat:** before a fight you can see coming (Absorption lasts 2 minutes), or after creating
distance or breaking line of sight. Never in melee range: 32 ticks of eating at walking speed with
no swings is 2.5 sword cooldowns. Eating stops and blocks sprinting
([Sprinting](https://minecraft.wiki/w/Sprinting)).

**Bot feasibility: yes.** `bot.equip(apple, 'hand')`, `bot.consume()`. Remember the equip resets
the attack cooldown.

### Healing behind cover

**What:** break line of sight, then heal. Ranged mobs need line of sight to shoot; a blaze's
volley is interrupted by breaking it ([Blaze](https://minecraft.wiki/w/Blaze)), a skeleton only
shoots with a clear line ([Skeleton](https://minecraft.wiki/w/Skeleton)).

**Ways to heal:** golden apple (above), Instant Health potion (`2 * 2^level` HP: 4 at I, 8 at II,
[Instant Health](https://minecraft.wiki/w/Instant_Health)); splash potions scale linearly to 0 at
4 blocks from impact ([Splash Potion](https://minecraft.wiki/w/Splash_Potion)); natural
regeneration needs a high food bar ([Hunger](https://minecraft.wiki/w/Hunger)).

**Bot feasibility: yes.** Place 2-3 blocks between the bot and the shooter (`placeBlock`), or
retreat around a corner, then eat. Existing `combat.disengageToHeal` does the retreat part.

## Ranged

### Bow

**Mechanic:**

- Full charge (and crit arrows) at 20 ticks of drawing. The wiki also quotes 0.9 s for "full
  charge" and 1 s for critical charge ([Bow](https://minecraft.wiki/w/Bow)); the game's power curve
  (**source**: `power = (s^2 + 2s) / 3`, `s = ticks / 20`, capped at 1) only reaches 1.0 at 20
  ticks, so use 20.
- Launch speed `3 * power` blocks/tick, i.e. 3 b/t at full charge (**source**; the wiki's
  projectile calculator also uses 3).
- Arrow physics: gravity 0.05 b/t², drag 0.99 per tick, terminal velocity 5 b/t
  ([Entity](https://minecraft.wiki/w/Entity), [Bow](https://minecraft.wiki/w/Bow)).
- Damage at full charge: 6 HP; critical shots up to about 11 HP. Power I to V: 9, 11, 12, 14, 15
  HP ([Bow](https://minecraft.wiki/w/Bow)).

**Leading a target:** simulate the arrow tick by tick (velocity, then drag 0.99, then gravity
0.05; the wiki does not give arrow tick order, so pin it with a test), solve for the flight time
`n` to the target's predicted position `p + v * n`, iterate 2-3 times. Velocity from position
deltas, not `entity.velocity`, for walking mobs.

**Bot feasibility: yes.** `activateItem()`, wait 20 ticks, `lookAt(aimPoint, true)`,
`deactivateItem()`. Already implemented (`combat.ranged`). Drawing slows the bot to sneak speed,
so draw behind cover or after dodging, as the wiki suggests vs skeletons
([Tutorial:Combat](https://minecraft.wiki/w/Tutorial:Combat)).

### Crossbow

**Mechanic** ([Crossbow](https://minecraft.wiki/w/Crossbow)):

- Charge 25 ticks (1.25 s); Quick Charge I/II/III: 20, 15, 10 ticks. Sneak speed while charging.
- Stays loaded until fired, also when switched out of the hand.
- Arrow 7 to 11 HP, launch speed about 3.15 b/t, same gravity and drag as bow arrows.
- Piercing arrows ignore shields. Multishot fires 3. Firework rockets explode on hit (5 to 18 HP
  depending on stars, about 4-block radius).

**Use:** load during approach or behind cover, fire on contact, switch to melee. A loaded
crossbow in the hotbar is a free opener.

**Bot feasibility: partial.** Load with `activateItem()` and `deactivateItem()` after the charge,
fire with another `activateItem()`. The loaded state lives in the item's `charged_projectiles`
component; reading it through prismarine-item works on 1.21.1 but needs testing.

## Movement, terrain and utility

### Water bucket clutch (MLG) and fire

**Mechanic:** player fall damage is `floor(fall distance - 3)` HP (`safe_fall_distance` 3).
Landing in water, cobweb, powder snow, on a ladder, vines or a slime block resets fall distance;
hay bales and honey blocks cut fall damage to 20%; beds halve the fall distance
([Damage](https://minecraft.wiki/w/Damage)). Armour does not help; Feather Falling and Protection
do. Water placed in the Nether evaporates ([Water Bucket](https://minecraft.wiki/w/Water_Bucket)).

**Clutch:** while falling, look straight down and use the bucket when the ground is inside block
interaction range (4.5 blocks, [Attribute](https://minecraft.wiki/w/Attribute)), a few ticks before
impact; pick the water back up afterwards. Water also puts out burning, so it doubles as the
counter to fire and lava damage (except in the Nether).

**Bot feasibility: partial.** `lookAt` straight down with `force=true`, `activateItem()` with the
bucket held. Timing must be predicted from fall speed (players: gravity 0.08, drag 0.98,
[Entity](https://minecraft.wiki/w/Entity)) because server round trips eat a tick or two. Easier
and safer: avoid the fall (existing safe-step check).

### Blocks for cover and pillaring

**What:** a 2-block pillar puts the bot's feet above a zombie's hitbox reach while it can still hit
their heads ([Tutorial:Combat](https://minecraft.wiki/w/Tutorial:Combat)). Endermen need 3 blocks
since 1.20.2 ([Enderman](https://minecraft.wiki/w/Enderman)). Don't pillar with archers around.
Cover blocks (2 high) stop arrows, blaze fireballs and pillager bolts.

**Bot feasibility: yes.** Jump and `placeBlock` under the feet; already used when outnumbered.

### Ender pearls

**Mechanic** ([Ender Pearl](https://minecraft.wiki/w/Ender_Pearl), [Entity](https://minecraft.wiki/w/Entity)):

- Teleport costs 5 HP (reduced by Protection/Feather Falling, not by plain armour). Cooldown 20
  ticks. 5% endermite chance.
- Launch about 1.5 b/t plus thrower velocity; gravity 0.03, drag 0.99. Max about 51.5 blocks
  horizontally at about 40 degrees.
- 1.21.1 tick order is position, drag, acceleration; 1.21.2 changed it to acceleration, drag,
  position. Use the 1.21.1 order.

**Use:** escape (pearl away from a crowd or out of a pit), or cross a gap. Throwing just before
landing from a high fall replaces fall damage with the 5 HP.

**Bot feasibility: partial.** Throw with `lookAt` + `activateItem()`; the landing point needs the
same simulator as arrows. Low priority for a PvE bot.

### Terrain: high ground, chokepoints, doorways

- **Doorways and 1-wide corridors:** only one or two melee mobs can reach you at once, and
  a sweep hits the stack. Spiders are 1.4 blocks wide and can't enter a 1-wide gap
  ([Spider](https://minecraft.wiki/w/Spider)); cave spiders fit through gaps 0.5 tall
  ([Cave Spider](https://minecraft.wiki/w/Cave_Spider)). The wiki suggests a 1-wide, 2-tall
  doorway to camp blaze spawners ([Tutorial:Combat](https://minecraft.wiki/w/Tutorial:Combat)).
- **Back to a wall or inside corner:** limits approach angles; the wiki recommends it vs endermen
  ([Tutorial:Combat](https://minecraft.wiki/w/Tutorial:Combat)).
- **High ground / pillars:** see above. Slimes don't pathfind and get stuck behind walls
  ([Slime](https://minecraft.wiki/w/Slime)).
- **Hazards:** ditches, cobwebs and water slow mobs ([Tutorial:Combat](https://minecraft.wiki/w/Tutorial:Combat)).

**Bot feasibility: partial.** Choosing a chokepoint needs terrain analysis around the bot
(scan for 1-wide openings with solid sides); fighting from one is easy.

### Night, crowds, pulling one at a time

- Hostiles spawn in darkness (light level 0, e.g. [Spider](https://minecraft.wiki/w/Spider)) and
  phantoms add a fourth threat after 3 days without sleep. Without armour and food, avoiding the
  night (home, bunker) beats fighting it.
- **Pull singles:** shoot one mob from range so it alone comes to you; zombies notice players from
  about 40 blocks ([Tutorial:Combat](https://minecraft.wiki/w/Tutorial:Combat)), so engage at
  the edge of the group, never in the middle.
- **Crowds:** back up so they line up, sweep at the front, sprint-hit to push the closest away, or
  pillar 2.

**Bot feasibility: yes** for pull and back-up; partial for choosing which mob to pull.

## Mob counters

Damage values are Normal difficulty unless noted.

### Creeper

[Creeper](https://minecraft.wiki/w/Creeper): 20 HP, speed 0.25. Starts the fuse within 3 blocks,
explodes after 30 ticks (1.5 s); cancels if the player gets 7+ blocks away (any difficulty);
breaking line of sight also stops the swell (**source**). Explosion power 3 (6 charged); max 43 HP
on Normal, 64.5 on Hard. Knockback resistance 0. Cats and ocelots within 6 blocks scare it off.

- Best: bow from 5+ blocks (about three unenchanted full-charge shots,
  [Tutorial:Combat](https://minecraft.wiki/w/Tutorial:Combat)).
- Melee: sprint-hit, back off at once, repeat. Two or three sword hits kill it.
- Lit fuse in range: run to 7+ blocks, or raise a shield (Java blocks the whole explosion,
  [Shield](https://minecraft.wiki/w/Shield)). Never stand and trade hits with a lit creeper.
- Blast Protection on one piece makes a surprise blast survivable.

**Bot feasibility: yes** (already prioritised). Watch the creeper's fuse metadata to know it is
lit.

### Skeleton

[Skeleton](https://minecraft.wiki/w/Skeleton): 20 HP. Shoots within 15 blocks with line of sight,
every 3 s (2 s on Hard), 3 to 5 HP (4 to 8 Hard). Retreats when the player is within 4 blocks and
strafes. Aims about 0.2 blocks high per block of distance.

- Close in behind a raised shield, lower and crit ([Tutorial:Combat](https://minecraft.wiki/w/Tutorial:Combat)).
- Or zig-zag in, or use cover to approach, or out-range it with a bow.
- Burns in daylight; waiting for morning is valid.

**Bot feasibility: yes.**

### Witch

[Witch](https://minecraft.wiki/w/Witch): 26 HP. Throws a splash potion within 10 blocks about every
3 s: Slowness at 8 to 10 blocks, Poison if you have 8+ HP, Weakness (25%) within 3 blocks when you
are low or poisoned, otherwise Harming (up to 6 HP). Drinks Healing (5% chance per tick when hurt,
+4 HP), Fire Resistance when burning, Swiftness at 11+ blocks, Water Breathing underwater.
Drinking takes 1.6 s and stops it attacking. Takes 85% less damage from poison, harming and fangs.

- Rush and land several hits while it drinks, or shoot it ([Tutorial:Combat](https://minecraft.wiki/w/Tutorial:Combat)).
- Don't use splash potions on it. Kill it first in raids: it heals the other raiders.
- A shield does not block its potions ([Shield](https://minecraft.wiki/w/Shield)).

**Bot feasibility: yes.**

### Enderman

[Enderman](https://minecraft.wiki/w/Enderman): 40 HP, 7 HP per hit (10.5 Hard), 2.9 blocks tall.
Turns hostile when a player within 64 blocks looks at its head or eyes for 5 ticks with a clear
view. A carved pumpkin on the head prevents this. Teleports away from most projectiles. Water and
rain deal 1 HP and make it teleport.

- Don't look at its head. For a bot: never `lookAt` a point above an enderman's mid-body unless
  you mean to fight it; look at its legs when fighting ([Tutorial:Combat](https://minecraft.wiki/w/Tutorial:Combat)).
- 2-block-tall shelter: it can't enter a space lower than its height
  ([Tutorial:Combat](https://minecraft.wiki/w/Tutorial:Combat)). Stand deep inside, since its
  reach now covers its hitbox and it can still hit from the opening edge. A 2-block pillar no
  longer works; 3 does ([Enderman](https://minecraft.wiki/w/Enderman)).
- Fighting next to water: stand in water and it can't follow; pouring water hurts it without
  angering it.
- Don't use bows or Fire Aspect (it teleports).

**Bot feasibility: yes.** The gaze rule must be enforced in every `lookAt` call (pathing and
looking around included), not only in combat.

### Phantom

[Phantom](https://minecraft.wiki/w/Phantom): 20 HP, bite 2 HP (3 Hard). Spawns at night or in
thunder when the player's time since rest reaches 72,000 ticks (3 in-game days), above Y=62 with
open sky, 1 to 3 per attempt on Normal, 20 to 34 blocks overhead. Swoops every 8 to 12 s and
retreats when hit mid-swoop. Burns in sunlight. Avoids cats (16 blocks).

- Prevention: sleep (entering a bed resets the timer, no need to skip the night). Dying also
  resets it.
- In a fight: get under a roof or into a 1-block hole, or hit them during the swoop and sidestep
  ([Tutorial:Combat](https://minecraft.wiki/w/Tutorial:Combat)). A bow works in the open.

**Bot feasibility: yes.** Sleeping (`bot.sleep(bed)`) is the cheapest counter; track nights
since last sleep.

### Spider, spider jockey, cave spider

- [Spider](https://minecraft.wiki/w/Spider): 16 HP, 2 HP (3 Hard). Hostile in light 11 or less,
  neutral above unless attacked. Climbs walls (not ceilings), pounces close up, immune to poison
  and cobwebs, 1.4 wide. 1% spawn as a jockey with a skeleton rider: kill the skeleton first or
  shoot both.
- [Cave Spider](https://minecraft.wiki/w/Cave_Spider): 12 HP, 2 HP plus Poison (7 s, 6 HP on
  Normal; 15 s Hard). Poison can't drop you below 1 HP but leaves you one hit from death. Fits
  through 1x1 gaps. Spawners sit in cobwebbed mineshaft corridors: clear webs with shears, a sword
  or water before fighting ([Tutorial:Combat](https://minecraft.wiki/w/Tutorial:Combat)).

**Bot feasibility: yes.** Don't chase spiders up walls (current behaviour). Treat cobwebs as
no-go for the bot's own pathing; spiders aren't slowed by them.

### Slime

[Slime](https://minecraft.wiki/w/Slime): large 16 HP / 4 HP damage, medium 4 HP / 2, small 1 HP / 0.
Large splits into 2 to 4 medium, medium into 2 to 4 small. Moves in straight lines, no pathfinding,
damages on contact roughly twice as fast as other mobs.

- Back up so the splits come one by one; ignore small slimes (no damage).
- Don't hold a shield up long against ramming slimes (durability drain,
  [Tutorial:Combat](https://minecraft.wiki/w/Tutorial:Combat)).

**Bot feasibility: yes.** Mark size 0 slimes as harmless in target selection.

### Raids: pillager, vindicator, evoker, ravager

[Raid](https://minecraft.wiki/w/Raid): Bad Omen (from an ominous bottle in 1.21) becomes Raid Omen
when entering a village; the raid starts 30 s later. 3/5/7 waves on Easy/Normal/Hard, plus one with
Raid Omen II+. Milk cancels it.

- [Pillager](https://minecraft.wiki/w/Pillager): 24 HP, crossbow 3 to 5 HP, fires from up to 8
  blocks every 3 s. Block with a shield, counter while it reloads. Captains drop ominous bottles
  outside raids: a bot should not drink one unless told to.
- [Vindicator](https://minecraft.wiki/w/Vindicator): 24 HP, iron axe 13 HP (19.5 Hard), speed 0.35,
  disables shields for 5 s. Don't block it; kite with a bow or trade hits with full-charge crits.
  Priority over pillagers.
- [Evoker](https://minecraft.wiki/w/Evoker): 24 HP, keeps 10 blocks away. Fangs 6 HP (9 Hard) in a
  16-fang line, or rings when you are within 3 blocks; armour doesn't reduce them and shields don't
  block them, so step sideways or jump. Summons 3 vexes (14 HP, 9 HP per hit on Normal, phase
  through blocks, die after 30 to 119 s, [Vex](https://minecraft.wiki/w/Vex)). Kill it first;
  drops a totem.
- [Ravager](https://minecraft.wiki/w/Ravager): 100 HP, bite 12 HP (18 Hard), 70% knockback
  resistance. A blocked bite has a 50% chance to stun it for 2 s, after which it roars (5 blocks of
  knockback; the wiki lists both 6 HP flat and 4/6/9 per difficulty). Kill the rider first,
  use a bow, or fight from a 2-deep hole ([Tutorial:Combat](https://minecraft.wiki/w/Tutorial:Combat)).

Raid kill order: evoker, witch, vindicator, ravager rider, pillager
([Tutorial:Combat](https://minecraft.wiki/w/Tutorial:Combat)).

**Bot feasibility: partial.** Each mob is fightable; a whole raid on Normal (31 to 43 raiders) is a
coordination problem (positions, iron golems, healing) beyond a single fight loop.

### Warden

[Warden](https://minecraft.wiki/w/Warden): 500 HP, melee 30 HP (45 Hard), disables shields. Sonic
boom 10 HP (15 Hard) through walls, ignores armour, shields and Protection, range 14 horizontal /
20 vertical. Listens for vibrations within 15 blocks; anger 80 makes it hostile. Spawns after the
4th activation of sculk shriekers by a player. Despawns after 60 s calm. Darkness every 6 s
within 20 blocks.

- Avoid. Sneak in the Deep Dark (sneaking movement doesn't make vibrations), don't break or
  place blocks, don't fire projectiles near it, don't step on sculk sensors or shriekers.
- If one spawns: leave the area or dig in and wait 60 s without making vibrations. Nothing to gain
  from killing it ([Tutorial:Combat](https://minecraft.wiki/w/Tutorial:Combat)).

**Bot feasibility: yes** for avoidance (sneak control state, sculk blocks as no-go); fighting it:
no.

### Blaze

[Blaze](https://minecraft.wiki/w/Blaze): 20 HP. Charges 3 s, fires 3 fireballs 0.3 s apart (5 HP
each, sets on fire 5 s), then waits 5 s. Melee 6 HP within 2 blocks. Snowballs deal 3 HP. Immune to
fire, lava and falls.

- Shield blocks fireballs and the ignition. Attack in the 5 s gap after a volley. Fire Resistance
  stops fireball damage but not the melee. Break line of sight to interrupt.

**Bot feasibility: yes.**

### Drowned

[Drowned](https://minecraft.wiki/w/Drowned): 20 HP, melee 3 HP, trident throw 8 HP (12 Hard) every
1.5 s up to 20 blocks. 6.25% spawn with a trident. During the day they stay in water and mostly
ignore players on land.

- Fight from land with a bow or crossbow, block tridents with a shield
  ([Tutorial:Combat](https://minecraft.wiki/w/Tutorial:Combat)). Don't melee them in water: crits
  don't work in water.

**Bot feasibility: yes.**

## PvP etiquette and server rules

golemkit bots don't attack players by default ([world.md](./world.md)) and should stay that way.
Server rules vary, but these patterns are common
([HostHavoc on server rules](https://hosthavoc.com/en-GB/blog/importance-of-minecraft-server-rules),
[BadWolfMC rules](https://www.badwolfmc.com/server-rules)):

- **Consent:** many servers require both players to agree to a fight outside PvP zones. A bot never
  starts a fight with a player.
- **Defend-only stance:** if PvP is ever enabled for a bot, it only fights back against a player
  who hurt it or its owner, stops when the attacker leaves, and doesn't chase.
- **No spawn killing:** protected spawn areas are near universal, and attacking or luring players
  at their edge counts as spawn killing.
- **No combat logging:** logging out within a short window after PvP damage is the most commonly
  banned behaviour. A bot that disconnects mid-fight (crash, reconnect logic) can trigger it; delay
  voluntary disconnects until out of combat.
- **No automation where banned:** W-tap and similar mods exist ([Auto W-tap](https://www.curseforge.com/minecraft/mc-mods/auto-w-tap));
  whether a bot doing the same thing is allowed is up to the server. Ask before running a combat
  bot on a public server.

## Summary

| Technique | Mechanic numbers | Mineflayer | golemkit priority |
|---|---|---|---|
| Attack cooldown timing | `T = 20/speed`; `0.2 + 0.8c^2`; sword 12 ticks, axes 20 to 25 | yes | high (done, verify tick counting) |
| Critical hits | 1.5x base; falling, `c > 0.9`, no sprint, not in water/climbable/riding, no Blindness | yes | high (done) |
| Sprint hit / W-tap | extra KB, vertical 0.5; ends sprint; not a crit | yes | high |
| Sweep | sword, ground, no sprint, `c > 0.9`; `1 + n/(n+1) * base` | yes | medium |
| Spacing / reach | 3 blocks eyes to hitbox vs zombie about 1.4 | yes | high (done) |
| Strafing | lateral steps, keep aim | yes | medium (done) |
| Hit-and-run | mob speed 0.25 vs player walk 4.3 m/s | yes | high |
| Hurt immunity | 10 ticks; only stronger hits land, for the difference | yes | medium |
| Axe vs sword | netherite 10 dmg/1.0 vs 8/1.6; axe disables shields 5 s | yes | medium (done) |
| Shield | 180-degree front arc, 5-tick delay, 100-tick disable by axes | yes | high |
| Armour / toughness | `min(20, max(a/5, a - 4d/(t+8)))/25`, cap 80% | yes | high (done) |
| Protection vs Blast | EPF 1 vs 2 per level, cap 20 (80%) | yes | low |
| Totem | hand only; 1 HP, Regen II 45 s, Abs II 5 s, Fire Res 40 s | yes | high |
| Golden apple | 32 ticks; Abs I 2 min, Regen II 5 s | yes | high (done) |
| Healing behind cover | break line of sight, then eat/drink | yes | medium |
| Bow | 20 ticks, 3 b/t, gravity 0.05, drag 0.99 | yes | high (done) |
| Crossbow | 25 ticks (-5 per Quick Charge), 3.15 b/t, stays loaded | partial | low |
| Water bucket clutch | fall dmg `floor(d - 3)`; water resets fall | partial | low |
| Pillaring / cover | 2 blocks vs zombies, 3 vs endermen | yes | medium (done) |
| Ender pearl | 5 HP, 20-tick cooldown, 1.5 b/t, gravity 0.03 | partial | low |
| Chokepoints / doorways | 1-wide gap, spiders 1.4 wide can't enter | partial | medium |
| Pull one at a time | bow pull at the group edge | yes | medium |
| Creeper | fuse 30 ticks, ignite 3, cancel 7, power 3 | yes | high (done) |
| Skeleton | 15-block range, shot every 3 s (2 Hard) | yes | high (done) |
| Witch | 10-block throws, drinks heal 5%/tick when hurt | yes | medium |
| Enderman | 5-tick gaze within 64 blocks; 2.9 tall | yes | high (gaze guard in all `lookAt`) |
| Phantom | 72,000 ticks without rest | yes | medium (sleep) |
| Spider / cave spider | climbs; cave spider poison to 1 HP | yes | medium |
| Slime | splits 2 to 4; small deals 0 | yes | low |
| Raid mobs | vindicator disables shield; fangs ignore armour and shields | partial | low |
| Warden | boom ignores armour/shield; sneak avoids vibrations | yes (avoid only) | medium (avoidance) |
| Blaze / drowned | 5 s volley gap; trident 8 HP to 20 blocks | yes | low |
| PvP etiquette | consent, no spawn kill, no combat log | n/a | high (policy) |

## What golemkit does with it

Implemented (pure decisions in `src/skills/tactics.ts` and `src/skills/techniques.ts`, described
under [Skilled-player techniques](./world.md#skilled-player-techniques), toggles on
[Live config](../guide/live-config.md)):

| Technique | Where | Toggle |
|---|---|---|
| Cooldown timing, crit jumps, sprinted first hit, spacing, strafing | fight loop | `combat.crits`, `combat.strafe` |
| W-tap sprint hits when knockback is worth more or no crit is possible | fight loop | `combat.sprintReset` |
| Sweep hits when mobs bunch around the target | fight loop | `combat.sweep` |
| Shield between slow swings against melee, never against axes; disabled-shield tracking | fight loop | `combat.shieldMelee` |
| Shield against a creeper blast that can't be outrun | fight loop | `combat.shieldMelee` |
| Totem into the offhand at 8 health or in a lethal fall | reflexes | `combat.totem` |
| Golden apple mid-fight at 8 health (12 when surrounded) | fight loop | `combat.goldenApple` |
| Water bucket clutch, water against fire | reflexes, `water_bucket` | `combat.waterClutch` |
| Enderman gaze guard on every look; no arrows at endermen or breezes | combat skill | `combat.endermanGaze` |
| Fight from a 1-wide corridor against 3+ melee mobs | `defend` | `combat.chokepoints` |
| Bow lead with arrow physics, shield against archers, cover, pillaring, bunker | existing | `combat.ranged`, `combat.shield` |
| Defend-only PvP, never owners or friends | reflexes, `defend_player` | `combat.pvp`, `combat.friends` |

Not implemented: ender pearls, building walls mid-fight against melee crowds, cobwebs, potions,
Blast Protection choices (armour is scored by total protection), sleeping to reset phantoms
(the bed is the owner's business), warden avoidance beyond never attacking it.
