// Feature toggles: settings an owner can change in game, live, without a restart.
//   !config_list            what can be changed, current values
//   !config_set llm.listen all
//   !config_reset llm.listen    (or no key: everything back to the profile)
// Overrides are stored in agent.storage (settings.overrides) and win over the profile until reset.
import { z } from 'zod'

export interface ToggleDef {
  /** Dotted settings path; a trailing ".*" accepts any key at that level (e.g. retry.actions.*). */
  key: string
  description: string
  schema: z.ZodType
}

const bool = z.boolean()
const health = z.number().min(0).max(20)
const unit = z.number().min(0).max(1)

export const TOGGLES: ToggleDef[] = [
  { key: 'selfAware', description: 'show the bot its own variant, profile, model and settings every turn (observe: self)', schema: bool },
  { key: 'respectBuilds', description: 'leave blocks that look player-made alone when building and gathering (off = use anything)', schema: bool },
  { key: 'canDig', description: 'may break blocks (and tunnel when pathing)', schema: bool },
  { key: 'reflexes.selfDefense', description: 'fight back when hit', schema: bool },
  { key: 'reflexes.autoEat', description: 'eat when hungry', schema: bool },
  { key: 'reflexes.eatBelow', description: 'eat when food drops below this', schema: health },
  { key: 'reflexes.retreatBelow', description: 'back off at or below this health (0 = stand ground)', schema: health },
  { key: 'reflexes.waterFightAbove', description: "don't fight mobs in water below this health (0 = always fight)", schema: health },
  { key: 'reflexes.rangedDefense', description: 'react to mobs shooting at it: shoot back, shield, cover or back off', schema: bool },
  { key: 'reflexes.air', description: 'when drowning, stop and get air: swim up, break ice or a roof above, or swim to an opening', schema: bool },
  { key: 'reflexes.airBelow', description: 'go for air at or below this much air (of 20; earlier at low health)', schema: health },
  { key: 'combat.adaptiveWeapon', description: 'pick the best weapon per target (damage, enchantments, finishers, axes vs shields)', schema: bool },
  { key: 'combat.ranged', description: 'use bow/crossbow for flyers and out-of-reach targets when it has arrows', schema: bool },
  { key: 'combat.shield', description: 'raise a shield against ranged mobs between swings', schema: bool },
  { key: 'combat.crits', description: 'jump and hit while falling for critical hits (x1.5); sprint into the first hit for knockback', schema: bool },
  { key: 'combat.strafe', description: 'keep spacing and circle melee mobs between swings, step back after a hit', schema: bool },
  { key: 'combat.disengageToHeal', description: 'leave a losing fight (retreat.*; with retreat.enabled off: at 4 health or less with food, back off briefly to eat), then fight on (works with retreatBelow 0)', schema: bool },
  { key: 'combat.autoArmor', description: 'wear the best armour in the inventory and keep a shield or totem in the offhand', schema: bool },
  { key: 'combat.maxChase', description: 'stop chasing a mob this many blocks from where the fight started', schema: z.number().min(2).max(64) },
  { key: 'combat.sprintReset', description: 'W-tap: let go of sprint after a hit and sprint into the next one for knockback when a crit is not possible or knockback is worth more', schema: bool },
  { key: 'combat.sweep', description: 'with a sword, plain ground hits (no jump) when mobs bunch around the target, so the sweep hits them all', schema: bool },
  { key: 'combat.shieldMelee', description: 'raise the shield against melee mobs between slow swings, and against a lit creeper it cannot outrun (an axe hit is blocked, then the shield is down 5 s)', schema: bool },
  { key: 'combat.totem', description: 'move a totem of undying into the offhand at 8 health or less, or in a fall that could kill', schema: bool },
  { key: 'combat.goldenApple', description: 'eat a golden apple mid-fight at 8 health or less (12 when surrounded) instead of waiting for a lull', schema: bool },
  { key: 'combat.waterClutch', description: 'water bucket against fall damage (placed just before landing, then scooped up) and to put out fire', schema: bool },
  { key: 'combat.endermanGaze', description: 'never look an enderman in the eyes unless fighting it', schema: bool },
  { key: 'combat.fightFastMobs', description: 'at low health keep fighting mobs faster than the bot (vindicators, spiders, ravagers, wolves) instead of backing off and getting hit from behind', schema: bool },
  { key: 'combat.chokepoints', description: 'against 3+ melee mobs with health to spare, fight from a nearby 1-wide gap so they come one at a time', schema: bool },
  { key: 'combat.phantoms.enabled', description: 'phantoms: to bed when they are about or it has not been in a bed for a while (they do not stop sleep and a bed resets their timer), else fight them before the dive (off = only fight back after a hit)', schema: bool },
  { key: 'combat.phantoms.sleep', description: 'go to bed against phantoms and the timer that spawns them (default on)', schema: bool },
  { key: 'combat.phantoms.insomniaMinutes', description: 'real minutes without a bed or a death after which it goes to bed at night anyway; phantoms come after 3 in-game days, 60 min (default 30)', schema: z.number().min(0).max(1440) },
  { key: 'combat.phantoms.bedRange', description: 'use a bed this close (default 16)', schema: z.number().min(1).max(64) },
  { key: 'combat.phantoms.engageRange', description: 'start fighting a phantom this close instead of waiting for its hit, 0 = only fight back (default 16)', schema: z.number().min(0).max(48) },
  { key: 'combat.phantoms.groundClear', description: 'no bed with a ground mob this close (default 8)', schema: z.number().min(0).max(32) },
  { key: 'combat.phantoms.retrySeconds', description: 'after a refused bed, wait this long before trying again (default 60)', schema: z.number().min(0).max(3600) },
  { key: 'combat.phantoms.recentMinutes', description: 'a bed this recent already reset the timer: with phantoms about it fights them instead of going to bed again (default 5)', schema: z.number().min(0).max(120) },
  { key: 'combat.dodge.enabled', description: 'dodge layer in mob fights: leaps away from shots and swings, sprint-jumps away from lit creepers (off = none of combat.dodge.*)', schema: bool },
  { key: 'combat.dodge.draws', description: 'leap sideways just before a close skeleton lets go of its drawn bow, and while a pillager holds a charged crossbow', schema: bool },
  { key: 'combat.dodge.arrows', description: 'leap out of the path of an arrow or other projectile in flight that would hit (ballistic check against the hitbox)', schema: bool },
  { key: 'combat.dodge.meleeTiming', description: "track each melee mob's attack cooldown: stand in and hit while it recharges, be out of its reach before its next swing", schema: bool },
  { key: 'combat.dodge.creeperLeap', description: 'sprint-jump away from a lit creeper instead of walking (default off: in the bench it cost kills without saving health)', schema: bool },
  { key: 'combat.dodge.latencyMs', description: 'round trip to the server the dodges allow for, ms (default 75)', schema: z.number().min(0).max(500) },
  { key: 'combat.dodge.drawRange', description: 'react to the bow draw within this many blocks, to the arrow beyond it (default 10)', schema: z.number().min(0).max(32) },
  { key: 'combat.dodge.arrowMargin', description: 'extra room around the hitbox when judging whether a projectile hits, blocks (default 0.15)', schema: unit },
  { key: 'combat.dodge.leapMs', description: 'how long a leap faces away before snapping back to the target, ms (default 200)', schema: z.number().min(50).max(600) },
  { key: 'combat.dodge.leapDistance', description: 'how far along a leap the ground is checked, blocks (default 2.5)', schema: z.number().min(1).max(5) },
  { key: 'combat.dodge.maxDrop', description: 'deepest drop a leap may land in, blocks (default 2)', schema: z.number().int().min(0).max(4) },
  { key: 'combat.dodge.meleeMargin', description: "blocks beyond a melee mob's reach to be at when its swing is ready (default 0.35)", schema: z.number().min(0).max(2) },
  { key: 'combat.dodge.meleeLeadMs', description: "be out of reach this long before a melee mob's next swing, ms, on top of latencyMs (default 150)", schema: z.number().min(0).max(1000) },
  { key: 'combat.dodge.meleeCooldownMs', description: 'attack cooldown assumed for melee mobs not in the table, ms (default 1000, 20 ticks)', schema: z.number().min(250).max(3000) },
  { key: 'combat.dodge.creeperLeapMs', description: 'longest the creeper leap keeps sprint-jumping away, ms; it stops once the fuse is out or the creeper is 7.2 blocks off (default 1500)', schema: z.number().min(0).max(3000) },
  { key: 'combat.dodge.minGapMs', description: 'shortest gap between two leaps, ms (default 300)', schema: z.number().min(0).max(2000) },
  { key: 'combat.pvp', description: 'off (never fight players) | defend (fight back a player who attacks the bot or the player it guards) | revenge (defend, and go after whoever killed or attacked the bot, an owner or the guarded player) | targets (attack the players on combat.targets, and grudges) | all (attack every player in range); never owners, friends or creative players', schema: z.enum(['off', 'defend', 'revenge', 'targets', 'all']) },
  { key: 'combat.friends', description: 'players never fought in any PvP mode (comma separated; owners are always spared)', schema: z.array(z.string().min(1)) },
  { key: 'combat.targets', description: 'players attacked on sight with combat.pvp targets or all (comma separated; owners and friends are ignored)', schema: z.array(z.string().min(1)) },
  { key: 'combat.revengeMinutes', description: 'how long a grudge lasts with combat.pvp revenge/targets/all (minutes, default 30; 0 = no grudges)', schema: z.number().min(0).max(1440) },
  { key: 'combat.revengeKills', description: 'a grudge is forgiven after killing the player this many times (default 1)', schema: z.number().int().min(1).max(100) },
  { key: 'combat.revengeIgnoresOdds', description: 'revenge fights start even when the gear check says the bot would lose (default off)', schema: bool },
  { key: 'combat.spareProtected', description: 'leave players inside protected areas (spawn protection, claims) alone in the attacking PvP modes (default on)', schema: bool },
  { key: 'combat.taunts', description: 'say a short public line after winning a PvP fight (default off; mode changes are whispered to owners only)', schema: bool },
  { key: 'combat.pvpEngage', description: 'start PvP fights with players within this many blocks (default 16)', schema: z.number().min(2).max(64) },
  { key: 'combat.pvpChase', description: 'give up a PvP chase this many blocks from where the fight started (default 48)', schema: z.number().min(4).max(256) },
  { key: 'combat.pvpLostSec', description: 'give up a PvP fight after this many seconds without seeing the player (default 30)', schema: z.number().min(1).max(600) },
  { key: 'combat.pvpMinOdds', description: 'gear check: the odds (their time to kill the bot over its time to kill them) needed to start a targets/all fight (default 0.7)', schema: z.number().min(0).max(10) },
  { key: 'combat.pvpTactics', description: 'PvP technique against players: axe vs raised shields, shield timing, spacing and circling, bow at range, totem and golden apples, ledge awareness (off = the mob fight loop)', schema: bool },
  { key: 'combat.huntMinutes', description: 'a hunt (hunt_player) gives up after this many minutes (default 10)', schema: z.number().min(1).max(120) },
  { key: 'retreat.enabled', description: 'risk-based retreat: leave a fight when health would not survive the next few hits, by an escape route (off = the old rule: back off to eat at 4 health)', schema: bool },
  { key: 'retreat.hits', description: 'leave when health would not survive what every threat in reach lands in this many attack cycles of 1 s (default 2)', schema: z.number().min(0.5).max(10) },
  { key: 'retreat.floor', description: 'always leave a fight at or below this health (default 4; 0 = no floor)', schema: health },
  { key: 'retreat.hysteresis', description: 'once leaving, keep leaving until health is this much above the estimate (default 4)', schema: health },
  { key: 'retreat.shieldBlocks', description: 'share of hits a shield in the offhand is expected to block, for the estimate (default 0.4)', schema: unit },
  { key: 'retreat.returnAbove', description: 'after escaping, come back to the fight at this health or more (default 16)', schema: z.number().min(1).max(20) },
  { key: 'retreat.healSeconds', description: 'longest wait to heal after escaping, seconds (default 60)', schema: z.number().min(0).max(600) },
  { key: 'retreat.comeBack', description: 'after healing, fight the mobs still around (at home after going home, where it left otherwise; default on)', schema: bool },
  { key: 'retreat.maxEscapes', description: 'escapes per defend run before it fights where it stands (default 2)', schema: z.number().int().min(0).max(10) },
  { key: 'retreat.routes', description: 'escape routes in the order tried: home, pillar, sprint, bunker (default in that order; comma separated; leave one out to turn it off)', schema: z.array(z.enum(['home', 'pillar', 'bunker', 'sprint'])) },
  { key: 'retreat.homeRadius', description: 'escape home only when home is this close, blocks (default 40)', schema: z.number().min(0).max(256) },
  { key: 'retreat.closeDoors', description: 'shut open wooden doors next to it after escaping home (default on)', schema: bool },
  { key: 'retreat.pillarHeight', description: 'blocks to pillar up when escaping melee mobs (default 2; never against archers, spiders or endermen)', schema: z.number().int().min(1).max(4) },
  { key: 'retreat.sprintDistance', description: 'how far to sprint away when that is the escape, blocks (default 24)', schema: z.number().min(6).max(48) },
  { key: 'retreat.avoidOpen', description: 'poorly placed for a fight (see retreat.avoidFactors): go home or to a chokepoint instead of fighting in the open, unless an owner is in trouble (default on)', schema: bool },
  { key: 'retreat.avoidFactors', description: 'how many of no armour, night and outnumbered make it avoid an open fight (default 2; 3 = only all three)', schema: z.number().int().min(1).max(3) },
  { key: 'retreat.minArmour', description: 'armour points below this count as no armour for retreat.avoidOpen (default 1)', schema: z.number().min(0).max(20) },
  { key: 'retreat.outnumberedAt', description: 'this many melee mobs within 8 blocks count as outnumbered for retreat.avoidOpen (default 2)', schema: z.number().int().min(2).max(10) },
  { key: 'retreat.avoidRoutes', description: 'where to go instead of an open fight, in order: home, chokepoint (comma separated)', schema: z.array(z.enum(['home', 'chokepoint'])) },
  { key: 'mining.safe', description: 'safe mining: needs weapon, food (and gear, see mining.gear) to dig or walk deeper than mining.safeDepth, avoids breaking into caves, lights tunnels, climbs out when losing underground', schema: bool },
  { key: 'mining.safeDepth', description: 'blocks below the surface it may dig or go for ore without being ready (default 8)', schema: z.number().int().min(0).max(64) },
  { key: 'mining.needWeapon', description: 'a sword or axe is needed to mine deeper than mining.safeDepth', schema: bool },
  { key: 'mining.minFood', description: 'food items needed to mine deeper than mining.safeDepth (default 3)', schema: z.number().int().min(0).max(64) },
  { key: 'mining.gear', description: 'gear needed to mine deeper than mining.safeDepth: none | shield_or_armour | armour (with shield_or_armour the first iron ingot becomes a shield)', schema: z.enum(['none', 'shield_or_armour', 'armour']) },
  { key: 'mining.minArmour', description: 'armour points worn that count as armour for mining.gear (default 1)', schema: z.number().int().min(0).max(20) },
  { key: 'mining.retreatBelow', description: 'underground: abandon the dig and climb out at or below this health (0 = never; separate from reflexes.retreatBelow)', schema: health },
  { key: 'mining.retreatHostiles', description: 'underground: abandon the dig and climb out when this many hostiles are close (0 = never)', schema: z.number().int().min(0).max(20) },
  { key: 'mining.hostileRadius', description: 'underground: how close a hostile counts for mining.retreatHostiles, in blocks (default 8)', schema: z.number().int().min(2).max(32) },
  { key: 'mining.surfaceHostiles', description: 'underground: hostiles standing under open sky (the surface above the mine) count for mining.retreatHostiles too (default off; one within mining.hostileClose counts either way)', schema: bool },
  { key: 'mining.hostileClose', description: 'underground: a hostile this close counts for mining.retreatHostiles wherever it stands, in blocks (default 4)', schema: z.number().int().min(0).max(32) },
  { key: 'mining.torches', description: 'light tunnels with torches, crafted from coal or charcoal and sticks when it has none', schema: bool },
  { key: 'mining.torchEvery', description: 'a torch every this many tunnel steps (default 8)', schema: z.number().int().min(1).max(64) },
  { key: 'mining.firstTorchAt', description: 'in a mine with no torch yet, the first one goes after this many steps (default 4, 0 = at torchEvery)', schema: z.number().int().min(0).max(64) },
  { key: 'mine.enabled', description: 'dig a staircase mine near home when the gear need finds no iron ore with an open face (default on)', schema: bool },
  { key: 'mine.depthY', description: 'the mine stairs go down to this y (default 16: iron depth in 1.21; deepslate below 0)', schema: z.number().int().min(-58).max(120) },
  { key: 'mine.radius', description: 'the mine entrance is within this many blocks of home (default 32)', schema: z.number().int().min(4).max(128) },
  { key: 'mine.minFromHome', description: '...and at least this far from home, out of the base (default 8)', schema: z.number().int().min(0).max(64) },
  { key: 'mine.minutes', description: 'one trip down the mine lasts at most this long (default 15)', schema: z.number().min(1).max(60) },
  { key: 'mine.branchLength', description: 'side branches off the main tunnel are this long (default 12)', schema: z.number().int().min(1).max(64) },
  { key: 'mine.branchSpacing', description: 'solid blocks between two branches (default 3)', schema: z.number().int().min(1).max(16) },
  { key: 'mine.maxBranches', description: 'branch pairs per trip at most (default 6)', schema: z.number().int().min(0).max(64) },
  { key: 'mine.minFreeSlots', description: 'head back up with fewer free inventory slots than this, after dropping junk (default 3)', schema: z.number().int().min(1).max(30) },
  { key: 'mine.cooldownMinutes', description: 'minutes between two trips down the mine (default 20)', schema: z.number().min(0).max(1440) },
  { key: 'mine.atNight', description: 'go down a lit mine at night too (default on)', schema: bool },
  { key: 'mine.startAtNight', description: 'at night, with no mine yet, start one near home when it has torches or can make them (default on)', schema: bool },
  { key: 'mine.relight', description: 'on the walk down a known mine, put torches on its dark stairs (mining.torchEvery apart) so an unlit mine gets lit (default on)', schema: bool },
  { key: 'mine.gear', description: 'gear needed to go down its own mine: none | shield_or_armour | armour (default none; mining.gear is for caves)', schema: z.enum(['none', 'shield_or_armour', 'armour']) },
  { key: 'mine.minHealth', description: 'health needed to go down the mine (default 14)', schema: health },
  { key: 'mine.keepCobble', description: 'cobblestone kept on a mine trip; more is dropped at the end of a branch (default 64)', schema: z.number().int().min(0).max(2304) },
  { key: 'mine.ores', description: 'ores mined in the walls: iron, coal, copper, diamond, gold, redstone, lapis, emerald (comma separated; default iron, coal, copper, diamond)', schema: z.array(z.enum(['iron', 'coal', 'copper', 'diamond', 'gold', 'redstone', 'lapis', 'emerald'])) },
  { key: 'askHelp.enabled', description: 'when a behaviour keeps failing the same way, tell the owners once what it was trying, why it fails and what would help', schema: bool },
  { key: 'askHelp.failures', description: 'failures of the same kind before it asks for help (default 3)', schema: z.number().int().min(1).max(100) },
  { key: 'askHelp.minutes', description: '...spread over at least this many minutes (default 10)', schema: z.number().min(0).max(1440) },
  { key: 'askHelp.maxPerHour', description: 'help messages per hour at most, over all behaviours (default 3)', schema: z.number().int().min(0).max(60) },
  { key: 'askHelp.tell', description: 'who hears it: owners (whisper the owners online) | say (public chat)', schema: z.enum(['owners', 'say']) },
  { key: 'askHelp.thanks', description: 'say "sorted, thanks" once when something it asked about works again', schema: bool },
  { key: 'askHelp.llm', description: 'let the LLM brain know when it asked for help (no extra turn unless llm triggers.events.stuck)', schema: bool },
  { key: 'status.file', description: 'write data/bots/<name>/status.json every status.intervalMs, for `node src/cli.ts status <name>` (default on)', schema: bool },
  { key: 'status.intervalMs', description: 'how often the status is sampled (progress, stuck check) and the file rewritten, in ms (default 5000)', schema: z.number().int().min(1000).max(600_000) },
  { key: 'status.alert', description: 'whisper the online owners once when the bot is stuck (wants to do something, no progress for status.stuckAlertMs), then with back-off (default on)', schema: bool },
  { key: 'status.stuckAlertMs', description: 'no progress (an action done, items gained, 16+ blocks moved) for this long counts as stuck, in ms (default 600000 = 10 min)', schema: z.number().int().min(60_000).max(86_400_000) },
  { key: 'status.alertMaxMs', description: 'repeat stuck alerts double their gap up to this, in ms (default 7200000 = 2 h)', schema: z.number().int().min(60_000).max(7 * 86_400_000) },
  { key: 'humanize.enabled', description: 'player-like reaction/typing delays', schema: bool },
  { key: 'humanize.typoRate', description: 'chance of a typo per message (0-1)', schema: z.number().min(0).max(1) },
  { key: 'humanize.lowercase', description: 'write chat in lower case', schema: bool },
  { key: 'humanize.pauseWhileTyping', description: 'stand still while typing', schema: bool },
  { key: 'humanize.idleFidget', description: 'look around when idle', schema: bool },
  { key: 'llm.listen', description: 'mention | conversation | all', schema: z.enum(['mention', 'conversation', 'all']) },
  { key: 'llm.immersive', description: 'stay in character (reports stay truthful)', schema: bool },
  { key: 'llm.conversationMs', description: 'follow-ups without the name count for this long (ms)', schema: z.number().int().min(0).max(3_600_000) },
  { key: 'llm.aliases', description: 'other names it answers to (comma separated)', schema: z.array(z.string().min(1)) },
  { key: 'llm.budget.turnsPerHour', description: 'LLM turns per hour', schema: z.number().int().min(0) },
  { key: 'llm.budget.tokensPerHour', description: 'LLM tokens per hour', schema: z.number().int().min(0) },
  { key: 'llm.budget.tokensPerDay', description: 'LLM tokens per day (0 = no limit)', schema: z.number().int().min(0) },
  { key: 'llm.budget.maxToolCalls', description: 'tool calls per turn', schema: z.number().int().min(1).max(100) },
  { key: 'llm.goals.maxTurns', description: 'goal turns on its own before checking back', schema: z.number().int().min(1).max(500) },
  { key: 'llm.goals.timeoutMin', description: 'goal minutes on its own before checking back', schema: z.number().min(1).max(1440) },
  { key: 'llm.goals.ownerWaitMin', description: 'minutes to wait for an owner answer before going on alone (0 = forever)', schema: z.number().min(0).max(1440) },
  { key: 'intents.mode', description: 'plain-language commands without the LLM: fallback (only while the LLM is down) | first (simple requests itself, the rest to the LLM) | off', schema: z.enum(['fallback', 'first', 'off']) },
  { key: 'intents.strategy', description: 'how the intent layers decide: first_confident (first layer above its threshold) | vote (most confident layers agree) | best (highest confidence)', schema: z.enum(['first_confident', 'vote', 'best']) },
  { key: 'intents.log_decisions', description: "log each intent layer's guess, confidence and time per message (debug level)", schema: bool },
  { key: 'intents.layers.patterns.enabled', description: 'intents: the pattern parser layer', schema: bool },
  { key: 'intents.layers.patterns.threshold', description: 'intents: confidence the pattern parser needs (default 0.7)', schema: unit },
  { key: 'intents.layers.embeddings.enabled', description: 'intents: the local sentence-embedding layer (nearest example phrasings)', schema: bool },
  { key: 'intents.layers.embeddings.threshold', description: 'intents: similarity the embeddings layer needs (default 0.62)', schema: unit },
  { key: 'intents.layers.local_llm.enabled', description: 'intents: the local LLM layer (OpenAI-compatible endpoint; needs url and model in the profile)', schema: bool },
  { key: 'intents.layers.local_llm.threshold', description: 'intents: confidence the local LLM layer needs (default 0.7)', schema: unit },
  { key: 'intents.layers.cloud_llm.enabled', description: 'intents: hand lines no layer understood to the LLM brain (off = drop them in mode first)', schema: bool },
  { key: 'trips.enabled', description: 'trips that behaviours start (food scouting, far trees, sheep, ore): top up food from own chests, hold a weapon, check health before leaving, and turn back when food or daylight runs short', schema: bool },
  { key: 'trips.food', description: 'food items to top up to from the pantry (own and configured chests near home) before a trip (default 8)', schema: z.number().int().min(0).max(64) },
  { key: 'trips.minFood', description: 'fewest food items to leave on a trip with; food trips are exempt (default 4)', schema: z.number().int().min(0).max(64) },
  { key: 'trips.needWeapon', description: 'a sword or axe is needed to leave on a trip (default on)', schema: bool },
  { key: 'trips.minHealth', description: 'health needed to leave on a trip (default 12)', schema: health },
  { key: 'trips.foodMinHealth', description: 'a food trip leaves with this much health when food is under 18, since health does not come back by waiting then (default 6)', schema: health },
  { key: 'trips.turnBackAt', description: 'turn back when the food left (bar + carried) drops to this share of what it left with (default 0.5)', schema: unit },
  { key: 'trips.foodFloor', description: 'turn back when the food bar is at or below this with nothing to eat (default 6, 0 = off)', schema: health },
  { key: 'trips.daylightMarginS', description: 'turn back when the daylight left is the walk home plus this many seconds (default 60)', schema: z.number().int().min(0).max(600) },
  { key: 'trips.speed', description: 'walking speed for the way home in blocks per second (default 3)', schema: z.number().min(0.5).max(10) },
  { key: 'trips.minDistance', description: 'trips shorter than this many blocks need no preparation (default 64)', schema: z.number().int().min(0).max(1024) },
  { key: 'trips.ownerOrders', description: 'also prepare and budget trips the owner ordered (chop_tree, upgrade_tools; default off)', schema: bool },
  { key: 'inventoryMemory.enabled', description: 'container memory: remember what is in chests across restarts and keep it right (journal changes, notice chests moved or broken); off = in memory only', schema: bool },
  { key: 'inventoryMemory.maxAgeHours', description: 'container memory older than this is a hint, re-checked before relying on it (default 24)', schema: z.number().min(0.1).max(24 * 30) },
  { key: 'inventoryMemory.indexOwn', description: 'by day, look into its own and configured chests near home now and then (check_storage) and say when the pantry runs low', schema: bool },
  { key: 'inventoryMemory.refreshMinutes', description: 'check_storage looks into a chest not seen for this long (default 60)', schema: z.number().int().min(1).max(24 * 60) },
  { key: 'storage.anyContainer', description: 'take anything it wants from every container it knows near home (chests, barrels, shulker boxes, furnaces, smokers, hoppers, droppers, dispensers, brewing stands): look into them, count them for materials and food (off = only chests it placed and storage.chests)', schema: bool },
  { key: 'pickup.maxAirBreaks', description: 'give up on a dropped item after running out of air this many times going for it (items in deep water); 0 = never give up (default 2)', schema: z.number().int().min(0).max(20) },
  { key: 'pickup.unreachableMinutes', description: 'a drop it gave up on stays skipped this long, in minutes; air breaks older than this are forgotten (default 10)', schema: z.number().min(0.5).max(240) },
  { key: 'pickup.matchRadius', description: 'other drops within this many blocks of a given-up drop are skipped with it (default 2)', schema: z.number().min(0).max(8) },
  { key: 'inventoryMemory.radius', description: 'check_storage: chests within this many blocks of home (default 48)', schema: z.number().int().min(4).max(256) },
  { key: 'inventoryMemory.lowFood', description: 'tell the owners when the pantry holds fewer food items than this (default 8, 0 = never)', schema: z.number().int().min(0).max(1000) },
  { key: 'inventoryMemory.grumble', description: 'grumble once in chat when its own chest is raided, moved or broken', schema: bool },
  { key: 'inventoryMemory.grumbleTo', description: 'who hears the grumble: owners (whisper the owners online) | say (public chat)', schema: z.enum(['owners', 'say']) },
  { key: 'inventoryMemory.grumbleHours', description: 'at most one grumble per chest this often (default 3)', schema: z.number().min(0).max(168) },
  { key: 'needs.enabled', description: 'the needs layer: boost behaviours serving an urgent need and go looking when nothing in sight can meet it', schema: bool },
  { key: 'needs.boost', description: 'score added to a behaviour serving an urgent need, at urgency 1 (default 15)', schema: z.number().min(0).max(60) },
  { key: 'needs.search.enabled', description: 'go looking (a bounded search) when a need has no visible way to be met', schema: bool },
  { key: 'needs.search.radius', description: 'how far a need search may go, in blocks (default 160)', schema: z.number().int().min(16).max(512) },
  { key: 'needs.search.minutes', description: 'give a need search up after this many minutes (default 6)', schema: z.number().min(1).max(30) },
  { key: 'needs.search.cooldownMinutes', description: 'minutes between searches for the same need (default 30)', schema: z.number().min(1).max(1440) },
  { key: 'needs.search.retryMinutes', description: 'a need search taken over by other work in its first minute does not count; minutes before it may run again (default 5)', schema: z.number().min(0).max(1440) },
  { key: 'needs.search.perDay', description: 'searches per need per day at most (default 6, 0 = never)', schema: z.number().int().min(0).max(100) },
  { key: 'needs.search.startBelow', description: 'a need search may start while no other work scores above this (default 30; 15 = only when nothing else wants the body)', schema: z.number().min(0).max(79) },
  { key: 'needs.search.holdScore', description: 'a running need search keeps this score against other work; only one scoring it plus the switch margin takes over (default 30, 0 = any work above the idle band)', schema: z.number().min(0).max(79) },
  { key: 'needs.search.resumes', description: 'a need search cut short because the body was taken (a reflex, a player) may start again at once this many times per cooldown (default 3)', schema: z.number().int().min(0).max(20) },
  { key: 'needs.search.atNight', description: 'also search at night (default off)', schema: bool },
  { key: 'needs.safety.enabled', description: 'the safety need (stay safe (hostiles close, low health)): on, off; reset = on when a behaviour serving it is armed', schema: bool },
  { key: 'needs.safety.threshold', description: 'urgency (0-1) from which the safety need boosts its behaviours and may search (default 0.5)', schema: unit },
  { key: 'needs.food.enabled', description: 'the food need (stay fed): on, off; reset = on when a behaviour serving it is armed', schema: bool },
  { key: 'needs.food.threshold', description: 'urgency (0-1) from which the food need boosts its behaviours and may search (default 0.5)', schema: unit },
  { key: 'needs.gear.enabled', description: 'the gear need (gear up (weapon, tools, armour)): on, off; reset = on when a behaviour serving it is armed', schema: bool },
  { key: 'needs.gear.threshold', description: 'urgency (0-1) from which the gear need boosts its behaviours and may search (default 0.5)', schema: unit },
  { key: 'needs.supplies.enabled', description: 'the supplies need (keep the base supplied (wood, pantry food, seeds)): on, off; reset = on when a behaviour serving it is armed', schema: bool },
  { key: 'needs.supplies.threshold', description: 'urgency (0-1) from which the supplies need boosts its behaviours and may search (default 0.5)', schema: unit },
  { key: 'needs.rest.enabled', description: 'the rest need (rest at home and in bed at night): on, off; reset = on when a behaviour serving it is armed', schema: bool },
  { key: 'needs.rest.threshold', description: 'urgency (0-1) from which the rest need boosts its behaviours and may search (default 0.5)', schema: unit },
  { key: 'idle.mode', description: 'what it does when nothing else scores: off | passive (look around) | idle (light, near home) | active (chores) | explore (chores and scouting trips)', schema: z.enum(['off', 'passive', 'idle', 'active', 'explore']) },
  { key: 'idle.radius', description: 'idle and active chores stay within this many blocks of home (default 24)', schema: z.number().int().min(4).max(256) },
  { key: 'idle.exploreRadius', description: 'explore mode: how far a scouting trip may go (default 200)', schema: z.number().int().min(32).max(1024) },
  { key: 'idle.exploreMinutes', description: 'explore mode: give a scouting trip up after this many minutes (default 8)', schema: z.number().min(1).max(30) },
  { key: 'idle.chores.*', description: 'switch one idle chore on or off, e.g. idle.chores.scout_nearby off', schema: bool },
  { key: 'farming.iceWater', description: 'cold ground: break ice on a frozen shore or pond for a new farm\'s water when there is no open water or bucket (default on)', schema: bool },
  { key: 'farming.protectWater', description: 'keep a farm\'s water from freezing in a cold biome: auto (a cheap block over it, else a torch next to it) | cover | torch | off', schema: z.enum(['auto', 'cover', 'torch', 'off']) },
  { key: 'farming.badFarm', description: 'a farm site health marked bad: auto (repair a small job where it is, else a new farm elsewhere) | repair (never move) | relocate (always a new farm) | off (leave it for the owners)', schema: z.enum(['auto', 'repair', 'relocate', 'off']) },
  { key: 'farming.repairMaxBlocks', description: 'repair a flooded farm by filling at most this many cells with dirt (default 16)', schema: z.number().int().min(0).max(80) },
  { key: 'farming.repairTries', description: 'repairs tried on one bad farm before it moves or leaves it (default 2)', schema: z.number().int().min(0).max(20) },
  { key: 'farming.ownBuilds', description: 'its own blocks (torches, walls, covers, its farms and base) never count as somebody\'s build near a farm site (default on)', schema: bool },
  { key: 'farming.ownBaseRadius', description: 'blocks around its base\'s anchor that count as its own build (default 12, 0 = only the blocks it remembers placing)', schema: z.number().int().min(0).max(64) },
  { key: 'farming.plot', description: 'use the farm plot its base keeps free inside the walls (base project farm_plot) as a food source (default on)', schema: bool },
  { key: 'farming.plotWater', description: 'water for the farm plot: auto (water in reach or carried ice, else a dry plot) | water (only with water) | dry (never bother)', schema: z.enum(['auto', 'water', 'dry']) },
  { key: 'farming.plotSwap', description: 'dig out stone or sand on the farm plot and put dirt in its place (default on)', schema: bool },
  { key: 'food.sources', description: 'long-run food sources in order of preference: repair, farm, plot, animals, fish, forage (comma separated; leave one out to never use it)', schema: z.array(z.enum(['repair', 'farm', 'plot', 'animals', 'fish', 'forage'])) },
  { key: 'food.stock', description: 'animals, fishing and foraging run while carried and stored food items are below this (default 12)', schema: z.number().int().min(0).max(256) },
  { key: 'food.retryMinutes', description: 'a food source that failed is skipped for this many minutes (default 60)', schema: z.number().min(0).max(1440) },
  { key: 'food.minSeeds', description: 'seeds (carried and in its chests) to start a field farm when no grass is near (default 8)', schema: z.number().int().min(1).max(64) },
  { key: 'sites.enabled', description: 'site health: check the farm, bed, chests and home it depends on and mark bad ones', schema: bool },
  { key: 'sites.failures', description: 'unreachable or no-work checks in a row before a site is bad (default 3)', schema: z.number().int().min(1).max(20) },
  { key: 'sites.checkMinutes', description: 'check one site at most this often, in minutes (default 5)', schema: z.number().min(0.5).max(240) },
  { key: 'sites.recheckHours', description: 'look at a bad site again after this many hours (default 6)', schema: z.number().min(0.1).max(720) },
  { key: 'sites.replace', description: 'replace a bad site when it can (a new farm near home); off = only tell', schema: bool },
  { key: 'sites.tell', description: 'whisper the owners when a site goes bad or is fine again', schema: bool },
  { key: 'projects.enabled', description: 'base projects: improve and extend the base on its own when nothing else needs doing', schema: bool },
  { key: 'projects.policy', description: 'base projects: auto (build, asking first for big ones) | ask (propose every one) | off (plan only)', schema: z.enum(['auto', 'ask', 'off']) },
  { key: 'projects.askAbove', description: 'auto policy: projects with more blocks than this need an owner\'s ok first (default 150)', schema: z.number().int().min(0).max(100_000) },
  { key: 'projects.askTimeoutMinutes', description: 'how long to wait for an answer to a proposal (default 30)', schema: z.number().min(1).max(10_080) },
  { key: 'projects.onTimeout', description: 'no answer in time: wait (ask again later) | build | skip (default wait)', schema: z.enum(['wait', 'build', 'skip']) },
  { key: 'projects.paused', description: 'stop working on base projects for now (planning still works)', schema: bool },
  { key: 'projects.sessionMinutes', description: 'one base-project work session lasts at most this long (default 10)', schema: z.number().min(1).max(60) },
  { key: 'projects.night', description: 'also work at night on projects inside finished, lit walls (default on)', schema: bool },
  { key: 'materials.sources', description: 'where build and repair materials come from, in this order: chests, substitutes, craft, nearby, mine, far (comma separated; leave one out to turn it off)', schema: z.array(z.enum(['chests', 'substitutes', 'craft', 'nearby', 'mine', 'far'])) },
  { key: 'materials.retryMinutes', description: 'a material source that gave nothing of an item is skipped for it this long (default 30; 0 = always retry)', schema: z.number().min(0).max(1440) },
  { key: 'materials.mineMinutes', description: 'longest trip down its own mine for build blocks (default 6)', schema: z.number().min(1).max(60) },
  { key: 'materials.farDistance', description: 'far source: blocks past the base and its keep-out to start digging for stone (default 32)', schema: z.number().int().min(8).max(160) },
  { key: 'materials.farTries', description: 'far source: spots tried, nearest first (default 3)', schema: z.number().int().min(1).max(8) },
  { key: 'baseSafety.enabled', description: 'base safety: find caves, holes and mine entrances under and around the base that mobs can use, and fix them (default on)', schema: bool },
  { key: 'baseSafety.margin', description: 'base safety: blocks around the base footprint that are checked too (default 4)', schema: z.number().int().min(0).max(16) },
  { key: 'baseSafety.depth', description: 'base safety: blocks below the floor that are checked (default 8)', schema: z.number().int().min(1).max(24) },
  { key: 'baseSafety.fillMax', description: 'base safety: cavities up to this many blocks are filled in whole (default 48; 0 = never fill)', schema: z.number().int().min(0).max(2000) },
  { key: 'baseSafety.sealMax', description: 'base safety: at most this many openings of one cavity are sealed (default 24; 0 = never seal)', schema: z.number().int().min(0).max(500) },
  { key: 'baseSafety.capWith', description: 'base safety: a mine entrance near or in the base gets trapdoor | slab | block | light | none (default trapdoor)', schema: z.enum(['trapdoor', 'slab', 'block', 'light', 'none']) },
  { key: 'baseSafety.keepOutDepth', description: 'base safety: digging for stone or ore stays out of the ground under the base down to this depth (default 8; 0 = off)', schema: z.number().int().min(0).max(32) },
  { key: 'baseSafety.mineClearance', description: 'base safety: a staircase mine starts at least this many blocks from the base walls (default 4)', schema: z.number().int().min(0).max(32) },
  { key: 'baseSafety.minePlacement', description: 'base safety: where a new mine may start: inside the walls under a hatch | outside the walls | either, inside first (default inside)', schema: z.enum(['outside', 'inside', 'either']) },
  { key: 'baseSafety.mineHatch', description: 'base safety: a mine inside the walls gets a trapdoor hatch, opened for a trip and closed after it (default on)', schema: bool },
  { key: 'baseSafety.mineKeepClear', description: 'base safety: a mine inside the walls starts at least this many blocks from the gate (default 2)', schema: z.number().int().min(0).max(8) },
  { key: 'baseSafety.retireCloseMines', description: 'base safety: a known mine just outside the walls is capped and not used again; a new one is started (default on)', schema: bool },
  { key: 'baseSafety.useOutsideMines', description: 'base safety: with minePlacement inside, trips still go down a known mine outside the walls instead of digging one inside (default off)', schema: bool },
  { key: 'baseSafety.floorHoles', description: 'base safety: also fill holes in the floor surface inside the walls, dirt in a farm plot (default on)', schema: bool },
  { key: 'baseSafety.clearFixtures', description: 'base safety: break a torch or flower standing in a hole it fills; off = leave such a spot alone (default on)', schema: bool },
  { key: 'deathSpots.enabled', description: 'after a death, keep out of that spot for a while (default on)', schema: bool },
  { key: 'deathSpots.minutes', description: 'how long a death spot is avoided (default 10)', schema: z.number().min(0.5).max(240) },
  { key: 'deathSpots.stepCost', description: 'extra path cost per block inside a death spot (default 8; 0 = paths ignore it)', schema: z.number().min(0).max(50) },
  { key: 'respawn.enabled', description: 'respawn by itself when dead, also when it logs in dead (default on)', schema: bool },
  { key: 'respawn.retrySeconds', description: 'ask to respawn again this often while still dead (default 5)', schema: z.number().min(1).max(120) },
  { key: 'respawn.maxTries', description: 'reconnect after this many respawn asks without coming back (default 6)', schema: z.number().int().min(1).max(50) },
  { key: 'pathfinder.thinkTimeoutMs', description: 'how long the pathfinder may plan one path (ms); raise on a loaded machine', schema: z.number().int().min(1000).max(60_000) },
  { key: 'pathfinder.sprintAbove', description: 'walks only sprint when food is above this; sprinting burns food about ten times faster (default 12; 0 = always sprint)', schema: z.number().min(0).max(20) },
  { key: 'building', description: 'which blueprint to build: library (best saved match) | creative (design a new one) | ask (owner chooses when online)', schema: z.enum(['library', 'creative', 'ask']) },
  { key: 'build.creativeMethod', description: 'creative builds: hand (block by block like a player) | commands (/fill and /setblock when op; shown to other ops) | auto (= hand)', schema: z.enum(['auto', 'hand', 'commands']) },
  { key: 'build.handDelayMs', description: 'pause after each block in a creative hand build (ms, jittered)', schema: z.number().int().min(0).max(5000) },
  { key: 'world.spawnProtection', description: "the server's spawn-protection radius (server.properties, default 16): crafting tables and furnaces go outside it", schema: z.number().int().min(0).max(256) },
  { key: 'world.viewDistance', description: 'chunks around the bot the client asks for: tiny (6) | short (8) | normal (10) | far (12, default) or 2-32; fewer = less memory, but blocks and mobs further out are not seen (the server caps it at its own view-distance)', schema: z.union([z.enum(['tiny', 'short', 'normal', 'far']), z.number().int().min(2).max(32)]) },
  { key: 'road.width', description: 'lanes of a new road (1, 3 or 5)', schema: z.number().int().min(1).max(5) },
  { key: 'road.palette', description: 'road look: stone_bricks | cobblestone | stone | oak | spruce', schema: z.enum(['stone_bricks', 'cobblestone', 'stone', 'oak', 'spruce']) },
  { key: 'road.maxCut', description: 'deepest a road may cut into the ground (blocks)', schema: z.number().int().min(0).max(16) },
  { key: 'road.maxFill', description: 'highest a road may stand on fill above the ground (blocks)', schema: z.number().int().min(0).max(24) },
  { key: 'road.lanterns', description: 'lanterns on posts at road landings', schema: bool },
  { key: 'worldedit.enabled', description: 'WorldEdit actions: true = the server has it (skip detection), false = never use it; reset = detect', schema: bool },
  { key: 'worldedit.maxBlocks', description: 'largest region a WorldEdit action may change (blocks of volume)', schema: z.number().int().min(1).max(10_000_000) },
  { key: 'retry.actions.*', description: 'extra attempts after a failed action, e.g. retry.actions.goto 2', schema: z.number().int().min(0).max(10) }
]

