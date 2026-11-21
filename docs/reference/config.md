# Configuration

Precedence, lowest to highest: environment (`.env`) → bot definition → [fleet](/concepts/architecture#fleets-and-multiple-servers) `defaults` →
fleet bot entry / CLI flags.

## Environment

| variable | default | |
|---|---|---|
| `MC_HOST` | `mc.example.com` | server host |
| `MC_PORT` | `25565` | server port |
| `MC_AUTH` | `offline` | `offline` or `microsoft` (device-code login, cached in `.auth/`) |
| `MC_VERSION` | `1.21.1` | protocol version |
| `MC_OWNERS` | (everyone) | comma-separated players allowed to command bots |
| `MC_PREFIX` | `!` | chat command prefix |
| `MC_CAN_DIG` | `false` | let bots break blocks |
| `MC_RECONNECT_DELAY_MS` | `10000` | wait before reconnecting |
| `MC_RETRY_ACTIONS` | `*=0` | action [retries](/guide/profiles#retries), e.g. `*=0,goto=2` ([profiles](../guide/profiles#retries)) |
| `MC_RETRY_LLM` | `2` | retries for transient LLM provider errors |
| `MC_RECONNECT_MAX_MS` | `300000` | reconnect backoff cap |
| `MC_LLM_PROXY` | | `caveman`, `none` or a gateway URL |
| `MC_CAVEMAN_BIN` | auto | path to the [caveman](/guide/profiles#llm-proxy-caveman-or-a-gateway) CLI |
| `MC_MODDED_HOSTILE` | | extra hostile modded mobs, comma-separated globs (`somemod:*_zombie`) |
| `MC_JOURNAL` | `true` | `false` turns the [journal](../guide/journal) off |
| `MC_JOURNAL_TYPES` | all | comma-separated event types to record |
| `MC_JOURNAL_RETENTION_DAYS` | `14` | keep raw [journal](/guide/journal) files this long (rollups much longer) |
| `MC_JOURNAL_SUMMARIZE` | | LLM provider for daily summaries (off when unset) |
| `MC_LOG_LEVEL` | `info` | [level spec](/guide/logging#levels), e.g. `info,McBuddy=debug,*/neoforge=trace` ([logging](../guide/logging)) |
| `MC_LOG_FORMAT` | `pretty` | `pretty`, `plain`, `json` |
| `MC_LOG_COLOR` | `auto` | `auto`, `always`, `never` (`NO_COLOR` also works) |
| `MC_LOG_TIME` | `time` | `time`, `iso`, `none` |
| `MC_LOG_FILE` | | combined log file |
| `MC_LOG_DIR` | | directory for per-bot log files |
| `MC_LOG_FILE_FORMAT` | `plain` | `plain` or `json` inside files |
| `MC_LOG_MAX_SIZE_MB` | `20` | rotate files at this size (0 = never) |
| `MC_LOG_MAX_FILES` | `5` | rotated files to keep |
| `MC_LOG_BUFFER` | `1000` | entries kept in memory (`recentLogs()`) |

## Profile keys

Some of these can also be changed in game without a restart: see [Feature toggles](../guide/live-config).


All optional except `variant`; see [Profiles](../guide/profiles).

| key | what | guide |
|---|---|---|
| `variant` | which variant to run | [Variants, profiles, fleets](../concepts/variants-profiles) |
| `username`, `persona`, `owners`, `canDig`, `server` | identity, permissions, server override | [Profiles](../guide/profiles) |
| `llm` | provider, model, effort, login, token source, proxy, listen, immersive, aliases, budget | [LLM brain](../guide/llm-brain) |
| `context` | [context pack](/guide/context-pack) directory (default `profiles/<name>/`) | [Context pack](../guide/context-pack) |
| `humanize` | reaction/typing delays, stand still while typing, typos, fidgeting | [Profiles](../guide/profiles#humanize-player-like-timing) |
| `reflexes` | eat/retreat/water-fight thresholds | [Movement, protection, combat](../concepts/world#reflexes) |
| `retry` | action, LLM and reconnect retries | [Profiles](../guide/profiles#retries) |
| `journal` | journal on/off, types, retention, summaries | [Journal](../guide/journal) |
| `settings` | free-form values for skills and brains | [Writing a variant](../guide/writing-a-bot) |
| `logging` | level spec, format, files | [Logging](../guide/logging) |

## Files and directories

| path | |
|---|---|
| `.env` | local settings (gitignored), from `.env.example` |
| `variants/` | bot definitions |
| `fleet.yaml` | your fleet (gitignored); `fleets/example.yaml` is the template |
| `data/channels-<host>-<port>.json` | learned NeoForge channels per server |
| `data/protected-<host>-<port>.json` | learned [protected areas](/concepts/world#protected-areas) (spawn, claims) per server |
| `data/registries-<host>-<port>.json` | the server's item / entity / block registries (from the sync) |
| `data/bots/<username>/store.json` | per-bot storage (`agent.storage`) |
| `data/bots/<username>/journal/` | journal: daily JSONL files and `rollups/` |
| `profiles/<name>/` | context pack (AGENTS.md, USER.md, MEMORY.md, skills/, hooks.yaml) |
| `.auth/<login>/` | isolated LLM CLI logins (`just llm-login`) |
| `data/bots/<server>/<username>/` | same, when a username runs on several servers |
| `.auth/` | Microsoft auth token cache |
| `logs/` | log files when `MC_LOG_DIR=logs` (gitignored) |
