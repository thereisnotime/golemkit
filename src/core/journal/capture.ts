// Feeds the journal from agent events (actions, chat, LLM usage, protected areas) and from
// each session's mineflayer bot (deaths, damage, inventory, blocks, players, places). Created
// by the Agent, so every bot records regardless of its brains.
import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import type { Agent, ActionInfo } from '../agent.ts'
import type { ActionResult } from '../action.ts'
import { itemName } from '../helpers.ts'
import type { Journal } from './journal.ts'
import type { Pos } from './types.ts'
import { InventoryTracker, DamageAggregator, BlockAggregator, type Counts } from './aggregate.ts'
import { parseDeathMessage, parseAdvancement, type DeathInfo } from './deathMessages.ts'

const SECRET_CMD = /^\/(login|log|l|register|reg|changepassword|changepass|cp)\b.*/i
const cut = (s: unknown, n: number) => { const t = String(s ?? ''); return t.length > n ? t.slice(0, n - 1) + '…' : t }

/** Slash commands that carry passwords keep only the command name. */
export function maskChat (msg: string): string {
  return SECRET_CMD.test(msg) ? msg.replace(SECRET_CMD, (_m, c) => `/${c} ***`) : msg
}

/** Text of a kick/disconnect reason (string or chat component JSON). */
export function reasonText (r: unknown): string {
  if (typeof r === 'string') {
    try { return reasonText(JSON.parse(r)) } catch { return r }
  }
  if (r && typeof r === 'object') {
    const o = r as Record<string, any>
    const own = typeof o.text === 'string' ? o.text : typeof o.translate === 'string' ? o.translate : ''
    const extra = Array.isArray(o.extra) ? o.extra.map(reasonText).join('') : ''
    const value = o.value !== undefined && typeof o.value !== 'object' ? String(o.value) : ''
    return (own + extra || value || JSON.stringify(r)).trim()
  }
  return String(r ?? '')
}

export function inventoryCounts (bot: Bot): Counts {
  const c: Counts = {}
  try {
    for (const i of bot.inventory.items()) c[itemName(i)] = (c[itemName(i)] ?? 0) + i.count
  } catch {}
  return c
}

function entityName (e: Entity | undefined | null): string {
  if (!e) return 'unknown'
  if (e.type === 'player') return e.username ?? 'player'
  return (e.displayName as string | undefined) ?? e.name ?? 'unknown'
}

const posOf = (bot: Bot): Pos | undefined => bot.entity?.position ? { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z } : undefined

export class JournalCapture {
  private readonly agent: Agent
  private readonly journal: Journal
  private bot: Bot | null = null
  private starts = new WeakMap<ActionInfo, number>()
  /** Exclusive action holding the body, for "what was it doing" on deaths and item changes. */
  private current: string | null = null
  private lastKick: string | null = null

  constructor (agent: Agent, journal: Journal) {
    this.agent = agent
    this.journal = journal
    if (!journal.enabled) return
    agent.on('actionStart', info => this.onActionStart(info))
    agent.on('actionEnd', (info, result) => this.onActionEnd(info, result))
    agent.on('chat', m => {
      const pos = this.pos()
      if (m.whisper) journal.record('whisper', { dir: 'in', from: m.from, message: cut(maskChat(m.message), 256) }, pos)
      else journal.record('chat_in', { from: m.from, message: cut(maskChat(m.message), 256) }, pos)
    })
    agent.on('chatOut', m => {
      const message = cut(maskChat(m.message), 256)
      if (m.to) journal.record('whisper', { dir: 'out', to: m.to, message }, this.pos())
      else journal.record('chat_out', { message }, this.pos())
    })
    agent.on('serverMessage', text => this.onServerMessage(text))
    agent.on('llmUsage', snap => {
      const t = snap.last
      if (!t) return
      const trigger = (snap as unknown as { trigger?: string }).trigger ?? (t as unknown as { trigger?: string }).trigger
      journal.record('llm_turn', {
        provider: t.provider, ...(t.model ? { model: t.model } : {}), ok: t.ok,
        inputTokens: t.inputTokens, outputTokens: t.outputTokens, cacheReadTokens: t.cacheReadTokens,
        toolCalls: t.toolCalls, ms: t.durationMs, ...(trigger ? { trigger } : {}), ...(t.estimated ? { estimated: true } : {})
      })
    })
    agent.on('protectedArea', p => journal.record('protected_area', {}, { pos: p, dim: this.bot?.game?.dimension }))
    // A goals system can emit `goal` on the agent ({ goal, status, ... }) or call journal.record('goal', ...).
    ;(agent.on as (ev: string, fn: (d: unknown) => void) => void)('goal', (d: unknown) => {
      journal.record('goal', d && typeof d === 'object' ? d as Record<string, unknown> : { goal: String(d) }, this.pos())
    })
    agent.on('sessionEnd', reason => {
      journal.record('disconnect', { reason: cut(this.lastKick ?? reason, 200) })
      this.lastKick = null
      journal.flush()
    })
  }

