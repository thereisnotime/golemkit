// sceneBrain(): lets bots on the same server act out scenes together. Each bot with the brain
// registers as an actor; one coordinator casts scenes, one director per run drives the beats.
// See docs/guide/scenes.md.
import { resolve } from 'node:path'
import { defineBrain, type Agent } from '../../core/index.ts'
import { loadSceneDir, parseScene } from './format.ts'
import { SceneRuntime, runtimeOf, type SceneRuntimeOptions } from './runtime.ts'
import { sceneActions } from '../../adapters/minecraft-java/skills/scene.ts'
import type { LineProvider, Scene, SceneInput } from './types.ts'

export interface SceneBrainOptions {
  /** Scenes defined in code (validated). */
  scenes?: (Scene | SceneInput)[]
  /** Directory of YAML scenes; default `scenes/` in the repo. false to skip. */
  dir?: string | false
  /** This bot directs every scene while online (a "stage manager"). */
  director?: boolean
  /** Roles this bot likes to play; casting offers them to it first. */
  roles?: string[]
  /** Improvise or vary lines (e.g. an LLM). Default: static lines with templating. */
  lineProvider?: LineProvider
  /** Run scene schedules. Default true. */
  schedule?: boolean
  /** Ambient filler between scenes. Default on (needs players within 48 blocks). */
  ambient?: SceneRuntimeOptions['ambient']
  /** React to players (approach/chat/hit hooks). Default true. */
  interact?: boolean
  /** Who may start/stop scenes (on top of the command brain's owner check). */
  allow?: SceneRuntimeOptions['allow']
}

const DEFAULT_DIR = resolve(import.meta.dirname, '..', '..', '..', 'scenes')

/**
 * Per-instance overrides come from `settings.scenes` in the fleet file, e.g.
 * `settings: { scenes: { director: true, roles: [hauler], ambient: false, schedule: false } }`.
 */
function instanceOverrides (agent: Agent): Partial<SceneBrainOptions> {
  const s = agent.settings.scenes
  if (!s || typeof s !== 'object') return {}
  const o = s as Record<string, unknown>
  const out: Partial<SceneBrainOptions> = {}
  if (typeof o.director === 'boolean') out.director = o.director
  if (Array.isArray(o.roles)) out.roles = o.roles.map(String)
  if (typeof o.schedule === 'boolean') out.schedule = o.schedule
  if (typeof o.interact === 'boolean') out.interact = o.interact
  if (o.ambient === false) out.ambient = false
  if (typeof o.dir === 'string') out.dir = o.dir
  return out
}

export const sceneBrain = (opts: SceneBrainOptions = {}) => defineBrain({
  name: 'scene',
  start (agent) {
    for (const a of sceneActions) if (!agent.getAction(a.name)) agent.registerAction(a)
    const log = agent.log.child('scene')
    const o = { ...opts, ...instanceOverrides(agent) }
    const scenes: Scene[] = (o.scenes ?? []).map(s => parseScene(s))
    if (o.dir !== false) {
      for (const s of loadSceneDir(o.dir ?? DEFAULT_DIR, (file, e) => log.warn(`invalid scene file skipped: ${e.message}`, { file }))) {
        if (!scenes.some(x => x.name === s.name)) scenes.push(s)
      }
    }
    const rt = runtimeOf(agent) ?? new SceneRuntime(agent, {
      scenes,
      ...(o.director !== undefined ? { director: o.director } : {}),
      ...(o.roles ? { roles: o.roles } : {}),
      ...(o.lineProvider ? { lineProvider: o.lineProvider } : {}),
      ...(o.schedule !== undefined ? { schedule: o.schedule } : {}),
      ...(o.ambient !== undefined ? { ambient: o.ambient } : {}),
      ...(o.interact !== undefined ? { interact: o.interact } : {}),
      ...(o.allow ? { allow: o.allow } : {})
    })
    rt.start()
    log.info(`${scenes.length} scenes loaded`, { scenes: scenes.map(s => s.name) })
  },
  session (agent) {
    const rt = runtimeOf(agent)
    rt?.online()
    return () => rt?.offline()
  },
  stop (agent) {
    runtimeOf(agent)?.stop()
  }
})
