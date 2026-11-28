# death-cause Specification

## Purpose
Reports of a death state the real cause, from the server's death message and the damage the bot took, instead of a guess (`src/core/journal/deathReport.ts`, the Minecraft adapter's `deaths.ts`).

## Requirements

### Requirement: Death cause event
The adapter SHALL emit `deathCause` once per death with a report: the cause in chat form taken from the server's death message ("slain by Zombie", "drowned"), or, when no message came within 3 seconds of the death, a text for the last damage source ("burned in lava", "fell", "killed by Zombie (no death message, last hit)"), or "unknown cause"; the killer and weapon when named; the server message; the damage sources of the last 15 seconds, newest first, without repeats (mob names, players, fall, lava, fire, drowning, starvation); hostiles within 8 blocks; the action that held the body; health before the last hit; the position; and a one-line summary of all of it. The message MAY arrive up to 3 seconds before or after the death event.

#### Scenario: The live Pax death
- **WHEN** the bot, fighting a creeper and a zombie, dies and the server says "Pax was slain by Zombie"
- **THEN** the report's cause is "slain by Zombie", its recent damage names zombie and creeper, and its action is defend

### Requirement: Hooks and the LLM get the cause
The hooks brain SHALL fire `death` hooks once the report is there (at most a few seconds after the death) with `{pos}` (where the bot died), `{cause}`, `{killer}`, `{deathMessage}`, `{deathDetail}` and `{drops}`. The LLM brain's death event SHALL carry the summary and tell the model to report that cause rather than guess. The self-improver's `death` triggers SHALL fire once the report is there too, with `{cause}` and `{deathDetail}` filled in their templates. observe SHALL include `lastDeath` (cause, detail, seconds ago) for 10 minutes after a death. With an adapter that sends no report, both SHALL still fire with an unknown cause 4 seconds after the death.

#### Scenario: Death report hook
- **WHEN** Pax dies in lava with the hook text "I died at {pos}: {cause}."
- **THEN** the owner gets "I died at 120 11 -40: tried to swim in lava."

### Requirement: One environmental classification
Damage with no attacker SHALL be classified the same way by the death-cause tracker and the journal (`classifyEnv` / `envCauses` in the Minecraft adapter's `deaths.ts`): lava, fire, drowning (no air left), fall (landed within the last second after dropping more than 3 blocks), starvation (food 0), else unknown. The journal's `damage` events and the cause of a `death` event without a server message SHALL use it instead of a generic "environment".

#### Scenario: Journal death in lava without a message
- **WHEN** the bot dies in lava and no death message arrives within 3 seconds
- **THEN** the journal's death event has cause "lava"

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