  private pos (): { pos?: Pos, dim?: string } {
    const b = this.bot
    if (!b?.entity) return {}
    return { pos: posOf(b), dim: b.game?.dimension }
  }

  private onActionStart (info: ActionInfo): void {
    this.starts.set(info, Date.now())
    if (this.agent.getAction(info.name)?.exclusive !== false) this.current = info.name
  }

  private onActionEnd (info: ActionInfo, result: ActionResult): void {
    const started = this.starts.get(info) ?? Date.now()
    const def = this.agent.getAction(info.name)
    const exclusive = def?.exclusive !== false
    if (exclusive && this.current === info.name) this.current = null
    const cfg = this.journal.config.actions
    if (cfg.skip.has(info.name)) return
    if (!exclusive && !cfg.includeStatus && result.ok) return
    const params = info.params && typeof info.params === 'object' && Object.keys(info.params).length ? cut(JSON.stringify(info.params), 120) : undefined
    this.journal.record('action', {
      name: info.name,
      caller: `${info.caller.kind}:${info.caller.name}`,
      ok: result.ok,
      message: cut(result.message, 160),
      ms: Date.now() - started,
      ...(params ? { params } : {}),
      ...(info.player ? { player: info.player } : {})
    }, this.pos())
  }

  // ---------------------------------------------------------------- server messages

  private recentServer: { at: number, death: DeathInfo }[] = []
  private pendingDeath: ((d: DeathInfo | null) => void) | null = null
  private recentKills = new Map<string, number>()

  private onServerMessage (text: string): void {
    const me = this.agent.username
    const death = parseDeathMessage(text)
    if (death) {
      if (death.victim === me) {
        if (this.pendingDeath) this.pendingDeath(death)
        else this.recentServer.push({ at: Date.now(), death })
        this.recentServer = this.recentServer.filter(r => Date.now() - r.at < 5000)
      } else if (death.killer === me) {
        this.recordKill(death.victim, { how: death.cause, ...(death.weapon ? { weapon: death.weapon } : {}) })
      }
      return
    }
    const adv = parseAdvancement(text)
    if (adv) this.journal.record('advancement', { advancement: adv.advancement, player: adv.player, self: adv.player === me }, adv.player === me ? this.pos() : {})
  }

  private recordKill (entity: string, extra: Record<string, unknown> = {}): void {
    const now = Date.now()
    const last = this.recentKills.get(entity)
    if (last && now - last < 3000) return
    this.recentKills.set(entity, now)
    this.journal.record('kill', { entity, ...extra }, this.pos())
  }

  // ---------------------------------------------------------------- session

