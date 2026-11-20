// Typed builder for scenes written in TS. Produces the same data as YAML and validates it.
//
//   const cart = scene('broken_cart', 'A cart breaks down')
//     .role('hauler').role('foreman').role('miner')
//     .anchor({ role: 'hauler' })
//     .mark('cart', 0, 0).mark('pile', 6, 3)
//     .beats(
//       b.say('hauler', 'The wheel! Not again...'),
//       b.parallel([b.goto('miner', 'pile')], [b.look('foreman', 'hauler')]),
//     )
//     .build()
import { defineScene } from './format.ts'
import type {
  AnchorSpec, Beat, BeatBase, Condition, Gesture, InteractionSpec, MarkOffset, Range, RoleSpec,
  Scene, SceneInput, SceneOptions, ScheduleSpec, Target
} from './types.ts'

type Extra = Omit<BeatBase, 'as'>

/** Beat constructors. The first argument is the role for body beats. */
export const b = {
  say: (as: string, line: string | string[], opts: Extra & { whisper?: boolean, typingMs?: Range } = {}): Beat => ({ as, say: line, ...opts }),
  act: (as: string, act: string, params?: Record<string, unknown>, opts: Extra = {}): Beat => ({ as, act, ...(params ? { params } : {}), ...opts }),
  goto: (as: string, target: Target, opts: Extra & { range?: number } = {}): Beat => ({ as, goto: target, ...opts }),
  look: (as: string, target: Target, opts: Extra = {}): Beat => ({ as, look: target, ...opts }),
  gesture: (as: string, gesture: Gesture, times?: number): Beat => ({ as, gesture, ...(times ? { times } : {}) }),
  wait: (ms: Range): Beat => ({ wait: ms }),
  cue: (name: string): Beat => ({ cue: name }),
  /** `await` is reserved in JS, hence the name. */
  awaitCue: (name: string, timeoutMs?: number): Beat => ({ await: name, ...(timeoutMs ? { timeoutMs } : {}) }),
  parallel: (...branches: Beat[][]): Beat => ({ parallel: branches }),
  repeat: (times: Range | undefined, beats: Beat[], forMs?: Range): Beat => ({ repeat: { ...(times !== undefined ? { times } : {}), ...(forMs !== undefined ? { forMs } : {}), beats } }),
  choose: (...options: { weight?: number, beats: Beat[] }[]): Beat => ({ choose: options }),
  when: (cond: Condition, then: Beat[], otherwise?: Beat[]): Beat => ({ if: cond, then, ...(otherwise ? { else: otherwise } : {}) }),
  set: (vars: Record<string, unknown>): Beat => ({ set: vars })
}

export class SceneBuilder {
  private data: SceneInput & { roles: Record<string, RoleSpec>, marks: Record<string, MarkOffset>, beats: Beat[], tracks: Record<string, Beat[]>, interactions: InteractionSpec[] }

  constructor (name: string, description?: string) {
    this.data = { name, ...(description ? { description } : {}), roles: {}, marks: {}, beats: [], tracks: {}, interactions: [] }
  }

  role (name: string, spec: RoleSpec = {}): this { this.data.roles[name] = spec; return this }
  anchor (anchor: AnchorSpec): this { this.data.anchor = anchor; return this }
  mark (name: string, dx: number, dyOrDz: number, dz?: number): this {
    this.data.marks[name] = dz === undefined ? [dx, dyOrDz] : [dx, dyOrDz, dz]
    return this
  }

  beats (...beats: Beat[]): this { this.data.beats.push(...beats); return this }
  track (role: string, ...beats: Beat[]): this { (this.data.tracks[role] ??= []).push(...beats); return this }
  on (trigger: InteractionSpec['on'], beats: Beat[], opts: Omit<InteractionSpec, 'on' | 'beats'> = {}): this {
    this.data.interactions.push({ on: trigger, beats, ...opts })
    return this
  }

  schedule (s: ScheduleSpec): this { this.data.schedule = s; return this }
  vars (v: Record<string, unknown>): this { this.data.vars = { ...this.data.vars, ...v }; return this }
  options (o: Partial<SceneOptions>): this { this.data.options = { ...this.data.options, ...o }; return this }

  /** Validates and returns the scene (throws SceneValidationError). */
  build (): Scene { return defineScene(this.data) }
}

export const scene = (name: string, description?: string) => new SceneBuilder(name, description)
