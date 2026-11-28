## Why
Live: north of Pax's fortress the looks at 505 and 579 blocks were snowy with no grass, trees or animals, and a polar bear killed it at 593. Waiting for maxDistance (1500) before turning means walking a long way through frozen land.

## What Changes
- New setting `startOver.snowTurnAfter` (default 3, 0 = never): after that many snowy looks in a row the main heading turns 90 degrees (counts as one of `maxTurns`). A non-snowy look resets the count.
