// Scene actions. Control actions (scene_start/stop/status/list) are chat commands; stage
// actions (scene_walk/look/gesture) are what directors use for goto/look/gesture beats.
import { defineAction, defineSkill, z, noParams, ok, fail, goals, goto, sleep, playerEntity, type ActionContext, type Agent } from '../../../core/index.ts'
import { runtimeOf } from '../../../brains/scene/runtime.ts'
import { BOARD, type RunInfo, type RunSummary } from '../../../brains/scene/protocol.ts'

const CLAIM_MS = 3000

/**
 * Several bots hear the same public `!scene_start`. The first one to run the action claims it
 * on the server blackboard; the others return an empty result (the command brain stays quiet).
 */
function claim (ctx: ActionContext, action: string, params: unknown): boolean {
  const board = ctx.agent.fleet.board(ctx.agent.serverName)
  const claims = board.get<Record<string, number>>('scene:claims') ?? {}
  const now = Date.now()
  const key = `${ctx.caller.kind}:${ctx.caller.name}:${action}:${JSON.stringify(params)}`
  if (now - (claims[key] ?? 0) < CLAIM_MS) return false
  const fresh = Object.fromEntries(Object.entries(claims).filter(([, t]) => now - t < CLAIM_MS))
  board.set('scene:claims', { ...fresh, [key]: now })
  return true
}

function rt (agent: Agent) {
  const r = runtimeOf(agent)
  if (!r) throw new Error('this bot has no scene brain')
  return r
}

const sceneStart = defineAction({
  name: 'scene_start',
  description: 'Start a scene by name; free scene actors are cast into its roles.',
  params: z.object({ name: z.string().min(1).describe('scene name, see scene_list') }),
  exclusive: false,
  async run (ctx, { name }) {
    if (!claim(ctx, 'scene_start', { name })) return ok('')
    const by = ctx.caller.kind === 'player' ? ctx.caller.name : `${ctx.caller.kind}:${ctx.caller.name}`
    const r = await rt(ctx.agent).request('start', name, by)
    return r.ok ? ok(r.message) : fail(r.message)
  }
})

const sceneStop = defineAction({
  name: 'scene_stop',
  description: 'Stop a running scene (default: all of them).',
  params: z.object({ name: z.string().optional().describe('scene name; default every running scene') }),
  exclusive: false,
  async run (ctx, { name }) {
    if (!claim(ctx, 'scene_stop', { name })) return ok('')
    const by = ctx.caller.name
    const r = await rt(ctx.agent).request('stop', name, by)
    return r.ok ? ok(r.message) : fail(r.message)
  }
})

const sceneStatus = defineAction({
  name: 'scene_status',
  description: 'Show running scenes: beat, status and cast.',
  params: noParams,
  exclusive: false,
  run (ctx) {
    if (!claim(ctx, 'scene_status', {})) return ok('')
    const board = ctx.agent.fleet.board(ctx.agent.serverName)
    const runs = Object.values(board.get<Record<string, RunInfo>>(BOARD.runs) ?? {})
    if (!runs.length) {
      const last = board.get<RunSummary>(BOARD.last)
      return ok(last ? `no scene running (last: ${last.scene} ${last.result}${last.reason ? `, ${last.reason}` : ''})` : 'no scene running')
    }
    const text = runs.map(r => {
      const secs = Math.round((Date.now() - r.startedAt) / 1000)
      const cast = Object.entries(r.cast).map(([role, u]) => `${role}=${u}`).join(' ')
      return `${r.scene} ${r.status} ${secs}s at ${r.beat ?? 'start'} [${cast}] directed by ${r.director}`
    }).join(' | ')
    return ok(text, runs)
  }
})

const sceneList = defineAction({
  name: 'scene_list',
  description: 'List the scenes this bot knows.',
  params: noParams,
  exclusive: false,
  run (ctx) {
    if (!claim(ctx, 'scene_list', {})) return ok('')
    const scenes = rt(ctx.agent).opts.scenes
    if (!scenes.length) return ok('no scenes loaded')
    return ok(scenes.map(s => `${s.name} (${Object.keys(s.roles).length} roles)`).join(', '), scenes.map(s => ({ name: s.name, description: s.description, roles: Object.keys(s.roles) })))
  }
})

