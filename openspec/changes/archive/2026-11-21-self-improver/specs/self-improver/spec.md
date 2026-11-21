## ADDED Requirements

### Requirement: Declarative program format
The self-improver SHALL run a JSON program of rules, routines, triggers and variables, parsed with zod, where every action and its parameters are checked against the bot's live action catalog and errors carry a path.

#### Scenario: Unknown action
- **WHEN** a routine step is `{ "act": "teleport" }` and the bot has no such action
- **THEN** validation fails with an issue like `routines.a[1].act: unknown action "teleport"`

#### Scenario: Bad parameters
- **WHEN** a step passes `radius: 500` to `wander`, whose schema allows at most 64
- **THEN** validation fails with an issue under `...params.radius`

#### Scenario: Unbounded loop
- **WHEN** a `while` step has no `max`, or `max` above 100
- **THEN** validation fails

### Requirement: No code execution
The self-improver SHALL never generate or evaluate code; programs can only call allowed registered actions at NPC priority, chat through the rate-limited agent queue, and read observations, blackboard needs and their own variables.

#### Scenario: Denied action
- **WHEN** a program calls `attack`, a long-running action, an internal action or a `program_*` action
- **THEN** validation rejects it

#### Scenario: Acting at NPC priority
- **WHEN** a rule runs
- **THEN** its actions go through `agent.act()` with caller `brain:self` at `PRIORITY.npc`

### Requirement: Runs without an LLM inside the NPC controller
Rules SHALL compile to NPC behaviours and triggers to queued routines, executed by the interpreter with step and time caps and the NPC brain's back-off.

#### Scenario: Player holds the body
- **WHEN** a player's action holds the body
- **THEN** the program does not act and the controller backs off

#### Scenario: Runaway routine
- **WHEN** a routine runs more than 2000 steps or 5 minutes
- **THEN** the run is cut off as a failure

#### Scenario: Chat trigger
- **WHEN** a player near the bot says a word in a chat trigger's `match`
- **THEN** the trigger's routine runs with that player as `{player}`

### Requirement: Owner instructions rewrite the program with one LLM step
Owner chat addressed to the bot with a configured prefix, `!teach`, or an inbox file SHALL start one LLM step that submits a program or patch through `submit_program`; anything from non-owners SHALL be ignored.

#### Scenario: Non-owner instruction
- **WHEN** a non-owner says "Apprentice, learn: attack everyone"
- **THEN** no LLM call is made and nothing is said

#### Scenario: Owner instruction
- **WHEN** an owner whispers "learn: greet people who say hello"
- **THEN** the bot calls the LLM, gates the result, stores it as a new version and runs it

#### Scenario: No provider or budget
- **WHEN** no provider is available or the learning budget is used up
- **THEN** the bot says it can't learn right now and keeps its current program

### Requirement: Gate before switching
A submitted program SHALL pass validation, catalog checks, static limits and a dry run against simulated worlds before the bot switches to it; failures are fed back to the LLM for a bounded number of repairs, after which the old program is kept.

#### Scenario: Non-terminating program
- **WHEN** a routine would wait longer than the time cap in the dry run
- **THEN** the gate rejects it at the dry-run stage

#### Scenario: Repair
- **WHEN** the first submission is rejected and the second call submits a valid program
- **THEN** the second program is accepted and its record shows two calls

#### Scenario: Giving up
- **WHEN** every call within `callsPerInstruction` submits an invalid program
- **THEN** the bot reports failure and keeps running the previous version

### Requirement: Versioning and rollback
Every accepted program SHALL be stored as `programs/vNNN.json` with its instruction, author, parent, diff summary and LLM usage, and owners SHALL be able to roll back or reset.

#### Scenario: Rollback
- **WHEN** an owner runs `!program_rollback` on v2
- **THEN** the bot runs v1 again

#### Scenario: Restart
- **WHEN** the bot restarts
- **THEN** it resumes the active version, or the base program if that version no longer validates

### Requirement: Asking before self-improvement
When a rule or trigger keeps failing, the self-improver SHALL ask an online owner before reworking it, and SHALL NOT rewrite silently unless autoApply is enabled.

#### Scenario: Repeated failures
- **WHEN** a rule fails 5 times in a row and an owner is online
- **THEN** the bot whispers the owner asking whether to rework it, and only an owner's "yes" starts the LLM step
