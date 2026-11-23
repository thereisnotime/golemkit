import { test } from 'node:test'
import { minecraftView } from './fake-attach.ts'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { PRIORITY, ok, fail, createLogger, type ActionInfo, type ActionResult } from '../src/core/index.ts'
import { parseProfile } from '../src/core/profile.ts'
import { NpcController, type Behavior } from '../src/brains/npc/index.ts'
import {
  BehaviorRegistry, ArmedStore, BehaviorRuntime, defaultBehaviorRegistry, validateBehaviorConfig, mergeConfigs,
  nextFoodStep, isHungry, keepFed, behaviorActions, missingCapability, defineBehavior, z,
  type FoodWorld, type FoodStepOptions
} from './behaviors-helpers.ts'
import { attachRuntime } from '../src/brains/behaviors/actions.ts'
import { huntRefusal } from '../src/skills/combat.ts'

const require = createRequire(import.meta.url)
const mcData = require('minecraft-data')('1.21.1')

function memStore (initial: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(initial))
  return {
    data,
    get: <T>(k: string, fb?: T) => (data.has(k) ? structuredClone(data.get(k)) : fb) as T,
    set: (k: string, v: unknown) => { data.set(k, structuredClone(v)) }
  }
}

// ------------------------------------------------------------------ registry

test('library registers every documented behaviour with valid defaults', () => {
  const reg = defaultBehaviorRegistry()
  for (const name of ['keep_fed', 'stay_safe', 'follow_owner', 'guard_area', 'guard_owner', 'collect_drops', 'deposit_when_full',
    'sleep_at_night', 'return_home', 'wander', 'chop_wood_loop', 'farm_loop', 'light_area', 'avoid_mobs', 'greet_players', 'idle_look']) {
    assert.ok(reg.has(name), name)
    const v = reg.validate(name, {})
    assert.ok(v.ok, `${name} defaults validate`)
    assert.ok(reg.get(name)!.description.length > 40, `${name} has a real description`)
  }
})

test('options are validated strictly with clear errors', () => {
  const reg = defaultBehaviorRegistry()
  const good = reg.validate('keep_fed', { below: 10 })
  assert.ok(good.ok && good.options.below === 10 && good.options.hunt === true)
  const bad = reg.validate('keep_fed', { below: 'lots' })
  assert.ok(!bad.ok && /below/.test(bad.error))
  const range = reg.validate('keep_fed', { below: 40 })
  assert.ok(!range.ok && /below/.test(range.error))
  const unknown = reg.validate('keep_fed', { bellow: 10 })
  assert.ok(!unknown.ok && /unknown option bellow/.test(unknown.error) && /below/.test(unknown.error))
  const name = reg.validate('keep_food', {})
  assert.ok(!name.ok && /unknown behaviour "keep_food"/.test(name.error) && /keep_fed/.test(name.error))
  assert.ok(reg.validate('wander', { priority: 'behavior' }).ok, 'common priority option')
  assert.ok(!reg.validate('wander', { priority: 'urgent' }).ok)
})

test('chat-style option strings are converted with the schema', () => {
  const reg = defaultBehaviorRegistry()
  assert.deepEqual(reg.coerce('keep_fed', 'below=10 hunt=false animals=cow,pig'), { below: 10, hunt: false, animals: ['cow', 'pig'] })
  assert.deepEqual(reg.coerce('keep_fed', '{"below": 9}'), { below: 9 })
  assert.deepEqual(reg.coerce('collect_drops', 'items=oak_log'), { items: ['oak_log'] })
  assert.deepEqual(reg.coerce('guard_area', 'place=farm radius=8'), { place: 'farm', radius: 8 })
  assert.match(String(reg.coerce('keep_fed', 'below')), /key=value/)
  assert.deepEqual(reg.coerce('keep_fed', { below: 3 }), { below: 3 })
})

