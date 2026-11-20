# Configuration

Precedence, lowest to highest: environment (`.env`) → bot definition → fleet `defaults` →
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
| `MC_LOG_LEVEL` | `info` | level spec, e.g. `info,McBuddy=debug,*/neoforge=trace` ([logging](../guide/logging)) |
| `MC_LOG_FORMAT` | `pretty` | `pretty`, `plain`, `json` |
| `MC_LOG_COLOR` | `auto` | `auto`, `always`, `never` (`NO_COLOR` also works) |
| `MC_LOG_TIME` | `time` | `time`, `iso`, `none` |
| `MC_LOG_FILE` | | combined log file |
| `MC_LOG_DIR` | | directory for per-bot log files |
| `MC_LOG_FILE_FORMAT` | `plain` | `plain` or `json` inside files |
| `MC_LOG_MAX_SIZE_MB` | `20` | rotate files at this size (0 = never) |
| `MC_LOG_MAX_FILES` | `5` | rotated files to keep |
| `MC_LOG_BUFFER` | `1000` | entries kept in memory (`recentLogs()`) |

## Files and directories

| path | |
|---|---|
| `.env` | local settings (gitignored), from `.env.example` |
| `bots/` | bot definitions |
| `fleet.yaml` | your fleet (gitignored); `fleet.example.yaml` is the template |
| `data/channels-<host>-<port>.json` | learned NeoForge channels per server |
| `data/bots/<username>/store.json` | per-bot storage (`agent.storage`) |
| `data/bots/<server>/<username>/` | same, when a username runs on several servers |
| `.auth/` | Microsoft auth token cache |
| `logs/` | log files when `MC_LOG_DIR=logs` (gitignored) |
