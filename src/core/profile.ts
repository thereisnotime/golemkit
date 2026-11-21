// Profiles (profiles/<name>.yaml): a named, saved instance of a variant.
//
//   variant: companion
//   username: Pax
//   owners: [robin]
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
import { LoggingSchema } from './fleetFile.ts'

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
    budgetReserve: z.number().min(0).max(1).optional()
  }).optional().describe('persistent goals and continuation guardrails')
}).passthrough()

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
  /** While the LLM is paused (quota/budget): false, or { arm: { behaviour: options } } (default: return_home, sleep_at_night, chop_wood_loop, deposit_when_full). */
  npcMode: z.union([z.literal(false), z.object({ arm: z.record(z.string(), z.record(z.string(), z.unknown())) })]).optional(),
  persona: z.string().optional(),
  server: z.object({
    host: z.string().optional(),
    port: z.number().int().optional(),
    auth: z.enum(['offline', 'microsoft']).optional(),
    version: z.string().optional()
  }).optional(),
  llm: LlmProfileSchema.optional(),
  /** Building policy: library (reuse a saved blueprint), creative (design one), ask (the owner picks). Lands in settings.building. */
  building: z.enum(['library', 'creative', 'ask']).optional(),
  /** WorldEdit: true/false forces it on/off (no detection); an object sets { enabled, maxBlocks, ownersOnly, replyMs }. Lands in settings.worldedit. */
  worldedit: z.union([z.boolean(), z.object({ enabled: z.boolean().optional(), maxBlocks: z.number().int().min(1).optional(), ownersOnly: z.boolean().optional(), replyMs: z.number().int().min(200).max(20_000).optional() })]).optional(),
  /** Extra blueprint folders (relative to the profile), added to settings.build.blueprintDirs. */
  blueprints: z.union([z.string(), z.array(z.string())]).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  /** Reflex tuning: { selfDefense, autoEat, eatBelow, retreatBelow (0 = never retreat), waterFightAbove }. */
  reflexes: z.object({
    selfDefense: z.boolean().optional(),
    autoEat: z.boolean().optional(),
    eatBelow: z.number().optional(),
    retreatBelow: z.number().optional(),
    waterFightAbove: z.number().optional()
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

export function parseProfile (text: string, name = 'profile', file = '(inline)'): LoadedProfile {
  const profile = ProfileSchema.parse(YAML.parse(text))
  const settings: Record<string, unknown> = { ...profile.settings }
  if (profile.respectBuilds !== undefined) settings.respectBuilds = profile.respectBuilds
  if (profile.selfAware !== undefined) settings.selfAware = profile.selfAware
  if (profile.npcMode !== undefined) settings.npcMode = profile.npcMode
  settings.profileName = name   // so the bot can tell which profile it is (observe: profile)
  if (profile.llm) settings.llm = { ...(settings.llm as object | undefined), ...profile.llm }
  if (profile.humanize !== undefined) settings.humanize = profile.humanize
  if (profile.reflexes) settings.reflexes = { ...(settings.reflexes as object | undefined), ...profile.reflexes }
  if (profile.journal !== undefined) settings.journal = profile.journal === false ? false : { ...(settings.journal as object | undefined), ...profile.journal }
  if (profile.retry) settings.retry = { ...(settings.retry as object | undefined), ...profile.retry }
  if (profile.behaviors) settings.behaviors = { ...(settings.behaviors as object | undefined), ...profile.behaviors }
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
