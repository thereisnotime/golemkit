## ADDED Requirements

### Requirement: A refused trip step rests
When a keep_fed step fails because the trip check refused to leave ("not ready for a trip"), keep_fed SHALL leave that step alone for 3 minutes.

#### Scenario: too hurt to scout
- **WHEN** the scout step is refused with "not ready for a trip: health 1/20 (needs 6)"
- **THEN** keep_fed does not offer the scout again for 3 minutes
