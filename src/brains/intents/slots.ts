// Slot extraction and validation for classifier layers that only pick the intent (embeddings,
// a local LLM): counts, items, places, players and templates come from the line itself with the
// same helpers the pattern parser uses (leadingCount, normalizeItem, ACTIVITIES, TEMPLATES), never
// from a model. A model's own argument guesses are accepted only when they are grounded in the
// line (the words or numbers are there) and name a real item. See docs/guide/intents.md.
import { createRequire } from 'node:module'
import {
  ACTIVITIES, ITEM_ALIASES, NOT_BLUEPRINTS, NOT_PLAYERS, TEMPLATES, lineShape, leadingCount, minable, normalizeItem, resolvePlayers,
  type IntentName, type ParseContext
} from './parse.ts'

export interface SlotOptions {
  /** Is this a real item or block name? Default: minecraft-data 1.21.1 plus generic names (log, planks, food, all). */
  knownItem?: (name: string) => boolean
}

export type SlotResult =
  | { ok: true, intent: IntentName, args: Record<string, unknown> }
  | { ok: false, missing: string }

// ------------------------------------------------------------------ item names

const GENERIC = new Set(['log', 'planks', 'food', 'all', 'iron_ore', 'gold_ore', 'copper_ore', 'diamond_ore', 'coal_ore', 'redstone_ore', 'lapis_ore', 'emerald_ore'])
/** Tool and armour words without a material ("a pickaxe"): the action picks the material. */
const TOOL_WORDS = new Set(['pickaxe', 'axe', 'shovel', 'hoe', 'sword', 'helmet', 'chestplate', 'leggings', 'boots'])
/** Registry names that are never what a player means by an item word. */
const NOT_ITEMS = new Set(['air', 'cave_air', 'void_air', 'light', 'fire', 'barrier', 'structure_void', 'jigsaw', 'map', 'water', 'lava', 'bubble_column', 'moving_piston', 'piston_head'])

let registryNames: Set<string> | null | undefined

function registry (): Set<string> | null {
  if (registryNames !== undefined) return registryNames
  try {
    const req = createRequire(import.meta.url)
    const data = req('minecraft-data')('1.21.1') as { itemsByName: Record<string, unknown>, blocksByName: Record<string, unknown> }
    registryNames = new Set([...Object.keys(data.itemsByName), ...Object.keys(data.blocksByName)])
  } catch {
    registryNames = null
  }
  return registryNames
}

/** Default item check: a vanilla 1.21.1 item/block (or a generic name like log, food, all). */
export function knownItemDefault (name: string): boolean {
  if (!name || NOT_ITEMS.has(name)) return false
  if (GENERIC.has(name)) return true
  if (/^[a-z_]+_(log|planks)$/.test(name)) return true
  const reg = registry()
  if (reg) return reg.has(name) || TOOL_WORDS.has(name)
  // no registry: only the alias table and things that look minable
  return Object.values(ITEM_ALIASES).some(([b, i]) => b === name || i === name) || minable(name)
}

/** Words that are never (part of) the item in a request. */
const STOP = new Set([
  'me', 'us', 'you', 'your', 'my', 'our', 'i', 'we', 'it', 'them', 'some', 'the', 'a', 'an', 'of', 'to', 'for', 'and', 'or', 'with',
  'please', 'back', 'here', 'there', 'over', 'more', 'any', 'few', 'couple', 'stack', 'stacks', 'bunch', 'lot', 'lots', 'loads', 'dozen',
  'half', 'handful', 'pair', 'several', 'get', 'got', 'grab', 'fetch', 'bring', 'mine', 'dig', 'collect', 'gather', 'drop', 'give', 'go',
  'come', 'hand', 'pass', 'toss', 'throw', 'need', 'want', 'could', 'would', 'can', 'will', 'up', 'down', 'out', 'away', 'now', 'just',
  'little', 'bit', 'full', 'all', 'is', 'are', 'be', 'from', 'in', 'on', 'at', 'by', 'that', 'this', 'those', 'these', 'what', 'one',
  'go', 'run', 'head', 'off', 'find', 'look', 'pick', 'something', 'stuff', 'things', 'thing', 'nearby', 'around', 'quick'
])

