## ADDED Requirements

### Requirement: Road planning on a height map
The planner SHALL find a route over a height map where the walking height changes by at most one block per cell, only on straight moves, and never on or next to a turn, with cut and fill within the limits on every lane, and SHALL return no route with a reason when there is none.

#### Scenario: Flat field
- **WHEN** a road is planned across a flat field
- **THEN** it is straight, has no stairs and no landings, and three lanes all the way

#### Scenario: Even slope
- **WHEN** a road is planned up a 1-in-3 slope
- **THEN** it goes straight up with one stair row per block of rise, spread evenly

#### Scenario: No route
- **WHEN** a building wall closes off the target
- **THEN** planning fails with a reason instead of a route

#### Scenario: Search limit
- **WHEN** the node limit runs out
- **THEN** planning fails and says it gave up after that many nodes

### Requirement: Switchbacks on steep slopes
When the rise is steeper than one block per block between the endpoints, the search SHALL fold the road with 180 degree turns made of two landings and a connector, the parallel flights one gap cell apart, without any rule that builds switchbacks on purpose.

#### Scenario: Cliff
- **WHEN** a road joins plateaus 20 blocks apart in height with a cliff of 8 blocks between them and endpoints 16 blocks apart
- **THEN** the route has a 180 degree turn, every rise has a stair facing up on all lanes, no turn is on a rise, and every flight is straight

### Requirement: Width and obstacles
Every lane and railing cell SHALL stay out of buildings, trees and protected areas, lanes SHALL stay out of the margin around buildings except the straight stub in front of a door, and a road SHALL NOT overlap another road or itself.

#### Scenario: House in the way
- **WHEN** a house footprint lies between the endpoints
- **THEN** the road goes round it, no lane on the footprint or its margin

#### Scenario: Door
- **WHEN** a road starts at a door front and ends at another door front
- **THEN** it leaves straight out of the first door and arrives straight into the second

#### Scenario: Water
- **WHEN** a lake lies across the way and bridging is off
- **THEN** there is no route; with bridging on, the road crosses on a deck at or above the water with railings

### Requirement: T-junctions
A road SHALL end on (or start from) an existing road only at a flat cell of the same walking height, coming in square, and SHALL NOT write over the existing road.

#### Scenario: Join an existing road
- **WHEN** a door is connected to a road running past at the same height
- **THEN** the new road ends on its edge lane and none of its blocks are on the old road

#### Scenario: Wrong height
- **WHEN** the existing road is higher than any fill can reach, or the only cells are stairs
- **THEN** there is no junction and planning fails

### Requirement: Road geometry
The geometry SHALL put the floor at walking height minus one, a stair on the higher cell of each rise facing the way up on every lane, full landing squares at turns, a base down to the ground (capped), head-room of three blocks over every lane with any cut up to the ground, wall railings where the drop beside the road is 2 or more, and optional lanterns on landing posts.

#### Scenario: Ditch
- **WHEN** a flat road passes a ditch 4 deep on one side
- **THEN** a wall stands on that side on a base down to the ditch floor, and none on the other

#### Scenario: Bump
- **WHEN** rising costs more than cutting
- **THEN** the road stays level and the bump is cut away

### Requirement: Networks
`connect` SHALL join all endpoints with the cheapest roads first between groups, re-planning as roads are laid, use each door at most once and join the rest at T-junctions, with no two roads overlapping.

#### Scenario: Six doors on a hill
- **WHEN** six houses on a hill are connected
- **THEN** all are in one group with five roads, no overlaps, every road walkable

### Requirement: Road actions
The bot SHALL offer `build_road` (two places, dry run with length, stairs, landings, cut/fill and materials), `connect_buildings` (structures it built, doors among its own blocks, doors nearby, or given doors), `remove_road` and `road_list`, build in survival by hand after gathering materials and in creative by hand or with merged `/fill` runs, never dig anything but natural or road blocks, honour digging and protected areas, and report placed, unreachable and missing honestly with a walkability check.

#### Scenario: Live, creative with commands
- **WHEN** two huts at different heights on a hill are connected with `connect_buildings method=commands`
- **THEN** the road is built with a few dozen merged commands, the read-back finds it walkable, and `remove_road` takes it out again

#### Scenario: Not op
- **WHEN** the server refuses the first command
- **THEN** the road is built by hand instead and the result says so
