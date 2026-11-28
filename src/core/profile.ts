// Profiles (profiles/<name>.yaml): a named, saved instance of a variant.
//
//   variant: companion
//   username: Pax
//   owners: [Robin]
//   server: { host: mc.example.com }
//   persona: "Pax, a capable helper..."
//   llm: { provider: claude-subscription, model: claude-sonnet-5-5, listen: conversation }
//   settings: { home: [100, 64, -20] }
//
// `llm` lands in settings.llm, where the LLM brain picks it up.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import YAML from 'yaml'
import { z } from 'zod'
import type { InstanceOptions, ServerConfig } from './definition.ts'
import { expandEnv } from './definition.ts'
import { LoggingSchema } from './fleetFile.ts'
import { createLogger } from './log.ts'
import { TOGGLES } from './toggles.ts'
import { unknownKeys } from './schemaKeys.ts'
import { NeedsSettingsSchema, IdleSettingsSchema, SitesSettingsSchema, IDLE_MODES } from './needs.ts'
import { ProjectsSettingsSchema } from './projects.ts'
import { BaseSafetySettingsSchema, DeathSpotsSettingsSchema } from './baseSafety.ts'
import { RespawnSettingsSchema } from './respawnPlan.ts'
import { MaterialSourcesSettingsSchema } from './materialSources.ts'

export const LlmProfileSchema = z.object({
  provider: z.string().optional().describe('claude-subscription | codex | anthropic | opencode | openai'),
  model: z.string().optional(),
  effort: z.string().optional(),
  login: z.string().optional().describe('LLM login dir (default .auth/<provider>) or "user"'),
  oauthTokenVar: z.string().optional().describe('claude-subscription: variable holding a setup-token'),
  oauthTokenFile: z.string().optional().describe('dotenv file to read oauthTokenVar from (only that variable is read)'),
  proxy: z.string().optional().describe('"caveman" (local layer, auto-started), "none", or an http(s) gateway URL'),
  listen: z.enum(['mention', 'conversation', 'all']).optional(),
  immersive: z.boolean().optional().describe('stay in character; default false (factual, openly a bot)'),
  aliases: z.array(z.string()).optional(),
  conversationMs: z.number().optional(),
  ownersOnly: z.boolean().optional(),
  tickMs: z.number().optional(),
  ambientBatchMs: z.number().optional(),
  ambientMinGapMs: z.number().optional(),
  budget: z.record(z.string(), z.number()).optional(),
  goals: z.object({
    enabled: z.boolean().optional(),
    maxTurns: z.number().int().min(1).optional().describe('continuation turns without hearing from the owner'),
    timeoutMin: z.number().min(1).optional().describe('minutes a goal runs on its own without hearing from the owner'),
    maxSameFailures: z.number().int().min(1).optional(),
    continueDelayMs: z.number().optional(),
    idleBaseMs: z.number().optional(),
    idleMaxMs: z.number().optional(),
    budgetReserve: z.number().min(0).max(1).optional(),
    ownerWaitMin: z.number().min(0).max(1440).optional().describe('minutes to wait for an owner answer before going on alone (0 = forever)')
  }).optional().describe('persistent goals and continuation guardrails')
}).passthrough()

/** One intents pipeline layer (docs/guide/intents.md). */
const IntentLayerSchema = z.object({
  use: z.enum(['patterns', 'embeddings', 'local_llm', 'cloud_llm']),
  name: z.string().regex(/^[a-z0-9_]+$/).optional(),
  enabled: z.boolean().optional(),
  threshold: z.number().min(0).max(1).optional(),
  model: z.string().optional(),
  dtype: z.string().optional(),
  method: z.enum(['knn', 'centroid']).optional(),
  k: z.number().int().min(1).max(50).optional(),
  margin: z.number().min(0).max(1).optional(),
  preload: z.boolean().optional(),
  url: z.string().url().optional(),
  timeout_ms: z.number().int().min(100).max(60_000).optional(),
  api_key_var: z.string().optional()
}).strict()

