## ADDED Requirements

### Requirement: Chore rules
Whether a Minecraft chore has anything to do SHALL come from one pure function of what the bot has
and where it is (`choreIdle`). That function SHALL also give the reason when a chore has nothing to
do. top_up_seeds SHALL run with fewer than 16 seeds (carried and in its chests), with or without a
farm. extend_farm SHALL start a farm when there is none and it has 8 or more seeds.

#### Scenario: Pax's conditions
- **WHEN** it is day at home with 20 logs, 35 seeds in the pantry, no farm, no coal, stone tools and nothing to store
- **THEN** tidy_storage, top_up_wood, top_up_seeds, craft_spares and light_dark_spots have nothing to do, each with its reason, and extend_farm (start a farm) and scout_nearby do

### Requirement: Quiet pause
A chore run that found nothing to do SHALL say so: a dark-spot pass that placed no torch, a scout that
found nothing, a seed run that got no seeds, or tidying that stored nothing. The chore SHALL then not
run again for its quietMinutes: idle.chores.<name>.quietMinutes, else the chore's own default, else
three cooldowns and at least 30 minutes. light_dark_spots SHALL default to 240 minutes.

#### Scenario: No spot a torch reaches
- **WHEN** light_dark_spots lit nothing because no torch spot reaches the dark spots
- **THEN** it is not picked again for 4 hours and the other chores get the slots

### Requirement: Why it is idle
When no behaviour and no chore runs, the controller snapshot's reason SHALL list the chores of the
mode and why each one was passed over: needs a higher mode, off, waiting for day or night, cooling,
in its quiet pause, or not needed (with the reason). The status line SHALL show that list instead of
"every behaviour scored 0".

#### Scenario: Status
- **WHEN** every chore is cooling or has nothing to do
- **THEN** `just status` shows e.g. "idle (active): tidy_storage not needed (nothing to store yet), extend_farm again in 8m, ..."

### Requirement: Stroll ground
wander SHALL pick, for each spot it tries, the standable ground nearest the bot's height first. It
SHALL skip spots more than 4 blocks above or below the bot, SHALL try closer spots after the first
six, and SHALL say whether it found no ground or no path.

#### Scenario: Inside a walled fortress
- **WHEN** the bot strolls within 8 blocks of home in a fortress with a house and walls
- **THEN** it walks to the yard ground and not onto the house roof or the walls
