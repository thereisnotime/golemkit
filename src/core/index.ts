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
export {
  STATUS_DEFAULTS, resolveStatusOptions, assess, idleReason, alertDue, alertText, chatLine as statusChatLine, formatStatus, staleAfter, fmtDuration,
  type StatusOptions, type DeciderSnapshot, type BotStatus, type StatusState, type DoingView, type Assessment, type AssessInput, type AlertState
} from './status.ts'
export { StatusTracker, statusAction, PROGRESS_DISTANCE, type DeciderSource, type StatusAgent } from './statusTracker.ts'
export { distance } from './format.ts'
export { Fleet, Blackboard, type FleetMessage, type FleetEvents } from './fleet.ts'
export { goals, Movements, goto, gotoTimed, travel, reachMovements, type ReachMoves, surfaceY, roofed, TravelUndergroundError, TravelUnderwaterError, swimUp, holdGoal, playerEntity, isHostile, FLYING, nearestHostile, itemName, fmtPos, needsSurvival, gameModeNote } from '../adapters/minecraft-java/helpers.ts'
export { getAir, headInWater, oxygen, planAir, airCells, climbOntoLedge, trackOwnAir, type AirResult } from '../adapters/minecraft-java/air.ts'
export { isModdedBlock, MODDED_BLOCK } from '../adapters/minecraft-java/modded.ts'
export {
  DangerMemory, dangerMemory, rememberDanger, activeZones, isInDanger, inZoneHeight, avoidZones, crossesDanger, clearDanger, describeZone,
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
export {
  TRIP_DEFAULTS, STARVING_BAR, DAYLIGHT_MS, tripSettings, planTripPrep, tripNotReadyText, tripStart, walkHomeMs, turnBackReason,
  beginTrip, activeTrip, endTrip, checkTrip, rethrowTurnBack, TripTurnBackError,
  type TripSettings, type TripKind, type TripKit, type TripPrep, type TripSample, type TripStart, type Trip
} from './trip.ts'
export {
  NEED_NAMES, IDLE_MODES, SEARCH_DEFAULTS, IDLE_DEFAULTS, SITES_DEFAULTS, needsSettings, idleSettings, sitesSettings,
  NeedsSettingsSchema, IdleSettingsSchema, SitesSettingsSchema,
  type IdleMode, type NeedsSettings, type NeedSetting, type IdleSettings, type ChoreSetting, type SitesSettings, type SearchSettings
} from './needs.ts'
export {
  SiteBook, siteBook, noteSiteCheck, recheckDue, checkDue, siteText, siteLabel, HARD_FAULTS,
  type SiteFault, type SitePos, type SiteRef, type SiteVerdict, type SiteRecord, type SiteChange
} from './sites.ts'
export {
  PROJECT_POLICIES, TIMEOUT_POLICIES, PROJECT_OPS, PROJECTS_DEFAULTS, MAX_FAILS, FAIL_BACKOFF_MS, ProjectsSettingsSchema, projectsSettings, emptyProjectState, normalizeState, stuckReason,
  orderProjects, needsOk, projectQueue, nextStep, applyOp, noteSession, restingReason, fmtQueue, goalMentions,
  type ProjectPolicy, type TimeoutPolicy, type ProjectsSettings, type ProjectInfo, type ProjectState, type ProjectProgress, type Decision,
  type QueueStatus, type QueueEntry, type StepContext, type NextStep, type ProjectOp
} from './projects.ts'
export {
  SAFETY_TECHNIQUES, CAP_KINDS, MINE_PLACEMENTS, BASE_SAFETY_DEFAULTS, DEATH_SPOTS_DEFAULTS, DEATH_ZONE_KIND,
  BaseSafetySettingsSchema, DeathSpotsSettingsSchema, baseSafetySettings, deathSpotsSettings,
  type SafetyTechnique, type CapKind, type MinePlacement, type BaseSafetySettings, type DeathSpotsSettings
} from './baseSafety.ts'
export {
  MATERIAL_SOURCES, MATERIAL_SOURCES_DEFAULTS, MaterialSourcesSettingsSchema, materialSourcesSettings,
  type MaterialSource, type MaterialSourcesSettings
} from './materialSources.ts'
