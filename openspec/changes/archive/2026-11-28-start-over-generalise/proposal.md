## Why
A review of the start-over work found it tuned to one bot and one world: snow was the goal baked
into the code (a snow counter, `allowSnow`, a fixed snowy penalty), turns ignored the avoid points,
decision rules sat untested in the adapter behaviour, behaviour numbers were literals, settings had
two sources of truth (hand-rolled clamps and the toggle schemas), and the storage clean-up named
other modules' keys and places.

## What Changes
- Site rules: `badBiomes` (name patterns, default snowy and frozen ones), `badCold`, `iceAsWater`
  replace `allowSnow`; the bad-biome penalty and all score weights and caps are settings.
- Turns: `turnAfterRejects` counts rejected looks in a row for any reason (replaces
  `snowTurnAfter`); every turn picks the best untried heading against the avoid points and the old
  base instead of heading+90.
- The step rules move out of the adapter into pure `applyLook`, `applyLeg`, `applyTurn`,
  `applyShelterFail`, `applyLeave`, `settleNext` with tests.
- Behaviour numbers become `startOver.*` settings and toggles; the air reflex's shore search radius
  becomes `reflexes.airShoreRadius`.
- Settings are read through the toggle schemas (`toggleSettings`, one safeParse per key); `avoid`
  gets a schema and a toggle; config.md lists `settings.startOver`.
- Base-anchored storage keys and place names are registered by their modules (`baseAnchored`), plus
  `dropPlaces` / `dropKeys` settings.
- Shared code: one tool/armour tier table, the stash derived from pack value kinds, the leg water
  test next to the navigation water helpers, own builds left out of the build count.
- Fixes: the action description reads minDistance, `home.away` is owned and cleared when no run is
  active, runs refuse or wait outside `startOver.dimensions`.
