# survival-bench Specification

## Purpose
A repeatable live measurement of how well a bot survives on its own: a fresh test bot with a real profile's behaviours, left alone far from everything for a number of in-game days, with deaths, food, tools, gathering, failures and travel recorded (`scripts/survival-bench.ts`, pure helpers in `scripts/survival-stats.ts`, `just survival-bench`).

## Requirements

### Requirement: Safe start on a shared server
The benchmark SHALL refuse a start closer than 300 blocks to the world spawn, the fortress or the village, and SHALL refuse it when an online player other than the bench accounts is closer than 300 blocks in the overworld (unless `--force`). It SHALL NOT change the time of day or any gamerule; it SHALL record the in-game time at start and end and run for `--days` x 20 real minutes. The test bot SHALL use its own account and data directory, never a running bot's.

#### Scenario: A player near the start
- **WHEN** a player is online 120 blocks from the chosen start
- **THEN** the run stops before the bot is set up and names the player and distance

### Requirement: Named start scenarios
The benchmark SHALL start at a named scenario's spot, `forest` by default (1818 1318: a forest with natural trees within 32 blocks, grass, water and animals nearby, so runs measure the early game: wood, tools, food, bed), or `ice` (1600 800, the earlier default, with no natural tree within ~137 blocks). `--start x,z` SHALL override the scenario, recorded as `custom`. Every scenario SHALL be 300+ blocks from the world spawn, the fortress and the village, and a new one also from the other test areas. Before setting the bot up, the director SHALL measure the terrain at the start (biome, natural trees within 32, grass blocks within 32, nearest open water, animals in sight) and the result line SHALL carry it as `terrain` and `terrainNote` (`--terrain-note` replaces the note). `--survey` SHALL print the same terrain for candidate spots from a spectating director without changing the world.

#### Scenario: Default start
- **WHEN** the bench runs without `--scenario` or `--start`
- **THEN** the bot starts near 1818 1318 and the result line has `scenario: "forest"` and a terrain note naming the biome and the tree count

### Requirement: Fresh, isolated test bot
Each run SHALL start the bot with a fresh data directory (no remembered places, trees or chests), the chosen profile's behaviours and settings (Pax by default) without an LLM brain unless `--llm`, its owner set to a second test account parked in spectator mode above the start (so help asks reach an online owner and never the real one or public chat), follow_owner and bodyguard off, no configured chests or far food places, no public chat from keep_spawn_bed or idle_antics, and no context pack. Before it runs, the director SHALL clear its inventory, restore full health and food, teleport it to a dry surface near the start, set its spawnpoint and home there, and give the `--kit` (none, stone or iron). The bot SHALL be online without brains while this happens.

#### Scenario: A death during the run
- **WHEN** the bot dies 600 blocks from world spawn
- **THEN** it respawns at the start, not at world spawn, and the death is counted with its cause

### Requirement: Metrics per run
The benchmark SHALL append one JSON line per run to `data/survival-bench/results.jsonl` with: deaths and their causes (the death report, else the journal), seconds alive and time to the first death, food min/mean and seconds at food 0, health min, the best tool tier reached, logs, cobblestone and food items gained (journal item_gained), whether the spawn point was set (a "Respawn point set" message or a spawnpoint other than the start at the end), action failures by caller and action, stuck loops (the same failure, numbers folded, more than `--stuck` times), distance walked, farthest distance from the start, help asks (journal `help` events), whispers and chat lines it sent, players seen near it, the scenario and measured terrain at the start, and the in-game time at start and end. It SHALL print a summary table, and `--compare <tagA> <tagB>` SHALL print a before/after table that calls a difference better or worse only when it is larger than the noise (the larger standard deviation, or 25% of the larger mean with one run a side).

#### Scenario: Compare two tags
- **WHEN** the deaths are 3 and 5 under tag a and 0 and 1 under tag b
- **THEN** the compare table shows a delta of -3.5 deaths and calls it better

### Requirement: Clean-up
After every run, also a failed one, the director SHALL remove the blocks the bot placed, only at the noted positions and only where that same block is still there, kill dropped items and experience at the start, the death spots and those blocks, clear the bot's inventory and effects, put its spawnpoint back to world spawn and disconnect. What could not be cleaned (blocks it broke, placed blocks that changed since, positions the journal counted but the bench did not note) SHALL be reported. A run that broke before its clean-up SHALL leave `pending-cleanup.json`, which `--cleanup` and the next run finish.

#### Scenario: A sapling that grew
- **WHEN** the bot planted a sapling that became a tree before the clean-up
- **THEN** the tree is left in place and reported as changed, not removed