const sceneWalk = defineAction({
  name: 'scene_walk',
  capabilities: ['move'],
  description: 'Walk near a position (scene stage direction). Omit y to walk to the surface at x/z.',
  params: z.object({ x: z.number(), y: z.number().optional(), z: z.number(), range: z.number().min(0).max(16).default(1.5) }),
  internal: true,
  async run ({ bot, signal }, { x, y, z: zz, range }) {
    const goal = y === undefined ? new goals.GoalNearXZ(x, zz, range) : new goals.GoalNear(x, y, zz, range)
    await goto(bot, goal, signal)
    return ok('there')
  }
})

const sceneLook = defineAction({
  name: 'scene_look',
  capabilities: ['look'],
  description: 'Look at a player/bot by name or at a position (scene stage direction).',
  params: z.object({ player: z.string().optional(), x: z.number().optional(), y: z.number().optional(), z: z.number().optional() }),
  exclusive: false,
  internal: true,
  async run ({ bot }, p) {
    if (p.player) {
      const e = playerEntity(bot, p.player)
      if (!e) return fail(`can't see ${p.player}`)
      await bot.lookAt(e.position.offset(0, e.height * 0.9, 0))
      return ok('looking')
    }
    if (p.x === undefined || p.z === undefined) return fail('need a player or x/z')
    const me = bot.entity.position
    await bot.lookAt(me.offset(p.x + 0.5 - me.x, (p.y ?? me.y) + 1 - me.y, p.z + 0.5 - me.z))
    return ok('looking')
  }
})

const sceneGesture = defineAction({
  name: 'scene_gesture',
  capabilities: ['look'],
  description: 'A harmless gesture: swing (arm), crouch, nod, shake (head), spin, jump.',
  params: z.object({ gesture: z.enum(['swing', 'crouch', 'nod', 'shake', 'spin', 'jump']), times: z.number().int().min(1).max(10).default(1) }),
  exclusive: false,
  internal: true,
  async run ({ bot, signal }, { gesture, times }) {
    const { yaw, pitch } = bot.entity
    try {
      for (let i = 0; i < times; i++) {
        switch (gesture) {
          case 'swing': bot.swingArm('right'); await sleep(350, signal); break
          case 'crouch':
            bot.setControlState('sneak', true); await sleep(350, signal)
            bot.setControlState('sneak', false); await sleep(250, signal); break
          case 'nod':
            await bot.look(yaw, -0.6, true); await sleep(220, signal)
            await bot.look(yaw, 0.3, true); await sleep(220, signal); break
          case 'shake':
            await bot.look(yaw - 0.6, pitch, true); await sleep(200, signal)
            await bot.look(yaw + 0.6, pitch, true); await sleep(200, signal); break
          case 'spin':
            for (let q = 1; q <= 4; q++) { await bot.look(yaw + q * Math.PI / 2, pitch, true); await sleep(150, signal) }
            break
          case 'jump':
            bot.setControlState('jump', true); await sleep(250, signal)
            bot.setControlState('jump', false); await sleep(450, signal); break
        }
      }
    } finally {
      bot.setControlState('sneak', false)
      bot.setControlState('jump', false)
      if (gesture === 'nod' || gesture === 'shake') await bot.look(yaw, pitch, true).catch(() => {})
    }
    return ok(gesture)
  }
})

const sceneHold = defineAction({
  name: 'scene_hold',
  description: 'Stand by between scene beats, keeping lower-priority brains (NPC routines) from wandering off.',
  params: noParams,
  longRunning: true,
  internal: true,
  run: ({ signal }) => new Promise<ReturnType<typeof ok>>(resolve => {
    if (signal.aborted) return resolve(ok('released'))
    signal.addEventListener('abort', () => resolve(ok('released')), { once: true })
  })
})

export const sceneActions = [sceneStart, sceneStop, sceneStatus, sceneList, sceneWalk, sceneLook, sceneGesture, sceneHold]

/** The scene actions as a skill (sceneBrain also registers any that are missing). */
export const sceneSkill = () => defineSkill({
  name: 'scene',
  description: 'Scene control (start/stop/status/list) and stage directions.',
  actions: sceneActions
})
