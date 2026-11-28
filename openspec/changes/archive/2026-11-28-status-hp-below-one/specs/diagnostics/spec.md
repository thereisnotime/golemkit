## ADDED Requirements

### Requirement: Health below one is not shown as dead
The status summary and `just status` SHALL show health above 0 and below 1 with one decimal (at least 0.1), so only a dead bot reads `hp 0`.

#### Scenario: nearly dead
- **WHEN** health is 0.08
- **THEN** the status shows `hp 0.1`
