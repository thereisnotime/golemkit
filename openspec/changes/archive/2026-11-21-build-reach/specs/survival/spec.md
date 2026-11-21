## ADDED Requirements

### Requirement: Climbing out survives a fight
A fight that preempts `goto` while it climbs out SHALL pause the climb, not fail it; when `goto` resumes it SHALL climb again from where the bot is.

#### Scenario: Skeleton in the cave
- **WHEN** the bot is climbing out and a skeleton shoots it
- **THEN** the reflexes don't start a fight and the bot keeps climbing

#### Scenario: Zombie on the bot
- **WHEN** a zombie hits the bot at its level while it climbs
- **THEN** the reflexes fight it, `goto` ends as preempted and climbs again when resumed
