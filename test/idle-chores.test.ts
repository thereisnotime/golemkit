// Idle chore selection with the real Minecraft chores and the conditions Pax sat in for hours
// (snowy fortress, frozen farm, chests with 35 seeds, stone tools, no coal, nowhere to stroll).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { explainChores, choreSummary, type PickInput } from '../src/brains/npc/idle.ts'
import { idleSettings } from '../src/core/needs.ts'
import { choreIdle, type ChoreState } from '../src/skills/needPlan.ts'
import { minecraftChores } from '../src/adapters/minecraft-java/needs/chores.ts'

const chores = minecraftChores({} as any)
const pax: ChoreState = {
  homeDistance: 2, radius: 24, canDig: true, canPlace: true, sleeping: false,
  wood: 20, seeds: 35, farm: null, startFarm: true, spare: false, lightFuel: false, scoutTarget: 'iron', tidy: false
}
const now = 10_000_000
const input = (state: ChoreState, o: Partial<PickInput> = {}): PickInput => ({
  mode: 'active', isNight: false, hour: 10, now, last: {}, setting: (n) => idleSettings({}).chore(n),
  applicable: (n) => choreIdle(n, state) === null, whyNot: (n) => choreIdle(n, state), ...o
})

test("Pax's conditions: each chore says why it has nothing to do", () => {
  assert.equal(choreIdle('tidy_storage', pax), 'nothing to store yet')
  assert.equal(choreIdle('top_up_wood', pax), '20 logs, enough')
  assert.equal(choreIdle('top_up_seeds', pax), '35 seeds, enough')
  assert.equal(choreIdle('extend_farm', pax), null, 'no farm and 35 seeds: start one (the cold-ground farm makes this work)')
  assert.equal(choreIdle('craft_spares', pax), 'nothing spare to craft from what it carries')
  assert.equal(choreIdle('light_dark_spots', pax), 'no torches, coal or charcoal')
  assert.equal(choreIdle('scout_nearby', pax), null)
  assert.equal(choreIdle('top_up_seeds', { ...pax, seeds: 3 }), null, 'no farm and few seeds: gather them (it used to wait for a farm)')
  assert.match(choreIdle('extend_farm', { ...pax, seeds: 3 })!, /8 to start one/)
})

test('active mode with Pax: start a farm, then scout, then stroll, then look around; never stuck on nothing', () => {
  let last: Record<string, number> = {}
  const quietUntil: Record<string, number> = {}
  const order: string[] = []
  for (let i = 0; i < 4; i++) {
    const r = explainChores(chores, input(pax, { last, quietUntil }))
    assert.ok(r.pick, `pass ${i}: ${choreSummary(r.why)}`)
    order.push(r.pick.name)
    last = { ...last, [r.pick.name]: now }
  }
  assert.deepEqual(order, ['extend_farm', 'scout_nearby', 'stroll', 'look_around'])
})

test('a chore that found nothing waits its quiet pause, and the status says why each one is out', () => {
  const quietUntil = { scout_nearby: now + 60 * 60_000 }
  const r = explainChores(chores, input(pax, { last: { extend_farm: now - 60_000 }, quietUntil }))
  assert.equal(r.pick?.name, 'stroll')
  assert.match(r.why.scout_nearby!, /found nothing to do, again in 60m/)
  assert.match(r.why.extend_farm!, /again in 9m/)
  assert.match(r.why.top_up_seeds!, /35 seeds, enough/)
  const line = choreSummary(r.why)
  assert.match(line, /tidy_storage not needed \(nothing to store yet\)/)
  const cfg = idleSettings({ chores: { scout_nearby: { quietMinutes: 5 } } })
  assert.equal(cfg.chore('scout_nearby').quietMinutes, 5)
})

test('light_dark_spots waits 4 hours after lighting nothing (9 spots no torch reaches)', () => {
  const light = chores.find(c => c.name === 'light_dark_spots')!
  assert.equal(light.quietMinutes, 240)
  const lit = { ...pax, lightFuel: true }
  const r = explainChores(chores, input(lit, { last: { extend_farm: now, scout_nearby: now }, quietUntil: { light_dark_spots: now + 239 * 60_000 } }))
  assert.notEqual(r.pick?.name, 'light_dark_spots')
})

test('at night: rest by the bed, the day chores wait', () => {
  const r = explainChores(chores, input(pax, { isNight: true, hour: 23 }))
  assert.equal(r.pick?.name, 'rest_by_bed')
  assert.equal(r.why.extend_farm, 'waits for the day')
})
