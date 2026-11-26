## ADDED Requirements

### Requirement: Farm water on cold ground
When start_farm finds no open water it may use, no remembered water spot and no bucket, and
farming.iceWater is on (default) and digging is allowed, it SHALL look for surface ice with land
next to it within its radius, then out to 96 blocks. The ice SHALL have air or snow above it, no
roof, and water or a solid block under it. It SHALL score each site like a water site, counting the
ice as water and not as a hazard. It SHALL break the centre ice standing on the shore, with a tool
that has no Silk Touch or a bare hand, never in the Nether, and SHALL check that water is there
afterwards. Water in a cold biome (temperature below 0.15), whether open, poured from a bucket or
from broken ice, SHALL be kept from freezing as farming.protectWater says. In auto, that is a cheap
block over the water, placed against a helper block on the shore cell next to it that it takes back;
it carries two cheap blocks or takes them from its chests. Without the blocks it uses a torch on that
shore cell, which gives the water light 12, and without either, two dirt dug from just outside the plot. In cover or torch mode it uses only that one. With off,
or with neither, it SHALL not use the site and SHALL say why. Protected areas, spawn clearance,
builds nearby, bad farm sites and lava stay ruled out.

#### Scenario: Pax's frozen lake
- **WHEN** home is by a frozen lake in a snowy biome, the bot has no bucket and no torches, and its chests hold dirt
- **THEN** it takes 2 dirt from its chests, breaks the shore ice for a water source, puts a dirt block over the water and starts the farm there

#### Scenario: A torch instead
- **WHEN** it has no cheap blocks but carries torches
- **THEN** it breaks the ice and puts a torch on the shore cell next to the water, which is then not tilled

#### Scenario: Nothing to keep it open
- **WHEN** it has no cheap blocks and no torches anywhere
- **THEN** it leaves the ice alone and the failure says the water would freeze again and what it lacks

### Requirement: Seeds from its chests for a new farm
start_farm SHALL take wheat seeds from its own chests near home before it breaks grass for them.

#### Scenario: Seeds in the pantry
- **WHEN** it has 0 seeds and its pantry holds 35
- **THEN** it takes the seeds it needs from the pantry and breaks no grass

### Requirement: Shore farms judged on their land
A new farm SHALL remember which cells of its square were land when it was made, where its water came
from, and what keeps the water open. Site health SHALL count only those cells when it decides whether
the farm is flooded. A frozen centre SHALL mark it bad, and so SHALL half of those cells turned to
water or ice. Farms without the record are judged on the whole square as before.

#### Scenario: Lake beside the farm
- **WHEN** a shore farm has half its square on the lake and its centre water is open
- **THEN** the site check says it is fine

#### Scenario: The water froze
- **WHEN** the centre of a shore farm is ice
- **THEN** it is marked bad ("the water froze")
