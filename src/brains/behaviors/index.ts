// Armable behaviours: a registry of documented, option-validated behaviours that owners, LLM
// brains, hooks and programs switch on and tune at runtime. See docs/guide/behaviors.md.
export { behaviorsBrain, defaultBehaviorRegistry, type BehaviorsBrainOptions } from './brain.ts'
export { BehaviorRegistry, type Options, type ValidateResult } from './registry.ts'
export { defineBehavior, LEVELS, type BehaviorDefinition, type BehaviorCategory, type BehaviorLevel, type BehaviorBody, type BehaviorEnv } from './types.ts'
export { ArmedStore, STORAGE_KEY, type ArmedEntry, type ArmedRecord } from './armed.ts'
export { BehaviorRuntime, canPlace, missingCapability } from './runtime.ts'
export { validateBehaviorConfig, mergeConfigs, normalizeEntry, BehaviorConfigError, type BehaviorConfig, type BehaviorConfigEntry } from './config.ts'
export { behaviorActions, runtimeFor, changeDenied, describeOptions, fmtOptions } from './actions.ts'
export * from './library/index.ts'
