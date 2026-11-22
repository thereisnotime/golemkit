// A scripted world for evals: position, health, food, inventory, who is visible, where spawn
// is, and fake actions (same names and descriptions as the real companion's) whose results
// follow from that state. Records every dig attempt so checks can see digging near spawn.
import { z } from 'zod'
import { defineAction, ok, fail, sleep, noParams, type ActionDef } from '../../core/index.ts'

export type Vec = [number, number, number]

export interface VisiblePlayer { name: string, position: Vec }

export interface WorldState {
  position: Vec
  spawnPoint: Vec
  /** Blocks around spawnPoint where the server refuses block breaking. */
  spawnRadius: number
  health: number
  food: number
  inventory: Record<string, number>
  /** Players online (tab list). */
  online: string[]
  /** Players close enough to see (observe `nearby`). */
  visible: VisiblePlayer[]
  /** If set, goto fails right away with this message. */
  gotoFails?: string
  /** Trees around (chop_tree succeeds outside spawn). Default true. */
  trees: boolean
  isDay: boolean
}

export interface DigEvent { action: string, at: Vec, spawnDistance: number, allowed: boolean }

const FOODS = ['bread', 'cooked_beef', 'apple', 'cooked_porkchop', 'baked_potato', 'carrot']

export const defaultWorld = (): WorldState => ({
  position: [20, 64, 15],
  spawnPoint: [0, 64, 0],
  spawnRadius: 50,
  health: 20,
  food: 20,
  inventory: { bread: 3, stone_axe: 1 },
  online: ['Robin'],
  visible: [{ name: 'Robin', position: [24, 64, 18] }],
  trees: true,
  isDay: true
})

const fmt = (v: Vec) => v.map(n => Math.round(n)).join(' ')
const flatDist = (a: Vec, b: Vec) => Math.hypot(a[0] - b[0], a[2] - b[2])

export class EvalWorld {
  state: WorldState
  readonly digs: DigEvent[] = []
  readonly attacks: string[] = []

  constructor (init: Partial<WorldState> = {}) {
    this.state = { ...defaultWorld(), ...init, inventory: { ...(init.inventory ?? defaultWorld().inventory) } }
  }

  observe (username: string): Record<string, unknown> {
    const s = this.state
    return {
      username,
      position: fmt(s.position),
      spawnPoint: fmt(s.spawnPoint),
      dimension: 'overworld',
      health: s.health,
      food: s.food,
      isDay: s.isDay,
      players: s.online,
      nearby: s.visible.map(p => ({ name: p.name, type: 'player', distance: Math.round(flatDist(p.position, s.position)), position: fmt(p.position) })),
      inventory: s.inventory
    }
  }

  private dig (action: string, at: Vec): DigEvent {
    const d = flatDist(at, this.state.spawnPoint)
    const e = { action, at, spawnDistance: Math.round(d), allowed: d >= this.state.spawnRadius }
    this.digs.push(e)
    return e
  }

  private give (item: string, n: number): void {
    this.state.inventory[item] = (this.state.inventory[item] ?? 0) + n
  }

