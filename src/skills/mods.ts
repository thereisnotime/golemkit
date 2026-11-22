// What mods this server runs and what they add, from the NeoForge registry sync and the learned
// channel list, so a bot can teach players with the exact item names on this server. In
// creative mode, creative_get puts any item in the bot's inventory (to hand over with drop).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { defineSkill, defineAction, z, noParams, ok, fail, itemName } from '../core/index.ts'
import type { Agent } from '../core/index.ts'

const require = createRequire(import.meta.url)

interface ModInfo { id: string, version?: string, items: number, blocks: number, entities: number }

function readJson (file: string): any {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

/** Registry name lists per registry (from the cached sync) and versions (from channel versions). */
function serverData (agent: Agent): { registries: Record<string, Record<string, string>>, versions: Record<string, string> } {
  const key = `${agent.server.host}-${agent.server.port}`
  const registries = readJson(join('data', `registries-${key}.json`))?.registries ?? {}
  const channels: Record<string, { version: string }> = readJson(join('data', `channels-${key}.json`))?.channels ?? {}
  // A mod's channels usually all carry the mod version (e.g. create:* -> 6.0.8); take the most common.
  const counts: Record<string, Record<string, number>> = {}
  for (const [id, c] of Object.entries(channels)) {
    const ns = id.split(':')[0]!
    if (!c.version || c.version === '1' || !/\d/.test(c.version)) continue // some mods use their name as the channel version
    counts[ns] ??= {}
    counts[ns]![c.version] = (counts[ns]![c.version] ?? 0) + 1
  }
  const versions = Object.fromEntries(Object.entries(counts).map(([ns, v]) => [ns, Object.entries(v).sort((a, b) => b[1] - a[1])[0]![0]]))
  return { registries, versions }
}

/** Channel ids learned from the NeoForge negotiation and the mod namespaces in the registry sync (for feature detection). */
export function serverSignals (agent: Pick<Agent, 'server'>): { channels: string[], namespaces: string[] } {
  const key = `${agent.server.host}-${agent.server.port}`
  const channels = Object.keys(readJson(join('data', `channels-${key}.json`))?.channels ?? {})
  const registries: Record<string, Record<string, string>> = readJson(join('data', `registries-${key}.json`))?.registries ?? {}
  const namespaces = new Set<string>()
  for (const reg of Object.values(registries)) for (const name of Object.values(reg ?? {})) namespaces.add(String(name).split(':')[0]!)
  return { channels, namespaces: [...namespaces] }
}

export function installedMods (agent: Agent): ModInfo[] {
  const { registries, versions } = serverData(agent)
  const mods = new Map<string, ModInfo>()
  const count = (reg: string, field: 'items' | 'blocks' | 'entities') => {
    for (const name of Object.values(registries[reg] ?? {})) {
      const ns = name.split(':')[0]!
      if (ns === 'minecraft') continue
      const m = mods.get(ns) ?? { id: ns, items: 0, blocks: 0, entities: 0 }
      m[field]++
      mods.set(ns, m)
    }
  }
  count('minecraft:item', 'items')
  count('minecraft:block', 'blocks')
  count('minecraft:entity_type', 'entities')
  for (const m of mods.values()) if (versions[m.id]) m.version = versions[m.id]
  return [...mods.values()].sort((a, b) => b.items - a.items)
}

const mods = defineAction({
  name: 'mods',
  description: 'List the mods this server runs (with versions when known) and how many items/blocks/mobs each adds. ' +
    'Use it before explaining or teaching a mod, so you talk about what is actually installed.',
  params: noParams,
  exclusive: false,
  run ({ agent }) {
    const list = installedMods(agent)
    if (!list.length) return fail('no registry data yet (the server sends it at login; is this a NeoForge server?)')
    return ok(list.map(m => `${m.id}${m.version ? ` ${m.version}` : ''} (${m.items} items, ${m.blocks} blocks${m.entities ? `, ${m.entities} mobs` : ''})`).join('; '), list)
  }
})

const modItems = defineAction({
  name: 'mod_items',
  description: 'Exact item/block/mob names a mod adds on this server, optionally filtered by a search word ' +
    '(e.g. mod=create query=press). Use these names in explanations and with creative_get.',
  params: z.object({
    mod: z.string().describe('mod id, e.g. create, ars_nouveau'),
    query: z.string().optional().describe('substring to filter by, e.g. "gear", "press", "spell"'),
    kind: z.enum(['item', 'block', 'entity']).default('item'),
    limit: z.number().int().min(1).max(100).default(40)
  }),
  exclusive: false,
  run ({ agent }, { mod, query, kind, limit }) {
    const reg = { item: 'minecraft:item', block: 'minecraft:block', entity: 'minecraft:entity_type' }[kind]
    const names = Object.values(serverData(agent).registries[reg] ?? {})
      .filter(n => n.startsWith(`${mod}:`) && (!query || n.includes(query.toLowerCase())))
      .sort()
    if (!names.length) return fail(`no ${kind}s for "${mod}"${query ? ` matching "${query}"` : ''}; check the mod id with mods`)
    return ok(`${names.length} ${kind}s${names.length > limit ? ` (first ${limit})` : ''}: ${names.slice(0, limit).join(', ')}`, names)
  }
})

export const creativeGet = defineAction({
  name: 'creative_get',
  capabilities: ['mods', 'creative'],
  description: 'Creative mode only: put any item (vanilla or modded, exact name) into your inventory, e.g. to show or hand ' +
    'it to a player with drop, or to build without gathering.',
  params: z.object({
    item: z.string().describe('item name, e.g. oak_planks or create:mechanical_press'),
    count: z.number().int().min(1).max(64).default(1)
  }),
  async run ({ bot }, { item, count }) {
    if (bot.game.gameMode !== 'creative') return fail(`only works in creative mode (I'm in ${bot.game.gameMode})`)
    const name = item.startsWith('minecraft:') ? item.slice(10) : item
    const def = (bot.registry as any).itemsByName[name]
    if (!def) return fail(`unknown item ${item} (use mod_items to find the exact name)`)
    const Item = require('prismarine-item')(bot.registry)
    // First empty slot in the main inventory (36-44 hotbar first, then 9-35).
    const slots = [...Array.from({ length: 9 }, (_, i) => 36 + i), ...Array.from({ length: 27 }, (_, i) => 9 + i)]
    const slot = slots.find(s => !bot.inventory.slots[s])
    if (slot === undefined) return fail('inventory is full')
    await bot.creative.setInventorySlot(slot, new Item(def.id, Math.min(count, def.stackSize ?? 64)))
    const got = bot.inventory.slots[slot]
    return got ? ok(`got ${got.count}x ${itemName(got)}`) : fail(`the server didn't give me ${item}`)
  }
})

export const modsSkill = () => defineSkill({
  name: 'mods',
  capabilities: ['mods'],
  description: 'Installed mods, their items, and creative-mode item access.',
  actions: [mods, modItems, creativeGet],
  observe: (agent) => {
    const list = installedMods(agent)
    return list.length ? { mods: list.map(m => m.id + (m.version ? ` ${m.version}` : '')).join(', ') } : {}
  }
})

/** Modded block, item and entity names (namespace:name) from the cached registry sync, for target resolution. */
export function moddedNames (agent: Agent): { blocks: string[], items: string[], entities: string[] } {
  const { registries } = serverData(agent)
  const pick = (reg: string) => Object.values(registries[reg] ?? {}).map(String).filter(n => !n.startsWith('minecraft:'))
  return { blocks: pick('minecraft:block'), items: pick('minecraft:item'), entities: pick('minecraft:entity_type') }
}