test('duplicate and badly named definitions are rejected', () => {
  const def = defineBehavior({ name: 'x', category: 'idle', description: 'd', options: z.object({}) })
  assert.throws(() => new BehaviorRegistry([def, def]), /duplicate/)
  assert.throws(() => new BehaviorRegistry([{ ...def, name: 'Bad Name' }]), /snake_case/)
})

// ------------------------------------------------------------------ armed store

test('arm, configure, disarm and reset', () => {
  const reg = defaultBehaviorRegistry()
  const store = new ArmedStore(reg, memStore(), {}, () => 1000)
  assert.deepEqual(store.armed(), [])
  const r = store.arm('keep_fed', { below: 12 }, 'player:Robin')
  assert.ok(r.ok)
  assert.deepEqual(store.armed().map(a => [a.name, a.options.below, a.by]), [['keep_fed', 12, 'player:Robin']])
  assert.ok(!store.arm('keep_fed', { below: 99 }).ok, 'bad options rejected')
  assert.equal(store.options('keep_fed').below, 12, 'unchanged after a rejected arm')
  assert.ok(store.configure('keep_fed', { hunt: false }, 'brain:llm').ok)
  assert.equal(store.options('keep_fed').below, 12, 'configure merges')
  assert.equal(store.options('keep_fed').hunt, false)
  assert.ok(store.configure('wander', { radius: 5 }).ok)
  assert.equal(store.isArmed('wander'), false, 'configure does not arm')
  assert.ok(store.disarm('keep_fed').ok)
  assert.ok(!store.disarm('keep_fed').ok, 'already off')
  assert.equal(store.isArmed('keep_fed'), false)
  assert.ok(!store.arm('nope').ok)
})

test('config is the base and runtime changes persist across restarts', () => {
  const reg = defaultBehaviorRegistry()
  const backing = memStore()
  const config = validateBehaviorConfig(mergeConfigs({ keep_fed: true, stay_safe: true }, { stay_safe: { retreatBelow: 12 } }), reg)
  const a = new ArmedStore(reg, backing, config)
  assert.deepEqual(a.armed().map(e => e.name), ['stay_safe', 'keep_fed'])
  assert.equal(a.options('stay_safe').retreatBelow, 12)
  a.disarm('keep_fed', 'player:Robin')
  a.arm('follow_owner', { distance: 4 }, 'brain:llm')

  const b = new ArmedStore(reg, backing, config) // restart: same storage, same config
  assert.deepEqual(b.armed().map(e => e.name), ['stay_safe', 'follow_owner'])
  assert.equal(b.options('follow_owner').distance, 4)
  assert.equal(b.armed().find(e => e.name === 'follow_owner')?.by, 'brain:llm')
  b.reset('keep_fed')
  assert.ok(b.isArmed('keep_fed'), 'reset goes back to config')
  b.reset()
  assert.deepEqual(b.armed().map(e => e.name), ['stay_safe', 'keep_fed'])
})

// ------------------------------------------------------------------ profile config

test('profile behaviors: lands in settings and is validated against the registry', () => {
  const p = parseProfile(`
variant: companion
behaviors:
  keep_fed: { below: 10 }
  stay_safe: true
  wander: { enabled: false, radius: 4 }
`, 'pax')
  const s = (p.options.settings as any).behaviors
  assert.deepEqual(s.keep_fed, { below: 10 })
  const reg = defaultBehaviorRegistry()
  const v = validateBehaviorConfig(s, reg)
  assert.equal(v.keep_fed?.enabled, true)
  assert.equal(v.keep_fed?.options.below, 10)
  assert.equal(v.wander?.enabled, false)
  assert.equal(v.wander?.options.radius, 4)
  assert.throws(() => validateBehaviorConfig({ keep_food: true, stay_safe: { retreatBelow: 'x' } }, reg, 'pax.yaml: behaviors'),
    (e: Error) => /pax\.yaml: behaviors/.test(e.message) && /keep_food/.test(e.message) && /retreatBelow/.test(e.message))
  assert.throws(() => validateBehaviorConfig({ keep_fed: 'yes' }, reg), /expected true, false or an options map/)
  assert.throws(() => parseProfile('variant: x\nbehaviors: [keep_fed]\n'), /behaviors/)
})

