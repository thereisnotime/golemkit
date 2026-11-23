// keep_spawn_bed: keeps a bed at home and the respawn point on it, so a death ends at home
// instead of at world spawn. The decision is the pure planner nextBedStep (src/skills/bedPlan.ts);
// the spawn point itself is tracked by the spawn_bed skill (server messages, sleeping, where the
// bot respawns). The work goes through ctx.act().
import type { Bot } from 'mineflayer'
import { z, needsSurvival, type Agent } from '../../../core/index.ts'
import { defineBehavior } from '../../../brains/behaviors/types.ts'
import { getHome, sameDimension } from '../../../skills/navigation.ts'
import { inventoryCounts } from '../../../skills/toolkit.ts'
import { knownContainers, ownChests, configuredChests } from '../../../skills/containers.ts'
import { huntRefusal } from '../../../skills/combat.ts'
import { getSpawn, checkSpawnBed, ownBedsNear, spawnBedState, shearable } from '../../../skills/bed.ts'
import {
  nextBedStep, recordSheepSearch, isBedItem, SHEEP_RINGS, SHEEP_RING_MEMORY_MS, DEFAULT_ASK_TEXT, DEFAULT_REMIND_TEXT,
  type BedStep, type BedWorld, type OwnChest
} from '../../../skills/bedPlan.ts'
import type { SearchRecord } from '../../../skills/foodPlan.ts'
import { WOOD_NEED } from './tools.ts'
import { isDay, flatDist } from './util.ts'
import { tripRun } from './trip.ts'

const SEARCHES_KEY = 'spawnBed.searches'

const options = z.object({
  homeRange: z.number().min(2).max(16).default(6).describe('the bed goes within this many blocks of home'),
  radius: z.number().min(8).max(64).default(32).describe('how far to look for sheep before searching further out'),
  rings: z.array(z.number().min(32).max(1024)).max(6).default([...SHEEP_RINGS]).describe('search rings for sheep around home, smallest first (by day)'),
  ringMemoryMinutes: z.number().min(1).max(240).default(SHEEP_RING_MEMORY_MS / 60_000).describe('remember an empty ring this long before searching it again'),
  spareSheep: z.number().int().min(0).max(16).default(2).describe('adult sheep to leave alive when hunting for wool (shearing spares them all)'),
  graceSeconds: z.number().min(0).max(120).default(12).describe('at night: how long to stay in bed waiting for the others before getting up'),
  ask: z.boolean().default(true).describe('at night: ask the players still up to go to bed'),
  askText: z.string().max(200).default(DEFAULT_ASK_TEXT).describe('first ask; {players} is replaced by the names'),
  remindText: z.string().max(200).default(DEFAULT_REMIND_TEXT).describe('reminders; {players}, {sleeping}, {needed}'),
  askEverySeconds: z.number().min(3).max(60).default(5).describe('between asks'),
  maxAsks: z.number().int().min(0).max(5).default(3).describe('asks per night, the first one included'),
  sleepingPercentage: z.number().int().min(0).max(101).default(100).describe("the server's playersSleepingPercentage, until the server reports a count"),
  ignore: z.array(z.string()).default([]).describe('players never asked to sleep (other bots)')
})
type Options = z.infer<typeof options>

/** Own and configured chests within `range` of home with what the bot last saw in them. */
function chestsNearHome (agent: Agent, home: { x: number, z: number }, range: number): OwnChest[] {
  const seen = knownContainers(agent)
  const own = [...ownChests(agent), ...configuredChests(agent)]
  return own
    .filter(p => Math.hypot(p.x - home.x, p.z - home.z) <= range)
    .map(p => ({ ...p, contents: seen.find(c => c.x === p.x && c.y === p.y && c.z === p.z)?.contents ?? {} }))
}

