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

golemkit plays Minecraft Java today. The [LLM brain](/guide/llm-brain), [plain-language commands](/guide/intents), behaviours, context
packs and the [journal](/guide/journal) don't depend on the game; the [game-adapter split](https://github.com/thereisnotime/golemkit/blob/main/openspec/changes/game-adapters/proposal.md)
puts the game behind an interface so other games can plug in. Phases 0 to 3 are done: Minecraft Java
runs behind the [GameAdapter interface](/concepts/adapters), actions and behaviours declare the
capabilities they need, and a lint rule keeps Minecraft out of the core. Phase 4 adds a second game.

| game | status | how it would connect |
|---|---|---|
| Minecraft Java | <span class="rm now">works today</span> | Mineflayer, a real protocol client, as the `minecraft-java` adapter |
| Minecraft Bedrock | <span class="rm soon">next</span> | `bedrock-protocol` from the same PrismarineJS family; the first candidate for a second adapter |
| Luanti (formerly Minetest) | <span class="rm soon">next</span> | open source with scriptable clients; the other candidate |
| Terraria | <span class="rm idea">idea</span> | through a server plugin API (TShock) |
| Factorio | <span class="rm idea">idea</span> | through its RCON and mod API, less player-like |
| Vintage Story | <span class="rm idea">idea</span> | through its modding API |

Games with anti-cheat and no bot API are out of scope.

## Minecraft servers

