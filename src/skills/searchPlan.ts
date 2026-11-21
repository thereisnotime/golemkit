// Pure decisions for finding and fetching things: what a player's word means (target
// resolution), which search phases to run, whether a cluster of blocks is a village or a
// nether portal, where bring_item gets an item from, how many items a toss really handed over,
// whether owner drops can still be reached, and when to say how it is going. No mineflayer
// here, so all of it is unit-tested; the actions live in search.ts.
import { compass, scoutStopReason, DEFAULT_SCOUT_LIMITS, type Pos, type XZ, type ScoutProgress, type ScoutLimits } from './foodPlan.ts'

// ------------------------------------------------------------------ names

/** Names known on this server, by registry (vanilla from minecraft-data plus modded from the sync). */
export interface RegistryNames {
  blocks: readonly string[]
  items: readonly string[]
  entities: readonly string[]
  biomes?: readonly string[]
}

export type TargetKind = 'block' | 'mob' | 'structure' | 'biome' | 'item'
export type FetchHow = 'collect' | 'chop' | 'harvest' | 'bucket'

export interface ResolvedTarget {
  kind: TargetKind
  /** Short key for places (`found:<key>`) and messages. */
  key: string
  /** What to call it in chat. */
  label: string
  /** Blocks that count as the target. */
  blocks?: string[]
  /** Entities that count as the target. */
  mobs?: string[]
  structure?: 'village' | 'nether_portal'
  /** Biome names that count (exact names from the registry, or matched by pattern). */
  biomes?: string[]
  biomePattern?: string
  /** How to fetch some of it, when it can be fetched at all. */
  fetch?: FetchHow
  /** The item fetching it gives (raw_iron for iron ore, wheat for wheat crops). */
  item?: string
  /** Ore family (iron, coal, diamond...), for prospecting. */
  ore?: string
  /** Only fully grown crops count. */
  ripe?: boolean
  /** Water or lava: only source blocks with open air above count. */
  liquid?: boolean
  modded?: boolean
  /** Anything worth telling the player about what it can and can't do with this target. */
  note?: string
}

export interface ResolveError { error: string, suggestions: string[] }

const STOP_WORDS = /^(a|an|the|some|any|me|my|nearest|closest|nearby|of|for|to)$/

/** Lower case, no namespace for vanilla, no articles, spaces to underscores. */
export function normalizeTarget (text: string): string {
  const words = text.toLowerCase().replace(/minecraft:/g, '').replace(/[^a-z0-9_:\s-]/g, ' ').split(/[\s-]+/).filter(w => w && !STOP_WORDS.test(w))
  return words.join('_')
}

/** Singular candidates for a word, most likely first: cows -> cow, wolves -> wolf, endermen -> enderman. */
export function singulars (word: string): string[] {
  const out = [word]
  if (word.endsWith('men')) out.push(word.slice(0, -3) + 'man')
  if (word.endsWith('ies')) out.push(word.slice(0, -3) + 'y')
  if (word.endsWith('ves')) out.push(word.slice(0, -3) + 'f', word.slice(0, -3) + 'fe')
  if (/(x|s|ch|sh|z)es$/.test(word)) out.push(word.slice(0, -2))
  if (word.endsWith('es')) out.push(word.slice(0, -1))
  if (word.endsWith('s') && !word.endsWith('ss')) out.push(word.slice(0, -1))
  return [...new Set(out)]
}

// ------------------------------------------------------------------ families

/** Ore families: block names, the item they drop, and the height band they occur in (overworld). */
export const ORES: Record<string, { blocks: string[], drop: string, minY: number, maxY: number }> = {
  coal: { blocks: ['coal_ore', 'deepslate_coal_ore'], drop: 'coal', minY: 0, maxY: 256 },
  iron: { blocks: ['iron_ore', 'deepslate_iron_ore'], drop: 'raw_iron', minY: -64, maxY: 320 },
  copper: { blocks: ['copper_ore', 'deepslate_copper_ore'], drop: 'raw_copper', minY: -16, maxY: 112 },
  gold: { blocks: ['gold_ore', 'deepslate_gold_ore'], drop: 'raw_gold', minY: -64, maxY: 32 },
  redstone: { blocks: ['redstone_ore', 'deepslate_redstone_ore'], drop: 'redstone', minY: -64, maxY: 15 },
  lapis: { blocks: ['lapis_ore', 'deepslate_lapis_ore'], drop: 'lapis_lazuli', minY: -64, maxY: 64 },
  diamond: { blocks: ['diamond_ore', 'deepslate_diamond_ore'], drop: 'diamond', minY: -64, maxY: 16 },
  emerald: { blocks: ['emerald_ore', 'deepslate_emerald_ore'], drop: 'emerald', minY: -16, maxY: 320 },
  quartz: { blocks: ['nether_quartz_ore'], drop: 'quartz', minY: 10, maxY: 117 },
  ancient_debris: { blocks: ['ancient_debris'], drop: 'ancient_debris', minY: 8, maxY: 119 }
}

