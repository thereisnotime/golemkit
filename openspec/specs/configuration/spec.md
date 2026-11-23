# configuration Specification

## Purpose
How profiles, fleet files and the environment combine into a running bot's settings: which keys a profile accepts, what happens to keys it doesn't know, where the server comes from in a fleet, and when `.env` is read.

## Requirements

### Requirement: Unknown profile keys are reported
Loading a profile SHALL log a warning naming the file and the dotted key for every key the profile format does not declare, at the top level and in nested blocks (`reflexes`, `server`, `humanize`, `npcMode`, `llm.goals`, ...), and for keys under `settings.combat` that are not `combat.*` toggles. The profile SHALL still load. Free-form maps (`settings`, `behaviors`, `llm.budget`) and extra `llm` keys SHALL NOT be reported; blocks that are strict (`intents`, `journal`, `context`) keep failing on unknown keys.

#### Scenario: Misplaced combat block
- **WHEN** a profile has `combat: { pvp: defend }` at the top level
- **THEN** the profile loads, the block is ignored, and a warning says `unknown key combat` and that combat toggles go under `settings: combat:`

#### Scenario: Typo in a nested key
- **WHEN** a profile has `reflexes: { retreatBelo: 3 }`
- **THEN** a warning names `reflexes.retreatBelo`

#### Scenario: Stock profiles
- **WHEN** any `profiles/*.yaml` in the repo is loaded
- **THEN** no unknown-key warning is logged

### Requirement: Profile reflexes match the reflexes brain
The profile `reflexes:` block SHALL accept every option the reflexes brain reads from settings: `selfDefense`, `autoEat`, `eatBelow`, `retreatBelow`, `waterFightAbove` and `rangedDefense`, and `reflexes.rangedDefense` SHALL be a live toggle.

#### Scenario: Ranged defence off from a profile
- **WHEN** a profile sets `reflexes: { rangedDefense: false }`
- **THEN** settings.reflexes.rangedDefense is false and the ranged reflex does not run

### Requirement: Fleet server wins over a profile's server
For a fleet bot, the connection settings SHALL be the environment (and `--host`/`--port`), then the profile's `server:` block, then the keys the fleet's server entry sets, later winning. A profile only fills keys the fleet leaves out.

#### Scenario: Profile pointing elsewhere
- **WHEN** a fleet server sets `host: fleet.example` and the bot's profile sets `server: { host: other.example, platform: paper }`
- **THEN** the bot connects to fleet.example with platform paper

### Requirement: .env before the logger
The logger SHALL load `.env` from the working directory before it reads `MC_LOG_*` and collects the secrets to redact, so these apply when Node is started without `--env-file`. Variables already set in the environment SHALL win over `.env`.

#### Scenario: Plain node start
- **WHEN** `.env` sets `MC_LOG_FORMAT=json` and the CLI is started with `node src/cli.ts`
- **THEN** log lines are JSON and secret values from `.env` are redacted