test('the shipped pax profile arms keep_fed (with scouting), stay_safe and farm_setup', async () => {
  const { loadProfile } = await import('../src/core/profile.ts')
  const p = loadProfile('pax')!
  const v = validateBehaviorConfig((p.options.settings as any).behaviors, defaultBehaviorRegistry())
  assert.ok(v.keep_fed?.enabled && v.stay_safe?.enabled && v.farm_setup?.enabled)
  assert.equal(v.keep_fed?.options.scout, true)
  assert.ok(v.keep_spawn_bed?.enabled, 'keeps a bed at home')
  assert.equal(v.keep_spawn_bed?.options.graceSeconds, 12)
  assert.equal(v.keep_spawn_bed?.options.askText, '{players}, could you hop into bed so we can skip the night?')
})

// ------------------------------------------------------------------ hunt filter

test('hunt filter: only plain adult passive animals', () => {
  const keys = mcData.entitiesByName.cow.metadataKeys as string[]
  const wolfKeys = mcData.entitiesByName.wolf.metadataKeys as string[]
  const cow = { id: 1, name: 'cow', type: 'animal', metadata: [] as unknown[] }
  assert.equal(huntRefusal(cow, { metadataKeys: keys }), null)
  const named = { ...cow, metadata: [] as unknown[] }
  named.metadata[keys.indexOf('custom_name')] = '{"text":"Bessie"}'
  assert.equal(huntRefusal(named, { metadataKeys: keys }), 'named')
  assert.equal(huntRefusal({ ...cow, vehicle: { id: 9 } }, { metadataKeys: keys }), 'leashed')
  const baby = { ...cow, metadata: [] as unknown[] }
  baby.metadata[keys.indexOf('baby')] = true
  assert.equal(huntRefusal(baby, { metadataKeys: keys }), 'baby')
  assert.equal(huntRefusal({ id: 2, name: 'villager', type: 'passive' }), 'not a huntable animal')
  assert.equal(huntRefusal({ id: 3, name: 'wolf', type: 'animal' }, { metadataKeys: wolfKeys }), 'not a huntable animal')
  assert.equal(huntRefusal({ id: 4, name: 'cat', type: 'animal' }), 'not a huntable animal')
  assert.equal(huntRefusal({ id: 5, name: 'player', type: 'player', username: 'Robin' }), 'player')
  assert.equal(huntRefusal({ id: 6, name: 'cow', type: 'player', username: 'cow' }), 'player', 'a player called cow')
  assert.equal(huntRefusal({ ...cow, metadata: [] }, { animals: ['pig'] }), 'not a huntable animal', 'respects the animal list')
  const owned = { id: 7, name: 'pig', type: 'animal', metadata: [] as unknown[] }
  owned.metadata[20] = 'some-uuid'
  assert.equal(huntRefusal(owned, { metadataKeys: [...keys, 'flags', 'owneruuid'] }), null, 'index 20 is not owneruuid for these keys')
  owned.metadata[18] = 'some-uuid'
  assert.equal(huntRefusal(owned, { metadataKeys: [...keys, 'flags', 'owneruuid'] }), 'tamed')
})

// ------------------------------------------------------------------ keep_fed decisions

const allOn: FoodStepOptions = { chests: true, harvest: true, hunt: true, cook: true, eatRaw: true }
const empty: FoodWorld = { hasReadyFood: false, raw: [], safeRaw: false, canCook: false, canBake: false, foodChest: false, ripeCrops: 0, animals: 0 }

