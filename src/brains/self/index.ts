// Self-improver: an NPC that runs a declarative program without an LLM and rewrites that
// program with one LLM step when an owner tells it to. See docs/guide/self-improver.md.
export { selfImprover, SelfImprover, isTeacher, type SelfImproverOptions, type SelfAgent, type ExperienceOptions } from './brain.ts'
export {
  FORMAT_VERSION, LIMITS, FACTS, TIME_WINDOWS, DEFAULT_DENY, ProgramSchema, ProgramError,
  parseProgram, mustParse, makeCatalog, applyPatch, diffSummary, formatSpec,
  type Program, type ProgramInput, type ProgramPatch, type Rule, type Trigger, type Step, type Cond, type ActionCatalog, type CatalogPolicy
} from './format.ts'
export { runRoutine, evalCond, ProgramMemory, ChatLimiter, CapExceeded, RoutineFailed, type World, type Host, type RunEnv } from './interpreter.ts'
export { compile, liveWorld, TriggerQueue, TRIGGER_BEHAVIOR } from './compile.ts'
export { gate, dryRun, SimWorld, DEFAULT_SCENARIOS, type GateResult, type DryRunReport, type Scenario } from './gate.ts'
export { ProgramStore, type ProgramRecord, type ProgramUsage } from './store.ts'
export { Learner, extractJson, type LearnerOptions, type LearnResult, type LearnBudget } from './learner.ts'
export { parseInstruction, parseAnswer, chatMatches, DEFAULT_PREFIXES, type IntakeOptions } from './intake.ts'
