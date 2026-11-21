## ADDED Requirements

### Requirement: Context pack loading
The framework SHALL load a context pack from the directories in `settings.contextDefaults` and `settings.context` (a profile's `context:` key or its sibling `profiles/<name>/` directory), recognising `AGENTS.md`/`RULES.md`, `IDENTITY.md`, `SOUL.md`, `USER.md`, `MEMORY.md`, `skills/` and `hooks.yaml`, with later directories overriding earlier ones, and SHALL log each loaded file with its size and token estimate.

#### Scenario: Sibling directory discovered
- **WHEN** `profiles/pax.yaml` has no `context` key and `profiles/pax/AGENTS.md` exists
- **THEN** the profile's settings carry the absolute path of `profiles/pax` as its context

#### Scenario: Disabled
- **WHEN** a profile sets `context: false`
- **THEN** no pack is loaded and the system prompt is the same as without the feature

#### Scenario: Status
- **WHEN** a player runs `!context_status`
- **THEN** the bot reports the loaded files with token estimates, the skill, hook and memory note counts and any warnings

### Requirement: System prompt layout
The system prompt SHALL place operational rules directly after the first line, then identity (replacing the persona) or the persona, then the framework rules, then soul, user and the skill index, then memory last, with per-section and total character caps, and SHALL be byte-identical between turns until a pack file or MEMORY.md changes.

#### Scenario: Ordering
- **WHEN** a pack has AGENTS.md, SOUL.md, USER.md and skills
- **THEN** the rules text appears before the persona and the skill index appears after USER.md, and skill bodies are not in the prompt

#### Scenario: Total cap
- **WHEN** the sections exceed the total cap
- **THEN** memory is cut first and rules last, and memory notes go to the user message if memory was cut

### Requirement: Memory file
When a pack is active, MEMORY.md SHALL be the authoritative long-term note store: `remember` adds a bullet line, skipping exact duplicates and updating near-duplicates about the same topic in place; over its caps it merges the oldest same-topic notes and then drops the oldest unpinned ones; lines under a "Pinned" heading are never removed; existing storage notes are migrated once.

#### Scenario: Duplicate
- **WHEN** the model remembers a fact that is already in MEMORY.md with different case and punctuation
- **THEN** the file is unchanged and the tool answers "already noted"

#### Scenario: Hand edit
- **WHEN** a person adds a line to MEMORY.md while the bot runs
- **THEN** the next prompt and `recall` include it

### Requirement: Skills with progressive disclosure
Skills SHALL be read from `skills/<name>/SKILL.md` or `skills/<name>.md`; only their names and descriptions SHALL go into the system prompt, and the model SHALL get `list_skills` and `read_skill` tools for the full text. Action names in a skill's frontmatter SHALL be checked against the action catalog and built-in tools, with warnings for unknown ones.

#### Scenario: Reading a skill
- **WHEN** the model calls `read_skill` with `gather-wood`
- **THEN** it gets the skill body, and the call counts toward the per-turn tool limit

#### Scenario: Unknown action
- **WHEN** a skill lists `teleport` in `actions` and the catalog has no such action
- **THEN** loading logs a warning naming the skill and the action

### Requirement: Deterministic hooks
The hooks brain SHALL run `hooks.yaml` rules without the LLM: events `spawn`, `death`, `playerJoined`, `playerLeft`, `chat` (regex), `hurt`, `lowHealth`, `actionFailed`, `timer` and `llmBudgetExhausted`; conditions, cooldowns, `once` and owner-only flags; steps `act`, `say`, `whisper` and `remember`. Actions SHALL run through `agent.act()` as `brain:hooks` at priority 40 and chat through `agent.say/whisper`. No code from the file is executed.

#### Scenario: Low health
- **WHEN** health drops below 8 and the bot carries food
- **THEN** the hook runs `eat` at priority 40 once, and fires again only after health recovers to 10 and drops again

#### Scenario: Owner-only chat hook
- **WHEN** a non-owner sends a chat line matching an `ownerOnly` hook's regex
- **THEN** the hook does not fire

#### Scenario: Cooldown
- **WHEN** a hook with `cooldown: 30s` matches twice within 10 seconds
- **THEN** it fires once

### Requirement: A/B eval harness
The eval SHALL run each scenario N times per arm with the same provider, model, tasks and per-turn limits, through the real LLM runtime against a fake agent in a scripted world, and SHALL report per arm and scenario the success rate, mean tool calls, latency and tokens in/out/cached and cost, to the console and as JSON and markdown in `data/evals/`. A `--dry` mode SHALL use a deterministic scripted provider; real providers SHALL print the number of provider runs and require `--yes`.

#### Scenario: Dry run
- **WHEN** `just llm-eval --dry` runs
- **THEN** both arms produce results without any network call and a report is written

#### Scenario: Real provider without consent
- **WHEN** the eval is started with a real provider and without `--yes`
- **THEN** it prints the expected number of runs and exits without calling the provider
