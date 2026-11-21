## ADDED Requirements

### Requirement: Blueprint libraries
The bot SHALL load blueprints from the shipped folder, the user folders (`settings.build.blueprintDirs` and the profile's `blueprints:` key) and its learned library (`data/bots/<name>/blueprints/`), later libraries winning by name, and SHALL keep a cached index with name, library, description, tags, size, block count, materials, author, source, created date, rating and notes.

#### Scenario: Learned blueprint is buildable
- **WHEN** a blueprint is saved to the learned library
- **THEN** `build template=<name>` and `build_plan template=<name>` find it without a restart

#### Scenario: Learned blueprint can't shadow a shipped one
- **WHEN** the learned library holds a file named `hut`
- **THEN** the shipped `hut` stays in use and the learned file is reported as ignored

### Requirement: Search and show
The bot SHALL offer `blueprint_list`, `blueprint_search` (text, tags, material, footprint, height, block count, size class, library) and `blueprint_show` (library info, text drawing, materials against the inventory).

#### Scenario: Ranked search
- **WHEN** an owner searches for "stone house"
- **THEN** blueprints with matching names and tags come first, blueprints matching nothing are left out, and size limits filter strictly

### Requirement: Schematic import
The bot SHALL convert Sponge `.schem` (v1-v3), Litematica `.litematic` and structure `.nbt` files into blueprint YAML with plain-block palette entries and placeable states, keep modded and unknown blocks with a warning, leave out fluids and technical blocks with a warning, and refuse files above a block limit (default 4000) with a crop suggestion. The `blueprint_import` action SHALL read only bare file names from the import folder and is for owners.

#### Scenario: Same structure in three formats
- **WHEN** the same structure is imported from a `.schem`, a `.litematic` and a structure `.nbt`
- **THEN** the three blueprints are identical, and the door side is the entrance

#### Scenario: Too big
- **WHEN** a schematic has more blocks than the limit
- **THEN** the import fails, names the size and block count, and suggests a `crop` that fits

#### Scenario: Path escape
- **WHEN** `blueprint_import` is given `../file.schem`, an absolute path or a symlink
- **THEN** it refuses without reading the file

### Requirement: Capture
The `blueprint_capture` action SHALL save a world region (two corners, or a centre and size, at most 32 per side and 4000 blocks) as a learned blueprint, keeping only player-made blocks unless `all=true`, keeping enclosed air as "must be clear", and using the side of the first door (or the given facing) as the blueprint's facing. It is for owners.

#### Scenario: Save this as X
- **WHEN** an owner asks to capture a hut they built
- **THEN** the hut is saved trimmed to its blocks, ground and plants are left out, and building it elsewhere facing another way turns every stair and door with it

### Requirement: Designed blueprints
The `blueprint_design` action SHALL accept a blueprint as YAML/JSON text or an object, validate it with the schema and sanity checks (size limit, block limit, real block names, every block placeable in build order, no floating blocks), return problems that name layer, row, column and block, preview it, and save it to the learned library. It SHALL never execute anything from the input.

#### Scenario: Floating block
- **WHEN** a design has a block with no touching chain of blocks down to the bottom layer
- **THEN** it is refused with the block's layer, row, column and name, and nothing is saved

#### Scenario: Good design
- **WHEN** a valid design is given
- **THEN** it is saved with author, source `designed`, created date, size, block count and materials, and the reply includes a preview

### Requirement: Rename and delete
`blueprint_rename` and `blueprint_delete` SHALL only change learned blueprints and are for owners.

#### Scenario: Shipped blueprint
- **WHEN** someone asks to delete `hut`
- **THEN** it is refused because `hut` is shipped

### Requirement: Building policy
The setting `building` (profile key and live toggle) SHALL choose between `library` (best match by tags and size), `creative` (design a new blueprint, the best match as fallback) and `ask` (offer the owner up to three matches while an owner is online, otherwise library). `blueprint_pick` SHALL apply it and the LLM prompt SHALL tell the model to use it when a request names no blueprint. Pax defaults to `library`.

#### Scenario: Ask with the owner offline
- **WHEN** the policy is `ask` and no owner is online
- **THEN** `blueprint_pick` answers with the best library match

#### Scenario: Live switch
- **WHEN** an owner runs `!config_set building creative`
- **THEN** the next `blueprint_pick` says to design a new blueprint with `blueprint_design`
