# Tasks

- [x] Pure decisions in `src/skills/tactics.ts` with unit tests (`test/combat.test.ts`)
- [x] Fight loop in `src/skills/fight.ts`: cooldown, crits, sprint hit, reach, spacing, strafe, safe steps, chase limits, archers, spiders, flyers, lull eating
- [x] `defend`: threat order, heal disengage, outnumbered escape, archer line of fire; `attack` refuses protected entities
- [x] `gear_up` action and armour reflex; offhand totem/shield; shield already in the offhand counts
- [x] Ballistic bow aim with measured target velocity
- [x] `stay_safe`: unprepared at night goes home sooner or bunkers
- [x] Toggles `combat.crits`, `combat.strafe`, `combat.disengageToHeal`, `combat.autoArmor`, `combat.maxChase`
- [x] Docs: world.md (fight loop diagram), live-config.md
- [x] `scripts/fight-test.ts`, live runs before/after