| platform | status | notes |
|---|---|---|
| NeoForge 1.21.1 | <span class="rm now">works today</span> | mod channels, [registry sync](/concepts/neoforge#_4-modded-item-and-entity-names) and config tasks handled; tested daily |
| Paper, Spigot, vanilla | <span class="rm try">untested</span> | the NeoForge platform stays idle; `MC_PLATFORM=vanilla` or `paper` skips it |
| Fabric, Quilt | <span class="rm try">untested</span> | fine when no mod needs a client side |
| Other NeoForge versions | <span class="rm try">untested</span> | set `MC_VERSION`; the handshake follows the 1.21.1 wire formats |
| Legacy Forge (FML) | <span class="rm idea">idea</span> | a different handshake, not implemented |

## Features

| feature | status | proposal |
|---|---|---|
| Bodyguard that intercepts mobs, pulls them away and handles creepers safely | <span class="rm now">works today</span> | [guard-intercept](https://github.com/thereisnotime/golemkit/blob/main/openspec/changes/archive/2026-11-23-guard-intercept/proposal.md) (done) |
| Combat techniques: W-tap, sweeps, shield timing, totem, golden apples, water bucket, enderman gaze, chokepoints | <span class="rm now">works today</span> | [combat-techniques spec](https://github.com/thereisnotime/golemkit/blob/main/openspec/specs/combat-techniques/spec.md), [research notes](/concepts/combat-research) |
| One referee for the [reflexes](/concepts/world#reflexes), so they stop taking the body from each other (`reflexPlan.ts`) | <span class="rm now">works today</span> | in the [PvP benchmark](/guide/behaviors#pvp-benchmark-just-pvp-bench) runs |
| PvP modes (`combat.pvp`: off, defend, revenge, targets, all; off by default) with PvP tactics; tested bot-vs-bot only | <span class="rm try">untested</span> | [pvp spec](https://github.com/thereisnotime/golemkit/blob/main/openspec/specs/pvp/spec.md), [bot-vs-bot numbers](/guide/behaviors#pvp-benchmark-just-pvp-bench) |
| Ranged defence (cover, shooting back, backing out of range, getting out of sight under heavy fire) and danger zones | <span class="rm now">works today</span> | [stay-safe spec](https://github.com/thereisnotime/golemkit/blob/main/openspec/specs/stay-safe/spec.md), [heavy fire numbers](/guide/behaviors#benchmark-just-guard-bench) |
| Food ladder: search rings, trips to known food places, seed gathering (surface grass only), a farm that grows to 9x9 | <span class="rm now">works today</span> | [food spec](https://github.com/thereisnotime/golemkit/blob/main/openspec/specs/food/spec.md) |
| Food ladder extras: the pantry (`settings.storage.chests`), no far rings with poor gear (`scoutGear`), the starving hold over chores | <span class="rm try">untested</span> | [food spec](https://github.com/thereisnotime/golemkit/blob/main/openspec/specs/food/spec.md) |
| Wood ladder: remembered trees, rings out to 250 blocks, planks per kind, the sword right after the pickaxe | <span class="rm now">works today</span> | [wood-tools spec](https://github.com/thereisnotime/golemkit/blob/main/openspec/specs/wood-tools/spec.md), [survival benchmark](/guide/behaviors#survival-benchmark-just-survival-bench) |
| Safe mining: gear and food before going deep (`settings.mining`), climbing out when losing underground | <span class="rm try">untested</span> | [safe-mining spec](https://github.com/thereisnotime/golemkit/blob/main/openspec/specs/safe-mining/spec.md) |
| Trips: food and a weapon from the pantry before leaving (`prepare_trip`), turning back on food or daylight (`settings.trips`) | <span class="rm now">works today</span> | [trips spec](https://github.com/thereisnotime/golemkit/blob/main/openspec/specs/trips/spec.md), seen in the [survival benchmark](/guide/behaviors#survival-benchmark-just-survival-bench) |
| Asking the owners for help when a behaviour keeps failing (`askHelp`, the help desk) | <span class="rm now">works today</span> | [ask-help spec](https://github.com/thereisnotime/golemkit/blob/main/openspec/specs/ask-help/spec.md) |
| Going back for its own drops after a death (`recover_drops`, `recover_items`) | <span class="rm now">works today</span> | [death-drops spec](https://github.com/thereisnotime/golemkit/blob/main/openspec/specs/death-drops/spec.md), [live test](/guide/behaviors#death-drops-recover-drops) |
| Death cause reports for hooks and the LLM | <span class="rm now">works today</span> | [death-cause spec](https://github.com/thereisnotime/golemkit/blob/main/openspec/specs/death-cause/spec.md) |
| Container memory: chest contents kept across restarts, changes and broken chests noticed, pantry checks, "where's my iron" | <span class="rm now">works today</span> | [container-memory spec](https://github.com/thereisnotime/golemkit/blob/main/openspec/specs/container-memory/spec.md) |
| Respawn bed at home (`keep_spawn_bed`), asking players to sleep at night | <span class="rm try">untested</span> | [spawn-bed spec](https://github.com/thereisnotime/golemkit/blob/main/openspec/specs/spawn-bed/spec.md) |
| Spawn-proofing: torches around home and own farms (`light_home`, `light_up`) | <span class="rm try">untested</span> | [spawn-proofing spec](https://github.com/thereisnotime/golemkit/blob/main/openspec/specs/spawn-proofing/spec.md) |
| Survival benchmark: a test bot alone for N in-game days, forest and ice scenarios | <span class="rm now">works today</span> | [survival-bench spec](https://github.com/thereisnotime/golemkit/blob/main/openspec/specs/survival-bench/spec.md), [baselines](/guide/behaviors#survival-benchmark-just-survival-bench) |
| [Profile](/guide/profiles) checks: unknown keys logged as warnings, a [fleet](/concepts/architecture#fleets-and-multiple-servers)'s server wins over a profile's | <span class="rm now">works today</span> | [configuration spec](https://github.com/thereisnotime/golemkit/blob/main/openspec/specs/configuration/spec.md) |
| Game adapter interface, capability gating, adapter lint (game-adapters phases 0 to 3) | <span class="rm now">works today</span> | [game-adapters](https://github.com/thereisnotime/golemkit/blob/main/openspec/changes/game-adapters/proposal.md) |
| Bodyguard that lets LLM goals use the body between threats | <span class="rm soon">next</span> | [bodyguard-coexistence](https://github.com/thereisnotime/golemkit/blob/main/openspec/changes/bodyguard-coexistence/proposal.md) |
| Lighter, more realistic guard benchmark (light waves, a tester that fights back) | <span class="rm soon">next</span> | [guard-bench-modes](https://github.com/thereisnotime/golemkit/blob/main/openspec/changes/guard-bench-modes/proposal.md) |
| Job queue ("farm, then wood, then home") | <span class="rm soon">next</span> | [job-queue](https://github.com/thereisnotime/golemkit/blob/main/openspec/changes/job-queue/proposal.md) |
| Daily routine for NPC mode | <span class="rm soon">next</span> | [daily-routine](https://github.com/thereisnotime/golemkit/blob/main/openspec/changes/daily-routine/proposal.md) |
| Guarding an area or village (patrols, lighting, doors; a simple `guard_area` behaviour exists) | <span class="rm soon">next</span> | [area-guard](https://github.com/thereisnotime/golemkit/blob/main/openspec/changes/area-guard/proposal.md) |
| Alerts for unknown players | <span class="rm soon">next</span> | [player-alerts](https://github.com/thereisnotime/golemkit/blob/main/openspec/changes/player-alerts/proposal.md) |
| Hunting and shearing in [bring_item](/guide/search), owner-only drop recovery | <span class="rm soon">next</span> | [search-gaps](https://github.com/thereisnotime/golemkit/blob/main/openspec/changes/search-gaps/proposal.md) |
| Known plain-language misses | <span class="rm soon">next</span> | [intent-parser-gaps](https://github.com/thereisnotime/golemkit/blob/main/openspec/changes/intent-parser-gaps/proposal.md) |
| Staircase towers as an action | <span class="rm soon">next</span> | [stair-tower-action](https://github.com/thereisnotime/golemkit/blob/main/openspec/changes/stair-tower-action/proposal.md) |
| Restart a stopped agent | <span class="rm soon">next</span> | [core-restart-fixes](https://github.com/thereisnotime/golemkit/blob/main/openspec/changes/core-restart-fixes/proposal.md) |
| A second game (game-adapters phase 4) | <span class="rm soon">next</span> | [game-adapters](https://github.com/thereisnotime/golemkit/blob/main/openspec/changes/game-adapters/proposal.md) |
| Mod GUIs, Create contraptions, Ars spells, Curios slots | <span class="rm idea">idea</span> | |