const ORE_ALIASES: Record<string, string> = {
  coal: 'coal', coal_ore: 'coal', iron: 'iron', iron_ore: 'iron', raw_iron: 'iron', copper: 'copper', copper_ore: 'copper', raw_copper: 'copper',
  gold: 'gold', gold_ore: 'gold', raw_gold: 'gold', redstone: 'redstone', redstone_ore: 'redstone', lapis: 'lapis', lapis_lazuli: 'lapis', lapis_ore: 'lapis',
  diamond: 'diamond', diamond_ore: 'diamond', emerald: 'emerald', emerald_ore: 'emerald', quartz: 'quartz', nether_quartz: 'quartz', nether_quartz_ore: 'quartz',
  ancient_debris: 'ancient_debris', netherite: 'ancient_debris'
}

export const WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry'] as const
export const LOGS = WOODS.map(w => `${w}_log`)

export const CROP_BLOCKS: Record<string, { block: string, item: string }> = {
  wheat: { block: 'wheat', item: 'wheat' },
  carrot: { block: 'carrots', item: 'carrot' },
  carrots: { block: 'carrots', item: 'carrot' },
  potato: { block: 'potatoes', item: 'potato' },
  potatoes: { block: 'potatoes', item: 'potato' },
  beetroot: { block: 'beetroots', item: 'beetroot' },
  beetroots: { block: 'beetroots', item: 'beetroot' }
}

/** Food animals (the hunt list), for "animals". */
export const ANIMALS = ['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom']

/** Biome words: a pattern over the registry's biome names. */
export const BIOME_WORDS: Record<string, { label: string, pattern: string }> = {
  desert: { label: 'desert', pattern: '^desert$' },
  snow: { label: 'snowy biome', pattern: '^(snowy_|frozen_|ice_spikes$|grove$|jagged_peaks$)' },
  snowy: { label: 'snowy biome', pattern: '^(snowy_|frozen_|ice_spikes$|grove$|jagged_peaks$)' },
  tundra: { label: 'snowy biome', pattern: '^(snowy_|frozen_|ice_spikes$)' },
  ice: { label: 'icy biome', pattern: '^(frozen_|ice_spikes$|snowy_)' },
  ocean: { label: 'ocean', pattern: 'ocean$' },
  sea: { label: 'ocean', pattern: 'ocean$' },
  jungle: { label: 'jungle', pattern: 'jungle$' },
  forest: { label: 'forest', pattern: 'forest$' },
  plains: { label: 'plains', pattern: 'plains$' },
  swamp: { label: 'swamp', pattern: 'swamp$' },
  taiga: { label: 'taiga', pattern: 'taiga$' },
  savanna: { label: 'savanna', pattern: '^savanna' },
  badlands: { label: 'badlands', pattern: 'badlands$' },
  mesa: { label: 'badlands', pattern: 'badlands$' },
  mushroom: { label: 'mushroom fields', pattern: '^mushroom_fields$' },
  beach: { label: 'beach', pattern: 'beach$' },
  river: { label: 'river', pattern: 'river$' },
  mountain: { label: 'mountains', pattern: '(_peaks$|^stony_peaks$|^windswept_|^meadow$)' },
  mountains: { label: 'mountains', pattern: '(_peaks$|^stony_peaks$|^windswept_|^meadow$)' },
  cherry: { label: 'cherry grove', pattern: '^cherry_grove$' },
  cherry_grove: { label: 'cherry grove', pattern: '^cherry_grove$' }
}