/**
 * The item named somewhere in a line: the longest 1-3 word phrase (rightmost on ties) that
 * normalises to a known item. `block` context prefers the block (iron -> iron_ore), `item` the
 * item (iron -> iron_ingot). Null when nothing in the line is an item.
 */
export function findItem (t: string, ctx: 'block' | 'item', opts: SlotOptions = {}): string | null {
  const known = opts.knownItem ?? knownItemDefault
  const words = t.split(' ').filter(Boolean)
  for (let len = Math.min(3, words.length); len >= 1; len--) {
    for (let start = words.length - len; start >= 0; start--) {
      const phrase = words.slice(start, start + len).join(' ')
      if (!(phrase in ITEM_ALIASES) && words.slice(start, start + len).some(w => STOP.has(w) || /^\d+$/.test(w) || NUMBER_WORDS.has(w))) continue
      const name = normalizeItem(phrase, ctx)
      if (name && name !== 'all' && known(name)) return name
    }
  }
  return null
}

/** Every item name a line could mean (each 1-3 word phrase, both contexts): grounding for model output. */
export function itemsInLine (t: string): Set<string> {
  const words = t.split(' ').filter(Boolean)
  const out = new Set<string>()
  for (let len = 1; len <= 3; len++) {
    for (let start = 0; start + len <= words.length; start++) {
      const phrase = words.slice(start, start + len).join(' ')
      out.add(phrase.replace(/\s+/g, '_'))
      out.add(normalizeItem(phrase, 'block'))
      out.add(normalizeItem(phrase, 'item'))
    }
  }
  out.delete('')
  return out
}

// ------------------------------------------------------------------ amounts

const NUMBER_WORDS = new Set(['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen',
  'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'])

/**
 * An amount anywhere in the line: digits or number words first ("get me 20 of those logs"),
 * then vague amounts ("a stack of", "a few", "some" = undefined). Same scale as the parser.
 */
export function findAmount (t: string): number | undefined {
  const words = t.split(' ').filter(Boolean)
  for (let i = 0; i < words.length; i++) {
    if (/^\d+$/.test(words[i]!) || NUMBER_WORDS.has(words[i]!) && words[i] !== 'one') {
      const q = leadingCount(words.slice(i).join(' '))
      if (q.found && q.count !== undefined) return q.count
    }
  }
  for (let i = 0; i < words.length; i++) {
    if (!/^(a|an|one|half|some|several|many|lots|loads|plenty)$/.test(words[i]!)) continue
    const q = leadingCount(words.slice(i).join(' '))
    if (q.found) return q.count
  }
  return undefined
}

// ------------------------------------------------------------------ slots per intent

const SPEAKER_SPOT = /\b(here|there|over here|over there|where i am|where i stand|to me|my spot|my position|my location|near me|next to me|right here)\b/
const WOODS = /\b(oak|spruce|birch|jungle|acacia|dark oak|mangrove|cherry|pale oak)\b/

function player (t: string, verbs: string): string | undefined {
  const m = new RegExp(`\\b(?:${verbs})\\s+([a-z0-9_]{3,16})$`).exec(t)
  if (!m || NOT_PLAYERS.has(m[1]!) || /^(me|us|myself|closely|behind|along|everywhere|around|safe|back|please)$/.test(m[1]!)) return undefined
  return m[1]
}

const place = (s: string) => s.trim().replace(/^(the|my|our|your)\s+/, '').replace(/\s+/g, '_')

/**
 * Slots for an intent chosen by a classifier that doesn't extract them itself. Returns the
 * (possibly refined: goto home -> go_home, collect bread -> bring) intent with its args, or the
 * missing slot when the line lacks one the action needs (bring without an item, goto without a place).
 */
