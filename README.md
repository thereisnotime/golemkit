# mc-buddy

A companion bot for the **mc02** NeoForge 1.21.1 server (Create, Ars Nouveau, Curios, ...).
It's a real protocol client built on [Mineflayer](https://github.com/PrismarineJS/mineflayer),
not a headless Minecraft, so it starts in a second and uses ~100 MB of RAM.

Mineflayer only speaks vanilla, so this repo adds the parts needed to get into a modded
NeoForge server (see [How it gets in](#how-it-gets-in)).

## Quick start

```bash
asdf install            # node + just from .tool-versions
just setup              # npm ci, creates .env from .env.example
just run
```

Then in game: `!help`.

## Commands

Say them in chat, or whisper the bot without the `!`.

| Command | What it does |
|---|---|
| `!come` | walk to you |
| `!follow [player]` | follow you (or someone else) |
| `!goto <x> <y> <z>` / `!goto <player>` | walk somewhere |
| `!stop` | stop whatever it's doing |
| `!guard` | follow you and kill hostile mobs near you (toggle) |
| `!attack` | fight the nearest hostile mob |
| `!pos` / `!hp` / `!inv` | status |
| `!drop [item\|all]` | throw items at you |
| `!eat` | eat the best food it has |
| `!sleep` | use a bed within 16 blocks |
| `!collect <block> [n]` | mine blocks (needs `MC_CAN_DIG=true`) |
| `!say <text>` | say something |

It also fights back when hit, eats when hungry, respawns, and reconnects when dropped.

## Config

All settings are env vars, see [.env.example](.env.example). The useful ones:

- `MC_OWNERS=robin,friend` limits who can give commands (default: everyone)
- `MC_CAN_DIG=true` lets it break blocks while pathfinding and enables `!collect`
- `MC_AUTH=microsoft` for online-mode servers (device-code login, token cached in `.auth/`)
- `MC_DEBUG=true` logs the handshake and every skipped packet

## How it gets in

1. **Channel negotiation.** NeoForge rejects clients that don't list every payload channel
   its mods require, with the right version and direction. The bot doesn't know them up
   front, so it learns them from the server's rejection message (missing channel, then
   flow, then version) over 3–4 quick reconnects and caches the result in `data/`.
   All channels are offered as optional on both configuration and play, which makes
   NeoForge silently ignore the ones that don't apply.
2. **NeoForge config tasks.** Answers frozen registry sync, config file sync, data map
   negotiation, extensible enum and feature flag checks (`src/neoforge/handshake.js`).
3. **Unparseable packets are dropped.** Item stacks with modded data components can't be
   parsed (components have no length prefix), which normally kills the connection. The
   bot skips those packets instead (`src/neoforge/tolerantParser.js`). Currently that's
   the recipe list, the command tree and occasional item-related packets.
4. **Modded blocks are solid.** Unknown block states are treated as full cubes so the bot
   doesn't fall through Create casings (`src/modded.js`).

## Limitations

- Modded items show as `modded#<id>`; modded blocks are all "modded_block" (full cubes).
- Inventory/equipment packets containing modded items may be skipped, so `!inv` can be
  incomplete.
- No interaction with Create contraptions, Ars spells, Curios slots or mod GUIs.
- When the modpack changes, the bot relearns channels on its own; `just reset-channels`
  forces it.

## Development

```bash
just            # list recipes
just check      # syntax check + unit tests
just probe      # connect once and report how far login gets
just chat-test  # join as a second player and send commands to the running bot
```

Specs live in `openspec/`.
