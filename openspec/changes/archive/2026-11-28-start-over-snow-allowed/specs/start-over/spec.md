## ADDED Requirements

### Requirement: Snow allowed means no snow turns
With startOver.allowSnow on, the start-over SHALL NOT turn because of snowy looks, and the site check SHALL count water and surface ice within 64 blocks.

#### Scenario: snowy taiga
- **WHEN** snow is allowed and the place has grass, trees, animals and ice 50 blocks away
- **THEN** it settles there
