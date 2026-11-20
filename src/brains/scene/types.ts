// Scene data model. Scenes are plain data (TS objects or YAML) so they can be written without
// touching the engine; see docs/scenes.md for the full reference.

/** A fixed number, or a [min, max] range picked uniformly each time. */
export type Range = number | [number, number]

/** Offset from the anchor: [dx, dz] (walk to the surface) or [dx, dy, dz]. */
export type MarkOffset = [number, number] | [number, number, number]

export interface RoleSpec {
  description?: string
  /** Action names the bot must have to take this role (e.g. ['follow']). */
  requires?: string[]
  /** Usernames that should get this role when available, in order. */
  prefer?: string[]
  /** The scene can run without this role; its beats are skipped. */
  optional?: boolean
}

/**
 * Where the scene is staged. Marks are offsets from here.
 * - `{ pos: [x, y, z] }` fixed world position
 * - `{ role: 'hauler' }` where that cast member stands when the scene starts
 * - `{ player: 'nearest' | '<name>', radius? }` a player near the cast
 */
export type AnchorSpec =
  | { pos: [number, number, number] }
  | { role: string }
  | { player: string, radius?: number }

/**
 * Where a goto/look points: a mark name, a role name (that bot), `player` (the player the
 * scene is reacting to, or the nearest one), or `anchor`.
 */
export type Target = string

export interface BeatBase {
  /** Role performing the beat. Defaults to the track's role inside `tracks`. */
  as?: string
  /** Give up on the beat after this long (default from scene options). */
  timeoutMs?: number
  /** Purely informational: failures of every beat are logged and skipped anyway. */
  optional?: boolean
}

export interface SayBeat extends BeatBase {
  /** A line, or several to pick from at random. Supports {player}, {me}, {role:x}, {$var}, {scene}. */
  say: string | string[]
  /** Whisper to the player instead of public chat. */
  whisper?: boolean
  /** Delay before the line is sent; default scales with its length. */
  typingMs?: Range
}

export interface ActBeat extends BeatBase {
  /** Any action name the bot has (goto, look_at, follow, jump, drop, equip, ...). */
  act: string
  /** Parameters; string values are templated like lines. */
  params?: Record<string, unknown>
}

export interface GotoBeat extends BeatBase {
  goto: Target
  /** How close is close enough, in blocks. Default 1.5 for marks, 2 for bots/players. */
  range?: number
}

export interface LookBeat extends BeatBase {
  look: Target
}

export type Gesture = 'swing' | 'crouch' | 'nod' | 'shake' | 'spin' | 'jump'

export interface GestureBeat extends BeatBase {
  gesture: Gesture
  times?: number
}

export interface WaitBeat extends BeatBase {
  wait: Range
}

export interface CueBeat extends BeatBase {
  /** Fires a named sync point (also broadcast on the fleet bus as topic `scene:cue`). */
  cue: string
}

export interface AwaitBeat extends BeatBase {
  /** Blocks until the named cue fired in this run (or anyone broadcasts it). */
  await: string
}

export interface ParallelBeat extends BeatBase {
  /** Branches run at the same time; the beat ends when all of them end. */
  parallel: Beat[][]
}

export interface RepeatBeat extends BeatBase {
  repeat: {
    /** How many times (a range picks once). Omit both times and forMs to loop until stopped. */
    times?: Range
    /** Keep looping for this long (checked between iterations). */
    forMs?: Range
    beats: Beat[]
  }
}

export interface ChooseBeat extends BeatBase {
  /** Runs one branch, picked at random by weight (default 1). */
  choose: { weight?: number, beats: Beat[] }[]
}

export interface Condition {
  /** Key to test: `$name` for scene variables, anything else is the server blackboard. */
  key?: string
  equals?: unknown
  notEquals?: unknown
  exists?: boolean
  gt?: number
  lt?: number
  /** Passes with this probability (0..1); combined with the other tests. */
  chance?: number
}

export interface IfBeat extends BeatBase {
  if: Condition
  then: Beat[]
  else?: Beat[]
}

export interface SetBeat extends BeatBase {
  /** Sets scene variables (`$name`) or blackboard keys. */
  set: Record<string, unknown>
}

export type Beat =
  | SayBeat | ActBeat | GotoBeat | LookBeat | GestureBeat | WaitBeat | CueBeat | AwaitBeat
  | ParallelBeat | RepeatBeat | ChooseBeat | IfBeat | SetBeat

export const BEAT_KINDS = ['say', 'act', 'goto', 'look', 'gesture', 'wait', 'cue', 'await', 'parallel', 'repeat', 'choose', 'if', 'set'] as const
export type BeatKind = typeof BEAT_KINDS[number]

