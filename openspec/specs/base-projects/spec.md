# base-projects Specification

## Purpose
TBD - created by archiving change base-projects. Update Purpose after archive.

## Requirements

### Requirement: The bot works through a queue of base projects on its own
A bot with the base projects skill and idle mode `active` SHALL, when nothing else scores, run
one bounded work session on the first ready base project: its health and food at least
`projects.minHealth` and `projects.minFood`, no hostiles close, by day or, at night, only on
projects inside finished and lit walls (`projects.night`).

#### Scenario: Idle at home by day
- **WHEN** no behaviour scores, it is day, the bot is fed and healthy and the stone floor is ready
- **THEN** the `base_project` chore runs `work_on_base`, which takes cobblestone from its chests, gathers what is still missing for at most `gatherMinutes`, builds floor cells for at most `sessionMinutes` and records the progress

#### Scenario: Interrupted
- **WHEN** a session is cut short by a reflex, a death or a reconnect
- **THEN** the next session surveys the world again and builds only what is still missing

### Requirement: The base is extended, never rebuilt or torn down
The bot SHALL find its base by fitting the base blueprint to what stands (settings, the remembered
spot, a build in progress, a finished placement, a named place, home, one block up or down, every
gate side) and SHALL count blocks a role accepts as done. On its own it SHALL dig only natural
blocks and blocks it placed itself, leave every other block in the footprint alone, and leave
floor cells under another build alone.

#### Scenario: Pax's fortress
- **WHEN** the place `fortress` is 560 68 -43 and the old plank walls stand one block up from fortress v2's origin
- **THEN** the base is found at 560 67 -43, the plank walls count as done and the hut's floor columns are left alone

### Requirement: Owners steer the queue
Owners SHALL be able to list the projects, get a dry-run plan, approve, veto, skip, unskip, move a
project to the front, and pause and resume all base work from chat. Others SHALL NOT change it.

#### Scenario: Next
- **WHEN** an owner says "pax build towers next"
- **THEN** towers go to the front of the queue with an ok

### Requirement: Big projects wait for an ok under the policy
With policy `auto` a project with more than `askAbove` blocks to place SHALL be proposed to the
owners online first; with `ask` every building project; with `off` nothing is built. An unanswered
proposal SHALL be handled by `onTimeout` after `askTimeoutMinutes`: wait and ask again after
`reaskHours`, build, or skip.

#### Scenario: No answer
- **WHEN** the floor was proposed 40 minutes ago, nobody answered and `onTimeout` is `wait`
- **THEN** the floor needs an ok again and is proposed again after `reaskHours`

### Requirement: LLM building goals and base projects don't fight
While an LLM goal about building is active and worked on, base projects SHALL wait. A paused goal,
or one untouched for 30 minutes, SHALL NOT hold them, and the projects its text names SHALL count
as asked for by its owner.

#### Scenario: Paused fortress goal
- **WHEN** the goal "Upgrade our fortress to fortress v2: stone floor, corner towers, walkway and gate torches" is paused waiting for its offline owner
- **THEN** floor, towers, walkway, walls and lighting are ready without a new ok

### Requirement: Stuck projects say why
A project whose last sessions got nothing done SHALL show the last session's reason on its queue
line and in the status view; a big project waiting for an ok with no owner online SHALL say so;
the builder SHALL name attachments it found nothing to place against, and the survey SHALL leave
alone attachments whose support block holds something the bot may not change.

#### Scenario: Walkway at 42/44
- **WHEN** two ladders have no wall block to hang on
- **THEN** the walkway line says which ladder hangs on which block and the stage can finish

### Requirement: Wall repairs keep the gate door
The builder SHALL take a door out only when a cell still to build is closed in behind it.

#### Scenario: A wall block missing
- **WHEN** the walls stage is missing one wall block and the door is in
- **THEN** the door stays in while the block is placed

### Requirement: Materials come from an ordered list of sources
The bot SHALL get what a build, a base project session or `gather_materials` still needs from the
sources in `materials.sources` order (default chests, substitutes, craft, nearby, mine, far), one
at a time, planned again after each, until nothing required is short or the time is up. A source
that gave nothing of an item SHALL be skipped for that item for `materials.retryMinutes`. The
session result, `projects`, `plan_base` and the status view SHALL say which sources were used,
what each gave, and why the others were skipped.

#### Scenario: Cobblestone in the chests, none to dig near home
- **WHEN** a repair needs 9 cobblestone, the bot carries none, its chests hold hundreds and stone near home is ruled out by the keep-out and water
- **THEN** it takes 9 cobblestone from its chests, digs nothing, and the line says chests were used

#### Scenario: Nothing in the chests, digging close by failed
- **WHEN** the chests hold no cobblestone and digging close by gave none a few minutes ago
- **THEN** nearby is skipped with that reason and the bot takes a trip down its own staircase mine for the cobblestone, then digs further out past the keep-out if the mine fell short

#### Scenario: Substitutes the blueprint allows
- **WHEN** the floor stage needs cobblestone and the chests hold only andesite, which the floor role accepts
- **THEN** it takes andesite; for the whole fortress (whose walls don't accept andesite) it does not

### Requirement: Holes in the floor are counted
The survey SHALL count an empty floor cell as still to build even when a block that isn't part of
the plan stands on top of it; only a cell that holds a block is left alone as covered.

#### Scenario: Chest over a gap
- **WHEN** a floor cell is air and a chest stands above it
- **THEN** the floor stage lists that cell as still to build
