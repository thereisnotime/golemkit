## Why
Live: at night with food 5 the ladder chose the 48-block scout (allowed for a starving bot), but keep_fed called find_food without atNight, so find_food refused with "it is night" and keep_fed asked again every ~22 s for the whole night.

## What Changes
- keep_fed passes `atNight` to find_food when it is night and the ring is no wider than `riskyRingsFrom` (pure `scoutAtNightFor`), or when the profile sets `scoutAtNight`.
