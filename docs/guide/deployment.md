# Deployment

Bots are long-running Node processes. Any process supervisor works; two tested setups below.

## Podman

The repo ships a `Containerfile`.

```bash
podman build -t mc-buddy .
podman run -d --name mc-buddy \
  --env-file .env \
  -v ./data:/app/data:Z \
  -v ./fleet.yaml:/app/fleet.yaml:ro,Z \
  mc-buddy fleet fleet.yaml
```

- `data/` holds learned channels and bot storage; mount it so restarts keep them.
- For Microsoft auth also mount `.auth/` and run the first login interactively
  (`podman run -it ... run buddy`) to complete the device-code flow.
- The default command is `run buddy`; pass any CLI arguments after the image name.

Stop and clean up:

```bash
podman rm -f -v mc-buddy
podman rmi mc-buddy
```

## systemd (user service)

```ini
# ~/.config/systemd/user/mc-buddy.service
[Unit]
Description=mc-buddy fleet
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
systemctl --user enable --now mc-buddy
journalctl --user -u mc-buddy -f
```

The agent already reconnects after disconnects; `Restart=on-failure` only covers crashes.

## Resource use

Roughly 80–150 MB RAM per bot, a few percent of one core while walking. A fleet in one
process shares the protocol and block data, so ten bots cost much less than ten processes.
LLM brains add whatever the provider costs; see the LLM guide for budgets.