export type InteractionTrigger = 'approach' | 'chat' | 'hit'

export interface InteractionSpec {
  on: InteractionTrigger
  /** approach: trigger distance (default 6). chat: hearing distance (default 12); naming a cast member always counts. */
  radius?: number
  /** chat only: case-insensitive regex the message must match. */
  match?: string
  /** pause (default): pause the timeline, react, resume. aside: react without pausing. */
  mode?: 'pause' | 'aside'
  /** After reacting: resume (default) or stop the scene. */
  then?: 'resume' | 'stop'
  /** Minimum gap between two runs of this interaction (default 30 s). */
  cooldownMs?: number
  /** Minimum gap per player (default 120 s). */
  perPlayerCooldownMs?: number
  /** Role that reacts when beats omit `as`: the one the player addressed/approached by default. */
  beats: Beat[]
}

export type TimeOfDay = 'dawn' | 'morning' | 'noon' | 'dusk' | 'night' | 'midnight'

export interface ScheduleSpec {
  /** Start every N ms (plus jitter). */
  everyMs?: number
  jitterMs?: number
  /** Start at these game times (names or ticks 0..23999), once per in-game day each. */
  at?: (TimeOfDay | number)[]
  /** Start when a player comes within this many blocks of an idle actor. */
  whenPlayersNear?: number
  /** Only start (by any trigger) when a player is within this many blocks of an actor. */
  requirePlayersNear?: number
  /** May be picked as idle filler when no scene is running. */
  ambient?: boolean
  /** Probability that a trigger actually starts the scene (default 1). */
  chance?: number
  /** Minimum gap between two scheduled runs of this scene (default 5 min). */
  cooldownMs?: number
}

export interface SceneOptions {
  /** Minimum gap between any two lines of the cast (default 1600). */
  lineGapMs: number
  /** Minimum gap between two lines of the same bot (default 2000). */
  botLineGapMs: number
  /** Typing delay per character when a say beat has no typingMs (default 35, clamped 400..2500; 0 = none). */
  typingMsPerChar: number
  /** Default per-beat timeout for act/goto beats (default 45000). */
  beatTimeoutMs: number
  /** How long a beat waits for a busy bot (higher-priority action) before skipping (default 8000). */
  busyWaitMs: number
  /** How long to look for a replacement when a cast member drops (default 20000). */
  recastTimeoutMs: number
  /** Hard limit on a run (default 10 min). */
  maxDurationMs: number
  /** Max player reactions per run (default 4). */
  maxReactions: number
  /** Default await timeout (default 60000). */
  awaitTimeoutMs: number
}

export interface Scene {
  name: string
  description?: string
  roles: Record<string, RoleSpec>
  anchor?: AnchorSpec
  marks: Record<string, MarkOffset>
  /** Main timeline. */
  beats: Beat[]
  /** Per-role timelines that run alongside the main one. */
  tracks: Record<string, Beat[]>
  interactions: InteractionSpec[]
  schedule?: ScheduleSpec
  /** Initial scene variables (`$name` in conditions and lines, without the `$` here). */
  vars: Record<string, unknown>
  options: SceneOptions
}

/** What scene authors write: everything except name/roles/beats is optional. */
export interface SceneInput {
  name: string
  description?: string
  roles: Record<string, RoleSpec>
  anchor?: AnchorSpec
  marks?: Record<string, MarkOffset>
  beats?: Beat[]
  tracks?: Record<string, Beat[]>
  interactions?: InteractionSpec[]
  schedule?: ScheduleSpec
  vars?: Record<string, unknown>
  options?: Partial<SceneOptions>
}

export const DEFAULT_SCENE_OPTIONS: SceneOptions = {
  lineGapMs: 1600,
  botLineGapMs: 2000,
  typingMsPerChar: 35,
  beatTimeoutMs: 45_000,
  busyWaitMs: 8000,
  recastTimeoutMs: 20_000,
  maxDurationMs: 10 * 60_000,
  maxReactions: 4,
  awaitTimeoutMs: 60_000
}

/** Input to a lineProvider: the default line is already picked and templated. */
export interface LineRequest {
  scene: string
  role: string
  speaker: string
  /** The line the engine would say. */
  line: string
  /** All authored variants, templated. */
  variants: string[]
  player?: string
  vars: Record<string, unknown>
  /** Role name -> username. */
  cast: Record<string, string>
  /** 'beat' for the timeline, or the interaction trigger. */
  context: 'beat' | InteractionTrigger
  /** Chat message that triggered a chat interaction. */
  message?: string
}

/** Returns a replacement line, or nothing to keep the default. */
export type LineProvider = (req: LineRequest) => string | undefined | null | Promise<string | undefined | null>
