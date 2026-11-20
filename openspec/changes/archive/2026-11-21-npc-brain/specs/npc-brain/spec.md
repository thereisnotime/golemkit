## ADDED Requirements

### Requirement: Utility-based behaviour selection
The NPC brain SHALL score every configured behaviour each tick and run the highest positive score, with hysteresis so it does not flap.

#### Scenario: Highest score wins
- **WHEN** nothing is running and behaviours score 5 and 20
- **THEN** the brain starts the behaviour scoring 20

#### Scenario: Challenger within the margin
- **WHEN** a behaviour scoring 30 is running and another scores 35 with a switch margin of 10
- **THEN** the running behaviour keeps going

#### Scenario: Challenger beyond the margin
- **WHEN** a behaviour scoring 30 has run longer than the minimum run time and another scores 45
- **THEN** the brain aborts the running behaviour, interrupts its in-flight action and starts the other

#### Scenario: Urgent challenger
- **WHEN** a behaviour just started and danger scores at or above the urgent threshold
- **THEN** the brain switches immediately regardless of the minimum run time

### Requirement: Acting through the action lock
The NPC brain SHALL act only through `agent.act()` with caller `brain:npc` at `PRIORITY.npc`.

#### Scenario: Behaviour runs an action
- **WHEN** a behaviour runs
- **THEN** its actions are requested via `agent.act()` with the NPC caller and priority

### Requirement: Backing off for other callers
The NPC brain SHALL stay out of the way while a player, LLM, reflex or system caller holds the body, and resume after a back-off.

#### Scenario: Player holds the body
- **WHEN** a player-issued action is running
- **THEN** the brain requests no actions, reports itself paused, and resumes only after the player's action ended and the back-off elapsed

#### Scenario: Taken over mid-action
- **WHEN** a player preempts the NPC's running action
- **THEN** the running behaviour ends and the brain backs off

#### Scenario: Busy result
- **WHEN** an NPC action request returns busy because a reflex holds the body
- **THEN** the brain backs off for the shorter reflex back-off

### Requirement: Failure cooldown
A behaviour that fails SHALL not be retried until an exponentially growing cooldown has passed.

#### Scenario: No bed
- **WHEN** sleep_at_night fails because there is no bed
- **THEN** it scores 0 until its cooldown expires, and the cooldown doubles on the next failure

### Requirement: Graceful degradation
Behaviours that need actions the bot does not have SHALL score 0.

#### Scenario: Missing chore skill
- **WHEN** a bot lists `actionBehavior('chop_tree', ...)` but has no `chop_tree` action
- **THEN** the behaviour never runs and the others are unaffected

### Requirement: Navigation skill
The navigation skill SHALL provide wander, set_home, go_home, remember_place, forget_place, places, goto_place and flee actions, with home and places persisted in agent storage.

#### Scenario: Home persists
- **WHEN** a bot sets home and later restarts
- **THEN** go_home walks back to the stored position

#### Scenario: First spawn
- **WHEN** an NPC brain starts a session and no home is stored
- **THEN** the spawn position becomes home

### Requirement: NPC status
The NPC brain SHALL expose an `npc_status` action reporting the current behaviour, top scores, needs and back-off state.

#### Scenario: Asking the NPC
- **WHEN** a player says `!npc_status`
- **THEN** the bot replies with what it is doing and why
