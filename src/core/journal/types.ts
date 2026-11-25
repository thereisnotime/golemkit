// Event journal types: what one recorded fact looks like and the journal settings.

export const JOURNAL_TYPES = [
  'death', 'respawn', 'damage', 'kill',
  'item_gained', 'item_lost',
  'block_broken', 'block_placed',
  'chat_in', 'chat_out', 'whisper',
  'action', 'goal',
  'player_seen', 'player_joined', 'player_left',
  'place_visited', 'advancement', 'protected_area',
  'food_spot', 'farm_started', 'found',
  'connect', 'disconnect',
  'llm_turn',
  /** Container memory (settings.inventoryMemory): a container's contents differ from what the bot remembered / it is gone or another block. */
  'container_changed', 'container_gone',
  /** A behaviour asked the owners for help, or it works again (settings.askHelp). */
  'help',
  /** A place it depends on (farm, bed, chest, home) went bad or is fine again (site health). */
  'site',
  /** Written by the journal itself when a type hit its per-minute cap. */
  'journal_dropped'
] as const

export type JournalType = typeof JOURNAL_TYPES[number]

export interface Pos { x: number, y: number, z: number }

/** One recorded fact. `ts` is epoch ms, `pos` is block coordinates. */
export interface JournalEvent {
  ts: number
  type: JournalType | string
  pos?: Pos
  dim?: string
  data: Record<string, any>
  /** Set on query results only: the bot it came from (fleet queries) / it was reconstructed from a rollup. */
  bot?: string
  fromRollup?: boolean
}

export interface SummarizeConfig {
  provider: string
  /** Anything createProvider accepts (model, effort, login, ...). */
  options: Record<string, unknown>
  /** Max characters of the summary. Default 600. */
  maxChars: number
}

export interface JournalConfig {
  enabled: boolean
  /** Types to record; null = all. */
  types: Set<string> | null
  exclude: Set<string>
  /** Raw JSONL files older than this are deleted once their rollup exists. */
  retentionDays: number
  /** Rollup files older than this are deleted. */
  rollupRetentionDays: number
  flushMs: number
  /** Per type, per minute. `default` applies to types without their own entry. */
  caps: Record<string, number>
  actions: { includeStatus: boolean, skip: Set<string> }
  /** Add a recent-events line to observe() when a context pack is active. */
  observe: boolean
  /** Side of the square region (blocks) that counts as "a new place" for place_visited. */
  placeRegion: number
  summarize: SummarizeConfig | null
}
