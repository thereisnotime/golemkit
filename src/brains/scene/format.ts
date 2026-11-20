// Scene parsing and validation. Top-level fields go through zod; beats are parsed recursively
// by kind (each beat is an object with exactly one kind key), so errors carry a path like
// `beats[3].parallel[1][0]`. References (roles, marks, cues) are checked afterwards.
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, extname } from 'node:path'
import YAML from 'yaml'
import { z } from 'zod'
import {
  BEAT_KINDS, DEFAULT_SCENE_OPTIONS,
  type Beat, type BeatKind, type Scene, type SceneInput, type InteractionSpec
} from './types.ts'

export class SceneValidationError extends Error {
  readonly issues: string[]
  constructor (scene: string, issues: string[]) {
    super(`scene ${scene}: ${issues.join('; ')}`)
    this.name = 'SceneValidationError'
    this.issues = issues
  }
}

const range = z.union([z.number().nonnegative(), z.tuple([z.number().nonnegative(), z.number().nonnegative()])])
const name = z.string().min(1)
const base = { as: name.optional(), timeoutMs: z.number().positive().optional(), optional: z.boolean().optional() }

// Per-kind schemas for the leaf part of each beat; nested beat lists are parsed separately.
const leafSchemas: Record<BeatKind, z.ZodObject> = {
  say: z.strictObject({ ...base, say: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]), whisper: z.boolean().optional(), typingMs: range.optional() }),
  act: z.strictObject({ ...base, act: name, params: z.record(z.string(), z.unknown()).optional() }),
  goto: z.strictObject({ ...base, goto: name, range: z.number().positive().optional() }),
  look: z.strictObject({ ...base, look: name }),
  gesture: z.strictObject({ ...base, gesture: z.enum(['swing', 'crouch', 'nod', 'shake', 'spin', 'jump']), times: z.number().int().min(1).max(10).optional() }),
  wait: z.strictObject({ ...base, wait: range }),
  cue: z.strictObject({ ...base, cue: name }),
  await: z.strictObject({ ...base, await: name }),
  parallel: z.strictObject({ ...base, parallel: z.array(z.unknown()).min(1) }),
  repeat: z.strictObject({
    ...base,
    repeat: z.strictObject({ times: range.optional(), forMs: range.optional(), beats: z.array(z.unknown()) })
  }),
  choose: z.strictObject({ ...base, choose: z.array(z.strictObject({ weight: z.number().positive().optional(), beats: z.array(z.unknown()) })).min(1) }),
  if: z.strictObject({
    ...base,
    if: z.strictObject({
      key: z.string().optional(),
      equals: z.unknown().optional(),
      notEquals: z.unknown().optional(),
      exists: z.boolean().optional(),
      gt: z.number().optional(),
      lt: z.number().optional(),
      chance: z.number().min(0).max(1).optional()
    }),
    then: z.array(z.unknown()),
    else: z.array(z.unknown()).optional()
  }),
  set: z.strictObject({ ...base, set: z.record(z.string(), z.unknown()) })
}

const InteractionSchema = z.strictObject({
  on: z.enum(['approach', 'chat', 'hit']),
  radius: z.number().positive().optional(),
  match: z.string().optional(),
  mode: z.enum(['pause', 'aside']).optional(),
  then: z.enum(['resume', 'stop']).optional(),
  cooldownMs: z.number().nonnegative().optional(),
  perPlayerCooldownMs: z.number().nonnegative().optional(),
  beats: z.array(z.unknown())
})

const TimeName = z.enum(['dawn', 'morning', 'noon', 'dusk', 'night', 'midnight'])

export const SceneFileSchema = z.strictObject({
  name: z.string().regex(/^[a-z0-9_-]+$/i, 'letters, digits, _ and - only'),
  description: z.string().optional(),
  roles: z.record(z.string().regex(/^[a-z0-9_]+$/i), z.strictObject({
    description: z.string().optional(),
    requires: z.array(z.string()).optional(),
    prefer: z.array(z.string()).optional(),
    optional: z.boolean().optional()
  }).nullable().transform(v => v ?? {})).refine(r => Object.keys(r).length > 0, 'at least one role'),
  anchor: z.union([
    z.strictObject({ pos: z.tuple([z.number(), z.number(), z.number()]) }),
    z.strictObject({ role: z.string() }),
    z.strictObject({ player: z.string(), radius: z.number().positive().optional() })
  ]).optional(),
  marks: z.record(z.string(), z.union([z.tuple([z.number(), z.number()]), z.tuple([z.number(), z.number(), z.number()])])).optional(),
  beats: z.array(z.unknown()).optional(),
  tracks: z.record(z.string(), z.array(z.unknown())).optional(),
  interactions: z.array(InteractionSchema).optional(),
  schedule: z.strictObject({
    everyMs: z.number().positive().optional(),
    jitterMs: z.number().nonnegative().optional(),
    at: z.array(z.union([TimeName, z.number().int().min(0).max(23999)])).optional(),
    whenPlayersNear: z.number().positive().optional(),
    requirePlayersNear: z.number().positive().optional(),
    ambient: z.boolean().optional(),
    chance: z.number().min(0).max(1).optional(),
    cooldownMs: z.number().nonnegative().optional()
  }).optional(),
  vars: z.record(z.string(), z.unknown()).optional(),
  options: z.strictObject({
    lineGapMs: z.number().nonnegative(),
    botLineGapMs: z.number().nonnegative(),
    typingMsPerChar: z.number().nonnegative(),
    beatTimeoutMs: z.number().positive(),
    busyWaitMs: z.number().nonnegative(),
    recastTimeoutMs: z.number().nonnegative(),
    maxDurationMs: z.number().positive(),
    maxReactions: z.number().int().nonnegative(),
    awaitTimeoutMs: z.number().positive()
  }).partial().optional()
})

