## ADDED Requirements

### Requirement: Restart after stop
An Agent SHALL be startable again after stop() completes.

#### Scenario: Stop then start
- **WHEN** a script calls stop() and then start() on the same agent
- **THEN** the agent connects again
