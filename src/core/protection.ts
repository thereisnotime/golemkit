// Learns where the server refuses block breaking (spawn protection, claims) and keeps the
// pathfinder from planning digs there.
//
// A refused break looks like this: we finish digging, mineflayer marks the block as air,
// then the server sends a block update restoring the old block. Without help the
// pathfinder re-plans through the same block forever ("can't break dirt").
//
// Zones are kept per server in data/protected-<host>-<port>.json.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Bot } from 'mineflayer'

export interface Zone { x: number, y: number, z: number, at: string }

const ZONE_RADIUS = 20
const REFUSAL_WINDOW_MS = 800

export class ProtectedAreas {
  readonly file: string
  zones: Zone[] = []

  constructor (file: string) {
    this.file = file
    try { this.zones = JSON.parse(readFileSync(file, 'utf8')).zones ?? [] } catch {}
  }

  isProtected (p: { x: number, y: number, z: number }, radius = ZONE_RADIUS): boolean {
    return this.zones.some(z => Math.abs(z.x - p.x) <= radius && Math.abs(z.z - p.z) <= radius && Math.abs(z.y - p.y) <= radius * 2)
  }

  /** Records a refused break. Returns true if this created a new zone. */
  add (p: { x: number, y: number, z: number }): boolean {
    if (this.isProtected(p, ZONE_RADIUS / 2)) return false
    this.zones.push({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), at: new Date().toISOString() })
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify({ zones: this.zones }, null, 2) + '\n')
    } catch {}
    return true
  }

  clear (): void {
    this.zones = []
    try { writeFileSync(this.file, JSON.stringify({ zones: [] }) + '\n') } catch {}
  }

  /** Pathfinder exclusion: digging inside a zone costs Infinity (never planned). */
  breakCost = (block: { position: { x: number, y: number, z: number } }): number =>
    this.isProtected(block.position) ? Infinity : 0
}

/**
 * Watches this session's digs for refusals. `onRefused` gets the block position; the agent
 * records the zone and re-plans.
 */
export function watchRefusedDigs (bot: Bot, onRefused: (pos: { x: number, y: number, z: number }) => void): () => void {
  const recent = new Map<string, number>()
  const key = (p: { x: number, y: number, z: number }) => `${p.x},${p.y},${p.z}`
  const onDug = (block: { position: { x: number, y: number, z: number } }) => {
    recent.set(key(block.position), Date.now())
  }
  const onChange = (packet: any) => {
    const l = packet?.location
    if (!l) return
    const t = recent.get(key(l))
    if (!t) return
    recent.delete(key(l))
    const name = bot.registry.blocksByStateId[packet.type]?.name
    if (Date.now() - t < REFUSAL_WINDOW_MS && packet.type !== 0 && name !== 'air' && name !== 'cave_air') onRefused(l)
  }
  bot.on('diggingCompleted', onDug)
  bot._client.on('block_change', onChange)
  const prune = setInterval(() => { const now = Date.now(); for (const [k, t] of recent) if (now - t > 5000) recent.delete(k) }, 5000)
  return () => {
    bot.off('diggingCompleted', onDug)
    bot._client.removeListener('block_change', onChange)
    clearInterval(prune)
  }
}
