## Why

Bots could only build the blueprints that ship with the code. An owner couldn't bring in a
schematic from the internet, couldn't say "save this as X" about something they built, and the
LLM had no way to come up with its own design. There was also no way to say whether the bot
should reuse a known blueprint, design something new, or ask first.

## What Changes

- Blueprint libraries: shipped (`blueprints/`), user folders (`settings.build.blueprintDirs`,
  profile `blueprints:`) and a learned library per bot (`data/bots/<name>/blueprints/`). Each
  blueprint carries `meta` (author, source, tags, created, rating, notes); size, block count and
  materials are computed. A cached index makes search cheap.
- Import of Sponge `.schem` (v1-v3), Litematica `.litematic` and vanilla structure `.nbt` into the
  YAML format with plain-block palette entries, modded and unknown blocks kept with a warning, a
  block limit (default 4000) with a crop suggestion. CLI (`scripts/blueprint-import.ts`, `just
  blueprint-import`) and an action (`blueprint_import`) that only reads the import folder.
- `blueprint_capture`: a world region (corners, or a centre and size) saved as a learned
  blueprint; player-made blocks only by default; states kept as they lie with the entrance side
  as the blueprint's facing; owners only.
- `blueprint_design`: the model hands over YAML or JSON; it is validated (schema, size, real
  block names, placeable in build order, nothing floating), previewed and saved, with error
  messages written for the model to fix and retry. Data only.
- `blueprint_list`, `blueprint_search`, `blueprint_show`; `blueprint_rename` and
  `blueprint_delete` for learned blueprints, owners only.
- Building policy `building: library | creative | ask` (profile key and live toggle),
  `blueprint_pick` to apply it, and prompt guidance. Pax defaults to `library`.

## Impact

- New: `src/skills/blueprint-library.ts`, `src/skills/schematic.ts`, `src/skills/library.ts`,
  `scripts/blueprint-import.ts`, `scripts/library-test.ts`, `blueprints/import/well.schem`.
- Changed: `blueprint.ts` (meta fields, plain blocks get a kind and the item that places them),
  `construction.ts` (loads all libraries), `skills/index.ts` (skill in `extendedSkills`),
  `core/toggles.ts` (`building`), `core/profile.ts` (`building`, `blueprints` keys),
  `llm/prompt.ts`, Pax's profile and build-house skill, shipped blueprints gained tags.
- Docs: new `docs/guide/blueprints.md`.
