## ADDED Requirements

### Requirement: Plain-language intent parsing
The parser SHALL turn one chat line into an intent with arguments and a confidence between 0 and 1, without an LLM and without evaluating code, and SHALL return no intent (or a confidence below the threshold) for lines that are not a whole request.

#### Scenario: Simple request
- **WHEN** the owner's line is "get 64 cobblestone"
- **THEN** the intent is collect with item cobblestone and count 64

#### Scenario: Number words and vague amounts
- **WHEN** the line is "get a stack of cobble" or "mine ten iron"
- **THEN** the count is 64 with item cobblestone, or 10 with item iron_ore

#### Scenario: Speaker references
- **WHEN** the speaker Tester says "follow me" or "guard me"
- **THEN** the player argument is Tester

#### Scenario: Chat between players
- **WHEN** the line is "i think we should go home" or "did you follow him?"
- **THEN** no intent reaches the threshold

### Requirement: Addressing
The intents brain SHALL act only on lines from owners that are addressed to the bot: its name or an alias at the start or end, a whisper, any line while the owner is the only other player online, or a follow-up shortly after an intents reply. Lines starting with the command prefix SHALL be left to the command brain.

#### Scenario: Non-owner
- **WHEN** a player who is not an owner says "pax follow me"
- **THEN** nothing happens and nothing is said

#### Scenario: Name in the middle
- **WHEN** an owner says "i think pax is lost" with other players online
- **THEN** the line is ignored

### Requirement: Acting through actions and behaviours
Each intent SHALL run through agent.act() with the speaker as a player caller at player priority, or arm and disarm behaviours through behavior_arm and behavior_disarm, and SHALL reply briefly with the real result.

#### Scenario: Guard me
- **WHEN** an owner says "pax guard me"
- **THEN** the bodyguard behaviour is armed for that owner, or guard_owner when bodyguard is not registered

#### Scenario: Missing action
- **WHEN** an owner says "pax find diamonds" and find_target is not registered
- **THEN** the bot replies that find_target isn't available here yet

#### Scenario: Status without the LLM
- **WHEN** an owner asks "pax what are you doing?"
- **THEN** the reply comes from observe(): current action, position, health, food and armed behaviours

### Requirement: Coexistence with the LLM brain
The setting intents.mode SHALL choose fallback (handle only while the LLM can't think), first (handle confident intents, pass the rest to the LLM) or off, it SHALL be changeable live, and every addressed message SHALL be handled by at most one of the intents brain and the LLM.

#### Scenario: Fallback with the LLM up
- **WHEN** mode is fallback, the LLM is available and an owner says "pax follow me"
- **THEN** the LLM gets the turn and the intents brain does nothing

#### Scenario: Fallback with the LLM down
- **WHEN** mode is fallback, the provider quota is used up and an owner says "pax chop some wood"
- **THEN** the intents brain chops a tree and the LLM runtime records the line without a turn or a pause notice

#### Scenario: First mode
- **WHEN** mode is first and an owner says "pax stop" and then "pax tell me a joke"
- **THEN** the intents brain stops the bot and the LLM answers only the joke

### Requirement: Help
Asking for help SHALL list the understood phrases briefly.

#### Scenario: Help
- **WHEN** an owner says "pax help" or "pax what can you do"
- **THEN** the bot replies with a short list of phrases
