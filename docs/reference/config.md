---
scope: mixed
scopeNote: "LLM, logging and storage settings are game-agnostic; MC_* connection settings are Minecraft."
---

# Configuration

Precedence, lowest to highest: environment (`.env`) → [variant](/concepts/variants-profiles) (bot definition) → [profile](/guide/profiles) →
[fleet](/concepts/architecture#fleets-and-multiple-servers) `defaults` → fleet bot entry → CLI flags
(see [Precedence](/concepts/variants-profiles#precedence)). In-game changes to
[feature toggles](../guide/live-config) win over all of these until reset.

Connection settings (`host`, `port`, `auth`, `version`, `platform`) layer differently. With
`run`: environment < the profile's `server:` < `--host`/`--port`. In a fleet: environment < the
profile's `server:` < the fleet's `servers:` entry < `--host`/`--port`, so the fleet decides where
its bots connect, a profile only fills the keys the fleet leaves out, and the command-line flags
win in both.

`.env` in the working directory is loaded on start when it exists (no `--env-file` needed);
copy it from `.env.example`. Profiles, context packs, fleet and [scene](/guide/scenes) files expand `${NAME}` and
`${NAME:-default}` from the environment (see [Profiles](../guide/profiles#personal-values-from-the-environment)).

## Environment

| variable | default | |
|---|---|---|
| `MC_HOST` | `localhost` | server host |
| `MC_PORT` | `25565` | server port |
| `MC_AUTH` | `offline` | `offline` or `microsoft` (device-code login, cached in `.auth/`) |
| `MC_VERSION` | `1.21.1` | protocol version |
| `MC_PLATFORM` | `neoforge` | server platform: `neoforge`, `vanilla` or `paper` (also `server.platform` in a profile); NeoForge also works on vanilla servers |
| `MC_OWNERS` | (everyone) | comma-separated players allowed to command bots |
| `MC_OWNER` | | your Minecraft name, used by the stock profiles as `${MC_OWNER:-Robin}` and by the live test scripts as the player to keep away from |
| `MC_CLAUDE_OAUTH_TOKEN_VAR` | `CLAUDE_CODE_OAUTH_TOKEN` | variable holding the Claude subscription token (every `claude-subscription` bot; the pax and [apprentice](/guide/self-improver) profiles default to it) |
| `MC_CLAUDE_OAUTH_TOKEN_FILE` | `~/.config/golemkit/secrets.env` in pax and apprentice | dotenv file to read only that variable from |
| `MC_PREFIX` | `!` | chat command prefix |
| `MC_CAN_DIG` | `false` | let bots break blocks |
| `MC_RECONNECT_DELAY_MS` | `10000` | wait before reconnecting |
| `MC_RETRY_ACTIONS` | `*=0` | action [retries](/guide/profiles#retries), e.g. `*=0,goto=2` ([profiles](../guide/profiles#retries)) |
| `MC_RETRY_LLM` | `2` | retries for transient LLM provider errors |
| `MC_RECONNECT_MAX_MS` | `300000` | reconnect backoff cap |
| `MC_LLM_PROXY` | | `caveman`, `none` or a gateway URL |
| `MC_CAVEMAN_BIN` | auto | path to the [caveman](/guide/profiles#llm-proxy-caveman-or-a-gateway) CLI |
| `MC_MODDED_HOSTILE` | | extra hostile modded mobs, comma-separated globs (`somemod:*_zombie`); NeoForge platform |
| `MC_JOURNAL` | `true` | `false` turns the [journal](../guide/journal) off |
| `MC_JOURNAL_TYPES` | all | comma-separated event types to record |
| `MC_JOURNAL_RETENTION_DAYS` | `14` | keep raw [journal](/guide/journal) files this long (rollups much longer) |
| `MC_JOURNAL_SUMMARIZE` | | LLM provider for daily summaries (off when unset) |
| `MC_LOG_LEVEL` | `info` | [level spec](/guide/logging#levels), e.g. `info,McBuddy=debug,*/neoforge=trace` ([logging](../guide/logging)); the old `MC_DEBUG=true` still means `debug` |
| `MC_LOG_FORMAT` | `pretty` | `pretty`, `plain`, `json` |
| `MC_LOG_COLOR` | `auto` | `auto`, `always`, `never` (`NO_COLOR` also works) |
| `MC_LOG_TIME` | `time` | `time`, `iso`, `none` |
| `MC_LOG_FILE` | | combined log file |
| `MC_LOG_DIR` | | directory for per-bot log files |
| `MC_LOG_FILE_FORMAT` | `plain` | `plain` or `json` inside files |
| `MC_LOG_MAX_SIZE_MB` | `20` | rotate files at this size (0 = never) |
| `MC_LOG_MAX_FILES` | `5` | rotated files to keep |
| `MC_LOG_BUFFER` | `1000` | entries kept in memory (`recentLogs()`) |

`MC_USERNAME` in `.env.example` is only read by `scripts/probe.ts` and `scripts/skill-test.ts`;
bots take their name from the profile, `--username` or the variant. The LLM variables
(`MC_LLM_*`, `MC_CLAUDE_*`, `MC_CODEX_*`, `MC_OPENCODE_*`, `MC_OPENAI_*`, `ANTHROPIC_API_KEY`,
`CLAUDE_CODE_OAUTH_TOKEN`) are listed in `.env.example` and described in the
[LLM brain](../guide/llm-brain) guide. The login directory variables are `MC_CLAUDE_LOGIN`,
`MC_CODEX_LOGIN` and `MC_OPENCODE_LOGIN`. `MC_CLAUDE_OAUTH_TOKEN_VAR` and
`MC_CLAUDE_OAUTH_TOKEN_FILE` set the subscription token source for every bot that runs
`claude-subscription` (a profile's `llm.oauthTokenVar` / `llm.oauthTokenFile` win over them).

Renamed variables still work under their old names, with a warning once per process (the
warning names the variable, never its value):

| current | old name |
|---|---|
| `MC_CLAUDE_OAUTH_TOKEN_VAR` | `MC_OAUTH_TOKEN_VAR` |
| `MC_CLAUDE_OAUTH_TOKEN_FILE` | `MC_OAUTH_TOKEN_FILE` |
| `MC_CLAUDE_LOGIN` | `MC_CLAUDE_PROFILE` |
| `MC_CODEX_LOGIN` | `MC_CODEX_PROFILE` |
| `MC_OPENCODE_LOGIN` | `MC_OPENCODE_PROFILE` |

## Profile keys

Some of these can also be changed in game without a restart: see [Feature toggles](../guide/live-config).

All optional except `variant`; see [Profiles](../guide/profiles).

| key | what | guide |
|---|---|---|
| `variant` | which variant to run | [Variants, profiles, fleets](../concepts/variants-profiles) |
| `username`, `description`, `persona`, `owners`, `canDig`, `server` | identity, permissions, server override (`host`, `port`, `auth`, `version`, `platform`; in a fleet only for keys the fleet's server leaves out; `--host`/`--port` beat it) | [Profiles](../guide/profiles) |
| `respectBuilds`, `selfAware` | leave player-made blocks alone (default off); show the bot its own setup each turn (default on) | [Feature toggles](../guide/live-config) |
| `npcMode` | behaviours to arm while the LLM is paused, or `false` | [NPC mode](../guide/behaviors#npc-mode-when-the-llm-can-t-think) |
| `askHelp` | `true`/`false` or `{ enabled, failures, minutes, forgetMinutes, perReasonMinutes, maxPerHour, tell, llm, thanks, quietHours, observeMinutes }`; lands in `settings.askHelp`. Default off; an options map turns it on unless it says `enabled: false` | [Asking for help](../guide/behaviors#asking-for-help) |
| `status` | `true`/`false` or `{ file, intervalMs, alert, stuckAlertMs, alertMaxMs }`; lands in `settings.status`. Default on: `status.json` every 5 s, stuck alert after 10 min without progress, repeats back off up to 2 h; `false` turns off file and alert | [Status and stuck alerts](../guide/status) |
| `behaviors` | [armed behaviours](/guide/behaviors) and their options | [Behaviours](../guide/behaviors) |
| `intents` | [plain-language commands](/guide/intents) without the LLM: mode, layers, strategy | [Plain-language commands](../guide/intents) |
| `worldedit` | `true`/`false` or `{ enabled, maxBlocks, ownersOnly, replyMs }` | [WorldEdit](../guide/worldedit) |
| `building` | library, creative, ask | [Blueprint libraries](../guide/blueprints#building-policy) |
| `blueprints` | extra blueprint folders | [Blueprint libraries](../guide/blueprints#libraries) |
| `llm` | provider, model, effort, login, token source, proxy, listen, immersive, aliases, budget | [LLM brain](../guide/llm-brain) |
| `context` | [context pack](/guide/context-pack) directory (default `profiles/<name>/`) | [Context pack](../guide/context-pack) |
| `humanize` | reaction/typing delays, stand still while typing, typos, fidgeting | [Profiles](../guide/profiles#humanize-player-like-timing) |
| `reflexes` | `selfDefense` (on), `autoEat` (on), `eatBelow` (15), `retreatBelow` (8, 0 = never), `waterFightAbove` (14), `rangedDefense` (on), `air` (on), `airBelow` (10); a variant's own reflex defaults sit under the profile's | [Movement, protection, combat](../concepts/world#reflexes) |
| `retry` | action, LLM and reconnect retries | [Profiles](../guide/profiles#retries) |
| `journal` | journal on/off, types, retention, summaries | [Journal](../guide/journal) |
| `settings` | free-form values for skills and brains; the common ones are listed below | [Writing a variant](../guide/writing-a-bot) |
| `logging` | level spec, format, files | [Logging](../guide/logging) |

### Settings the skills read

Each group's keys, ranges and defaults are in the [feature toggles](../guide/live-config#what-can-be-changed)
table; the same keys work in the profile under `settings:` and live with `!config_set`.

| key | what | default |
|---|---|---|
| `settings.combat` | the `combat.*` toggles: mob fight techniques (all on, `maxChase` 16) and [PvP](../concepts/world#pvp) (`pvp: off`, `friends`, `targets`, `revengeMinutes`, `pvpEngage`, ...) | PvP `off` |
| `settings.mining` | the `mining.*` toggles: [safe mining](../guide/progression#safe-mining) readiness depth, weapon, food, gear, climb-out thresholds, torches | `safe: true`, `safeDepth: 8`, `minFood: 3`, `gear: none`, `retreatBelow: 10`, `retreatHostiles: 2` |
| `settings.trips` | the `trips.*` toggles: [trips](../guide/behaviors#trips) top-up and turn-back rules | `enabled: true`, `food: 8`, `minFood: 4`, `minHealth: 12`, `turnBackAt: 0.5` |
| `settings.storage.chests` | chests the bot may take from as its own, as `[x, y, z]`, `{ x, y, z }`, `"x y z"` or `{ at: [x, y, z], role: pantry \| storage \| gear }`; without roles the first is the pantry (food only) and the others storage ([chest roles](/guide/search#chest-roles)) | none |
| `settings.inventoryMemory` | [container memory](../guide/search#container-memory): `true`/`false` or `{ enabled, maxAgeHours, refreshMinutes, indexOwn, radius, lowFood, grumble, grumbleTo, grumbleHours }` | `enabled: false`, `maxAgeHours: 24`, `indexOwn: false` |
| `settings.status` | the `status.*` toggles, same as the top-level `status:` key: [status file and stuck alert](../guide/status#settings) | `file: true`, `intervalMs: 5000`, `alert: true`, `stuckAlertMs: 600000`, `alertMaxMs: 7200000` |
| `settings.pathfinder.thinkTimeoutMs` | planning time per path (ms) | 10000 |
| `settings.road`, `settings.build`, `settings.world.spawnProtection` | [roads](../guide/roads), creative builds, spawn-protection radius | see the toggles |

Unknown keys under `settings.combat`, `settings.mining`, `settings.trips`,
`settings.inventoryMemory` and `settings.status` are ignored with a warning (`profiles/pax.yaml: unknown key
settings.mining.depth (ignored)`), as are unknown top-level keys and unknown keys in the other
declared blocks; see [Profiles](../guide/profiles#format). Other `settings` maps are not checked.

## Files and directories

| path | |
|---|---|
| `.env` | local settings (gitignored), from `.env.example` |
| `variants/` | bot definitions |
| `fleet.yaml` | your fleet (gitignored); `fleets/example.yaml` is the template |
| `data/channels-<host>-<port>.json` | learned NeoForge channels per server (NeoForge platform) |
| `data/protected-<host>-<port>.json` | learned [protected areas](/concepts/world#protected-areas) (spawn, claims) per server |
| `data/registries-<host>-<port>.json` | the server's item / entity / block registries (from the NeoForge [registry sync](/concepts/neoforge#_4-modded-item-and-entity-names)) |
| `data/bots/<username>/store.json` | per-bot storage (`agent.storage`: own chests under `search.ownChests`, container memory under `containers.memory`, in-game toggle changes under `settings.overrides`) |
| `data/bots/<username>/status.json` | the bot's [status](../guide/status) (what it does, why, last progress), rewritten every `status.intervalMs` while it runs; read by `just status` |
| `data/bots/<username>/journal/` | journal: daily JSONL files and `rollups/` |
| `data/bots/<server>/<username>/` | the same per-bot data, when a fleet runs on several servers |
| `data/models/` | cached model for the [intents embeddings layer](../guide/intents) |
| `profiles/<name>/` | context pack (AGENTS.md, USER.md, MEMORY.md, skills/, hooks.yaml) |
| `.auth/<login>/` | isolated LLM CLI logins (`just llm-login`) |
| `.auth/` | Microsoft auth token cache |
| `logs/` | log files when `MC_LOG_DIR=logs` (gitignored) |
