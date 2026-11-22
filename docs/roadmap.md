---
scope: mixed
scopeNote: "Covers the game-agnostic core and the Minecraft and NeoForge work."
---

# Roadmap

What works today, what is being built next and what is only an idea. Every planned item has an
[OpenSpec](https://openspec.dev) proposal with its design and tasks in
[`openspec/changes/`](https://github.com/thereisnotime/golemkit/tree/main/openspec/changes).

<span class="rm now">works today</span> tested live
· <span class="rm try">untested</span> should work, not part of regular testing
· <span class="rm soon">next</span> proposed, with a spec
· <span class="rm idea">idea</span> possible later

## Games

golemkit plays Minecraft Java today. The LLM brain, plain-language commands, behaviours, context
packs and the journal don't depend on the game; the [game-adapter split](https://github.com/thereisnotime/golemkit/blob/main/openspec/changes/game-adapters/proposal.md)
puts the game behind an interface so other games can plug in.

| game | status | how it would connect |
|---|---|---|
| Minecraft Java | <span class="rm now">works today</span> | Mineflayer, a real protocol client |
| Minecraft Bedrock | <span class="rm soon">next</span> | `bedrock-protocol` from the same PrismarineJS family; the first candidate for a second adapter |
| Luanti (formerly Minetest) | <span class="rm soon">next</span> | open source with scriptable clients; the other candidate |
| Terraria | <span class="rm idea">idea</span> | through a server plugin API (TShock) |
| Factorio | <span class="rm idea">idea</span> | through its RCON and mod API, less player-like |
| Vintage Story | <span class="rm idea">idea</span> | through its modding API |

Games with anti-cheat and no bot API are out of scope.

## Minecraft servers

| platform | status | notes |
|---|---|---|
| NeoForge 1.21.1 | <span class="rm now">works today</span> | mod channels, registry sync and config tasks handled; tested daily |
| Paper, Spigot, vanilla | <span class="rm try">untested</span> | the NeoForge layer stays idle |
| Fabric, Quilt | <span class="rm try">untested</span> | fine when no mod needs a client side |
| Other NeoForge versions | <span class="rm try">untested</span> | set `MC_VERSION`; the handshake follows the 1.21.1 wire formats |
| Legacy Forge (FML) | <span class="rm idea">idea</span> | a different handshake, not implemented |

## Features

| feature | status | proposal |
|---|---|---|
| Bodyguard that intercepts mobs, pulls them away and handles creepers safely | <span class="rm soon">next</span> | [guard-intercept](https://github.com/thereisnotime/golemkit/blob/main/openspec/changes/guard-intercept/proposal.md) |
| Bodyguard that lets LLM goals use the body between threats | <span class="rm soon">next</span> | [bodyguard-coexistence](https://github.com/thereisnotime/golemkit/blob/main/openspec/changes/bodyguard-coexistence/proposal.md) |
| Lighter, more realistic guard benchmark | <span class="rm soon">next</span> | [guard-bench-modes](https://github.com/thereisnotime/golemkit/blob/main/openspec/changes/guard-bench-modes/proposal.md) |
| Job queue ("farm, then wood, then home") | <span class="rm soon">next</span> | [job-queue](https://github.com/thereisnotime/golemkit/blob/main/openspec/changes/job-queue/proposal.md) |
| Daily routine for NPC mode | <span class="rm soon">next</span> | [daily-routine](https://github.com/thereisnotime/golemkit/blob/main/openspec/changes/daily-routine/proposal.md) |
| Guarding an area or village | <span class="rm soon">next</span> | [area-guard](https://github.com/thereisnotime/golemkit/blob/main/openspec/changes/area-guard/proposal.md) |
| Alerts for unknown players | <span class="rm soon">next</span> | [player-alerts](https://github.com/thereisnotime/golemkit/blob/main/openspec/changes/player-alerts/proposal.md) |
| Hunting and shearing in bring_item, owner-only drop recovery | <span class="rm soon">next</span> | [search-gaps](https://github.com/thereisnotime/golemkit/blob/main/openspec/changes/search-gaps/proposal.md) |
| Known plain-language misses | <span class="rm soon">next</span> | [intent-parser-gaps](https://github.com/thereisnotime/golemkit/blob/main/openspec/changes/intent-parser-gaps/proposal.md) |
| Staircase towers as an action | <span class="rm soon">next</span> | [stair-tower-action](https://github.com/thereisnotime/golemkit/blob/main/openspec/changes/stair-tower-action/proposal.md) |
| Restart a stopped agent | <span class="rm soon">next</span> | [core-restart-fixes](https://github.com/thereisnotime/golemkit/blob/main/openspec/changes/core-restart-fixes/proposal.md) |
| Other games | <span class="rm soon">next</span> | [game-adapters](https://github.com/thereisnotime/golemkit/blob/main/openspec/changes/game-adapters/proposal.md) |
| Mod GUIs, Create contraptions, Ars spells, Curios slots | <span class="rm idea">idea</span> | |
