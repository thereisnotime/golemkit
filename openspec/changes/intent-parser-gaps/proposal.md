# Intent parser gaps

## Why

Known misses in the plain-language commands: "keep the creepers away from me" is rejected (guard
and chat score too close), "show me what you are carrying" is misread as a search, "hold it" is
read as guard, and a confident wrong pattern can win over a correct embedding guess.

## What changes

- Add the missed phrasings to the examples and tests.
- Tighten the patterns that misfire ("show me", "hold it").
- Default Pax to the `vote` strategy if the bench confirms it beats `first_confident` on held-out
  data.

## Status

Proposed, not started.