export function extractSlots (intent: IntentName, text: string, ctx: ParseContext, opts: SlotOptions = {}): SlotResult {
  const { t } = lineShape(text)
  intent = refine(intent, t)
  const done = (i: IntentName, args: Record<string, unknown> = {}): SlotResult => ({ ok: true, intent: i, args: resolvePlayers(i, args, ctx) })
  switch (intent) {
    case 'unfollow': case 'unguard': case 'eat': case 'sleep': case 'status': case 'where': case 'inventory': case 'help': case 'go_home':
      return done(intent)
    case 'stop':
      return done('stop', /\b(stay|stay put|wait (here|there)|hold (your )?position|do not move|stand (here|still)|remain|park yourself)\b/.test(t) ? { stay: true } : {})
    case 'follow': {
      const p = player(t, 'follow|accompany|with|after|behind')
      const d = /\bat (\d+) blocks?\b/.exec(t)
      return done('follow', { ...(p ? { player: p } : {}), ...(d ? { distance: Number(d[1]) } : {}) })
    }
    case 'come': return done('come')
    case 'goto': {
      const c = /(?:^|\s)(-?\d+)\s+(-?\d+)(?:\s+(-?\d+))?(?:\s|$)/.exec(t)
      if (c) return done('goto', c[3] !== undefined ? { x: Number(c[1]), y: Number(c[2]), z: Number(c[3]) } : { x: Number(c[1]), z: Number(c[2]) })
      const to = /\b(?:to|towards|toward|at|over to)\s+(?:the |my |our |your )?([a-z0-9_: ]{2,32})$/.exec(t)
      if (to) {
        const name = place(to[1]!)
        if (/^(home|base|your_home|our_base|the_base|home_base)$/.test(name)) return done('go_home')
        if (/^(me|us|here|there|where_i_am|my_spot|my_position|my_location)$/.test(name)) return done('goto', { at: 'speaker' })
        return done('goto', { place: name })
      }
      if (SPEAKER_SPOT.test(t)) return done('goto', { at: 'speaker' })
      return { ok: false, missing: 'place' }
    }
    case 'guard': {
      if (/\b(here|this (place|area|spot|position|base)|the area|around here|the (base|house|camp)|our (base|house)|my house|this)\b/.test(t) && !/\b(me|us|my back)\b/.test(t)) return done('guard', { target: 'here' })
      const pl = /\b(?:guard|protect|defend|patrol)\s+(?:the|my|our)\s+([a-z0-9_: ]{2,32})$/.exec(t)
      if (pl && !/\b(back|self)\b/.test(pl[1]!)) return done('guard', { target: 'place', place: place(pl[1]!) })
      const p = player(t, 'guard|protect|defend|cover|escort|watch over|look after')
      return done('guard', { target: 'player', ...(p ? { player: p } : {}) })
    }
    case 'farm': {
      const create = /\b(make|start|build|set up|setup|create|plant|establish|new)\b/.test(t) && /\b(farm|field|garden)\b/.test(t)
      if (create) return done('farm', { create: true, ...(SPEAKER_SPOT.test(t) ? { at: 'speaker' } : {}) })
      const crop = /\b(wheat|crops?|carrots?|potato(?:es)?|beetroots?)\b/.exec(t)
      const at = /\b(?:at|in|near|by)\s+(?:the |my |our |your )?([a-z0-9_:]+(?: [a-z0-9_:]+)?)$/.exec(t)
      return done('farm', { ...(crop ? { crop: crop[1] } : {}), ...(at && !/^(once|now|bit|while)$/.test(at[1]!) ? { place: place(at[1]!) } : {}) })
    }
    case 'chop': {
      const count = findAmount(t)
      const unit = /\btrees?\b/.test(t) ? 'tree' : /plank/.test(t) ? 'planks' : 'log'
      const wood = WOODS.exec(t)
      return done('chop', { ...(count !== undefined ? { count } : {}), unit, ...(wood && unit !== 'tree' ? { wood: wood[1]!.replace(/\s+/g, '_') } : {}) })
    }
    case 'collect': {
      const item = findItem(t, 'block', opts)
      if (!item) return { ok: false, missing: 'item' }
      const count = findAmount(t)
      if (!minable(item)) return done('bring', { item: findItem(t, 'item', opts) ?? item, ...(count !== undefined ? { count } : {}) })
      return done('collect', { item, ...(count !== undefined ? { count } : {}) })
    }
    case 'bring': case 'give': {
      const item = findItem(t, 'item', opts)
      if (!item) return { ok: false, missing: 'item' }
      const count = findAmount(t)
      return done(intent, { item, ...(count !== undefined ? { count } : {}) })
    }
    case 'drop': {
      const item = findItem(t, 'item', opts)
      if (item) { const count = findAmount(t); return done('drop', { item, ...(count !== undefined ? { count } : {}) }) }
      if (/\b(everything|all|it all|inventory|pockets?|whole lot)\b/.test(t)) return done('drop', { item: 'all' })
      return { ok: false, missing: 'item' }
    }
    case 'find': {
      const m = /\b(?:find|locate|look for|look around for|search for|search|seek|track down|hunt for|hunt down|where is|where are|scout for|spot|show me|take me to|lead me to|is there|are there|any|need)\s+(?:me |us )?(?:the nearest |the closest |nearest |closest |a |an |the |some |any )?([a-z0-9_ ]{2,40}?)(?: nearby| near here| around| around here| close by| close| near)?(?: within \d+(?: blocks)?)?(?: and .*)?$/.exec(t)
      const target = m?.[1]?.trim()
      if (!target || /^(you|yourself|me|us|it|them|this|that|out|one)$/.test(target)) return { ok: false, missing: 'target' }
      const r = /\bwithin (\d+)/.exec(t)
      return done('find', { target: target.replace(/\s+/g, '_'), ...(r ? { radius: Number(r[1]) } : {}), ...(/\band (bring|get|grab|fetch)\b/.test(t) ? { bring: true } : {}) })
    }
    case 'build': {
      if (NOT_BLUEPRINTS.test(t)) return { ok: false, missing: 'template' }
      const key = Object.keys(TEMPLATES).sort((a, b) => b.length - a.length).find(k => new RegExp(`\\b${k}\\b`).test(t))
      if (!key) return { ok: false, missing: 'template' }
      return done('build', { template: TEMPLATES[key], ...(SPEAKER_SPOT.test(t) ? { at: 'speaker' } : {}) })
    }
    case 'set_home':
      return done('set_home', /\b(here|where i am|where i stand|my position|this is|this (spot|place|location))\b/.test(t) ? { at: 'speaker' } : {})
    case 'remember_place': {
      const m = /\b(?:as|called|named|is) (?:the |my |our |a )?([a-z0-9_:-]+(?: [a-z0-9_:-]+){0,2})$/.exec(t) ??
        /\b(?:call|name|mark) (?:this|here|it|this (?:place|spot|location|position)) (?:the |my |our |a )?([a-z0-9_:-]+(?: [a-z0-9_:-]+){0,2})$/.exec(t)
      if (!m || /^(here|this|it|that)$/.test(m[1]!)) return { ok: false, missing: 'name' }
      return done('remember_place', { name: m[1]!.replace(/\s+/g, '_'), at: 'speaker' })
    }
    case 'behavior_on': case 'behavior_off': {
      const b = /\b([a-z]+_[a-z_]+)\b/.exec(t)
      if (b) return done(intent, { behavior: b[1] })
      const act = t.split(' ').find(w => w in ACTIVITIES) ?? t.split(' ').map(w => `${w.replace(/e$/, '')}ing`).find(w => w in ACTIVITIES) ??
        t.split(' ').map(w => `${w}${w.at(-1)}ing`).find(w => w in ACTIVITIES)
      if (!act) return { ok: false, missing: 'activity' }
      return done(intent, { activity: act })
    }
    case 'pvp_attack': case 'pvp_spare': case 'pvp_mode': case 'hunt':
      // pattern-only intents: a classifier never gets to pick them (see INTENT_NAMES)
      return { ok: false, missing: intent === 'pvp_mode' ? 'mode' : intent === 'hunt' ? 'animal' : 'player' }
  }
}

