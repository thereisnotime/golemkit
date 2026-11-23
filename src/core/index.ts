// Public API for writing skills, brains and bots.
import { loadDotEnvOnce } from './definition.ts'
// Load .env before any variant or script reads process.env, also when Node wasn't started with
// --env-file. Variables already set in the environment win.
loadDotEnvOnce()
export { Agent, type AgentEvents, type HelpEventInfo, type ChatMessage, type ActionInfo, type ActOptions, type ActionCatalogEntry } from './agent.ts'
export {
  defineAction, noParams, ok, fail, sleep, checkAborted, ActionAbortedError, PRIORITY,
  type ActionDef, type ActionContext, type ActionResult, type Caller
} from './action.ts'
export { defineSkill, type SkillDef } from './skill.ts'
export { defineBrain, type BrainDef } from './brain.ts'
export { defineBot, defineVariant, serverFromEnv, expandEnv, envOr, loadDotEnvOnce, type BotDefinition, type VariantDefinition, type ServerConfig, type InstanceOptions } from './definition.ts'
export {
  createLogger, setLogLevel, configureLogging, loggingFromEnv, getLoggingConfig, recentLogs, subscribeLogs, installCrashHandlers, LEVELS,
  type Logger, type Level, type LogEntry, type LogConfig, type LogFields
} from './log.ts'
export { Storage } from './storage.ts'
export { distance } from './format.ts'
export { Fleet, Blackboard, type FleetMessage, type FleetEvents } from './fleet.ts'
export { goals, Movements, goto, gotoTimed, travel, reachMovements, type ReachMoves, surfaceY, roofed, TravelUndergroundError, TravelUnderwaterError, swimUp, holdGoal, playerEntity, isHostile, FLYING, nearestHostile, itemName, fmtPos, needsSurvival, gameModeNote } from '../adapters/minecraft-java/helpers.ts'
export { isModdedBlock, MODDED_BLOCK } from '../adapters/minecraft-java/modded.ts'
export {
  DangerMemory, dangerMemory, rememberDanger, activeZones, isInDanger, avoidZones, crossesDanger, clearDanger, describeZone,
  DANGER_TTL_MS, PATROL_TTL_MS, DANGER_RADIUS, type DangerZone, type DangerSighting, type DangerPos
} from './danger.ts'
export {
  Journal, resolveJournalConfig, fleetQuery, parseDeathMessage, parseAdvancement, parseRange,
  fmtEvent, fmtSection, fmtRollup, fmtCounts, ago, buildDayRollup, buildSection, ITEM_DESPAWN_MS, JOURNAL_TYPES,
  type JournalEvent, type JournalQuery, type JournalConfig, type JournalType, type DeathView, type DayRollup,
  type RollupSection, type PeriodSummary, type DeathInfo,
  DeathCauseTracker, buildDeathReport, describeDeath, causeFromMessage, onDeathReport, type DeathReport, type DeathContext
} from './journal/index.ts'
export {
  KNOWN_CAPABILITIES, supports,
  type GameAdapter, type GameClient, type GameClients, type AdapterFactory, type AdapterEvents, type AdapterConnectOptions,
  type Capability, type KnownCapability, type Observation, type SelfState, type ObservedEntity, type SeenEntity,
  type InventoryStack, type WorldTime, type Pos
} from './adapter.ts'
// Minecraft Java (the default adapter): re-exported so variants, profiles and scripts keep their imports.
export { MinecraftJavaAdapter, minecraftJava } from '../adapters/minecraft-java/adapter.ts'
export { JournalCapture } from '../adapters/minecraft-java/journal-capture.ts'
export { z } from 'zod'
