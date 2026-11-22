import { test } from 'node:test'
import { attachFakeBot } from './fake-attach.ts'
import assert from 'node:assert/strict'
import { Agent, Fleet, defineVariant, defineAction, z, sleep, PRIORITY } from '../src/core/index.ts'
import {
  SceneRuntime, sceneSkill, sceneActions, parseScene, SCENE_BOARD,
  type Performer, type StageWorld, type SceneInput, type ActorEntry, type RunInfo, type LineProvider
} from '../src/brains/scene/index.ts'

const base = { host: 'test.invalid', port: 25565, auth: 'offline' as const, version: '1.21.1' }
const fast = { lineGapMs: 0, botLineGapMs: 0, typingMsPerChar: 0, recastTimeoutMs: 300 }

interface Entry { t: number, user: string, what: string }

function stage (names: string[], scenes: SceneInput[], extra: { lineProvider?: LineProvider } = {}) {
  const fleet = new Fleet()
  const log: Entry[] = []
  const t0 = Date.now()
  const world: StageWorld = {
    position: () => ({ x: 0, y: 64, z: 0 }),
    playersNear: () => [],
    time: () => undefined
  }
  const parsed = scenes.map(s => parseScene(s))
  const def = defineVariant({ name: 'actor', skills: [sceneSkill()], brains: [] })
  const rts = names.map(username => {
    const agent = new Agent(def, base, { username, dataDir: `data/test/scene/${username}` })
    fleet.add(agent, 's1')
    const performer: Performer = async (cmd, { signal }) => {
      const what = cmd.kind === 'say' ? `say ${cmd.text}` : `${cmd.name} ${JSON.stringify(cmd.params)}`
      log.push({ t: Date.now() - t0, user: username, what })
      try {
        await sleep(cmd.kind === 'act' && cmd.name === 'hold' ? 60_000 : 5, signal)
      } catch {
        log.push({ t: Date.now() - t0, user: username, what: `aborted ${what}` })
        throw new Error('aborted')
      }
      return { status: 'ok', message: '' }
    }
    const rt = new SceneRuntime(agent, { scenes: parsed, schedule: false, ambient: false, interact: false, ...extra }, { world, performer })
    rt.start()
    rt.online()
    return rt
  })
  const board = fleet.board('s1')
  const runs = () => Object.values(board.get<Record<string, RunInfo>>(SCENE_BOARD.runs) ?? {})
  const actors = () => board.get<Record<string, ActorEntry>>(SCENE_BOARD.actors) ?? {}
  const said = (user?: string) => log.filter(e => (!user || e.user === user) && e.what.startsWith('say ')).map(e => e.what.slice(4))
  const done = () => { for (const r of rts) r.stop() }
  return { fleet, rts, board, log, runs, actors, said, done }
}

async function until (cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time')
    await sleep(10)
  }
}

const trio = { hauler: {}, foreman: {}, miner: {} }

test('a request from any bot is cast, directed and run with cue sync', async () => {
  const s = stage(['C', 'A', 'B'], [{
    name: 'cart',
    roles: trio,
    anchor: { pos: [100, 64, 100] },
    marks: { cart: [2, 3] },
    beats: [
      { as: 'hauler', say: 'the wheel!' },
      { as: 'hauler', goto: 'cart' },
      { as: 'foreman', look: 'hauler' }
    ],
    tracks: {
      miner: [{ await: 'parts' }, { say: 'got the parts' }],
      foreman: [{ wait: 60 }, { say: 'parts are here' }, { cue: 'parts' }]
    },
    options: fast
  }])
  try {
    // C is not the coordinator (A is); the request is routed there.
    const reply = await s.rts[0]!.request('start', 'cart', 'Steve')
    assert.equal(reply.ok, true, reply.message)
    assert.match(reply.message, /A as hauler, B as foreman, C as miner/)
    const run = s.runs()[0]!
    assert.equal(run.director, 'A')
    assert.equal(s.actors().C!.busyIn, run.runId)
    const summary = await s.rts[1]!.waitForRun(run.runId, 5000)
    assert.equal(summary?.result, 'finished')

    assert.deepEqual(s.said('A'), ['the wheel!'])
    const walk = s.log.find(e => e.user === 'A' && e.what.startsWith('scene_walk'))!
    assert.deepEqual(JSON.parse(walk.what.slice('scene_walk '.length)), { x: 102, z: 103, range: 1.5 })
    assert.ok(s.log.some(e => e.user === 'B' && e.what === 'scene_look {"player":"A"}'))
    const cue = s.log.find(e => e.what === 'say parts are here')!
    const miner = s.log.find(e => e.what === 'say got the parts')!
    assert.ok(miner.t >= cue.t, 'miner waits for the cue')
    assert.ok(cue.t >= 55, 'foreman waited first')
    assert.equal(s.runs().length, 0)
    assert.equal(s.actors().C!.busyIn, undefined)

    const again = await s.rts[2]!.request('start', 'nope')
    assert.equal(again.ok, false)
  } finally { s.done() }
})

