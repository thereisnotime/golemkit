## Context

Blueprints are YAML parsed by `blueprint.ts`; `construction.ts` builds them. The format already
had plain-block palette entries (`{ block, state }`) and a passthrough `meta:` block, meant for
this change.

## Decisions

### Three libraries, one loader
`libraryDirs(agent)` returns shipped, user and learned folders in that order; `loadLibrary`
parses every `*.yaml` (regular files only, no symlinks), later folders win by name, and keeps an
index entry per blueprint. The result is cached under a signature of paths and mtimes, so a
search costs a directory listing. A learned blueprint that takes a shipped or user name is
reported and ignored, and every writer refuses such names, so a captured "small_house" can't
silently replace the default house. `build` and `build_plan` load through the same function.

### Index and search
Per entry: name, library, description, tags, size, block count, materials by item, and the meta
fields. Search has hard filters (footprint, height, block count, library) and a score (tags 5,
name 4, tag via synonym 3, description 1.5, material). Synonyms map common words (home, fort,
castle, wall...) onto the four base tags. Ties go to rating, then the bot's own library.
Shipped blueprints now carry tags.

### Schematics
`prismarine-nbt` (already a dependency) parses big-endian NBT, gzipped or not. Readers produce
one `Structure`: palette plus a dense grid of palette indices, -1 for "don't care". Sponge v1/v2
(Palette + BlockData) and v3 (Blocks.Palette/Data) decode varints; Litematica unpacks tightly
packed longs (entries may span two longs) per region, handles negative sizes and merges regions;
structure files use size/palette(s)/blocks. A volume cap (4M) guards memory before anything is
expanded. The converter trims the empty margin, drops states the builder can't place or check
(waterlogged, fence sides, chest type, rail shape), leaves out fluids, portals and command blocks
with a warning, keeps modded and unknown blocks as plain blocks with a warning, picks mnemonic
palette characters, and writes YAML that is parsed once more before it is saved.

Wooden blocks get one role per kind (`wood_stairs`, `wood_planks`...) that accepts any overworld
wood and follows the build theme, unless the structure mixes woods for that kind; `exact=true`
turns this off. The first live capture showed why: a kiosk built in spruce could not be copied by
a bot standing among oaks.

Other plain blocks get a role of their own; that role now infers its kind from the name (doors last,
torches/ladders/signs as attachments, beds/chests/furnaces as furnishings) and the item that
places it (a wall torch comes from a torch), so imported and captured builds go in in the right
order.

### Capture and orientation
Capture reads the box through `bot.blockAt` and `getProperties()`. By default natural blocks are
"don't care"; air counts as "must be clear" only when built blocks enclose it in its row and its
column (rooms, doorways), so the surroundings never become part of the footprint. States are kept
as they lie in the world: the drawing is north-up, and the blueprint's `facing` is the side of
the first door (or the caller's choice), so `rotate()` turns every state correctly when it is
built facing elsewhere.

### Design checks
`checkDesign` runs after the zod schema and `parseBlueprint`: size (24 per side) and block
limits (1500, `settings.build.designMaxBlocks`), role defaults must be real 1.21.1 blocks or items
(minecraft-data from mineflayer's copy, with "did you mean"), then the build-order simulation the
shipped-blueprint test used (now `unplaceableCells`), then a flood fill from the bottom layer over
touching blocks to find floating ones. Every problem names layer, row, column, glyph and block.

### Policy
`decideBuilding(policy, hits, ownerOnline)` is pure: library builds the best match (or designs
when nothing fits), creative designs with the best match as fallback, ask offers up to three
matches when an owner is online and falls back to library otherwise. `blueprint_pick` feeds it
the search hits and whether an owner is in the player list. The policy lives in
`settings.building` (profile key `building:`, toggle `building`), so `!config_set building
creative` takes effect on the next pick. The system prompt only says to call `blueprint_pick`;
the live value is never baked into the cached prompt.

### Files and safety
Imports read only `settings.build.importDir` (default `blueprints/import/`), by bare file name.
`safeChild` rejects absolute paths, `..`, NUL, and any path whose deepest existing part resolves
(realpath) outside the root, and symlinked files. Learned files are `<name>.yaml`, written
atomically; names are `[a-z0-9_]{1,48}`. Writes, renames and deletes are owners only (a player
caller and the player an LLM acts for must be owners).

## Core changes

- `core/toggles.ts`: one toggle, `building`.
- `core/profile.ts`: `building` lands in `settings.building`; `blueprints` (folders, relative to
  the profile) are appended to `settings.build.blueprintDirs`.

## Risks

- Apart from wood, captured and imported blueprints name exact blocks, so in survival the bot needs
  those items; modded blocks can only be placed when carried.
- Block-entity data (chest contents, sign text) and entities are not imported.
- Rotation of `rotation=0..15` (signs, banners) isn't turned with the blueprint.
