# Idle that keeps it busy, farms on cold ground

## Why

Pax sat for hours by its fortress on snowy ground with `idle: active`. Its farm froze, and
`start_farm` found no water that wouldn't freeze and had no bucket. Most chores had nothing to
do with what it had: logs, 35 seeds, no coal. `top_up_seeds` waited for a farm, and the farm
waited for seeds. `light_dark_spots` came back every 30 minutes and lit nothing, and `stroll`
always picked roofs it couldn't reach ("found nowhere to wander to"). The status only said
"every behaviour scored 0".

## What changes

- start_farm can now get water on a frozen shore without a bucket. It breaks ice over water or
  ground, with no Silk Touch and never in the Nether, and keeps the water open with a cheap block
  over it, or a torch next to it. Open water and bucket holes in a cold biome are kept open the
  same way. It takes the seeds and blocks it needs from its own chests first. The 1.21.1 ice and
  freezing rules are in `src/skills/coldFarmPlan.ts`. New settings: `farming.iceWater`,
  `farming.protectWater`.
- A farm remembers which cells were land when it was made. Site health judges a shore farm on
  those cells, so the lake next to it no longer counts as a flood. A frozen centre still makes
  the farm bad.
- Idle chores:
  - The rules for whether a chore has anything to do are pure (`choreIdle`).
  - `top_up_seeds` no longer needs a farm.
  - A chore that found nothing to do waits `quietMinutes` (default three cooldowns, at least 30;
    light_dark_spots 240).
  - The status says why each chore was passed over.
- `wander` takes the ground nearest the bot's height, not roofs and wall tops.
- light_up counts a single snow layer as a free cell for a torch.

## Impact

`src/skills/coldFarmPlan.ts` (new), `food.ts`, `needPlan.ts`, `navigation.ts`, `lightPlan.ts`,
`lighting.ts`, `src/brains/npc/idle.ts`, `needs.ts`, `controller.ts`, `src/core/needs.ts`,
`toggles.ts`, `profile.ts` (farming keys checked), the Minecraft chores and site checks; tests
`cold-farm-plan`, `idle-chores`, `light-plan`.
