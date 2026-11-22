# Design

Gather sources are added to `gatherSource` in `searchPlan.ts`. Drop tracking records item entity
spawn times near the owner's last-seen position. Steps already done are kept in the action's
context and skipped on resume.
