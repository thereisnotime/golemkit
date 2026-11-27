## ADDED Requirements

### Requirement: Use any chest
With `storage.anyChest` on, the bot SHALL treat every container it remembers near home as its own chest (take from it, look into it, count its contents for materials and the pantry), still skipping protected areas. Off, only chests it placed and `storage.chests` count.

#### Scenario: someone else's chest with cobblestone
- **WHEN** anyChest is on and a remembered chest it did not place holds 495 cobblestone
- **THEN** the material planner counts that cobblestone and takes from it
