// NeoForge sends its "frozen" registries (blocks, items, entity types, ...) during login so
// clients agree on numeric ids. We parse them to give modded items and entities real names
// ("create:andesite_alloy") instead of "unknown".
//
// Wire format (neoforged/NeoForge@1.21.1):
//   FrozenRegistryPayload = ResourceLocation registryName, RegistrySnapshot
//   RegistrySnapshot      = Map<VarInt id, ResourceLocation name>, Map<ResourceLocation alias, ResourceLocation target>
//
// Blocks are a different story: chunks use block *state* ids, and how many states a modded
// block has lives in mod code, not in the snapshot. Modded blocks therefore stay the solid
// "modded_block" stand-in (modded.ts); the block id->name map is cached for reference only.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { Reader } from './codec.ts'

export interface RegistrySnapshot {
  name: string
  ids: Record<number, string>
  aliases: Record<string, string>
}

export function decodeFrozenRegistry (buf: Buffer): RegistrySnapshot {
  const r = new Reader(buf)
  const name = r.string()
  const ids: Record<number, string> = {}
  const n = r.varint()
  for (let i = 0; i < n; i++) {
    const id = r.varint()
    ids[id] = r.string()
  }
  const aliases: Record<string, string> = {}
  const m = r.done ? 0 : r.varint()
  for (let i = 0; i < m; i++) aliases[r.string()] = r.string()
  return { name, ids, aliases }
}

/** Registries worth keeping (item and entity names are applied; blocks are kept for reference). */
const KEEP = new Set(['minecraft:item', 'minecraft:entity_type', 'minecraft:block'])

/** Caches the server's registries per host:port so names are known even before the next sync. */
export class RegistryCache {
  readonly file: string
  registries: Record<string, Record<number, string>> = {}

  constructor (file: string) {
    this.file = file
    try { this.registries = JSON.parse(readFileSync(file, 'utf8')).registries ?? {} } catch {}
  }

  add (snap: RegistrySnapshot): void {
    if (KEEP.has(snap.name)) this.registries[snap.name] = snap.ids
  }

  save (): void {
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify({ updated: new Date().toISOString(), registries: this.registries }) + '\n')
  }

  get (name: string): Record<number, string> | undefined {
    return this.registries[name]
  }
}

export interface ApplyResult {
  items: number
  entities: number
  /** Vanilla ids whose name on the server differs from minecraft-data (should be 0). */
  mismatches: string[]
}

/** Modded hostile mobs we know about; extend per bot (settings.moddedHostile) or MC_MODDED_HOSTILE. */
export const DEFAULT_MODDED_HOSTILE = ['ars_nouveau:wilden_*']

/** Entity names that are clearly not creatures (projectiles, contraptions, effects). */
const OBJECT_LIKE = /(proj|projectile|contraption|arrow|bolt|_block|module|camera|ritual|wall|orbit|linger|spike|shard|hook|bubble|lightning|glue|seat|flying_item|fangs|blueprint|cube|carriage|drone)/

const strip = (n: string) => n.startsWith('minecraft:') ? n.slice('minecraft:'.length) : n
const titleize = (n: string) => n.split(':').pop()!.split('_').map(w => w ? w[0]!.toUpperCase() + w.slice(1) : w).join(' ')

/** Glob match for hostile patterns like "ars_nouveau:wilden_*". */
function globMatch (pattern: string, name: string): boolean {
  const re = new RegExp('^' + pattern.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$')
  return re.test(name)
}

/**
 * Adds modded items and entity types to a bot's mineflayer registry. minecraft-data maps are
 * shared between all bots in the process, so the bot gets its own copies; nothing is mutated
 * in place. Modded entities count as 'mob', or 'hostile' when they match `hostile` patterns.
 */
export function applyModdedRegistries (registry: any, cache: RegistryCache, opts: { hostile?: string[] } = {}): ApplyResult {
  const result: ApplyResult = { items: 0, entities: 0, mismatches: [] }
  const hostile = [...DEFAULT_MODDED_HOSTILE, ...(opts.hostile ?? [])]

  const items = cache.get('minecraft:item')
  if (items) {
    const byId = { ...registry.items }
    const byName = { ...registry.itemsByName }
    const arr = [...registry.itemsArray]
    for (const [idStr, full] of Object.entries(items)) {
      const id = Number(idStr)
      const name = strip(full)
      const known = byId[id]
      if (known) {
        if (known.name !== name) result.mismatches.push(`item ${id}: ${known.name} != ${name}`)
        continue
      }
      const item = { id, name, displayName: titleize(name), stackSize: 64, modded: true }
      byId[id] = item
      byName[name] = item
      arr.push(item)
      result.items++
    }
    registry.items = byId
    registry.itemsByName = byName
    registry.itemsArray = arr
  }

  const entities = cache.get('minecraft:entity_type')
  if (entities) {
    const byId = { ...registry.entities }
    const byName = { ...registry.entitiesByName }
    const arr = [...registry.entitiesArray]
    for (const [idStr, full] of Object.entries(entities)) {
      const id = Number(idStr)
      const name = strip(full)
      const known = byId[id]
      if (known) {
        if (known.name !== name) result.mismatches.push(`entity ${id}: ${known.name} != ${name}`)
        continue
      }
      const isHostile = hostile.some(p => globMatch(p, name))
      const type = isHostile ? 'hostile' : OBJECT_LIKE.test(name) ? 'object' : 'mob'
      const entity = {
        id, internalId: id, name, displayName: titleize(name),
        width: 0.6, height: 1.8, type,
        category: isHostile ? 'Hostile mobs' : 'Modded', metadataKeys: [], modded: true
      }
      byId[id] = entity
      byName[name] = entity
      arr.push(entity)
      result.entities++
    }
    registry.entities = byId
    registry.entitiesByName = byName
    registry.entitiesArray = arr
  }
  return result
}
