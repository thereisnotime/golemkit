## Why
Live: at 1 health and 10 food (no healing below 18) keep_fed asked for the 120-block scout 26 times in 20 minutes, each refused by the trip check for health. Scout, spot and trip steps carry no pause of their own.

## What Changes
- Pure `failPause`: a step refused with "not ready for a trip" rests `NOT_READY_PAUSE_MS` (3 minutes); other failures keep their step pause.