function zodIssues (err: z.ZodError, prefix: string): string[] {
  return err.issues.map(i => {
    const p = i.path.map(k => typeof k === 'number' ? `[${k}]` : `.${String(k)}`).join('')
    return `${prefix}${p}: ${i.message}`
  })
}

function parseBeats (raw: unknown[], path: string, issues: string[]): Beat[] {
  const out: Beat[] = []
  raw.forEach((b, i) => {
    const beat = parseBeat(b, `${path}[${i}]`, issues)
    if (beat) out.push(beat)
  })
  return out
}

function parseBeat (raw: unknown, path: string, issues: string[]): Beat | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    issues.push(`${path}: a beat must be an object like { say: "..." }`)
    return undefined
  }
  const kinds = BEAT_KINDS.filter(k => k in raw)
  if (kinds.length !== 1) {
    issues.push(`${path}: ${kinds.length ? `has several beat kinds (${kinds.join(', ')})` : `no beat kind (one of ${BEAT_KINDS.join(', ')})`}`)
    return undefined
  }
  const kind = kinds[0]!
  const r = leafSchemas[kind].safeParse(raw)
  if (!r.success) {
    issues.push(...zodIssues(r.error, path))
    return undefined
  }
  const d = r.data as Record<string, any>
  switch (kind) {
    case 'parallel':
      d.parallel = (d.parallel as unknown[]).map((branch, i) =>
        parseBeats(Array.isArray(branch) ? branch : [branch], `${path}.parallel[${i}]`, issues))
      break
    case 'repeat':
      d.repeat.beats = parseBeats(d.repeat.beats, `${path}.repeat.beats`, issues)
      break
    case 'choose':
      d.choose = (d.choose as { weight?: number, beats: unknown[] }[]).map((c, i) => ({ ...c, beats: parseBeats(c.beats, `${path}.choose[${i}].beats`, issues) }))
      break
    case 'if':
      d.then = parseBeats(d.then, `${path}.then`, issues)
      if (d.else) d.else = parseBeats(d.else, `${path}.else`, issues)
      break
  }
  return d as Beat
}

/** Calls fn for every beat in the tree with its path and the role it runs as (if known). */
export function walkBeats (beats: Beat[], path: string, role: string | undefined, fn: (b: Beat, path: string, role: string | undefined) => void): void {
  beats.forEach((b, i) => {
    const p = `${path}[${i}]`
    const r = b.as ?? role
    fn(b, p, r)
    if ('parallel' in b) b.parallel.forEach((br, j) => walkBeats(br, `${p}.parallel[${j}]`, r, fn))
    else if ('repeat' in b) walkBeats(b.repeat.beats, `${p}.repeat.beats`, r, fn)
    else if ('choose' in b) b.choose.forEach((c, j) => walkBeats(c.beats, `${p}.choose[${j}].beats`, r, fn))
    else if ('if' in b) {
      walkBeats(b.then, `${p}.then`, r, fn)
      if (b.else) walkBeats(b.else, `${p}.else`, r, fn)
    }
  })
}

const BODY_KINDS = new Set(['say', 'act', 'goto', 'look', 'gesture'])
const SPECIAL_TARGETS = new Set(['player', 'anchor'])

