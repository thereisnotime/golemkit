## ADDED Requirements

### Requirement: Actions
Skills SHALL expose capabilities as actions with a name, description and zod parameter schema, callable through `Agent.act()`.

#### Scenario: Invalid parameters
- **WHEN** an action is called with parameters that fail its schema
- **THEN** it does not run and the result explains the validation error

### Requirement: Action lock
Only one exclusive action SHALL run at a time, arbitrated by caller priority.

#### Scenario: Reflex preempts follow
- **WHEN** the bot is following a player (player priority) and gets hit (reflex priority)
- **THEN** follow is suspended, the bot fights back, and follow resumes afterwards

#### Scenario: Lower priority while busy
- **WHEN** an NPC brain requests an exclusive action while a player-issued action runs
- **THEN** the request is rejected with a busy result

### Requirement: Command brain
Every non-internal action SHALL be usable as a chat command.

#### Scenario: Positional and named arguments
- **WHEN** a player says `!goto 10 64 -20` or `!follow distance=4 Steve`
- **THEN** the words map to the action's parameters in schema order, with key=value by name

### Requirement: Bot definitions and fleets
Bots SHALL be defined in `bots/` and runnable alone or several per process.

#### Scenario: Fleet
- **WHEN** `cli.ts fleet fleet.yaml` lists three bots
- **THEN** all three connect, staggered, in one process
