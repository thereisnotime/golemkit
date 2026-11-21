// A/B evals for context packs (and other prompt/config changes). See docs/guide/context-pack.md.
export { runEval, expectedRuns, fmtReport, writeReport, type Arm, type EvalOptions, type EvalReport, type RunRecord, type Aggregate } from './harness.ts'
export { SCENARIOS, OWNER, runCheck, checkLabel, type Scenario, type Check, type RunOutcome } from './scenarios.ts'
export { EvalWorld, defaultWorld, type WorldState, type DigEvent } from './world.ts'
export { ScriptedProvider } from './scripted.ts'