export const ProfileSchema = z.object({
  variant: z.string().describe('variant name (variants/<name>.ts) or path'),
  description: z.string().optional(),
  username: z.string().optional(),
  owners: z.array(z.string()).optional(),
  canDig: z.boolean().optional(),
  /** Leave blocks that look player-made alone (default off: the bot may dig and use anything it needs). */
  respectBuilds: z.boolean().optional(),
  /** Show the bot its own variant/profile/model/settings each turn (default on). */
  selfAware: z.boolean().optional(),
  /** While the LLM is paused (quota/budget): false, or { arm: { behaviour: options } } (default: chop_wood_loop, deposit_when_full). */
  npcMode: z.union([z.literal(false), z.object({ arm: z.record(z.string(), z.record(z.string(), z.unknown())) })]).optional(),
  /** Ask the owners for help when a behaviour keeps failing the same way: true/false or options. Lands in settings.askHelp. See docs/guide/behaviors.md#asking-for-help. */
  askHelp: z.union([z.boolean(), z.object({
    enabled: z.boolean().optional(),
    failures: z.number().int().min(1).max(100).optional(),
    minutes: z.number().min(0).max(1440).optional(),
    forgetMinutes: z.number().min(1).optional(),
    perReasonMinutes: z.number().min(1).optional(),
    maxPerHour: z.number().int().min(0).max(60).optional(),
    tell: z.enum(['owners', 'say']).optional(),
    llm: z.boolean().optional(),
    thanks: z.boolean().optional(),
    quietHours: z.tuple([z.number().min(0).max(24), z.number().min(0).max(24)]).optional(),
    observeMinutes: z.number().min(1).max(1440).optional()
  }).strict()]).optional(),
  /** Status snapshot, status.json and the stuck alert: true/false or options. Lands in settings.status. See docs/guide/status.md. */
  status: z.union([z.boolean(), z.object({
    file: z.boolean().optional().describe('write data/bots/<name>/status.json for `node src/cli.ts status` (default true)'),
    intervalMs: z.number().int().min(1000).max(600_000).optional().describe('sample and file rewrite interval in ms (default 5000)'),
    alert: z.boolean().optional().describe('whisper online owners when stuck, with back-off (default true)'),
    stuckAlertMs: z.number().int().min(60_000).max(86_400_000).optional().describe('no progress for this long while it wants to do something = stuck, in ms (default 600000)'),
    alertMaxMs: z.number().int().min(60_000).max(7 * 86_400_000).optional().describe('largest gap between repeat alerts in ms (default 7200000)')
  }).strict()]).optional(),
  /**
   * Needs layer (docs/guide/needs-and-idle.md): standing drives (safety, food, gear, supplies, rest)
   * that boost the behaviours serving them and go looking when nothing in sight can meet them.
   * false turns it off. Lands in settings.needs.
   */
  needs: z.union([z.literal(false), NeedsSettingsSchema]).optional().describe('needs: boosts for urgent needs and bounded searches; false = off'),
  /** What it does when nothing else scores: a mode name, or { mode, radius, exploreRadius, exploreMinutes, chores }. Lands in settings.idle. */
  idle: z.union([z.enum(IDLE_MODES), IdleSettingsSchema]).optional().describe('idle mode: off | passive | idle | active | explore, or options'),
  /** Site health: check the farm, bed, chests and home it depends on; mark, replace or report bad ones. false turns it off. Lands in settings.sites. */
  sites: z.union([z.literal(false), SitesSettingsSchema]).optional().describe('site health checks; false = off'),
  /** Base projects (docs/guide/base-projects.md): the queue of base improvements it works through on its own. false turns it off. Lands in settings.projects. */
  projects: z.union([z.literal(false), ProjectsSettingsSchema]).optional().describe('base projects: improve and extend the base on its own (policy auto | ask | off); false = off'),
  /** Base safety (docs/guide/base-safety.md): caves, holes and mine entrances under and around the base, found and fixed. false turns it off. Lands in settings.baseSafety. */
  baseSafety: z.union([z.literal(false), BaseSafetySettingsSchema]).optional().describe('base safety: find and fix caves, holes and mine entrances mobs can use; false = off'),
  /** Death spots: keep out of the spot it just died in for a while. false turns it off. Lands in settings.deathSpots. */
  deathSpots: z.union([z.literal(false), DeathSpotsSettingsSchema]).optional().describe('avoid the spot of a recent death for a while; false = off'),
  /** Respawning by itself when dead, also when it logs in dead. false turns it off. Lands in settings.respawn. */
  respawn: z.union([z.literal(false), RespawnSettingsSchema]).optional().describe('respawn by itself when dead (also when it logs in dead); false = off'),
  /** Material sources (docs/guide/base-projects.md#where-materials-come-from): where build and repair blocks come from, in order. Lands in settings.materials. */
  materials: MaterialSourcesSettingsSchema.optional().describe('where build and repair materials come from: chests, substitutes, craft, nearby, mine, far (in order)'),
  persona: z.string().optional(),
  server: z.object({
    host: z.string().optional(),
    port: z.number().int().optional(),
    auth: z.enum(['offline', 'microsoft']).optional(),
    version: z.string().optional(),
    platform: z.enum(['neoforge', 'vanilla', 'paper']).optional()
  }).optional(),
  llm: LlmProfileSchema.optional(),
  /** Plain-language commands without the LLM (intents brain). Lands in settings.intents. See docs/guide/intents.md. */
  intents: z.object({
    mode: z.enum(['fallback', 'first', 'off']).optional(),
    threshold: z.number().min(0).max(1).optional(),
    aliases: z.array(z.string()).optional(),
    /** Classifier layers in order: patterns, embeddings, local_llm; cloud_llm = hand the rest to the LLM brain. */
    layers: z.array(IntentLayerSchema).optional(),
    strategy: z.enum(['first_confident', 'vote', 'best']).optional(),
    min_votes: z.number().int().min(1).optional(),
    log_decisions: z.boolean().optional(),
    /** Extra example phrasings for the embeddings layer: { intent: [lines], none: [chat lines] }. */
    examples: z.record(z.string(), z.array(z.string())).optional()
  }).strict().optional(),
  /** Building policy: library (reuse a saved blueprint), creative (design one), ask (the owner picks). Lands in settings.building. */
  building: z.enum(['library', 'creative', 'ask']).optional(),
  /** WorldEdit: true/false forces it on/off (no detection); an object sets { enabled, maxBlocks, ownersOnly, replyMs }. Lands in settings.worldedit. */
  worldedit: z.union([z.boolean(), z.object({ enabled: z.boolean().optional(), maxBlocks: z.number().int().min(1).optional(), ownersOnly: z.boolean().optional(), replyMs: z.number().int().min(200).max(20_000).optional() })]).optional(),
  /** Extra blueprint folders (relative to the profile), added to settings.build.blueprintDirs. */
  blueprints: z.union([z.string(), z.array(z.string())]).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  /** Reflex tuning: { selfDefense, autoEat, eatBelow, retreatBelow (0 = never retreat), waterFightAbove, rangedDefense, air, airBelow }. */
  reflexes: z.object({
    selfDefense: z.boolean().optional(),
    autoEat: z.boolean().optional(),
    eatBelow: z.number().optional(),
    retreatBelow: z.number().optional(),
    waterFightAbove: z.number().optional(),
    rangedDefense: z.boolean().optional(),
    air: z.boolean().optional(),
    airBelow: z.number().min(0).max(20).optional()
  }).optional(),
  /** Retry policies (actions, llm, reconnect); see core/retry.ts. */
  retry: z.object({
    actions: z.record(z.string(), z.number().int().min(0).max(10)).optional(),
    actionBackoffMs: z.tuple([z.number(), z.number()]).optional(),
    llm: z.object({ attempts: z.number().int().min(0).max(10).optional(), backoffMs: z.tuple([z.number(), z.number()]).optional() }).optional(),
    reconnect: z.object({ baseMs: z.number().optional(), maxMs: z.number().optional() }).optional()
  }).optional(),
  /** Player-like timing and habits; true/false or options (see core/humanize.ts). Default: on when llm.immersive. */
  humanize: z.union([z.boolean(), z.object({
    enabled: z.boolean().optional(),
    reactionMs: z.tuple([z.number(), z.number()]).optional(),
    charsPerSec: z.tuple([z.number(), z.number()]).optional(),
    maxDelayMs: z.number().optional(),
    pauseWhileTyping: z.boolean().optional(),
    lookAtSpeaker: z.boolean().optional(),
    actionHesitationMs: z.tuple([z.number(), z.number()]).optional(),
    lowercase: z.boolean().optional(),
    typoRate: z.number().min(0).max(1).optional(),
    idleFidget: z.boolean().optional()
  })]).optional(),
  logging: LoggingSchema.optional(),
  /** Event journal settings (docs/guide/journal.md); false turns it off. Lands in settings.journal. */
  journal: z.union([z.literal(false), z.object({
    enabled: z.boolean().optional(),
    types: z.array(z.string()).optional(),
    exclude: z.array(z.string()).optional(),
    retentionDays: z.number().min(0).optional(),
    rollupRetentionDays: z.number().min(0).optional(),
    flushMs: z.number().min(100).optional(),
    caps: z.record(z.string(), z.number().min(0)).optional(),
    actions: z.object({ includeStatus: z.boolean().optional(), skip: z.array(z.string()).optional() }).optional(),
    observe: z.boolean().optional(),
    placeRegion: z.number().min(16).optional(),
    summarize: z.union([z.boolean(), z.string(), z.object({ provider: z.string() }).passthrough()]).optional()
  }).strict()]).optional(),
  /**
   * Armed behaviours (behaviors brain): `{ name: true | false | { enabled?, ...options } }`.
   * Lands in settings.behaviors; names and options are checked against the behaviour registry
   * when the profile is run (src/brains/behaviors). See docs/guide/behaviors.md.
   */
  behaviors: z.record(z.string(), z.union([z.boolean(), z.null(), z.record(z.string(), z.unknown())])).optional(),
  /**
   * Context pack directory (AGENTS.md, USER.md, skills/, hooks.yaml, MEMORY.md...), see
   * docs/guide/context-pack.md. Default: the sibling directory profiles/<name>/ if it exists.
   * false turns it off. Lands in settings.context as absolute paths.
   */
  context: z.union([
    z.literal(false),
    z.string(),
    z.array(z.string()),
    z.object({
      dirs: z.union([z.string(), z.array(z.string())]).optional(),
      memoryFile: z.union([z.string(), z.literal(false)]).optional(),
      caps: z.record(z.string(), z.number()).optional(),
      watch: z.boolean().optional()
    }).strict()
  ]).optional()
})

