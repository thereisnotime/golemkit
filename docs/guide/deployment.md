---
scope: core
---

# Deployment

Bots are long-running Node processes. Any process supervisor works; two tested setups below.

## Podman

The repo ships a `Containerfile` (Node 26 slim, production dependencies only, entrypoint
`node src/cli.ts`). `just image [tag]` builds it.

```bash
podman build -t golemkit .
podman run -d --name golemkit \
  --env-file .env \
  -v ./data:/app/data:Z \
  -v ./fleet.yaml:/app/fleet.yaml:ro,Z \
  golemkit fleet fleet.yaml
```

- `data/` holds learned channels, bot storage and [journals](./journal); mount it so restarts keep them.
- There is no `.env` file in the image; `--env-file .env` passes the same variables, and
  `${VAR}` in profiles and fleet files expands from them.
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
LLM brains add whatever the provider costs; see the LLM guide for budgets.
