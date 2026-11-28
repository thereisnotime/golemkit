---
scope: core
---

# Feature toggles (live config)

Some settings can be changed in game, while the bot runs, without a restart. Changes apply
immediately, survive restarts, and win over the [profile](/guide/profiles) until you reset them.

```
!config_list                          what can be changed, with current values (* = changed in game)
!config_get llm.listen                one setting and what it does
!config_set llm.listen all            change it (owners only)
!config_set reflexes.retreatBelow 6
!config_set retry.actions.goto 2
!config_reset llm.listen              back to the profile value
!config_reset                         undo every in-game change
```

Whispers work without the `!`. Only owners can change settings; LLM brains and other brains
can't change their own.

## What can be changed

| key | type | what |
|---|---|---|
| `canDig` | on/off | may break blocks and tunnel while pathing |
| `selfAware` | on/off | show the bot its own [variant](/concepts/variants-profiles), profile, model, brains and settings every turn (default on) |
| `respectBuilds` | on/off | leave blocks that look player-made alone when building (default off: the bot may dig and use anything it needs) |
| `reflexes.selfDefense` | on/off | fight back when hit (default on; also gates PvP `defend`) |
| `reflexes.autoEat` | on/off | eat when hungry (default on) |
| `reflexes.eatBelow` | 0–20 | eat when food drops below this (default 15) |
| `reflexes.retreatBelow` | 0–20 | back off at or below this health (0 = stand ground; default 8) |
| `reflexes.waterFightAbove` | 0–20 | don't fight mobs in water below this health (0 = always fight; default 14) |
| `reflexes.rangedDefense` | on/off | react to mobs shooting at it: shoot back, shield, cover or back off (default on) |
| `reflexes.air` | on/off | when drowning, stop and get air: swim up, break ice or a roof above, or swim to an opening, then to dry land (default on; [air](/concepts/world#air)) |
| `reflexes.airBelow` | 0–20 | go for air at or below this much air of 20, 3 earlier at 12 health or less and 6 earlier at 6 or less (default 10) |
| `combat.adaptiveWeapon` | on/off | best weapon per target (damage × speed, enchantments, one-hit finishers, axe vs shields; default on) |
| `combat.ranged` | on/off | bow/crossbow for flyers and targets out of reach, if it has arrows (default on) |
| `combat.shield` | on/off | raise a shield against ranged mobs between swings (default on) |
| `combat.crits` | on/off | jump and hit while falling for critical hits (×1.5), sprint into the first hit for knockback (default on) |
| `combat.strafe` | on/off | keep spacing and circle melee mobs between swings, step back after a hit (default on) |
| `combat.disengageToHeal` | on/off | leave a losing fight (the `retreat.*` rule; with `retreat.enabled` off: at 4 health or less with food, back off briefly to eat) and fight on; works with `retreatBelow 0` (default on) |
| `combat.autoArmor` | on/off | wear the best armour in the inventory, shield or totem in the offhand (default on) |
| `combat.maxChase` | 2–64 | stop chasing a mob this many blocks from where the fight started (default 16) |
| `combat.sprintReset` | on/off | W-tap: sprint into ground hits for knockback when a crit isn't possible or knockback is worth more (default on) |
| `combat.sweep` | on/off | with a sword, plain ground hits when mobs bunch around the target, so the sweep hits them all (default on) |
| `combat.shieldMelee` | on/off | shield up against melee mobs between slow swings, and against a lit creeper it can't outrun; an axe hit is blocked, then the shield is down 5 s (default on) |
| `combat.totem` | on/off | totem of undying into the offhand at 8 health or less (10 while on fire), or in a fall that could kill; it stays there until health is above 14 (default on) |
| `combat.goldenApple` | on/off | eat a golden apple mid-fight at 8 health or less, 12 when surrounded (default on) |
| `combat.waterClutch` | on/off | water bucket against fall damage and to put out fire, scooped back up (default on) |
| `combat.endermanGaze` | on/off | never look an enderman in the eyes unless fighting it (default on) |
| `combat.fightFastMobs` | on/off | at low health keep fighting mobs faster than the bot (vindicators, ravagers, spiders, wolves, piglin brutes, hoglins) instead of backing off at `retreatBelow`; the water back-off (`waterFightAbove`) still applies (default on) |
| `combat.chokepoints` | on/off | against 3+ melee mobs with half health or more, fight from a 1-wide gap nearby (default on) |
| `combat.phantoms.enabled` | on/off | phantoms: to bed when they are about or after a long time without a bed, else fight them before the dive (off = only fight back after a hit) |
| `combat.phantoms.sleep` | on/off | go to bed against phantoms and their spawn timer (default on) |
| `combat.phantoms.insomniaMinutes` | 0–1440 | real minutes without a bed or a death before it goes to bed at night anyway (default 30; phantoms come after 60) |
| `combat.phantoms.bedRange` | 1–64 | use a bed this close (default 16) |
| `combat.phantoms.engageRange` | 0–48 | fight a phantom this close before its dive, 0 = only after a hit (default 16) |
| `combat.phantoms.groundClear` | 0–32 | no bed with a ground mob this close (default 8) |
| `combat.phantoms.retrySeconds` | 0–3600 | wait after a refused bed (default 60) |
| `combat.phantoms.recentMinutes` | 0–120 | a bed this recent reset the timer: fight the phantoms instead of going to bed again (default 5) |
| `combat.dodge.enabled` | on/off | the [dodge layer](../concepts/world#dodging) in mob fights; off turns every `combat.dodge.*` technique off (default on) |
| `combat.dodge.draws` | on/off | leap sideways just before a skeleton within `drawRange` lets go of its drawn bow, and while a pillager holds a charged crossbow (default on) |
| `combat.dodge.arrows` | on/off | leap out of the path of an arrow or other projectile in flight that would hit (default on) |
| `combat.dodge.meleeTiming` | on/off | track each melee mob's attack cooldown: stay in while it recharges, be out of reach before it swings (default on) |
| `combat.dodge.creeperLeap` | on/off | sprint-jump away from a lit creeper instead of walking (default off: in the duels it cost kills without saving health) |
| `combat.dodge.latencyMs` | 0–500 | round trip the dodges allow for, ms (default 75) |
| `combat.dodge.drawRange` | 0–32 | react to the draw within this many blocks, to the arrow beyond (default 10) |
| `combat.dodge.arrowMargin` | 0–1 | extra room around the hitbox when judging a projectile, blocks (default 0.15) |
| `combat.dodge.leapMs` | 50–600 | how long a leap faces away before snapping back to the target, ms (default 200) |
| `combat.dodge.leapDistance` | 1–5 | how far along a leap the ground is checked, blocks (default 2.5) |
| `combat.dodge.maxDrop` | 0–4 | deepest drop a leap may land in (default 2) |
| `combat.dodge.meleeMargin` | 0–2 | blocks beyond a melee mob's reach to be at when its swing is ready (default 0.35) |
| `combat.dodge.meleeLeadMs` | 0–1000 | be out of reach this long before its next swing, on top of `latencyMs` (default 150) |
| `combat.dodge.meleeCooldownMs` | 250–3000 | attack cooldown assumed for melee mobs not in the table (default 1000, 20 ticks) |
| `combat.dodge.creeperLeapMs` | 0–3000 | longest the creeper leap keeps going; it stops once the fuse is out or the creeper is 7.2 blocks off (default 1500) |
| `combat.dodge.minGapMs` | 0–2000 | shortest gap between two leaps (default 300) |
| `combat.pvp` | off / defend / revenge / targets / all | [PvP mode](../concepts/world#pvp): `defend` fights back; `revenge` also goes after whoever killed or attacked the bot, an owner or the guarded player; `targets` attacks the target list; `all` every player in range. Never owners, friends or creative players; changes are whispered to the owners (default off) |
| `combat.friends` | names | players never fought in any PvP mode (comma separated; owners are always spared) |
| `combat.targets` | names | players attacked on sight in `targets` and `all` (`!attack_player`, `!spare_player` edit it) |
| `combat.revengeMinutes` | 0–1440 | how long a grudge lasts (default 30; 0 = no grudges) |
| `combat.revengeKills` | 1–100 | a grudge is forgiven after this many kills (default 1) |
| `combat.revengeIgnoresOdds` | on/off | revenge fights start even when the gear check says it would lose (default off) |
| `combat.spareProtected` | on/off | leave players in [protected areas](/concepts/world#protected-areas) alone in the attacking modes (default on) |
| `combat.taunts` | on/off | a short public line after winning a PvP fight (default off) |
| `combat.pvpEngage` | 2–64 | start PvP fights with players within this many blocks (default 16) |
| `combat.pvpChase` | 4–256 | give up a PvP chase this far from where the fight started (default 48) |
| `combat.pvpLostSec` | 1–600 | give up after this many seconds without seeing the player (default 30) |
| `combat.pvpMinOdds` | 0–10 | gear check: odds needed to start a `targets`/`all` fight (default 0.7; 1 = even) |
| `combat.pvpTactics` | on/off | the PvP fight loop (axe vs shields, shield timing, spacing, bow, totem and apples, ledges); off = the mob loop (default on) |
| `combat.huntMinutes` | 1–120 | `hunt_player` gives up after this many minutes (default 10) |
| `retreat.enabled` | on/off | [leaving fights in time](/concepts/world#leaving-fights): leave when health would not survive the next few hits and escape by a route; off = the old rule, back off to eat at 4 health (default on) |
| `retreat.hits` | 0.5–10 | look-ahead of the estimate: what every threat in reach lands in this many 1 s attack cycles (default 2) |
| `retreat.floor` | 0–20 | always leave at or below this health (default 4, 0 = no floor) |
| `retreat.hysteresis` | 0–20 | once leaving, keep leaving until health is this much above the estimate (default 4) |
| `retreat.shieldBlocks` | 0–1 | share of hits a shield in the offhand is counted as blocking (default 0.4) |
| `retreat.returnAbove` | 1–20 | come back to the fight after escaping only at this health (default 16) |
| `retreat.healSeconds` | 0–600 | longest wait to heal after an escape (default 60) |
| `retreat.comeBack` | on/off | after healing, fight the mobs still around: at home after going home, where it left otherwise (default on) |
| `retreat.maxEscapes` | 0–10 | escapes per `defend` run before it fights where it stands (default 2) |
| `retreat.routes` | list | escape routes in the order tried: `home`, `pillar`, `sprint`, `bunker`; leave one out to turn it off (default all four in that order) |
| `retreat.homeRadius` | 0–256 | escape home only when home is this close (default 40) |
| `retreat.closeDoors` | on/off | shut open wooden doors next to it once home (default on) |
| `retreat.pillarHeight` | 1–4 | pillar height for the pillar route (default 2: above zombie reach, still able to hit down) |
| `retreat.sprintDistance` | 6–48 | how far the sprint route runs (default 24) |
| `retreat.avoidOpen` | on/off | poorly placed for a fight: go home or fight from a chokepoint instead of in the open, unless an owner is in trouble (default on) |
| `retreat.avoidFactors` | 1–3 | how many of no armour, night and outnumbered make `avoidOpen` apply (default 2; 3 = only all three, a bolder profile) |
| `retreat.minArmour` | 0–20 | armour points below this count as no armour (default 1) |
| `retreat.outnumberedAt` | 2–10 | this many melee mobs within 8 blocks count as outnumbered (default 2) |
| `retreat.avoidRoutes` | list | where `avoidOpen` goes, in order: `home`, `chokepoint` (default both) |
| `mining.safe` | on/off | [safe mining](./progression#safe-mining): readiness before going deeper than `mining.safeDepth`, no caves, torches, climb out when losing underground (default on) |
| `mining.safeDepth` | 0–64 | blocks below the surface it may dig or go for ore without being ready (default 8) |
| `mining.needWeapon` | on/off | a sword or axe is part of being ready (default on) |
| `mining.minFood` | 0–64 | food items needed to be ready (default 3) |
| `mining.gear` | none / shield_or_armour / armour | gear needed to be ready (default none); with shield_or_armour the first iron ingot becomes a shield |
| `mining.minArmour` | 0–20 | armour points worn that count as armour (default 1) |
| `mining.retreatBelow` | 0–20 | underground: abandon the dig and climb out at or below this health; separate from `reflexes.retreatBelow` (default 10, 0 = never) |
| `mining.retreatHostiles` | 0–20 | underground: climb out when this many hostiles are within `mining.hostileRadius` blocks (default 2, 0 = never) |
| `mining.hostileRadius` | 2–32 | underground: how close a hostile counts for `mining.retreatHostiles`, in blocks (default 8) |
| `mining.surfaceHostiles` | on/off | underground: hostiles standing under open sky (the surface over the mine) count for `mining.retreatHostiles` too (default off; one within `mining.hostileClose` counts either way) |
| `mining.hostileClose` | 0–32 | underground: a hostile this close counts wherever it stands, in blocks (default 4) |
| `mining.torches` | on/off | light tunnels, crafting torches from coal or charcoal and sticks (default on) |
| `mining.torchEvery` | 1–64 | a torch every this many tunnel steps (default 8) |
| `mining.firstTorchAt` | 0–64 | in a mine with no torch yet, the first one goes after this many steps (default 4, 0 = at `torchEvery`) |
| `mine.enabled` | on/off | [the staircase mine](./progression#the-staircase-mine): dig one near home when the gear need finds no iron ore with an open face (default on) |
| `mine.depthY` | -58–120 | the stairs go down to this y (default 16, iron depth) |
| `mine.radius` | 4–128 | the entrance is within this many blocks of home (default 32) |
| `mine.minFromHome` | 0–64 | ...and at least this far from home (default 8) |
| `mine.minutes` | 1–60 | one trip down lasts at most this long (default 15) |
| `mine.branchLength` | 1–64 | side branches off the main tunnel (default 12) |
| `mine.branchSpacing` | 1–16 | solid blocks between two branches (default 3) |
| `mine.maxBranches` | 0–64 | branch pairs per trip (default 6) |
| `mine.minFreeSlots` | 1–30 | head back up with fewer free slots than this (default 3) |
| `mine.cooldownMinutes` | 0–1440 | minutes between two trips down (default 20) |
| `mine.atNight` | on/off | go down a lit mine at night too (default on) |
| `mine.startAtNight` | on/off | at night, with no mine yet, start one near home when it has torches or can make them (default on) |
| `mine.relight` | on/off | on the walk down a known mine, put torches on its dark stairs (`mining.torchEvery` apart) so an unlit mine becomes a lit one (default on) |
| `mine.gear` | none / shield_or_armour / armour | gear needed for its own mine (default none; `mining.gear` is for caves) |
| `mine.minHealth` | 0–20 | health needed to go down (default 14) |
| `mine.keepCobble` | 0–2304 | cobblestone kept on a trip; more is dropped at the end of a branch (default 64) |
| `mine.ores` | list | ores mined in the walls (default iron, coal, copper, diamond; also gold, redstone, lapis, emerald) |
| `askHelp.enabled` | on/off | when a behaviour keeps failing the same way, tell the owners once what it was trying, why it fails and what would help ([asking for help](./behaviors#asking-for-help); default off) |
| `askHelp.failures` | 1–100 | failures of the same kind before it asks (default 3) |
| `askHelp.minutes` | 0–1440 | ...spread over at least this many minutes (default 10) |
| `askHelp.maxPerHour` | 0–60 | help messages per hour at most, over all behaviours (default 3) |
| `askHelp.tell` | owners / say | whisper the owners who are online, or public chat (default owners) |
| `askHelp.thanks` | on/off | say "sorted, thanks" once when something it asked about works again (default off) |
| `askHelp.llm` | on/off | let the LLM brain know it asked (no extra turn unless `triggers.events.stuck`; default on) |
| `status.file` | on/off | write `data/bots/<name>/status.json` for `just status` ([status](./status); default on) |
| `status.intervalMs` | 1000–600000 | status sample and file interval in ms (default 5000) |
| `status.alert` | on/off | whisper the online owners when stuck: it wants to do something and made no progress for `status.stuckAlertMs` (default on) |
| `status.stuckAlertMs` | 60000–86400000 | no progress for this long counts as stuck, ms (default 600000 = 10 min) |
| `status.alertMaxMs` | 60000–604800000 | repeat alerts double their gap up to this, ms (default 7200000 = 2 h) |
| `trips.enabled` | on/off | [trips](./behaviors#trips) that behaviours start: prepare (food from own chests, weapon, health) and turn back when food or daylight runs short (default on) |
| `trips.food` | 0–64 | food items to top up to from the pantry (own and configured chests near home) before a trip (default 8) |
| `trips.minFood` | 0–64 | fewest food items to leave with; food trips are exempt (default 4) |
| `trips.needWeapon` | on/off | a sword or axe is needed to leave (default on) |
| `trips.minHealth` | 0–20 | health needed to leave (default 12) |
| `trips.foodMinHealth` | 0–20 | a food trip leaves with this much health when food is under 18, since health doesn't come back by waiting (default 6) |
| `trips.turnBackAt` | 0–1 | turn back when the food left (bar + carried) is down to this share of what it left with (default 0.5) |
| `trips.foodFloor` | 0–20 | turn back when the food bar is at or below this with nothing to eat (default 6, 0 = off) |
| `trips.daylightMarginS` | 0–600 | turn back when the daylight left is the walk home plus this many seconds (default 60) |
| `trips.speed` | 0.5–10 | walking speed used for the way home, blocks per second (default 3) |
| `trips.minDistance` | 0–1024 | walks shorter than this many blocks are not trips (default 64) |
| `trips.ownerOrders` | on/off | also prepare and budget actions an owner ordered (default off) |
| `inventoryMemory.enabled` | on/off | [container memory](./search#container-memory): keep what it saw in chests across restarts and keep it right ([journal](/guide/journal) changes, notice chests moved or broken); off = in memory only (default off) |
| `inventoryMemory.maxAgeHours` | 0.1–720 | sightings older than this are hints, re-checked before relying on them (default 24) |
| `inventoryMemory.indexOwn` | on/off | by day, look into its own and configured chests near home now and then ([check_storage](./behaviors#container-memory-check-storage)) and say when the pantry runs low (default off) |
| `inventoryMemory.refreshMinutes` | 1–1440 | check_storage looks into a chest not seen inside for this long (default 60) |
| `storage.anyContainer` | on/off | take anything it wants from every container it knows near home (chests, barrels, shulker boxes, furnaces, smokers, hoppers, droppers, dispensers, brewing stands); off = only chests it placed and `storage.chests` |
| `pickup.maxAirBreaks` | 0–20 | give up on a dropped item after running out of air this many times going for it (items on the bottom of a lake); pickup_items, collect_drops and recover_items then skip it. 0 = never give up (default 2) |
| `pickup.unreachableMinutes` | 0.5–240 | a drop it gave up on stays skipped this long; air breaks older than this are forgotten (default 10) |
| `pickup.matchRadius` | 0–8 | other drops within this many blocks of a given-up drop are skipped with it (default 2) |
| `inventoryMemory.radius` | 4–256 | check_storage: chests within this many blocks of home (default 48) |
| `inventoryMemory.lowFood` | 0–1000 | tell the owners when the pantry holds fewer food items than this (default 8, 0 = never) |
| `inventoryMemory.grumble` | on/off | grumble once in chat when its own chest is raided, moved or broken (default off) |
| `inventoryMemory.grumbleTo` | owners / say | whisper the owners online, or public chat (default owners) |
| `inventoryMemory.grumbleHours` | 0–168 | at most one grumble per chest this often (default 3) |
| `needs.enabled` | on/off | the [needs layer](./needs-and-idle): boosts for urgent needs and going looking (default on) |
| `needs.boost` | 0–60 | score added to a behaviour serving an urgent need, at urgency 1 (default 15) |
| `needs.search.enabled` | on/off | go looking when a need has no visible way to be met (default on) |
| `needs.search.radius` | 16–512 | how far a search may go, in blocks (default 160) |
| `needs.search.minutes` | 1–30 | give a search up after this long (default 6) |
| `needs.search.cooldownMinutes` | 1–1440 | minutes between searches for one need (default 30) |
| `needs.search.retryMinutes` | 0–1440 | a search taken over in its first minute doesn't count; minutes before it may run again (default 5) |
| `needs.search.perDay` | 0–100 | searches per need a day at most (default 6) |
| `needs.search.startBelow` | 0–79 | a search may start while no other work scores above this; it then goes next, after the running behaviour (default 30, 15 = only when nothing else wants the body) |
| `needs.search.holdScore` | 0–79 | a running search keeps this score against other work: only work scoring it plus the switch margin (10) takes over (default 30, 0 = anything above the idle band ends it) |
| `needs.search.resumes` | 0–20 | a search cut short because the body was taken (a reflex eating or fighting, a player) may start again at once this many times per `cooldownMinutes` (default 3) |
| `needs.search.atNight` | on/off | also search at night (default off) |
| `needs.<need>.enabled` | on/off | `safety`, `food`, `gear`, `supplies`, `rest`: on or off; reset = on when a behaviour serving it is armed |
| `needs.<need>.threshold` | 0–1 | urgency from which the need boosts its behaviours and may search (default 0.5) |
| `idle.mode` | off / passive / idle / active / explore | what it does when nothing else scores ([idle modes](./needs-and-idle#idle-modes); default idle) |
| `idle.radius` | 4–256 | idle and active chores stay this close to home (default 24) |
| `idle.exploreRadius` | 32–1024 | explore mode: how far a scouting trip goes (default 200) |
| `idle.exploreMinutes` | 1–30 | explore mode: how long a scouting trip may take (default 8) |
| `idle.chores.<chore>` | on/off | one idle chore on or off (`!config_set idle.chores.scout_nearby off`) |
| `farming.iceWater` | on/off | cold ground: break ice on a frozen shore for a new farm's water when there is no open water or bucket ([cold ground](./needs-and-idle#farming-on-cold-ground); default on) |
| `farming.protectWater` | auto / cover / torch / off | keep a farm's water from freezing in a cold biome: a cheap block over it, else a torch next to it (default auto) |
| `farming.badFarm` | auto / repair / relocate / off | a farm marked bad: repair a small job where it is, else move (auto); never move; always move; leave it ([food sources](./food-sources#bad-farms-repair-or-move); default auto) |
| `farming.repairMaxBlocks` | 0–80 | most flooded cells it fills with dirt in one repair (default 16) |
| `farming.repairTries` | 0–20 | repairs per bad farm before it gives up on it (default 2) |
| `farming.ownBuilds` | on/off | its own torches, walls, covers, farms and base are not somebody's build near a farm site (default on) |
| `farming.ownBaseRadius` | 0–64 | blocks around its base's anchor that count as its own (default 12) |
| `farming.plot` | on/off | use the farm plot its base keeps inside the walls ([farm plot](./food-sources#the-base-s-farm-plot); default on) |
| `farming.plotWater` | auto / water / dry | the plot's water: in reach; on a plot of 5 and up a water bucket (carried, stored, an empty one filled, or crafted from 3 iron); carried ice; else dry (auto); only with water; never (default auto) |
| `farming.plotSwap` | on/off | dig out stone cells of the plot and put dirt in (default on) |
| `farming.plotSize` | 3–11, odd | wanted side of the farm plot; a smaller one is [grown](./food-sources#growing-the-plot) and its farm extended (default 7) |
| `farming.plotMin` | 3–11, odd | smallest farm plot worth keeping inside the walls (default 3) |
| `farming.plotSeedRadius` | 8–96 | short of seeds for the plot: break grass this far from home (default 32) |
| `food.sources` | list | [food sources](./food-sources) in order: repair, farm, plot, animals, fish, forage (`!config_set food.sources plot,fish`) |
| `food.stock` | 0–256 | animals, fishing and foraging run below this many food items, carried plus chests (default 12) |
| `food.retryMinutes` | 0–1440 | a failed food source is skipped this long (default 60) |
| `food.minSeeds` | 1–64 | seeds to start a field farm without grass near (default 8) |
| `sites.enabled` | on/off | [site health](./needs-and-idle#site-health): check the farm, bed, chests and home and mark bad ones (default on) |
| `sites.failures` | 1–20 | unreachable or no-work checks in a row before a site is bad (default 3) |
| `sites.checkMinutes` | 0.5–240 | one site checked at most this often (default 5) |
| `sites.recheckHours` | 0.1–720 | a bad site is looked at again after this long (default 6) |
| `sites.replace` | on/off | replace a bad site when it can (a new farm near home; default on) |
| `sites.tell` | on/off | whisper the owners when a site goes bad or is fine again (default on) |
| `projects.enabled` | on/off | [base projects](./base-projects): improve and extend the base on its own (default on) |
| `projects.policy` | auto / ask / off | auto builds, asking first for big projects; ask proposes every one; off only plans (default auto) |
| `projects.askAbove` | 0–100000 | auto: projects with more blocks than this need an owner's ok (default 150) |
| `projects.askTimeoutMinutes` | 1–10080 | how long to wait for an answer to a proposal (default 30) |
| `projects.onTimeout` | wait / build / skip | no answer in time: ask again later, go ahead or skip it (default wait) |
| `projects.paused` | on/off | no base work for now; planning still works (owners: "pax pause building") |
| `projects.sessionMinutes` | 1–60 | one work session at most (default 10) |
| `projects.night` | on/off | also work at night on projects inside finished, lit walls (default on) |
| `baseSafety.enabled` | on/off | [base safety](./base-safety): find caves, holes and mine entrances mobs can use under and by the base, and fix them (default on) |
| `baseSafety.margin` | 0–16 | blocks around the footprint checked too (default 4) |
| `baseSafety.depth` | 1–24 | blocks below the floor checked (default 8) |
| `baseSafety.fillMax` | 0–2000 | cavities up to this many blocks are filled in whole (default 48; 0 = never) |
| `baseSafety.sealMax` | 0–500 | at most this many openings of one cavity are sealed (default 24; 0 = never) |
| `baseSafety.capWith` | trapdoor / slab / block / light / none | what goes on a mine entrance by or in the base (default trapdoor) |
| `baseSafety.keepOutDepth` | 0–32 | stone and ore digging stays out of the ground under the base down to this depth (default 8; 0 = off) |
| `baseSafety.mineClearance` | 0–32 | a new staircase mine starts at least this far from the walls (default 4) |
| `baseSafety.minePlacement` | inside / outside / either | where a new mine may start: inside the walls under a hatch (default), outside them, or either (inside first) |
| `baseSafety.mineHatch` | on/off | a trapdoor hatch over an inside mine's stairs, opened for a trip and closed after (default on) |
| `baseSafety.mineKeepClear` | 0–8 | an inside mine starts at least this far from the gate (default 2) |
| `baseSafety.retireCloseMines` | on/off | an old mine just outside the walls is capped and retired (default on) |
| `baseSafety.useOutsideMines` | on/off | with minePlacement inside, trips still go down a known mine outside the walls instead of digging one inside (default off) |
| `baseSafety.floorHoles` | on/off | also fill holes in the floor surface inside the walls; dirt in a farm plot (default on) |
| `baseSafety.clearFixtures` | on/off | break a torch or flower standing in a hole it fills; off = leave such a spot alone (default on) |
| `materials.sources` | list of chests / substitutes / craft / nearby / mine / far | [where build and repair materials come from](./base-projects#where-materials-come-from), in this order; leave one out to turn it off (default all six in that order) |
| `materials.retryMinutes` | 0–1440 | a source that gave nothing of an item is skipped for it this long (default 30; 0 = always retry) |
| `materials.mineMinutes` | 1–60 | longest trip down its own mine for build blocks (default 6) |
| `materials.farDistance` | 8–160 | far: blocks past the base and its keep-out where it starts digging for stone (default 32) |
| `materials.farTries` | 1–8 | far: spots tried, nearest first (default 3) |
| `deathSpots.enabled` | on/off | keep out of the spot of a recent death (default on) |
| `deathSpots.minutes` | 0.5–240 | how long (default 10) |
| `deathSpots.stepCost` | 0–50 | extra path cost per block inside a death spot (default 8; 0 = paths ignore it) |
| `startOver.go` | on/off | start over once on its own when it starts (remembered: it doesn't fire again once done) ([start over](./start-over)) |
| `startOver.run` | text | with go: a run id; a new id starts one more start-over (from the current home) even after an earlier one finished, or redirects one under way |
| `startOver.minDistance` | 64–5000 | settle no closer than this to the old base, blocks (default 500) |
| `startOver.maxDistance` | 128–10000 | look no further than this from the old base before turning, blocks (default 1500; at least minDistance + 64) |
| `startOver.legLength` | 32–256 | walk this far per leg before looking again, blocks (default 96) |
| `startOver.legMinutes` | 0.5–30 | a leg taking longer than this counts as blocked and the next one takes a detour (default 4) |
| `startOver.blockedMoved` | 0–256 | a failed leg that moved fewer blocks than this counts as blocked (default 16) |
| `startOver.detours` | angles | detour angles tried either side of the heading when a leg is blocked or wet, in order (default 45, 90) |
| `startOver.direction` | n / ne / e / se / s / sw / w / nw / empty | which way to go; empty = away from spawn and the avoid points (default empty) |
| `startOver.dimensions` | names | dimensions a start-over may run in (default overworld) |
| `startOver.spawnRadius` | 0–5000 | keep this far from world spawn, blocks (default 300; 0 = spawn is not avoided) |
| `startOver.avoid` | list of { name, x, z, radius } | more places to keep away from, a list of { name, x, z, radius } (JSON live); entries without x and z are skipped |
| `startOver.avoidRadius` | 0–10000 | radius of an avoid point that gives none, blocks (default 400) |
| `startOver.take` | names | packed first whatever the value table says (comma separated; prefix* and *suffix work) |
| `startOver.leave` | names | never packed (comma separated; prefix* and *suffix work) |
| `startOver.freeSlots` | 0–20 | inventory slots left free after packing (default 2) |
| `startOver.packRadius` | 8–128 | chests within this many blocks of home are packed from (default 48) |
| `startOver.roomAbove` | 0–36 | with more used inventory slots than this, it first puts what isn't worth packing into the old chests (default 24) |
| `startOver.stash` | names | pack value kinds put into the new chest when it settles: treasure, metal, ore, ammo, seeds, light, fuel, material, wood, stone, block, gear, food (default treasure, metal, ore) |
| `startOver.minGrass` | 0–1000 | grass blocks within lookRadius a new place needs (default 24) |
| `startOver.minLogs` | 0–1000 | tree logs within lookRadius a new place needs (default 8) |
| `startOver.minWater` | 0–100 | open water sources within waterRadius that don't freeze (and ice with iceAsWater) a new place needs (default 1) |
| `startOver.minAnimals` | 0–100 | passive animals within animalRadius a new place needs (default 2) |
| `startOver.maxBuildBlocks` | 0–1000 | blocks of somebody's build nearby that rule a place out (default 6) |
| `startOver.badBiomes` | names | biomes a new place must not be in (names, prefix* and *suffix; default snowy_*, frozen_*, ice_spikes, grove, jagged_peaks; empty = any biome) |
| `startOver.badCold` | on/off | a place where water freezes counts as a bad biome too (default on) |
| `startOver.iceAsWater` | on/off | surface ice counts as water for a new place (default off) |
| `startOver.lookRadius` | 8–96 | grass, logs and builds are counted within this many blocks (default 32) |
| `startOver.waterRadius` | 8–128 | water is counted within this many blocks (default 64) |
| `startOver.animalRadius` | 8–128 | animals are counted within this many blocks (default 64) |
| `startOver.treeDepth` | 0–64 | logs more than this many blocks under the surface (caves, mineshafts) don't count as trees (default 12) |
| `startOver.weights.grass` | 0–100 | site score per grass block (default 0.25) |
| `startOver.weights.logs` | 0–100 | site score per log (default 1) |
| `startOver.weights.water` | 0–100 | site score per water source (default 3) |
| `startOver.weights.animals` | 0–100 | site score per animal (default 4) |
| `startOver.weights.badBiome` | 0–10000 | site score taken off in a bad biome (default 100) |
| `startOver.weights.build` | 0–1000 | site score taken off per build block over maxBuildBlocks (default 10) |
| `startOver.caps.grass` | 1–1000 | grass blocks counted at most, for the score (default 200) |
| `startOver.caps.logs` | 1–1000 | logs counted at most, for the score (default 60) |
| `startOver.caps.water` | 1–100 | water sources counted at most, for the score (default 10) |
| `startOver.caps.animals` | 1–100 | animals counted at most, for the score (default 10) |
| `startOver.fallback.grass` | 0–1000 | grass a place needs to be the fallback once the range is used up (default 8) |
| `startOver.fallback.logs` | 0–1000 | logs a place needs to be the fallback once the range is used up (default 4) |
| `startOver.turnAfterRejects` | 0–20 | places looked at and rejected in a row (for any reason) after which it turns (0 = never; default 3) |
| `startOver.maxTurns` | 0–7 | turns of 90 degrees after the range runs out, an ocean, or rejects in a row, before making do (default 2) |
| `startOver.duskSeconds` | 0–600 | stop walking this long before dark and dig in once night falls (default 30) |
| `startOver.leaveDaylightSeconds` | 0–1200 | pack and leave only with at least this much daylight left; else wait at home for the morning (default 120) |
| `startOver.shelterTries` | 0–20 | failed bunkers in a night before it waits for the morning where it stands (default 3) |
| `startOver.shelterStep` | 0–128 | blocks it walks on along the heading after a failed bunker (default 12) |
| `startOver.protectedStep` | 0–256 | blocks it walks on after a bunker refused on protected ground; those don't count as tries (default 24) |
| `startOver.shelterMinutes` | 1–60 | longest a night bunker is kept (default 15) |
| `startOver.settleTries` | 0–50 | failed walks to a far settle target before it settles where it stands (default 5) |
| `startOver.settleNear` | 0–512 | a settle target closer than this counts as reached when the walk fails, blocks (default 64) |
| `startOver.oldBaseRadius` | 16–4096 | places, containers, pinned chests and beds within this many blocks of the old base belong to it (default 256) |
| `startOver.dropPlaces` | names | more place names dropped on leaving wherever they are (prefix* and *suffix; modules add their own base places) |
| `startOver.dropKeys` | names | more storage keys dropped on leaving (modules add their own base-anchored keys) |
| `respawn.enabled` | on/off | respawn by itself when dead, also when it logs in dead (default on) |
| `respawn.retrySeconds` | 1–120 | ask to respawn again this often while still dead (default 5) |
| `respawn.maxTries` | 1–50 | reconnect after this many asks without coming back (default 6) |
| `humanize.enabled` | on/off | player-like reaction and typing delays |
| `humanize.typoRate` | 0–1 | chance of a typo per message |
| `humanize.lowercase` | on/off | write chat in lower case |
| `humanize.pauseWhileTyping` | on/off | stand still while typing |
| `humanize.idleFidget` | on/off | look around when idle |
| `llm.listen` | mention / conversation / all | how it follows chat |
| `llm.immersive` | on/off | stay in character (reports stay truthful) |
| `llm.conversationMs` | ms | how long follow-ups don't need its name |
| `llm.aliases` | list | other names it answers to (`pax,p`) |
| `llm.budget.turnsPerHour` / `tokensPerHour` / `tokensPerDay` | number | LLM budgets |
| `llm.budget.maxToolCalls` | number | tool calls per turn |
| `llm.goals.maxTurns` / `timeoutMin` | number | how long goals run on their own |
| `llm.goals.ownerWaitMin` | minutes | after asking the owner, go on alone if no answer (0 = wait forever; default 15) |
| `intents.mode` | fallback / first / off | [plain-language commands](/guide/intents) without the LLM: only while it's down, simple requests always, or never (see [plain-language commands](./intents)) |
| `intents.strategy` | first_confident / vote / best | how the [intent layers](./intents#layer-pipeline) pick a winner: the first one above its threshold, the intent most confident layers agree on, or the highest confidence |
| `intents.log_decisions` | on/off | one debug line per message with each layer's guess, confidence and time |
| `intents.layers.patterns.enabled` / `.threshold` | on/off, 0–1 | the pattern parser layer (default on, 0.7) |
| `intents.layers.embeddings.enabled` / `.threshold` | on/off, 0–1 | the local embedding model layer (default 0.62); switching it on adds it after patterns on a bot without layer config; a threshold change keeps the loaded model |
| `intents.layers.local_llm.enabled` / `.threshold` | on/off, 0–1 | the local LLM layer (needs `url` and `model` in the profile; default 0.7) |
| `intents.layers.cloud_llm.enabled` | on/off | hand lines no layer understood to the [LLM brain](/guide/llm-brain) (off: they're dropped in mode `first`) |
| `pathfinder.thinkTimeoutMs` | 1000–60000 | how long the pathfinder may plan one path (default 10000); raise on a loaded machine, see [tool progression](./progression#speed) |
| `pathfinder.sprintAbove` | 0–20 | walks only sprint when food is above this; sprinting burns food about ten times faster (default 12; 0 = always sprint) |
| `building` | library / creative / ask | reuse a saved [blueprint](/guide/goals-and-building#blueprint-format), design a new one, or let the owner pick (see [Blueprint libraries](./blueprints#building-policy)) |
| `build.creativeMethod` | auto / hand / commands | how a creative bot builds: hand = block by block like a player (auto means hand), commands = `/fill` and `/setblock` when it is op (each command shows to other ops as an admin message); survival always builds by hand (see [creative builds](./goals-and-building#creative-mode)) |
| `build.handDelayMs` | 0–5000 | pause after each block in a creative hand build (default 150, jittered ±50) |
| `world.viewDistance` | tiny / short / normal / far, 2–32 | chunks around the bot the client asks for (default far, 12; the server caps it at its own view-distance); fewer = less memory, but trees, food and mobs further out are not seen (see [memory](./deployment#memory)) |
| `world.spawnProtection` | 0–256 | the server's spawn-protection radius (default 16): crafting tables and furnaces go outside it (see [tool progression](./progression#where-the-crafting-table-and-furnace-go)) |
| `road.width` | 1–5 | lanes of a new [road](./roads.md) (even widths round up; default 3) |
| `road.palette` | stone_bricks / cobblestone / stone / oak / spruce | what roads are made of (default stone_bricks: stone brick floor and stairs, cobblestone base, stone brick wall railings) |
| `road.maxCut` / `road.maxFill` | 0–16 / 0–24 | deepest cut into the ground and highest fill above it for any lane (default 6 / 6) |
| `road.lanterns` | on/off | lanterns on posts at road landings (default off) |
| `worldedit.enabled` | on/off | WorldEdit actions: on = the server has it (no detection), off = never; reset = detect (see [WorldEdit](./worldedit.md)) |
| `worldedit.maxBlocks` | number | largest region a WorldEdit action may change (default 50000) |
| `retry.actions.<action>` | 0–10 | extra attempts after a failed action |

In a profile, the `reflexes.*` values go under `reflexes:`, the `askHelp.*` values under the
top-level `askHelp:` key, the `status.*` values under the top-level `status:` key (or `settings.status`), the `needs.*`, `idle.*` and `sites.*` values under the top-level `needs:`, `idle:` and `sites:` keys, and the `combat.*`, `mining.*`, `trips.*` and `inventoryMemory.*`
values under `settings:` (`settings: { combat: { pvp: defend } }`). A top-level `combat:` key
is ignored with a warning, and so is any key under `settings.combat`, `settings.mining`,
`settings.trips` or `settings.inventoryMemory` that is not in the table above (see
[Profiles](./profiles#format)). An `askHelp:` map turns asking for help on only with
`enabled: true` (setting `askHelp.failures` and the like live doesn't turn it on either), and `inventoryMemory: true` is short for `{ enabled: true }`. See
[Reflexes](/concepts/world#reflexes). The techniques behind the `combat.*` toggles are described
in [Movement, protection and combat](/concepts/world#skilled-player-techniques).

Behaviours have their own live commands: `!behavior_arm`, `!behavior_configure`,
`!behavior_disarm` (see [Behaviours](./behaviors)), e.g. `!behavior_configure chop_wood_loop`
with `rings` to change how far it looks for trees, or `!behavior_configure keep_spawn_bed graceSeconds=20 ask=false` to
change how long it lies in bed at night and whether it asks the others to sleep
([respawn point](./behaviors#respawn-point-keep-spawn-bed)), or `!behavior_configure light_home target=4 maxTorches=24`
to change how bright it keeps home and its farms and how many torches it puts down a run
([spawn-proofing](./behaviors#spawn-proofing-light-home)).
`!behavior_configure recover_drops maxDistance=200 giveUpHealth=10` changes how far it goes
back for its things after a death and when it turns back, `!behavior_disarm recover_drops`
turns it off ([death drops](./behaviors#death-drops-recover-drops)).

## How it works

```mermaid
flowchart TD
  P(["owner: !config_set<br/>llm.listen all"]) --> V{"known toggle?<br/>valid value?"}
  V -- no --> E(["error: what's allowed"])
  V -- yes --> S[("agent.storage<br/>settings.overrides")]
  S --> M["effective settings =<br/>profile ⊕ overrides"]
  M --> R["reflexes read it<br/>on every event"]
  M --> L["LLM brain:<br/>applySettings()"]
  M --> H["humanize, retry,<br/>canDig recomputed"]
  classDef a fill:#e0f2fe,stroke:#0284c7,color:#0c4a6e
  classDef d fill:#fef3c7,stroke:#d97706,color:#78350f
  classDef g fill:#dcfce7,stroke:#16a34a,color:#14532d
  classDef r fill:#fee2e2,stroke:#dc2626,color:#7f1d1d
  class P a
  class V d
  class S,M,R,L,H g
  class E r
```

From code: `agent.setToggle(key, value)`, `agent.resetToggle(key?)`, `agent.listToggles()`, and the
`settingsChanged` event. Add new toggles in `src/core/toggles.ts` (a key, a description, a zod
schema) and make the consumer read `agent.settings` when it acts, not once at startup.
