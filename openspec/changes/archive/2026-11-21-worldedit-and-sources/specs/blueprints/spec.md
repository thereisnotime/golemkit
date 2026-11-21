## ADDED Requirements

### Requirement: Legacy and Axiom schematics
The importer SHALL read legacy MCEdit/WorldEdit 6 and Schematica `.schematic` files, mapping numeric ids and data values to 1.21 blocks with states, and Axiom `.bp` files, choosing the reader by content.

#### Scenario: Legacy door
- **WHEN** a legacy file has an oak door with lower data 3 and upper data 8
- **THEN** both halves import as `oak_door` facing north with a left hinge

#### Scenario: Unknown id
- **WHEN** a legacy file uses an id the table doesn't know
- **THEN** those cells are left out and the import warns with the id and count

### Requirement: Fetching blueprints from sources
`just blueprint-fetch` SHALL download each entry of `blueprints/sources.yaml` with a generic User-Agent, verify its hash when given, convert it with author, source, license and tags in `meta`, write redistributable ones to `blueprints/library/` and the rest to the gitignored `blueprints/downloaded/`, and report which a survival bot can build.

#### Scenario: Unclear license
- **WHEN** an entry has `redistribute: false`
- **THEN** its blueprint is written only to `blueprints/downloaded/`

#### Scenario: Manual source
- **WHEN** an entry is `manual: true` and its file isn't in `blueprints/downloaded/raw/`
- **THEN** nothing is downloaded and the report says where to get it



### Requirement: Gathering stone-family blocks
`gather_materials` SHALL make cobblestone, stone, stone brick and smooth stone slabs, stairs and walls, stone bricks and smooth stone, smelting cobblestone into stone (and stone into smooth stone) as needed, and mine andesite, diorite, granite and tuff.

#### Scenario: Stone brick stairs
- **WHEN** a list asks for 8 stone brick stairs and the bot has nothing
- **THEN** the plan mines 12 cobblestone, smelts 12 stone, crafts stone bricks three times and then the stairs
