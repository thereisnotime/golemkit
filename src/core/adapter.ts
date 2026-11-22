// The line between the game-agnostic core and a game. The Agent (action lock, chat queue,
// storage, brains, journal) talks to one GameAdapter; the adapter owns the game client, its
// connection and everything game-specific. Minecraft Java is src/adapters/minecraft-java.
// See docs/concepts/adapters.md.
import type { Agent } from './agent.ts'

/**
 * What an adapter can do. Actions and behaviours list the ones they need (`requires`) and an
 * agent only offers those its adapter supports. Games can add their own names.
 */
export type KnownCapability =
  | 'chat' // public chat and whispers
  | 'commands' // server commands (/..., //... for WorldEdit)
  | 'move' // walk, path find, follow
  | 'look' // turn the head, gestures
  | 'dig' // break blocks
  | 'place' // place blocks
  | 'inventory' // hold, toss, equip items
  | 'craft' // crafting recipes
  | 'containers' // chests and other containers
  | 'combat' // attack, defend
  | 'eat' // hunger and food
  | 'sleep' // beds
  | 'creative' // creative-mode item access, flying
  | 'mods' // modded content (registries, mod lists)
export type Capability = KnownCapability | (string & {})

/** Every capability core knows about (the Minecraft Java adapter supports them all). */
export const KNOWN_CAPABILITIES: readonly KnownCapability[] = [
  'chat', 'commands', 'move', 'look', 'dig', 'place', 'inventory', 'craft', 'containers', 'combat', 'eat', 'sleep', 'creative', 'mods'
]

/** True when `have` contains every capability in `need` (no `need` means always). */
export function supports (have: ReadonlySet<Capability>, need: readonly Capability[] | undefined): boolean {
  return !need || need.every(c => have.has(c))
}

export interface Pos { x: number, y: number, z: number }

/** The bot itself, in the shape every game shares; `game` holds the rest. */
export interface SelfState {
  username: string
  position: Pos
  /** Health and food, or the game's equivalents; null when the game has none. */
  health: number | null
  food: number | null
  heldItem: string | null
  /** In bed (games that have sleeping). */
  sleeping?: boolean
  /** Game-specific facts about the bot, in the order they appear in observe(). */
  game: Record<string, unknown>
}

export interface ObservedEntity {
  name: string
  type: string
  distance: number
  position: Pos
}

/**
 * A snapshot of what the bot can see. The shared part is small and versioned; `game` holds
 * what only skills of that game read. Agent.observe() turns it into the JSON that LLM brains
 * and debugging tools get.
 */
export interface Observation {
  version: 1
  game: string
  self: SelfState
  /** World time; `isDay` is the game's own notion of day. */
  time: { timeOfDay: number, isDay: boolean }
  /** Other players online (names). */
  players: string[]
  /** Nearest entities, closest first. */
  nearby: ObservedEntity[]
  /** Item name -> count. */
  inventory: Record<string, number>
}

export interface SeenEntity {
  id: number
  name: string
  type: string
  /** Players only. */
  username?: string
  position: Pos
  distance: number
  /** Attacks on sight (the game's own judgement, neutral mobs excluded). */
  hostile: boolean
}

export interface InventoryStack {
  /** The game's item name (Minecraft: 'unknown' for an unmapped modded item). */
  name: string
  /** The name observe() uses (Minecraft: modded#<id> for an unmapped modded item). */
  label: string
  count: number
  /** Edible. */
  food: boolean
}

export interface WorldTime {
  timeOfDay: number
  day: number
  /** Day as observe() reports it. */
  isDay: boolean
  /** Night for sleeping and danger (Minecraft: beds work, or a thunderstorm). */
  isNight: boolean
}

