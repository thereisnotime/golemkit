## ADDED Requirements

### Requirement: Patrol and defend
With area_guard armed for a place, the bot SHALL patrol it and SHALL attack hostiles inside its bounds.

#### Scenario: Zombie in the village
- **WHEN** a zombie enters the guarded village bounds
- **THEN** the bot attacks it

### Requirement: Light up
The bot SHALL place a light source on walkable dark spots inside the area when it has or can craft torches.

#### Scenario: Dark spot
- **WHEN** a walkable spot inside the area has block light 0
- **THEN** a torch is placed there
