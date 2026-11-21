// A fake agent for unit tests and scripts/llm-smoke.ts: real action definitions and a real
// action lock with priorities, no Minecraft connection. Records chat and action calls.
import { z } from 'zod'
import { Storage, PRIORITY, defineAction, ok, fail, sleep, createLogger, type ActionDef, type ActionResult, type ActOptions, type ActionInfo, type ActionCatalogEntry, type BotDefinition } from '../core/index.ts'
import type { RuntimeAgent } from './runtime.ts'

export interface FakeCall { name: string, params: unknown, priority: number, player?: string }

export const fakeActions = (): ActionDef<any>[] => [
  defineAction({
    name: 'come',
    description: 'Walk to a player (default: whoever asked).',
    params: z.object({ player: z.string().optional() }),
    run: async ({ player, signal }, p) => { await sleep(50, signal); return ok(`reached ${p.player ?? player}`) }
  }),
  defineAction({
    name: 'follow',
    description: 'Follow a player, staying close, until stopped.',
    params: z.object({ player: z.string().optional(), distance: z.number().min(1).max(16).default(2) }),
    longRunning: true,
    run: async ({ player, signal }, p) => {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      return ok(`stopped following ${p.player ?? player}`)
    }
  }),
  defineAction({
    name: 'goto',
    description: 'Walk to coordinates.',
    params: z.object({ x: z.number(), y: z.number().optional(), z: z.number() }),
    run: async ({ signal }, p) => { await sleep(50, signal); return ok(`arrived at ${p.x} ${p.y ?? '~'} ${p.z}`) }
  }),
  defineAction({
    name: 'jump',
    description: 'Jump once.',
    params: z.object({}),
    exclusive: false,
    run: () => ok('jumped')
  }),
  defineAction({
    name: 'say',
    description: 'Say something in public chat.',
    params: z.object({ text: z.string() }),
    exclusive: false,
    run: () => ok('')
  }),
  defineAction({
    name: 'stop',
    description: 'Stop whatever the bot is doing.',
    params: z.object({}),
    exclusive: false,
    run: ({ agent }) => { agent.stopActions('stopped'); return ok('stopped') }
  })
]

/** Minimal Agent stand-in: action lock with preemption (no resume), chat log, storage in a temp dir. */
export class FakeAgent implements RuntimeAgent {
  readonly username: string
  readonly storage: Storage
  readonly definition: BotDefinition
  readonly log = createLogger('fake')
  readonly said: { to?: string, msg: string }[] = []
  readonly calls: FakeCall[] = []
  owners: string[] = []
  private readonly actions = new Map<string, ActionDef<any>>()
  private running: { info: ActionInfo, controller: AbortController } | null = null

  /** Overrides observe() (a scripted world for evals). */
  observation?: () => Record<string, unknown>

  constructor (opts: { username?: string, dataDir: string, actions?: ActionDef<any>[], persona?: string, observation?: () => Record<string, unknown> }) {
    this.username = opts.username ?? 'Buddy'
    this.observation = opts.observation
    this.storage = new Storage(opts.dataDir)
    for (const a of opts.actions ?? fakeActions()) this.actions.set(a.name, a)
    this.definition = { name: 'fake', skills: [], brains: [], persona: opts.persona }
  }

  actionCatalog (): ActionCatalogEntry[] {
    return [...this.actions.values()].filter(a => !a.internal).map(a => ({
      name: a.name,
      description: a.description,
      inputSchema: z.toJSONSchema(a.params, { io: 'input' }) as Record<string, unknown>,
      exclusive: a.exclusive !== false,
      longRunning: !!a.longRunning
    }))
  }

  get currentAction (): ActionInfo | null {
    return this.running?.info ?? null
  }

  /** Puts an action in the lock as if someone else started it (for busy tests). Returns a function that ends it. */
  occupy (name: string, priority: number, caller: ActionInfo['caller'] = { kind: 'player', name: 'Steve' }): () => void {
    const controller = new AbortController()
    this.running = { info: { name, params: {}, caller, priority }, controller }
    return () => { if (this.running?.controller === controller) this.running = null }
  }

  stopActions (): void {
    this.running?.controller.abort('stopped')
    this.running = null
  }

  async act (name: string, params: unknown = {}, opts: ActOptions = {}): Promise<ActionResult> {
    const def = this.actions.get(name)
    if (!def) return fail(`unknown action "${name}"`)
    const parsed = def.params.safeParse(params ?? {})
    if (!parsed.success) return fail(`bad parameters for ${name}: ${z.prettifyError(parsed.error).replace(/\n/g, '; ')}`)
    const caller = opts.caller ?? { kind: 'system', name: 'system' }
    const priority = opts.priority ?? PRIORITY.npc
    this.calls.push({ name, params: parsed.data, priority, player: opts.player })
    const controller = new AbortController()
    const ctx = { agent: this as any, bot: {} as any, signal: controller.signal, caller, player: opts.player, log: this.log }
    if (def.exclusive === false) return normalize(await def.run(ctx, parsed.data))
    const cur = this.running
    if (cur) {
      if (cur.info.priority > priority) return fail(`busy: ${cur.info.name} (${cur.info.caller.kind} ${cur.info.caller.name})`)
      cur.controller.abort('replaced')
    }
    const mine = { info: { name, params: parsed.data, caller, priority }, controller }
    this.running = mine
    try {
      return normalize(await def.run(ctx, parsed.data))
    } catch (e) {
      return fail(controller.signal.aborted ? String(controller.signal.reason) : (e as Error).message)
    } finally {
      if (this.running === mine) this.running = null
    }
  }

  observe (): Record<string, unknown> {
    if (this.observation) return { ...this.observation(), currentAction: this.currentAction ? { name: this.currentAction.name } : null }
    return {
      username: this.username,
      position: '10 64 -20',
      health: 20,
      food: 18,
      isDay: true,
      currentAction: this.currentAction ? { name: this.currentAction.name } : null,
      players: ['Steve'],
      nearby: [{ name: 'Steve', type: 'player', distance: 4 }],
      inventory: { bread: 3 }
    }
  }

  say (msg: string): void { this.said.push({ msg }) }
  whisper (to: string, msg: string): void { this.said.push({ to, msg }) }
  isOwner (player: string): boolean { return this.owners.length === 0 || this.owners.includes(player.toLowerCase()) }
}

function normalize (r: ActionResult | string | void): ActionResult {
  if (r === undefined) return { ok: true, message: 'done' }
  if (typeof r === 'string') return { ok: true, message: r }
  return r
}