test('keep_fed order: eat, cook, bake, raw, chest, crops, hunt', () => {
  assert.equal(nextFoodStep({ ...empty, hasReadyFood: true, animals: 3 }, allOn), 'eat')
  assert.equal(nextFoodStep({ ...empty, raw: ['beef'], safeRaw: true, canCook: true }, allOn), 'cook')
  assert.equal(nextFoodStep({ ...empty, raw: ['beef'], safeRaw: true, canCook: true }, allOn, new Set(['cook'])), 'eat', 'cooking failed: eat it raw')
  assert.equal(nextFoodStep({ ...empty, raw: ['chicken'], safeRaw: false }, allOn), null, 'never raw chicken')
  assert.equal(nextFoodStep({ ...empty, canBake: true }, allOn), 'bread')
  assert.equal(nextFoodStep({ ...empty, foodChest: true, ripeCrops: 5, animals: 2 }, allOn), 'withdraw')
  assert.equal(nextFoodStep({ ...empty, foodChest: true, ripeCrops: 5, animals: 2 }, { ...allOn, chests: false }), 'harvest')
  assert.equal(nextFoodStep({ ...empty, ripeCrops: 5, animals: 2 }, allOn, new Set(['harvest'])), 'hunt')
  assert.equal(nextFoodStep({ ...empty, animals: 2 }, { ...allOn, hunt: false }), null)
  assert.equal(nextFoodStep(empty, allOn), null)
})

test('keep_fed triggers on hunger, or on low health when too hungry to heal', () => {
  const o = { below: 14, healBelow: 14 }
  assert.equal(isHungry(20, 20, o), false)
  assert.equal(isHungry(10, 20, o), true)
  assert.equal(isHungry(16, 6, o), true, 'Pax at 6 health with 16 food does not regenerate')
  assert.equal(isHungry(19, 6, o), false, 'regenerates on its own at 18+')
})

/** A fake world where actions change the inventory the way the real ones would. */
function foodWorld () {
  const inv: { name: string, count: number, type: number }[] = []
  const add = (name: string, count: number) => {
    const e = inv.find(i => i.name === name)
    if (e) e.count += count; else inv.push({ name, count, type: mcData.itemsByName[name].id })
  }
  const take = (name: string, n: number) => { const e = inv.find(i => i.name === name)!; e.count -= n; if (e.count <= 0) inv.splice(inv.indexOf(e), 1) }
  const pos = { x: 0, y: 64, z: 0, distanceTo: (p: any) => Math.hypot(p.x, p.y - 64, p.z), offset: () => pos, floored: () => pos }
  const bot: any = {
    food: 6,
    health: 6,
    entity: { position: pos },
    registry: mcData,
    inventory: { items: () => inv, emptySlotCount: () => 30 },
    entities: {
      10: { id: 10, name: 'cow', type: 'animal', metadata: [], position: { x: 5, y: 64, z: 5, distanceTo: () => 7 } },
      11: { id: 11, name: 'villager', type: 'passive', metadata: [], position: { x: 3, y: 64, z: 3, distanceTo: () => 4 } }
    },
    findBlock: () => null,
    findBlocks: () => []
  }
  const actions = ['eat', 'hunt', 'smelt', 'craft', 'harvest', 'withdraw']
  const calls: { name: string, params: any }[] = []
  const said: string[] = []
  const agent: any = {
    owners: ['Robin'],
    getAction: (n: string) => actions.includes(n) ? { name: n } : undefined,
    protectedAreas: { isProtected: () => false },
    say: (t: string) => said.push(t),
    whisper: (_: string, t: string) => said.push(t)
  }
  const act = async (name: string, params: any = {}): Promise<ActionResult> => {
    calls.push({ name, params })
    if (name === 'hunt') { delete bot.entities[10]; add('beef', 2); add('oak_log', 0); return ok('hunted 1 cow') }
    if (name === 'craft' && params.item === 'furnace') { take('cobblestone', 8); add('furnace', 1); return ok('crafted furnace') }
    if (name === 'smelt') { take(params.item, params.count); add(`cooked_${params.item}`, params.count); return ok('smelted') }
    if (name === 'eat') {
      const f = inv.find(i => i.name.startsWith('cooked_') || i.name === 'beef')
      if (!f) return fail('nothing to eat')
      take(f.name, 1); bot.food = Math.min(20, bot.food + 8); return ok('ate')
    }
    return fail('unexpected')
  }
  return { bot, agent, calls, act, add, said }
}

