## ADDED Requirements

### Requirement: Another run by id
With startOver.go, a startOver.run id different from the stored run's SHALL start one more start-over once the earlier one is settled or failed, keeping the first old_base.

#### Scenario: run 2
- **WHEN** run 1 settled and the profile sets run 2
- **THEN** a new start-over begins from the current home

### Requirement: Range by distance walked
After a turn, the start-over range SHALL count the blocks actually walked, and a failed walk to a far settle target SHALL be retried up to 5 times before settling where it stands.

#### Scenario: mountains
- **WHEN** legs in the mountains move 20 blocks each
- **THEN** they use up 20 blocks of range each, not a full leg length
