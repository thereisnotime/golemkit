## ADDED Requirements

### Requirement: Yield to LLM goals
With `yieldToLlm` set, the bodyguard SHALL let an LLM goal hold the body while no threat to the player is in range, and SHALL take it back within one tick when a threat appears.

#### Scenario: Quiet escort
- **WHEN** the bodyguard is armed with yieldToLlm and an owner goal is active with no hostiles near
- **THEN** the goal turn runs and the bot stays within range of the player

#### Scenario: Threat appears
- **WHEN** a zombie comes within range of the player during a goal turn
- **THEN** the bodyguard preempts the goal action

### Requirement: Player gone
When the protected player goes offline, the bot SHALL follow the `whenGone` option, also at night.

#### Scenario: whenGone stay at night
- **WHEN** the player logs off at night with whenGone stay
- **THEN** the bot stays at the last position instead of going home
