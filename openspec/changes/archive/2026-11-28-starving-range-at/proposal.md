## Why
Live after the food change: at food 7 (one above critical) Pax started a food trip to a village 3500 blocks away, and the trip turned back 15 s later at the trip food floor of 6. A trip that can't survive its own food floor is wasted.

## What Changes
- New keep_fed option `starvingRangeAt` (default 8): food at or below it applies `starvingRange` (default 96), not only food at or below critical (6).