/** Blocks that are somebody's things: findable, never fetched by digging. */
const NEVER_DIG = /(chest|barrel|shulker_box|_bed$|bell$|furnace|crafting_table|lectern|anvil|enchanting_table|beacon|spawner|door|sign|banner|portal)/

/** Natural blocks worth fetching with collect (digging them gives the block or its drop). */
const FETCHABLE_BLOCK = /(_ore$|^ancient_debris$|_log$|_stem$|^(sand|red_sand|gravel|clay|dirt|grass_block|stone|deepslate|andesite|diorite|granite|tuff|calcite|cobblestone|netherrack|soul_sand|obsidian|ice|packed_ice|snow_block|pumpkin|melon|sugar_cane|cactus|bamboo|kelp|moss_block|mud|terracotta|sandstone|basalt|blackstone|glowstone|amethyst_cluster|mushroom_stem|red_mushroom|brown_mushroom|dandelion|poppy|cornflower|azure_bluet|oxeye_daisy|allium|blue_orchid|lily_of_the_valley|.*_tulip|sunflower|lilac|rose_bush|peony|sweet_berry_bush|vine|lily_pad)$)/

const ITEM_OF_BLOCK: Record<string, string> = {
  stone: 'cobblestone', deepslate: 'cobbled_deepslate', grass_block: 'dirt', clay: 'clay_ball', gravel: 'gravel', glowstone: 'glowstone_dust',
  melon: 'melon_slice', sweet_berry_bush: 'sweet_berries', ice: 'ice', amethyst_cluster: 'amethyst_shard'
}

/** The item digging a block gives (ores give their drop). */
export function itemOfBlock (block: string): string {
  for (const o of Object.values(ORES)) if (o.blocks.includes(block)) return o.drop
  return ITEM_OF_BLOCK[block] ?? block
}

const has = (list: readonly string[], n: string) => list.includes(n)

/**
 * What a player's word means: an ore family, logs, a crop, a liquid, a mob, a structure, a
 * biome, a plain block or item, or a modded name from the registry sync. Plurals and articles
 * are fine ("the diamonds", "cows", "a village").
 */
