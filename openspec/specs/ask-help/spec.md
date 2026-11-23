# ask-help Specification

## Purpose
A behaviour that keeps failing the same way tells its owners once what it was trying, why it fails and what would help, instead of looping for hours (`src/brains/npc/help.ts`, settings.askHelp).

## Requirements

### Requirement: Failure grouping
The NPC controller SHALL report every failed behaviour run, with its failure message, to the agent's help desk, and every successful run. The desk SHALL group failures per behaviour and per normalized reason: lower case, bracketed details, quotes and everything after the first ";" or spaced dash removed, numbers and coordinates replaced by one placeholder. A kind with no new failure for `forgetMinutes` (120) SHALL start over. A success SHALL clear the behaviour's failure kinds. Aborted and yielded runs SHALL count as neither.

#### Scenario: Wider rings are the same failure
- **WHEN** chop_wood_loop fails with "no natural tree within 32 blocks" and later "no natural tree within 64 blocks"
- **THEN** both count towards the same failure kind

### Requirement: Escalation
With `settings.askHelp` enabled, once a failure kind has at least `failures` (3) failures and its first one is at least `minutes` (10) minutes old, the desk SHALL ask for help once: a message naming what the behaviour was trying (its goal, default its name), the last failure message, the tries and minutes, and what would help (the behaviour's help hook) or "Any idea?". With `tell: owners` it SHALL whisper each owner who is online; with `tell: say` it SHALL use public chat. With no owner online, during `quietHours`, or past `maxPerHour` (3) asks in the last hour, it SHALL not send and SHALL try again on the next failure. It SHALL not ask again for the same behaviour and reason within `perReasonMinutes` (60), nor for another reason of a behaviour whose ask is still open. Sent asks SHALL be kept in storage so a restart does not repeat them.

#### Scenario: Sticks
- **WHEN** keep_tools_upgraded fails "could not make sticks" 4 times over 12 minutes and Robin (owner) is online
- **THEN** Robin gets one whisper "Stuck trying to upgrade my tools: could not make sticks (4 tries over 12 min). A few logs or planks in my chest would help." and further failures in the next hour send nothing

### Requirement: Help hooks
A Behavior and a BehaviorDefinition MAY define `goal` and `help(ctx, failure)`; the body's own wins over the definition's. help MAY return a string (what would help), an object with help, goal and tried, undefined (no hint) or null (the behaviour reports this itself: no ask). The stock library SHALL give its behaviours goals and hints for their usual failures (wood, sticks, iron, coal, trees, paths and doors, beds, chests, seeds, water, torches), and a clear-path hint for path failures of any behaviour.

#### Scenario: keep_fed reports itself
- **WHEN** keep_fed with `report: true` keeps failing
- **THEN** the generic escalation stays quiet and keep_fed's own starving report is the one message

### Requirement: Shared limits for behaviours that ask on their own
A behaviour MAY ask through the desk directly (keep_fed's starving report). Such an ask SHALL share the per-reason and per-behaviour limits with the escalations, SHALL go out even with askHelp off (the behaviour has its own switch, and the hourly cap does not apply then) and during quietHours, MAY fall back to public chat when no owner is online, and SHALL be recorded like an escalation.

#### Scenario: No double message
- **WHEN** keep_fed whispered that it is starving and then keeps failing for 15 minutes
- **THEN** no second message about keep_fed goes out within the hour

### Requirement: Sorted
When a behaviour that asked succeeds again, the desk SHALL mark the ask sorted, record a `help` journal event with status sorted and, with `thanks: true`, tell the same people "sorted: <goal> works again, thanks" once.

#### Scenario: Wood arrives
- **WHEN** Robin puts logs in the chest and keep_tools_upgraded succeeds
- **THEN** the journal gets a sorted help event, and Robin gets a thanks only if askHelp.thanks is on

### Requirement: Visibility
Every ask SHALL be a `help` journal event (status, behaviour, reason, goal, help, failures, tried, to, message), listed by `recall_events type=help` (or `stuck`). observe SHALL include `askedForHelp` (behaviour, reason, help, minutes ago, sorted, who was told) for `observeMinutes` (60) and npc_status SHALL list it. The agent SHALL emit `askHelp` and `helpSorted` unless `llm: false`; the LLM brain SHALL put them in its memory and SHALL start a turn only when `triggers.events.stuck` is true.

#### Scenario: LLM sees it without a model call
- **WHEN** Pax (LLM brain, default triggers) asks Robin for help with chop_wood_loop
- **THEN** no LLM turn starts, and the next turn's memory says it asked for help and should not repeat the request

### Requirement: Configuration
The profile key `askHelp` SHALL accept true, false or an options map (enabled, failures, minutes, forgetMinutes, perReasonMinutes, maxPerHour, tell, llm, thanks, quietHours, observeMinutes), landing in settings.askHelp; only `true` or `enabled: true` turns it on: an options map without `enabled: true` (in a profile, or built up by `!config_set askHelp.<key>` on a bot without askHelp) tunes it but leaves it off. It SHALL be off by default. askHelp.enabled, failures, minutes, maxPerHour, tell, thanks and llm SHALL be live toggles. The game-agnostic desk SHALL not import Minecraft packages or touch agent.bot.

#### Scenario: Pax
- **WHEN** profiles/pax.yaml is loaded
- **THEN** settings.askHelp is enabled with 3 failures over 10 minutes
