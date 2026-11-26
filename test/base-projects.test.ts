// Base projects end to end on a fake world shaped like Pax's fortress: the old 15x15 plank walls
// one block up, a dirt floor with the hut on it, a paused LLM goal asking for fortress v2. The
// survey must find the base, extend it rather than rebuild it, and take the paused goal's asks.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Vec3 } from 'vec3'
import { Agent, defineVariant } from '../src/core/index.ts'
import { standardSkills, extendedSkills } from '../src/skills/index.ts'
import { planBase, planLines, gateOf } from '../src/skills/projects.ts'
import { loadBlueprints, rotate, placeCells } from '../src/skills/blueprint.ts'
import { fakeBot, WORLDS } from './fake-world.ts'
import { attachFakeBot } from './fake-attach.ts'

const SERVER = { host: 'golden.invalid', port: 25565, auth: 'offline' as const, version: '1.21.1' }
const tmp = mkdtempSync(join(tmpdir(), 'golemkit-projects-'))

function paxWorld (): { blocks: Map<string, string>, origin: { x: number, y: number, z: number } } {
  const origin = { x: 560, y: 67, z: -43 }
  const bp = rotate(loadBlueprints().blueprints.get('fortress')!, 'north')
  const blocks = new Map<string, string>()
  // the old fortress: plank walls (layers 1-3 of v2), its door
  for (const c of placeCells(bp, origin)) {
    if (c.role === 'wall' && c.y <= origin.y + 3) blocks.set(`${c.x},${c.y},${c.z}`, 'spruce_planks')
    if (c.role === 'door') blocks.set(`${c.x},${c.y},${c.z}`, 'spruce_door')
  }
  // the hut inside, its floor one up
  for (let x = 558; x <= 562; x++) for (let z = -48; z <= -44; z++) blocks.set(`${x},68,${z}`, 'spruce_planks')
  return { blocks, origin }
}

function paxAgent () {
  const agent = new Agent(defineVariant({ name: 'pax-test', skills: [...standardSkills(), ...extendedSkills()], brains: [] }), SERVER, {
    username: 'Pax', owners: ['pe4ka'], dataDir: join(tmp, 'pax'), canDig: true
  })
  const bot = fakeBot({ ...WORLDS[Object.keys(WORLDS)[0]!]!, username: 'Pax', position: [560.5, 69, -42.5], gameMode: 'survival', health: 20, food: 20, timeOfDay: 1000, players: [], mobs: [] })
  const { blocks } = paxWorld()
  bot.blockAt = (p: Vec3) => {
    const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
    const name = blocks.get(k) ?? (p.y <= 67 ? 'dirt' : 'air')
    return { name, position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), getProperties: () => ({}) }
  }
  attachFakeBot(agent, bot)
  agent.storage.set('home', { x: 560, y: 68, z: -46, dimension: 'overworld' })
  agent.storage.set('places', { fortress: { x: 560, y: 68, z: -43, dimension: 'overworld' } })
  const now = Date.now()
  agent.storage.set('llm.goal', {
    id: 'g1', text: 'Upgrade our fortress to fortress v2: stone floor, corner towers, walkway and gate torches (pe4ka asked to fix the floor)', owner: 'pe4ka',
    steps: [], notes: [], createdAt: now - 86_400_000, updatedAt: now - 3_600_000, autoTurns: 80, totalTurns: 290, deadlineAt: now - 3_600_000,
    failures: {}, stalls: 0, paused: 'waiting for the owner', pausedAt: now - 3_600_000
  })
  return { agent, bot }
}

test('Pax\'s fortress: found one block below the place, the old walls count, the paused goal\'s asks are taken', () => {
  const { agent, bot } = paxAgent()
  const p = planBase(agent, bot)
  assert.equal(typeof p, 'object')
  if (typeof p === 'string') return
  assert.deepEqual(p.survey.base.origin, { x: 560, y: 67, z: -43 })
  assert.equal(p.survey.base.facing, 'north')
  assert.equal(p.survey.base.fresh, false)
  const by = Object.fromEntries(p.queue.map(e => [e.info.name, e]))
  // the walls: plank walls stand; the foundation under them and the battlements and gate torches are left
  assert.ok(by.walls!.info.left > 0 && by.walls!.info.left < by.walls!.info.total / 2)
  // the floor: the hut's columns are left alone, the rest is dirt to replace
  const floor = p.survey.projects.find(x => x.info.name === 'floor')!
  assert.ok((floor.note ?? '').includes('under other builds'))
  assert.equal(by.floor!.info.requestedBy, 'pe4ka')
  assert.equal(by.towers!.info.requestedBy, 'pe4ka')
  assert.equal(by.walkway!.info.requestedBy, 'pe4ka')
  // paused goal: the projects go ahead; the walls first
  assert.equal(p.holds, false)
  assert.equal(by.walls!.status, 'ready')
  assert.equal(p.step.kind, 'work')
  assert.equal(p.step.kind === 'work' && p.step.entry.info.name, 'walls')
  // the gate on the north wall: outside to the north, inside to the south
  const gate = gateOf(p.survey.base)!
  assert.ok(gate)
  assert.equal(gate.outside.z, gate.door.z - 1)
  assert.equal(gate.inside.z, gate.door.z + 1)
  const lines = planLines(agent, bot, p, true)
  assert.match(lines[0]!, /fortress at 560 67 -43, gate north/)
  assert.ok(lines.some(l => /^ {2}floor: .*cobblestone/.test(l)))
  if (process.env.SHOW_PLAN) console.log(lines.join("\n"))
})

test('an active LLM building goal keeps the projects waiting', () => {
  const { agent, bot } = paxAgent()
  const g = agent.storage.get<Record<string, unknown>>('llm.goal')!
  agent.storage.set('llm.goal', { ...g, paused: undefined, updatedAt: Date.now() })
  const p = planBase(agent, bot)
  assert.ok(typeof p !== 'string')
  if (typeof p === 'string') return
  assert.equal(p.holds, true)
  assert.equal(p.step.kind, 'none')
})

test('the project action: owners only; pause stops the work', async () => {
  const { agent, bot } = paxAgent()
  const call = (params: Record<string, unknown>, player: string) => agent.act('project', params, { caller: { kind: 'player', name: player }, priority: 50, player })
  assert.equal((await call({ op: 'pause' }, 'stranger')).ok, false)
  assert.equal((await call({ op: 'skip', name: 'the towers' }, 'pe4ka')).ok, true)
  assert.equal((await call({ op: 'pause' }, 'pe4ka')).ok, true)
  const p = planBase(agent, bot)
  assert.ok(typeof p !== 'string')
  if (typeof p === 'string') return
  assert.equal(p.queue.find(e => e.info.name === 'towers')!.status, 'skipped')
  assert.equal(p.step.kind, 'none')
  const r = await agent.act('plan_base', {}, { caller: { kind: 'player', name: 'pe4ka' }, priority: 50, player: 'pe4ka' })
  assert.ok(r.ok)
  assert.match(r.message, /paused by pe4ka/)
})
