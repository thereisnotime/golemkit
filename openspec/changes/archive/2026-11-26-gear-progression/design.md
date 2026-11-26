# Design

## Why a separate readiness for its own mine
`mining.gear` exists because Pax died fighting in a cave it walked into. The danger was the cave: mobs spawning in the dark and coming from every side, water and drops. A staircase it digs itself is a 1-wide lit corridor that the cave check (`caveHazard`) keeps closed. Requiring a shield or armour for it would make the gear chain impossible on terrain without exposed iron (the shield needs iron). So the mine has its own gate (`mine.gear`, default none) plus weapon, food and health, and keeps every safe-mining rule underground (retreat, air, torches, no caves).

## Where the decisions live
Everything that decides is pure in `stairMinePlan.ts`: settings, readiness, entrance problems and pick, target depth, the per-step trip decision (`mineTripStep`), branch geometry, ore in the walls with its vein (`visibleOre`), the tunnel air of an earlier trip (`tunnelAir`, so the cave check doesn't take the old tunnel for a cave), junk to drop, which known mine to use, whether a mine counts as lit, and the site verdict. `stairMine.ts` only reads blocks and digs, reusing `planStep` for every step.

## Reuse over duplication
The staircase and flat steps are mining.ts's `planStep`; torches are `placeTorch`; the retreat is `undergroundRetreat`; smelting stays `smeltItem` with a walk to the remembered furnace (or home) first. The old prospecting in `upgrade_tools` (a 20-block staircase from where the bot stands) stays for owner orders; the gear need uses the mine.

## Searches cut short
A search counts when it starts, so one that a regular behaviour takes over still blocks the next for the cooldown. That's right for real searches and wrong for ones that never got going: six of those used up Pax's day. A run that throws, or ends with "replaced"/"preempted" within 60 s, is recorded `cut`; cut records only block for `retryMinutes`. A "started" record older than 45 minutes is a run a restart cut.

## Bucket for the farm
The farm side (another change) needs water on cold ground. The clear interface is the blackboard need `bucket`: whoever needs a bucket sets it, keep_tools_upgraded moves the bucket to the front of the iron chain, and the gear need gets urgent enough (0.6) to search. Holding any bucket meets it.

## Trade-offs
- The mine is near home (32 blocks) so night trips are short; it's dug where the ground is dry, which on Pax's lake means away from the shore.
- Junk is dropped at branch ends so the walk back doesn't pick it up again; drops on the stairs may be picked up again on the way up.
- A mine trip can be cut by a reflex (eating, a fight); it eats at food 15 itself so the eat reflex doesn't take the body.
