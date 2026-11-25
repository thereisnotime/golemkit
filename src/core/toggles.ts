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
  { key: 'combat.disengageToHeal', description: 'at 4 health or less with food, back off briefly to eat, then fight on (works with retreatBelow 0)', schema: bool },
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
  { key: 'mining.safe', description: 'safe mining: needs weapon, food (and gear, see mining.gear) to dig or walk deeper than mining.safeDepth, avoids breaking into caves, lights tunnels, climbs out when losing underground', schema: bool },
  { key: 'mining.safeDepth', description: 'blocks below the surface it may dig or go for ore without being ready (default 8)', schema: z.number().int().min(0).max(64) },
  { key: 'mining.needWeapon', description: 'a sword or axe is needed to mine deeper than mining.safeDepth', schema: bool },
  { key: 'mining.minFood', description: 'food items needed to mine deeper than mining.safeDepth (default 3)', schema: z.number().int().min(0).max(64) },
  { key: 'mining.gear', description: 'gear needed to mine deeper than mining.safeDepth: none | shield_or_armour | armour (with shield_or_armour the first iron ingot becomes a shield)', schema: z.enum(['none', 'shield_or_armour', 'armour']) },
  { key: 'mining.minArmour', description: 'armour points worn that count as armour for mining.gear (default 1)', schema: z.number().int().min(0).max(20) },
  { key: 'mining.retreatBelow', description: 'underground: abandon the dig and climb out at or below this health (0 = never; separate from reflexes.retreatBelow)', schema: health },
  { key: 'mining.retreatHostiles', description: 'underground: abandon the dig and climb out when this many hostiles are close (0 = never)', schema: z.number().int().min(0).max(20) },
  { key: 'mining.hostileRadius', description: 'underground: how close a hostile counts for mining.retreatHostiles, in blocks (default 8)', schema: z.number().int().min(2).max(32) },
  { key: 'mining.torches', description: 'light tunnels with torches, crafted from coal or charcoal and sticks when it has none', schema: bool },
  { key: 'mining.torchEvery', description: 'a torch every this many tunnel steps (default 8)', schema: z.number().int().min(1).max(64) },
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
  { key: 'inventoryMemory.radius', description: 'check_storage: chests within this many blocks of home (default 48)', schema: z.number().int().min(4).max(256) },
  { key: 'inventoryMemory.lowFood', description: 'tell the owners when the pantry holds fewer food items than this (default 8, 0 = never)', schema: z.number().int().min(0).max(1000) },
  { key: 'inventoryMemory.grumble', description: 'grumble once in chat when its own chest is raided, moved or broken', schema: bool },
  { key: 'inventoryMemory.grumbleTo', description: 'who hears the grumble: owners (whisper the owners online) | say (public chat)', schema: z.enum(['owners', 'say']) },
  { key: 'inventoryMemory.grumbleHours', description: 'at most one grumble per chest this often (default 3)', schema: z.number().min(0).max(168) },
  { key: 'pathfinder.thinkTimeoutMs', description: 'how long the pathfinder may plan one path (ms); raise on a loaded machine', schema: z.number().int().min(1000).max(60_000) },
  { key: 'building', description: 'which blueprint to build: library (best saved match) | creative (design a new one) | ask (owner chooses when online)', schema: z.enum(['library', 'creative', 'ask']) },
  { key: 'build.creativeMethod', description: 'creative builds: hand (block by block like a player) | commands (/fill and /setblock when op; shown to other ops) | auto (= hand)', schema: z.enum(['auto', 'hand', 'commands']) },
  { key: 'build.handDelayMs', description: 'pause after each block in a creative hand build (ms, jittered)', schema: z.number().int().min(0).max(5000) },
  { key: 'world.spawnProtection', description: "the server's spawn-protection radius (server.properties, default 16): crafting tables and furnaces go outside it", schema: z.number().int().min(0).max(256) },
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