  /** Wires one session's bot. Returns the cleanup. */
  session (bot: Bot): () => void {
    if (!this.journal.enabled) return () => {}
    this.bot = bot
    const j = this.journal
    j.start()
    const offs: (() => void)[] = []
    const on = (emitter: any, ev: string, fn: (...a: any[]) => void) => { emitter.on(ev, fn); offs.push(() => emitter.off?.(ev, fn) ?? emitter.removeListener?.(ev, fn)) }
    const here = () => ({ pos: posOf(bot), dim: bot.game?.dimension })
    const startedAt = Date.now()

    j.record('connect', { server: `${this.agent.server.host}:${this.agent.server.port}`, gameMode: bot.game?.gameMode }, here())

    // inventory
    const inv = new InventoryTracker()
    inv.reset(inventoryCounts(bot))
    on(bot.inventory, 'updateSlot', () => { if (!dead) inv.change(inventoryCounts(bot), Date.now()) })

    // damage
    const damage = new DamageAggregator()
    let health = bot.health || 20
    let lastHurt: { source: string, at: number } | null = null
    on(bot, 'entityHurt', (e: Entity, source?: Entity) => {
      if (e !== bot.entity) return
      lastHurt = { source: source ? entityName(source) : 'environment', at: Date.now() }
    })
    let dead = false
    let healthBefore = health
    on(bot, 'health', () => {
      const h = bot.health
      if (h < health && h > 0 && !dead) {
        const src = lastHurt && Date.now() - lastHurt.at < 1500 ? lastHurt.source : (bot.food === 0 ? 'starvation' : 'unknown')
        damage.hit(src, Math.round((health - h) * 10) / 10, Math.round(h), Date.now(), posOf(bot))
      }
      if (h > 0) healthBefore = h
      health = h
    })

    // death and respawn
    let deathTimer: NodeJS.Timeout | null = null
    on(bot, 'death', () => {
      if (dead) return
      dead = true
      const ts = Date.now()
      const at = here()
      let carried = inventoryCounts(bot)
      if (!Object.keys(carried).length) carried = inv.baseline
      const action = this.current ?? this.agent.currentAction?.name ?? null
      for (const d of damage.poll(ts, true)) writeDamage(d)
      const write = (info: DeathInfo | null) => {
        if (deathTimer) { clearTimeout(deathTimer); deathTimer = null }
        this.pendingDeath = null
        j.record('death', {
          cause: info?.cause ?? (lastHurt && ts - lastHurt.at < 3000 ? lastHurt.source : 'unknown'),
          ...(info?.killer ? { killer: info.killer } : {}),
          ...(info?.weapon ? { weapon: info.weapon } : {}),
          ...(info?.message ? { message: info.message } : {}),
          healthBefore: Math.round(healthBefore * 10) / 10,
          ...(action ? { action } : {}),
          lost: carried,
          lostCount: Object.values(carried).reduce((a, b) => a + b, 0)
        }, { ...at, ts })
        j.flush()
      }
      const known = this.recentServer.find(r => ts - r.at < 3000)
      this.recentServer = []
      if (known) return write(known.death)
      this.pendingDeath = write
      deathTimer = setTimeout(() => write(null), 3000)
    })
    offs.push(() => { if (deathTimer) { clearTimeout(deathTimer); this.pendingDeath?.(null) } })
    on(bot, 'spawn', () => {
      // 'spawn' fires again after a respawn and after a dimension change.
      const snap = inventoryCounts(bot)
      if (dead) {
        dead = false
        health = bot.health || 20
        j.record('respawn', { keptInventory: Object.keys(snap).length > 0 }, here())
      } else {
        j.record('place_visited', { dimension: bot.game?.dimension, reason: 'dimension change' }, here())
      }
      inv.reset(snap)
    })

    // kills: the last entity we hit dies within 10 s
    let lastAttack: { id: number, name: string, at: number } | null = null
    const origAttack = bot.attack
    bot.attack = function (this: Bot, target: Entity, ...rest: any[]) {
      if (target) lastAttack = { id: target.id, name: entityName(target), at: Date.now() }
      return (origAttack as any).call(this, target, ...rest)
    } as Bot['attack']
    offs.push(() => { bot.attack = origAttack })
    on(bot, 'entityDead', (e: Entity) => {
      if (lastAttack && e.id === lastAttack.id && Date.now() - lastAttack.at < 10_000) {
        this.recordKill(lastAttack.name)
        lastAttack = null
      }
    })

    // blocks
    const blocks = new BlockAggregator()
    // bot.dig is wrapped rather than listening to diggingCompleted: mineflayer removes all
    // diggingCompleted listeners when the bot dies. A dig the server refused leaves the block.
    const origDig = bot.dig
    bot.dig = async function (this: Bot, block: any, ...rest: any[]) {
      const name = block?.name
      const p = block?.position?.clone?.() ?? block?.position
      const result = await (origDig as any).call(this, block, ...rest)
      try {
        if (name && p) {
          setTimeout(() => {
            const now = bot.blockAt(p)
            if (!now || now.name !== name) blocks.add('broken', name, p, bot.game?.dimension, Date.now())
          }, 400).unref()
        }
      } catch {}
      return result
    } as Bot['dig']
    offs.push(() => { bot.dig = origDig })
    const origPlace = bot.placeBlock
    bot.placeBlock = async function (this: Bot, ref: any, face: any, ...rest: any[]) {
      try {
        return await (origPlace as any).call(this, ref, face, ...rest)
      } finally {
        try {
          const p = ref.position.plus(face)
          const b = bot.blockAt(p)
          if (b && b.name !== 'air') blocks.add('placed', b.name, p, bot.game?.dimension, Date.now())
        } catch {}
      }
    } as Bot['placeBlock']
    offs.push(() => { bot.placeBlock = origPlace })

    // players
    const seen = new Map<string, number>()
    on(bot, 'playerJoined', (p: { username: string }) => {
      if (p.username === bot.username || Date.now() - startedAt < 10_000) return // the list is replayed on spawn
      j.record('player_joined', { player: p.username })
    })
    on(bot, 'playerLeft', (p: { username: string }) => {
      if (p.username !== bot.username) j.record('player_left', { player: p.username })
    })
    on(bot, 'entitySpawn', (e: Entity) => {
      if (e.type !== 'player' || !e.username || e.username === bot.username) return
      const last = seen.get(e.username)
      if (last && Date.now() - last < 10 * 60_000) return
      seen.set(e.username, Date.now())
      j.record('player_seen', { player: e.username, distance: bot.entity ? Math.round(e.position.distanceTo(bot.entity.position)) : undefined }, { pos: e.position, dim: bot.game?.dimension })
    })

    on(bot, 'kicked', (r: unknown) => { this.lastKick = `kicked: ${reasonText(r)}` })

    // places: entering a region not visited in the last 30 min, or coming near a named place
    const R = Math.max(16, this.journal.config.placeRegion)
    const regions = new Map<string, number>()
    let lastRegion = ''
    let lastNamed = ''
    const checkPlace = () => {
      const p = posOf(bot)
      if (!p || dead) return
      const dim = bot.game?.dimension
      const named = this.namedPlaceNear(p, dim)
      if (named && named !== lastNamed) {
        lastNamed = named
        j.record('place_visited', { place: named }, here())
      } else if (!named) lastNamed = ''
      const key = `${dim}|${Math.floor(p.x / R)},${Math.floor(p.z / R)}`
      if (key === lastRegion) return
      const first = !lastRegion
      lastRegion = key
      const prev = regions.get(key)
      regions.set(key, Date.now())
      if (first || named || (prev && Date.now() - prev < 30 * 60_000)) return
      j.record('place_visited', { region: key.split('|')[1], ...(prev ? {} : { new: true }) }, here())
    }

    const writeDamage = (d: { source: string, amount: number, hits: number, healthAfter: number, pos?: Pos }) =>
      j.record('damage', { source: d.source, amount: d.amount, hits: d.hits, healthAfter: d.healthAfter }, { pos: d.pos, dim: bot.game?.dimension })
    const flushAggregates = (force: boolean) => {
      const now = Date.now()
      const diff = inv.poll(force ? now + 60_000 : now)
      if (diff) {
        const action = this.current ? { action: this.current } : {}
        if (Object.keys(diff.gained).length) j.record('item_gained', { items: diff.gained, ...action }, here())
        if (Object.keys(diff.lost).length) j.record('item_lost', { items: diff.lost, ...action }, here())
      }
      for (const d of damage.poll(now, force)) writeDamage(d)
      for (const b of blocks.poll(now, force)) {
        j.record(b.kind === 'broken' ? 'block_broken' : 'block_placed', { blocks: b.blocks, count: b.count, area: b.area }, { pos: b.pos, dim: b.dim })
      }
    }
    let ticks = 0
    const timer = setInterval(() => {
      flushAggregates(false)
      if (++ticks % 5 === 0) checkPlace()
    }, 1000)
    timer.unref()
    offs.push(() => clearInterval(timer))
    offs.push(() => flushAggregates(true))

    return () => {
      for (const off of offs.reverse()) { try { off() } catch {} }
      if (this.bot === bot) this.bot = null
      this.current = null
    }
  }

  /** A named place (navigation `places` / `home` in agent storage) within 12 blocks. */
  private namedPlaceNear (p: Pos, dim?: string): string | null {
    const places: Record<string, { x: number, y: number, z: number, dimension?: string }> = { ...this.agent.storage.get<Record<string, any>>('places', {}) }
    const home = this.agent.storage.get<{ x: number, y: number, z: number, dimension?: string }>('home')
    if (home) places.home = home
    for (const [name, q] of Object.entries(places)) {
      if (!q || typeof q.x !== 'number') continue
      if (q.dimension && dim && q.dimension !== dim) continue
      if (Math.hypot(q.x - p.x, q.z - p.z) <= 12 && Math.abs((q.y ?? p.y) - p.y) <= 12) return name
    }
    return null
  }
}
