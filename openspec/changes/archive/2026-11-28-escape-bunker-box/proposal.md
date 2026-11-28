## Why
Live: a bunker was interrupted after sealing (stay_safe took the body), so its climb-out never ran. Pax sat in the sealed 3-deep shaft for over an hour; go_home timed out every 5 minutes and find_target got stuck 4 times. goto only climbed out first when more than 8 blocks underground.

## What Changes
- Pure `boxedIn` (pitPlan.ts): solid on all four sides at feet and head, with a lid within 3 blocks.
- `goto` and `go_home` climb out first (climb_out) when boxed in.