export function resolveTarget (text: string, names: RegistryNames): ResolvedTarget | ResolveError {
  const raw = normalizeTarget(text)
  if (!raw) return { error: 'what should I look for?', suggestions: [] }
  const cands = raw.includes(':') ? [raw] : singulars(raw)
  for (const w of [raw, ...cands]) {
    // structures
    if (/^(village|town|villager_village)$/.test(w)) {
      return { kind: 'structure', key: 'village', label: 'a village', structure: 'village', note: 'beds, a bell and villagers close together' }
    }
    if (/^(nether_portal|portal|obsidian_portal)$/.test(w)) {
      return { kind: 'structure', key: 'nether_portal', label: 'a nether portal', structure: 'nether_portal', blocks: ['nether_portal', 'obsidian'] }
    }
    // ores ("diamonds", "iron", "coal ore")
    const ore = ORE_ALIASES[w]
    if (ore && !(w === 'diamond' && raw === 'diamond_block')) {
      const o = ORES[ore]!
      return { kind: 'block', key: ore, label: `${ore.replace('_', ' ')} ore`, blocks: o.blocks.filter(b => !names.blocks.length || has(names.blocks, b)), fetch: 'collect', item: o.drop, ore }
    }
    // wood
    if (/^(log|logs|wood|tree|trees|timber)$/.test(w)) {
      return { kind: 'block', key: 'logs', label: 'trees', blocks: [...LOGS], fetch: 'chop', item: 'log' }
    }
    // crops (ripe only, village or own farms)
    const crop = CROP_BLOCKS[w]
    if (crop) {
      return { kind: 'block', key: crop.item, label: `ripe ${crop.block}`, blocks: [crop.block], fetch: 'harvest', item: crop.item, ripe: true }
    }
    // liquids
    if (w === 'water' || w === 'lava') {
      return { kind: 'block', key: w, label: w, blocks: [w], liquid: true, fetch: 'bucket', item: `${w}_bucket` }
    }
    if (/^(chest|chests|storage)$/.test(w)) {
      return { kind: 'block', key: 'chest', label: 'a chest', blocks: ['chest', 'trapped_chest', 'barrel'], note: 'found chests are reported, never broken or emptied' }
    }
    if (/^(bed|beds)$/.test(w)) {
      return { kind: 'block', key: 'bed', label: 'a bed', blocks: names.blocks.filter(b => b.endsWith('_bed')) }
    }
    if (/^(animal|animals|food_animals|livestock)$/.test(w)) {
      return { kind: 'mob', key: 'animals', label: 'animals', mobs: [...ANIMALS] }
    }
    // biomes
    const biome = BIOME_WORDS[w]
    if (biome) {
      const re = new RegExp(biome.pattern)
      return { kind: 'biome', key: w, label: biome.label, biomePattern: biome.pattern, biomes: (names.biomes ?? []).filter(b => re.test(b)) }
    }
  }
  // exact registry names (vanilla first, then modded)
  for (const w of cands) {
    if (names.biomes && has(names.biomes, w) && !has(names.blocks, w)) {
      return { kind: 'biome', key: w, label: w.replace(/_/g, ' '), biomes: [w], biomePattern: `^${w}$` }
    }
    if (has(names.entities, w) && !has(names.items, w)) {
      return { kind: 'mob', key: w, label: w.replace(/_/g, ' '), mobs: [w], ...(w.includes(':') ? { modded: true } : {}) }
    }
    if (has(names.blocks, w)) {
      const modded = w.includes(':')
      if (modded) {
        return { kind: 'item', key: w, label: w, item: has(names.items, w) ? w : undefined, modded: true, note: 'modded blocks all look the same to me in the world; I can only bring it from my inventory, my chests or by crafting' }
      }
      const fetch: FetchHow | undefined = NEVER_DIG.test(w) ? undefined : /_log$|_stem$/.test(w) ? 'chop' : FETCHABLE_BLOCK.test(w) ? 'collect' : undefined
      return { kind: 'block', key: w, label: w.replace(/_/g, ' '), blocks: [w], ...(fetch ? { fetch, item: itemOfBlock(w) } : {}) }
    }
    if (has(names.entities, w)) {
      return { kind: 'mob', key: w, label: w.replace(/_/g, ' '), mobs: [w], ...(w.includes(':') ? { modded: true } : {}) }
    }
    if (has(names.items, w)) {
      return { kind: 'item', key: w, label: w.replace(/_/g, ' '), item: w, ...(w.includes(':') ? { modded: true } : {}), note: 'an item, not something lying in the world: bring_item gets it from my inventory, my chests, crafting or its source' }
    }
  }
  // modded by bare name: create:andesite_alloy from "andesite alloy", when only one mod has it
  for (const w of cands) {
    const hit = (list: readonly string[]) => list.filter(n => n.includes(':') && n.split(':')[1] === w)
    const ents = hit(names.entities)
    if (ents.length === 1) return { kind: 'mob', key: ents[0]!, label: ents[0]!, mobs: ents, modded: true }
    const items = [...new Set([...hit(names.items), ...hit(names.blocks)])]
    if (items.length === 1) {
      return { kind: 'item', key: items[0]!, label: items[0]!, item: has(names.items, items[0]!) ? items[0] : undefined, modded: true, note: 'a modded name: I can bring it from my inventory, my chests or by crafting, not find it lying around' }
    }
  }
  const word = raw.split('_')[0]!
  const suggestions = [...new Set([...names.blocks, ...names.entities, ...names.items].filter(n => n.includes(word)))].slice(0, 6)
  return { error: `I don't know what "${text}" is`, suggestions }
}

export function isResolveError (r: ResolvedTarget | ResolveError): r is ResolveError {
  return 'error' in r
}

// ------------------------------------------------------------------ search phases

export type SearchPhase = 'view' | 'memory' | 'scout' | 'prospect'

export interface PhaseOptions {
  /** Prospect for ores with the strip mine when nothing is in view. */
  prospect: boolean
  canDig: boolean
  /** Feet height, for ore height bands. */
  feetY: number
}

/** The pickaxe an ore family needs: tier rank (1 wooden, 2 stone, 3 iron) and the upgrade target that gets it. */
export function pickaxeFor (ore: string): { rank: number, upTo: 'stone' | 'iron' } {
  if (ore === 'coal' || ore === 'quartz') return { rank: 1, upTo: 'stone' }
  if (ore === 'iron' || ore === 'copper' || ore === 'lapis') return { rank: 2, upTo: 'stone' }
  return { rank: 3, upTo: 'iron' }
}

