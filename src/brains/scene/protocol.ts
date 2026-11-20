// Fleet topics, blackboard layout and casting rules shared by the runtime and the director.
import type { Scene } from './types.ts'

/** Blackboard keys (per server). */
export const BOARD = {
  /** Record<username, ActorEntry>: every bot with the scene brain. */
  actors: 'scene:actors',
  /** Record<runId, RunInfo>: running scenes. */
  runs: 'scene:runs',
  /** RunSummary of the last finished run. */
  last: 'scene:last'
} as const

export const TOPIC = {
  /** director -> member: perform a command. */
  do: 'scene:do',
  /** member -> director: command finished. */
  done: 'scene:done',
  /** director -> member: cancel the run's actions (or one beat's). */
  cancel: 'scene:cancel',
  /** member -> director: a player did something near a cast member. */
  player: 'scene:player',
  /** broadcast: a cue fired. Other brains may listen; awaits also accept external cues. */
  cue: 'scene:cue',
  /** any bot -> coordinator: start/stop request. */
  request: 'scene:request',
  /** coordinator -> director: run this cast. */
  direct: 'scene:direct',
  /** reply to request/direct. */
  reply: 'scene:reply'
} as const

export interface ActorEntry {
  online: boolean
  /** Explicit director: directs every scene while online. */
  director: boolean
  /** Action names the bot has, for role requirements. */
  actions: string[]
  /** Run the bot is cast in. */
  busyIn?: string
  /** Roles this bot likes to play (casting gives it these first, after a scene's own `prefer`). */
  roles?: string[]
}

export type RunStatus = 'starting' | 'running' | 'paused' | 'recasting' | 'reacting' | 'stopping'

export interface RunInfo {
  runId: string
  scene: string
  director: string
  /** Role -> username. */
  cast: Record<string, string>
  status: RunStatus
  /** Path of the last body beat started, e.g. "beats[4]" (with its role). */
  beat?: string
  startedAt: number
  by?: string
  /** Largest approach radius among the scene's interactions (members use it for detection). */
  approachRadius?: number
  /** Whether the scene listens to chat / hits at all. */
  listens: { chat: boolean, hit: boolean }
}

export interface RunSummary {
  runId: string
  scene: string
  result: 'finished' | 'stopped' | 'aborted'
  reason?: string
  endedAt: number
}

export type Command =
  | { kind: 'act', name: string, params: Record<string, unknown>, player?: string, busyWaitMs: number }
  | { kind: 'say', text: string, whisperTo?: string }

export type DoneStatus = 'ok' | 'failed' | 'busy' | 'preempted' | 'cancelled' | 'timeout'

export interface Done {
  status: DoneStatus
  message: string
}

export interface DoMsg { runId: string, beatId: number, cmd: Command }
export interface DoneMsg extends Done { runId: string, beatId: number }
export interface CancelMsg { runId: string, beatId?: number }
export interface PlayerMsg {
  runId: string
  trigger: 'approach' | 'chat' | 'hit'
  player: string
  /** Cast member that noticed. */
  member: string
  distance: number
  message?: string
  /** The chat message named a cast member or role. */
  mentioned?: boolean
}
export interface RequestMsg { reqId: string, op: 'start' | 'stop', scene?: string, by?: string, sceneData?: Scene, player?: string }
export type DirectMsg =
  | { reqId: string, runId: string, stop?: false, scene: Scene, cast: Record<string, string>, by?: string, player?: string }
  | { reqId: string, runId: string, stop: true, reason?: string }
export interface ReplyMsg { reqId: string, ok: boolean, message: string }

/** Caller name for actions of a run (and beat). The prefix identifies everything a run started. */
export const callerName = (runId: string, beatId?: number) => beatId === undefined ? `scene:${runId}:` : `scene:${runId}:${beatId}`

export const sortNames = (names: string[]) => [...names].sort((a, b) => a.localeCompare(b, 'en'))

function eligible (actors: Record<string, ActorEntry>, name: string, requires: string[] = []): boolean {
  const a = actors[name]
  return !!a && a.online && !a.busyIn && requires.every(r => a.actions.includes(r))
}

export type CastResult = { ok: true, cast: Record<string, string> } | { ok: false, error: string }

/**
 * Assigns roles deterministically. Pass 1 gives roles their preferred bots (in role order):
 * the scene's `prefer` list first, then bots that list the role in their own `roles`;
 * pass 2 fills the rest in role order with the lowest-named eligible bot. Optional roles may
 * stay empty; a required role that can't be filled fails the whole cast.
 */
export function castRoles (scene: Pick<Scene, 'roles'>, actors: Record<string, ActorEntry>, opts: { exclude?: string[], only?: string[] } = {}): CastResult {
  const used = new Set(opts.exclude ?? [])
  const cast: Record<string, string> = {}
  const roles = Object.entries(scene.roles).filter(([r]) => !opts.only || opts.only.includes(r))
  const pool = sortNames(Object.keys(actors))
  for (const [role, spec] of roles) {
    const fans = pool.filter(n => actors[n]!.roles?.includes(role))
    const pick = [...(spec.prefer ?? []), ...fans].find(n => !used.has(n) && eligible(actors, n, spec.requires))
    if (pick) { cast[role] = pick; used.add(pick) }
  }
  for (const [role, spec] of roles) {
    if (cast[role]) continue
    const pick = pool.find(n => !used.has(n) && eligible(actors, n, spec.requires))
    if (pick) { cast[role] = pick; used.add(pick); continue }
    if (!spec.optional) {
      const need = spec.requires?.length ? ` with ${spec.requires.join(', ')}` : ''
      return { ok: false, error: `no free actor for role ${role}${need}` }
    }
  }
  return { ok: true, cast }
}

/** Explicit director bots win (lowest name among them), otherwise the lowest name in the group. */
export function electDirector (group: string[], actors: Record<string, ActorEntry>): string | undefined {
  const explicit = sortNames(Object.entries(actors).filter(([, a]) => a.online && a.director).map(([n]) => n))
  return explicit[0] ?? sortNames(group)[0]
}

/** The coordinator handles start/stop requests and the scheduler: elected among online actors. */
export function electCoordinator (actors: Record<string, ActorEntry>): string | undefined {
  return electDirector(Object.entries(actors).filter(([, a]) => a.online).map(([n]) => n), actors)
}