/** On/off pairs whose direction the words decide better than a sentence embedding does. */
const POLARITY: Partial<Record<IntentName, IntentName>> = {
  follow: 'unfollow', unfollow: 'follow', guard: 'unguard', unguard: 'guard', behavior_on: 'behavior_off', behavior_off: 'behavior_on'
}
const OFF_WORDS = /^(do not|never|stop|quit|cease|no more|enough|disable|turn off|switch off|deactivate|disarm|pause|end|no need to|you can stop|give the \w+ a rest)\b|\b(anymore|any more)$/
const ON_WORDS = /^(start|begin|keep|resume|continue|carry on|enable|turn on|switch on|activate|arm|go|get back to|back to)\b/

/** Families of intents a classifier tends to confuse; the words decide inside a family (see refine). */
export const FAMILIES: IntentName[][] = [['follow', 'unfollow'], ['guard', 'unguard'], ['behavior_on', 'behavior_off'], ['bring', 'give']]

/** Fixes the direction (stop X vs start X) and give vs bring from the words of the line. */
export function refine (intent: IntentName, t: string): IntentName {
  const other = POLARITY[intent]
  if (other) {
    const off = OFF_WORDS.test(t)
    const offIntent = intent.startsWith('un') || intent === 'behavior_off'
    if (off && !offIntent) return other
    if (!off && offIntent && ON_WORDS.test(t) && intent.startsWith('behavior')) return other
  }
  if (intent === 'bring' || intent === 'give') return /^(give|hand|pass|toss|throw|gimme)\b|\byour\b/.test(t) ? 'give' : 'bring'
  return intent
}

