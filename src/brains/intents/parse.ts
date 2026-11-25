// Plain-language command parser for the intents brain: "pax guard me", "get 64 cobblestone",
// "bring me bread" -> { intent, args, confidence }. Pure functions, no LLM, no eval: a cleaned
// line is matched against an ordered table of anchored patterns. Anything that doesn't match a
// pattern as a whole gets no intent (or a low confidence), so chat between players, questions
// and long requests are left alone (or to the LLM). See docs/guide/intents.md.

export type IntentName =
  | 'follow' | 'unfollow' | 'come' | 'go_home' | 'goto' | 'guard' | 'unguard' | 'farm' | 'chop' | 'collect'
  | 'find' | 'bring' | 'give' | 'drop' | 'eat' | 'sleep' | 'stop' | 'status' | 'where' | 'inventory'
  | 'set_home' | 'remember_place' | 'build' | 'behavior_on' | 'behavior_off' | 'help'
  | 'pvp_attack' | 'pvp_spare' | 'pvp_mode' | 'hunt'

/**
 * Every intent the brain can act on (the label set for classifiers and the local LLM prompt).
 * The PvP intents (pvp_attack, pvp_spare, pvp_mode) and hunt are left out on purpose: only the
 * anchored patterns produce them, never a guess from the embeddings or a local model.
 */
export const INTENT_NAMES: readonly IntentName[] = [
  'follow', 'unfollow', 'come', 'go_home', 'goto', 'guard', 'unguard', 'farm', 'chop', 'collect',
  'find', 'bring', 'give', 'drop', 'eat', 'sleep', 'stop', 'status', 'where', 'inventory',
  'set_home', 'remember_place', 'build', 'behavior_on', 'behavior_off', 'help'
]

export interface Intent {
  intent: IntentName
  args: Record<string, unknown>
  /** 0..1. The brain acts only at or above its threshold (default 0.7). */
  confidence: number
}

export interface ParseContext {
  /** Who said it: "me", "us" and "here" resolve to this player. */
  speaker: string
  /**
   * Players online now (any case). When given, "hunt X" / "track down X" is a player hunt only
   * if X is one of them; without it only the kill verbs ("hunt X") guess at a player.
   */
  players?: readonly string[]
}

/** Default confidence threshold below which the brain does nothing. */
export const DEFAULT_THRESHOLD = 0.7

// ------------------------------------------------------------------ addressing

export interface AddressOptions {
  /** The bot's name and other names it answers to. */
  names: string[]
  whisper?: boolean
  /** Nobody else is online but the speaker (an owner): everything they say is for the bot. */
  alone?: boolean
  /** A recent exchange with this player: follow-ups without the name count. */
  inConversation?: boolean
}

export interface Addressed {
  /** The line without the bot's name. */
  body: string
  /** The name was said (or it was a whisper), as opposed to alone/conversation. */
  explicit: boolean
}

/**
 * Is the line for the bot? Its name (or an alias) at the start ("pax, follow me", "@pax follow
 * me") or the end ("follow me pax"), a whisper, or anything when alone with the owner or in an
 * ongoing exchange. A name in the middle ("I think pax is lost") doesn't count. Returns the line
 * without the name, or null when it isn't addressed to the bot.
 */
export function addressed (text: string, o: AddressOptions): Addressed | null {
  const line = text.trim()
  if (!line) return null
  const names = o.names.filter(Boolean).map(escape)
  if (names.length) {
    const alt = names.join('|')
    const start = new RegExp(`^(?:(?:hey|hi|yo|ok|okay|oi)\\s+)?@?(?:${alt})(?:[\\s,:;!.-]+|$)(.*)$`, 'i').exec(line)
    if (start) return { body: start[1]!.trim(), explicit: true }
    const end = new RegExp(`^(.*?)[\\s,]+@?(?:${alt})[\\s?!.]*$`, 'i').exec(line)
    if (end) return { body: end[1]!.trim(), explicit: true }
  }
  if (o.whisper) return { body: line, explicit: true }
  if (o.alone || o.inConversation) return { body: line, explicit: false }
  return null
}

