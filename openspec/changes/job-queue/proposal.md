# Job queue

## Why

Without the LLM a bot does one thing at a time and forgets it afterwards. Owners want to queue
work ("farm until noon, then get wood, then come home at night") and have it carried out and
reported, LLM or not.

## What changes

- A persistent job queue per bot: add, list, reorder, cancel, clear.
- Jobs are actions or behaviours with an end condition: a count, a time of day, a duration, or
  "until done".
- Plain-language commands: "then", "after that", "until noon", "queue", "what's next".
- Reports when each job finishes or fails; the LLM can plan the queue when it is up.

## Status

Proposed, not started.
