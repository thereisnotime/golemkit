# Design

## Formats

- `readSchematic` sniffs the buffer: Axiom magic `0x0AE5BB36`, zip (refused with a hint), gzip,
  then NBT. `readSchematicNbt` picks Litematica (`Regions`), structure (`blocks` + `size`), Sponge
  (`Palette`/`Blocks.Palette`/`BlockData`) or legacy (`Blocks` and `Data` byte arrays).
- Legacy mapping: minecraft-data ships `pc/common/legacy.json` (id:data to flattened state, from
  the 1.13 data fixer) and 1.12.2 `blocks.json` (old name to id, for Schematica). Both come with
  mineflayer, so no table is committed. Post-1.13 renames are a small map. Doors and tall plants
  are fixed up across halves because the old format split their state.
- Readers can attach `warnings` to the Structure; crop and conversion keep them.
- Axiom: header NBT, thumbnail, gzipped `BlockRegion` sections at 4+ bits per entry without
  spanning, coordinates in section units (confirmed on a real file).

## Fetching

- One request per second, generic User-Agent, 16 MB cap, https only, commit-pinned URLs with
  sha256. Blueprint names go through `checkName`, writes through `writeLearned` (safe paths).
- Licensing decides the folder. Committed results get `LICENSES.md` and the license texts.
- Fetched files usually carry terrain; `terrain: false` is the fetch default. Turning ground into
  dirt (instead of dropping it) keeps the support the building had.
- The report reuses `unplaceableCells`, `floatingCells`, `wantsForRoles` and `planWood`.
- `blueprints/library/` is a second shipped folder; ties in search rank it after the hand-made
  shipped set. `sources.yaml` is skipped by the loaders.

## Stone family

`stoneRecipe` (crafts) and `stoneChain` (pure: how much stone, smooth stone and bricks a list
takes, what to smelt, how much cobblestone that is) feed `planWood`; `makeStone` runs the smelts
and brick crafts between mining and the final crafts. `woodRecipe` stays wood-only.

## WorldEdit

- Detection order: setting, announced channels/registries (`serverSignals` in mods.ts, plus
  `minecraft:register` payloads), then a `/we version` probe. Cached per session.
- Commands: `agent.command(cmd)` queues on the chat queue (same 1.1 s spacing and queue cap),
  bypasses humanize styling and splitting, logs, and resolves when sent. Replies are the
  `serverMessage` events after sending, until 0.6 s of quiet or `replyMs`.
- `parseWeReply` turns lines into a kind (ok, permission, unknown_command, too_big,
  no_selection, empty_clipboard, bad_pattern, not_found, exists, nothing, usage, error, silent)
  plus counts, sizes, positions, files, version.
- Safety: owners only (setting), selection tracked per session so volumes are known, block
  limit (toggle), protected zones and spawn keep-out unless an owner passes `protected_ok`,
  argument character whitelist, `we_raw` command whitelist.
- `we_build` uses `//schem list` / `load` / `//size -c` / `//paste -a` and falls back to
  `buildStructure`. No uploads: a client can't put files on the server.

## Core changes

- `Agent.command()`: commands need a raw `/` line that must not be styled or split, and must
  respect the chat rate limit; the queue entry carries a resolver.
- Two toggles and one profile key. Nothing else in core.
