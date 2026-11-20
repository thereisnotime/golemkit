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
| `MC_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `NO_COLOR` | | disable coloured log prefixes |

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
