# protected-areas Specification

## Purpose
How a bot learns where the server refuses block breaking (spawn protection, claims) without mistaking lag for protection (`src/core/protection.ts`, `agent.markProtected`). Zones are saved per server in `data/protected-<host>-<port>.json`; docs in `docs/concepts/world.md#protected-areas`.

## Requirements

### Requirement: Confirmed zones only
A refused break SHALL create a zone (radius 20) only when a second refusal comes within 8 blocks of an earlier one, at least 5 seconds and less than 5 minutes after it, or when the refusal is confirmed (a refused placement inside vanilla spawn protection). Refusals in the same lag burst SHALL count once.

#### Scenario: Lag burst
- **WHEN** three breaks within one second are rolled back next to each other
- **THEN** no zone is recorded

#### Scenario: Real protection
- **WHEN** a break is refused and another one 3 blocks away is refused a minute later
- **THEN** a zone is recorded and the pathfinder stops planning digs there

### Requirement: Never from crops
Crop, farmland and plant breaks (tilling and planting in tend_farm and start_farm, grass broken for seeds, kelp) SHALL never create a zone, however often they are rolled back.

#### Scenario: Harvest rollback over the farm
- **WHEN** lag rolls back five tilled cells on its farm over a minute
- **THEN** no zone covers the farm and the bot keeps working it
