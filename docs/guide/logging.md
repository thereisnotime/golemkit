# Logging

Every bot, brain, skill and the fleet log through one system. You can tune what you see per
bot and per subsystem, write files per bot, switch to JSON for tooling, and subscribe to the
log stream from code.

## Logger names

Loggers are hierarchical, `<username>/<component>/...`:

| logger | what |
|---|---|
| `McBuddy` | lifecycle: starting, connecting, spawned, died, disconnected |
| `McBuddy/action` | action start/end with params, caller, duration, result (debug) |
| `McBuddy/action/<name>` | logs written by an action itself (`ctx.log`) |
| `McBuddy/chat` | chat in (`<Steve> hi`), whispers, and what the bot says (`> hello`) |
| `McBuddy/server` | system messages: joins, deaths, advancements (debug) |
| `McBuddy/neoforge` | handshake, channel learning (debug), skipped packets (trace) |
| `McBuddy/<brain>` | brains log under their own name (e.g. `McBuddy/npc`) |
| `fleet` | fleet messages between bots (debug) |
| `mc-buddy` | CLI and process-level messages |

## Levels

`trace` < `debug` < `info` < `warn` < `error`, plus `silent`.

`MC_LOG_LEVEL` takes a **level spec**: a default level plus overrides per logger, comma
separated (the same idea as `RUST_LOG`):

```bash
MC_LOG_LEVEL=info                                  # everything at info
MC_LOG_LEVEL=info,McBuddy=debug                    # one bot in detail
MC_LOG_LEVEL=info,*/neoforge=trace                 # NeoForge internals for all bots
MC_LOG_LEVEL=info,*/chat=warn                      # hide chat lines
MC_LOG_LEVEL=warn,Villager1/npc=debug              # only one NPC's decisions
MC_LOG_LEVEL=debug,*/server=info,*/neoforge=info   # verbose, minus the noisy bits
```

- A pattern matches the logger and all its children (`McBuddy` covers `McBuddy/chat`).
- `*` matches anything, including `/`.
- The most specific (longest) pattern wins.

Shortcuts on the CLI: `-v` (debug), `-q` (warn), `-l <spec>`.

## Formats

| `MC_LOG_FORMAT` | |
|---|---|
| `pretty` (default) | coloured bot names, dimmed components and fields |
| `plain` | no colour; level in capitals; good for journald |
| `json` | one JSON object per line: `time`, `ts`, `level`, `logger`, `msg`, plus fields |

```
23:08:50 McBuddy/action DEBUG end follow ok=true ms=8123 result="stopped following Steve"
{"time":"2026-11-20T23:08:55.971Z","ts":1795216135971,"level":"info","logger":"McBuddy","msg":"spawned at 550 80 51 (overworld, survival)"}
```

`MC_LOG_COLOR=auto|always|never` (`NO_COLOR` is honoured), `MC_LOG_TIME=time|iso|none`.

## Files

```bash
MC_LOG_FILE=logs/mc-buddy.log     # everything in one file
MC_LOG_DIR=logs                   # one file per bot: logs/McBuddy.log, logs/_system.log
MC_LOG_FILE_FORMAT=json           # files in JSON (console stays pretty)
MC_LOG_MAX_SIZE_MB=20             # rotate at this size (0 = never)
MC_LOG_MAX_FILES=5                # keep name.log.1 ... name.log.5
```

Both can be on at once. Level filtering applies to files too.

## In a fleet file

```yaml
logging:
  level: info,*/chat=warn,Villager1=debug
  format: pretty
  dir: logs
  fileFormat: json
  maxSizeMb: 50
```

Precedence: environment → fleet file → CLI flags.

## CLI flags

```bash
just run buddy -v                           # debug
just run buddy -l 'info,McBuddy/action=debug'
just fleet fleet.yaml --log-format json --log-dir logs
```

## From code

```ts
ctx.log.info('found a tree', { at: fmtPos(pos), type: 'oak' })   // in an action
agent.log.child('farming').debug('replanted', { count: 4 })      // McBuddy/farming
const log = agent.log.with({ scene: 'broken_cart' })              // bind fields to every line
if (log.enabled('trace')) log.trace(expensiveDump())

import { recentLogs, subscribeLogs, configureLogging } from '../core/index.ts'
recentLogs({ logger: 'McBuddy', minLevel: 'warn', limit: 50 })   // ring buffer (MC_LOG_BUFFER, default 1000)
const off = subscribeLogs(entry => ws.send(JSON.stringify(entry)))  // live stream, e.g. for a UI
configureLogging({ level: 'info,McBuddy=trace' })                // change at runtime
```

Use fields for data instead of formatting it into the message; they render as `key=value`
in pretty/plain and stay structured in JSON.

## Secrets

Values of environment variables whose names end in `KEY`, `TOKEN`, `SECRET` or `PASSWORD` are
replaced with `***` in every output, console and files.

## Crashes

Uncaught exceptions and unhandled promise rejections are logged with their stack before the
process exits (or, for rejections, continues).