export type ProfileFile = z.infer<typeof ProfileSchema>

export interface LoadedProfile {
  name: string
  file: string
  profile: ProfileFile
  options: InstanceOptions
  server: Partial<ServerConfig>
}

export const PROFILES_DIR = 'profiles'

export function profilePath (name: string, dir = PROFILES_DIR): string | null {
  for (const f of [join(dir, `${name}.yaml`), join(dir, `${name}.yml`), name]) {
    if ((f.endsWith('.yaml') || f.endsWith('.yml')) && existsSync(f)) return f
  }
  return null
}

/** Keys zod would drop silently, with a hint for the usual mistakes. */
const HINTS: Record<string, string> = {
  combat: 'combat toggles go under settings: combat:',
  bot: 'the key is variant:'
}

/** settings.combat / mining / mine / trips / inventoryMemory / status keys the code reads (their feature toggles). */
// nested toggles (combat.dodge.arrows) make their first segment a known key (settings.combat.dodge)
const toggleKeys = (group: string) => new Set(TOGGLES.filter(t => t.key.startsWith(`${group}.`)).map(t => t.key.slice(group.length + 1).split('.')[0]!))
const CHECKED_SETTINGS: Record<string, Set<string>> = { combat: toggleKeys('combat'), mining: toggleKeys('mining'), mine: toggleKeys('mine'), trips: toggleKeys('trips'), inventoryMemory: toggleKeys('inventoryMemory'), status: toggleKeys('status'), farming: toggleKeys('farming'), food: toggleKeys('food'), retreat: toggleKeys('retreat'), pickup: toggleKeys('pickup') }