// ------------------------------------------------------------------ validating model output

/** Args each intent may carry, with their types. Anything else a model returns is dropped. */
const ARG_TYPES: Record<string, 'string' | 'number' | 'boolean'> = {
  player: 'string', distance: 'number', at: 'string', x: 'number', y: 'number', z: 'number', place: 'string', target: 'string',
  stay: 'boolean', create: 'boolean', crop: 'string', count: 'number', unit: 'string', wood: 'string', item: 'string', radius: 'number',
  bring: 'boolean', template: 'string', name: 'string', behavior: 'string', activity: 'string', hunt: 'boolean', mode: 'string', animal: 'string'
}

/** Which args belong to which intent (for the local LLM prompt and for merging model values). */
export const INTENT_ARGS: Record<IntentName, string[]> = {
  follow: ['player', 'distance'], unfollow: [], come: ['player'], go_home: [], goto: ['place', 'x', 'y', 'z', 'at'],
  guard: ['target', 'player', 'place'], unguard: [], farm: ['create', 'crop', 'place', 'at'], chop: ['count', 'unit', 'wood'],
  collect: ['item', 'count'], find: ['target', 'radius', 'bring'], bring: ['item', 'count'], give: ['item', 'count'], drop: ['item', 'count'],
  eat: [], sleep: [], stop: ['stay'], status: [], where: [], inventory: [], set_home: ['at'], remember_place: ['name'],
  build: ['template', 'at'], behavior_on: ['behavior', 'activity'], behavior_off: ['behavior', 'activity'], help: [],
  pvp_attack: ['player', 'hunt'], pvp_spare: ['player'], pvp_mode: ['mode'], hunt: ['animal', 'count']
}

/** Args the extractor works out from the line itself; a model's odd value for them is ignored, not fatal. */
const DERIVED = new Set(['unit', 'at', 'stay', 'create', 'bring', 'activity', 'behavior', 'crop', 'wood'])

function derivedOk (k: string, v: unknown): boolean {
  switch (k) {
    case 'unit': return typeof v === 'string' && /^(tree|log|planks)$/.test(v)
    case 'at': return v === 'speaker'
    case 'stay': case 'create': case 'bring': return typeof v === 'boolean'
    case 'activity': return typeof v === 'string' && v in ACTIVITIES
    case 'behavior': return typeof v === 'string' && /^[a-z]+_[a-z_]+$/.test(v)
    default: return typeof v === 'string' && /^[a-z_]{2,20}$/.test(v)
  }
}

export type Validated = { ok: true, intent: IntentName, args: Record<string, unknown> } | { ok: false, reason: string }

