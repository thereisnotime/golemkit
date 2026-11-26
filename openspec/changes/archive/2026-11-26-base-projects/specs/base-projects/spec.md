## ADDED Requirements

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
