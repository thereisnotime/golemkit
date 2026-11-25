# Memory diet

## Why
One idle bot (Pax) sat at 330 to 350 MB RSS. Measured against a bare Mineflayer bot on a local
vanilla 1.21.1 server, about 90 MB of a quiet Pax process was ours, and the young generation of
the V8 heap added another 45 to 65 MB whenever the bot was busy.

## What changes
- The Anthropic SDK, the Claude Agent SDK and the MCP SDK load on the first turn (or when the MCP
  bridge starts), not at startup. A bot nobody talks to never loads them (about 20 MB).
- The justfile sets `NODE_COMPILE_CACHE` and the image sets it too, so a start reads the
  type-stripped source from the cache and doesn't load Node's TypeScript stripper (about 25 MB);
  `run`/`fleet` flush the cache a minute after start.
- `just run`, `just dev`, `just fleet` and the image start Node with `--max-semi-space-size=8`
  (`GOLEM_NODE_FLAGS` changes or empties it): V8's default lets the young generation grow to
  2 x 32 MB, which a busy bot keeps full.
- `GOLEM_MEMLOG` lines carry the GC count and pause time since the previous line.
- No default changes for `world.viewDistance`: the server caps it at its own view-distance (10
  on vanilla and on mc02), so asking for 10 instead of 12 loads the same 453 columns there.

## Findings
See docs/guide/deployment.md#memory for the table. In short: Node itself is 40 MB, a bare
Mineflayer bot with its 453 chunk columns about 150 MB; minecraft-data loads only the 1.21.1
files (plus older ones 1.21.1 points at), about 6 MB of JSON; no native addon, onnxruntime or
Claude Code binary is mapped in an idle bot. The remaining peaks come from the bot's own work
(pathfinding and scouting keep 100+ MB of short-lived objects for a while) and are not changed here.