/**
 * Keys in `raw` that `schema` doesn't declare (zod strips them without a word), as dotted paths
 * (see unknownKeys); settings.combat, mining, trips, inventoryMemory and status are checked against their toggles.
 */
export function unknownProfileKeys (raw: unknown, schema: z.ZodType = ProfileSchema): string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  const out = unknownKeys(raw, schema)
  for (const [group, keys] of Object.entries(CHECKED_SETTINGS)) {
    const sub = (raw as { settings?: Record<string, unknown> }).settings?.[group]
    if (sub && typeof sub === 'object' && !Array.isArray(sub)) {
      out.push(...Object.keys(sub).filter(k => !keys.has(k)).map(k => `settings.${group}.${k}`))
    }
  }
  return out
}

export function parseProfile (text: string, name = 'profile', file = '(inline)'): LoadedProfile {
  const raw = YAML.parse(expandEnv(text))
  const profile = ProfileSchema.parse(raw)
  const unknown = unknownProfileKeys(raw)
  if (unknown.length) {
    const log = createLogger('golemkit/profile')
    for (const k of unknown) log.warn(`${file === '(inline)' ? name : file}: unknown key ${k} (ignored)${HINTS[k] ? `; ${HINTS[k]}` : ''}`)
  }
  if (profile.askHelp && typeof profile.askHelp === 'object' && profile.askHelp.enabled === undefined) {
    createLogger('golemkit/profile').warn(`${file === '(inline)' ? name : file}: askHelp has options but no enabled: true, so asking for help stays off`)
  }
  const settings: Record<string, unknown> = { ...profile.settings }
  if (profile.respectBuilds !== undefined) settings.respectBuilds = profile.respectBuilds
  if (profile.selfAware !== undefined) settings.selfAware = profile.selfAware
  if (profile.npcMode !== undefined) settings.npcMode = profile.npcMode
  if (profile.status !== undefined) settings.status = { ...(settings.status as object | undefined), ...(profile.status === true ? {} : profile.status === false ? { file: false, alert: false } : profile.status) }
  if (profile.askHelp !== undefined) settings.askHelp = { ...(settings.askHelp as object | undefined), ...(typeof profile.askHelp === 'boolean' ? { enabled: profile.askHelp } : profile.askHelp) }
  settings.profileName = name   // so the bot can tell which profile it is (observe: profile)
  if (profile.llm) settings.llm = { ...(settings.llm as object | undefined), ...profile.llm }
  if (profile.intents) {
    // layers: [{use, ...}] -> layers: {name: entry} + order, so live toggles (intents.layers.<name>.enabled) merge into it
    const { layers, ...rest } = profile.intents
    const named = layers ? layers.map(l => ({ ...l, name: l.name ?? l.use })) : undefined
    settings.intents = {
      ...(settings.intents as object | undefined),
      ...rest,
      ...(named ? { layers: Object.fromEntries(named.map(l => [l.name, l])), order: named.map(l => l.name) } : {})
    }
  }
  if (profile.humanize !== undefined) settings.humanize = profile.humanize
  if (profile.reflexes) settings.reflexes = { ...(settings.reflexes as object | undefined), ...profile.reflexes }
  if (profile.journal !== undefined) settings.journal = profile.journal === false ? false : { ...(settings.journal as object | undefined), ...profile.journal }
  if (profile.retry) settings.retry = { ...(settings.retry as object | undefined), ...profile.retry }
  if (profile.behaviors) settings.behaviors = { ...(settings.behaviors as object | undefined), ...profile.behaviors }
  if (profile.needs !== undefined) settings.needs = profile.needs === false ? { enabled: false } : { ...(settings.needs as object | undefined), ...profile.needs }
  if (profile.idle !== undefined) settings.idle = typeof profile.idle === 'string' ? { ...(settings.idle as object | undefined), mode: profile.idle } : { ...(settings.idle as object | undefined), ...profile.idle }
  if (profile.sites !== undefined) settings.sites = profile.sites === false ? { enabled: false } : { ...(settings.sites as object | undefined), ...profile.sites }
  if (profile.projects !== undefined) settings.projects = profile.projects === false ? { enabled: false } : { ...(settings.projects as object | undefined), ...profile.projects }
  if (profile.baseSafety !== undefined) settings.baseSafety = profile.baseSafety === false ? { enabled: false } : { ...(settings.baseSafety as object | undefined), ...profile.baseSafety }
  if (profile.materials !== undefined) settings.materials = { ...(settings.materials as object | undefined), ...profile.materials }
  if (profile.deathSpots !== undefined) settings.deathSpots = profile.deathSpots === false ? { enabled: false } : { ...(settings.deathSpots as object | undefined), ...profile.deathSpots }
  if (profile.respawn !== undefined) settings.respawn = profile.respawn === false ? { enabled: false } : { ...(settings.respawn as object | undefined), ...profile.respawn }
  if (profile.building) settings.building = profile.building
  if (profile.worldedit !== undefined) settings.worldedit = { ...(settings.worldedit as object | undefined), ...(typeof profile.worldedit === 'boolean' ? { enabled: profile.worldedit } : profile.worldedit) }
  if (profile.blueprints) {
    const build = (settings.build ?? {}) as { blueprintDirs?: string | string[] }
    settings.build = { ...build, blueprintDirs: [...[build.blueprintDirs ?? []].flat(), ...[profile.blueprints].flat().map(d => resolveDir(d, file))] }
  }
  const context = resolveContext(profile.context, name, file)
  if (context !== undefined) settings.context = context
  return {
    name,
    file,
    profile,
    server: profile.server ?? {},
    options: {
      ...(profile.username ? { username: profile.username } : {}),
      ...(profile.persona ? { persona: profile.persona } : {}),
      ...(profile.owners ? { owners: profile.owners } : {}),
      ...(profile.canDig !== undefined ? { canDig: profile.canDig } : {}),
      settings
    }
  }
}

