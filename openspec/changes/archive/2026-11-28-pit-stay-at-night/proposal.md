## Why
Live after the sealed-pit fix: go_home climbed Pax out of its bunker at night, and it was killed by a pillager and then a zombie within 10 minutes. A sealed pit is the safest place at night.

## What Changes
- Pure `pitAction`: boxed in by day, climb out; at night, stay. goto and go_home fail with "sheltered in a sealed pit, staying until morning" at night instead of climbing out.
