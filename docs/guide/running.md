# Running bots and fleets

## One bot

```bash
just run <bot> [flags]
just run buddy --username Helper --owners Robin,friend --dig
```

`<bot>` is a file in `variants/` (`variants/buddy.ts` or `variants/buddy/index.ts`) or a path to one.
Flags override the bot definition for this instance:

| flag | meaning |
|---|---|
| `--username`, `-u` | Minecraft username |
| `--owners a,b` | only these players may command it |
| `--dig` | let it break blocks (pathfinding through walls, `collect`) |
| `--host`, `--port` | server, overriding `.env` |

`just dev <bot>` restarts the bot when you save a file.

## A fleet

A [fleet](/concepts/architecture#fleets-and-multiple-servers) file runs many bots in one process. Copy `fleets/example.yaml` to `fleet.yaml` (it's
gitignored) and run `just fleet`.

```yaml
servers:
  mc02:
    host: mc.example.com
    auth: offline
    staggerMs: 5000          # gap between logins on this server
defaults:
  server: mc02
  owners: [Robin]
bots:
  - bot: buddy
    username: McBuddy
  - bot: buddy
    username: Helper
    count: 3                 # Helper1, Helper2, Helper3
    canDig: true
    settings: { home: [100, 64, -20] }
```

Per-bot keys: `bot`, `server`, `username`, `count`, `owners`, `canDig`, `settings`.
`defaults` applies to every entry. A single top-level `server:` block (no `servers:`) also
works for one-server fleets.

## Several servers

List more servers and pick one per bot:

```yaml
servers:
  mc02: { host: mc.example.com }
  creative: { host: localhost, port: 25566, staggerMs: 2000 }
defaults: { server: mc02 }
bots:
  - { bot: buddy, username: McBuddy }
  - { bot: buddy, username: McBuddy, server: creative }
```

Servers start in parallel; logins are staggered per server. Each server gets its own learned
NeoForge channel cache, and when a username runs on more than one server its data goes to
`data/bots/<server>/<username>`. Bots only coordinate with bots on the same server.

Only run fleets on servers you own or where the admins agreed to bots. Most public servers
ban them.

## Logs

Each bot logs with its username as a coloured prefix. `-v` shows every action call,
`-l 'info,*/neoforge=trace'` the NeoForge internals. Per-bot files, JSON output and
everything else: see [Logging](./logging).

## Stopping

Ctrl-C stops all bots cleanly (storage is flushed). A second Ctrl-C exits immediately.
