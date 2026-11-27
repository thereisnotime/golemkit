## ADDED Requirements

### Requirement: Materials come from an ordered list of sources
The bot SHALL get what a build, a base project session or `gather_materials` still needs from the
sources in `materials.sources` order (default chests, substitutes, craft, nearby, mine, far), one
at a time, planned again after each, until nothing required is short or the time is up. A source
that gave nothing of an item SHALL be skipped for that item for `materials.retryMinutes`. The
session result, `projects`, `plan_base` and the status view SHALL say which sources were used,
what each gave, and why the others were skipped.

#### Scenario: Cobblestone in the chests, none to dig near home
- **WHEN** a repair needs 9 cobblestone, the bot carries none, its chests hold hundreds and stone near home is ruled out by the keep-out and water
- **THEN** it takes 9 cobblestone from its chests, digs nothing, and the line says chests were used

#### Scenario: Nothing in the chests, digging close by failed
- **WHEN** the chests hold no cobblestone and digging close by gave none a few minutes ago
- **THEN** nearby is skipped with that reason and the bot takes a trip down its own staircase mine for the cobblestone, then digs further out past the keep-out if the mine fell short

#### Scenario: Substitutes the blueprint allows
- **WHEN** the floor stage needs cobblestone and the chests hold only andesite, which the floor role accepts
- **THEN** it takes andesite; for the whole fortress (whose walls don't accept andesite) it does not

### Requirement: Holes in the floor are counted
The survey SHALL count an empty floor cell as still to build even when a block that isn't part of
the plan stands on top of it; only a cell that holds a block is left alone as covered.

#### Scenario: Chest over a gap
- **WHEN** a floor cell is air and a chest stands above it
- **THEN** the floor stage lists that cell as still to build
