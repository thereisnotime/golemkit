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
  { key: 'combat.adaptiveWeapon', description: 'pick the best weapon per target (damage, enchantments, finishers, axes vs shields)', schema: bool },
  { key: 'combat.ranged', description: 'use bow/crossbow for flyers and out-of-reach targets when it has arrows', schema: bool },
  { key: 'combat.shield', description: 'raise a shield against ranged mobs between swings', schema: bool },
  { key: 'combat.crits', description: 'jump and hit while falling for critical hits (x1.5); sprint into the first hit for knockback', schema: bool },
  { key: 'combat.strafe', description: 'keep spacing and circle melee mobs between swings, step back after a hit', schema: bool },
  { key: 'combat.disengageToHeal', description: 'at 4 health or less with food, back off briefly to eat, then fight on (works with retreatBelow 0)', schema: bool },
  { key: 'combat.autoArmor', description: 'wear the best armour in the inventory and keep a shield or totem in the offhand', schema: bool },
  { key: 'combat.maxChase', description: 'stop chasing a mob this many blocks from where the fight started', schema: z.number().min(2).max(64) },
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
  { key: 'pathfinder.thinkTimeoutMs', description: 'how long the pathfinder may plan one path (ms); raise on a loaded machine', schema: z.number().int().min(1000).max(60_000) },
  { key: 'building', description: 'which blueprint to build: library (best saved match) | creative (design a new one) | ask (owner chooses when online)', schema: z.enum(['library', 'creative', 'ask']) },
  { key: 'build.creativeMethod', description: 'creative builds: hand (block by block like a player) | commands (/fill and /setblock when op; shown to other ops) | auto (= hand)', schema: z.enum(['auto', 'hand', 'commands']) },
  { key: 'build.handDelayMs', description: 'pause after each block in a creative hand build (ms, jittered)', schema: z.number().int().min(0).max(5000) },
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
