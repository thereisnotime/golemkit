# Base projects

## Why
Pax lives in a small fortress (560 67 -43) its owner asked it to upgrade to fortress v2. The LLM
goal for that stopped at 130 of 648 blocks: the model called `update_goal wait=true` while the
owner was offline, the goal resumed itself three times (the `selfResumes` cap) and then stayed
paused, with its turn and time limits used up as well. Without a goal Pax stood around. A bot
should improve its base on its own, steered by its owner but not blocked by one.

## What changes
- Core (`src/core/projects.ts`): `projects:` settings (policy auto/ask/off, askAbove, ask timeout
  and onTimeout wait/build/skip, session and gather limits, safe-needs gate, night, template,
  base, order, skip), the stored owner decisions and progress, and pure queue logic: order,
  dependencies, which projects need an ok, when to ask, what an unanswered ask turns into, the
  next step, owner ops (approve, veto, skip, unskip, next, pause, resume, reset), goal words.
- Minecraft (`src/skills/basePlan.ts`, `src/skills/projects.ts`): the base blueprint's
  `meta.stages` (fortress: walls, floor, walkway, towers; new `outpost`), plus lighting, a storage
  row, a workshop and a reserved farm plot; finding the base by fitting the blueprint to what
  stands; surveying what is done, left, someone else's or under another build; bill of materials
  against inventory and chests; sessions that take from chests, gather (bounded) and build only a
  stage; actions `projects`, `project`, `plan_base`, `work_on_base`.
- `build` takes stage-only and autonomous builds (internal): only natural or own blocks are dug,
  other spots are left out instead of failing.
- Needs layer: the `base_project` chore in idle mode `active`.
- Intents: "pax projects", "pax plan fortress", "pax approve X", "pax build X next", "pax skip X",
  "pax do not build X", "pax pause building", "pax resume building" (patterns only).
- LLM goals: an active building goal holds the projects back; a paused or stale one doesn't and
  the projects it names count as asked for by its owner.
- Pax: `projects: { policy: auto, askAbove: 150, onTimeout: wait }`.
