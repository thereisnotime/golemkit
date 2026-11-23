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

Roughly 80–150 MB RAM per bot, a few percent of one core while walking. A [fleet](/concepts/architecture#fleets-and-multiple-servers) in one
process shares the protocol and block data, so ten bots cost much less than ten processes.
LLM brains add whatever the provider costs; see the [LLM brain](./llm-brain) guide for budgets.