function escape (s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ------------------------------------------------------------------ cleaning

const LEAD_FILLERS = [
  'hey', 'hi', 'yo', 'oi', 'ok', 'okay', 'alright', 'right', 'so', 'and', 'then', 'now', 'please', 'pls', 'plz', 'just', 'quickly',
  'can you', 'could you', 'would you', 'will you', 'would you mind', 'can u', 'could u', 'pls can you', 'please can you',
  'go ahead and', 'i want you to', 'i need you to', 'i would like you to', 'i d like you to', 'id like you to', 'you should', 'you can',
  'try to', 'lets', 'let s', 'time to', 'be a dear and', 'kindly', 'mate', 'buddy', 'bro', 'dude'
].sort((a, b) => b.length - a.length)

const TRAIL_FILLERS = [
  'please', 'pls', 'plz', 'now', 'right now', 'asap', 'thanks', 'thank you', 'thx', 'ty', 'for me', 'for us', 'mate', 'buddy', 'bro', 'dude',
  'ok', 'okay', 'quickly', 'for now', 'for a bit', 'for a while', 'real quick', 'again', 'too', 'as well', 'will you', 'would you', 'thanks in advance'
].sort((a, b) => b.length - a.length)

/** Words that start a question; such lines only map to the info intents (status, where, inventory, help). */
const QUESTION_START = /^(did|do(?! not)|does|is|are|was|were|have|has|had|why|how|when|who|whose|which|should|shall|may|might|am|isn t|aren t|didn t|doesn t)\b/

export interface Cleaned { t: string, question: boolean, polite: boolean }

export function clean (text: string): Cleaned {
  let t = text.toLowerCase().replace(/[’`´]/g, "'")
  const question = /\?\s*$/.test(t)
  t = t.replace(/\bx(\d+)\b/g, '$1') // "bread x5"
  t = t.replace(/(\d+)x\b/g, '$1')   // "5x bread"
  t = t.replace(/[^a-z0-9:_'\- ]+/g, ' ').replace(/(^|\s)-(?!\d)/g, ' ').replace(/'/g, ' ').replace(/\s+/g, ' ').trim()
  // common shorthand
  t = t.replace(/\bu\b/g, 'you').replace(/\br\b/g, 'are').replace(/\bur\b/g, 'your').replace(/\bpls\b/g, 'please')
  t = t.replace(/\bwhat s\b/g, 'what is').replace(/\bwhere s\b/g, 'where is').replace(/\bwhats\b/g, 'what is').replace(/\bwheres\b/g, 'where is')
  t = t.replace(/\bdon t\b|\bdont\b/g, 'do not').replace(/\bi m\b/g, 'i am').replace(/\bcan t\b|\bcant\b/g, 'cannot')
  t = t.replace(/\bgonna\b/g, 'going to').replace(/\bwanna\b/g, 'want to').replace(/\bgimme\b/g, 'give me').replace(/\blemme\b/g, 'let me')
  let polite = false
  for (let changed = true; changed;) {
    changed = false
    for (const f of LEAD_FILLERS) {
      if (t === f) break
      if (t.startsWith(f + ' ')) {
        if (/^(can|could|would|will|please)/.test(f)) polite = true
        t = t.slice(f.length + 1).trim()
        changed = true
      }
    }
    for (const f of TRAIL_FILLERS) {
      if (t !== f && t.endsWith(' ' + f)) { t = t.slice(0, -f.length - 1).trim(); changed = true }
    }
  }
  return { t, question, polite }
}

// ------------------------------------------------------------------ numbers and items

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19
}
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 }

/** Vague amounts. "some" means "the default" (undefined). */
const VAGUE: [RegExp, number | undefined][] = [
  [/^half an? stack( of)?\b/, 32],
  [/^(a|one) stack( of)?\b/, 64],
  [/^a full stack( of)?\b/, 64],
  [/^a couple( of)?\b/, 2],
  [/^a pair of\b/, 2],
  [/^a few\b/, 3],
  [/^a handful of\b/, 5],
  [/^several\b/, 5],
  [/^a dozen\b/, 12],
  [/^a bunch( of)?\b/, 16],
  [/^(a lot of|lots of|loads of|plenty of|a load of|many)\b/, 32],
  [/^(some|a bit of|a little|more|any|enough)\b/, undefined],
  [/^(an|a|one)\b/, 1]
]

/**
 * A leading amount: digits, number words up to the nineties ("sixty four"), "N stacks",
 * "a stack" = 64, "a few" = 3, "some" = undefined. Returns the count and the rest of the text.
 */
export function leadingCount (text: string): { count?: number, rest: string, found: boolean } {
  let t = text.trim()
  let n: number | undefined
  let found = false
  const digits = /^(\d+)\b\s*/.exec(t)
  if (digits) { n = Number(digits[1]); t = t.slice(digits[0].length); found = true } else {
    const w = /^([a-z]+)(?:[\s-]+([a-z]+))?\b/.exec(t)
    if (w && TENS[w[1]!] !== undefined) {
      n = TENS[w[1]!]
      if (w[2] && UNITS[w[2]] !== undefined && UNITS[w[2]]! < 10) { n! += UNITS[w[2]]!; t = t.slice(w[0].length) } else t = t.slice(w[1]!.length)
      found = true
    } else if (w && UNITS[w[1]!] !== undefined && w[1] !== 'one') {
      n = UNITS[w[1]!]; t = t.slice(w[1]!.length); found = true
    }
  }
  t = t.trim()
  if (found) {
    const st = /^stacks?( of)?\b\s*/.exec(t)
    if (st) { n = (n ?? 1) * 64; t = t.slice(st[0].length) }
    return { count: n, rest: t.replace(/^of\s+/, '').trim(), found }
  }
  for (const [re, v] of VAGUE) {
    const m = re.exec(t)
    if (m) {
      // "one stack" matched above; a bare "one" is a count of 1
      return { count: v, rest: t.slice(m[0].length).replace(/^of\s+/, '').trim(), found: true }
    }
  }
  return { rest: t, found: false }
}

/** Splits "bread 5" / "5 bread" / "a stack of cobble" into count and item phrase. */
export function quantityItem (text: string): { count?: number, item: string } {
  let t = text.trim().replace(/^(of|the|your|my|our|those|these|that|this)\s+/, '')
  const lead = leadingCount(t)
  let count = lead.count
  t = lead.rest.replace(/^(of|the|your|my)\s+/, '')
  const trail = /\s(\d+)$/.exec(t)
  if (trail && count === undefined) { count = Number(trail[1]); t = t.slice(0, trail.index) }
  return { count, item: t.trim() }
}

/** Item words, singular: what players say -> [block/mining name, item/inventory name]. */
export const ITEM_ALIASES: Record<string, [string, string]> = {
  cobble: ['cobblestone', 'cobblestone'],
  cobblestone: ['cobblestone', 'cobblestone'],
  stone: ['stone', 'cobblestone'],
  rock: ['stone', 'cobblestone'],
  wood: ['log', 'log'],
  log: ['log', 'log'],
  'wood log': ['log', 'log'],
  'wooden log': ['log', 'log'],
  tree: ['log', 'log'],
  timber: ['log', 'log'],
  lumber: ['log', 'planks'],
  plank: ['planks', 'planks'],
  planks: ['planks', 'planks'],
  'wood plank': ['planks', 'planks'],
  'wood planks': ['planks', 'planks'],
  'wooden plank': ['planks', 'planks'],
  'wooden planks': ['planks', 'planks'],
  iron: ['iron_ore', 'iron_ingot'],
  'iron ore': ['iron_ore', 'raw_iron'],
  'raw iron': ['iron_ore', 'raw_iron'],
  'iron ingot': ['iron_ore', 'iron_ingot'],
  gold: ['gold_ore', 'gold_ingot'],
  'gold ore': ['gold_ore', 'raw_gold'],
  copper: ['copper_ore', 'copper_ingot'],
  diamond: ['diamond_ore', 'diamond'],
  'diamond ore': ['diamond_ore', 'diamond'],
  coal: ['coal_ore', 'coal'],
  'coal ore': ['coal_ore', 'coal'],
  redstone: ['redstone_ore', 'redstone'],
  lapis: ['lapis_ore', 'lapis_lazuli'],
  'lapis lazuli': ['lapis_ore', 'lapis_lazuli'],
  emerald: ['emerald_ore', 'emerald'],
  quartz: ['nether_quartz_ore', 'quartz'],
  clay: ['clay', 'clay_ball'],
  steak: ['cooked_beef', 'cooked_beef'],
  beef: ['beef', 'beef'],
  pork: ['cooked_porkchop', 'cooked_porkchop'],
  porkchop: ['cooked_porkchop', 'cooked_porkchop'],
  chicken: ['cooked_chicken', 'cooked_chicken'],
  seed: ['wheat_seeds', 'wheat_seeds'],
  'wheat seed': ['wheat_seeds', 'wheat_seeds'],
  berry: ['sweet_berries', 'sweet_berries'],
  'sweet berry': ['sweet_berries', 'sweet_berries'],
  food: ['food', 'food'],
  'something to eat': ['food', 'food'],
  torche: ['torch', 'torch'],
  table: ['crafting_table', 'crafting_table'],
  'crafting table': ['crafting_table', 'crafting_table'],
  'workbench': ['crafting_table', 'crafting_table'],
  everything: ['all', 'all'],
  all: ['all', 'all'],
  'it all': ['all', 'all'],
  'all of it': ['all', 'all'],
  'all your stuff': ['all', 'all'],
  stuff: ['all', 'all']
}

/** Words whose trailing s is part of the name. */
const KEEP_S = new Set(['glass', 'grass', 'moss', 'leaves', 'planks', 'bricks', 'stairs', 'boots', 'leggings', 'shears', 'lapis', 'tongs', 'oats', 'gras', 'sweet_berries', 'beans', 'netherrack'])

export function singular (word: string): string {
  if (KEEP_S.has(word) || word.length <= 3) return word
  if (/ies$/.test(word)) return word.slice(0, -3) + 'y'
  if (/(ch|sh|x|ss)es$/.test(word)) return word.slice(0, -2)
  if (/oes$/.test(word)) return word.slice(0, -2)
  if (/ves$/.test(word) && word !== 'leaves') return word.slice(0, -3) + 'f'
  if (/[^s]s$/.test(word)) return word.slice(0, -1)
  return word
}

/**
 * Normalises an item phrase to a Minecraft-style name. `block` context (mining, collecting)
 * prefers the block ("iron" -> iron_ore), `item` context (bring, drop, give) the item
 * ("iron" -> iron_ingot). "log" and "planks" stay generic (any wood).
 */
export function normalizeItem (phrase: string, ctx: 'block' | 'item'): string {
  let p = phrase.toLowerCase().trim().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ')
  p = p.replace(/^(of|the|a|an|some|your|my|any|more|those|these)\s+/, '').replace(/\s+(blocks?|items?|pieces?|ones?|please|stuff)$/, '').trim()
  if (!p) return ''
  const idx = ctx === 'block' ? 0 : 1
  const direct = ITEM_ALIASES[p]
  if (direct) return direct[idx]
  const words = p.split(' ').map(singular)
  const joined = words.join(' ')
  if (ITEM_ALIASES[joined]) return ITEM_ALIASES[joined]![idx]
  // "oak wood" / "spruce logs" -> oak_log; "oak planks" -> oak_planks
  const last = words.at(-1)!
  if (words.length > 1 && (last === 'wood' || last === 'log')) return `${words.slice(0, -1).join('_')}_log`
  if (words.length > 1 && (last === 'plank' || last === 'planks')) return `${words.slice(0, -1).join('_')}_planks`
  return words.join('_')
}

/** Activity word ("farming", "chopping") or behaviour name -> behaviour (null: unknown). */
export const ACTIVITIES: Record<string, string> = {
  farming: 'farm_loop',
  harvesting: 'farm_loop',
  tending: 'farm_loop',
  chopping: 'chop_wood_loop',
  woodcutting: 'chop_wood_loop',
  lumberjacking: 'chop_wood_loop',
  logging: 'chop_wood_loop',
  cutting: 'chop_wood_loop',
  following: 'follow_owner',
  guarding: 'guard',
  protecting: 'guard',
  defending: 'guard',
  wandering: 'wander',
  exploring: 'wander',
  roaming: 'wander',
  collecting: 'collect_drops',
  looting: 'collect_drops',
  sleeping: 'sleep_at_night',
  greeting: 'greet_players',
  lighting: 'light_area',
  depositing: 'deposit_when_full',
  upgrading: 'keep_tools_upgraded',
  eating: 'keep_fed'
}

// ------------------------------------------------------------------ templates

export const TEMPLATES: Record<string, string> = {
  house: 'small_house',
  'small house': 'small_house',
  'little house': 'small_house',
  home: 'small_house',
  'big house': 'cottage',
  'bigger house': 'cottage',
  'large house': 'cottage',
  cottage: 'cottage',
  cabin: 'cabin',
  'log cabin': 'cabin',
  tower: 'tower',
  watchtower: 'watchtower',
  'watch tower': 'watchtower',
  hut: 'hut',
  shelter: 'shelter',
  wall: 'wall_segment',
  'wall segment': 'wall_segment',
  platform: 'platform',
  fortress: 'fortress',
  fort: 'fortress'
}
export const NOT_BLUEPRINTS = /\b(road|roads|path|bridge|farm|fire|portal|tunnel|stair|stairs|staircase|nether)\b/

// ------------------------------------------------------------------ the pattern table

type Build = (m: RegExpExecArray, ctx: ParseContext) => { intent: IntentName, args?: Record<string, unknown>, confidence?: number } | null

interface Rule { re: RegExp, build: Build }

const ME = '(me|us|myself)'
const PLAYER = '([a-z0-9_]{3,16})'

/** "me"/"us" -> the speaker, else the named player (lower case; the brain matches the real name). */
export function who (word: string | undefined, ctx: ParseContext): string {
  return !word || /^(me|us|myself)$/.test(word) ? ctx.speaker : word
}

/** Words after "attack"/"kill" that are mobs, not players. */
const MOBS = /^(zombies?|skeletons?|creepers?|spiders?|endermen|enderman|mobs?|monsters?|hostiles?|everything|everyone|anything|animals?|cows?|pigs?|sheep|chickens?|witch(es)?|pillagers?|phantoms?|slimes?|drowned|husks?|strays?|vindicators?|blazes?|ghasts?|rabbits?|bunny|bunnies|mooshrooms?|goats?|horses?|llamas?|foxes|fox|wolves|wolf|cats?|squids?|cod|salmon|them all|all)$/

/** Animals the hunt action takes ("hunt rabbits" -> hunt { animal: 'rabbit' }). */
const HUNT_ANIMALS: Record<string, string> = {
  cow: 'cow', cows: 'cow', pig: 'pig', pigs: 'pig', sheep: 'sheep', chicken: 'chicken', chickens: 'chicken',
  rabbit: 'rabbit', rabbits: 'rabbit', bunny: 'rabbit', bunnies: 'rabbit', mooshroom: 'mooshroom', mooshrooms: 'mooshroom'
}

/** "hunt X" names a player when X is online (when the online list is known); "hunt player X" has its own rule. */
function huntsPlayer (verb: string, word: string, ctx: ParseContext): boolean {
  if (ctx.players) return ctx.players.some(p => p.toLowerCase() === word)
  return verb !== 'track down' // no list: only the kill verbs guess at a player; "track down iron" is a search
}

export const NOT_PLAYERS = new Set(['it', 'that', 'this', 'them', 'there', 'here', 'around', 'everyone', 'everybody', 'someone', 'home', 'the', 'a', 'my', 'your'])

const RULES: Rule[] = [
  // ---- help and info (questions allowed)
  { re: /^(help|commands|command list|what can you do|what do you understand|what can i say|what do you do|how do i use you|what are your commands|list commands|show commands|help me use you)$/, build: () => ({ intent: 'help' }) },
  { re: /^(status|report|sitrep|what are you doing|what are you up to|what is up|what is going on|what you doing|whatcha doing|watcha doing|how are you|how is it going|how are things|are you busy|are you ok|you ok|are you alright|what are you working on|what is your status|status report|whats your status)$/, build: () => ({ intent: 'status' }) },
  { re: /^(why are you idle|why are you so idle|why are you doing nothing|why are you not doing anything|why are you standing (around|there|still)|why are you just standing (around|there)|why did you stop working|are you stuck|you stuck|why are you stuck|is something wrong|what is wrong|whats wrong|what is the problem|whats the problem|what is the holdup|why idle|why stuck)$/, build: () => ({ intent: 'status' }) },
  { re: /^(where are you|where are you at|where you at|where is pax|your position|position|pos|coords|coordinates|your coords|your coordinates|what are your coords|what are your coordinates|send coords|location|your location|where did you go)$/, build: () => ({ intent: 'where' }) },
  { re: /^(inventory|inv|show inventory|show me your inventory|what do you have|what have you got|what you got|what are you carrying|what is in your inventory|check your inventory|list your items|your items|what do you have on you|show your stuff)$/, build: () => ({ intent: 'inventory' }) },

  // ---- stop / stay
  { re: /^(do not|never|no more|quit|stop|cease) (follow|following) ?(me|us|him|her|them|[a-z0-9_]{3,16})?$/, build: () => ({ intent: 'unfollow' }) },
  { re: /^(leave me alone|go away|stop tailing me|stop chasing me|get lost|quit following me around|stop following me around)$/, build: () => ({ intent: 'unfollow' }) },
  { re: /^(stop|quit|cease|no more) (guarding|protecting|defending|watching) ?(me|us|here|this place|the area|it|[a-z0-9_]{3,16})?$/, build: () => ({ intent: 'unguard' }) },
  { re: /^(stand down|at ease|you can stop guarding|off duty|dismissed)$/, build: () => ({ intent: 'unguard' }) },
  { re: /^(stay|stay here|stay there|wait here|wait there|stay put|hold position|hold your position|do not move|stand here|stand still|remain here)$/, build: () => ({ intent: 'stop', args: { stay: true } }) },
  { re: /^(stop|halt|cancel|abort|freeze|enough|nevermind|never mind|forget it|quit it|cut it out|hold on|hold up|stop it|stop that|stop everything|cancel that|cancel it|cancel everything|stop what you are doing|stop whatever you are doing|stop doing that|stop moving|that is enough|thats enough|wait|stop now|stop stop)$/, build: () => ({ intent: 'stop' }) },

  // ---- behaviours on/off by name ("turn on keep_fed", "disarm farm_loop")
  { re: /^(arm|enable|turn on|switch on|activate) ([a-z]+_[a-z_]+)$/, build: m => ({ intent: 'behavior_on', args: { behavior: m[2] } }) },
  { re: /^(disarm|disable|turn off|switch off|deactivate) ([a-z]+_[a-z_]+)$/, build: m => ({ intent: 'behavior_off', args: { behavior: m[2] } }) },

  // ---- eat / sleep
  { re: /^(eat|eat something|eat some food|eat food|have a snack|grab a bite|have something to eat|have a bite|go eat|feed yourself|get something to eat|time to eat|eat up|have lunch|have dinner|have breakfast|you should eat|eat now|are you hungry eat)$/, build: () => ({ intent: 'eat' }) },
  { re: /^(sleep|go to sleep|go to bed|go sleep|take a nap|nap|bedtime|time for bed|time to sleep|hit the hay|get some sleep|sleep in the bed|use the bed|skip the night)$/, build: () => ({ intent: 'sleep' }) },

  // ---- follow / come
  { re: new RegExp(`^(follow|come with|come along with|tag along with|stick with|stay with|keep up with|keep following|walk with|accompany|stay close to|stick close to) ${ME}( around| closely| everywhere)?( at (\\d+) blocks?)?$`), build: m => ({ intent: 'follow', args: { player: who(m[2], { speaker: '' }) || '', ...(m[5] ? { distance: Number(m[5]) } : {}) } }) },
  { re: /^(follow|come along|tag along|follow along|let s go|lets go|come on|with me|on me|heel)$/, build: () => ({ intent: 'follow', args: {} }) },
  { re: new RegExp(`^(follow|keep following|stay with|accompany) ${PLAYER}$`), build: (m) => NOT_PLAYERS.has(m[2]!) ? null : ({ intent: 'follow', args: { player: m[2] }, confidence: 0.85 }) },
  { re: /^(come|come here|come to me|come over|come over here|get over here|over here|here|to me|come back|come back here|return to me|get here|walk to me|come closer|closer|come near|over here please|get back here|back to me|tp to me|teleport to me|come to my position|come to my location|come find me|find me|reach me|meet me|meet me here|i need you here|i need you)$/, build: () => ({ intent: 'come', args: {} }) },
  { re: new RegExp(`^(come to|go to|walk to|run to|meet|join) ${PLAYER}$`), build: m => NOT_PLAYERS.has(m[2]!) ? null : ({ intent: 'goto', args: { place: m[2] }, confidence: 0.8 }) },

  // ---- home and places
  { re: /^((go|head|walk|run|get|come|go back|head back|walk back|run back|get back|come back|return|back|move|travel)( back)? home|home|go to (your |the |our )?(home|base)|return to (your |the |our )?(home|base)|go back to (your |the |our )?(home|base)|back to base|to base|go to base|return home|head home|go home now|homeward|(go|head|get|walk|run|come|make your way)( back)? to (the |your |our )?(base|house|home base))$/, build: () => ({ intent: 'go_home' }) },
  { re: /^(go|walk|head|move|travel|run|goto|tp)( to)? (-?\d+) (-?\d+)(?: (-?\d+))?$/, build: m => m[5] !== undefined ? ({ intent: 'goto', args: { x: Number(m[3]), y: Number(m[4]), z: Number(m[5]) } }) : ({ intent: 'goto', args: { x: Number(m[3]), z: Number(m[4]) } }) },
  { re: /^(go|walk|move|head|run|get) (there|over there|here|over here|to where i am|where i am|to me|to my spot)$/, build: () => ({ intent: 'goto', args: { at: 'speaker' } }) },
  { re: /^(go|head|walk|travel|move|run|return|get|come|go back|head back) (back )?to (the |my |your |our )?([a-z0-9_: ]{2,32})$/, build: m => ({ intent: 'goto', args: { place: m[4]!.trim().replace(/\s+/g, '_') }, confidence: 0.8 }) },
  { re: /^(set|make|mark|save)( your| the| my| our)? home( here| to here| at my position| where i am| where i stand)?$/, build: m => ({ intent: 'set_home', args: m[3] ? { at: 'speaker' } : {} }) },
  { re: /^(this is (your |our |my |the )?home|home is here|sethome|set home|your home is here|here is home|live here|this is home now)$/, build: m => ({ intent: 'set_home', args: /^set ?home$/.test(m[0]) ? {} : { at: 'speaker' } }) },
  { re: /^(remember|save|mark|call|name|note|store) (this|here|this place|this spot|this location|this position|it|the spot|the place|where i am|where i stand|my position)( place| spot| location)? (as|is) (the |my |our |a )?([a-z0-9_: -]{1,32})$/, build: m => ({ intent: 'remember_place', args: { name: m[6]!.trim().replace(/\s+/g, '_'), at: 'speaker' } }) },
  { re: /^(this|here) is (called |named )?(the |my |our )?([a-z0-9_:-]{1,32})(,? remember( it| that)?)$/, build: m => ({ intent: 'remember_place', args: { name: m[4], at: 'speaker' } }) },
  { re: /^(remember|save) (this place|this spot|here|this location)$/, build: () => null },

  // ---- PvP (pattern only; the brain checks the name is a player it knows)
  { re: /^(pvp|pvp mode|set pvp|set pvp to|set pvp mode to|switch pvp to|pvp mode to) (off|defend|revenge|targets|all)$/, build: m => ({ intent: 'pvp_mode', args: { mode: m[2] } }) },
  { re: /^(stop attacking|stop fighting|stop the pvp|stop pvp|no more pvp|no pvp|ceasefire|cease fire|peace)$/, build: () => ({ intent: 'pvp_mode', args: { mode: 'off' } }) },
  { re: new RegExp(`^(stop attacking|stop fighting|stop hunting|leave|spare|forgive|do not attack|do not fight|do not hurt|never attack) ${PLAYER}( alone)?$`), build: m => NOT_PLAYERS.has(m[2]!) || MOBS.test(m[2]!) || (m[1] === 'leave' && !m[3]) ? null : ({ intent: 'pvp_spare', args: { player: m[2] } }) },
  { re: /^(hunt|hunt down|go hunt|go hunting for|kill|go kill)( a| an| one| some| the| (\d+))? (cows?|pigs?|sheep|chickens?|rabbits?|bunny|bunnies|mooshrooms?|animals|food)( for me| for us| for food)?$/, build: m => {
    const animal = HUNT_ANIMALS[m[4]!]
    const count = m[3] ? Number(m[3]) : undefined
    return { intent: 'hunt', args: { ...(animal ? { animal } : {}), ...(count ? { count } : {}) } }
  } },
  { re: new RegExp(`^(hunt|hunt down|track down|find and kill|go hunt|go find and kill)( the player| player) ${PLAYER}( down)?$`), build: m => ({ intent: 'pvp_attack', args: { player: m[3], hunt: true } }) },
  { re: new RegExp(`^(hunt|hunt down|track down|find and kill|go hunt|go find and kill) ${PLAYER}( down)?$`), build: (m, ctx) => NOT_PLAYERS.has(m[2]!) || MOBS.test(m[2]!) || /^(me|us|myself|for)$/.test(m[2]!) || !huntsPlayer(m[1]!, m[2]!, ctx) ? null : ({ intent: 'pvp_attack', args: { player: m[2], hunt: true } }) },
  { re: new RegExp(`^(attack|fight|go after|kill|take out) ${PLAYER}( on sight)?$`), build: m => NOT_PLAYERS.has(m[2]!) || MOBS.test(m[2]!) || /^(me|us|myself)$/.test(m[2]!) ? null : ({ intent: 'pvp_attack', args: { player: m[2] }, confidence: 0.85 }) },

  // ---- guard
  { re: new RegExp(`^(guard|protect|defend|cover|bodyguard|watch over|look after|keep an eye on|watch|escort) ${ME}$`), build: () => ({ intent: 'guard', args: { target: 'player' } }) },
  { re: /^(be my bodyguard|be my guard|keep me safe|watch my back|protect me|cover me|i need protection|guard me please|got my back|have my back|bodyguard mode|guard mode)$/, build: () => ({ intent: 'guard', args: { target: 'player' } }) },
  { re: /^(guard|protect|defend|watch|patrol|secure|hold) (here|this place|this area|this spot|this|the area|the spot|it|around here|this position|this base|our base|the base|the house|our house|my house|the camp)$/, build: () => ({ intent: 'guard', args: { target: 'here' } }) },
  { re: new RegExp(`^(guard|protect|defend) ${PLAYER}$`), build: m => NOT_PLAYERS.has(m[2]!) ? null : ({ intent: 'guard', args: { target: 'player', player: m[2] }, confidence: 0.8 }) },
  { re: /^(guard|protect|defend|patrol) (the |my |our )([a-z0-9_: ]{2,32})$/, build: m => ({ intent: 'guard', args: { target: 'place', place: m[3]!.trim().replace(/\s+/g, '_') }, confidence: 0.8 }) },

  // ---- switching behaviours by activity ("start farming", "stop chopping")
  { re: /^(start|begin|keep|go|resume|continue|carry on|get|turn on|switch on|enable|you can start|get back to|back to) ([a-z]+ing)( again| for me| around| on your own| by yourself)?$/, build: m => ACTIVITIES[m[2]!] ? ({ intent: 'behavior_on', args: { activity: m[2] } }) : null },
  { re: /^(stop|quit|end|pause|turn off|switch off|disable|no more|enough) ([a-z]+ing)( for now| now| already)?$/, build: m => ACTIVITIES[m[2]!] ? ({ intent: 'behavior_off', args: { activity: m[2] } }) : null },

  // ---- farm
  { re: /^(make|start|build|set up|setup|create|plant|establish) (a |an |the |your |my )?(new )?(wheat |crop |small )?(farm|field|garden)( here| over here| nearby)?$/, build: m => ({ intent: 'farm', args: { create: true, ...(m[6] ? { at: 'speaker' } : {}) } }) },
  { re: /^(farm|harvest|tend|reap|do some farming|go farm|go harvest|work the field|work the farm|tend the farm|tend the crops|tend the field)( the| your| my| our| some)?( (wheat|crops?|field|fields|farm|carrots?|potato(es)?|beetroots?))?( (at|in|near|by) (the |my |our |your )?([a-z0-9_: ]{2,32}))?$/, build: m => ({ intent: 'farm', args: { ...(m[4] ? { crop: m[4] } : {}), ...(m[9] ? { place: m[9].trim().replace(/\s+/g, '_') } : {}) } }) },

  // ---- wood
  { re: /^(chop|cut|fell|chop down|cut down) (down )?(a|one|the|that|this|the nearest|a nearby) tree$/, build: () => ({ intent: 'chop', args: { count: 1, unit: 'tree' } }) },
  { re: /^(chop|cut|fell|chop down|cut down) (down )?(.+) trees?$/, build: m => { const q = leadingCount(m[3]!); return q.found && !q.rest ? ({ intent: 'chop', args: { ...(q.count ? { count: q.count } : {}), unit: 'tree' } }) : null } },
  { re: /^(chop|cut|fell|lumberjack|chop down|cut down|go chop|go cut|go get|get|gather|collect|harvest|grab|fetch|bring back|go and chop|go and get)( down)?( me| us)? ?(.*?) ?(wood|logs?|timber|lumber|trees|planks|wood planks|wooden planks)$/, build: m => {
    const amount = m[4] ?? ''
    const q = amount ? leadingCount(amount) : { count: undefined, rest: '', found: false }
    let wood = q.rest
    if (wood && !/^[a-z_]+$/.test(wood)) return null
    if (amount && !q.found && !/^(oak|spruce|birch|jungle|acacia|dark oak|dark_oak|mangrove|cherry|pale_oak)$/.test(wood)) return null
    const planks = /plank/.test(m[5]!) || /^(make|craft)/.test(m[1]!)
    const unit = planks ? 'planks' : 'log'
    return ({ intent: 'chop', args: { ...(q.count ? { count: q.count } : {}), unit, ...(wood ? { wood: wood.replace(/\s+/g, '_') } : {}) } })
  } },
  { re: /^(chop|go chop|chop chop|chop wood|do some chopping|lumberjack|woodcutting)$/, build: () => ({ intent: 'chop', args: {} }) },

  // ---- find (before collect: "find me diamonds" is a search)
  { re: /^(find|locate|look for|search for|seek|track down|where is|where are|where can i find|scout for|scout|go find|go look for|show me|take me to|lead me to|is there|are there|any) (me |us )?(the nearest |the closest |nearest |closest |a |an |the |some |any )?([a-z0-9_ ]{2,40}?)( nearby| near here| around| around here| close by| close)?( within (\d+)( blocks)?)?( and (bring|get|grab|fetch) (it|them|some)( back| to me| here)?)?$/, build: (m, ctx) => {
    const target = m[4]!.trim()
    if (/^(you|yourself|me|us|it|them|this|that|out)$/.test(target)) return null
    if (m[1] === 'where is' || m[1] === 'where are') {
      if (/^(you|pax|my stuff|everyone)$/.test(target)) return null
      // "where's my iron": something stored, answered from container memory
      const mine = /^(my|our) ([a-z0-9_ ]{2,40})$/.exec(target)
      if (mine && !m[5] && !m[7] && !m[9]) return ({ intent: 'find', args: { target: mine[2]!.trim().replace(/\s+/g, '_'), stored: true } })
    }
    if ((m[1] === 'is there' || m[1] === 'are there' || m[1] === 'any') && !m[5]) return null // "is there a way..." chat
    void ctx
    return ({ intent: 'find', args: { target: target.replace(/\s+/g, '_'), ...(m[7] ? { radius: Number(m[7]) } : {}), ...(m[9] ? { bring: true } : {}) } })
  } },

  // ---- give / bring / drop
  { re: /^(give|hand|pass|toss|throw) (me|us) (your|all your|all of your|some of your|one of your) (.+)$/, build: m => { const q = quantityItem(m[4]!); const all = /all/.test(m[3]!); return q.item ? ({ intent: 'give', args: { item: normalizeItem(q.item, 'item'), ...(q.count ? { count: q.count } : {}), ...(all ? { all: true } : {}) } }) : null } },
  { re: /^(give|hand|pass) (me|us) (.+)$/, build: m => { const q = quantityItem(m[3]!); return q.item && !/^(a hand|a sec|a second|a minute|a break|space|room)$/.test(m[3]!) ? ({ intent: 'give', args: { item: normalizeItem(q.item, 'item'), ...(q.count ? { count: q.count } : {}) } }) : null } },
  { re: /^(bring|fetch|deliver|get) (me|us) (.+?)( back| here| over here| over)?$/, build: m => { const q = quantityItem(m[3]!); const item = normalizeItem(q.item, 'item'); return item ? ({ intent: 'bring', args: { item, ...(q.count ? { count: q.count } : {}), ...(m[1] === 'get' ? { viaGet: true } : {}) } }) : null } },
  { re: /^(bring|fetch|deliver) (.+?) (to me|to us|here|over here|back|back here)$/, build: m => { const q = quantityItem(m[2]!); const item = normalizeItem(q.item, 'item'); return item ? ({ intent: 'bring', args: { item, ...(q.count ? { count: q.count } : {}) } }) : null } },
  { re: /^(throw away|throw out|get rid of|drop|toss|throw|discard|dump|empty|unload)( all| all of| all your| all of your| your| the)? (.+)$/, build: m => { const q = quantityItem(m[3]!); const item = normalizeItem(q.item, 'item'); if (!item) return null; const all = /all/.test(m[2] ?? '') || item === 'all'; return ({ intent: 'drop', args: { item: item === 'inventory' || item === 'pocket' ? 'all' : item, ...(q.count && !all ? { count: q.count } : {}) } }) } },
  { re: /^(drop|empty|empty your pockets|drop it|drop everything|drop all)$/, build: () => ({ intent: 'drop', args: { item: 'all' } }) },

  // ---- build
  { re: /^(build|construct)( me| us)? (a |an |the |another |one |some )?(.+?)( here| over here| right here| there| over there| near me| next to me)?$/, build: m => {
    const raw = m[4]!.trim()
    if (NOT_BLUEPRINTS.test(raw) || raw.split(' ').length > 3) return null
    const known = TEMPLATES[raw]
    if (!known && !/^[a-z0-9_ ]+$/.test(raw)) return null
    return ({ intent: 'build', args: { template: known ?? raw.replace(/\s+/g, '_'), ...(m[5] ? { at: 'speaker' } : {}) }, confidence: known ? 0.9 : 0.75 })
  } },
  { re: /^(make|put up|erect|set up)( me| us)? (a |an |the )?(.+?)( here| over here| right here| there| near me)?$/, build: m => {
    const known = TEMPLATES[m[4]!.trim()]
    return known ? ({ intent: 'build', args: { template: known, ...(m[5] ? { at: 'speaker' } : {}) } }) : null
  } },

  // ---- collect / mine (generic, last)
  { re: /^(get|collect|mine|dig|dig up|gather|fetch|grab|obtain|acquire|go get|go mine|go collect|go dig|harvest|farm|quarry|bring back|pick up|go and get|go and mine|scavenge)( me| us)? (.+?)( for me| for us| please)?$/, build: m => {
    const q = quantityItem(m[3]!)
    if (!q.item || q.item.split(' ').length > 3) return null
    if (/^(going|started|ready|lost|out|up|down|back|away|over|here|there|it|that|this|them|to|on|off|in|home|rid|moving|busy|along)\b/.test(q.item)) return null
    const block = normalizeItem(q.item, 'block')
    if (!block || block === 'all') return null
    // "get me bread": a thing you don't dig up is a delivery
    if (!minable(block)) return ({ intent: 'bring', args: { item: normalizeItem(q.item, 'item'), ...(q.count ? { count: q.count } : {}) }, confidence: m[2] ? 0.9 : 0.8 })
    return ({ intent: 'collect', args: { item: block, ...(q.count ? { count: q.count } : {}) } })
  } }
]

/** Blocks you dig or chop (as opposed to items you bring). */
export function minable (name: string): boolean {
  return /(^|_)(ore|log|planks|stone|cobblestone|dirt|sand|gravel|clay|deepslate|netherrack|granite|diorite|andesite|tuff|calcite|obsidian|snow|ice|wood|basalt|blackstone|terracotta|mud|moss_block|grass_block|soul_sand|soul_soil|end_stone|sandstone|glowstone|leaves)$/.test(name) ||
    ['log', 'planks', 'stone', 'cobblestone', 'dirt', 'sand', 'gravel', 'clay', 'coal_ore', 'iron_ore', 'gold_ore', 'diamond_ore', 'copper_ore', 'redstone_ore', 'lapis_ore', 'emerald_ore', 'nether_quartz_ore'].includes(name)
}

/** Info intents answer questions; everything else needs a request, not a question. */
export const INFO: ReadonlySet<IntentName> = new Set(['help', 'status', 'where', 'inventory'])

/** A cleaned line plus what kind of sentence it is: question, negation, polite request. */
export interface LineShape extends Cleaned {
  /** "don't X" / "never X" / "no X": only unfollow, unguard, pvp_spare and pvp off may come out of it. */
  negated: boolean
  /** A real question (not "can you ...?"): only the info intents act on it at full confidence. */
  asksQuestion: boolean
}

/**
 * A statement about someone ("I'm going to get wood", "we need a farm", "the guard is asleep"),
 * not a request to the bot. Patterns never match these (they are anchored); looser classifiers check it.
 * Requests phrased as needs ("I need bread", "I could use torches") don't count.
 */
export function isStatement (t: string): boolean {
  if (/^((can|could|does|will|would|is) )?(anyone|someone|somebody|anybody|everyone|everybody)\b/.test(t)) return true
  return /^(i am|i was|i will|i have|i had|i did|i think|i just|i went|i got|i found|i love|i hate|i saw|i chopped|i built|i made|we|we are|he|she|they|my|his|her|their|our|the|someone|somebody|everyone|nobody)\b/.test(t)
}

/** "steve, give me your sword": the line starts by naming someone else (the bot's own name is already stripped). */
export function addressesOther (text: string): boolean {
  const m = /^\s*@?([A-Za-z0-9_]{3,16})\s*,/.exec(text)
  return !!m && !/^(hey|hi|yo|oi|ok|okay|alright|right|so|well|now|please|pls|yes|yeah|no|nope|mate|buddy|bro|dude|then|and|also|thanks|sorry)$/i.test(m[1]!)
}

/** Cleans a line and classifies its sentence shape. Shared by every classifier layer. */
export function lineShape (text: string): LineShape {
  const c = clean(text)
  const negated = /^(do not|never(?! mind)|no) /.test(c.t)
  const asksQuestion = (c.question && !c.polite) || QUESTION_START.test(c.t)
  return { ...c, negated, asksQuestion }
}

/**
 * Applies the sentence shape to a classifier's raw confidence: negated requests other than
 * unfollow/unguard/pvp_spare and "pvp off" ("no pvp", "no more pvp") are no request at all (null), questions halve the confidence of action
 * intents ("did you follow him?"), except searches phrased as questions ("where is the village?").
 */
export function shapeConfidence (intent: IntentName, confidence: number, shape: LineShape, args?: Record<string, unknown>): number | null {
  if (shape.negated && intent !== 'unfollow' && intent !== 'unguard' && intent !== 'pvp_spare' && !(intent === 'pvp_mode' && args?.mode === 'off')) return null
  let c = confidence
  if (shape.asksQuestion && !INFO.has(intent)) {
    if (!(intent === 'find' && /^(where|is there|are there|any)\b/.test(shape.t))) c *= 0.5
  }
  return Math.round(c * 100) / 100
}

/** Fills in the speaker for "me"/"us" and for follow/come/guard without a player. */
export function resolvePlayers (intent: IntentName, args: Record<string, unknown>, ctx: ParseContext): Record<string, unknown> {
  const out = { ...args }
  if ('player' in out) out.player = who(out.player as string | undefined, ctx)
  if (intent === 'follow' || intent === 'come' || intent === 'guard' && out.target === 'player') out.player = out.player || ctx.speaker
  return out
}

/**
 * Parses one line (already stripped of the bot's name) into an intent, or null. No match for
 * the whole line means no intent: partial matches would act on chat that wasn't a request.
 */
export function parseIntent (text: string, ctx: ParseContext): Intent | null {
  const shape = lineShape(text)
  const { t } = shape
  if (!t || t.length > 120) return null
  for (const rule of RULES) {
    const m = rule.re.exec(t)
    if (!m) continue
    const r = rule.build(m, ctx)
    if (!r) continue
    const confidence = shapeConfidence(r.intent, r.confidence ?? 0.9, shape, r.args)
    if (confidence === null) return null
    return { intent: r.intent, args: resolvePlayers(r.intent, r.args ?? {}, ctx), confidence }
  }
  return null
}

/** Short phrase list for "help". */
export function helpLines (name: string): string[] {
  return [
    `say "${name} <request>": follow me, stop following, come here, go home, go to <place>, guard me / guard here / stop guarding, stay, stop`,
    'farm (at <place>), make a farm, chop some wood, get 64 cobblestone, mine 10 iron, find <thing>, bring me bread 5, give me your <item>, drop <item>',
    'eat, sleep, status / what are you doing / where are you, inventory, set home, remember this place as <name>, build a house (here), start/stop farming|chopping|following|guarding',
    'PvP (owners): pvp off|defend|revenge|targets|all, attack <player>, hunt <player> (or hunt player <name>), stop attacking <player>; hunt rabbits|cows|... for food; "stop" ends every fight'
  ]
}