/** Events an adapter emits. The Agent turns them into its own events (session, chat, ...). */
export type AdapterEvents = {
  /** In the world and ready: the agent sets up skills and brains. */
  spawn: () => void
  /** The connection ended. 'learned' means "reconnect right away" (a handshake learned something). */
  end: (reason: 'learned' | 'ended', detail?: string) => void
  chat: (from: string, message: string, whisper: boolean) => void
  /** Any server/system message that isn't player chat. */
  serverMessage: (text: string, position: string) => void
  /** The bot got hurt; health after the hit. */
  hurt: (health: number) => void
  /** Health or food changed. */
  health: (health: number, food: number) => void
  death: () => void
  /** Respawned in the same session (after a death or a dimension change). */
  respawn: () => void
  playerJoined: (name: string) => void
  playerLeft: (name: string) => void
  /** The server changed the bot's game mode. */
  gameMode: (mode: string, previous: string) => void
  kicked: (reason: string) => void
  error: (err: Error) => void
}

export interface AdapterConnectOptions {
  username: string
}

/**
 * One game client behind the agent. An adapter is created per agent and reused for every
 * session: connect() starts one, the 'end' event says it's over, and the agent calls
 * connect() again to reconnect.
 */
export interface GameAdapter {
  /** 'minecraft-java', 'minecraft-bedrock', ... */
  readonly game: string
  readonly capabilities: ReadonlySet<Capability>
  /** Called once by the Agent constructor, before any connect. */
  attach (agent: Agent): void
  /** Starts a session; resolves once the connection attempt is under way. */
  connect (opts: AdapterConnectOptions): Promise<void>
  disconnect (reason?: string): Promise<void>
  /** In a session and spawned. */
  readonly connected: boolean
  /** The game's own client (Minecraft Java: the Mineflayer bot), for that game's skills. */
  readonly client: GameClient | null
  self (): SelfState | null
  /** What the bot sees; null when not in the world. */
  observe (): Observation | null
  /** Sends a chat line (or a whisper to `to`) right away; the agent's queue does the rate limiting. */
  chat (text: string, to?: string): Promise<void>
  /** Sends a server command line ('/...'), without styling. */
  command (line: string): Promise<void>
  on<E extends keyof AdapterEvents> (event: E, fn: AdapterEvents[E]): void
  off<E extends keyof AdapterEvents> (event: E, fn: AdapterEvents[E]): void

  /** Called by the agent when a session is over (after skills and brains cleaned up): drop per-session state and close the client. */
  endSession (): void

  // Primitives the core and the brain frameworks use (all optional: a game without them skips them).
  /** Once per Agent.start(), before the first connect (process-wide setup). */
  start? (): void
  /** Stops any movement in progress (the action lock calls it when it stops an action). */
  stopMotion? (): void
  /** Settings changed (config_set): re-read what the adapter takes from settings. */
  settingsChanged? (key: string): void
  /** The protected areas changed: re-plan movement around them. */
  replan? (): void
  /** Humanize: stand still for `ms`, facing `speaker` if set and visible. */
  holdStill? (ms: number, speaker?: string): Promise<void>
  /** Humanize: an idle glance around. */
  fidget? (): void
  /** Is the body moving (path finding, following)? */
  isMoving? (): boolean
  /** Every entity the client tracks except the bot, with its distance from the bot. */
  entities? (): SeenEntity[]
  /** Inventory stacks with the game's own item names, and how many slots there are. */
  inventory? (): { items: InventoryStack[], slots: number }
  /** World time and the game's notions of day and night. */
  time? (): WorldTime | null
  /** Everyone online, the bot included. */
  players? (): string[]
  /** Where another player is, when the bot can see them. */
  playerPosition? (name: string): Pos | null
  /** Low health or food, night, or hostiles close (the LLM brain lets safety behaviours win then). */
  inDanger? (): boolean
}

/**
 * The type of `adapter.client`, `ctx.bot` in actions and the `bot` argument of skill and brain
 * hooks. Each adapter adds its client type to GameClients (module augmentation), so core never
 * names a game library: with the Minecraft Java adapter it is the Mineflayer Bot.
 */
export interface GameClients {}
export type GameClient = keyof GameClients extends never ? unknown : GameClients[keyof GameClients]

/** Creates an adapter for a server; profiles and fleet files pick one by game name (phase 4). */
export type AdapterFactory = () => GameAdapter