function sheepCounts (bot: Bot, radius: number, spare: number, agent: Agent): { shearable: number, huntable: number } {
  const me = bot.entity.position
  let shear = 0
  let woolly = 0
  let adults = 0
  const keys = (bot.registry as any).entitiesByName?.sheep?.metadataKeys as string[] | undefined
  for (const e of Object.values(bot.entities ?? {})) {
    if (e.name !== 'sheep' || e.position.distanceTo(me) > radius || agent.protectedAreas.isProtected(e.position)) continue
    if (huntRefusal(e as any, { animals: ['sheep'], metadataKeys: keys })) continue
    adults++
    if (shearable(bot, e)) { shear++; woolly++ }
  }
  return { shearable: shear, huntable: Math.max(0, Math.min(woolly, adults - spare)) }
}

export const keepSpawnBed = defineBehavior({
  name: 'keep_spawn_bed',
  capabilities: ['place', 'sleep', 'move', 'craft'],
  category: 'routine',
  description: 'Keeps a bed at home and the respawn point on it, so after a death it comes back at home. Knows whether the point is set ' +
    '(server messages, where it respawns); if not: uses its own bed near home, else places one from the inventory or its chests, else crafts ' +
    'one (3 wool of one colour + 3 planks; wool by shearing, shears from 2 iron, or hunting sheep, searching rings for sheep by day), then ' +
    'right-clicks it. At night that is a short sleep: it waits a few seconds and asks players still up to go to bed. Never breaks a bed; ' +
    'below safety and food, above idle; backs off with a reason ("no sheep found within 250").',
  options,
  requires: ['place_bed', 'set_spawn'],
  uses: ['go_home', 'withdraw', 'craft', 'shear', 'hunt', 'find_food'],
  needs: { place: true },
  priority: 'npc',
  create (o: Options, { agent }) {
    let cached: { at: number, step: BedStep | null } | null = null
    let lastStuck = ''
    const can = (n: string) => !!agent.getAction(n)
    const world = (bot: Bot, now: number): BedWorld | null => {
      if (!bot.entity || !needsSurvival(bot)) return null
      const home = getHome(agent) ?? null
      const spawn = checkSpawnBed(agent, bot)
      const inHomeDim = !!home && sameDimension(bot, home)
      const own = home && inHomeDim ? ownBedsNear(agent, bot, home, o.homeRange + 2)[0] : undefined
      const sheep = sheepCounts(bot, o.radius, o.spareSheep, agent)
      return {
        now,
        home,
        inHomeDim,
        spawn,
        spawnBed: spawnBedState(bot, spawn),
        ownBed: own ? own.pos : null,
        inv: inventoryCounts(bot),
        chests: home ? chestsNearHome(agent, home, 32) : [],
        shearable: sheep.shearable,
        huntable: sheep.huntable,
        night: !isDay(bot),
        searches: agent.storage.get<SearchRecord[]>(SEARCHES_KEY, []),
        can: { craft: can('craft'), hunt: can('hunt'), shear: can('shear'), search: can('find_food'), withdraw: can('withdraw'), place: agent.settings.canPlace !== false && can('place_bed'), use: can('set_spawn') }
      }
    }
    const plan = (bot: Bot, now: number, fresh = false): BedStep | null => {
      if (!fresh && cached && now - cached.at < 5000) return cached.step
      const w = world(bot, now)
      const step = w ? nextBedStep(w, { homeRange: o.homeRange + 2, rings: o.rings, ringMemoryMs: o.ringMemoryMinutes * 60_000 }) : null
      cached = { at: now, step }
      if (step?.do === 'stuck' && step.why !== lastStuck) agent.log.info(`keep_spawn_bed: ${step.why}`)
      lastStuck = step?.do === 'stuck' ? step.why : ''
      return step
    }
    const sleepParams = () => ({
      grace_seconds: o.graceSeconds, ask: o.ask, ask_text: o.askText, remind_text: o.remindText,
      ask_every_seconds: o.askEverySeconds, max_asks: o.maxAsks, sleeping_percentage: o.sleepingPercentage, ignore: o.ignore
    })
    return {
      cooldownMs: 10_000,
      failureCooldownMs: 60_000,
      maxFailureCooldownMs: 30 * 60_000,
      score: ({ bot, now, current }) => {
        if (current === 'keep_spawn_bed') return 24
        const step = plan(bot as Bot, now)
        return step && step.do !== 'stuck' ? 24 : 0
      },
      // the back-off ends early when what it holds for a bed changes (wool, planks, a bed, shears given or picked up)
      retryKey: ({ bot }) => {
        const inv = (bot as Bot).inventory ? inventoryCounts(bot as Bot) : {}
        return Object.entries(inv).filter(([k]) => isBedItem(k) || /_wool$|_planks$|_log$|^shears$|^iron_ingot$/.test(k)).map(([k, v]) => `${k}:${v}`).sort().join(',')
      },
      async run (ctx) {
        const bot = ctx.bot as Bot
        const step = plan(bot, ctx.now, true)
        if (!step) return { ok: true, message: 'respawn point is at home' }
        const home = getHome(agent)
        const farFromHome = !!home && !!bot.entity && flatDist(bot.entity.position, home) > 16
        switch (step.do) {
          case 'stuck':
            if (step.need === 'wood') ctx.bb.setNeed(WOOD_NEED, 1)
            return { ok: false, message: step.why }
          case 'use': {
            if (farFromHome && can('go_home')) { const r = await ctx.act('go_home', { range: 3 }); if (!r.ok) return r }
            return ctx.act('set_spawn', { x: step.bed.x, y: step.bed.y, z: step.bed.z, ...sleepParams() })
          }
          case 'place': {
            if (farFromHome && can('go_home')) { const r = await ctx.act('go_home', { range: 3 }); if (!r.ok) return r }
            const r = await ctx.act('place_bed', { item: step.item, range: o.homeRange })
            if (!r.ok) return r
            const at = r.data as { x: number, y: number, z: number }
            return ctx.act('set_spawn', { x: at.x, y: at.y, z: at.z, ...sleepParams() })
          }
          case 'withdraw':
            return ctx.act('withdraw', { item: step.item, count: step.count, x: step.from.x, y: step.from.y, z: step.from.z })
          case 'craft':
            return ctx.act('craft', { item: step.item, count: step.count })
          case 'shear':
            return ctx.act('shear', { count: 3, radius: o.radius })
          case 'hunt':
            return ctx.act('hunt', { animal: 'sheep', count: step.count, radius: o.radius, keepAtLeast: o.spareSheep })
          case 'search': {
            // a trip (skills/trip.ts): pantry food and a weapon first, and back home when food or daylight runs short
            const r = await tripRun(ctx, { purpose: `looking for sheep ${step.radius} blocks out`, kind: 'wool', distance: step.radius },
              () => ctx.act('find_food', { animals: ['sheep'], radius: step.radius, minRadius: step.covered, keepAtLeast: o.spareSheep, from: 'home', maxMinutes: 8 }))
            if ((r.data as { turnedBack?: string, trip?: boolean } | undefined)?.turnedBack || (r.data as { trip?: boolean } | undefined)?.trip) return r
            // only a ring searched all the way round counts as empty; one cut short (night, time, a cave) is tried again
            const why = (r.data as { reason?: string } | undefined)?.reason ?? ''
            if (r.ok || /^covered every direction/.test(why)) {
              const searches = agent.storage.get<SearchRecord[]>(SEARCHES_KEY, [])
              agent.storage.set(SEARCHES_KEY, recordSheepSearch(searches, step.radius, r.ok, Date.now()))
            }
            return r.ok ? r : { ok: false, message: `no sheep within ${step.radius}: ${r.message}` }
          }
        }
      }
    }
  }
})

export { getSpawn }
