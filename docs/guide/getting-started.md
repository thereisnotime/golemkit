---
scope: minecraft
---

# Getting started

## Requirements

- [asdf](https://asdf-vm.com) (or any way to get the versions in `.tool-versions`: Node 26, just)
- A Minecraft Java server. The defaults are `localhost:25565`, offline mode, version 1.21.1;
  put your server in `.env` (`MC_HOST`, `MC_PORT`, `MC_AUTH`, `MC_VERSION`), see below.
  Vanilla and Paper servers work too; the [NeoForge layer](/concepts/neoforge) simply stays idle.

## Install

```bash
git clone git@github.com:thereisnotime/golemkit.git
cd golemkit
asdf install      # node + just
just setup        # npm ci, creates .env from .env.example
```

Dependencies live in `./node_modules`; nothing is installed globally. TypeScript runs directly
on Node (type stripping), so there is no build step.

## Run your first bot

```bash
just run          # variants/buddy.ts, username McBuddy
```

The first connection to a NeoForge server takes a few seconds longer: the bot is rejected a
couple of times while it learns the server's mod channels, then caches them in `data/`.

```
22:39:58 McBuddy starting: 6 skills, 20 actions, brains: command, reflexes
22:39:58 McBuddy connecting to localhost:25565 (offline), 210 known NeoForge channels
22:39:59 McBuddy spawned at 541 53 58 (overworld, survival)
```

In game, say `!help`. Try `!come`, `!follow`, `!guard`, `!pos`. Whispers work without the `!`.
`!help follow` explains one command.

## Point it at another server

```bash
MC_HOST=play.example.net MC_PORT=25565 just run
```

or set them in `.env`. Online-mode servers need `MC_AUTH=microsoft` and a real account; the
first run prints a device-code login link and caches the token in `.auth/`.

## Next

- [Running bots and fleets](./running): several bots, several servers.
- [Writing a bot](./writing-a-bot): your own bot in a dozen lines.
- [Architecture](../concepts/architecture): how actions, skills and brains fit together.
