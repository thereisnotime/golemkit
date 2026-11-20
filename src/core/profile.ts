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
import { join } from 'node:path'
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
  listen: z.enum(['mention', 'conversation', 'all']).optional(),
  immersive: z.boolean().optional().describe('stay in character; default false (factual, openly a bot)'),
  aliases: z.array(z.string()).optional(),
  conversationMs: z.number().optional(),
  ownersOnly: z.boolean().optional(),
  tickMs: z.number().optional(),
  ambientBatchMs: z.number().optional(),
  ambientMinGapMs: z.number().optional(),
  budget: z.record(z.string(), z.number()).optional()
}).passthrough()

export const ProfileSchema = z.object({
  variant: z.string().describe('variant name (variants/<name>.ts) or path'),
  description: z.string().optional(),
  username: z.string().optional(),
  owners: z.array(z.string()).optional(),
  canDig: z.boolean().optional(),
  persona: z.string().optional(),
  server: z.object({
    host: z.string().optional(),
    port: z.number().int().optional(),
    auth: z.enum(['offline', 'microsoft']).optional(),
    version: z.string().optional()
  }).optional(),
  llm: LlmProfileSchema.optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
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
  logging: LoggingSchema.optional()
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
  if (profile.llm) settings.llm = { ...(settings.llm as object | undefined), ...profile.llm }
  if (profile.humanize !== undefined) settings.humanize = profile.humanize
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
