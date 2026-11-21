## ADDED Requirements

### Requirement: WorldEdit detection
The bot SHALL decide whether WorldEdit is available from the `worldedit.enabled` setting, then from WorldEdit channels or registry entries the server announced, then from the reply to a `/we version` probe, SHALL confirm permission with a harmless `//size`, and SHALL report the reason with the answer.

#### Scenario: Server without WorldEdit
- **WHEN** the server announces no WorldEdit channels and answers `/we version` with "Unknown or incomplete command"
- **THEN** `we_status` fails with "WorldEdit not available" and the reason, and other WorldEdit actions refuse without sending commands

#### Scenario: Installed but not permitted (mc02)
- **WHEN** `/we version` answers "WorldEdit version (unknown)" with a Forge-Official 7.3.8 platform line but `//size` answers "Unknown or incomplete command"
- **THEN** `we_status` reports WorldEdit 7.3.8 as installed but not available because the bot has no permission for its commands

#### Scenario: Forced on
- **WHEN** the profile sets `worldedit: true`
- **THEN** WorldEdit counts as available without any probe

### Requirement: Rate-limited commands with parsed replies
WorldEdit commands SHALL be sent through the agent's rate-limited command path and logged, and the result SHALL come from the server's reply.

#### Scenario: Set reports the server's count
- **WHEN** an owner selects a region and runs `we_set stone_bricks` and the server answers "Operation completed (75 blocks affected)."
- **THEN** the action succeeds with "set 75 blocks with stone_bricks"

#### Scenario: No permission
- **WHEN** the server answers "You don't have permission to do this."
- **THEN** the action fails and says the bot lacks permission

#### Scenario: No reply
- **WHEN** nothing comes back within `worldedit.replyMs`
- **THEN** the action fails with "no reply from WorldEdit"

### Requirement: WorldEdit safety
World-changing WorldEdit actions SHALL be for owners only by default, SHALL need a selection made by the bot, SHALL refuse regions over `worldedit.maxBlocks` (default 50000, a live toggle) and regions touching protected areas or the spawn area unless an owner passes `protected_ok`, and `we_raw` SHALL refuse commands not on its whitelist.

#### Scenario: Over the limit
- **WHEN** the selection is 75 blocks and `worldedit.maxBlocks` is 50
- **THEN** `we_set` fails naming the limit and sends nothing

#### Scenario: Not whitelisted
- **WHEN** an owner asks for `we_raw //regen`
- **THEN** it is refused and never sent

### Requirement: Build a library blueprint with WorldEdit
`we_build` SHALL paste a schematic of the blueprint's name from the server's WorldEdit folder when WorldEdit is available and the server has it, and SHALL otherwise build the blueprint normally unless `fallback=false`.

#### Scenario: Schematic on the server
- **WHEN** `//schem list` shows `well.schem` and an owner asks `we_build template=small_house schematic=well`
- **THEN** the bot loads it, checks its size with `//size -c` and pastes it with `//paste -a`

#### Scenario: No schematic
- **WHEN** the server has no schematic of that name
- **THEN** the bot says it can't upload one and builds the blueprint with `build`