export function findToggle (key: string): ToggleDef | undefined {
  return TOGGLES.find(t => t.key === key) ??
    TOGGLES.find(t => t.key.endsWith('.*') && key.startsWith(t.key.slice(0, -1)) && key.length > t.key.length - 1)
}

/** Parses a chat/CLI string (or passes through a typed value) against the toggle's schema. */
export function parseToggleValue (def: ToggleDef, raw: unknown): { ok: true, value: unknown } | { ok: false, error: string } {
  let v: unknown = raw
  if (typeof raw === 'string') {
    const s = raw.trim()
    const probe = def.schema
    if (probe.safeParse(true).success && /^(true|false|on|off|yes|no)$/i.test(s)) v = /^(true|on|yes)$/i.test(s)
    else if (probe.safeParse(1).success && s !== '' && !Number.isNaN(Number(s))) v = Number(s)
    else if (probe.safeParse(['x']).success) v = s.split(',').map(x => x.trim()).filter(Boolean)
    else v = s
  }
  const r = def.schema.safeParse(v)
  return r.success ? { ok: true, value: r.data } : { ok: false, error: z.prettifyError(r.error).replace(/\n/g, '; ') }
}

export function getPath (obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj)
}

/** Turns { "a.b": 1 } into { a: { b: 1 } }. */
export function expandPaths (flat: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [path, value] of Object.entries(flat)) {
    const keys = path.split('.')
    let o = out
    keys.slice(0, -1).forEach(k => { o = (o[k] && typeof o[k] === 'object' ? o[k] : (o[k] = {})) as Record<string, unknown> })
    o[keys.at(-1)!] = value
  }
  return out
}

/** Deep merge for plain objects; arrays and scalars from `over` replace. */
export function deepMerge (base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(over)) {
    const b = out[k]
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && b && typeof b === 'object' && !Array.isArray(b)
      ? deepMerge(b as Record<string, unknown>, v as Record<string, unknown>)
      : v
  }
  return out
}
