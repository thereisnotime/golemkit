## ADDED Requirements

### Requirement: Redirect a run
A startOver.run id different from the travelling run's SHALL redirect it to startOver.direction with fresh turns and range, keeping its origin.

#### Scenario: west instead
- **WHEN** run 2 is travelling north and the profile sets run 3 with direction w
- **THEN** on start it carries on west from where it is
