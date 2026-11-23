# Ask for help when stuck

## Why
A behaviour that keeps failing only backs off longer (60 s doubling to 15 min) and loops for hours. Pax ran keep_tools_upgraded ~80 times on "could not make sticks", chop_wood_loop said "no natural tree within 32 blocks" for hours and stay_safe's go_home hit "No path to the goal" again and again, and nobody heard about it. keep_fed already whispered the owner once an hour when it found no food, on its own rate limit.

## What changes
- A game-agnostic help desk (`src/brains/npc/help.ts`), one per agent, shared by every NPC controller and by behaviours that ask on their own.
- The NPC controller reports every failed run and every success to it. Failures are grouped per behaviour and per normalized reason (numbers, coordinates, bracketed details and later clauses stripped).
- After `failures` failures of one kind spread over at least `minutes` minutes it asks once: whisper the owners online (or public chat with `tell: say`) what it was trying, why it fails, what it tried and what would help. At most once per reason (and one open ask per behaviour) per `perReasonMinutes`, and `maxPerHour` in total; nothing during `quietHours`; nobody online means it tries again on the next failure.
- Behaviours and definitions may give a `goal` and a `help(ctx, failure)` hook; the stock library gets defaults from one table (`src/adapters/minecraft-java/behaviors/help.ts`). A hook returning null means the behaviour reports itself.
- keep_fed's starving report goes through the same desk (shared limits and journal), still on its own `report` switch.
- Every ask and every "works again" is a `help` journal event (`recall_events type=help`/`stuck`). observe shows `askedForHelp` for `observeMinutes`; npc_status lists it.
- The agent emits `askHelp` / `helpSorted`; the LLM brain puts them in its memory, and starts a turn only with `triggers.events.stuck`.
- Optional "sorted, thanks" (`thanks: true`).
- Profile key `askHelp` (true/false or options) and live toggles `askHelp.*`. Off by default; Pax turns it on.
