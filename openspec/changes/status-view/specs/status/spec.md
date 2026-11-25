## ADDED Requirements

### Requirement: Status snapshot
Every agent SHALL keep a status snapshot with: connected or not; the action holding the body with its caller, priority and start time; for each registered decision loop the running behaviour, its score and priority, or why nothing runs (suspended, body held by another caller, backing off, behaviours cooling down after failures with the failure, a score waiting to start, every score at 0); the time and kind of the last progress; health, food, position and dimension from the game adapter; the last failure; and the need and goal when a loop reports them. The status code SHALL be game-agnostic: it SHALL read the game adapter, agent events and decision-loop snapshots only.

#### Scenario: Idle with failing behaviour
- **WHEN** nothing runs and chop_wood_loop is cooling down after failing "no natural tree within 32 blocks"
- **THEN** the status says why it is idle: chop_wood_loop cooling with the time left, after failing, with that message

### Requirement: Progress
The status SHALL count as progress an exclusive, non-internal action that ended ok, a behaviour run that succeeded, more inventory items than at the previous sample, being at least 16 blocks from where it last made progress, and a decision loop's own last progress time. Failures that only mean another caller took the body (busy, preempted, replaced, stopped) SHALL not count as failures. A new session SHALL reset the baseline so time disconnected does not count.

#### Scenario: Items
- **WHEN** the inventory holds 3 more items than at the last sample
- **THEN** the last progress is now, "+3 items"

### Requirement: States
The status SHALL be `offline` when not connected, `busy` while a long-running action (follow, guard) holds the body, `working` while something runs or progress is recent, `stuck` when there has been no progress for `stuckAlertMs` and it wants to do something (an action or behaviour runs, a behaviour cools down after failures, a need or goal is set, or a failure happened since the last progress), and `idle` otherwise.

#### Scenario: Follow is not stuck
- **WHEN** an owner's follow has held the body for 40 minutes without other progress
- **THEN** the state is busy and no alert is sent

### Requirement: Status file and CLI
With `settings.status.file` on (default), the agent SHALL rewrite `<dataDir>/status.json` atomically every `intervalMs` (default 5000) while it runs and write a last offline status when it stops. `node src/cli.ts status [name]` SHALL print one bot in detail (matched by username, profile or data directory) or one line per bot, mark a file older than 3 intervals (at least 15 s) as not running, print the raw JSON with `--json`, and exit 1 when nothing matches.

#### Scenario: Stale file
- **WHEN** the status file was last written 10 minutes ago
- **THEN** `status Pax` says NOT RUNNING, last update 10m ago

### Requirement: Chat status
Every agent SHALL have a non-exclusive `status` action (aliases why, stuck), unless a skill brings its own, that answers with one line of at most 240 characters: the state or what it does, why (or what stops it when stuck), the last progress and health and food. The intents brain SHALL answer "status", "what are you doing", "why are you idle", "are you stuck" and similar with the same line.

#### Scenario: Why are you idle
- **WHEN** an owner says "why are you idle?"
- **THEN** the bot replies with the status line naming the reason nothing runs

### Requirement: Stuck alert
With `settings.status.alert` on (default), when the state becomes stuck the agent SHALL whisper each online owner once what it is trying and what stops it, then again after `stuckAlertMs`, doubling the gap each time up to `alertMaxMs` (default 2 h) while it stays stuck. Progress SHALL reset the back-off. With no owner online nothing SHALL be sent and it SHALL not count as sent.

#### Scenario: Back-off
- **WHEN** a bot stays stuck for 40 minutes with stuckAlertMs 10 minutes and its owner online
- **THEN** the owner gets whispers at 10, 20 and 40 minutes

### Requirement: Settings
The profile key `status` (true/false or { file, intervalMs, alert, stuckAlertMs, alertMaxMs }) SHALL land in `settings.status`; `false` SHALL turn off the file and the alert. The five keys SHALL be feature toggles; unknown keys under `settings.status` SHALL be warned about.

#### Scenario: Live toggle
- **WHEN** an owner runs `!config_set status.alert off`
- **THEN** a stuck bot stops alerting without a restart
