## Settings: one source of truth
The `startOver.*` toggles in `core/toggles.ts` hold every key's zod schema, range and description.
`toggleSettings(group, raw, defaults)` walks the toggles of a group (nested keys too) and runs one
safeParse per key, so a bad value keeps its default and the rest still apply. `startOverSettings`
is that call plus the two cross-key rules (maxDistance beyond minDistance + 64, avoid radius
default). A unit test checks the defaults and the toggles name the same keys.

## Pure step rules
`startOverStep` decides what to do; the `apply*` functions say what the state looks like after it
happened (a look, a leg, a turn, a failed bunker, leaving). The adapter behaviour only reads the
world, runs actions and saves what these return.

## Turning
A turn (range used up, an ocean ahead, rejects in a row) asks `turnHeading`: the 8 compass headings
minus the ones already tried (`tried` in the state) and, at an ocean, the wet ones, scored with
`chooseHeading` against the avoid points plus the old base (radius minDistance). Old states without
`tried` count their current heading as tried.

## Base-anchored state
`core/baseAnchored.ts` is a small registry: modules that keep storage tied to the base they work
around (projects, farms, the spawn bed, ring searches, lighting) register their keys and place-name
patterns at import. `abandonedState` takes the lists as arguments, so it stays pure.

## home.away
`setHomeAway(agent, by)` stores who owns it; owners register a check (`registerHomeAway`). Reading
it runs the check and clears a stale flag, so a finished, cancelled or deleted run can't leave the
bot homeless.