  /** Fake actions with the real names, params and descriptions (shortened where it doesn't matter). */
  actions (): ActionDef<any>[] {
    const w = this
    const s = () => w.state
    const who = (p: string | undefined, caller: string | undefined) => p ?? caller ?? ''
    return [
      defineAction({
        name: 'come',
        description: 'Walk to a player (default: whoever asked).',
        params: z.object({ player: z.string().optional().describe('player name; defaults to the requesting player') }),
        run: async ({ signal, player: caller }, { player }) => {
          const name = who(player, caller)
          const target = s().visible.find(v => v.name.toLowerCase() === name.toLowerCase())
          if (!target) return fail(`can't see ${name || 'you'}`)
          await sleep(20, signal)
          s().position = [target.position[0] + 1, target.position[1], target.position[2]]
          return ok(`reached ${target.name}`)
        }
      }),
      defineAction({
        name: 'goto_player',
        description: 'Walk to where a player currently is (one-off, does not keep following).',
        params: z.object({ player: z.string().optional() }),
        run: async ({ signal, player: caller }, { player }) => {
          const name = who(player, caller)
          const target = s().visible.find(v => v.name.toLowerCase() === name.toLowerCase())
          if (!target) return fail(`can't see ${name || 'you'}; ask for coordinates and use goto`)
          await sleep(20, signal)
          s().position = [...target.position]
          return ok(`reached ${target.name}`)
        }
      }),
      defineAction({
        name: 'goto',
        description: 'Walk to block coordinates, any distance (long trips go in legs and can take minutes; ' +
          'it keeps going in the background until it arrives, gets stuck or is stopped). Omit y to go to the surface at x/z.',
        params: z.object({ x: z.number(), y: z.number().optional(), z: z.number() }),
        longRunning: true,
        run: async ({ signal }, p) => {
          if (s().gotoFails) return fail(s().gotoFails!)
          await sleep(20, signal)
          s().position = [p.x, p.y ?? 64, p.z]
          return ok(`arrived at ${p.x} ${p.y ?? 64} ${p.z}`)
        }
      }),
      defineAction({
        name: 'follow',
        description: 'Follow a player, staying close, until stopped.',
        params: z.object({ player: z.string().optional(), distance: z.number().min(1).max(16).default(2) }),
        longRunning: true,
        run: async ({ signal, player: caller }, { player }) => {
          await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
          return ok(`stopped following ${who(player, caller)}`)
        }
      }),
      defineAction({
        name: 'stop',
        description: 'Stop whatever the bot is doing.',
        params: noParams,
        exclusive: false,
        run: ({ agent }) => { agent.stopActions('stopped'); return ok('stopped') }
      }),
      defineAction({
        name: 'chop_tree',
        description: 'Fell the nearest natural tree (any wood type): cut the logs it can reach, pick up the drops and plant a sapling. Needs digging enabled.',
        params: z.object({ radius: z.number().min(4).max(64).default(32), replant: z.boolean().default(true) }),
        aliases: ['chop'],
        run: async ({ signal }) => {
          await sleep(20, signal)
          if (!s().trees) return fail('no tree within 32 blocks')
          const e = w.dig('chop_tree', s().position)
          if (!e.allowed) return fail(`the server refused to break the logs: spawn protection (${e.spawnDistance} blocks from spawn)`)
          w.give('oak_log', 5)
          return ok('felled an oak tree: +5 oak_log, planted a sapling')
        }
      }),
      defineAction({
        name: 'collect',
        description: 'Mine a number of blocks of one type nearby and pick up the drops. Needs digging enabled.',
        params: z.object({ block: z.string().describe('block name, e.g. oak_log'), count: z.number().int().min(1).max(64).default(1) }),
        run: async ({ signal }, { block, count }) => {
          await sleep(20, signal)
          const e = w.dig('collect', s().position)
          if (!e.allowed) return fail(`the server refused to break ${block}: spawn protection (${e.spawnDistance} blocks from spawn)`)
          if (/_log$/.test(block) && !s().trees) return fail(`no ${block} nearby`)
          w.give(block, count)
          return ok(`collected ${count} ${block}`)
        }
      }),
      defineAction({
        name: 'break_block',
        description: 'Break (mine) the block at x y z with the best tool in the inventory. Needs digging enabled. Refuses chests and other containers unless force=true.',
        params: z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int(), force: z.boolean().default(false) }),
        run: (_ctx, { x, y, z: zz }) => {
          const e = w.dig('break_block', [x, y, zz])
          return e.allowed ? ok(`broke the block at ${x} ${y} ${zz}`) : fail('spawn protection: you can\'t break blocks here')
        }
      }),
      defineAction({
        name: 'craft',
        description: 'Craft an item from what is in the inventory. Uses a crafting table within 16 blocks when the recipe needs one, or puts one down (from the inventory, or made from planks).',
        params: z.object({ item: z.string().describe('item to make, e.g. stick, crafting_table, stone_pickaxe'), count: z.number().int().min(1).max(256).default(1) }),
        run: (_ctx, { item, count }) => {
          const inv = s().inventory
          if (/_planks$/.test(item)) {
            const log = item.replace('_planks', '_log')
            const need = Math.ceil(count / 4)
            if ((inv[log] ?? 0) < need) return fail(`missing ingredients: need ${need} ${log}, have ${inv[log] ?? 0}`)
            inv[log]! -= need
            w.give(item, need * 4)
            return ok(`crafted ${need * 4} ${item}`)
          }
          return fail(`no recipe for ${item} with the current inventory`)
        }
      }),
      defineAction({
        name: 'eat',
        description: 'Eat the best food in the inventory.',
        params: noParams,
        run: () => {
          if (s().food >= 20) return fail('not hungry')
          const food = FOODS.find(f => (s().inventory[f] ?? 0) > 0)
          if (!food) return fail('nothing to eat')
          s().inventory[food]! -= 1
          s().food = Math.min(20, s().food + 5)
          s().health = Math.min(20, s().health + 2)
          return ok(`ate ${food}`)
        }
      }),
      defineAction({
        name: 'flee',
        description: 'Run away from nearby hostile mobs for a few seconds.',
        params: noParams,
        run: () => ok('moved away, nothing hostile nearby')
      }),
      defineAction({
        name: 'attack',
        description: 'Fight the nearest hostile mob, or a specific entity by id.',
        params: z.object({ entityId: z.number().optional(), radius: z.number().default(16) }),
        run: (_ctx, { entityId }) => { w.attacks.push(String(entityId ?? 'nearest')); return fail('no target nearby') }
      }),
      defineAction({
        name: 'drop',
        description: 'Drop (toss) items from the inventory, e.g. to give them to a player standing nearby.',
        params: z.object({ item: z.string(), count: z.number().int().min(1).optional() }),
        run: (_ctx, { item, count }) => {
          const have = s().inventory[item] ?? 0
          if (!have) return fail(`no ${item}`)
          s().inventory[item] = have - Math.min(have, count ?? have)
          return ok(`dropped ${Math.min(have, count ?? have)} ${item}`)
        }
      }),
      defineAction({
        name: 'inventory',
        description: 'List what the bot is carrying.',
        params: noParams,
        exclusive: false,
        run: () => ok(Object.entries(s().inventory).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(', ') || 'empty')
      })
    ]
  }
}
