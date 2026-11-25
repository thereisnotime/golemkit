# Where Pax's memory goes

## Why
Claude Code's background-shell reaper killed Pax twice while the machine (16 GB, swap heavily used) ran low. We had no numbers: chunk storage, the pathfinder, our own stores, the LLM client or a leak were all candidates.

## What changes
- `GOLEM_MEMLOG=<seconds>` (off by default, no timer when off): a `memlog` line per interval with RSS, heap, external and array-buffer memory, RSS outside the heap, swap, and child process count and RSS, plus one line per agent with cheap counts. `GameAdapter.memStats?()` gives the game's counts (Minecraft Java: loaded chunk columns, view distance asked for and the server's, entities, players, listener counts); `Agent.memStats()` adds storage keys and size, journal buffer, chat queue. Pure helpers in `src/core/memlog.ts`.
- Heap snapshots documented: `NODE_OPTIONS=--heapsnapshot-signal=SIGUSR2`.
- `settings.world.viewDistance` (live toggle `world.viewDistance`): the chunk radius the client asks for, `tiny`/`short`/`normal`/`far` or 2..32, default `far` (Mineflayer's own, so nothing changes unless set). Pure helpers in `src/adapters/minecraft-java/viewDistance.ts`.
- Docs: deployment guide "Memory" with the measured numbers, config reference and live-config rows.

## Findings (one hour of Pax by its home, server view-distance 10, nobody talking to it)
- The Node process stays at 250 to 320 MB RSS plus 60 MB swapped, flat; JS heap 80 to 100 MB used.
- Mineflayer's world is the largest retainer on the heap, about 40 MB for 453 columns.
- The embeddings intent layer adds about 110 MB native memory once loaded.
- Each `claude-subscription` turn runs a Claude Code process of at least 220 MB next to the bot.
- No unbounded growth: heap snapshots at 4, 30 and 60 minutes differ by under 0.5 MB, chunk columns stay at 453, entities 130 to 150, listeners, storage (18 KB) and journal buffer stable.
- `world.viewDistance: short` brought the columns from 453 to 313 in a short live run.
- A heap snapshot leaves the process about 300 MB bigger (native memory not given back), so RSS after one is not comparable.
- The two measured separately (no player talked to Pax): embeddings layer load in a script, Claude Code binary start without credentials.
