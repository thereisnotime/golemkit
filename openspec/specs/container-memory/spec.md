# container-memory Specification

## Purpose
What the bot saw inside chests, barrels and shulker boxes, kept across restarts and kept right while players change things (`src/skills/containerPlan.ts` for the pure parts, wired in `src/skills/containers.ts` and the `check_storage` behaviour in `behaviors/storage.ts`). Settings live in `settings.inventoryMemory` and the `inventoryMemory.*` live toggles; docs in `docs/guide/search.md#container-memory`.

## Requirements

### Requirement: Feature flag
Container memory SHALL be off unless `settings.inventoryMemory.enabled` is true (`inventoryMemory: true` turns it on with the defaults). Off, the bot SHALL keep what it saw in memory only, record no container events and not grumble. The keys `enabled`, `maxAgeHours` (24), `refreshMinutes` (60), `indexOwn` (false), `radius` (48), `lowFood` (8), `grumble` (false), `grumbleTo` (owners) and `grumbleHours` (3) SHALL be live toggles, and an unknown key under `settings.inventoryMemory` SHALL be warned about when the profile loads.

#### Scenario: Framework default
- **WHEN** a profile has no `settings.inventoryMemory`
- **THEN** chest contents are remembered for the session only and nothing is journalled or said about them

### Requirement: Persistence
With memory on, every container the bot opens SHALL be stored in agent storage per server and dimension as position -> block, contents, `at` (contents seen) and `verifiedAt` (block seen in place). A double chest SHALL be one entry, keyed by its lower half and found by either half. Entries SHALL be bounded (256 per scope, 64 without contents), the least recently seen dropped first.

#### Scenario: Restart
- **WHEN** Pax looked into its pantry (18 bread) and restarts
- **THEN** `knownContainers()` still lists the pantry with its bread and age, and keep_fed and trip preparation use it

### Requirement: Facts and hints
An entry whose contents were seen within `maxAgeHours` (now minus `at`, default 24; the same rule applies with memory off) and that is not in doubt SHALL be a fact (`fresh`); an older one, or one in doubt (half of a double chest broken, a second half added), SHALL be a hint: it MAY choose which chest to try first but SHALL be re-checked on the spot before anything relies on it. An old entry without the wanted item SHALL NOT rule the chest out. The pre-trip pantry count (`prepare_trip`) and the pantry-low check SHALL count only fresh entries as food. `knownContainers()` SHALL expose `ageMs` and `freshness`.

#### Scenario: Old sighting
- **WHEN** the pantry was seen with 20 bread 30 hours ago and a trip needs food
- **THEN** the pantry counts as worth a look, the bot opens it and takes what is really there

### Requirement: Changes by players
When the bot opens a container it SHALL overwrite the entry with what is there. With memory on, a difference from a non-doubtful entry SHALL be journalled as `container_changed` with what is gone and added and since when. A remembered container found gone or another block, on arrival or by a block update or chunk load in view, SHALL be dropped and journalled as `container_gone` with what it last held, without walking there; one half of a double chest broken SHALL keep the other half in doubt. A container not looked into, placed in view or within 6 blocks of where a remembered one was, SHALL be remembered without contents and SHALL NOT be opened unless it is the bot's own or configured. The bot's own chest that is gone SHALL no longer count as its own.

#### Scenario: Bread taken
- **WHEN** the pantry held 18 bread 2 hours ago and now holds 6
- **THEN** the next look journals "pantry at 559 69 -47: 12 bread gone since 2 h ago"

#### Scenario: Chest moved
- **WHEN** a player breaks the pantry while the bot can see it and puts a chest 2 blocks over
- **THEN** the entry goes, `container_gone` names the new chest in `movedTo`, and the new chest is remembered with unknown contents

### Requirement: Grumbling
With `grumble` on, when its own or a configured chest is emptied, raided, moved or broken the bot SHALL say one short, mild line in character (no profanity), at most once per chest every `grumbleHours` and once every 10 minutes overall, by whisper to the owners online (nothing when none is) or in public chat with `grumbleTo: say`, through the agent's rate-limited chat. Items added SHALL NOT cause a grumble.

#### Scenario: Raided pantry
- **WHEN** Pax finds 12 bread gone from its pantry and Robin is online
- **THEN** it whispers Robin something like "who took my bread?!" once

### Requirement: Periodic check
With `indexOwn` on, the `check_storage` behaviour SHALL, by day and near home, look into its own and configured chests within `radius` of home not seen inside for `refreshMinutes` (`check_chests`, up to `max` per run), with a score below food, safety, tools and lighting; a chest it tried SHALL wait `refreshMinutes` whatever happened. When the food in the pantry (its own and configured chests within `radius` of home, the same set the pre-trip top-up uses) is below `lowFood` items it SHALL tell the owners through the help desk, at most every 6 hours unless the pantry ran out since.

#### Scenario: Pantry low
- **WHEN** it is day, the pantry was last checked 2 hours ago and holds 6 bread
- **THEN** check_storage opens it and whispers the owners "pantry low: 6 bread left"

### Requirement: Where is X
`where_stored` SHALL answer from memory with position and age ("12 iron_ingot in the chest at 559 69 -47, seen 2 h ago"), exact names first, fresh before old, old ones marked as maybe changed. "where is my X" in plain language SHALL route to it, and when the item is in its own or a configured chest the plain-language answer SHALL say that "bring me X" fetches it.

#### Scenario: Where's my iron
- **WHEN** Robin says "pax where's my iron" and the bot saw 12 iron ingots in its chest 2 hours ago
- **THEN** it answers "12 iron_ingot in the chest at 559 69 -47, seen 2 h ago (say "bring me iron" and I fetch it)"
