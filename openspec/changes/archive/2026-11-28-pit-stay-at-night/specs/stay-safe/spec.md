## MODIFIED Requirements

### Requirement: Out of a sealed pit before walking
Before walking, `goto` and `go_home` SHALL climb out when the bot is boxed in (solid on all four sides at feet and head level with a solid block within 3 above) by day. At night they SHALL stay in the pit and fail with the reason instead.

#### Scenario: interrupted bunker
- **WHEN** the bot is at the bottom of its sealed 3-deep bunker by day and stay_safe calls go_home
- **THEN** it digs the lid, climbs out, then walks home

#### Scenario: interrupted bunker at night
- **WHEN** the same happens at night
- **THEN** go_home fails with "sheltered in a sealed pit, staying until morning" and the bot stays put

#### Scenario: a room with a door
- **WHEN** the bot stands in a small room with an open doorway
- **THEN** it walks out normally without digging up
