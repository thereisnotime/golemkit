## Why
Pax at 0.08 health showed as "hp 0" in `just status`, which reads as dead and sent the night's debugging down the wrong path.

## What Changes
- The status line and `just status` show health below 1 (but above 0) with one decimal (`hp 0.1`); 0 means dead.
