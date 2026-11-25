---
scope: core
---

# Deployment

Bots are long-running Node processes. Any process supervisor works; two tested setups below.

## Podman

The repo ships a `Containerfile` (`node:26-slim`, `npm ci --omit=dev`, entrypoint
`node src/cli.ts`, default command `run buddy`). `just image [tag]` builds it (tag `golemkit`
by default). The image holds `src/`, `variants/`, `profiles/`, `fleets/`, `blueprints/` and
`scenes/`, with writable `data/`, `.auth/` and `logs/` owned by the `node` user.
`.containerignore` leaves out `.env`, `fleet.yaml`, `data/`, `.auth/`, `logs/`,
`blueprints/downloaded/` and `profiles/*/MEMORY.md`, so a private fleet file or your own
[profiles](/guide/profiles) are not in it; mount them.

```bash
podman build -t golemkit .
podman run -d --name golemkit \
  --userns=keep-id:uid=1000,gid=1000 \
  --env-file .env \
  -v ./data:/app/data:Z \
  -v ./fleet.yaml:/app/fleet.yaml:ro,Z \
  golemkit fleet fleet.yaml
```

- `data/` holds learned channels, bot storage, [journals](./journal) and the intents model
  cache (`data/models/`); mount it so restarts keep them.
- Rootless podman maps your own user to root inside the container, so the image's `node` user
  (uid 1000) can't write to a bind-mounted `data/`. `--userns=keep-id:uid=1000,gid=1000` maps
  your user to `node` instead.
- Profiles that read the Claude token from a file (`oauthTokenFile`, by default
  `~/.config/golemkit/secrets.env` in `pax` and `apprentice`) don't find it in the container
  and fall back to the environment, so put `CLAUDE_CODE_OAUTH_TOKEN` in the env file you pass.
