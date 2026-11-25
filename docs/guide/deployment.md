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

Measured with Pax (`profiles/pax.yaml`, Node 26, Mineflayer 4.39, NeoForge 1.21.1 server with
view-distance 10) over an hour by its home:

| what | how much |
|---|---|
| the Node process, idle or running its behaviours | 250–320 MB RSS (plus whatever the OS swapped out), flat over the hour |
| JS heap | 80–100 MB used of 150 MB |
| loaded chunks (Mineflayer's world) | about 40 MB for 453 columns, the biggest single thing on the heap |
| the embeddings intent layer (`intents.layers` with `use: embeddings`) | about 110 MB more RSS from the first chat line it classifies (ONNX model, native memory) |
| an LLM turn with `claude-subscription` | a Claude Code child process for the turn, 220 MB just to start, more with a long context; it exits after the turn |

The process does not grow without bound in normal play; the peaks are LLM turns, because each
one runs a Claude Code process next to the bot. Ways to lower it:

- `settings.world.viewDistance` (live toggle `world.viewDistance`): `short` (8) keeps about 290
  columns instead of 450, `tiny` (6) about 170 (roughly 90 KB each). The bot then sees trees,
  food and mobs less far; searches beyond the loaded area need a trip either way.
- Leave the embeddings layer out of `intents.layers` when patterns and the LLM are enough.
- An API provider (`anthropic`, `openai`) instead of a CLI provider runs no child process.

### Memory log and heap snapshots

`GOLEM_MEMLOG=<seconds>` logs a line per interval: RSS, heap used/total, external and
array-buffer memory, `other` (RSS outside the JS heap: code, native allocations), swap, and the
count and RSS of child processes (`kids`), then one line per bot with loaded chunk columns, the
view distance asked for and the server's, entities, players, listener counts, storage keys and
size, journal buffer and chat queue. Off (no timer) when unset.

```bash
GOLEM_MEMLOG=60 just run pax
# 11:24:03 memlog rss 319M heap 100/155M ext 41M ab 32M other 123M kids 0/0M
# 11:24:03 memlog Pax chunks=453 viewDistance=12 serverViewDistance=10 entities=138 players=1 ...
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
