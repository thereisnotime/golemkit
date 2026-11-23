# configuration Specification

## Purpose
How profiles, fleet files and the environment combine into a running bot's settings: which keys a profile accepts, what happens to keys it doesn't know, where the server comes from in a fleet, and when `.env` is read.

## Requirements

### Requirement: Unknown profile keys are reported
Loading a profile SHALL log a warning naming the file and the dotted key for every key the profile format does not declare, at the top level and in nested blocks (`reflexes`, `server`, `humanize`, `retry`, `worldedit`, `npcMode`, `llm.goals`, ...), and for keys under `settings.combat`, `settings.mining`, `settings.trips` and `settings.inventoryMemory` that are not `combat.*`, `mining.*`, `trips.*` or `inventoryMemory.*` feature toggles (`src/core/toggles.ts`). The profile SHALL still load and the reported keys are dropped (top level and declared blocks) or left unread (settings groups). Other free-form maps (the rest of `settings`, `behaviors`, `llm.budget`) and extra top-level `llm` keys SHALL NOT be reported; blocks that are strict (`askHelp`, `intents`, `journal`, `context`) keep failing on unknown keys.

#### Scenario: Misplaced combat block
- **WHEN** a profile has `combat: { pvp: defend }` at the top level
- **THEN** the profile loads, the block is ignored, and a warning says `unknown key combat` and that combat toggles go under `settings: combat:`

#### Scenario: Typo in a nested key
- **WHEN** a profile has `reflexes: { retreatBelo: 3 }`
- **THEN** a warning names `reflexes.retreatBelo`

#### Scenario: Unknown trips key
- **WHEN** a profile has `settings: { trips: { foodd: 10 } }`
- **THEN** a warning names `settings.trips.foodd` and the trip settings keep their defaults

#### Scenario: Stock profiles
- **WHEN** any `profiles/*.yaml` in the repo is loaded
- **THEN** no unknown-key warning is logged

#### Scenario: Keys the code reads are declared
- **WHEN** a profile sets `settings: { mining: { hostileRadius: 12 } }` or `llm: { goals: { ownerWaitMin: 5 } }`
- **THEN** no warning is logged and the value reaches the code (both are live toggles too)

### Requirement: Unknown fleet keys are reported
Parsing a fleet file SHALL log a warning naming the file and the dotted key (`bots[0].usrname`, `servers.mc.prot`, `defaults.ownres`) for every key the fleet format does not declare, at the top level, in each server entry, in `defaults` and in each bot entry. The fleet SHALL still start without those keys. The free-form `settings` maps SHALL NOT be reported.

#### Scenario: Typo in a bot entry
- **WHEN** a fleet file has `bots: [{ variant: buddy, usrname: B }]`
- **THEN** the fleet starts, the bot gets the default name, and a warning names `bots[0].usrname`

#### Scenario: Stock fleets
- **WHEN** any `fleets/*.yaml` in the repo is parsed
- **THEN** no unknown-key warning is logged

### Requirement: Profile reflexes match the reflexes brain
The profile `reflexes:` block SHALL accept every option the reflexes brain reads from settings: `selfDefense`, `autoEat`, `eatBelow`, `retreatBelow`, `waterFightAbove` and `rangedDefense`, and `reflexes.rangedDefense` SHALL be a live toggle.

#### Scenario: Ranged defence off from a profile
- **WHEN** a profile sets `reflexes: { rangedDefense: false }`
- **THEN** settings.reflexes.rangedDefense is false and the ranged reflex does not run

### Requirement: Settings groups fall back to defaults
`settings.mining`, `settings.trips` and `settings.inventoryMemory` SHALL be read over their defaults (`MINING_DEFAULTS` in `src/skills/minePlan.ts`, `TRIP_DEFAULTS` in `src/core/trip.ts`, `MEMORY_DEFAULTS` in `src/skills/containerPlan.ts`), and a value of the wrong type SHALL fall back to the default instead of failing. `settings.inventoryMemory: true` SHALL mean `{ enabled: true }`. `settings.storage.chests` SHALL accept `[x, y, z]` arrays, `{ x, y, z }` objects and `"x y z"` strings and skip anything else. `settings.combat.pvp` SHALL default to `off`, and any value other than `off`, `defend`, `revenge`, `targets` or `all` SHALL mean `off`.

#### Scenario: Wrong type
- **WHEN** a profile has `settings: { mining: { safeDepth: "deep" } }`
- **THEN** safe mining uses safeDepth 8

### Requirement: askHelp from a profile
The top-level profile key `askHelp` SHALL land in `settings.askHelp`: `true`/`false` set `enabled`. Only `askHelp: true` or `enabled: true` turns asking for help on; an options map without `enabled: true` tunes it but leaves it off (a profile like that gets a warning). The same holds for live toggles: `!config_set askHelp.failures 5` SHALL NOT turn it on. Without the key, asking for help is off.

#### Scenario: Options only
- **WHEN** a profile has `askHelp: { failures: 5 }`
- **THEN** asking for help stays off and a warning says the map has no `enabled: true`

#### Scenario: Options with enabled
- **WHEN** a profile has `askHelp: { enabled: true, failures: 5 }`
- **THEN** asking for help is on and asks after 5 failures of the same kind

#### Scenario: A live sub-key on a bot without askHelp
- **WHEN** an owner sends `!config_set askHelp.failures 5` to a bot whose profile has no `askHelp`
- **THEN** asking for help stays off until `askHelp.enabled` is set to true

### Requirement: Fleet server wins over a profile's server, flags win over both
For a fleet bot, the connection settings SHALL be the environment, then the profile's `server:` block, then the keys the fleet's server entry sets, then `--host`/`--port` on the command line, later winning. A profile only fills keys the fleet leaves out. The command-line flags SHALL win in a fleet as they do with `run`. The startup line per fleet server SHALL show the address each bot really connects to (after profiles and flags).

#### Scenario: Profile pointing elsewhere
- **WHEN** a fleet server sets `host: fleet.example` and the bot's profile sets `server: { host: other.example, platform: paper }`
- **THEN** the bot connects to fleet.example with platform paper

#### Scenario: Command-line host
- **WHEN** the same fleet is started with `--host cli.example`
- **THEN** the bot connects to cli.example with platform paper, and the startup line shows cli.example

### Requirement: .env before the logger
The logger SHALL load `.env` from the working directory before it reads `MC_LOG_*` and collects the secrets to redact, so these apply when Node is started without `--env-file`. Variables already set in the environment SHALL win over `.env`.

#### Scenario: Plain node start
- **WHEN** `.env` sets `MC_LOG_FORMAT=json` and the CLI is started with `node src/cli.ts`
- **THEN** log lines are JSON and secret values from `.env` are redacted
