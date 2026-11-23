# Safe mining and real death causes

## Why
Pax (profiles/pax.yaml) had fresh stone tools, no armour and no torches when keep_tools_upgraded ran `upgrade_tools {up_to: iron, armour: true, prospect: true}`. It saw iron ore in a cave about 60 blocks down, pathed in, fought a creeper and a zombie at 8 health (reflexes.retreatBelow 0), died at 592 10 -60 and lost everything. The LLM brain then said "Pax died again (zombie, ...)": the death event told it only "you died and respawned", the defend reflex had logged "died fighting creeper", and the model guessed.

## What changes
- Safe mining (`settings.mining`, pure planner `src/skills/minePlan.ts`): readiness (weapon, food, gear) before going deeper than `safeDepth`; not ready means surface ore only, no prospecting, a clear "not ready to mine: ..." with `data.need`, and no retry loop. With `gear: shield_or_armour` the first iron ingot becomes a shield.
- The staircase/strip miner caps its depth when not ready, refuses steps that open into a cave pocket or stand on a thin floor over one, places torches (crafting them from coal or charcoal and sticks), and abandons the dig and walks back up when health or hostiles turn underground.
- The reflexes climb out (`climb_out`) underground at `mining.retreatBelow` health or with `mining.retreatHostiles` hostiles close, regardless of reflexes.retreatBelow.
- `mining.*` live toggles; `upgrade_tools safe`, `keep_tools_upgraded safeMining`; unknown `settings.mining` keys warn.
- Death causes: a game-agnostic DeathCauseTracker; the Minecraft adapter feeds it (damage sources, lava/fire/drowning/starvation/fall, the server death message) and emits `deathCause`. Hooks get `{cause}`, `{killer}`, `{deathMessage}`, `{deathDetail}`; the LLM brain's death event carries the facts; observe shows `lastDeath` for 10 minutes. Pax's death-report hook includes the cause.
