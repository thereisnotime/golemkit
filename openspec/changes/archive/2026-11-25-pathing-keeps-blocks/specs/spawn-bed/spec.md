## ADDED Requirements

### Requirement: Paths never break the bot's base blocks
When digging is allowed, the pathfinder SHALL NOT break beds, storage, workstations, doors,
trapdoors, fence gates, signs, banners, torches, lanterns, glass or farmland to get somewhere;
it SHALL route around them. Explicit dig actions are not affected.

#### Scenario: Walking home past the respawn bed
- **WHEN** the bot paths to its home point and its respawn bed lies on the shortest route
- **THEN** it walks around the bed and the respawn point stays set