/**
 * Checks a model's {intent, args} against the line: the slots are extracted from the text as
 * for any intent-only classifier, and every value the model supplied must agree with them or be
 * grounded in the line (the number is said, the item words are there and name a real item, the
 * place words are there). An invented value rejects the whole guess.
 */
export function validateModelArgs (intent: IntentName, modelArgs: Record<string, unknown>, text: string, ctx: ParseContext, opts: SlotOptions = {}): Validated {
  const slots = extractSlots(intent, text, ctx, opts)
  const { t } = lineShape(text)
  const known = opts.knownItem ?? knownItemDefault
  const items = itemsInLine(t)
  const numbers = new Set((t.match(/-?\d+/g) ?? []).map(Number))
  const amount = findAmount(t)
  const words = new Set(t.split(' '))
  const grounded = (v: string) => v.split(/[_\s]+/).filter(Boolean).every(w => words.has(w) || [...words].some(x => x.startsWith(w) || w.startsWith(x) && x.length >= 4))

  const accepted: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(modelArgs ?? {})) {
    if (v === null || v === undefined || v === '') continue
    const type = ARG_TYPES[k]
    if (!type || !INTENT_ARGS[intent].includes(k)) continue // keys that don't belong to the intent are ignored, not trusted
    // args the line decides anyway (unit, at, stay, ...) are dropped when odd; content args (items, numbers, names) reject
    if (DERIVED.has(k) && !derivedOk(k, v)) continue
    if (typeof v !== type) return { ok: false, reason: `${k} has the wrong type` }
    const s = slots.ok ? slots.args[k] : undefined
    if (s !== undefined && s === v) { accepted[k] = v; continue }
    switch (k) {
      case 'item': {
        const name = String(v).toLowerCase()
        if (!known(name) && name !== 'all') return { ok: false, reason: `invented item ${name}` }
        if (!items.has(name)) return { ok: false, reason: `item ${name} isn't in the line` }
        break
      }
      case 'count': case 'distance': case 'radius':
        if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 4096) return { ok: false, reason: `${k} ${v} out of range` }
        if (!numbers.has(v as number) && amount !== v) return { ok: false, reason: `${k} ${v} isn't in the line` }
        break
      case 'x': case 'y': case 'z':
        if (!Number.isInteger(v) || Math.abs(v as number) > 30_000_000 || !numbers.has(v as number)) return { ok: false, reason: `coordinate ${k}=${v} isn't in the line` }
        break
      case 'player':
        if (String(v).toLowerCase() !== ctx.speaker.toLowerCase() && !words.has(String(v).toLowerCase()) && !/^(me|us)$/.test(String(v))) return { ok: false, reason: `player ${v} isn't in the line` }
        break
      case 'template':
        if (!Object.values(TEMPLATES).includes(String(v))) return { ok: false, reason: `unknown template ${v}` }
        break
      case 'activity':
        if (!(String(v) in ACTIVITIES)) return { ok: false, reason: `unknown activity ${v}` }
        break
      case 'at':
        if (v !== 'speaker') return { ok: false, reason: `at must be speaker` }
        break
      case 'place': case 'target': case 'name': case 'behavior': case 'crop': case 'wood':
        if (!/^[a-z0-9_:-]{1,40}$/.test(String(v)) || !grounded(String(v))) return { ok: false, reason: `${k} ${v} isn't in the line` }
        break
      case 'unit':
        if (!/^(tree|log|planks)$/.test(String(v))) return { ok: false, reason: `unit ${v}` }
        break
    }
    accepted[k] = v
  }
  if (!slots.ok) {
    // the extractor found nothing; a grounded model value may fill the missing slot
    if (accepted[slots.missing] === undefined) return { ok: false, reason: `missing ${slots.missing}` }
    return { ok: true, intent, args: resolvePlayers(intent, accepted, ctx) }
  }
  // the extractor's values win; grounded model values only fill gaps
  const extra = Object.fromEntries(Object.entries(accepted).filter(([k]) => slots.args[k] === undefined && INTENT_ARGS[slots.intent].includes(k)))
  return { ok: true, intent: slots.intent, args: { ...extra, ...slots.args } }
}