test('keep_fed run: hunts, crafts a furnace, cooks and eats until fed', async () => {
  const w = foodWorld()
  w.add('cobblestone', 8)
  w.add('oak_log', 4)
  const o = defaultBehaviorRegistry().validate('keep_fed', {})
  assert.ok(o.ok)
  const b = keepFed.create!(o.options as any, { agent: w.agent })
  const bb = { needs: { hunger: 0.7 } }
  assert.ok(b.score({ bot: w.bot, bb, current: null } as any) > 70)
  const signal = new AbortController().signal
  const r = await b.run({ agent: w.agent, bot: w.bot, bb, log: createLogger('t'), now: 0, current: 'keep_fed', signal, act: w.act, wait: async () => {} } as any)
  assert.deepEqual(w.calls.map(c => c.name), ['hunt', 'craft', 'smelt', 'eat', 'eat'])
  assert.equal(w.calls[0]!.params.radius, 32)
  assert.ok(r && typeof r === 'object' && r.ok, JSON.stringify(r))
  assert.ok(w.bot.food >= 18)
})

test('keep_fed fails truthfully when there is no food anywhere', async () => {
  const w = foodWorld()
  delete w.bot.entities[10]
  const o = defaultBehaviorRegistry().validate('keep_fed', {})
  const b = keepFed.create!((o as any).options, { agent: w.agent })
  const r: any = await b.run({ agent: w.agent, bot: w.bot, bb: { needs: { hunger: 0.7 } }, log: createLogger('t'), now: 0, current: null, signal: new AbortController().signal, act: w.act, wait: async () => {} } as any)
  assert.equal(r.ok, false)
  assert.match(r.message, /still hungry/)
  assert.deepEqual(w.calls, [], 'never touched the villager')
  assert.equal(w.said.length, 1, 'food 6 with nothing to try: told the owner once')
  assert.match(w.said[0]!, /starving \(food 6\/20\)/)
})

// ------------------------------------------------------------------ runtime + controller

function fakeAgent (actions: string[], extra: Record<string, unknown> = {}) {
  const store = memStore()
  let current: ActionInfo | null = null
  const calls: { name: string, params: unknown, priority: number }[] = []
  const agent: any = {
    username: 'BehaveTest',
    owners: ['Robin'],
    canDig: false,
    settings: {},
    definition: { name: 'test' },
    log: createLogger('test'),
    storage: store,
    isOwner: (p: string) => p.toLowerCase() === 'robin',
    get currentAction () { return current },
    getAction: (n: string) => actions.includes(n) ? { name: n } : undefined,
    async act (name: string, params: unknown, opts: { caller: any, priority: number }): Promise<ActionResult> {
      calls.push({ name, params, priority: opts.priority })
      if (current && current.priority > opts.priority) return fail(`busy: ${current.name} (${current.caller.kind} ${current.caller.name})`)
      return ok('done')
    },
    ...extra
  }
  const bot: any = {
    entity: { position: { x: 0, y: 64, z: 0, distanceTo: () => 0 } },
    food: 20, health: 20, time: { timeOfDay: 1000 }, entities: {}, players: {}, game: { dimension: 'overworld' },
    inventory: { items: () => [], inventoryStart: 9, inventoryEnd: 45, emptySlotCount: () => 36 }
  }
  agent.adapter = minecraftView(bot)
  return { agent, bot, calls, store, setForeign: (i: ActionInfo | null) => { current = i } }
}

/** A registry with two scripted behaviours: `need` (behavior level) and `chore` (npc level). */
function scripted (scores: Record<string, number>) {
  const mk = (name: string, priority: 'behavior' | 'npc') => defineBehavior({
    name, category: 'work', description: `${name} test behaviour`, options: z.object({}), priority,
    create: () => ({ score: () => scores[name] ?? 0, run: async (ctx: any) => { await ctx.act(name); await new Promise(r => ctx.signal.addEventListener('abort', r, { once: true })) } })
  })
  return new BehaviorRegistry([mk('need', 'behavior'), mk('chore', 'npc')])
}

