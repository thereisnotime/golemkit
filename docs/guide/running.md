---
scope: core
---

# Running bots and fleets

## One bot

```bash
just run <bot> [flags]
just run buddy --username Helper --owners Robin,friend --dig
```

`<bot>` is a [profile](./profiles) (`profiles/<name>.yaml` or `.yml`) or, if there is none by
that name, a [variant](/concepts/variants-profiles) in `variants/` (`variants/buddy.ts` or `variants/buddy/index.ts`) or a path
to one. Flags override the [profile](/guide/profiles) and the bot definition for this instance:

| flag | meaning |
|---|---|
| `--username`, `-u` | Minecraft username |
| `--owners a,b` | only these players may command it |
| `--dig` | let it break blocks (pathfinding through walls, `collect`) |
| `--host`, `--port` | server, overriding `.env`, the profile's `server:` and (in a fleet) the fleet's server entry |

Logging flags (`-v`, `-q`, `-l`, `--log-format`, `--log-file`, `--log-dir`) are listed in the
[CLI reference](/reference/cli#node-src-cli-ts). `just dev <bot>` restarts the bot when you save a file.

The server comes from `MC_HOST`, `MC_PORT`, `MC_AUTH`, `MC_VERSION` and `MC_PLATFORM`
(defaults `localhost`, `25565`, `offline`, `1.21.1`, `neoforge`), then the profile's `server:`
block, then `--host`/`--port`. `MC_PLATFORM` is `neoforge`, `vanilla` or `paper`; it is not
detected from the server. The NeoForge platform also connects to vanilla servers, it just has
nothing to answer there.

## A fleet

A [fleet](/concepts/architecture#fleets-and-multiple-servers) file runs many bots in one process. `just fleet <name>` runs
`fleets/<name>.yaml` (or `.yml`), or any file path; without a name it runs `fleets/example.yaml`.
For a private fleet, copy `fleets/example.yaml` to `fleet.yaml` (it's gitignored) and run
`just fleet fleet.yaml`.

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
  - variant: buddy
    username: McBuddy
  - variant: buddy
    username: Helper
    count: 3                 # Helper1, Helper2, Helper3
    canDig: true
    settings: { home: [100, 64, -20] }
```

Per-bot keys: `profile` or `variant` (`bot` is the older name for `variant`), `server`,
`username`, `count`, `owners`, `canDig`, `settings`. `defaults` (`server`, `owners`, `canDig`,
`settings`) applies to every entry; the entry's own keys win. With `count` above 1 a `username`
gets a number suffix. A single top-level `server:` block (no `servers:`) also works for
one-server fleets.

Server keys: `host`, `port`, `auth`, `version`, `platform`, `staggerMs`. The top-level
`staggerMs` (default 5000) applies to servers without their own. A top-level `logging:` block
sets [logging](./logging#in-a-fleet-file) for the whole process. Fleet files expand `${VAR}` and
`${VAR:-default}` like [profiles](./profiles#personal-values-from-the-environment). Keys a fleet
file doesn't know are dropped with a warning naming them (`fleets/x.yaml: unknown key
bots[0].usrname (ignored)`), like in a profile.

For a `profile:` entry, the fleet's `owners`, `canDig`, `username` and `settings` override the
profile (`settings.llm` is merged key by key, other settings groups are replaced whole).

The fleet decides where its bots connect, unless the command line says otherwise. For each
connection key, the first of these that sets it wins:

1. `--host` / `--port` on the command line (as with `run`)
2. the fleet's `servers:` entry (or the single `server:` block)
3. the profile's `server:` block, for `profile:` entries (useful for `platform` or `version`)
4. the environment (`MC_HOST`, `MC_PORT`, `MC_AUTH`, `MC_VERSION`, `MC_PLATFORM`) and the defaults

So `--host` sends every bot of the fleet to that host. The startup line per server
(`mc02: mc.example.com:25565: McBuddy, Helper1`) shows the address each bot really connects to,
after profiles and flags.
`--username`, `--owners` and `--dig` only apply to `run`, not to fleets.

## Several servers

List more servers and pick one per bot:

```yaml
servers:
  mc02: { host: mc.example.com }
  creative: { host: localhost, port: 25566, staggerMs: 2000 }
defaults: { server: mc02 }
bots:
  - { variant: buddy, username: McBuddy }
  - { variant: buddy, username: McBuddy, server: creative }
```

Servers start in parallel; logins are staggered per server. Each `host:port` gets its own
learned NeoForge channel cache (`data/channels-<host>-<port>.json`). As soon as a fleet lists
more than one server, every bot's data goes to `data/bots/<server>/<username>` (instead of
`data/bots/<username>`), so the same username on two servers keeps two journals and memories.
Bots only coordinate with bots on the same server.

Only run fleets on servers you own or where the admins agreed to bots. Most public servers
ban them.

## Logs

Each bot logs with its username as a coloured prefix. `-v` shows every action call,
`-l 'info,*/neoforge=trace'` the NeoForge internals. Per-bot files, JSON output and
everything else: see [Logging](./logging).

## Is it working?

`just status` lists every bot with its state (`working`, `busy`, `idle`, `stuck`, `offline`) and
one line on what it does and why; `just status Pax` shows one in detail. In game, `!status` or
"what are you doing" / "why are you idle" answers in chat, and a bot that is stuck for 10 minutes
whispers its owners. See [Status and stuck alerts](./status).

## Stopping

Ctrl-C stops all bots cleanly (storage is flushed). A second Ctrl-C exits immediately.
