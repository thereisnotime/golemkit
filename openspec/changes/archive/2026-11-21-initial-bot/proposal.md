## Why

We want a bot that can join the mc02 NeoForge 1.21.1 modpack server and play alongside players, without running a full (headless) Minecraft client. Mineflayer is the most capable protocol-level bot library but only supports vanilla servers.

## What Changes

- Add a NeoForge 21.1 configuration-phase handshake for Mineflayer: channel negotiation, registry/config sync, data map, extensible enum and feature flag acknowledgements.
- Learn the server's required payload channels from its negotiation failures and cache them.
- Keep the connection alive when packets contain modded data that vanilla protocol definitions can't parse.
- Treat unknown (modded) block states as solid.
- Companion behaviour: chat commands (come, follow, goto, guard, attack, status, drop, eat, sleep, collect), self-defence, auto-eat, auto-reconnect.

## Impact

- New repo `thereisnotime/golemkit` (private).
- Depends on mineflayer 4.39, mineflayer-pathfinder, prismarine-nbt.