const flush = () => new Promise(r => setImmediate(r))

test('armed set drives the controller; behaviour priority beats a lower holder', async () => {
  const f = fakeAgent(['need', 'chore', 'npc_interrupt'])
  const scores = { need: 50, chore: 30 }
  const rt = new BehaviorRuntime(f.agent, scripted(scores), {})
  const t = { now: 100_000 }
  const c = new NpcController(f.agent, f.bot, { name: 'behaviors', behaviors: () => rt.behaviors(), autoHome: false, now: () => t.now })
  rt.controller = c
  await c.tick(); await flush()
  assert.equal(c.current, null, 'nothing armed')

  rt.store.arm('chore')
  rt.store.arm('need')
  // the LLM holds the body: npc-level chore backs off, behavior-level need still runs
  f.setForeign({ name: 'follow', params: {}, caller: { kind: 'brain', name: 'llm' }, priority: PRIORITY.llm })
  await c.tick(); await flush()
  assert.equal(c.current, 'need')
  assert.equal(f.calls.at(-1)?.priority, PRIORITY.behavior)

  // need drops; chore stays blocked by the LLM back-off
  scores.need = 0
  t.now += 5000
  await c.tick(); await flush()
  assert.notEqual(c.current, 'chore')
  f.setForeign(null)
  t.now += 21_000
  await c.tick(); await flush()
  assert.equal(c.current, 'chore')
  assert.equal(f.calls.at(-1)?.priority, PRIORITY.npc)

  // disarming the running behaviour stops it
  rt.store.disarm('chore')
  assert.equal(c.current, null)
  c.stop()
})

test('a player holding the body pauses every level', async () => {
  const f = fakeAgent(['need', 'npc_interrupt'])
  const rt = new BehaviorRuntime(f.agent, scripted({ need: 50 }), {})
  rt.store.arm('need')
  const c = new NpcController(f.agent, f.bot, { name: 'behaviors', behaviors: () => rt.behaviors(), autoHome: false })
  f.setForeign({ name: 'come', params: {}, caller: { kind: 'player', name: 'Robin' }, priority: PRIORITY.player })
  await c.tick(); await flush()
  assert.equal(c.current, null)
  assert.equal(f.calls.length, 0)
  c.stop()
})

test('capability checks skip what the bot cannot run', () => {
  const reg = defaultBehaviorRegistry()
  const f = fakeAgent(['chop_tree', 'eat'])
  assert.match(String(missingCapability(reg.get('chop_wood_loop')!, f.agent)), /digging/)
  assert.match(String(missingCapability(reg.get('farm_loop')!, f.agent)), /harvest/)
  assert.equal(missingCapability(reg.get('keep_fed')!, f.agent), null)
  f.agent.settings.canPlace = false
  assert.match(String(missingCapability(reg.get('light_area')!, { ...f.agent, getAction: () => ({}) })), /placing/)
  const rt = new BehaviorRuntime(f.agent, reg, {})
  rt.store.arm('chop_wood_loop')
  rt.store.arm('keep_fed')
  const built = rt.build()
  assert.deepEqual(built.behaviors.map(b => b.name), ['keep_fed'])
  assert.match(built.skipped.chop_wood_loop!, /digging/)
  assert.equal(built.behaviors[0]!.priority, PRIORITY.behavior)
})

// ------------------------------------------------------------------ actions

function actionCtx (agent: any, caller: any, player?: string) {
  return { agent, bot: {}, signal: new AbortController().signal, caller, player, log: createLogger('t') } as any
}

