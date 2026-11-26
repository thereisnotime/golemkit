## MODIFIED Requirements
### Requirement: Gear search
The gear need's search SHALL run when iron (tools, armour, a bucket or a shield) is missing and the bot has a stone pickaxe or better. By day it SHALL look for iron ore with an open face within `needs.search.radius` and mine it there; when that finds nothing, or is skipped because its mine already reached depth, and a mine trip is due, it SHALL go home, prepare a trip (pantry food, weapon) and run `dig_mine` for the raw iron the chain still needs (3 to 32); then it SHALL go home and run upgrade_tools with keep_tools_upgraded's target. When the surface search turns back for the light (sunset) and night trips may go, it SHALL go on to the mine instead of ending the search. At night it MAY run when `mine.atNight` is on and either a lit mine near home is known, or no mine is known, `mine.startAtNight` is on and the bot carries or can craft at least 8 torches; then it SHALL skip the surface search. A known mine that is not lit SHALL wait for the day.

#### Scenario: Pax on the frozen lake
- **WHEN** the gear need is urgent, it is day and no iron ore with an open face is within 160 blocks
- **THEN** the bot digs its staircase mine near home, comes back up with raw iron, smelts it by home and crafts an iron pickaxe

#### Scenario: First mine at night
- **WHEN** it is night, no mine is known, the gear need is urgent and the bot has 8 torches
- **THEN** the gear search starts a staircase mine near home and lights the stairs as it digs

#### Scenario: Search turned back at sunset
- **WHEN** the surface search for iron turns back because daylight is running out and night trips may go
- **THEN** the bot goes on to its mine near home instead of stopping at home