function checkReferences (s: Scene, issues: string[]): void {
  const roles = new Set(Object.keys(s.roles))
  const marks = new Set(Object.keys(s.marks))
  for (const m of marks) {
    if (roles.has(m)) issues.push(`marks.${m}: a mark can't have the same name as a role`)
    if (SPECIAL_TARGETS.has(m)) issues.push(`marks.${m}: "${m}" is reserved`)
  }
  for (const r of Object.keys(s.tracks)) if (!roles.has(r)) issues.push(`tracks.${r}: unknown role "${r}"`)
  if (s.anchor && 'role' in s.anchor && !roles.has(s.anchor.role)) issues.push(`anchor.role: unknown role "${s.anchor.role}"`)
  for (const [r, spec] of Object.entries(s.roles)) {
    if (spec.optional && s.anchor && 'role' in s.anchor && s.anchor.role === r) issues.push(`roles.${r}: the anchor role can't be optional`)
  }

  const cues = new Set<string>()
  const awaits: [string, string][] = []
  const visit = (interaction: boolean) => (b: Beat, path: string, role: string | undefined) => {
    if (b.as !== undefined && !roles.has(b.as)) issues.push(`${path}: unknown role "${b.as}"`)
    const kind = BEAT_KINDS.find(k => k in b)!
    // Interaction beats default to the role the player addressed, so they may omit `as`.
    if (BODY_KINDS.has(kind) && !role && !interaction) issues.push(`${path}: ${kind} needs "as: <role>" outside a role track`)
    if ('goto' in b || 'look' in b) {
      const t = 'goto' in b ? b.goto : (b as { look: string }).look
      if (!roles.has(t) && !marks.has(t) && !SPECIAL_TARGETS.has(t)) issues.push(`${path}: unknown target "${t}" (not a role, mark, "player" or "anchor")`)
    }
    if ('cue' in b) cues.add(b.cue)
    if ('await' in b) awaits.push([b.await, path])
    if ('if' in b && b.if.key === undefined && b.if.chance === undefined) issues.push(`${path}.if: needs a key or a chance`)
    if ('wait' in b && Array.isArray(b.wait) && b.wait[0] > b.wait[1]) issues.push(`${path}.wait: min is greater than max`)
  }
  walkBeats(s.beats, 'beats', undefined, visit(false))
  for (const [r, beats] of Object.entries(s.tracks)) walkBeats(beats, `tracks.${r}`, r, visit(false))
  s.interactions.forEach((it, i) => {
    walkBeats(it.beats, `interactions[${i}].beats`, undefined, visit(true))
    if (it.match) {
      try { new RegExp(it.match, 'i') } catch { issues.push(`interactions[${i}].match: invalid regex`) }
    }
  })
  // Awaits may also be satisfied by an external fleet cue, so a missing cue is only an error
  // when nothing in the scene could ever fire it and it isn't namespaced as external ("ext:").
  for (const [a, path] of awaits) {
    if (!cues.has(a) && !a.startsWith('ext:')) issues.push(`${path}: awaits cue "${a}" that no beat fires (prefix external cues with "ext:")`)
  }
}

/** Validates and normalises a scene (TS object or parsed YAML). Throws SceneValidationError. */
export function parseScene (input: unknown, source = 'scene'): Scene {
  const r = SceneFileSchema.safeParse(input)
  const label = (input as { name?: unknown } | null)?.name ? String((input as { name: unknown }).name) : source
  if (!r.success) throw new SceneValidationError(label, zodIssues(r.error, ''))
  const f = r.data
  const issues: string[] = []
  const beats = parseBeats(f.beats ?? [], 'beats', issues)
  const tracks: Record<string, Beat[]> = {}
  for (const [role, list] of Object.entries(f.tracks ?? {})) tracks[role] = parseBeats(list, `tracks.${role}`, issues)
  const interactions: InteractionSpec[] = (f.interactions ?? []).map((it, i) => ({
    ...it,
    beats: parseBeats(it.beats, `interactions[${i}].beats`, issues)
  }))
  if (!beats.length && !Object.keys(tracks).length) issues.push('needs beats or tracks')
  const scene: Scene = {
    name: f.name,
    ...(f.description ? { description: f.description } : {}),
    roles: f.roles,
    ...(f.anchor ? { anchor: f.anchor } : {}),
    marks: f.marks ?? {},
    beats,
    tracks,
    interactions,
    ...(f.schedule ? { schedule: f.schedule } : {}),
    vars: f.vars ?? {},
    options: { ...DEFAULT_SCENE_OPTIONS, ...f.options }
  }
  if (!issues.length) checkReferences(scene, issues)
  if (issues.length) throw new SceneValidationError(label, issues)
  return scene
}

/** Identity with types, validated: `export default defineScene({...})`. */
export function defineScene (input: SceneInput): Scene {
  return parseScene(input)
}

export function parseSceneYaml (text: string, source = 'scene.yaml'): Scene {
  let data: unknown
  try {
    data = YAML.parse(text)
  } catch (e) {
    throw new SceneValidationError(source, [`YAML: ${(e as Error).message}`])
  }
  return parseScene(data, source)
}

/**
 * Loads every `*.yaml` / `*.yml` scene in a directory. Invalid files are reported through
 * onError (default: thrown) so one broken scene doesn't hide the rest.
 */
export function loadSceneDir (dir: string, onError?: (file: string, err: Error) => void): Scene[] {
  if (!existsSync(dir)) return []
  const out: Scene[] = []
  for (const file of readdirSync(dir).sort()) {
    if (!['.yaml', '.yml'].includes(extname(file))) continue
    const path = join(dir, file)
    try {
      out.push(parseSceneYaml(readFileSync(path, 'utf8'), file))
    } catch (e) {
      if (!onError) throw e
      onError(file, e as Error)
    }
  }
  return out
}