/** Whether the strip mine (a staircase at most 20 blocks down) can reach this ore's height band. */
export function prospectable (ore: string, feetY: number): boolean {
  const o = ORES[ore]
  if (!o || ore === 'quartz' || ore === 'ancient_debris' || ore === 'emerald') return false
  return o.maxY >= feetY - 20 && o.minY <= feetY
}

/**
 * The phases to run, in order: what is loaded around the bot, remembered spots, a surface
 * scout, and (ores only, when asked and the strip mine can reach their height) prospecting.
 * Biomes and mobs have nothing to remember for long, so only mobs check memory.
 */
export function searchPhases (t: ResolvedTarget, o: PhaseOptions): SearchPhase[] {
  if (t.kind === 'item') return []
  const out: SearchPhase[] = ['view']
  if (t.kind !== 'biome') out.push('memory')
  out.push('scout')
  if (t.ore && o.prospect && o.canDig && prospectable(t.ore, o.feetY)) out.push('prospect')
  return out
}

/**
 * find_food's stop rules plus one: a search is never worth dying for, so health at 4 or below
 * ends it even with nothing around (find_food keeps going then, since it is looking for food;
 * a starving bot froze to death in powder snow on a search).
 */
export function searchStopReason (p: ScoutProgress, l: ScoutLimits = DEFAULT_SCOUT_LIMITS): string | null {
  if (p.health <= 4) return `health is critical (${Math.round(p.health)}/20)`
  return scoutStopReason(p, l)
}

// ------------------------------------------------------------------ structures

export interface VillageSigns {
  beds: number
  bells: number
  villagers: number
  /** Job site blocks: composter, lectern, smithing table, barrel... */
  workstations: number
  /** dirt_path blocks. */
  paths: number
  /** iron golems. */
  golems?: number
}

/**
 * Is this a village? A bell with beds or villagers is; so are several villagers with beds;
 * an abandoned one (no villagers) needs beds, job sites and paths together. A couple of
 * villagers alone (a trader, a player's breeder) is not.
 */
export function villageVerdict (s: VillageSigns): { village: boolean, score: number, why: string } {
  const score = s.bells * 4 + Math.min(s.beds, 8) + Math.min(s.villagers, 8) * 1.5 + Math.min(s.workstations, 6) + Math.min(s.paths, 20) / 5 + (s.golems ?? 0) * 2
  const parts = [`${s.beds} beds`, `${s.bells} bell${s.bells === 1 ? '' : 's'}`, `${s.villagers} villagers`, ...(s.workstations ? [`${s.workstations} job sites`] : []), ...(s.paths ? [`${s.paths} path blocks`] : [])]
  const why = parts.join(', ')
  if (s.bells > 0 && (s.beds >= 1 || s.villagers >= 1)) return { village: true, score, why }
  if (s.villagers >= 3 && s.beds >= 2) return { village: true, score, why }
  if (s.villagers >= 2 && s.beds >= 2 && s.workstations >= 1) return { village: true, score, why }
  if (s.beds >= 3 && s.workstations >= 2 && s.paths >= 8) return { village: true, score, why: `${why} (nobody home)` }
  return { village: false, score, why }
}

/**
 * Is there a nether portal frame in these obsidian blocks? A lit portal block always counts.
 * Otherwise the obsidian must outline a vertical rectangle (4 to 23 wide, 5 to 23 tall, outer
 * size) in one x or z plane, with at most the corners missing.
 */