test('a busy cast or a running scene refuses a second start', async () => {
  const s = stage(['A', 'B', 'C'], [
    { name: 'long', roles: { a: {}, b: {} }, beats: [{ as: 'a', act: 'hold' }], options: fast },
    { name: 'trio', roles: trio, beats: [{ as: 'hauler', say: 'x' }], options: fast }
  ])
  try {
    assert.equal((await s.rts[0]!.request('start', 'long')).ok, true)
    const dup = await s.rts[1]!.request('start', 'long')
    assert.match(dup.message, /already running/)
    const trio2 = await s.rts[1]!.request('start', 'trio')
    assert.match(trio2.message, /can't cast trio: no free actor/)
    const stop = await s.rts[2]!.request('stop', 'long', 'Steve')
    assert.equal(stop.ok, true)
    await until(() => s.runs().length === 0)
    assert.ok(s.log.some(e => e.what.startsWith('aborted hold')), 'the in-flight action was cancelled')
  } finally { s.done() }
})

test('a dropped cast member is recast and the scene carries on', async () => {
  const s = stage(['A', 'B', 'C', 'D'], [{
    name: 'loop',
    roles: trio,
    beats: [{ repeat: { times: 12, beats: [{ as: 'miner', gesture: 'nod' }, { wait: 25 }] } }],
    options: fast
  }])
  try {
    await s.rts[0]!.request('start', 'loop')
    const runId = s.runs()[0]!.runId
    await until(() => s.log.filter(e => e.user === 'C').length >= 3)
    s.rts[2]!.offline()
    const summary = await s.rts[0]!.waitForRun(runId, 5000)
    assert.equal(summary?.result, 'finished')
    const nods = s.log.filter(e => e.what.startsWith('scene_gesture'))
    assert.ok(nods.some(e => e.user === 'D'), 'D took over the miner')
    const lastC = Math.max(...nods.filter(e => e.user === 'C').map(e => e.t))
    assert.ok(nods.filter(e => e.user === 'D').every(e => e.t >= lastC))
    assert.equal(s.actors().D!.busyIn, undefined)
  } finally { s.done() }
})

test('with nobody to take over, the scene aborts and releases the cast', async () => {
  const s = stage(['A', 'B', 'C'], [{
    name: 'loop',
    roles: trio,
    beats: [{ repeat: { times: 50, beats: [{ as: 'miner', gesture: 'nod' }, { wait: 20 }] } }],
    options: { ...fast, recastTimeoutMs: 100 }
  }])
  try {
    await s.rts[0]!.request('start', 'loop')
    const runId = s.runs()[0]!.runId
    await until(() => s.log.length >= 2)
    s.rts[2]!.offline()
    const summary = await s.rts[0]!.waitForRun(runId, 5000)
    assert.equal(summary?.result, 'aborted')
    assert.match(summary?.reason ?? '', /nobody to play miner/)
    for (const a of Object.values(s.actors())) assert.equal(a.busyIn, undefined)
  } finally { s.done() }
})

test('a player approaching pauses the scene for a rate-limited reaction', async () => {
  const s = stage(['A', 'B'], [{
    name: 'chat',
    roles: { hauler: {}, foreman: {} },
    beats: [{ repeat: { times: 40, beats: [{ as: 'hauler', say: 'tick' }, { wait: 15 }] } }],
    interactions: [{
      on: 'approach',
      radius: 6,
      cooldownMs: 10_000,
      beats: [{ look: 'player' }, { say: 'hi {player}' }, { set: { $helped: true } }]
    }],
    options: fast
  }])
  try {
    await s.rts[0]!.request('start', 'chat')
    const run = s.runs()[0]!
    await until(() => s.said('A').length >= 2)
    const report = (from: string, distance: number) => s.fleet.send({
      from, to: run.director, server: 's1', topic: 'scene:player',
      data: { runId: run.runId, trigger: 'approach', player: 'Steve', member: from, distance }
    })
    report('B', 9) // outside the radius: ignored
    await sleep(250)
    assert.equal(s.said('B').length, 0)
    report('B', 3)
    await until(() => s.said('B').includes('hi Steve'))
    // The reacting member (B, foreman) looked at the player, and the timeline paused meanwhile.
    const look = s.log.find(e => e.user === 'B' && e.what === 'scene_look {"player":"Steve"}')!
    const hi = s.log.find(e => e.what === 'say hi Steve')!
    assert.ok(look.t <= hi.t)
    const ticksDuring = s.log.filter(e => e.user === 'A' && e.t > look.t + 1 && e.t < hi.t)
    assert.equal(ticksDuring.length, 0, 'no timeline beats while reacting')
    await until(() => s.log.filter(e => e.user === 'A' && e.t > hi.t).length >= 2)
    report('B', 2) // cooldown
    await sleep(300)
    assert.equal(s.said('B').filter(l => l === 'hi Steve').length, 1)
    s.rts[0]!.request('stop')
    await until(() => s.runs().length === 0)
  } finally { s.done() }
})

test('lineProvider can replace lines and falls back on empty', async () => {
  const s = stage(['A'], [{
    name: 'solo',
    roles: { a: {} },
    beats: [{ as: 'a', say: 'hello' }, { as: 'a', say: 'keep me' }],
    options: fast
  }], { lineProvider: (r) => r.line === 'hello' ? `${r.speaker} says HELLO` : '' })
  try {
    await s.rts[0]!.request('start', 'solo')
    await until(() => s.said().length === 2 && s.runs().length === 0)
    assert.deepEqual(s.said(), ['A says HELLO', 'keep me'])
  } finally { s.done() }
})

test('cancelActions stops only matching actions and lets suspended ones resume', async () => {
  const hold = (name: string) => defineAction({
    name,
    description: name,
    params: z.object({}),
    longRunning: true,
    run: ({ signal }) => new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
  })
  const agent = new Agent(defineVariant({ name: 't', skills: [{ name: 's', actions: [hold('npc_walk'), hold('scene_hold')] }], brains: [] }), base, { username: 'X', dataDir: 'data/test/scene/X' })
  // Pretend to be connected; these actions never touch the bot.
  attachFakeBot(agent, {})
  void agent.act('npc_walk', {}, { caller: { kind: 'brain', name: 'npc' }, priority: PRIORITY.npc })
  const scene = agent.act('scene_hold', {}, { caller: { kind: 'brain', name: 'scene:r1:1' }, priority: PRIORITY.scene })
  assert.equal(agent.currentAction?.name, 'scene_hold')
  const n = agent.cancelActions(i => i.caller.name.startsWith('scene:r1:'), 'scene:cancel')
  assert.equal(n, 1)
  await scene
  assert.notEqual(agent.currentAction?.name, 'scene_hold')
  await sleep(5)
  assert.equal(agent.currentAction?.name, 'npc_walk', 'the suspended NPC action resumed')
  assert.equal(agent.cancelActions(i => i.caller.name.startsWith('scene:'), 'x'), 0)
  agent.stopActions()
})

test('control commands heard by several bots are handled once', async () => {
  const s = stage(['A', 'B'], [{ name: 'solo', roles: { a: {} }, beats: [{ as: 'a', say: 'hi' }], options: fast }])
  try {
    const status = sceneActions.find(a => a.name === 'scene_status')!
    const ctx = (agent: Agent) => ({ agent, caller: { kind: 'player', name: 'Steve' } }) as any
    const first = await status.run(ctx(s.rts[0]!.agent), {})
    const second = await status.run(ctx(s.rts[1]!.agent), {})
    assert.match(String((first as { message: string }).message), /no scene running/)
    assert.equal((second as { message: string }).message, '')
  } finally { s.done() }
})

test('choose and line variants do not repeat back to back', async () => {
  const s = stage(['A'], [{
    name: 'vary',
    roles: { a: {} },
    beats: [{ repeat: { times: 8, beats: [{ choose: [{ beats: [{ as: 'a', say: 'x' }] }, { weight: 5, beats: [{ as: 'a', say: ['y', 'z'] }] }] }] } }],
    options: fast
  }])
  try {
    await s.rts[0]!.request('start', 'vary')
    await until(() => s.said().length === 8 && s.runs().length === 0)
    const lines = s.said()
    for (let i = 1; i < lines.length; i++) assert.notEqual(lines[i], lines[i - 1], lines.join(','))
  } finally { s.done() }
})
