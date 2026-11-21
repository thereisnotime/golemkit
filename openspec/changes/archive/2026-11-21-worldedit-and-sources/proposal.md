# WorldEdit skill, more schematic formats, blueprints from the internet

## Why

The owner wants a bigger blueprint library without drawing everything by hand, and most
schematics online are in WorldEdit's formats (old `.schematic`, `.schem`) or are structure files
from mods. On servers that run WorldEdit, an owner also wants the bot to use it when asked
instead of placing thousands of blocks one by one.

## What changes

- The importer reads legacy MCEdit/WorldEdit 6 `.schematic` (numeric ids mapped with
  minecraft-data's legacy table), Schematica's mapping, Axiom `.bp`, and keeps reading WorldEdit 7
  `.schem` with all its extras and gzipped Create structure files. Detection is by content.
- Optional terrain clean-up on import: ground cover becomes dirt, plants and leaves are left out.
- `blueprints/sources.yaml` plus `scripts/blueprint-fetch.ts` (`just blueprint-fetch`): download,
  convert, attribute and check schematics. Freely licensed results are committed to
  `blueprints/library/` (loaded as shipped); the rest go to gitignored `blueprints/downloaded/`.
- `gather_materials` makes the stone family: cobblestone, stone, stone brick and smooth stone
  slabs, stairs and walls, stone bricks, smooth stone (smelting), and mines andesite, diorite,
  granite, tuff.
- New `worldedit` skill in the extended skills: detection, selection, region edits, clipboard,
  schematics on the server, a whitelisted raw command, building a library blueprint with
  WorldEdit, all owners only with a block limit and protected-area checks.
- Core: `agent.command()` sends a server command through the chat rate limit; toggles
  `worldedit.enabled` and `worldedit.maxBlocks`; profile key `worldedit`.