const CONTEXT_FILES = ['AGENTS.md', 'RULES.md', 'IDENTITY.md', 'SOUL.md', 'USER.md', 'MEMORY.md', 'hooks.yaml', 'hooks.yml', 'skills']

/** Relative paths: next to the profile file, then its parent (repo root), then the working directory. */
function resolveDir (p: string, file: string): string {
  if (isAbsolute(p)) return p
  const base = file === '(inline)' ? [] : [dirname(file), dirname(dirname(file))]
  const found = [...base, process.cwd()].map(b => resolve(b, p)).find(existsSync)
  return found ?? resolve(p)
}

function resolveContext (c: ProfileFile['context'], name: string, file: string): unknown {
  if (c === false) return false
  if (typeof c === 'string') return resolveDir(c, file)
  if (Array.isArray(c)) return c.map(d => resolveDir(d, file))
  if (c && typeof c === 'object') {
    const dirs = c.dirs === undefined ? autoContext(name, file) : [c.dirs].flat().map(d => resolveDir(d, file))
    return { ...c, dirs: dirs ?? [], ...(typeof c.memoryFile === 'string' ? { memoryFile: resolveDir(c.memoryFile, file) } : {}) }
  }
  return autoContext(name, file)
}

/** profiles/<name>/ next to profiles/<name>.yaml, if it holds any context file. */
function autoContext (name: string, file: string): string | undefined {
  if (file === '(inline)') return undefined
  const dir = join(dirname(file), name)
  return CONTEXT_FILES.some(f => existsSync(join(dir, f))) ? resolve(dir) : undefined
}

export function loadProfile (name: string, dir = PROFILES_DIR): LoadedProfile | null {
  const file = profilePath(name, dir)
  if (!file) return null
  return parseProfile(readFileSync(file, 'utf8'), name.replace(/^.*\//, '').replace(/\.ya?ml$/, ''), file)
}

/** Merges instance options: later wins; settings (and settings.llm) merge one level deep. */
export function mergeOptions (...all: (InstanceOptions | undefined)[]): InstanceOptions {
  const out: InstanceOptions = {}
  for (const o of all) {
    if (!o) continue
    for (const [k, v] of Object.entries(o)) if (v !== undefined && k !== 'settings') (out as any)[k] = v
    if (o.settings) {
      const prev = out.settings ?? {}
      const llm = { ...(prev.llm as object | undefined), ...(o.settings.llm as object | undefined) }
      out.settings = { ...prev, ...o.settings, ...(Object.keys(llm).length ? { llm } : {}) }
    }
  }
  return out
}
