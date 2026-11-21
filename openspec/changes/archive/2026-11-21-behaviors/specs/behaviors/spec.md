## ADDED Requirements

### Requirement: Behaviour registry
The system SHALL keep behaviour definitions by name, each with a strict zod options schema with defaults, a description, a category, required actions and a default priority level.

#### Scenario: Unknown option
- **WHEN** a behaviour is armed with an option its schema does not define
- **THEN** arming fails with a message naming the unknown option and listing the valid ones

#### Scenario: Unknown behaviour
- **WHEN** an unknown behaviour name is armed or configured
- **THEN** it fails with a message suggesting close names and listing the known ones

### Requirement: Arming from actions
The system SHALL provide behavior_list, behavior_status, behavior_arm, behavior_disarm, behavior_configure and behavior_reset as non-exclusive actions, so chat, LLM brains, hooks and programs can use them.

#### Scenario: Owner arms from chat
- **WHEN** an owner says `!behavior_arm keep_fed below=10`
- **THEN** keep_fed is armed with below=10 and the bot replies with the non-default options

#### Scenario: Non-owner is refused
- **WHEN** a player who is not an owner, or an LLM turn acting for one, tries to arm a behaviour
- **THEN** the action fails and nothing changes

#### Scenario: LLM arms
- **WHEN** the LLM brain calls behavior_arm
- **THEN** the change is recorded as made by brain:llm

### Requirement: Persistence
Runtime arm, disarm and configure changes SHALL be stored in agent.storage and win over the profile and variant config after a restart.

#### Scenario: Restart keeps runtime arming
- **WHEN** follow_owner is armed from chat and the bot restarts
- **THEN** follow_owner is still armed with the same options

### Requirement: Profile configuration
Profiles SHALL accept a `behaviors:` map of name to true, false or options, validated against the registry before the bot connects.

#### Scenario: Bad profile options
- **WHEN** a profile sets `keep_fed: { below: 40 }`
- **THEN** the run stops with an error naming the file, the behaviour and the option

### Requirement: Priorities and back-off
Armed behaviours SHALL act through agent.act as brain:behaviors at their own level (idle 10, npc 20, behavior 35) and back off while a caller at or above their level holds the body.

#### Scenario: Survival behaviour while the LLM holds the body
- **WHEN** the LLM runs an action at priority 30 and keep_fed (35) wants to run
- **THEN** keep_fed runs and npc-level behaviours stay paused

#### Scenario: Disarm stops a running behaviour
- **WHEN** a running behaviour is disarmed
- **THEN** it stops immediately

### Requirement: keep_fed
keep_fed SHALL, when hungry or hurt without enough food to heal, eat carried food, cook raw food when possible, withdraw food from known chests, harvest ripe crops or hunt passive animals, then eat.

#### Scenario: No food carried
- **WHEN** the bot is hungry, carries nothing edible and a cow is nearby
- **THEN** it hunts the cow, cooks the beef if it can, and eats

### Requirement: Safe hunting
The hunt action SHALL only target listed passive animals and never players, villagers, pets, named, tamed, leashed or baby animals.

#### Scenario: Named animal
- **WHEN** the only cow nearby has a name tag
- **THEN** hunt fails with "no animal I may hunt"
