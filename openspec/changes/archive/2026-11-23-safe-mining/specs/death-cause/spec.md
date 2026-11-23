## ADDED Requirements

### Requirement: Death cause event
The adapter SHALL emit `deathCause` once per death with a report: the cause in chat form taken from the server's death message ("slain by Zombie", "drowned"), or the last damage source when no message came within 3 seconds, or "unknown cause"; the killer and weapon when named; the server message; the damage sources of the last 15 seconds, newest first, without repeats (mob names, players, fall, lava, fire, drowning, starvation); hostiles within 8 blocks; the action that held the body; health before the last hit; the position; and a one-line summary of all of it. The message MAY arrive before or after the death event.

#### Scenario: The live Pax death
- **WHEN** the bot, fighting a creeper and a zombie, dies and the server says "Pax was slain by Zombie"
- **THEN** the report's cause is "slain by Zombie", its recent damage names zombie and creeper, and its action is defend

### Requirement: Hooks and the LLM get the cause
The hooks brain SHALL fire `death` hooks once the report is there (at most a few seconds after the death) with `{pos}` (where the bot died), `{cause}`, `{killer}`, `{deathMessage}`, `{deathDetail}` and `{drops}`. The LLM brain's death event SHALL carry the summary and tell the model to report that cause rather than guess. observe SHALL include `lastDeath` (cause, detail, seconds ago) for 10 minutes after a death. With an adapter that sends no report, both SHALL still fire with an unknown cause.

#### Scenario: Death report hook
- **WHEN** Pax dies in lava with the hook text "I died at {pos}: {cause}."
- **THEN** the owner gets "I died at 120 11 -40: tried to swim in lava."