export function portalVerdict (obsidian: readonly Pos[], portalBlocks = 0): { portal: boolean, at?: Pos, why: string } {
  if (portalBlocks > 0) return { portal: true, why: 'a lit portal' }
  const key = (p: Pos) => `${p.x},${p.y},${p.z}`
  const set = new Set(obsidian.map(key))
  for (const axis of ['x', 'z'] as const) {
    const planes = new Map<number, Pos[]>()
    for (const p of obsidian) { const k = p[axis]; planes.set(k, [...(planes.get(k) ?? []), p]) }
    for (const [plane, blocks] of planes) {
      if (blocks.length < 10) continue
      const other = axis === 'x' ? 'z' : 'x'
      // try every bottom-left corner candidate: the lowest block's row
      const ys = blocks.map(b => b.y)
      const minY = Math.min(...ys)
      const bottoms = blocks.filter(b => b.y === minY || b.y === minY + 1)
      for (const b of bottoms) {
        for (let w = 4; w <= 23; w++) {
          for (let h = 5; h <= 23; h++) {
            let need = 0
            let got = 0
            for (let i = 0; i < w; i++) {
              for (let j = 0; j < h; j++) {
                const edge = i === 0 || i === w - 1 || j === 0 || j === h - 1
                if (!edge) continue
                const corner = (i === 0 || i === w - 1) && (j === 0 || j === h - 1)
                if (corner) continue
                need++
                // the frame's bottom row starts one past the corner column
                const start = b[other] - 1
                const p = axis === 'x' ? { x: plane, y: b.y + j, z: start + i } : { x: start + i, y: b.y + j, z: plane }
                if (set.has(key(p))) got++
              }
            }
            if (need && got === need) {
              const at = axis === 'x' ? { x: plane, y: b.y, z: b[other] } : { x: b[other], y: b.y, z: plane }
              return { portal: true, at, why: `an obsidian frame ${w}x${h} (not lit)` }
            }
          }
        }
      }
    }
  }
  return { portal: false, why: obsidian.length ? `${obsidian.length} obsidian, no frame` : 'no obsidian' }
}

// ------------------------------------------------------------------ reporting a find

export interface FoundInfo extends Pos { what: string, count?: number, /** The search stopped counting at `count`. */ capped?: boolean }

/** "3 iron ore at 120 40 -30, 85 blocks north-east of you (12 below the surface)". */
export function describeFind (f: FoundInfo, from: Pos | null, fromName: string, surfaceY?: number | null): string {
  const what = f.count && f.count > 1 ? `${f.count}${f.capped ? '+' : ''} ${f.what}` : f.what
  const where = `at ${Math.floor(f.x)} ${Math.floor(f.y)} ${Math.floor(f.z)}`
  let rel = ''
  if (from) {
    const d = Math.round(Math.hypot(f.x - from.x, f.z - from.z))
    rel = d <= 3 ? `, right by ${fromName}` : `, ${d} blocks ${compass(from, f)} of ${fromName}`
  }
  const depth = surfaceY !== undefined && surfaceY !== null && surfaceY - f.y > 3 ? ` (${Math.round(surfaceY - f.y)} below the surface)` : ''
  return `${what} ${where}${rel}${depth}`
}

// ------------------------------------------------------------------ bring_item sources

export type BringStep = 'inventory' | 'chest' | 'craft' | 'smelt' | 'gather' | 'find'

export interface GatherSource {
  how: FetchHow | 'materials'
  /** Block to collect, or crop block to harvest. */
  block?: string
  /** What to look for with find_target when nothing is close. */
  target?: string
}

/** How an item can be got from the world, or null when it can't (only from chests or crafting). */
export function gatherSource (item: string): GatherSource | null {
  for (const [fam, o] of Object.entries(ORES)) if (o.drop === item || o.blocks.includes(item)) return { how: 'collect', block: o.blocks[0], target: fam }
  // planks of one wood are crafted from that wood's logs (ingredientFor), any planks come from any tree
  if (/_planks$/.test(item) && WOODS.some(w => item === `${w}_planks`)) return null
  if (/_planks$/.test(item) || item === 'planks' || item === 'stick' || item === 'crafting_table' || item === 'chest') return { how: 'materials', target: 'logs' }
  if (item === 'log' || item === 'logs') return { how: 'chop', target: 'logs' }
  if (/_log$/.test(item)) return { how: 'chop', block: item, target: item }
  const crop = Object.values(CROP_BLOCKS).find(c => c.item === item)
  if (crop) return { how: 'harvest', block: crop.block, target: crop.item }
  if (item === 'wheat_seeds') return { how: 'harvest', block: 'wheat', target: 'wheat' }
  if (item === 'cobblestone') return { how: 'collect', block: 'stone', target: 'stone' }
  if (item === 'cobbled_deepslate') return { how: 'collect', block: 'deepslate', target: 'deepslate' }
  if (item === 'clay_ball') return { how: 'collect', block: 'clay', target: 'clay' }
  if (item === 'flint') return { how: 'collect', block: 'gravel', target: 'gravel' }
  if (item === 'water_bucket' || item === 'lava_bucket') return { how: 'bucket', block: item.replace('_bucket', ''), target: item.replace('_bucket', '') }
  if (FETCHABLE_BLOCK.test(item) && !NEVER_DIG.test(item)) return { how: 'collect', block: item, target: item }
  return null
}

