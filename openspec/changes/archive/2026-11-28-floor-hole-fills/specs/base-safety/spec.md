## MODIFIED Requirements

### Requirement: Holes in the floor surface are fixed
With `baseSafety.floorHoles` on (default), the scan SHALL also report every open block at floor
level in a column inside the walls that is not part of a cavity, a farm's water, a known mine's
stairs or a cell holding something placed on purpose that is not a full block (crops, a sapling,
a rail, a sign, a button), with the open blocks below it down to the first solid one (at most
`depth`). The integrity project SHALL fill a hole that sits on solid ground bottom up, and SHALL
only plug the floor block of a hole that opens into a cave, goes deeper than `depth` or ends on a
block that isn't solid. With `baseSafety.clearFixtures` on (default) a torch or flower in a cell
to fill SHALL be broken first; off, such a floor cell SHALL not count as a hole. A fill step
SHALL be dropped when its cell holds a full block or something placed on purpose. The floor block
SHALL go in as floor stone when the bot carries or stores some, else as any filler it carries
(other stone, dirt, planks, logs last); a hole in the farm plot kept inside the walls SHALL get
dirt first. A block with nothing to place against yet SHALL get a second try at the end of the
session.

#### Scenario: A hole open to the sky
- **WHEN** a floor block inside the walls is missing and the one below it too, both lit by the sky
- **THEN** `check_base` reports a hole in the floor two blocks deep and `secure_base` fills both

#### Scenario: Farm plot
- **WHEN** a cell of the reserved farm plot is empty
- **THEN** it is filled with dirt, not stone

#### Scenario: A torch in the hole
- **WHEN** a one-block hole in the floor holds a torch standing on its bottom
- **THEN** the torch is broken and the hole filled, instead of failing with "torch is already there" every session

#### Scenario: A hole over a cave
- **WHEN** a hole in the floor runs down into a dark cave under the base
- **THEN** only its floor block is plugged, against the floor around it, and the cave below is left to the cavity fixes

#### Scenario: Crops at floor level
- **WHEN** a floor cell inside the walls holds wheat or a rail
- **THEN** it is not reported as a hole and no fill step targets it

#### Scenario: Out of cobblestone
- **WHEN** the bot carries spruce logs and dirt but no stone, and its chests hold no cobblestone
- **THEN** the floor block goes in as dirt rather than waiting for cobblestone