test('behavior actions: owners only from chat, LLM arms as brain:llm, string options', async () => {
  const f = fakeAgent(['eat', 'follow', 'pickup_items'])
  const rt = new BehaviorRuntime(f.agent, defaultBehaviorRegistry(), {})
  attachRuntime(f.agent, rt)
  const [list, status, arm, disarm, configure] = behaviorActions as any[]
  const llm = { kind: 'brain', name: 'llm' }

  const denied = await arm!.run(actionCtx(f.agent, { kind: 'player', name: 'Stranger' }), { name: 'keep_fed' })
  assert.equal((denied as ActionResult).ok, false)
  assert.match((denied as ActionResult).message, /owners/)
  const forStranger = await arm!.run(actionCtx(f.agent, llm, 'Stranger'), { name: 'keep_fed' })
  assert.equal((forStranger as ActionResult).ok, false, 'an LLM turn for a non-owner cannot arm')

  const r = await arm!.run(actionCtx(f.agent, { kind: 'player', name: 'Robin' }), { name: 'keep_fed', options: 'below=10 hunt=false' }) as ActionResult
  assert.ok(r.ok, r.message)
  assert.match(r.message, /armed keep_fed \(below=10 hunt=false\)/)
  assert.equal(rt.store.armed()[0]!.by, 'player:Robin')

  const l = await arm!.run(actionCtx(f.agent, llm), { name: 'follow_owner', options: { distance: 5 } }) as ActionResult
  assert.ok(l.ok, l.message)
  assert.equal(rt.store.armed().find(a => a.name === 'follow_owner')?.by, 'brain:llm')

  const bad = await arm!.run(actionCtx(f.agent, llm), { name: 'keep_fed', options: { below: 50 } }) as ActionResult
  assert.equal(bad.ok, false)
  assert.match(bad.message, /bad options for keep_fed: below/)

  const cant = await arm!.run(actionCtx(f.agent, llm), { name: 'chop_wood_loop' }) as ActionResult
  assert.equal(cant.ok, false, 'armed but cannot run is reported as a failure')
  assert.match(cant.message, /can't run/)

  const c = await configure!.run(actionCtx(f.agent, llm), { name: 'collect_drops', options: 'radius=6' }) as ActionResult
  assert.ok(c.ok && /not armed/.test(c.message), c.message)

  const s = await status!.run(actionCtx(f.agent, llm), {}) as ActionResult
  assert.match(s.message, /keep_fed \(below=10 hunt=false/)
  assert.match(s.message, /follow_owner/)

  const d = await disarm!.run(actionCtx(f.agent, llm), { name: 'follow_owner' }) as ActionResult
  assert.ok(d.ok)
  const ls = await list!.run(actionCtx(f.agent, llm), {}) as ActionResult
  assert.match(ls.message, /keep_fed\*/)
  const one = await list!.run(actionCtx(f.agent, llm), { name: 'keep_fed' }) as ActionResult
  assert.match(one.message, /below=14/)
})

test('NPC mode: arms extra behaviours while the LLM is paused and disarms exactly those after', async () => {
  const { EventEmitter } = await import('node:events')
  const { behaviorsBrain } = await import('../src/brains/behaviors/brain.ts')
  const mem: Record<string, unknown> = {}
  const agent: any = Object.assign(new EventEmitter(), {
    definition: { name: 't' }, settings: { behaviors: { deposit_when_full: {} } },
    storage: { get: (k: string, d?: unknown) => (k in mem ? mem[k] : d), set: (k: string, v: unknown) => { mem[k] = v }, delete: (k: string) => { delete mem[k] } },
    log: { child: () => agent.log, info () {}, warn () {}, debug () {}, trace () {} },
    getAction: () => undefined, registerAction () {}
  })
  const brain = behaviorsBrain()
  brain.start!(agent)
  agent.emit('llmPaused', 'quota')
  const armedBy = mem['npcMode.armed'] as string[]
  assert.ok(armedBy.includes('chop_wood_loop') && !armedBy.includes('deposit_when_full'), 'deposit_when_full was already armed: not ours to disarm later')
  agent.emit('llmResumed')
  assert.equal(mem['npcMode.armed'], undefined)
})
