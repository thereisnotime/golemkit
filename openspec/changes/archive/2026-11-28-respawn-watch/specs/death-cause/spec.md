## ADDED Requirements

### Requirement: Respawn when dead
The bot SHALL ask the server to respawn as soon as its health reads 0, including when it logs in already dead, and log it. While still dead it SHALL ask again every `respawn.retrySeconds` (default 5) and after `respawn.maxTries` asks (default 6) end the session so it reconnects. `respawn: false` turns the watcher off.

#### Scenario: logs in dead
- **WHEN** the first health reading after login is 0
- **THEN** it logs `dead at login (health 0), respawning` and sends the respawn request at once

#### Scenario: the request gets no answer
- **WHEN** health still reads 0 five seconds after the last request
- **THEN** it sends another, and after six without coming back it reconnects

#### Scenario: back alive
- **WHEN** health reads above 0 after being 0
- **THEN** it logs `respawned` and the retry count resets
