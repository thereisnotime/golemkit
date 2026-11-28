// Drops it can't get to without drowning (pure, unit tested in test/pickup-plan.test.ts).
// Pax kept walking into a lake for items lying on the bottom: the air reflex stopped
// pickup_items ("out of air ... swam up"), collect_drops picked the same drops again a few
// seconds later, ten times in two minutes. Every time a pickup is cut short by running out of air
// the drop it was going for gets an air break; after `maxAirBreaks` of them the drop (by entity
// id, or anything lying within `matchRadius` of where it lay, since drops sink and drift and
// several lie together) counts as unreachable for `unreachableMinutes`. pickup_items and the
// behaviours' "anything to collect" checks leave it out. The Mineflayer glue is in pickup.ts.
import { z } from 'zod'

/** settings.pickup (profile `settings: pickup:`, live with config_set pickup.*). */
export const PickupSchema = z.object({
  maxAirBreaks: z.number().int().min(0).max(20).default(2).describe('air breaks (out of air while going for a drop) before that drop counts as unreachable; 0 = never give up'),
  unreachableMinutes: z.number().min(0.5).max(240).default(10).describe('how long a drop it gave up on stays skipped, and how long an air break is remembered, in minutes'),
  matchRadius: z.number().min(0).max(8).default(2).describe('other drops within this many blocks of a given-up drop count as the same spot')
})
export type PickupSettings = z.infer<typeof PickupSchema>
export const PICKUP_DEFAULTS: PickupSettings = PickupSchema.parse({})

/** settings.pickup merged over the defaults; a value that doesn't fit its schema keeps the default. */
export function pickupSettings (raw: unknown): PickupSettings {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  const out: Record<string, unknown> = { ...PICKUP_DEFAULTS }
  for (const [k, schema] of Object.entries(PickupSchema.shape)) {
    if (o[k] === undefined) continue
    const r = (schema as z.ZodType).safeParse(o[k])
    if (r.success) out[k] = r.data
  }
  return out as PickupSettings
}

export interface V { x: number, y: number, z: number }
export interface DropRef { id: number, pos: V }

export interface AirBreakRecord {
  /** Entity ids seen at this spot. */
  ids: number[]
  /** Where the drop lay at the last air break. */
  pos: V
  breaks: number
  lastAt: number
  /** Set when breaks reached the limit: skipped until lastAt + unreachableMinutes. */
  gaveUp: boolean
}

export interface PickupMemory { records: AirBreakRecord[] }

export const newPickupMemory = (): PickupMemory => ({ records: [] })

const dist = (a: V, b: V) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const ttl = (s: PickupSettings) => s.unreachableMinutes * 60_000

/** Forgets records older than unreachableMinutes. */
export function prunePickupMemory (mem: PickupMemory, now: number, s: PickupSettings): void {
  mem.records = mem.records.filter(r => now - r.lastAt < ttl(s))
}

function find (mem: PickupMemory, d: DropRef, s: PickupSettings): AirBreakRecord | undefined {
  return mem.records.find(r => r.ids.includes(d.id)) ?? mem.records.find(r => dist(r.pos, d.pos) <= s.matchRadius)
}

export interface AirBreakResult {
  breaks: number
  /** This break reached the limit: give up on the drop now (log it once). */
  gaveUp: boolean
}

/** One pickup cut short by running out of air while going for `d`. */
export function recordAirBreak (mem: PickupMemory, d: DropRef, now: number, s: PickupSettings): AirBreakResult {
  prunePickupMemory(mem, now, s)
  let r = find(mem, d, s)
  if (!r) { r = { ids: [], pos: { ...d.pos }, breaks: 0, lastAt: now, gaveUp: false }; mem.records.push(r) }
  if (!r.ids.includes(d.id)) r.ids.push(d.id)
  r.pos = { ...d.pos }
  r.breaks++
  r.lastAt = now
  const was = r.gaveUp
  if (s.maxAirBreaks > 0 && r.breaks >= s.maxAirBreaks) r.gaveUp = true
  return { breaks: r.breaks, gaveUp: r.gaveUp && !was }
}

/** Given up on (too many air breaks, not yet forgotten)? */
export function dropUnreachable (mem: PickupMemory, d: DropRef, now: number, s: PickupSettings): boolean {
  if (s.maxAirBreaks <= 0) return false
  const r = find(mem, d, s)
  return !!r && r.gaveUp && now - r.lastAt < ttl(s)
}

/** The drops still worth going for. */
export function reachableDrops<T extends DropRef> (drops: T[], mem: PickupMemory, now: number, s: PickupSettings): T[] {
  return drops.filter(d => !dropUnreachable(mem, d, now, s))
}

/** Was the pickup cut short by air: travel gave up under water, or it was stopped with the head under water and short of air. */
export function isAirBreak (i: { underwaterError: boolean, aborted: boolean, headInWater: boolean, oxygen: number }): boolean {
  return i.underwaterError || (i.aborted && i.headInWater && i.oxygen < 20)
}
