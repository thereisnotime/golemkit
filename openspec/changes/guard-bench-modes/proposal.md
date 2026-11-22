# Guard bench modes

## Why

The mob-wave benchmark is deliberately harsh: 36 mobs in 4 minutes, a tester that stands still,
no armour, daylight (so spiders never attack and phantoms can't be tested). Its numbers don't
tell owners how the bodyguard does in normal play.

## What changes

- `--profile light`: 2 to 3 mobs at a time, a pause between waves.
- `--tester fights`: the tester defends itself like a player would.
- Runs with `--armour`, `--time night` (spiders and phantoms) and more repeats, with a
  confidence interval in the summary.

## Status

Proposed, not started.
