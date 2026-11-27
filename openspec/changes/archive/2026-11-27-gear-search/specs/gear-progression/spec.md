## MODIFIED Requirements
### Requirement: Searches cut short
A need search that throws or ends taken over ("replaced", "preempted", "aborted", "interrupted", "cancelled", "suspended") within its first 60 seconds SHALL be recorded as cut short, and so SHALL a search left at "started" for more than 45 minutes and a search ended because another caller took the body (a reflex, a player), however long it ran. Cut-short searches SHALL NOT count towards `needs.search.cooldownMinutes` or `needs.search.perDay`; the need MAY search again `needs.search.retryMinutes` (default 5) after one. A search cut short because the body was taken MAY start again at once, up to `needs.search.resumes` (default 3) times within `cooldownMinutes`; after that the retry gap applies. Every search SHALL be recorded when it ends, however it ends.

#### Scenario: Taken over by farm work
- **WHEN** Pax's 160-block gear search is taken over by farm work after 4 seconds, six times in a day
- **THEN** the seventh search may still run, 5 minutes after the last, with its 160-block radius

#### Scenario: The eat reflex
- **WHEN** the eat reflex takes the body 30 seconds into a gear search
- **THEN** the search starts again once the reflex back-off is over, not 5 minutes later

## ADDED Requirements
### Requirement: Search holds its slot
A running need search SHALL keep the score `needs.search.holdScore` (default 30) while other behaviours score, so that only a behaviour scoring at least the hold plus the switch margin takes over; a committed search keeps its higher score. `holdScore: 0` SHALL give the old rule (any behaviour above the idle band ends it).

#### Scenario: Drops to pick up
- **WHEN** a gear search is walking and collect_drops scores 22
- **THEN** the search keeps going

#### Scenario: Inventory full
- **WHEN** deposit_when_full scores 45 during a search
- **THEN** it takes over

### Requirement: What took over
When a running behaviour is replaced by another or yields the body, the controller SHALL record which behaviour or caller (with its action) took over and why. A need search that ends that way SHALL store `by`, `why` and `resume` on its record, log a line at info level, and the status (`just status`) SHALL show the newest search with how it ended and the last takeover.

#### Scenario: Status after a cut
- **WHEN** pickup_items at 45 ends a gear search after 12 seconds
- **THEN** `just status` shows "search: gear ..., cut short after 12s by pickup_items (pickup_items 45 > need:gear 30)"

### Requirement: Recipe variants
Crafting SHALL pick, among an item's recipe variants, one it can make (the most runs first); when it can make none, the failure SHALL name the variant it is fewest items short of, and among equals the one whose inputs it holds most of. keep_tools_upgraded SHALL only re-make a worn tool when it carries the materials for it (any stone variant for stone tools, planks for sticks).

#### Scenario: Stone sword with one cobblestone
- **WHEN** the bot holds 1 cobblestone and a stick and needs a stone sword
- **THEN** the failure says "need 1 cobblestone", not "need 2 cobbled_deepslate"