- There is no `.env` file in the image; `--env-file .env` passes the same variables, and
  `${VAR}` in profiles and [fleet files](/guide/running#a-fleet) expands from them.
- For Microsoft auth also mount `.auth/` and run the first login interactively
  (`podman run -it ... run buddy`) to complete the device-code flow.
- The default command is `run buddy`; pass any CLI arguments after the image name.

Stop and clean up:

```bash
podman rm -f -v golemkit
podman rmi golemkit
```

## systemd (user service)

```ini
# ~/.config/systemd/user/golemkit.service
[Unit]
Description=golemkit fleet
After=network-online.target

[Service]
WorkingDirectory=%h/golemkit
ExecStart=/usr/bin/env just fleet fleet.yaml
Restart=on-failure
RestartSec=15

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now golemkit
journalctl --user -u golemkit -f
```

The agent already reconnects after disconnects; `Restart=on-failure` only covers crashes.

## Resource use

A few percent of one core while walking. A [fleet](/concepts/architecture#fleets-and-multiple-servers) in one
process shares the protocol and block data, so ten bots cost much less than ten processes.
LLM brains add whatever the provider costs; see the [LLM brain](./llm-brain) guide for budgets.

## Memory

Measured on a local vanilla 1.21.1 server (rootless podman, view-distance 10, peaceful) with
Node 26.10 and Mineflayer 4.39, one setup at a time, each run 3.5 to 5.5 minutes with
`GOLEM_MEMLOG=30` and swap disabled for the bot process so RSS is real. The bot keeps 453 chunk
columns in every run (about 30 MB of array buffers). "Pax copy" is `profiles/pax.yaml` under
another name with its LLM provider left without credentials (configured, never called), so
its behaviours run but no turn does. MB, settled values after the first couple of minutes;
"busy" is a run where the bot went scouting for iron (`keep_tools_upgraded` → `find_target`).

| setup | RSS | heap used/total | other | notes |
|---|---|---|---|---|
| `node -e` (nothing loaded) | 40 | 4/5 | 31 | 33 MB of it is the `node` binary itself |
| bare Mineflayer bot | 148–152 | 44/48 | 66–72 | no golemkit; pathfinder loaded but idle makes no difference |
| bare Mineflayer + pathfinder, walking a route and scanning blocks | 226–257 | 50/115 | 75–110 | same with `--max-semi-space-size=8`: 193–211 (50/68), `=4`: 160–187 |
| golemkit, minimal variant (commands + reflexes, 48 actions), before | 235–237 | 82/87 | 110 | 300 for the first two minutes (heap total 150) |
| the same, after | 187–192 | 60–68/80 | 74–80 | 201–203 without the V8 flag (266 for the first two minutes) |
| Pax copy, quiet, before | 243–251 | 85/91 | 118 | 311 for the first two minutes |
| Pax copy, quiet, after | 195–209 | 62–73/72–85 | 91–96 | 205–214 without the V8 flag, 278 in its first minutes |
| Pax copy, busy, before | 298–361 | 82–111/153–161 | 104–152 | |
| Pax copy, busy, after | 225–281 | 63–97/89–115 | 77–151 | 336 at the peak of a scout (heap 112/129, `other` 175) |
| fleet of 2 Pax copies in one process, busy, before | 367–513 | 98–193/143–237 | 95–230 | both bots working most of the run |
| fleet of 2 Pax copies in one process, after | 238–262 | 81–89/91–106 | 82–96 | |
| 2 Pax copies as 2 processes, after | 229 + 318 | | | one quiet, one busy |
| live Pax on mc02 (NeoForge), before, for comparison | 332–353 | 92/155 | 136 | busy most of the time (about 20% of a core) |

"After" is this repo as it is now, started the way `just run` and the container image start it: the LLM SDKs load on
the first turn instead of at startup, the compile cache keeps Node's TypeScript stripper out of
the process, and `--max-semi-space-size=8` caps V8's young generation. Where the memory went:

- **Node and Mineflayer: about 150 MB.** That is the floor for one bot: the `node` binary (35–50
  MB of it is file-backed and shared), Mineflayer, node-minecraft-protocol's generated packet
  code and the 1.21.1 registry (minecraft-data loads only that version's files, about 6 MB of
  JSON), and the chunk columns. No native addon, onnxruntime or Claude Code binary is mapped into
  an idle bot (checked in `/proc/<pid>/smaps`).
- **golemkit itself: 45 to 60 MB on top**, about 20 MB of it heap (source text, action schemas,
  brains), the rest code and native memory. It was 90 to 100 MB. Importing the companion
  variant alone took 195 MB RSS before (heap 51 MB used) and takes 125 MB now (heap 31 MB): the
  Claude Agent SDK, the Anthropic SDK and the MCP SDK (with ajv) were about 40 MB of that, Node's
  TypeScript stripper (a wasm module) about 28 MB. In a running bot the difference is smaller,
  35 to 40 MB, because V8 then sizes its heap by what is live.
- **V8's young generation: 45 to 65 MB while busy.** By default V8 lets it grow to 2 x 32 MB, and
  a bot that pathfinds or scans blocks keeps it full. 8 MB semi-spaces give most of that back;
  the cost is more, shorter GCs. In the walking test GC pauses added up to 1.6% of one core
  instead of 0.5% (4 MB: 2.7%); for Pax under 0.2% when quiet either way and up to 1.3% while
  scouting instead of 0.6% (4 MB: 2.8%). `GOLEM_MEMLOG` shows the GC count and time per line. `GOLEM_NODE_FLAGS=""` goes back to V8's
  defaults.
- **Work peaks: up to 100+ MB, for a while.** Scouting and long paths keep 100+ MB of
  short-lived objects (heap used goes from about 65 to 110–140 MB) and glibc's malloc does not
  give the native part back afterwards: in the busy runs `other` stayed 30–80 MB higher after a
  scout. With jemalloc (`LD_PRELOAD=/usr/lib64/libjemalloc.so.2 just run pax`, one busy run)
  the process went back to 190–198 MB after the same kind of scout; it is not the default
  because it depends on the system library.
- **A second bot costs about 40 to 50 MB in a fleet** (its own chunk store, about 30 MB, plus
  its brains and state) **and about 200 MB or more as a separate process**, so put bots that
  share a machine in one fleet.

`settings.world.viewDistance` keeps its default (`far`, 12): the server caps it at its own
view-distance (10 on vanilla and on mc02), so asking for 10 loads the same 453 columns there;
on a server with a larger view-distance the bot sees further, which searches and scouting use.

Other things that add memory, measured separately:

| what | how much |
|---|---|
| the embeddings intent layer (`intents.layers` with `use: embeddings`) | about 110 MB more RSS from the first chat line it classifies (ONNX model, native memory) |
| an LLM turn with `claude-subscription` | a Claude Code child process for the turn, 220 MB just to start, more with a long context; it exits after the turn; the Agent SDK then stays loaded in the bot (about 20 MB) |

Ways to lower it further:

- `settings.world.viewDistance` (live toggle `world.viewDistance`): `short` (8) keeps about 310
  columns instead of 450 (measured with Pax), `tiny` (6) about 170 (roughly 70–90 KB each). The bot then sees trees,
  food and mobs less far; searches beyond the loaded area need a trip either way.
- Run several bots as one fleet (`just fleet`) instead of one process each.
- Leave the embeddings layer out of `intents.layers` when patterns and the LLM are enough.
- An API provider (`anthropic`, `openai`) instead of a CLI provider runs no child process.
- `GOLEM_NODE_FLAGS=--max-semi-space-size=4` saves another 20–30 MB while busy for about twice
  the GC time.

### Memory log and heap snapshots

`GOLEM_MEMLOG=<seconds>` logs a line per interval: RSS, heap used/total, external and
array-buffer memory, `other` (RSS outside the JS heap: code, native allocations), swap, the
count and RSS of child processes (`kids`) and the garbage collections since the last line with
their pause time (`gc`), then one line per bot with loaded chunk columns, the view distance
asked for and the server's, entities, players, listener counts, storage keys and size, journal
buffer and chat queue. Off (no timer) when unset.

```bash
GOLEM_MEMLOG=60 just run pax
# 15:31:07 memlog rss 189M heap 62/81M ext 34M ab 31M other 74M kids 0/0M gc 13/3ms
# 15:31:07 memlog Pax chunks=453 viewDistance=12 serverViewDistance=10 entities=138 players=1 ...
```

Heap snapshots on a signal, written to `--diagnostic-dir` (default: the working directory):

```bash
NODE_OPTIONS="--heapsnapshot-signal=SIGUSR2 --diagnostic-dir=/tmp/snaps" just run pax
kill -USR2 <pid>   # the node process: GOLEM_MEMLOG logs it ("memlog every 60s (pid 12345)")
```

Send the signal to the `node` process itself, not to `just` or its shell: those exit on it.

Open the `.heapsnapshot` in Chrome DevTools (Memory tab) and compare two of them. Taking one
pauses the bot for a few seconds and leaves the process a couple of hundred MB bigger
afterwards (the snapshot's native memory is not given back to the OS), so restart before
reading RSS again.
