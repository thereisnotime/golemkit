## ADDED Requirements

### Requirement: Persistent goals
The LLM brain SHALL keep one active goal per bot, with an optional ordered plan, in persistent storage, and SHALL show it near the top of every prompt and in observe().

#### Scenario: Goal survives a restart
- **WHEN** the model sets a goal "build us a house" and the bot restarts
- **THEN** the goal and its plan are loaded from storage and the next turn's prompt shows them under "Your active goal"

#### Scenario: Plan updates
- **WHEN** the model calls update_goal with done=[1]
- **THEN** step 1 is shown as done and the next open step is marked as next

### Requirement: Goal continuation
While a goal is active and nothing else is happening, the runtime SHALL start follow-up turns after an action the brain started ends, after a turn that made progress, after a reconnect, and on an idle check with growing backoff.

#### Scenario: Long action ends
- **WHEN** a goal is active and a long-running action started by the brain finishes
- **THEN** one goal turn starts with the action's result, without anyone talking to the bot

#### Scenario: Short actions
- **WHEN** a goal has three steps and each turn runs one short action
- **THEN** the bot works through all steps in consecutive goal turns and stops once complete_goal is called

### Requirement: Goal guardrails
Continuation SHALL stop when the turn limit or timeout without owner input is reached, when the same failure repeats maxSameFailures times, and when the owner stops it; it SHALL wait while the budget is exhausted or within the reserved share.

#### Scenario: Repeated failure
- **WHEN** the same action fails with the same message three times during a goal
- **THEN** the goal is paused and one turn asks the owner how to proceed instead of retrying

#### Scenario: Owner stop
- **WHEN** the owner runs !stop or !goal_cancel
- **THEN** the goal is abandoned and no further goal turns start

#### Scenario: Owner answers
- **WHEN** a paused goal's owner talks to the bot
- **THEN** the pause is cleared and the turn and time limits start over

### Requirement: Blueprints as data
Structures SHALL be defined in blueprints/*.yaml with roles, a palette and layers, validated on load with errors that name the problem.

#### Scenario: Unknown palette character
- **WHEN** a layer uses a character missing from the palette
- **THEN** loading reports the file, layer and character, and the other blueprints still load

### Requirement: Building structures
The build action SHALL place a whole blueprint on a flat, natural site near the requester, outside protected areas and spawn, in floor-walls-roof-attachments-door order, skipping blocks that are already right, and report the real number of blocks placed.

#### Scenario: Player build in the footprint
- **WHEN** the chosen or given footprint contains player-made blocks
- **THEN** the build refuses and names the block and position

#### Scenario: Resume
- **WHEN** a build is interrupted and build is called again
- **THEN** it uses the same site, skips the blocks already placed and places the rest

#### Scenario: Out of materials
- **WHEN** the bot runs out of planks halfway
- **THEN** the result says how many of the blocks are in place and what it ran out of

### Requirement: Materials and tools
gather_materials SHALL chop trees, craft planks, sticks, tables, doors and wooden tools, and mine simple blocks for a shopping list or a blueprint; chop_tree, collect and break_block SHALL craft the tool they need when the inventory allows.

#### Scenario: Empty inventory to hut materials
- **WHEN** the bot has an empty inventory and runs gather_materials template=hut
- **THEN** it fells trees (crafting a wooden axe once it has wood), crafts the planks and a door, and reports what it has and anything still missing
