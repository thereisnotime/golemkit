## ADDED Requirements

### Requirement: Queued jobs run in order
The bot SHALL run queued jobs one after another, each until its end condition, and SHALL report each completion or failure to the owner who queued it.

#### Scenario: Two jobs
- **WHEN** an owner queues "chop 16 logs" then "go home"
- **THEN** the bot chops until it has 16 logs, says so, then walks home

#### Scenario: Owner command in between
- **WHEN** an owner says "come here" while a job runs
- **THEN** the bot comes, then resumes the queue

### Requirement: Queue survives restarts
The job queue SHALL persist across restarts.

#### Scenario: Restart
- **WHEN** the bot restarts with two jobs queued
- **THEN** it continues with the first unfinished job