/** Ingredients for crops-based food (one level deep) that bring_item can go and get. */
export const SIMPLE_INGREDIENTS: Record<string, { item: string, per: number, makes: number }> = {
  bread: { item: 'wheat', per: 3, makes: 1 },
  stick: { item: 'planks', per: 2, makes: 4 },
  torch: { item: 'coal', per: 1, makes: 4 },
  hay_block: { item: 'wheat', per: 9, makes: 1 }
}

/** Items bring_item makes in a furnace, with what goes in (obtained the same way first). */
export const SMELTS: Record<string, string> = {
  iron_ingot: 'raw_iron', gold_ingot: 'raw_gold', copper_ingot: 'raw_copper', glass: 'sand', stone: 'cobblestone',
  charcoal: 'log', cooked_beef: 'beef', cooked_porkchop: 'porkchop', cooked_chicken: 'chicken', cooked_mutton: 'mutton',
  baked_potato: 'potato', smooth_stone: 'stone', brick: 'clay_ball'
}

/** The one-level ingredient bring_item fetches before crafting an item, if it has one. */
export function ingredientFor (item: string): { item: string, per: number, makes: number } | null {
  const wood = WOODS.find(w => item === `${w}_planks`)
  if (wood) return { item: `${wood}_log`, per: 1, makes: 4 }
  return SIMPLE_INGREDIENTS[item] ?? null
}

export interface BringState {
  item: string
  count: number
  /** Already in the inventory. */
  have: number
  /** Seen in the bot's own chests (placed by it or listed in settings.storage.chests). */
  inOwnChests: number
  /** Own chests nearby the bot hasn't looked into yet. */
  uncheckedOwnChests: number
  /** A recipe is known for the item. */
  recipe: boolean
  /** The source the item comes from in the world, if any. */
  source: GatherSource | null
  /** What to smelt to make it, if it comes out of a furnace. */
  smeltFrom?: string | null
  canDig: boolean
  creative?: boolean
}

/**
 * Where to get the item from, in order: what the bot carries, its own chests (only ones it
 * placed or that are configured as its storage), crafting (simple recipes; ingredients come from
 * the world when they're missing), smelting (iron ingots from raw iron, glass from sand), gathering nearby, then a search with find_target. Steps that
 * can't work are left out, so an empty list means "can't get it at all".
 */
export function bringSteps (s: BringState): BringStep[] {
  if (s.have >= s.count) return ['inventory']
  const out: BringStep[] = []
  if (s.have > 0) out.push('inventory')
  if (s.inOwnChests > 0 || s.uncheckedOwnChests > 0) out.push('chest')
  if (s.creative) return out
  const gatherNeedsDig = s.source && s.source.how !== 'bucket' && s.source.how !== 'harvest'
  // wood products come out of the materials pipeline, which crafts as it goes
  if (s.recipe && s.source?.how !== 'materials') out.push('craft')
  if (s.smeltFrom) out.push('smelt')
  if (s.source && (!gatherNeedsDig || s.canDig)) {
    out.push('gather')
    if (s.source.target) out.push('find')
  } else if (s.recipe && s.source?.how === 'materials' && !s.canDig) {
    out.push('craft') // planks from logs it already has
  }
  return out
}

/** Whether a chest is the bot's own to take from: one it placed, or one the owners listed in settings.storage.chests. */
export function isOwnChest (p: Pos, own: readonly Pos[], configured: readonly Pos[]): boolean {
  const same = (q: Pos) => q.x === p.x && q.y === p.y && q.z === p.z
  return own.some(same) || configured.some(same)
}

