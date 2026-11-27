# Base safety

## Why
Pax was shot twice by skeletons 4 blocks under its own fortress floor, 47 s apart: it had mined its
cobblestone right under the base, the tunnels were dark and connected to the outside, its chores
walked it in, and after respawning in its bed just above it went straight back for stone. Its
staircase mine starts one block outside the east wall, unlit. The walkway stage sat at 42/44 with
a bare "stopped" for ten sessions, the towers never started without anyone saying why, and the
builder dug the gate door out on every wall repair.

## What changes
- Core (`src/core/baseSafety.ts`): `baseSafety:` and `deathSpots:` settings with zod schemas and
  live toggles. Danger zones get an optional height band (`yRange`) and a kind filter; a death is
  remembered as a `death` zone (agent.ts).
- Minecraft: a pure scan of the ground under and around the settled base for dark cavities with
  openings, spawn spots and mines (`baseSafetyPlan.ts`), a registry of fix techniques (cap, fill,
  seal, light), mine findings and caps; the glue (`baseSafety.ts`, `caps.ts`) with `check_base`,
  `secure_base` and the base project `integrity`; site health marks the base unsafe with the reason.
- Digging for stone and ore stays out of the ground under the base (`baseArea.ts` keep-out) and out
  of death spots; new mines start `mineClearance` blocks from the walls (or inside, capped); a
  capped mine's trips take the cap off and put it back; a known uncapped mine too close is `unsafe`.
- Death spots cost the pathfinder extra per block and `wander` skips them.
- Builder: the door is taken out only when something still to build is closed in behind it;
  attachments that never found a face are reported; the survey leaves attachments whose support
  block is someone else's alone.
- Projects: stuck reasons on the queue line and in the status view (`notes` from a new
  `SkillDef.status` hook); "no owner online to ask" when a big project waits.
