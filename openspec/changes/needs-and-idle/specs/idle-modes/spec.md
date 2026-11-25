## ADDED Requirements

### Requirement: Idle modes
`idle.mode` SHALL choose what the bot does when no regular behaviour scores above the idle band and no need search is due: `off` (nothing), `passive` (look around), `idle` (light chores near home that change nothing important: look around, a short stroll, back home when further than `idle.radius`, wait by the bed at night), `active` (the idle chores plus productive ones: tidy storage, top up wood and seeds, extend the farm, craft spares, light dark spots, scout nearby), `explore` (active plus scouting trips out to `idle.exploreRadius` that come home). The default SHALL be `idle`; `idle.mode` SHALL be a live toggle.

#### Scenario: Pax with nothing to do
- **WHEN** Pax (idle mode active) has no behaviour scoring above 15 by day and its wood stock is low
- **THEN** it runs the `idle:top_up_wood` chore instead of standing still

#### Scenario: Off
- **WHEN** idle.mode is off
- **THEN** no idle chore runs

### Requirement: Chore choice
Among the chores of the mode (and the modes below it) that are enabled, inside their time window, past their cooldown and applicable now, the layer SHALL pick the one of the highest mode, then the one that ran least recently. Each chore SHALL take `idle.chores.<name>`: `true`/`false` or `{ enabled, radius, when: day | night | any, hours: [from, to], cooldownMinutes }`, where hours are the game clock (Minecraft: 0 is midnight, 6 sunrise).

#### Scenario: Window
- **WHEN** light_dark_spots has `hours: [8, 16]` and the game clock says 18
- **THEN** light_dark_spots is not picked
