## ADDED Requirements

### Requirement: Scene definitions are validated data
Scenes SHALL be definable as TS objects (via a builder) or YAML files, and SHALL be validated before use, with errors that name the offending path.

#### Scenario: Valid YAML scene loads
- **WHEN** a YAML file with roles, marks and beats referencing only declared roles and marks is loaded
- **THEN** it is returned as a typed scene

#### Scenario: Unknown role is rejected
- **WHEN** a beat uses `as: minr` but the scene only declares `miner`
- **THEN** loading fails with an error that names the beat path and the unknown role

### Requirement: Casting and director election are deterministic
The coordinator SHALL assign roles to online, idle scene bots that meet each role's requirements, honouring preferences, and SHALL elect the director as an explicit director bot or else the lowest username in the cast.

#### Scenario: Three bots, three roles
- **WHEN** bots C, A, B are online and a scene with roles hauler, foreman, miner starts
- **THEN** roles are assigned A, B, C in declaration order and A directs

#### Scenario: Not enough bots
- **WHEN** a required role cannot be filled
- **THEN** the scene does not start and the request fails with a reason

### Requirement: Director runs the beat timeline with cues
The director SHALL run beats in order, run parallel branches and role tracks concurrently, and SHALL block `await` beats until the matching `cue` fires (or the timeout passes).

#### Scenario: Cue sync between roles
- **WHEN** the miner track awaits `parts` and the foreman track cues `parts` after a wait
- **THEN** the miner's next beat starts only after the cue

### Requirement: Recast on disconnect
When a cast member goes offline the director SHALL pause the scene and recast the role; if nobody is available within the timeout it SHALL abort and release the cast.

#### Scenario: Replacement available
- **WHEN** a cast member goes offline and an idle eligible bot exists
- **THEN** the role is reassigned and the scene continues with the new bot

#### Scenario: No replacement
- **WHEN** a cast member goes offline and nobody can take the role within the timeout
- **THEN** the scene aborts and every cast member is released

### Requirement: Scenes yield to higher priorities and stop cleanly
Scene actions SHALL run at `PRIORITY.scene` with a per-run caller; stopping a scene SHALL cancel only the actions that run started.

#### Scenario: Stop leaves other actions alone
- **WHEN** a scene is stopped while a cast member also has a suspended NPC action
- **THEN** the scene's action is aborted and the NPC action is not removed

### Requirement: Player interactions branch the scene
Scenes SHALL be able to react when a player approaches, chats or hits a cast member, rate limited per interaction and per player.

#### Scenario: Approach pauses and resumes
- **WHEN** a player comes within the approach radius during a scene with a `pause` interaction
- **THEN** the timeline pauses, the reaction beats run with `{player}` filled in, and the timeline resumes

#### Scenario: Cooldown
- **WHEN** the same player triggers the same interaction again within its cooldown
- **THEN** no reaction runs

### Requirement: Control actions
Bots with the scene brain SHALL expose `scene_start`, `scene_stop`, `scene_status` and `scene_list`, and a command heard by several bots SHALL be handled once.

#### Scenario: Start by chat
- **WHEN** an owner says `!scene_start broken_cart` near three actors
- **THEN** exactly one scene run starts and one bot replies