/** Positions from settings.storage.chests: [x, y, z] arrays, {x, y, z} objects or "x y z" strings. Junk is skipped. */
export function parseChestList (v: unknown): Pos[] {
  if (!Array.isArray(v)) return []
  const out: Pos[] = []
  for (const e of v) {
    let p: number[] | null = null
    if (typeof e === 'string') p = e.trim().split(/[\s,]+/).map(Number)
    else if (Array.isArray(e)) p = e.map(Number)
    else if (e && typeof e === 'object') p = [Number((e as Pos).x), Number((e as Pos).y), Number((e as Pos).z)]
    if (p && p.length === 3 && p.every(Number.isFinite)) out.push({ x: Math.floor(p[0]!), y: Math.floor(p[1]!), z: Math.floor(p[2]!) })
  }
  return out
}

// ------------------------------------------------------------------ delivery

export interface TossCount {
  requested: number
  /** Of the item in the bot's inventory before and after tossing. */
  before: number
  after: number
  /** Items the player was seen picking up (playerCollect), or null when that couldn't be watched. */
  pickedUp: number | null
}

/**
 * What a toss really did: how many left the inventory, how many the player was seen picking up,
 * whether that is what was asked for, and a truthful line for chat.
 */
export function tossAccount (t: TossCount, item: string, player: string): { given: number, pickedUp: number | null, ok: boolean, message: string } {
  const given = Math.max(0, t.before - t.after)
  const picked = t.pickedUp === null ? null : Math.min(t.pickedUp, given)
  let message: string
  if (!given) message = `couldn't hand over any ${item}`
  else if (picked === null) message = `tossed ${given} ${item} to ${player}`
  else if (picked >= given) message = `gave ${player} ${given} ${item}`
  else if (picked > 0) message = `tossed ${given} ${item}; ${player} picked up ${picked}, the rest is on the ground by them`
  else message = `tossed ${given} ${item} next to ${player}; they haven't picked it up yet`
  const short = given < t.requested ? ` (${t.requested} asked for, I had ${t.before})` : ''
  // ok only when it all reached the player (or pickups couldn't be watched): items on the ground aren't delivered
  return { given, pickedUp: picked, ok: given >= t.requested && given > 0 && (picked === null || picked >= given), message: message + short }
}

// ------------------------------------------------------------------ owner drops

/** Ground items despawn after 5 minutes in loaded chunks. */
export const DESPAWN_MS = 5 * 60_000

export interface DropsTrip {
  /** When the player died (epoch ms). */
  diedAt: number
  now: number
  /** Blocks from the bot to the death spot. */
  distance: number
  /** Walking speed on a trip, blocks per second. Default 3.5 (paths are never straight). */
  speed?: number
  /** Margin kept for picking up. Default 20 s. */
  marginMs?: number
}

/** Whether the drops can still be there when the bot arrives, with the times for the answer. */
export function dropsTrip (t: DropsTrip): { go: boolean, etaMs: number, leftMs: number, why: string } {
  const speed = t.speed ?? 3.5
  const etaMs = Math.round(t.distance / speed * 1000)
  const leftMs = Math.max(0, DESPAWN_MS - (t.now - t.diedAt))
  const margin = t.marginMs ?? 20_000
  const s = (ms: number) => ms >= 90_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`
  if (leftMs <= 0) return { go: false, etaMs, leftMs, why: `the items despawned (died ${s(t.now - t.diedAt)} ago)` }
  if (etaMs + margin > leftMs) return { go: false, etaMs, leftMs, why: `it's ${Math.round(t.distance)} blocks, about ${s(etaMs)} away, and the items despawn in ${s(leftMs)}` }
  return { go: true, etaMs, leftMs, why: `about ${s(etaMs)} away, ${s(leftMs)} before the items despawn` }
}

// ------------------------------------------------------------------ progress

/**
 * Whether to tell the player how a long job is going: milestones (a phase starts, something is
 * found, items collected) at most every `minGapMs`; important ones (found it, giving up) always.
 */
export function progressDue (lastAt: number, now: number, important: boolean, minGapMs = 20_000): boolean {
  return important || now - lastAt >= minGapMs
}

/** Direction and distance from one point to another, for "45 blocks south-west". */
export function bearing (from: XZ, to: XZ): string {
  const d = Math.round(Math.hypot(to.x - from.x, to.z - from.z))
  return d <= 3 ? 'right here' : `${d} blocks ${compass(from, to)}`
}
