## Why
Live (run 5): with allowSnow on, Pax still turned away after three snowy looks, and a snowy taiga with 400 grass, 200 logs and 5 animals failed only because no water was within 32 blocks.

## What Changes
- No snow turns when allowSnow is on.
- The site check looks for water (and ice with allowSnow) within twice the look radius (64), closer to the farm code's 96.
- Also: the ocean turn only happens when standing on land (in the water every way looks wet).
